'use strict';

/**
 * Apple TV — MediaRemote, via the pyatv project's `atvremote` CLI.
 *
 * Needs a one-time pairing that produces credentials. pyatv does the protocol
 * work; this wraps it. Many apps publish now-playing position through
 * MediaRemote, which makes this the most accurate of the device platforms.
 *
 *   pipx install pyatv
 *   atvscan
 *   atvremote --id <ID> --protocol airplay pair
 */

const { execFile } = require('child_process');
const { promisify } = require('util');
const run = promisify(execFile);

class AppleTvDriver {
  constructor({ id, credentials, bin = 'atvremote', jumpBack = 10, jumpForward = 10 }) {
    this.name = 'appletv';
    this.id = id;
    this.credentials = credentials;
    this.bin = bin;
    this.label = id;
    this.capabilities = {
      readPosition: false,
      canJump: true,
      jumpBack,
      jumpForward,
      commandLatencyMs: 150,
    };
  }

  _args(extra) {
    const args = ['--id', this.id];
    if (this.credentials) args.push('--airplay-credentials', this.credentials);
    return args.concat(extra);
  }

  async connect() {
    const t0 = Date.now();
    const state = await this.position();
    this.capabilities.commandLatencyMs = Math.round((Date.now() - t0) / 2);
    this.capabilities.readPosition = state !== null;
    return this;
  }

  play() { return this._cmd('play'); }
  pause() { return this._cmd('pause'); }
  resume() { return this._cmd('play'); }

  async jump(dir, times = 1) {
    const cmd = dir === 'back' ? 'skip_backward' : 'skip_forward';
    for (let i = 0; i < times; i++) {
      await this._cmd(cmd);
      await new Promise((r) => setTimeout(r, 300));
    }
  }

  /**
   * `set_position` exists on Apple TV and is not quantized, so when it is
   * available we get a real seek instead of a stack of skip presses.
   */
  async seek(seconds) {
    await this._cmd(`set_position=${Math.max(0, Math.round(seconds))}`);
  }

  async position() {
    try {
      const out = await this._cmd('playing');
      const pos = /Position:\s*(\d+)/.exec(out);
      const dev = /Device state:\s*(\w+)/.exec(out);
      if (!pos) return null;
      return { position: Number(pos[1]), paused: (dev?.[1] || '').toLowerCase() !== 'playing' };
    } catch {
      return null;
    }
  }

  async _cmd(command) {
    const { stdout } = await run(this.bin, this._args([command]), { timeout: 10000 });
    return stdout;
  }
}

module.exports = { AppleTvDriver };
