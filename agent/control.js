'use strict';

/**
 * Correction planning for devices you can only poke with a remote.
 *
 * The browser corrector trims playback speed, which is continuous and
 * invisible. A Roku or an Apple TV gives you none of that. You get transport
 * keys and a skip key that jumps a fixed number of seconds, so every seek is
 * quantized to a multiple of 10, 15, or 30.
 *
 * The way out is that *waiting is a seek*. Pausing a player for 3.2 seconds
 * moves it back 3.2 seconds relative to everyone else, at whatever precision
 * your clock has. That gives two continuous instruments:
 *
 *   - hold the device: moves the device back, up to MAX_DEVICE_HOLD
 *   - hold the room:   moves the device forward, up to MAX_ROOM_HOLD
 *
 * Skips only exist to cover distance those two cannot. So the planner picks
 * the number of skips whose *remainder* lands inside one of those windows,
 * rather than the count that gets nearest on its own — sometimes deliberately
 * stopping short and letting the room wait, sometimes overshooting past the
 * target so the device can pause it off.
 */

// Below this we do nothing. A keypress round trip is tens of milliseconds and
// position readback is noisier than that, so chasing anything finer is noise.
const DEADBAND = 0.4;

// A device paused longer than this looks broken to whoever is watching it.
const MAX_DEVICE_HOLD = 25;

// The room may only be held this long — the other person is watching too.
const MAX_ROOM_HOLD = 8;

// Rough wall time per skip press, used to prefer fewer presses.
const PRESS_COST = 0.4;

/**
 * @param {number} drift  devicePosition - roomPosition. Positive = device ahead.
 * @param {object} caps   { canJump, jumpBack, jumpForward }
 * @returns {{steps: Array, strategy: string, residual: number, note?: string}}
 */
function planCorrection(drift, caps = {}, limits = {}) {
  const deadband = limits.deadband ?? DEADBAND;
  const maxDeviceHold = limits.maxDeviceHold ?? MAX_DEVICE_HOLD;
  const maxRoomHold = limits.maxRoomHold ?? MAX_ROOM_HOLD;

  if (!Number.isFinite(drift) || Math.abs(drift) <= deadband) {
    return { steps: [], strategy: 'in-step', residual: drift || 0 };
  }

  const jumpBack = caps.jumpBack || 0;
  const jumpForward = caps.jumpForward || 0;
  const canJump = Boolean(caps.canJump && jumpBack && jumpForward);

  const settleable = (r) => r >= -maxRoomHold && r <= maxDeviceHold;

  /* Enumerate what the skip key can reach, including doing nothing at all. */
  const candidates = [{ times: 0, dir: null, residual: drift }];
  if (canJump) {
    const backLimit = Math.ceil(Math.abs(drift) / jumpBack) + 1;
    for (let n = 1; n <= backLimit; n++) {
      candidates.push({ times: n, dir: 'back', residual: drift - n * jumpBack });
    }
    const fwdLimit = Math.ceil(Math.abs(drift) / jumpForward) + 1;
    for (let n = 1; n <= fwdLimit; n++) {
      candidates.push({ times: n, dir: 'forward', residual: drift + n * jumpForward });
    }
  }

  // Cost is the time the correction actually takes: the wait plus the presses.
  const cost = (c) => Math.abs(c.residual) + c.times * PRESS_COST;
  const step = (c) => ({
    op: 'jump',
    dir: c.dir,
    times: c.times,
    seconds: c.times * (c.dir === 'back' ? jumpBack : jumpForward),
  });

  const viable = candidates.filter((c) => settleable(c.residual)).sort((a, b) => cost(a) - cost(b));

  if (viable.length) {
    const best = viable[0];
    const steps = [];
    if (best.times > 0) steps.push(step(best));
    steps.push(...settle(best.residual, deadband, maxDeviceHold, maxRoomHold));
    return {
      steps,
      strategy:
        best.times === 0
          ? best.residual > 0
            ? 'hold-device'
            : 'hold-room'
          : `jump-${best.dir}-then-settle`,
      residual: 0,
    };
  }

  /* Nothing landed in a settleable window. This only happens when the skip
     size exceeds both hold windows combined. Being ahead is always fixable by
     waiting, so overshoot deliberately and pay for it in chunked pauses. */
  if (canJump) {
    const ahead = candidates.filter((c) => c.residual > 0).sort((a, b) => cost(a) - cost(b))[0];
    if (ahead) {
      const steps = [];
      if (ahead.times > 0) steps.push(step(ahead));
      steps.push(...chunkDeviceHold(ahead.residual, maxDeviceHold, deadband));
      return { steps, strategy: `jump-${ahead.dir}-then-settle`, residual: 0 };
    }
  }

  return manual(drift);
}

/** Land the remainder with a single hold on whichever side can absorb it. */
function settle(residual, deadband, maxDeviceHold, maxRoomHold) {
  if (Math.abs(residual) <= deadband) return [];
  if (residual > 0) {
    return [{ op: 'holdDevice', seconds: round(Math.min(residual, maxDeviceHold)) }];
  }
  return [{ op: 'holdRoom', seconds: round(Math.min(-residual, maxRoomHold)) }];
}

/** Split an over-long device pause into several, so none looks like a freeze. */
function chunkDeviceHold(seconds, cap, deadband) {
  const steps = [];
  let left = seconds;
  while (left > deadband) {
    const take = Math.min(left, cap);
    steps.push({ op: 'holdDevice', seconds: round(take) });
    left -= take;
  }
  return steps;
}

function manual(drift) {
  const secs = Math.round(Math.abs(drift));
  return {
    steps: [],
    strategy: 'manual',
    residual: drift,
    note:
      drift > 0
        ? `Skip back about ${secs} seconds on the TV — the gap is past what a pause can absorb.`
        : `Skip forward about ${secs} seconds on the TV — the gap is past what a pause can absorb.`,
  };
}

const round = (n) => Math.round(n * 100) / 100;

/** Total wall time a plan will take to execute. */
function planDuration(plan) {
  return plan.steps.reduce((total, s) => {
    if (s.op === 'holdDevice' || s.op === 'holdRoom') return total + s.seconds;
    if (s.op === 'jump') return total + s.times * PRESS_COST;
    return total;
  }, 0);
}

module.exports = {
  planCorrection,
  planDuration,
  constants: { DEADBAND, MAX_DEVICE_HOLD, MAX_ROOM_HOLD },
};
