'use strict';

/**
 * Roku — External Control Protocol.
 *
 * Plain HTTP on port 8060, no pairing, no auth, available to anything on the
 * same network. Roku documents it; nothing here is a workaround.
 *
 * Position readback depends on the channel. Channels built on Roku's video
 * node answer /query/media-player with a real position. Netflix and a few
 * others run their own player and report only a state, so we degrade to
 * open-loop and say so rather than syncing against a number we invented.
 */

const BASE_LATENCY_MS = 45;

class RokuDriver {
  constructor({ host, port = 8060, jumpBack = 10, jumpForward = 10 }) {
    this.name = 'roku';
    this.host = host;
    this.port = port;
    this.base = `http://${host}:${port}`;
    this.capabilities = {
      readPosition: false, // upgraded during connect() if the channel reports one
      canJump: true,
      jumpBack,
      jumpForward,
      commandLatencyMs: BASE_LATENCY_MS,
    };
    this.label = host;
  }

  async connect() {
    const info = await this._get('/query/device-info');
    const model = /<model-name>(.*?)<\/model-name>/.exec(info)?.[1];
    const name = /<user-device-name>(.*?)<\/user-device-name>/.exec(info)?.[1];
    this.label = name || model || this.host;

    // Measure the real round trip rather than trusting a constant.
    const t0 = Date.now();
    await this._get('/query/device-info');
    this.capabilities.commandLatencyMs = Math.round((Date.now() - t0) / 2);

    const probe = await this.position();
    this.capabilities.readPosition = probe !== null;
    return this;
  }

  async play() {
    await this._post('/keypress/Play');
  }

  // Roku exposes one Play/Pause toggle, so transport is driven by observed state.
  async pause() {
    const state = await this.position();
    if (state && state.paused) return;
    await this._post('/keypress/Play');
  }

  async resume() {
    const state = await this.position();
    if (state && !state.paused) return;
    await this._post('/keypress/Play');
  }

  async jump(dir, times = 1) {
    const key = dir === 'back' ? 'Rev' : 'Fwd';
    for (let i = 0; i < times; i++) {
      await this._post(`/keypress/${key}`);
      await sleep(320); // Roku coalesces presses sent faster than this
    }
    // Some channels need an explicit confirm to commit a scrub.
    await this._post('/keypress/Play').catch(() => {});
  }

  async position() {
    try {
      const xml = await this._get('/query/media-player');
      const pos = /<position>(\d+)\s*ms<\/position>/.exec(xml);
      const state = /state="(\w+)"/.exec(xml)?.[1];
      if (!pos) return null;
      return { position: Number(pos[1]) / 1000, paused: state === 'pause' };
    } catch {
      return null;
    }
  }

  async _get(path) {
    const res = await fetch(this.base + path, { signal: AbortSignal.timeout(4000) });
    if (!res.ok) throw new Error(`Roku ${path} returned ${res.status}`);
    return res.text();
  }

  async _post(path) {
    const res = await fetch(this.base + path, { method: 'POST', signal: AbortSignal.timeout(4000) });
    if (!res.ok) throw new Error(`Roku ${path} returned ${res.status}`);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

module.exports = { RokuDriver };
