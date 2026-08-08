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

function parseAdbDevices(text) {
  const devices = [];
  for (const line of String(text).split(/\r?\n/)) {
    const match = /^(\S+)\s+(device|offline|unauthorized|connecting)\b(.*)$/.exec(line.trim());
    if (!match) continue;
    devices.push({ serial: match[1], status: match[2], extra: String(match[3] || '').trim() });
  }
  return devices;
}

function pickAdbSerial(devices) {
  const live = (devices || []).filter(
    (d) => d.status === 'device' && !/^emulator-/.test(d.serial)
  );
  if (!live.length) return null;
  const mdns = live.find((d) => d.serial.includes('_adb-tls-connect'));
  return (mdns || live[0]).serial;
}

async function listAdbDevices(adb = 'adb') {
  const { stdout } = await run(adb, ['devices', '-l'], { timeout: 8000 });
  return parseAdbDevices(stdout);
}

/** Parse dumpsys media_session. Prefer a Netflix session when several exist. */
function parseMediaSession(dump, prefer = /netflix/i) {
  if (!dump) return null;
  const chunks = String(dump).split(/(?=Session\s+#)/i);
  const hits = [];
  for (const chunk of chunks) {
    const match =
      /state=PlaybackState\s*\{state=(\d+),\s*position=(\d+)[\s\S]*?updated=(\d+)/.exec(chunk) ||
      /state=PlaybackState\s*\{state=(\d+),\s*position=(\d+)/.exec(chunk);
    if (!match) continue;
    hits.push({
      state: Number(match[1]),
      positionMs: Number(match[2]),
      updatedAt: match[3] ? Number(match[3]) : null,
      preferred: prefer.test(chunk),
    });
  }
  const hit = hits.sort((a, b) => Number(b.preferred) - Number(a.preferred))[0];
  if (!hit) return null;
  return {
    position: hit.positionMs / 1000,
    paused: hit.state !== 3,
    updatedAt: hit.updatedAt,
  };
}

class AndroidTvDriver {
  constructor({ host, port = 5555, serial, adb = 'adb', jumpBack = 10, jumpForward = 10, flavor = 'androidtv' }) {
    this.name = flavor === 'nebula' ? 'nebula' : 'androidtv';
    this.flavor = flavor === 'nebula' ? 'nebula' : 'androidtv';
    const mdns = String(serial || host || '').includes('_adb-tls-connect');
    this.serial = serial || (mdns ? String(host) : `${host}:${port}`);
    this.skipConnect = Boolean(serial) || mdns;
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
    if (!this.skipConnect) {
      await run(this.adb, ['connect', this.serial], { timeout: 8000 });
    }
    const { stdout } = await run(this.adb, ['-s', this.serial, 'shell', 'getprop', 'ro.product.model'], { timeout: 8000 });
    this.label = stdout.trim() || this.serial;

    const t0 = Date.now();
    await this._shell('echo ping');
    this.capabilities.commandLatencyMs = Date.now() - t0;

    this.capabilities.readPosition = (await this.position()) !== null;
    return this;
  }

  play() {
    return this._key(this.flavor === 'nebula' ? KEY.playPause : KEY.play);
  }

  pause() {
    return this._key(this.flavor === 'nebula' ? KEY.playPause : KEY.pause);
  }

  resume() {
    return this._key(this.flavor === 'nebula' ? KEY.playPause : KEY.play);
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
      const parsed = parseMediaSession(out);
      if (!parsed) return null;

      let position = parsed.position;
      const uptime = await this._uptimeMs();
      if (!parsed.paused && uptime && parsed.updatedAt) {
        position += Math.max(0, (uptime - parsed.updatedAt) / 1000);
      }
      return { position, paused: parsed.paused };
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

module.exports = {
  AndroidTvDriver,
  KEY,
  parseMediaSession,
  parseAdbDevices,
  pickAdbSerial,
  listAdbDevices,
};
