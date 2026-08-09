'use strict';

const test = require('node:test');
const assert = require('node:assert');
const WebSocket = require('ws');

process.env.PORT = process.env.PORT || '8099';
const { server, start, PORT } = require('../server/index');

let started = false;
async function ensureServer() {
  if (!started) {
    await start();
    started = true;
  }
}

function connect() {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
  const inbox = [];
  const waiters = [];

  ws.on('message', (raw) => {
    const msg = JSON.parse(raw);
    inbox.push(msg);
    for (let i = waiters.length - 1; i >= 0; i--) {
      if (waiters[i].match(msg)) {
        waiters[i].resolve(msg);
        waiters.splice(i, 1);
      }
    }
  });

  return {
    ws,
    inbox,
    open: () => new Promise((res) => ws.on('open', res)),
    send: (msg) => ws.send(JSON.stringify(msg)),
    /** Resolve on the next message matching a predicate, with a timeout. */
    next(match, timeout = 3000) {
      const found = inbox.find(match);
      if (found) return Promise.resolve(found);
      return new Promise((resolve, reject) => {
        const w = { match, resolve };
        waiters.push(w);
        setTimeout(() => reject(new Error('timed out waiting for message')), timeout);
      });
    },
    close: () => ws.close(),
  };
}

test('health endpoint reports the server is up', async () => {
  await ensureServer();
  const res = await fetch(`http://127.0.0.1:${PORT}/health`);
  const body = await res.json();
  assert.strictEqual(res.status, 200);
  assert.strictEqual(body.ok, true);
});

test('the landing page and shared sync core are served', async () => {
  await ensureServer();
  const page = await fetch(`http://127.0.0.1:${PORT}/`);
  assert.strictEqual(page.status, 200);
  assert.match(await page.text(), /Duet/);

  const core = await fetch(`http://127.0.0.1:${PORT}/shared/sync.js`);
  assert.strictEqual(core.status, 200);
  assert.match(await core.text(), /DuetSync/);
});

test('directory traversal is refused', async () => {
  await ensureServer();
  const res = await fetch(`http://127.0.0.1:${PORT}/../package.json`);
  assert.ok(res.status === 403 || res.status === 404);
});

test('an invalid room code is rejected', async () => {
  await ensureServer();
  const c = connect();
  await c.open();
  c.send({ type: 'hello', room: '../..', name: 'Nope', surface: 'browser' });
  const err = await c.next((m) => m.type === 'error');
  assert.strictEqual(err.error, 'invalid_room');
  c.close();
});

test('a new room gets a readable code', async () => {
  await ensureServer();
  const { code } = await (await fetch(`http://127.0.0.1:${PORT}/api/room/new`)).json();
  assert.match(code, /^[A-Z0-9]{6}$/);
  assert.ok(!/[ILO01]/.test(code), 'ambiguous characters should be excluded');
});

test('ping returns a server timestamp for clock alignment', async () => {
  await ensureServer();
  const c = connect();
  await c.open();
  const t0 = Date.now();
  c.send({ type: 'ping', t0 });
  const pong = await c.next((m) => m.type === 'pong');
  assert.strictEqual(pong.t0, t0);
  assert.ok(Math.abs(pong.t1 - Date.now()) < 3000);
  c.close();
});

test('a play action reaches the other viewer with a server timestamp', async () => {
  await ensureServer();
  const room = 'TESTAA';
  const laptop = connect();
  const tv = connect();
  await Promise.all([laptop.open(), tv.open()]);

  laptop.send({ type: 'hello', room, name: 'Laptop', surface: 'browser' });
  await laptop.next((m) => m.type === 'welcome');
  tv.send({ type: 'hello', room, name: 'TV', surface: 'tv' });
  await tv.next((m) => m.type === 'welcome');

  laptop.send({ type: 'state', paused: false, position: 615.25, rate: 1 });
  const got = await tv.next((m) => m.type === 'state');

  assert.strictEqual(got.state.paused, false);
  assert.strictEqual(got.state.position, 615.25);
  assert.ok(Math.abs(got.state.atServerTime - Date.now()) < 3000);

  laptop.send({ type: 'state', paused: true, position: 620, rate: 1 });
  const paused = await tv.next((m) => m.type === 'state' && m.state.paused === true);
  assert.strictEqual(paused.state.paused, true);

  laptop.send({ type: 'state', paused: false, position: 620, rate: 1 });
  const resumed = await tv.next((m) => m.type === 'state' && m.state.paused === false && m.state.position === 620);
  assert.strictEqual(resumed.state.paused, false);

  laptop.close();
  tv.close();
});

test('a late joiner receives the room state already in progress', async () => {
  await ensureServer();
  const room = 'TESTBB';
  const first = connect();
  await first.open();
  first.send({ type: 'hello', room, name: 'First', surface: 'browser' });
  await first.next((m) => m.type === 'welcome');
  first.send({ type: 'state', paused: false, position: 1800, rate: 1 });
  await first.next((m) => m.type === 'state');

  const late = connect();
  await late.open();
  late.send({ type: 'hello', room, name: 'Late', surface: 'tv' });
  const welcome = await late.next((m) => m.type === 'welcome');

  assert.strictEqual(welcome.state.paused, false);
  assert.ok(welcome.state.position >= 1800);
  assert.strictEqual(welcome.members.length, 2);

  first.close();
  late.close();
});

test('the first person in a room is the host and later joiners see them', async () => {
  await ensureServer();
  const room = 'HOSTAA';
  const host = connect();
  const guest = connect();
  await Promise.all([host.open(), guest.open()]);

  host.send({ type: 'hello', room, name: 'Arnab', surface: 'browser' });
  const hostWelcome = await host.next((m) => m.type === 'welcome');
  assert.strictEqual(hostWelcome.creator.name, 'Arnab');
  assert.ok(hostWelcome.members.find((m) => m.host && m.name === 'Arnab'));

  guest.send({ type: 'hello', room, name: 'Samira', surface: 'browser' });
  const guestWelcome = await guest.next((m) => m.type === 'welcome');
  assert.strictEqual(guestWelcome.creator.name, 'Arnab');
  assert.ok(guestWelcome.members.find((m) => m.host && m.name === 'Arnab'));
  assert.ok(guestWelcome.members.find((m) => !m.host && m.name === 'Samira'));

  const joined = await host.next((m) => m.type === 'joined');
  assert.strictEqual(joined.member.name, 'Samira');
  assert.strictEqual(joined.member.host, false);
  assert.strictEqual(joined.creator.name, 'Arnab');

  host.close();
  guest.close();
});

test('a cue schedules the same start moment for both sides', async () => {
  await ensureServer();
  const room = 'TESTCC';
  const a = connect();
  const b = connect();
  await Promise.all([a.open(), b.open()]);
  a.send({ type: 'hello', room, name: 'A', surface: 'browser' });
  b.send({ type: 'hello', room, name: 'B', surface: 'tv' });
  await Promise.all([a.next((m) => m.type === 'welcome'), b.next((m) => m.type === 'welcome')]);

  a.send({ type: 'cue', inMs: 3000, position: 10 });
  const [ca, cb] = await Promise.all([
    a.next((m) => m.type === 'cue'),
    b.next((m) => m.type === 'cue'),
  ]);

  assert.strictEqual(ca.startAt, cb.startAt, 'both sides must count down to one instant');
  assert.ok(ca.startAt > Date.now());

  a.close();
  b.close();
});

test('position heartbeats propagate so each side can show the drift', async () => {
  await ensureServer();
  const room = 'TESTDD';
  const a = connect();
  const b = connect();
  await Promise.all([a.open(), b.open()]);
  a.send({ type: 'hello', room, name: 'A', surface: 'browser' });
  b.send({ type: 'hello', room, name: 'B', surface: 'companion' });
  await Promise.all([a.next((m) => m.type === 'welcome'), b.next((m) => m.type === 'welcome')]);

  a.send({ type: 'tick', position: 123.4, paused: false, title: 'A Movie' });
  const tick = await b.next((m) => m.type === 'tick');
  assert.strictEqual(tick.position, 123.4);
  assert.strictEqual(tick.title, 'A Movie');

  a.close();
  b.close();
});

test('chat is relayed and kept for late joiners', async () => {
  await ensureServer();
  const room = 'TESTEE';
  const a = connect();
  await a.open();
  a.send({ type: 'hello', room, name: 'A', surface: 'companion' });
  await a.next((m) => m.type === 'welcome');
  a.send({ type: 'chat', text: 'this part is my favourite' });
  await a.next((m) => m.type === 'chat');

  const b = connect();
  await b.open();
  b.send({ type: 'hello', room, name: 'B', surface: 'companion' });
  const welcome = await b.next((m) => m.type === 'welcome');
  assert.strictEqual(welcome.chat.at(-1).text, 'this part is my favourite');

  a.close();
  b.close();
});

test('voice signalling is delivered only to the named peer', async () => {
  await ensureServer();
  const room = 'TESTFF';
  const a = connect();
  const b = connect();
  await Promise.all([a.open(), b.open()]);
  a.send({ type: 'hello', room, name: 'A', surface: 'companion' });
  const wa = await a.next((m) => m.type === 'welcome');
  b.send({ type: 'hello', room, name: 'B', surface: 'companion' });
  await b.next((m) => m.type === 'welcome');
  const joined = await b.next((m) => m.type === 'joined' || m.type === 'welcome');
  assert.ok(joined);

  b.send({ type: 'signal', to: wa.selfId, data: { sdp: { type: 'offer', sdp: 'x' } } });
  const sig = await a.next((m) => m.type === 'signal');
  assert.strictEqual(sig.data.sdp.type, 'offer');

  a.close();
  b.close();
});

test('resync broadcasts current room state to every member', async () => {
  await ensureServer();
  const room = 'TESTHH';
  const a = connect();
  const b = connect();
  await Promise.all([a.open(), b.open()]);
  a.send({ type: 'hello', room, name: 'A', surface: 'browser' });
  b.send({ type: 'hello', room, name: 'B', surface: 'companion' });
  await Promise.all([a.next((m) => m.type === 'welcome'), b.next((m) => m.type === 'welcome')]);

  a.send({ type: 'state', paused: false, position: 90, rate: 1 });
  await Promise.all([a.next((m) => m.type === 'state'), b.next((m) => m.type === 'state')]);

  b.send({ type: 'resync' });
  const [ra, rb, cue] = await Promise.all([
    a.next((m) => m.type === 'state' && m.resync),
    b.next((m) => m.type === 'state' && m.resync),
    a.next((m) => m.type === 'cue'),
  ]);
  assert.strictEqual(ra.resync, true);
  assert.strictEqual(rb.resync, true);
  assert.strictEqual(ra.state.paused, true);
  assert.ok(ra.state.position >= 90);
  assert.ok(cue.startAt);

  a.close();
  b.close();
});

test('resync waits for a device acknowledgement and then makes play canonical', async () => {
  await ensureServer();
  const room = 'TESTRI';
  const browser = connect();
  const device = connect();
  await Promise.all([browser.open(), device.open()]);
  browser.send({ type: 'hello', room, name: 'A', surface: 'browser' });
  device.send({ type: 'hello', room, name: 'TV', surface: 'device' });
  await Promise.all([
    browser.next((m) => m.type === 'welcome'),
    device.next((m) => m.type === 'welcome'),
  ]);

  browser.send({ type: 'resync' });
  const paused = await device.next((m) => m.type === 'state' && m.resync);
  await new Promise((resolve) => setTimeout(resolve, 120));
  assert.ok(!browser.inbox.some((m) => m.type === 'cue'), 'cue raced ahead of the TV pause');

  device.send({ type: 'resync-ready', resyncId: paused.resyncId });
  const cue = await browser.next((m) => m.type === 'cue' && m.resyncId === paused.resyncId);
  const playing = await browser.next((m) => m.type === 'state' && m.cueStart, 3000);
  assert.strictEqual(playing.state.paused, false);
  assert.ok(Math.abs(playing.state.atServerTime - cue.startAt) < 10);

  browser.close();
  device.close();
});

test('a departing viewer is removed from the roster', async () => {
  await ensureServer();
  const room = 'TESTGG';
  const a = connect();
  const b = connect();
  await Promise.all([a.open(), b.open()]);
  a.send({ type: 'hello', room, name: 'A', surface: 'browser' });
  await a.next((m) => m.type === 'welcome');
  b.send({ type: 'hello', room, name: 'B', surface: 'tv' });
  await b.next((m) => m.type === 'welcome');
  await a.next((m) => m.type === 'joined');

  b.close();
  const left = await a.next((m) => m.type === 'left');
  assert.ok(left.id);
  a.close();
});

test.after(() => {
  server.close();
});
