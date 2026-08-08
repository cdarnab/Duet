'use strict';

/**
 * A fake set-top box that misbehaves the way real ones do: commands land late,
 * skips are quantized, and the position it reports is both stale and noisy.
 *
 * This exists so the closed loop can be tested on a machine with no TV
 * attached, and so a regression in the planner shows up in CI rather than in
 * someone's living room.
 */
class MockDriver {
  constructor(opts = {}) {
    this.name = 'mock';
    this.label = 'Simulated TV';
    this.capabilities = {
      readPosition: opts.readPosition !== false,
      readPaused: opts.readPaused === true || opts.readPosition !== false,
      canJump: true,
      jumpBack: opts.jumpBack ?? 10,
      jumpForward: opts.jumpForward ?? 10,
      commandLatencyMs: opts.latencyMs ?? 120,
    };

    this.position_ = opts.startPosition ?? 0;
    this.paused = true;
    this.rateError = opts.rateError ?? 1.0;
    this.reportLagMs = opts.reportLagMs ?? 400;
    this.reportNoise = opts.reportNoise ?? 0.15;
    // Apple TV rounds its reported position to the whole second. That turns a
    // precise playhead into a ±0.5s square wave, which is larger than the
    // planner's deadband — the single nastiest input this loop has to survive.
    this.readQuantumSec = opts.readQuantumSec ?? 0;
    this.log = [];
    this._lastTick = null;
    this._seed = opts.seed ?? 7;
  }

  _rand() {
    this._seed = (this._seed * 1103515245 + 12345) % 2147483648;
    return this._seed / 2147483648;
  }

  /** Advance the simulated playhead. Call this from the test's clock. */
  advance(ms) {
    if (!this.paused) this.position_ += (ms / 1000) * this.rateError;
    this._lastTick = this.position_;
  }

  async connect() {
    return this;
  }

  async play() {
    await this._delay();
    this.paused = false;
    this.log.push('play');
  }

  async pause() {
    await this._delay();
    this.paused = true;
    this.log.push('pause');
  }

  async resume() {
    return this.play();
  }

  async jump(dir, times = 1) {
    for (let i = 0; i < times; i++) {
      await this._delay();
      const step = dir === 'back' ? -this.capabilities.jumpBack : this.capabilities.jumpForward;
      this.position_ = Math.max(0, this.position_ + step);
      this.log.push(`jump:${dir}`);
    }
  }

  async position() {
    if (!this.capabilities.readPosition) {
      if (!this.capabilities.readPaused) return null;
      await this._delay(0.4);
      return { position: null, paused: this.paused };
    }
    await this._delay(0.4);
    // Report a stale, jittery number — never the truth.
    const stale = (this.reportLagMs / 1000) * (this.paused ? 0 : 1);
    const noise = (this._rand() - 0.5) * 2 * this.reportNoise;
    let reported = Math.max(0, this.position_ - stale + noise);
    if (this.readQuantumSec > 0) {
      reported = Math.round(reported / this.readQuantumSec) * this.readQuantumSec;
    }
    return { position: reported, paused: this.paused };
  }

  _delay(scale = 1) {
    return new Promise((r) => setTimeout(r, this.capabilities.commandLatencyMs * scale));
  }
}

module.exports = { MockDriver };
