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

function pickAdbSerial(devices, { prefer } = {}) {
  const live = (devices || []).filter(
    (d) => d.status === 'device' && !/^emulator-/.test(d.serial)
  );
  if (!live.length) return null;
  const blob = (d) => `${d.serial} ${d.extra || ''}`;
  if (prefer === 'firetv') {
    const fire = live.find((d) => /amazon|fire|\baft|toshiba/i.test(blob(d)));
    if (fire) return fire.serial;
    if (live.length === 1) return live[0].serial;
    return null;
  }
  if (prefer === 'nebula') {
    const neb = live.find((d) => /d2426|nebula|_adb-tls-connect/i.test(blob(d)));
    if (neb) return neb.serial;
  }
  const mdns = live.find((d) => d.serial.includes('_adb-tls-connect'));
  return (mdns || live[0]).serial;
}

async function listAdbDevices(adb = 'adb') {
  const { stdout } = await run(adb, ['devices', '-l'], { timeout: 8000 });
  return parseAdbDevices(stdout);
}

async function adbConnect(host, port = 5555, adb = 'adb') {
  const serial = String(host).includes(':') ? String(host) : `${host}:${port}`;
  await run(adb, ['connect', serial], { timeout: 8000 });
  return serial;
}

/** Parse dumpsys media_session. Prefer a Netflix session when several exist. */
function parseMediaSession(dump, prefer = /netflix/i) {
  if (!dump) return null;
  const chunks = String(dump).split(/(?=Session\s+#)/i);
  const hits = [];
  for (const chunk of chunks) {
    const match =
      /state=PlaybackState\s*\{state=(\d+),\s*position=(\d+)[\s\S]*?updated=(\d+)/.exec(chunk) ||
      /state=PlaybackState\s*\{state=(\d+),\s*position=(\d+)/.exec(chunk) ||
      /PlaybackState\s*\{state=(\d+)/.exec(chunk);
    if (!match) continue;
    const state = Number(match[1]);
    const positionMs = match[2] !== undefined ? Number(match[2]) : null;
    hits.push({
      state,
      positionMs: Number.isFinite(positionMs) ? positionMs : null,
      updatedAt: match[3] ? Number(match[3]) : null,
      preferred: prefer.test(chunk),
    });
  }
  const hit = hits.sort((a, b) => Number(b.preferred) - Number(a.preferred))[0];
  if (!hit) return null;
  return {
    position: hit.positionMs == null ? null : hit.positionMs / 1000,
    paused: hit.state !== 3 && hit.state !== 6,
    updatedAt: hit.updatedAt,
  };
}

/**
 * Fallback when the app never publishes a MediaSession (Nebula’s phone Netflix).
 * dumpsys audio still reports whether a USAGE_MEDIA player is started or paused.
 */
function parseAudioPlayback(dump) {
  if (!dump) return null;
  const chunks = String(dump).split(/(?=AudioPlaybackConfiguration\b)/i);
  const hits = [];
  for (const chunk of chunks) {
    const stateMatch = /\bstate:(started|paused|stopped|idle)\b/i.exec(chunk);
    if (!stateMatch) continue;
    const usage = /USAGE_([A-Z0-9_]+)/i.exec(chunk);
    const content = /CONTENT_TYPE_([A-Z0-9_]+)/i.exec(chunk);
    const usageName = (usage?.[1] || '').toUpperCase();
    const contentName = (content?.[1] || '').toUpperCase();
    if (/NOTIFICATION|ALARM|RINGTONE|ENFORCED|ASSISTANT|ASSISTANCE|SONIFICATION/.test(usageName + contentName)) {
      continue;
    }
    if (usageName && !/MEDIA|GAME/.test(usageName) && !/MOVIE|MUSIC|SPEECH/.test(contentName)) {
      continue;
    }
    hits.push({
      paused: stateMatch[1].toLowerCase() !== 'started',
      preferred: /MOVIE|MEDIA/.test(`${usageName} ${contentName}`) || /netflix/i.test(chunk),
    });
  }
  const hit = hits.sort((a, b) => Number(b.preferred) - Number(a.preferred))[0];
  return hit ? { paused: hit.paused, position: null } : null;
}

class AndroidTvDriver {
  constructor({ host, port = 5555, serial, adb = 'adb', jumpBack = 10, jumpForward = 10, flavor = 'androidtv' }) {
    this.name = flavor === 'nebula' ? 'nebula' : flavor === 'firetv' ? 'firetv' : 'androidtv';
    this.flavor = flavor === 'nebula' ? 'nebula' : 'androidtv';
    const mdns = String(serial || host || '').includes('_adb-tls-connect');
    this.serial = serial || (mdns ? String(host) : `${host}:${port}`);
    this.skipConnect = Boolean(serial) || mdns;
    this.adb = adb;
    this.label = this.serial;
    this.capabilities = {
      readPosition: false,
      readPaused: false,
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

    const probe = await this.position();
    this.capabilities.readPosition = Boolean(probe && Number.isFinite(probe.position));
    this.capabilities.readPaused = Boolean(probe && typeof probe.paused === 'boolean');
    return this;
  }

  async play(known) {
    if (this.flavor === 'nebula') return this._toggleTo(false, known);
    return this._key(KEY.play);
  }

  async pause(known) {
    if (this.flavor === 'nebula') return this._toggleTo(true, known);
    return this._key(KEY.pause);
  }

  async resume(known) {
    return this.play(known);
  }

  async _toggleTo(paused, known) {
    const state = known && typeof known.paused === 'boolean' ? known : await this.position();
    if (state && state.paused === paused) return;
    return this._key(KEY.playPause);
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
   * the reading is projected forward before it is used. Nebula’s phone Netflix
   * often has no session — fall back to dumpsys audio for pause/play only.
   */
  async position() {
    try {
      const sessionDump = await this._shell('dumpsys media_session');
      const session = parseMediaSession(sessionDump);
      if (session && typeof session.paused === 'boolean') {
        let position = session.position;
        if (Number.isFinite(position) && !session.paused && session.updatedAt) {
          const uptime = await this._uptimeMs();
          if (uptime) position += Math.max(0, (uptime - session.updatedAt) / 1000);
        }
        return { position: Number.isFinite(position) ? position : null, paused: session.paused };
      }
    } catch {
      /* try audio */
    }
    try {
      const audioDump = await this._shell('dumpsys audio');
      return parseAudioPlayback(audioDump);
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
  parseAudioPlayback,
  parseAdbDevices,
  pickAdbSerial,
  listAdbDevices,
  adbConnect,
};
