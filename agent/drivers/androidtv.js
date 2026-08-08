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

function matchAdbSerial(devices, serial) {
  const want = String(serial || '');
  if (!want) return null;
  const host = want.includes(':') ? want.split(':')[0] : want;
  return (
    (devices || []).find((d) => d.serial === want || d.serial === host || d.serial.startsWith(`${host}:`)) ||
    null
  );
}

function adbAuthHint(kind = 'firetv') {
  if (kind === 'firetv') {
    return 'Fire TV ADB is unauthorized. On the TV, tap Allow USB debugging (check Always allow from this computer), then run npm run firetv again.';
  }
  return 'ADB is unauthorized. On the TV, tap Allow USB debugging (Always allow), then try again.';
}

async function waitForAdbAuthorized(
  serial,
  {
    listDevices,
    reconnect,
    log = () => {},
    sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
    timeoutMs = 90_000,
    intervalMs = 2000,
    hint = adbAuthHint('firetv'),
  } = {}
) {
  if (!listDevices) throw new Error(hint);
  const deadline = Date.now() + timeoutMs;
  let announced = false;
  while (Date.now() < deadline) {
    if (reconnect) {
      try {
        await reconnect();
      } catch {
        /* still unauthorized / offline */
      }
    }
    const devices = await listDevices();
    const hit = matchAdbSerial(devices, serial);
    if (hit?.status === 'device') return hit.serial;
    if (!announced) {
      log('Waiting for you to tap Allow on the TV…');
      announced = true;
    }
    await sleep(intervalMs);
  }
  throw new Error(hint);
}

function splitMediaSessions(dump) {
  const text = String(dump || '');
  if (/Session\s+#/i.test(text)) return text.split(/(?=Session\s+#)/i);
  return text.split(/(?=^\s+\S.+\([^)]*userId=)/m);
}

/**
 * PlaybackState.updated is elapsedRealtime. If it is frozen or on a different
 * clock than /proc/uptime, projecting the playhead invents tens of seconds of
 * fake drift — Fire TV Netflix does this constantly.
 */
function isLivePlayhead(session, uptimeMs, { maxAgeMs = 4000 } = {}) {
  if (!session || !Number.isFinite(session.position) || !Number.isFinite(session.updatedAt)) return false;
  if (!Number.isFinite(uptimeMs)) return false;
  const age = uptimeMs - session.updatedAt;
  return age >= -500 && age <= maxAgeMs;
}

const LAUNCHER_APP = /tv\.launcher|leanbacklauncher|systemui|screensaver/i;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function parseCurrentApp(dump) {
  const text = String(dump || '');
  const focus = /mCurrentFocus=\S+\s+\S+\s+([A-Za-z0-9._]+)\//.exec(text);
  if (focus) return focus[1];
  const app = /mFocusedApp=.*\s([A-Za-z0-9._]+)\//.exec(text);
  return app ? app[1] : null;
}

function parseWakeLockSize(dump) {
  const match = /size=(\d+)/.exec(String(dump || ''));
  return match ? Number(match[1]) : null;
}

/** Current audio focus only — ignore the historical event log. */
function parseAudioFocusPaused(dump, pkg = /netflix/i) {
  const text = String(dump || '');
  const stack = /Audio Focus stack entries[\s\S]*?(?=Audio event log:|$)/i.exec(text)?.[0] || '';
  if (!/Audio Focus stack entries/i.test(stack)) return null;
  if (pkg.test(stack)) return false;
  return true;
}

/**
 * Fire Netflix ninja freezes PlaybackState. Use live session if it exists,
 * else audio focus, else wake-lock size (HA / python-androidtv).
 */
function inferFirePaused({ app, wakeLockSize, focusPaused, session, uptimeMs } = {}) {
  if (session && typeof session.paused === 'boolean' && isLivePlayhead(session, uptimeMs)) {
    return session.paused;
  }
  if (!app || !/netflix/i.test(app)) return null;
  if (typeof focusPaused === 'boolean') return focusPaused;
  if (Number.isFinite(wakeLockSize)) {
    if (wakeLockSize >= 3) return false;
    if (wakeLockSize >= 1) return true;
  }
  return null;
}

/** Parse dumpsys media_session. Prefer a Netflix session when several exist. */
function parseMediaSession(dump, prefer = /netflix/i) {
  if (!dump) return null;
  const chunks = splitMediaSessions(dump);
  const hits = [];
  for (const chunk of chunks) {
    const match =
      /state=PlaybackState\s*\{state=(\d+),\s*position=(\d+)[\s\S]*?updated=(\d+)/.exec(chunk) ||
      /state=PlaybackState\s*\{state=(\d+),\s*position=(\d+)/.exec(chunk) ||
      /PlaybackState\s*\{state=(\d+)/.exec(chunk);
    if (!match) continue;
    const state = Number(match[1]);
    if (state === 0) continue;
    const positionMs = match[2] !== undefined ? Number(match[2]) : null;
    hits.push({
      state,
      positionMs: Number.isFinite(positionMs) ? positionMs : null,
      updatedAt: match[3] ? Number(match[3]) : null,
      preferred: prefer.test(chunk) || /ninja/i.test(chunk),
      active: /\bactive=true\b/i.test(chunk),
    });
  }
  const hit = hits.sort((a, b) => Number(b.preferred) - Number(a.preferred) || Number(b.active) - Number(a.active))[0];
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
  constructor({
    host,
    port = 5555,
    serial,
    adb = 'adb',
    jumpBack = 10,
    jumpForward = 10,
    flavor = 'androidtv',
    exec,
  } = {}) {
    this.name = flavor === 'nebula' ? 'nebula' : flavor === 'firetv' ? 'firetv' : 'androidtv';
    this.flavor = this.name;
    const mdns = String(serial || host || '').includes('_adb-tls-connect');
    this.serial = serial || (mdns ? String(host) : `${host}:${port}`);
    this.skipConnect = Boolean(serial) || mdns;
    this.adb = adb;
    this._exec = exec || run;
    this.label = this.serial;
    this.capabilities = {
      readPosition: false,
      readPaused: this.flavor === 'firetv',
      publishPaused: this.flavor === 'firetv',
      publishStableMs: this.flavor === 'firetv' ? 1800 : 700,
      canJump: this.flavor !== 'firetv',
      jumpBack,
      jumpForward,
      commandLatencyMs: 120,
      commandHoldMs: this.flavor === 'firetv' ? 2500 : 1500,
    };
  }

  async connect() {
    if (!this.skipConnect) {
      await this._exec(this.adb, ['connect', this.serial], { timeout: 8000 });
    }
    try {
      const { stdout } = await this._exec(this.adb, ['-s', this.serial, 'shell', 'getprop', 'ro.product.model'], {
        timeout: 8000,
      });
      this.label = stdout.trim() || this.serial;
    } catch (err) {
      const detail = `${err.stderr || ''} ${err.message || ''}`;
      if (/unauthorized/i.test(detail)) throw new Error(adbAuthHint(this.name));
      throw err;
    }

    const t0 = Date.now();
    await this._shell('echo ping');
    this.capabilities.commandLatencyMs = Date.now() - t0;

    // Fire Netflix freezes its playhead. Never closed-loop seek. Pause/play
    // is still readable via focus + wake locks, same as python-androidtv.
    if (this.flavor === 'firetv') {
      this.capabilities.readPosition = false;
      this.capabilities.canJump = false;
      this.capabilities.readPaused = true;
      this.capabilities.publishPaused = true;
      this.capabilities.publishStableMs = 1800;
      this.capabilities.commandHoldMs = 2500;
      return this;
    }

    const probe = await this.position();
    this.capabilities.readPosition = Boolean(probe && Number.isFinite(probe.position));
    this.capabilities.readPaused = Boolean(probe && typeof probe.paused === 'boolean');
    return this;
  }

  async play(known) {
    if (this.flavor === 'firetv') return this._fireSetPaused(false);
    if (this.flavor === 'nebula') return this._toggleTo(false, known);
    return this._key(KEY.play);
  }

  async pause(known) {
    if (this.flavor === 'firetv') return this._fireSetPaused(true);
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

  async currentApp() {
    try {
      const dump = await this._shell('dumpsys window 2>/dev/null | grep -e mCurrentFocus -e mFocusedApp');
      return parseCurrentApp(dump);
    } catch {
      return null;
    }
  }

  /** Keys go to the launcher if Netflix is backgrounded — that was the Toshiba miss. */
  async ensureForeground() {
    if (this.flavor !== 'firetv') return;
    const app = await this.currentApp();
    if (app && /netflix/i.test(app)) return;
    if (app && !LAUNCHER_APP.test(app)) return;
    try {
      await this._exec(
        this.adb,
        ['-s', this.serial, 'shell', 'am', 'start', '--activity-single-top', '-n', 'com.netflix.ninja/.MainActivity'],
        { timeout: 8000 }
      );
      await sleep(400);
    } catch {
      /* leave whatever is focused */
    }
  }

  /**
   * Fire Netflix still reports “playing” after a pause, so we must not read
   * sensors to decide whether to press. Laptop follow = exactly one remote
   * play/pause key (85). Overlay is usually already up after the previous press.
   */
  async _fireSetPaused(_wantPaused) {
    await this.ensureForeground();
    await this._key(KEY.playPause);
  }

  async jump(dir, times = 1) {
    if (!this.capabilities.canJump) return;
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
    if (this.flavor === 'firetv') return this._firePosition();
    try {
      const sessionDump = await this._shell('dumpsys media_session');
      const session = parseMediaSession(sessionDump);
      if (session && typeof session.paused === 'boolean') {
        let position = session.position;
        const uptime = await this._uptimeMs();
        if (!isLivePlayhead({ ...session, position }, uptime)) {
          position = null;
        } else if (Number.isFinite(position) && !session.paused && session.updatedAt && uptime) {
          position += Math.max(0, (uptime - session.updatedAt) / 1000);
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

  async _firePosition() {
    let windowDump = '';
    let powerDump = '';
    let audioDump = '';
    let sessionDump = '';
    try {
      windowDump = await this._shell('dumpsys window 2>/dev/null | grep -e mCurrentFocus -e mFocusedApp');
    } catch {
      /* optional */
    }
    try {
      powerDump = await this._shell("dumpsys power | grep -e Locks -e size=");
    } catch {
      /* optional */
    }
    try {
      audioDump = await this._shell('dumpsys audio | grep -A 40 "Audio Focus stack entries"');
    } catch {
      /* optional */
    }
    try {
      sessionDump = await this._shell('dumpsys media_session');
    } catch {
      /* optional */
    }
    const paused = inferFirePaused({
      app: parseCurrentApp(windowDump),
      wakeLockSize: parseWakeLockSize(powerDump),
      focusPaused: parseAudioFocusPaused(audioDump),
      session: parseMediaSession(sessionDump),
      uptimeMs: await this._uptimeMs(),
    });
    if (typeof paused !== 'boolean') return null;
    return { position: null, paused };
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
    const { stdout } = await this._exec(this.adb, ['-s', this.serial, 'shell', cmd], {
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
  matchAdbSerial,
  adbAuthHint,
  waitForAdbAuthorized,
  isLivePlayhead,
  splitMediaSessions,
  parseCurrentApp,
  parseWakeLockSize,
  parseAudioFocusPaused,
  inferFirePaused,
};
