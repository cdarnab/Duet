'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { projected, correction, ClockSync, timecode, constants } = require('../shared/sync');

test('projected position advances with wall time while playing', () => {
  const state = { paused: false, position: 100, rate: 1, atServerTime: 1_000_000 };
  assert.strictEqual(projected(state, 1_000_000), 100);
  assert.strictEqual(projected(state, 1_002_500), 102.5);
});

test('projected position is frozen while paused', () => {
  const state = { paused: true, position: 42, rate: 1, atServerTime: 1_000_000 };
  assert.strictEqual(projected(state, 1_099_000), 42);
});

test('tiny drift is left alone so audio does not wobble', () => {
  const c = correction({
    state: { paused: false, position: 100, rate: 1, atServerTime: 1_000_000 },
    serverNow: 1_000_000,
    localPosition: 100.02,
  });
  assert.strictEqual(c.rate, 1, 'inside the deadband the player runs at normal speed');
  assert.notStrictEqual(c.action, 'seek');
});

test('moderate drift is corrected by trimming playback rate, not seeking', () => {
  const ahead = correction({
    state: { paused: false, position: 100, rate: 1, atServerTime: 1_000_000 },
    serverNow: 1_000_000,
    localPosition: 100.4,
  });
  assert.strictEqual(ahead.action, 'rate');
  assert.ok(ahead.rate < 1, 'a player that is ahead should slow down');

  const behind = correction({
    state: { paused: false, position: 100, rate: 1, atServerTime: 1_000_000 },
    serverNow: 1_000_000,
    localPosition: 99.6,
  });
  assert.strictEqual(behind.action, 'rate');
  assert.ok(behind.rate > 1, 'a player that is behind should speed up');
});

test('rate trim never exceeds the audible threshold', () => {
  const c = correction({
    state: { paused: false, position: 100, rate: 1, atServerTime: 1_000_000 },
    serverNow: 1_000_000,
    localPosition: 100 + constants.HARD_SEEK - 0.001,
  });
  assert.ok(Math.abs(1 - c.rate) <= constants.MAX_RATE_TRIM + 1e-9);
});

test('large drift triggers a seek to the projected target', () => {
  const c = correction({
    state: { paused: false, position: 100, rate: 1, atServerTime: 1_000_000 },
    serverNow: 1_002_000,
    localPosition: 90,
  });
  assert.strictEqual(c.action, 'seek');
  assert.strictEqual(c.target, 102);
});

test('a paused room snaps stragglers to the exact frame', () => {
  const c = correction({
    state: { paused: true, position: 55, rate: 1, atServerTime: 1_000_000 },
    serverNow: 1_050_000,
    localPosition: 58,
  });
  assert.strictEqual(c.action, 'seek');
  assert.strictEqual(c.target, 55);
});

test('seek target is clamped to the end of the file', () => {
  const c = correction({
    state: { paused: false, position: 100, rate: 1, atServerTime: 1_000_000 },
    serverNow: 1_060_000,
    localPosition: 100,
    duration: 120,
  });
  assert.ok(c.target <= 120);
});

test('clock sync recovers a known offset despite one-sided latency', () => {
  const clock = new ClockSync();
  const trueOffset = 2500; // server clock is 2.5s ahead of this client
  for (let i = 0; i < 12; i++) {
    const t0 = 1_000_000 + i * 1000;
    const rtt = 40 + (i % 4) * 30;
    const t1 = t0 + rtt / 2 + trueOffset;
    const t2 = t0 + rtt;
    clock.addSample(t0, t1, t2);
  }
  assert.ok(clock.ready);
  assert.ok(Math.abs(clock.offset - trueOffset) < 25, `offset was ${clock.offset}`);
});

test('clock sync ignores a single pathological latency spike', () => {
  const clock = new ClockSync();
  const trueOffset = 100;
  for (let i = 0; i < 10; i++) {
    const t0 = i * 1000;
    const rtt = i === 5 ? 4000 : 50; // one stalled sample
    clock.addSample(t0, t0 + rtt / 2 + trueOffset, t0 + rtt);
  }
  assert.ok(Math.abs(clock.offset - trueOffset) < 50, `offset was ${clock.offset}`);
});

test('timecode formats as hours:minutes:seconds.tenths', () => {
  assert.strictEqual(timecode(0), '00:00:00.0');
  assert.strictEqual(timecode(3661.45), '01:01:01.4');
  assert.strictEqual(timecode(-5), '00:00:00.0');
});
