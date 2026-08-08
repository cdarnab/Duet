'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { planCorrection, planDuration, constants } = require('../agent/control');

const roku = { canJump: true, jumpBack: 10, jumpForward: 10 };
const netflixStyle = { canJump: true, jumpBack: 10, jumpForward: 30 };
const noJump = { canJump: false };

test('a device inside the deadband is left alone', () => {
  const plan = planCorrection(0.2, roku);
  assert.strictEqual(plan.strategy, 'in-step');
  assert.strictEqual(plan.steps.length, 0);
});

test('a device slightly ahead is fixed by pausing it, not by skipping', () => {
  const plan = planCorrection(3.2, roku);
  assert.strictEqual(plan.strategy, 'hold-device');
  assert.deepStrictEqual(plan.steps, [{ op: 'holdDevice', seconds: 3.2 }]);
});

test('a device slightly behind is fixed by holding the room instead', () => {
  // Nobody should have to touch a remote when the other side is automated.
  const plan = planCorrection(-4.5, roku);
  assert.strictEqual(plan.strategy, 'hold-room');
  assert.deepStrictEqual(plan.steps, [{ op: 'holdRoom', seconds: 4.5 }]);
});

test('the room is never held longer than the cap', () => {
  const plan = planCorrection(-(constants.MAX_ROOM_HOLD + 20), roku);
  const roomHolds = plan.steps.filter((s) => s.op === 'holdRoom');
  roomHolds.forEach((s) => assert.ok(s.seconds <= constants.MAX_ROOM_HOLD));
});

test('a big lead is closed with one jump plus a hold, landing exactly', () => {
  const drift = 34; // device 34s ahead, 10s jumps
  const plan = planCorrection(drift, roku);
  assert.strictEqual(plan.steps[0].op, 'jump');
  assert.strictEqual(plan.steps[0].dir, 'back');
  assert.strictEqual(plan.steps[0].times, 3);

  const moved = -plan.steps[0].seconds;
  const afterJump = drift + moved; // 34 - 30 = 4, still ahead
  assert.ok(Math.abs(afterJump) < 10);
  assert.deepStrictEqual(plan.steps[1], { op: 'holdDevice', seconds: 4 });
});

test('a big lag overshoots forward on purpose, because ahead is correctable', () => {
  const drift = -47; // device 47s behind, 30s forward jumps
  const plan = planCorrection(drift, netflixStyle);
  const jump = plan.steps[0];
  assert.strictEqual(jump.dir, 'forward');
  assert.strictEqual(jump.times, 2); // ceil(47/30) — deliberately past the target

  const afterJump = drift + jump.seconds; // -47 + 60 = +13, now ahead
  assert.ok(afterJump > 0, 'the jump should overshoot into the correctable direction');
  assert.strictEqual(plan.steps[1].op, 'holdDevice');
  assert.strictEqual(plan.steps[1].seconds, 13);
});

test('every plan lands within the deadband on paper', () => {
  const caps = [roku, netflixStyle, { canJump: true, jumpBack: 15, jumpForward: 15 }];
  for (const cap of caps) {
    for (let drift = -120; drift <= 120; drift += 0.5) {
      const plan = planCorrection(drift, cap);
      if (plan.strategy === 'manual' || plan.strategy === 'in-step') continue;

      let residual = drift;
      for (const step of plan.steps) {
        if (step.op === 'jump') residual += step.dir === 'back' ? -step.seconds : step.seconds;
        else if (step.op === 'holdDevice') residual -= step.seconds;
        else if (step.op === 'holdRoom') residual += step.seconds;
      }
      assert.ok(
        Math.abs(residual) <= constants.DEADBAND + 0.01,
        `drift ${drift} with jumps ${cap.jumpBack}/${cap.jumpForward} left ${residual.toFixed(2)}s`
      );
    }
  }
});

test('a device with no skip keys asks the person for help rather than guessing', () => {
  const plan = planCorrection(60, noJump);
  assert.strictEqual(plan.strategy, 'manual');
  assert.match(plan.note, /skip back about 60 seconds/i);
});

test('a small gap on a device with no skip keys is still fixed automatically', () => {
  const plan = planCorrection(5, noJump);
  assert.strictEqual(plan.strategy, 'hold-device');
});

test('plan duration is reported so the loop can wait it out', () => {
  const plan = planCorrection(34, roku);
  assert.ok(planDuration(plan) > 4);
});

test('nonsense drift does not produce a plan', () => {
  assert.strictEqual(planCorrection(NaN, roku).strategy, 'in-step');
  assert.strictEqual(planCorrection(undefined, roku).strategy, 'in-step');
});
