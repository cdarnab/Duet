/* Duet background service worker.
 *
 * One socket per browser, not per tab. The connection lives here so it
 * survives navigation inside Netflix's single-page app and so every frame
 * shares one clock offset.
 */
importScripts('sync.js', 'defaults.js');

const clock = new DuetSync.ClockSync();

let socket = null;
let config = { server: DUET_DEFAULT_SERVER, room: '', name: 'Me' };
let selfId = null;
let roomState = { paused: true, position: 0, rate: 1, atServerTime: Date.now(), seq: 0 };
let connected = false;
const ports = new Set();

function isLocalServer(url) {
  return !url || /localhost|127\.0\.0\.1/.test(url);
}

chrome.storage.local.get(['duetConfig']).then((res) => {
  if (res.duetConfig) config = { ...config, ...res.duetConfig };
  if (isLocalServer(config.server)) {
    config.server = DUET_DEFAULT_SERVER;
    chrome.storage.local.set({ duetConfig: config });
  }
  if (config.room) connect();
});

let authRequired = false;
let connectGen = 0;
let reconnectTimer = 0;
let roomCreator = null;
let members = [];

function socketUrl() {
  const base = config.server.replace(/\/+$/, '');
  return base.replace(/^http/, 'ws') + '/ws';
}

async function sessionToken() {
  try {
    const url = config.server.replace(/\/+$/, '') + '/';
    const cookie = await chrome.cookies.get({ url, name: 'duet_session' });
    if (cookie?.value) return cookie.value;
    const all = await chrome.cookies.getAll({ domain: new URL(url).hostname, name: 'duet_session' });
    return all?.[0]?.value || '';
  } catch {
    return '';
  }
}

function fanout(msg) {
  for (const port of ports) {
    try {
      port.postMessage(msg);
    } catch {
      ports.delete(port);
    }
  }
}

function pingTabs(msg) {
  chrome.tabs.query({ url: ['http://*/*', 'https://*/*'] }, (tabs) => {
    for (const tab of tabs || []) {
      chrome.tabs.sendMessage(tab.id, msg, () => void chrome.runtime.lastError);
    }
  });
}

function connect() {
  const gen = ++connectGen;
  clearTimeout(reconnectTimer);
  if (socket) {
    const previous = socket;
    socket = null;
    try { previous.close(); } catch {}
  }
  if (!config.room || authRequired) return;

  const next = new WebSocket(socketUrl());
  socket = next;

  next.onopen = async () => {
    if (gen !== connectGen || socket !== next) return;
    const session = await sessionToken();
    if (gen !== connectGen || socket !== next) return;
    send({ type: 'hello', room: config.room, name: config.name, surface: 'browser', session });
    beat();
  };

  next.onmessage = (ev) => {
    if (gen !== connectGen || socket !== next) return;
    const msg = JSON.parse(ev.data);
    if (msg.type === 'error' && msg.error === 'auth_required') {
      authRequired = true;
      connected = false;
      fanout({ type: 'status', connected: false, room: config.room, authRequired: true });
      try { next.close(); } catch {}
      return;
    }
    if (msg.type === 'pong') {
      clock.addSample(msg.t0, msg.t1, Date.now());
      fanout({ type: 'clock', offset: clock.offset, rtt: clock.rtt, ready: clock.ready });
      return;
    }
    if (msg.type === 'welcome') {
      authRequired = false;
      connected = true;
      selfId = msg.selfId;
      roomState = msg.state;
      roomCreator = msg.creator || null;
      members = msg.members || [];
      fanout({ type: 'status', connected: true, room: config.room, creator: roomCreator, members });
    }
    if (msg.type === 'joined') {
      if (msg.creator) roomCreator = msg.creator;
      members = [...members.filter((m) => m.id !== msg.member?.id), msg.member].filter(Boolean);
    }
    if (msg.type === 'left') {
      members = members.filter((m) => m.id !== msg.id);
    }
    if (msg.type === 'state') roomState = msg.state;
    fanout({ ...msg, selfId, offset: clock.offset, creator: roomCreator, members });
  };

  next.onclose = () => {
    if (gen !== connectGen || socket !== next) return;
    socket = null;
    connected = false;
    fanout({ type: 'status', connected: false, room: config.room, authRequired });
    if (!config.room || authRequired) return;
    reconnectTimer = setTimeout(connect, 2000);
  };

  next.onerror = () => {
    if (gen !== connectGen || socket !== next) return;
    try { next.close(); } catch {}
  };
}

function send(msg) {
  if (socket && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(msg));
}

/* Clock samples double as a keepalive: socket traffic resets the service
   worker's idle timer, so the connection is not torn down mid-movie. */
let beats = 0;
function beat() {
  send({ type: 'ping', t0: Date.now() });
  beats++;
}
setInterval(() => {
  if (!connected) return;
  // Converge fast for the first few seconds, then trickle.
  if (beats < 8 || beats % 10 === 0) beat();
  else beats++;
}, 1000);

/* ----------------------------------------------------- content-script link */

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'duet') return;
  ports.add(port);
  port.postMessage({ type: 'status', connected, room: config.room, selfId });
  port.postMessage({ type: 'clock', offset: clock.offset, rtt: clock.rtt, ready: clock.ready });
  if (roomState) port.postMessage({ type: 'state', state: roomState, offset: clock.offset });

  port.onMessage.addListener((msg) => {
    if (msg.type === 'state' || msg.type === 'tick' || msg.type === 'resync' || msg.type === 'cue') {
      send(msg);
    }
  });
  port.onDisconnect.addListener(() => ports.delete(port));
});

chrome.runtime.onMessageExternal.addListener((msg, _sender, reply) => {
  if (msg && msg.type === 'duetPing') {
    reply({ ok: true, version: chrome.runtime.getManifest().version, name: chrome.runtime.getManifest().name });
    return true;
  }
  return false;
});

/* ------------------------------------------------------------------ popup */

chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  if (msg.type === 'getStatus') {
    reply({ connected, config, selfId, state: roomState, offset: clock.offset, rtt: clock.rtt, authRequired, creator: roomCreator, members });
    return true;
  }
  if (msg.type === 'setConfig') {
    config = { ...config, ...msg.config };
    chrome.storage.local.set({ duetConfig: config });
    authRequired = false;
    connect();
    reply({ ok: true, config });
    return true;
  }
  if (msg.type === 'createRoom') {
    (async () => {
      try {
        const session = await sessionToken();
        const headers = {};
        if (session) headers.cookie = `duet_session=${session}`;
        const res = await fetch(`${config.server.replace(/\/+$/, '')}/api/room/new`, { headers });
        if (res.status === 401 || res.status === 403) {
          authRequired = true;
          fanout({ type: 'status', connected: false, room: config.room, authRequired: true });
          reply({ ok: false, authRequired: true });
          return;
        }
        if (!res.ok) {
          reply({ ok: false });
          return;
        }
        const body = await res.json();
        const code = String(body.code || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
        if (code.length < 4) {
          reply({ ok: false });
          return;
        }
        config.room = code;
        chrome.storage.local.set({ duetConfig: config });
        authRequired = false;
        roomCreator = body.creator || null;
        members = [];
        connect();
        reply({ ok: true, config, code, creator: roomCreator, joinUrl: body.joinUrl || `/r/${code}` });
      } catch {
        reply({ ok: false });
      }
    })();
    return true;
  }
  if (msg.type === 'leave') {
    config.room = '';
    chrome.storage.local.set({ duetConfig: config });
    connectGen += 1;
    clearTimeout(reconnectTimer);
    try { socket?.close(); } catch {}
    socket = null;
    connected = false;
    authRequired = false;
    roomCreator = null;
    members = [];
    fanout({ type: 'status', connected: false, room: '' });
    reply({ ok: true });
    return true;
  }
  if (msg.type === 'cue') {
    send({ type: 'cue', inMs: 3200 });
    reply({ ok: true });
    return true;
  }
  if (msg.type === 'resync') {
    const at =
      typeof DuetSync !== 'undefined' && DuetSync.projected
        ? DuetSync.projected(roomState, Date.now() + (clock.offset || 0))
        : Number(roomState.position) || 0;
    roomState = { ...roomState, paused: true, position: at, rate: 1 };
    // Pause everyone, then count in. A seek-only resync is a no-op on Nebula.
    send({ type: 'state', paused: true, position: at, rate: 1 });
    send({ type: 'cue', inMs: 3200 });
    const payload = { type: 'state', state: roomState, resync: true, offset: clock.offset, selfId };
    fanout(payload);
    pingTabs({ type: 'resync', state: roomState });
    reply({ ok: true, connected });
    return true;
  }
  return false;
});
