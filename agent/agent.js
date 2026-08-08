'use strict';

/**
 * The agent: joins a Duet room on behalf of a physical device and keeps that
 * device in step with the room by pressing buttons at the right moments.
 *
 * It is a room member like any other, so the console's drift meter shows the
 * TV's real position without any special casing.
 */

const WebSocket = require('ws');
const { EventEmitter } = require('events');
const DuetSync = require('../shared/sync');
const { planCorrection, planDuration } = require('./control');
const { PositionEstimator } = require('./estimator');

class Agent extends EventEmitter {
  constructor({ server, room, driver, name, session = '', pollMs = 1500, tolerance, readLagSec = 0 }) {
    super();
    this.server = server.replace(/\/+$/, '');
    this.room = room.toUpperCase();
    this.driver = driver;
    this.name = name || driver.label || 'TV';
    this.session = session || '';
    this.pollMs = pollMs;
    this.tolerance = tolerance;

    this.clock = new DuetSync.ClockSync();
    // Devices report a stale, coarsely-rounded playhead. Acting on those
    // numbers directly means correcting rounding noise forever, so every
    // reading is folded into a smoothed local estimate instead.
    this.estimator = new PositionEstimator();
    this.readLagSec = readLagSec;
    this.state = { paused: true, position: 0, rate: 1, atServerTime: Date.now(), seq: -1 };
    this.selfId = null;
    this.connected = false;
    this.busy = false; // a correction plan is mid-execution
    this.lastDrift = null;
    this.holdingRoom = false;
    this._assumedPaused = true;
    this._commandUntil = 0;
    this._deviceStable = false;
    this._stableSince = 0;
    this.stopped = false;
    this._timers = [];
  }

  /* ------------------------------------------------------------- transport */

  connect() {
    const url = this.server.replace(/^http/, 'ws') + '/ws';
    this.ws = new WebSocket(url);

    this.ws.on('open', () => {
      this.connected = true;
      this._send({
        type: 'hello',
        room: this.room,
        name: this.name,
        surface: 'device',
        session: this.session,
      });
      this._ping();
      this.emit('status', { connected: true });
    });

    this.ws.on('message', (raw) => this._onMessage(JSON.parse(raw)));

    this.ws.on('close', () => {
      this.connected = false;
      this.emit('status', { connected: false });
      // Without this guard, stop() closes the socket, the close handler
      // reconnects, and the "stopped" agent runs forever.
      if (this.stopped) return;
      this._later(() => this.connect(), 2000);
    });

    this.ws.on('error', (err) => this.emit('error', err));
    return this;
  }

  _send(msg) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  _ping() {
    this._send({ type: 'ping', t0: Date.now() });
  }

  _onMessage(msg) {
    switch (msg.type) {
      case 'pong':
        this.clock.addSample(msg.t0, msg.t1, Date.now());
        break;
      case 'welcome':
        this.selfId = msg.selfId;
        this.state = msg.state;
        this.emit('joined', msg);
        break;
      case 'state':
        this.state = msg.state;
        this.emit('roomstate', msg.state);
        if (msg.resync) {
          this._resync().catch((err) => this.emit('error', err));
        }
        break;
      case 'cue':
        this._runCue(msg.startAt);
        break;
      case 'error':
        if (msg.error === 'auth_required') {
          this.stopped = true;
          this.emit('error', new Error('This Duet is invite-only. Pass --email and --password (or --session).'));
          try { this.ws.close(); } catch {}
        } else {
          this.emit('error', new Error(msg.error || 'server error'));
        }
        break;
    }
  }

  serverNow() {
    return this.clock.now();
  }

  expectedPosition() {
    return DuetSync.projected(this.state, this.serverNow());
  }

  /* ---------------------------------------------------------------- loops */

  async start() {
    await this.driver.connect();
    this.connect();

    // Clock samples: fast to converge, then a trickle.
    let n = 0;
    this._every(() => {
      if (!this.connected) return;
      if (n < 8 || n % 10 === 0) this._ping();
      n++;
    }, 1000);

    this._every(() => this.tick().catch((e) => this.emit('error', e)), this.pollMs);
    return this;
  }

  /** One pass: read the device, mirror transport, correct drift. */
  async tick() {
    if (this.busy || !this.connected || this.state.seq < 0) return;

    const reading = await this.driver.position();
    const expected = this.expectedPosition();
    const pausedKnown = Boolean(reading && typeof reading.paused === 'boolean');
    const positionKnown = Boolean(reading && Number.isFinite(reading.position));

    if (this._shouldPublishTransport(reading)) {
      this._assumedPaused = reading.paused;
      this._deviceStable = true;
      this._stableSince = Date.now();
      this._send({
        type: 'state',
        paused: reading.paused,
        position: positionKnown ? reading.position : expected,
        rate: 1,
        title: this.driver.label,
      });
      this.emit('drift', {
        drift: positionKnown ? reading.position - expected : null,
        blind: !positionKnown,
        devicePaused: reading.paused,
      });
      return;
    }
    this._noteDeviceReading(reading);

    if (!positionKnown) {
      // Open loop: we can still follow play/pause, and report pause if we see it.
      await this._mirrorTransport(reading);
      if (pausedKnown) {
        this._send({
          type: 'tick',
          position: expected,
          paused: reading.paused,
          title: this.driver.label,
        });
      }
      this.emit('drift', { drift: null, blind: true });
      return;
    }

    const at = Date.now();
    this.estimator.observe({
      position: reading.position,
      paused: reading.paused,
      rate: reading.paused ? 0 : 1,
      at,
    });
    // Fall back to the raw number until the estimate has settled.
    const position = this.estimator.ready
      ? this.estimator.estimate(at) + this.readLagSec
      : reading.position + this.readLagSec;

    this._send({
      type: 'tick',
      position,
      paused: reading.paused,
      title: this.driver.label,
    });

    await this._mirrorTransport(reading);

    if (this.state.paused) return;

    const drift = position - expected;
    this.lastDrift = drift;
    this.emit('drift', { drift, devicePosition: reading.position, expected });

    const plan = planCorrection(drift, this.driver.capabilities, this.tolerance);
    if (plan.strategy === 'in-step') return;
    if (plan.strategy === 'manual') {
      this.emit('manual', plan);
      return;
    }
    await this._execute(plan, drift);
  }

  _shouldPublishTransport(reading) {
    if (!reading || typeof reading.paused !== 'boolean') return false;
    if (Date.now() < (this._commandUntil || 0)) return false;
    if (!this._deviceStable) return false;
    return reading.paused !== this._assumedPaused;
  }

  _noteDeviceReading(reading) {
    if (!reading || typeof reading.paused !== 'boolean') return;
    if (Date.now() < (this._commandUntil || 0)) {
      this._deviceStable = false;
      this._stableSince = 0;
      return;
    }
    if (reading.paused === this._assumedPaused) {
      if (!this._stableSince) this._stableSince = Date.now();
      this._deviceStable = Date.now() - this._stableSince >= 700;
    } else {
      this._stableSince = 0;
    }
  }

  _markCommanded(paused) {
    this._assumedPaused = paused;
    this._commandUntil = Date.now() + 1500;
    this._deviceStable = false;
    this._stableSince = 0;
  }

  async _mirrorTransport(reading) {
    const state = reading || (await this.driver.position());
    if (!state || typeof state.paused !== 'boolean') {
      // Blind: assume the device follows whatever we last told it.
      if (this.state.paused !== this._assumedPaused) {
        this._markCommanded(this.state.paused);
        await (this.state.paused ? this.driver.pause() : this.driver.play());
      }
      return;
    }
    if (this.state.paused === state.paused) {
      this._assumedPaused = state.paused;
      return;
    }
    this._markCommanded(this.state.paused);
    await (this.state.paused ? this.driver.pause(state) : this.driver.resume(state));
  }

  /**
   * Run a plan. Holds are the precise instrument here, so they are timed off
   * the synced clock and compensated for command latency.
   */
  async _execute(plan, drift) {
    this.busy = true;
    const latency = (this.driver.capabilities.commandLatencyMs || 0) / 1000;
    this.emit('correcting', { plan, drift, eta: planDuration(plan) });

    try {
      for (const step of plan.steps) {
        if (step.op === 'jump') {
          await this.driver.jump(step.dir, step.times);
          await sleep(600); // let the player settle before the next step
        } else if (step.op === 'holdDevice') {
          await this.driver.pause();
          await sleep(Math.max(0, step.seconds - latency) * 1000);
          await this.driver.resume();
        } else if (step.op === 'holdRoom') {
          await this._holdRoom(step.seconds);
        }
      }
    } finally {
      // Readings are stale right after a correction, and the old estimate now
      // describes a playhead that no longer exists.
      this.estimator.reset();
      await sleep(1200);
      this.busy = false;
    }
    this.emit('corrected', { plan });
  }

  /** Pause the whole room briefly so the browser side waits for the TV. */
  async _holdRoom(seconds) {
    const at = this.expectedPosition();
    this.holdingRoom = true;
    this._send({ type: 'state', paused: true, position: at, rate: 1 });
    await sleep(seconds * 1000);
    this._send({ type: 'state', paused: false, position: at, rate: 1 });
    this.holdingRoom = false;
  }

  /**
   * Open-loop TVs cannot seek. Resync means: pause everyone, then count in.
   * That is the only snap that actually works on Nebula’s Netflix APK.
   */
  async _resync() {
    this.emit('status', { connected: true });
    this.emit('manual', { note: 'Resync: pausing both sides, then counting in' });
    this.busy = true;
    try {
      this._markCommanded(true);
      await this.driver.pause();
      const at = this.expectedPosition();
      this._send({ type: 'state', paused: true, position: at, rate: 1 });
      this.state = { ...this.state, paused: true, position: at, rate: 1 };
      this._send({ type: 'cue', inMs: 3200 });
    } finally {
      this.estimator.reset();
      this.busy = false;
    }
  }

  /** Start on the same beat as everyone else, allowing for command latency. */
  _runCue(startAt) {
    const lead = this.driver.capabilities.commandLatencyMs || 0;
    const wait = startAt - this.serverNow() - lead;
    this.emit('cue', { startAt, wait });
    this._later(async () => {
      this._markCommanded(false);
      await this.driver.play();
    }, Math.max(0, wait));
  }

  /* --------------------------------------------------------------- timers */

  _every(fn, ms) {
    const t = setInterval(fn, ms);
    this._timers.push(t);
    return t;
  }

  _later(fn, ms) {
    const t = setTimeout(fn, ms);
    this._timers.push(t);
    return t;
  }

  stop() {
    this.stopped = true;
    this._timers.forEach(clearTimeout);
    this._timers.forEach(clearInterval);
    this._timers = [];
    try {
      this.ws?.close();
    } catch {}
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

module.exports = { Agent };
