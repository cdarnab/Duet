'use strict';

/**
 * A TV tells you where it is badly: once every half second, rounded to the
 * nearest second, already a few hundred milliseconds stale. Used raw, that
 * reading jitters by ±500ms and would make the browser side seek constantly.
 *
 * So we don't use it raw. We keep a local dead-reckoned estimate of the
 * playhead and let each reading nudge it. Quantisation error is roughly
 * zero-mean, so a low-gain filter averages it away and leaves a smooth,
 * continuous position that is far more accurate than any single reading.
 *
 * A genuine seek on the device looks nothing like quantisation noise — it
 * shows up as a large residual, and that re-anchors the estimate immediately.
 */
class PositionEstimator {
  constructor({ gain = 0.25, reanchorSec = 1.5, minObservations = 3 } = {}) {
    this.gain = gain;
    this.reanchorSec = reanchorSec;
    this.minObservations = minObservations;
    this.reset();
  }

  reset() {
    this.anchorPos = null;
    this.anchorAt = 0;
    this.paused = true;
    this.rate = 1;
    this.observations = 0;
    this.lastSeekAt = 0;
    this.residual = 0;
  }

  get ready() {
    return this.anchorPos !== null && this.observations >= this.minObservations;
  }

  /** Where we believe the playhead is at local time `at`. */
  estimate(at) {
    if (this.anchorPos === null) return 0;
    if (this.paused) return this.anchorPos;
    return this.anchorPos + ((at - this.anchorAt) / 1000) * this.rate;
  }

  _anchor(position, at, paused, rate) {
    this.anchorPos = position;
    this.anchorAt = at;
    this.paused = paused;
    this.rate = rate;
  }

  /**
   * Fold one device reading in.
   * Returns 'anchor' on a hard re-anchor (first read, transport change, or a
   * seek on the device), 'blend' for a routine nudge.
   */
  observe({ position, paused = false, rate = 1, at }) {
    if (!Number.isFinite(position) || position < 0) return 'ignored';
    this.observations++;

    // No history, or the device started/stopped: trust the reading outright.
    if (this.anchorPos === null || paused !== this.paused) {
      this._anchor(position, at, paused, rate);
      return 'anchor';
    }

    const predicted = this.estimate(at);
    const residual = position - predicted;
    this.residual = residual;

    // Too big to be rounding — somebody moved the playhead.
    if (Math.abs(residual) > this.reanchorSec) {
      this._anchor(position, at, paused, rate);
      this.lastSeekAt = at;
      return 'anchor';
    }

    // Routine nudge. Shift the anchor, keep the clock, keep it continuous.
    this.anchorPos += residual * this.gain;
    this.rate = rate;
    return 'blend';
  }
}

module.exports = { PositionEstimator };
