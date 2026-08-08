'use strict';

const readline = require('readline');

const DEFAULT_SERVER = 'https://duet.arnabbanik.com';

function normalizeServer(server) {
  return String(server || DEFAULT_SERVER).replace(/\/+$/, '');
}

function normalizeRoomInput(code) {
  return String(code || '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .slice(0, 8);
}

function canPrompt() {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

function askLine(question, defaultValue = '') {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const suffix = defaultValue ? ` [${defaultValue}]` : '';
    rl.question(`${question}${suffix}: `, (answer) => {
      rl.close();
      resolve(String(answer || '').trim() || defaultValue);
    });
  });
}

function askPassword(question = 'Duet password') {
  return new Promise((resolve, reject) => {
    if (!process.stdin.isTTY) {
      reject(new Error('Password prompt needs a terminal. Use npm run capsule from Terminal.'));
      return;
    }
    const stdin = process.stdin;
    const stdout = process.stdout;
    stdout.write(`${question}: `);
    const wasRaw = Boolean(stdin.isRaw);
    stdin.setRawMode?.(true);
    stdin.resume();
    let pw = '';
    const onData = (buf) => {
      const str = buf.toString('utf8');
      for (const ch of str) {
        if (ch === '\n' || ch === '\r') {
          cleanup();
          stdout.write('\n');
          resolve(pw);
          return;
        }
        if (ch === '\u0003') {
          cleanup();
          stdout.write('\n');
          reject(new Error('Cancelled.'));
          return;
        }
        if (ch === '\u007f' || ch === '\b') {
          pw = pw.slice(0, -1);
          continue;
        }
        if (ch === '\u0015') {
          pw = '';
          continue;
        }
        if (ch.charCodeAt(0) < 32) continue;
        pw += ch;
      }
    };
    function cleanup() {
      stdin.removeListener('data', onData);
      stdin.setRawMode?.(wasRaw);
      stdin.pause();
    }
    stdin.on('data', onData);
  });
}

async function loginSession(server, email, password) {
  const base = normalizeServer(server);
  const res = await fetch(`${base}/login`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin: base,
    },
    body: JSON.stringify({ email, password }),
  });
  if (res.status === 403) throw new Error('This account is disabled.');
  if (!res.ok) throw new Error('Login failed. Check your Duet email and password.');
  const header = res.headers.get('set-cookie') || '';
  const match = /duet_session=([^;]+)/.exec(header);
  if (!match) throw new Error('Login succeeded but no session cookie was returned.');
  return decodeURIComponent(match[1]);
}

function sessionHeaders(server, session) {
  const base = normalizeServer(server);
  return { origin: base, cookie: `duet_session=${session}` };
}

async function sessionValid(server, session) {
  if (!session) return false;
  try {
    const res = await fetch(`${normalizeServer(server)}/api/me`, {
      headers: sessionHeaders(server, session),
    });
    return res.ok;
  } catch {
    return false;
  }
}

async function ensureSession({ server, email, password, session, store }) {
  const base = normalizeServer(server);
  if (session && (await sessionValid(base, session))) {
    return { session, email, refreshed: false };
  }

  let pass = password || '';
  if (!pass && email && store) pass = await store.getPassword(email);
  if (!email || !pass) {
    const err = new Error('Login required. Run npm run capsule in Terminal and enter your Duet email and password once.');
    err.code = 'LOGIN_REQUIRED';
    throw err;
  }

  const next = await loginSession(base, email, pass);
  if (store) {
    store.saveConfig({ server: base, email, session: next });
    await store.setPassword(email, pass);
  }
  return { session: next, email, refreshed: true };
}

function sortMine(rooms) {
  return [...(rooms || [])].sort((a, b) => {
    const members = Number(b.members || 0) - Number(a.members || 0);
    if (members) return members;
    return Number(b.createdAt || 0) - Number(a.createdAt || 0);
  });
}

function pickRokuHost(found, { savedHost, explicit } = {}) {
  const list = Array.isArray(found) ? found : [];
  if (explicit) {
    return list.find((d) => d.host === explicit) || { host: explicit, name: explicit };
  }
  if (savedHost) {
    const hit = list.find((d) => d.host === savedHost);
    if (hit) return hit;
  }
  if (list.length === 1) return list[0];
  return null;
}

function pickRoom({ mine = [], explicit } = {}) {
  const code = normalizeRoomInput(explicit);
  if (code) return { code, source: 'explicit' };
  const top = sortMine(mine)[0];
  if (top && top.code) return { code: normalizeRoomInput(top.code), source: 'created' };
  return null;
}

async function fetchMineRooms(server, session) {
  const base = normalizeServer(server);
  const res = await fetch(`${base}/api/rooms/mine`, { headers: sessionHeaders(base, session) });
  if (res.status === 401 || res.status === 403) return null;
  if (!res.ok) return [];
  const body = await res.json().catch(() => ({}));
  return Array.isArray(body.rooms) ? body.rooms : [];
}

async function resolveCapsuleLaunch(args, store, io = {}) {
  return resolveDeviceLaunch(args, store, { ...io, kind: io.kind || 'nebula' });
}

async function resolveDeviceLaunch(args, store, io = {}) {
  const kind = io.kind || args.device || 'nebula';
  const prompt = io.canPrompt || canPrompt;
  const ask = io.askLine || askLine;
  const askPw = io.askPassword || askPassword;
  const listDevices = io.listDevices;
  const discover = io.discoverRoku;
  const log = io.log || console.log;
  const checkSession = io.sessionValid || sessionValid;
  const loadMine = io.fetchMineRooms || fetchMineRooms;

  const config = store.loadConfig();
  const server = normalizeServer(
    args.server || process.env.DUET_SERVER || config.server || DEFAULT_SERVER
  );

  let email = args.email || process.env.DUET_EMAIL || config.email || '';
  let password = args.password || process.env.DUET_PASSWORD || '';
  let session = args.login ? '' : args.session || process.env.DUET_SESSION || config.session || '';

  if (!(await checkSession(server, session))) {
    if (!email && prompt()) email = await ask('Duet email', email);
    if (!password && email) password = await store.getPassword(email);
    if (!password && prompt()) password = await askPw('Duet password');
    const ensured = await ensureSession({ server, email, password, session: '', store });
    session = ensured.session;
    email = ensured.email || email;
    log(
      `Saved login for ${email} (${store.passwordBackend() === 'keychain' ? 'macOS Keychain' : '~/.duet'}).`
    );
  } else {
    store.saveConfig({ server, email, session });
  }

  if (args.login && !args.device && !args.room && !args.capsule) {
    return { onlyLogin: true, server, email, session };
  }

  let room = normalizeRoomInput(args.room);
  let roomSource = room ? 'explicit' : '';
  if (!room) {
    const mine = (await loadMine(server, session)) || [];
    const picked = pickRoom({ mine });
    if (picked) {
      room = picked.code;
      roomSource = 'created';
      log(`Joining your room ${room}.`);
    } else if (prompt()) {
      room = normalizeRoomInput(await ask('Room code to join'));
      roomSource = 'prompt';
    }
  }
  if (!room) {
    throw new Error(
      'No room of yours is open. Create one on your phone at duet.arnabbanik.com, or pass --room CODE.'
    );
  }

  let serial = args.serial || '';
  let host = args.host || '';
  const port = args.port || config.port || '';
  let label =
    args.name || (kind === 'roku' ? 'Roku' : kind === 'firetv' ? 'Fire TV' : kind === 'androidtv' ? 'Android TV' : 'Capsule');

  if (kind === 'roku') {
    if (!host) {
      const found = discover ? await discover({ timeoutMs: 5000 }) : [];
      let picked = pickRokuHost(found, {
        savedHost: config.rokuHost || config.host,
        explicit: '',
      });
      if (!picked && found.length > 1 && prompt()) {
        log('Rokus on this Wi-Fi:');
        found.forEach((d, i) => log(`  ${i + 1}. ${d.name}  ${d.host}`));
        const answer = await ask('Which Roku? (number or IP)');
        const index = Number(answer) - 1;
        if (Number.isInteger(index) && found[index]) picked = found[index];
        else if (answer) picked = pickRokuHost(found, { explicit: answer.trim() });
      }
      if (!picked && found.length === 0 && (config.rokuHost || config.host)) {
        picked = { host: config.rokuHost || config.host, name: 'Roku' };
        log(`No SSDP reply — trying saved Roku ${picked.host}.`);
      }
      if (!picked) {
        throw new Error(
          'No Roku on this Wi-Fi. Same network as the TV, then Settings → System → Advanced → Control by mobile apps → On.'
        );
      }
      host = picked.host;
      label = args.name || picked.name || 'Roku';
      log(`Using Roku ${picked.name || picked.host} (${picked.host}).`);
    }
  } else {
    const connectAdb = io.adbConnect;
    const { waitForAdbAuthorized, matchAdbSerial, adbAuthHint } = require('./drivers/androidtv');
    const waitAuth = io.waitForAdbAuthorized || waitForAdbAuthorized;
    const savedAdbHost = kind === 'firetv' ? config.firetvHost : kind === 'androidtv' ? config.androidtvHost : config.host;
    async function devicesOrThrow() {
      try {
        return await listDevices(args.adb || 'adb');
      } catch (err) {
        if (err && err.code === 'ENOENT') {
          throw new Error('ADB is missing. brew install android-platform-tools');
        }
        throw err;
      }
    }

    async function authorizeIfNeeded(serialHint, hostHint) {
      const target = serialHint || (hostHint ? `${String(hostHint).split(':')[0]}:${port || 5555}` : '');
      if (!target || !listDevices) return serialHint || target;
      const devices = await devicesOrThrow();
      const hit = matchAdbSerial(devices, target);
      if (hit?.status === 'device') return hit.serial;
      if (hit?.status === 'unauthorized' || hit?.status === 'offline' || hit?.status === 'connecting') {
        log(
          kind === 'firetv'
            ? 'Look at the Fire TV: Allow USB debugging? Check Always allow from this computer, then OK.'
            : 'Look at the TV: Allow USB debugging? Check Always allow from this computer, then OK.'
        );
        return waitAuth(hit.serial || target, {
          listDevices: devicesOrThrow,
          reconnect: connectAdb
            ? () =>
                connectAdb(
                  hostHint || String(target).split(':')[0],
                  Number(port || 5555),
                  args.adb || 'adb'
                )
            : undefined,
          log,
          hint: adbAuthHint(kind),
        });
      }
      return hit?.serial || serialHint || target;
    }

    if (!serial && !host && config.serial && listDevices) {
      const devices = await devicesOrThrow();
      if (devices.some((d) => d.serial === config.serial && d.status === 'device')) {
        serial = config.serial;
      }
    }
    if (!serial && !host && (args.host || savedAdbHost) && connectAdb) {
      const target = args.host || savedAdbHost;
      try {
        serial = await connectAdb(target, Number(port || 5555), args.adb || 'adb');
        log(`ADB connect ${serial}.`);
      } catch {
        /* fall through to listing / prompt */
      }
    }
    if (!serial && !host && listDevices) {
      let devices = await devicesOrThrow();
      const { pickAdbSerial } = require('./drivers/androidtv');
      serial = pickAdbSerial(devices, { prefer: kind }) || '';
      if (!serial) {
        const pending = devices.find((d) => d.status === 'unauthorized' || d.status === 'connecting');
        if (pending) {
          serial = await authorizeIfNeeded(pending.serial, String(pending.serial).split(':')[0]);
        }
      }
      if (!serial && (kind === 'firetv' || kind === 'androidtv') && prompt()) {
        const ip = await ask(
          kind === 'firetv'
            ? 'Fire TV IP (Settings → My Fire TV → About / Network)'
            : 'Android TV IP (Wireless debugging)'
        );
        if (ip && connectAdb) {
          try {
            serial = await connectAdb(ip, Number(port || 5555), args.adb || 'adb');
            host = ip;
            devices = await devicesOrThrow();
            serial = pickAdbSerial(devices, { prefer: kind }) || serial;
          } catch {
            host = ip;
          }
        } else if (ip) {
          host = ip;
        }
      }
    }
    if (!serial && !host && savedAdbHost) host = savedAdbHost;
    if (serial || host) {
      serial = await authorizeIfNeeded(serial, host || String(serial).split(':')[0]);
    }
    if (!serial && !host) {
      const hint =
        kind === 'firetv'
          ? 'No Fire TV on ADB. Toshiba / Fire TV: Settings → My Fire TV → Developer options → ADB debugging + ADB over network, then npm run firetv again (or pass --host IP).'
          : kind === 'androidtv'
            ? 'No Android TV on ADB. Turn on Wireless debugging, then run adb devices until you see “device”.'
            : 'No Capsule on ADB. Turn on Wireless debugging, then run adb devices until you see “device”.';
      throw new Error(hint);
    }
  }

  store.saveConfig({
    server,
    email,
    session,
    serial: serial || undefined,
    host: host || undefined,
    port: port || undefined,
    rokuHost: kind === 'roku' ? host : config.rokuHost,
    firetvHost: kind === 'firetv' ? host || config.firetvHost : config.firetvHost,
    androidtvHost: kind === 'androidtv' ? host || config.androidtvHost : config.androidtvHost,
    device: kind,
  });

  return {
    onlyLogin: false,
    device: kind,
    server,
    email,
    session,
    room,
    roomSource,
    serial,
    host,
    port,
    name: label,
    adb: args.adb || 'adb',
  };
}

module.exports = {
  DEFAULT_SERVER,
  normalizeServer,
  normalizeRoomInput,
  canPrompt,
  askLine,
  askPassword,
  loginSession,
  sessionHeaders,
  sessionValid,
  ensureSession,
  sortMine,
  pickRoom,
  pickRokuHost,
  fetchMineRooms,
  resolveCapsuleLaunch,
  resolveDeviceLaunch,
};
