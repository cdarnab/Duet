'use strict';

/**
 * Why the estimator exists.
 *
 * A set-top box reports a playhead that is stale by a few hundred milliseconds
 * and, on some platforms, rounded to the whole second. That error is larger
 * than the planner's entire deadband, so acting on raw readings means issuing
 * corrections against rounding noise — pausing a TV that was never out of step.
 *
 * These tests pin down both halves of the claim: that raw readings really are
 * that bad, and that the smoothed estimate really is good enough.
 */

const test = require('node:test');
const assert = require('node:assert');

const { PositionEstimator } = require('../agent/estimator');
const { planCorrection, constants } = require('../agent/control');
const { MockDriver } = require('../agent/drivers/mock');

const CAPS = { canJump: true, jumpBack: 10, jumpForward: 10 };

test('raw readings from a real-shaped device exceed the deadband', () => {
  let truth = 100;
  let worst = 0;
  for (let i = 0; i < 60; i++) {
    truth += 0.5;
    const raw = Math.round(truth - 0.4); // 400ms stale, rounded to the second
    worst = Math.max(worst, Math.abs(raw - truth));
  }
  assert.ok(
    worst > constants.DEADBAND,
    `raw error peaked at ${worst.toFixed(2)}s — if this is inside the deadband the estimator is unnecessary`
  );
});

test('the estimator recovers a smooth playhead from rounded readings', () => {
  const est = new PositionEstimator({ gain: 0.25 });
  let truth = 100;
  let at = 1_000_000;
  const errors = [];

  for (let i = 0; i < 120; i++) {
    at += 500;
    truth += 0.5;
    est.observe({ position: Math.round(truth - 0.4), paused: false, rate: 1, at });
    if (i > 25) errors.push(Math.abs(est.estimate(at) - (truth - 0.4)));
  }

  const worst = Math.max(...errors);
  assert.ok(worst < 0.3, `estimator error peaked at ${worst.toFixed(3)}s`);
});

test('smoothing stops the planner firing at rounding noise', () => {
  const est = new PositionEstimator({ gain: 0.25 });
  let truth = 500;
  let at = 2_000_000;
  let smoothed = 0;
  let raw = 0;

  for (let i = 0; i < 120; i++) {
    at += 500;
    truth += 0.5;
    const reading = Math.round(truth);
    est.observe({ position: reading, paused: false, rate: 1, at });
    if (i <= 25) continue;
    if (planCorrection(est.estimate(at) - truth, CAPS).strategy !== 'in-step') smoothed++;
    if (planCorrection(reading - truth, CAPS).strategy !== 'in-step') raw++;
  }

  assert.ok(raw > 10, `raw readings should misfire repeatedly, saw ${raw}`);
  assert.strictEqual(smoothed, 0, `smoothed readings should never misfire, saw ${smoothed}`);
});

test('a real seek is not mistaken for noise', () => {
  const est = new PositionEstimator();
  let at = 3_000_000;
  for (let i = 0; i < 10; i++) {
    at += 500;
    est.observe({ position: 200 + i * 0.5, paused: false, rate: 1, at });
  }
  at += 500;
  const outcome = est.observe({ position: 140, paused: false, rate: 1, at });
  assert.strictEqual(outcome, 'anchor', 'a 60s jump must re-anchor immediately');
  assert.ok(Math.abs(est.estimate(at) - 140) < 0.05);
});

test('a paused device does not keep advancing', () => {
  const est = new PositionEstimator();
  let at = 4_000_000;
  for (let i = 0; i < 6; i++) {
    at += 500;
    est.observe({ position: 50 + i * 0.5, paused: false, rate: 1, at });
  }
  at += 500;
  est.observe({ position: 53, paused: true, rate: 0, at });
  assert.strictEqual(est.estimate(at + 10_000), 53);
});

test('the estimate is continuous — no jumps between readings', () => {
  const est = new PositionEstimator({ gain: 0.25 });
  let truth = 700;
  let at = 5_000_000;
  let previous = null;
  let worstStep = 0;

  for (let i = 0; i < 80; i++) {
    at += 500;
    truth += 0.5;
    est.observe({ position: Math.round(truth), paused: false, rate: 1, at });
    if (!est.ready) continue;
    const now = est.estimate(at);
    if (previous !== null) worstStep = Math.max(worstStep, Math.abs(now - previous - 0.5));
    previous = now;
  }

  // Raw readings would step by a full second at a time; the estimate must not.
  assert.ok(worstStep < 0.3, `estimate jumped by ${worstStep.toFixed(3)}s between reads`);
});

test('the mock driver reports a rounded position when asked to', async () => {
  const driver = new MockDriver({ startPosition: 300, readQuantumSec: 1, reportLagMs: 400, latencyMs: 1 });
  await driver.connect();
  await driver.play();
  driver.advance(2000);
  const read = await driver.position();
  assert.strictEqual(read.position, Math.round(read.position));
  assert.ok(Math.abs(read.position - 302) <= 1);
});

test('a driver that cannot report position says so instead of guessing', async () => {
  const driver = new MockDriver({ readPosition: false, latencyMs: 1 });
  await driver.connect();
  assert.strictEqual(await driver.position(), null);
});
