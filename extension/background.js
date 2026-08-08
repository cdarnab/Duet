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

function socketUrl() {
  const base = config.server.replace(/\/+$/, '');
  return base.replace(/^http/, 'ws') + '/ws';
}

async function sessionToken() {
  try {
    const cookie = await chrome.cookies.get({ url: config.server, name: 'duet_session' });
    return cookie?.value || '';
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
  if (socket) {
    try { socket.close(); } catch {}
  }
  if (!config.room) return;

  socket = new WebSocket(socketUrl());

  socket.onopen = async () => {
    const session = await sessionToken();
    send({ type: 'hello', room: config.room, name: config.name, surface: 'browser', session });
    beat();
  };

  socket.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.type === 'error' && msg.error === 'auth_required') {
      authRequired = true;
      connected = false;
      fanout({ type: 'status', connected: false, room: config.room, authRequired: true });
      try { socket.close(); } catch {}
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
      fanout({ type: 'status', connected: true, room: config.room });
    }
    if (msg.type === 'state') roomState = msg.state;
    fanout({ ...msg, selfId, offset: clock.offset });
  };

  socket.onclose = () => {
    connected = false;
    fanout({ type: 'status', connected: false, room: config.room });
    if (config.room) setTimeout(connect, 2000);
  };

  socket.onerror = () => {
    try { socket.close(); } catch {}
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

/* ------------------------------------------------------------------ popup */

chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  if (msg.type === 'getStatus') {
    reply({ connected, config, selfId, state: roomState, offset: clock.offset, rtt: clock.rtt, authRequired });
    return true;
  }
  if (msg.type === 'setConfig') {
    config = { ...config, ...msg.config };
    chrome.storage.local.set({ duetConfig: config });
    connect();
    reply({ ok: true, config });
    return true;
  }
  if (msg.type === 'leave') {
    config.room = '';
    chrome.storage.local.set({ duetConfig: config });
    try { socket?.close(); } catch {}
    socket = null;
    connected = false;
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
    send({ type: 'resync' });
    const payload = { type: 'state', state: roomState, resync: true, offset: clock.offset, selfId };
    fanout(payload);
    pingTabs({ type: 'resync', state: roomState });
    reply({ ok: true, connected });
    return true;
  }
  return false;
});
