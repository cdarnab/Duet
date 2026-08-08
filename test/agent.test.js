'use strict';

/**
 * The whole loop, end to end: a real server, a real websocket, the real agent,
 * and a simulated set-top box that reports stale noisy positions and only
 * skips in 10-second steps.
 *
 * This is what backs the claim that native TV devices can be synced to about a
 * second. If it fails, the claim is wrong.
 */

const test = require('node:test');
const assert = require('node:assert');
const WebSocket = require('ws');

process.env.PORT = process.env.PORT || '8098';
const { server, start, PORT } = require('../server/index');
const { Agent } = require('../agent/agent');
const { MockDriver } = require('../agent/drivers/mock');

let started = false;
async function ensureServer() {
  if (!started) {
    await start();
    started = true;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Stands in for the browser side: sets room state and follows it exactly. */
function browserPeer(room) {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
  const peer = { ws, ready: false };
  ws.on('open', () => {
    ws.send(JSON.stringify({ type: 'hello', room, name: 'Laptop', surface: 'browser' }));
    peer.ready = true;
  });
  ws.on('message', (raw) => {
    const msg = JSON.parse(raw);
    if (msg.type === 'welcome') peer.selfId = msg.selfId;
    if (msg.type === 'state') peer.state = msg.state;
  });
  peer.setState = (s) => ws.send(JSON.stringify({ type: 'state', rate: 1, ...s }));
  return peer;
}

/** Drive the mock device's playhead in real time while the agent works. */
function runClock(device, ms, stepMs = 50) {
  return new Promise((resolve) => {
    let elapsed = 0;
    const t = setInterval(() => {
      device.advance(stepMs);
      elapsed += stepMs;
      if (elapsed >= ms) {
        clearInterval(t);
        resolve();
      }
    }, stepMs);
  });
}

test('the agent pulls a lagging TV back into step', async () => {
  await ensureServer();
  const room = 'AGENTA';

  const device = new MockDriver({ startPosition: 600, latencyMs: 80, rateError: 1.001 });
  const peer = browserPeer(room);
  await sleep(300);

  const agent = new Agent({
    server: `http://127.0.0.1:${PORT}`,
    room,
    driver: device,
    pollMs: 600,
  });
  await agent.start();
  await sleep(600);

  // The room is 6 seconds ahead of where the TV is sitting.
  device.paused = false;
  peer.setState({ paused: false, position: 606 });
  await sleep(200);

  await runClock(device, 14000);

  const expected = agent.expectedPosition();
  const gap = Math.abs(device.position_ - expected);
  assert.ok(gap < 1.2, `TV ended ${gap.toFixed(2)}s from the room`);

  agent.stop();
  peer.ws.close();
});

test('a large gap is closed with skips, not with a minutes-long pause', async () => {
  await ensureServer();
  const room = 'AGENTB';

  // The TV is 38 seconds behind — far past what any hold should absorb.
  const device = new MockDriver({ startPosition: 1200, latencyMs: 60 });
  const peer = browserPeer(room);
  await sleep(300);

  const agent = new Agent({ server: `http://127.0.0.1:${PORT}`, room, driver: device, pollMs: 600 });
  await agent.start();
  await sleep(600);

  // Listen before the stimulus: the agent corrects within one poll interval,
  // which is quicker than a sleep here would be.
  const plans = [];
  agent.on('correcting', ({ plan }) => plans.push(plan));

  device.paused = false;
  peer.setState({ paused: false, position: 1238 });

  await runClock(device, 20000);

  const usedJump = plans.some((p) => p.steps.some((s) => s.op === 'jump'));
  assert.ok(usedJump, 'a 38-second gap should be closed with skip presses');

  const gap = Math.abs(device.position_ - agent.expectedPosition());
  assert.ok(gap < 2.0, `TV ended ${gap.toFixed(2)}s from the room`);

  agent.stop();
  peer.ws.close();
});

test('the agent mirrors pause and resume from the browser side', async () => {
  await ensureServer();
  const room = 'AGENTC';

  const device = new MockDriver({ startPosition: 100, latencyMs: 50 });
  const peer = browserPeer(room);
  await sleep(300);

  const agent = new Agent({ server: `http://127.0.0.1:${PORT}`, room, driver: device, pollMs: 400 });
  await agent.start();
  await sleep(600);

  device.paused = false;
  peer.setState({ paused: false, position: 100 });
  await sleep(1200);
  assert.strictEqual(device.paused, false, 'TV should be playing');

  peer.setState({ paused: true, position: 103 });
  await sleep(1400);
  assert.strictEqual(device.paused, true, 'TV should have paused with the room');

  agent.stop();
  peer.ws.close();
});

test('the TV appears in the room roster with its real position', async () => {
  await ensureServer();
  const room = 'AGENTD';

  const device = new MockDriver({ startPosition: 777, latencyMs: 40 });
  const peer = browserPeer(room);
  await sleep(300);

  const agent = new Agent({ server: `http://127.0.0.1:${PORT}`, room, driver: device, pollMs: 400 });
  await agent.start();

  const seen = [];
  peer.ws.on('message', (raw) => {
    const msg = JSON.parse(raw);
    if (msg.type === 'tick') seen.push(msg);
  });

  await sleep(1600);
  assert.ok(seen.length > 0, 'the agent should report the TV position to the room');
  assert.ok(Math.abs(seen.at(-1).position - 777) < 2);

  agent.stop();
  peer.ws.close();
});

test('a TV pause in open loop still pauses the browser side', async () => {
  await ensureServer();
  const room = 'AGENTP';

  const device = new MockDriver({ startPosition: 50, readPosition: false, readPaused: true, latencyMs: 40 });
  const peer = browserPeer(room);
  await sleep(300);

  const agent = new Agent({ server: `http://127.0.0.1:${PORT}`, room, driver: device, pollMs: 400 });
  await agent.start();
  await sleep(900);

  peer.setState({ paused: false, position: 50 });
  await sleep(4000);
  assert.strictEqual(device.paused, false, 'TV should be playing with the room');

  const paused = new Promise((resolve) => {
    const onMsg = (raw) => {
      const msg = JSON.parse(raw);
      if (msg.type === 'state' && msg.state?.paused === true) {
        peer.ws.off('message', onMsg);
        resolve(msg);
      }
    };
    peer.ws.on('message', onMsg);
  });

  try {
    device.paused = true;
    const got = await Promise.race([paused, sleep(3500).then(() => null)]);
    assert.ok(got, 'browser should see a pause state from the TV');
  } finally {
    agent.stop();
    peer.ws.close();
  }
});

test('a device that cannot report position still follows play and pause', async () => {
  await ensureServer();
  const room = 'AGENTE';

  const device = new MockDriver({ startPosition: 50, readPosition: false, latencyMs: 50 });
  const peer = browserPeer(room);
  await sleep(300);

  const agent = new Agent({ server: `http://127.0.0.1:${PORT}`, room, driver: device, pollMs: 400 });
  await agent.start();
  await sleep(600);

  const blind = [];
  agent.on('drift', (d) => blind.push(d));
  peer.setState({ paused: false, position: 50 });
  await sleep(1400);

  assert.ok(blind.some((d) => d.blind), 'the agent should report that it is running open loop');
  assert.strictEqual(device.paused, false, 'transport should still be mirrored');

  agent.stop();
  peer.ws.close();
});

/**
 * The hardest input the loop sees: an Apple-TV-shaped device that rounds its
 * reported playhead to the whole second. Before the estimator was added, the
 * rounding alone was enough to keep the planner correcting a TV that was
 * already in step.
 */
test('a device that rounds its position to the second is not thrashed', async () => {
  await ensureServer();
  const room = 'AGENTQ';

  const device = new MockDriver({
    startPosition: 400,
    readQuantumSec: 1,
    reportLagMs: 400,
    reportNoise: 0.05,
    latencyMs: 40,
  });
  const peer = browserPeer(room);
  await sleep(300);

  const agent = new Agent({ server: `http://127.0.0.1:${PORT}`, room, driver: device, pollMs: 400 });
  await agent.start();
  try {
    await sleep(500);

    const corrections = [];
    agent.on('correcting', (c) => corrections.push(c));

    // Start both sides together at the same point, then just let them run.
    device.paused = false;
    peer.setState({ paused: false, position: 400 });
    await runClock(device, 6000);

    assert.ok(
      corrections.length <= 1,
      `rounding noise alone triggered ${corrections.length} corrections`
    );

    const drift = device.position_ - agent.expectedPosition();
    assert.ok(Math.abs(drift) < 1.5, `ended ${drift.toFixed(2)}s apart`);
  } finally {
    agent.stop();
    peer.ws.close();
  }
});

test.after(() => server.close());
