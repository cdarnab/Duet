'use strict';

/**
 * The claim this project makes is "you will be on the same frame". This test
 * checks that claim against a simulated pair of players that misbehave the way
 * real ones do: skewed system clocks, jittery latency, and decoders that run
 * fractionally fast or slow.
 */

const test = require('node:test');
const assert = require('node:assert');
const { correction, ClockSync } = require('../shared/sync');

class VirtualPlayer {
  constructor({ clockSkew, rateError, latency, jitter }) {
    this.clockSkew = clockSkew; // local clock minus true time, ms
    this.rateError = rateError; // 1.003 = decoder runs 0.3% fast
    this.latency = latency;
    this.jitter = jitter;
    this.clock = new ClockSync();
    this.position = 0;
    this.paused = true;
    this.playbackRate = 1;
    this.seeks = 0;
    this._rng = 1;
  }

  rand() {
    // Deterministic PRNG so the test result is reproducible.
    this._rng = (this._rng * 1103515245 + 12345) % 2147483648;
    return this._rng / 2147483648;
  }

  /** One ping exchange against a server whose clock is the true clock. */
  syncClock(trueNow) {
    const rtt = this.latency * 2 + this.rand() * this.jitter;
    const t0 = trueNow + this.clockSkew;
    const t1 = trueNow + rtt / 2;
    const t2 = trueNow + rtt + this.clockSkew;
    this.clock.addSample(t0, t1, t2);
  }

  advance(dtMs) {
    if (!this.paused) {
      this.position += (dtMs / 1000) * this.playbackRate * this.rateError;
    }
  }

  applyRoom(state, trueNow) {
    const serverNow = this.clock.now(trueNow + this.clockSkew);
    const c = correction({ state, serverNow, localPosition: this.position });
    if (c.action === 'seek') {
      this.position = c.target;
      this.seeks++;
    } else if (c.action === 'rate') {
      this.playbackRate = c.rate;
    }
    this.paused = state.paused;
  }
}

function runSession({ durationMs = 90_000, stepMs = 50 } = {}) {
  const a = new VirtualPlayer({ clockSkew: 4300, rateError: 1.004, latency: 30, jitter: 40 });
  const b = new VirtualPlayer({ clockSkew: -2100, rateError: 0.997, latency: 120, jitter: 160 });

  let trueNow = 5_000_000;
  const state = { paused: true, position: 0, rate: 1, atServerTime: trueNow, seq: 0 };

  // Warm the clocks the way the clients do on connect.
  for (let i = 0; i < 8; i++) {
    a.syncClock(trueNow);
    b.syncClock(trueNow);
    trueNow += 1000;
  }

  // A presses play at 12:00 into the film.
  a.position = 720;
  a.paused = false;
  Object.assign(state, { paused: false, position: 720, atServerTime: trueNow, seq: 1 });

  const samples = [];
  for (let t = 0; t < durationMs; t += stepMs) {
    trueNow += stepMs;
    a.advance(stepMs);
    b.advance(stepMs);

    // Correction loop runs at the same 250ms cadence as the real clients.
    if (t % 250 === 0) {
      a.applyRoom(state, trueNow);
      b.applyRoom(state, trueNow);
    }
    if (t % 10_000 === 0) {
      a.syncClock(trueNow);
      b.syncClock(trueNow);
    }
    if (t > 10_000) samples.push(Math.abs(a.position - b.position));
  }

  return { a, b, samples };
}

test('two players with skewed clocks and drifting decoders converge', () => {
  const { a, b, samples } = runSession();
  const finalGap = Math.abs(a.position - b.position);
  // Two frames at 24fps. Each player may sit at the edge of its own
  // deadband, so this is the structural floor, not an arbitrary number.
  assert.ok(finalGap < 0.12, `players ended ${finalGap.toFixed(3)}s apart`);

  const worst = Math.max(...samples);
  assert.ok(worst < 0.2, `worst gap after settling was ${worst.toFixed(3)}s`);
});

test('staying in sync does not require constant seeking', () => {
  const { a, b } = runSession();
  // One corrective seek each at the start is fine; a stream of them is not.
  assert.ok(a.seeks <= 2, `player A seeked ${a.seeks} times`);
  assert.ok(b.seeks <= 2, `player B seeked ${b.seeks} times`);
});

test('a mid-film seek by one side pulls the other along', () => {
  const a = new VirtualPlayer({ clockSkew: 0, rateError: 1, latency: 20, jitter: 10 });
  const b = new VirtualPlayer({ clockSkew: 900, rateError: 1, latency: 90, jitter: 30 });
  let trueNow = 1_000_000;
  for (let i = 0; i < 8; i++) {
    a.syncClock(trueNow);
    b.syncClock(trueNow);
    trueNow += 1000;
  }

  const state = { paused: false, position: 300, rate: 1, atServerTime: trueNow, seq: 1 };
  a.position = 300; b.position = 300; a.paused = false; b.paused = false;

  // A skips back to rewatch a scene.
  Object.assign(state, { position: 240, atServerTime: trueNow, seq: 2 });
  a.position = 240;

  for (let t = 0; t < 3000; t += 50) {
    trueNow += 50;
    a.advance(50);
    b.advance(50);
    if (t % 250 === 0) { a.applyRoom(state, trueNow); b.applyRoom(state, trueNow); }
  }

  assert.ok(Math.abs(a.position - b.position) < 0.12, 'the second player should have followed the skip');
  assert.ok(b.position < 250, 'the second player should be back near the rewound point');
});
