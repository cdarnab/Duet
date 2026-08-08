'use strict';

/**
 * Android TV and Fire TV — ADB over the network.
 *
 * Requires the person to turn on developer options and network debugging once,
 * and to accept the pairing prompt on screen. After that the device answers
 * keyevents and, usefully, reports real playback position through the media
 * session service — so this is one of the platforms where the loop can close.
 */

const { execFile } = require('child_process');
const { promisify } = require('util');
const run = promisify(execFile);

const KEY = {
  play: 126,
  pause: 127,
  playPause: 85,
  forward: 90,
  rewind: 89,
};

class AndroidTvDriver {
  constructor({ host, port = 5555, adb = 'adb', jumpBack = 10, jumpForward = 10 }) {
    this.name = 'androidtv';
    this.serial = `${host}:${port}`;
    this.adb = adb;
    this.label = this.serial;
    this.capabilities = {
      readPosition: false,
      canJump: true,
      jumpBack,
      jumpForward,
      commandLatencyMs: 120,
    };
  }

  async connect() {
    await run(this.adb, ['connect', this.serial], { timeout: 8000 });
    const { stdout } = await run(this.adb, ['-s', this.serial, 'shell', 'getprop', 'ro.product.model'], { timeout: 8000 });
    this.label = stdout.trim() || this.serial;

    const t0 = Date.now();
    await this._shell('echo ping');
    this.capabilities.commandLatencyMs = Date.now() - t0;

    this.capabilities.readPosition = (await this.position()) !== null;
    return this;
  }

  play() {
    return this._key(KEY.play);
  }

  pause() {
    return this._key(KEY.pause);
  }

  resume() {
    return this._key(KEY.play);
  }

  async jump(dir, times = 1) {
    const key = dir === 'back' ? KEY.rewind : KEY.forward;
    for (let i = 0; i < times; i++) {
      await this._key(key);
      await new Promise((r) => setTimeout(r, 280));
    }
  }

  /**
   * The media session reports position as of a timestamp, not as of now, so
   * the reading is projected forward before it is used.
   */
  async position() {
    try {
      const out = await this._shell('dumpsys media_session');
      const match = /state=PlaybackState\s*\{state=(\d+),\s*position=(\d+),[^}]*updated=(\d+)/.exec(out);
      if (!match) return null;

      const state = Number(match[1]);
      let position = Number(match[2]) / 1000;
      const updatedAt = Number(match[3]);
      const paused = state !== 3; // 3 == STATE_PLAYING

      const uptime = await this._uptimeMs();
      if (!paused && uptime && updatedAt) {
        position += Math.max(0, (uptime - updatedAt) / 1000);
      }
      return { position, paused };
    } catch {
      return null;
    }
  }

  async _uptimeMs() {
    try {
      const out = await this._shell('cat /proc/uptime');
      return Math.round(parseFloat(out.trim().split(/\s+/)[0]) * 1000);
    } catch {
      return null;
    }
  }

  _key(code) {
    return this._shell(`input keyevent ${code}`);
  }

  async _shell(cmd) {
    const { stdout } = await run(this.adb, ['-s', this.serial, 'shell', cmd], {
      timeout: 8000,
      maxBuffer: 8 * 1024 * 1024,
    });
    return stdout;
  }
}

module.exports = { AndroidTvDriver, KEY };
