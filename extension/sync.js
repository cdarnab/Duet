/**
 * Duet sync core.
 *
 * Pure, dependency-free playback-sync math. Loaded by the Node server, the
 * Chrome extension service worker, and the browser clients, so it must stay
 * runnable as a plain script and as a CommonJS module.
 *
 * Design: we never stream video between peers. We sync *intent* (paused,
 * position, at-what-server-time) and let each side drive its own player.
 */
(function (root, factory) {
  const mod = factory();
  if (typeof module === 'object' && module.exports) module.exports = mod;
  root.DuetSync = mod;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  // Beyond this drift we jump. A seek is jarring, so the bar is high.
  const HARD_SEEK = 0.75;
  // Inside this band we do nothing. Roughly one frame at 24fps. Two players
  // can each sit at the edge of it, so the worst case gap between them is
  // twice this number — keep it tight.
  const DEADBAND = 0.04;
  // Playback-rate trim ceiling. Browsers preserve pitch, and 5% is well under
  // the threshold where a tempo change is noticeable.
  const MAX_RATE_TRIM = 0.05;
  // Proportional gain. Must be high enough to actually claw back drift rather
  // than merely cancelling a decoder's rate error.
  const RATE_GAIN = 0.2;

  /** Where the shared state says we should be, right now, on the server clock. */
  function projected(state, serverNow) {
    if (!state) return 0;
    if (state.paused) return state.position;
    const elapsed = Math.max(0, serverNow - state.atServerTime) / 1000;
    return state.position + elapsed * (state.rate || 1);
  }

  /**
   * Decide how to bring a local player back in line.
   * Returns { action: 'none' | 'seek' | 'rate', target, rate, drift }.
   * drift > 0 means this player is ahead of the room.
   */
  function correction({ state, serverNow, localPosition, duration }) {
    let target = projected(state, serverNow);
    if (typeof duration === 'number' && duration > 0) target = Math.min(target, duration);
    if (target < 0) target = 0;

    const drift = localPosition - target;
    const magnitude = Math.abs(drift);

    if (state.paused) {
      return { action: magnitude > DEADBAND ? 'seek' : 'none', target, rate: 1, drift };
    }
    if (magnitude > HARD_SEEK) {
      return { action: 'seek', target, rate: 1, drift };
    }
    if (magnitude > DEADBAND) {
      // Glide back: run slightly slow if we're ahead, slightly fast if behind.
      const trim = Math.min(MAX_RATE_TRIM, magnitude * RATE_GAIN);
      const rate = 1 - Math.sign(drift) * trim;
      return { action: 'rate', target, rate: Number(rate.toFixed(4)), drift };
    }
    return { action: 'rate', target, rate: 1, drift };
  }

  /**
   * NTP-style clock alignment. Both sides need to agree on "now" before they
   * can agree on "where in the movie". Keeps the low-RTT half of samples and
   * takes the median, which throws out spikes from a congested link.
   */
  class ClockSync {
    constructor() {
      this.samples = [];
      this.offset = 0;
      this.rtt = 0;
      this.ready = false;
    }

    /** t0: local send, t1: server stamp, t2: local receive. */
    addSample(t0, t1, t2) {
      const rtt = t2 - t0;
      if (rtt < 0 || !Number.isFinite(rtt)) return this.offset;
      this.samples.push({ offset: t1 - (t0 + t2) / 2, rtt });
      if (this.samples.length > 20) this.samples.shift();

      const keep = Math.max(1, Math.ceil(this.samples.length / 2));
      const best = [...this.samples].sort((a, b) => a.rtt - b.rtt).slice(0, keep);
      best.sort((a, b) => a.offset - b.offset);

      this.offset = best[Math.floor(best.length / 2)].offset;
      this.rtt = best[0].rtt;
      this.ready = this.samples.length >= 3;
      return this.offset;
    }

    now(localNow) {
      return (localNow === undefined ? Date.now() : localNow) + this.offset;
    }
  }

  /** 01:23:45.6 — timecode reads better than raw seconds on a console. */
  function timecode(seconds) {
    if (!Number.isFinite(seconds) || seconds < 0) seconds = 0;
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    const t = Math.floor((seconds % 1) * 10);
    const pad = (n) => String(n).padStart(2, '0');
    return `${pad(h)}:${pad(m)}:${pad(s)}.${t}`;
  }

  return {
    projected,
    correction,
    ClockSync,
    timecode,
    constants: { HARD_SEEK, DEADBAND, MAX_RATE_TRIM, RATE_GAIN },
  };
});
