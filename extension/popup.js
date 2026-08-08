const $ = (id) => document.getElementById(id);
let fieldsLoaded = false;

function sanitizeRoom(value) {
  return String(value || '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .slice(0, 6);
}

function refresh() {
  chrome.runtime.sendMessage({ type: 'getStatus' }, (res) => {
    if (!res) return;

    const roomEl = $('room');
    const roomFocused = document.activeElement === roomEl;

    if (!fieldsLoaded) {
      roomEl.value = sanitizeRoom(res.config.room || '');
      if ($('server')) $('server').value = res.config.server || DUET_DEFAULT_SERVER;
      fieldsLoaded = true;
    } else if (!roomFocused && res.connected && res.config.room) {
      roomEl.value = sanitizeRoom(res.config.room);
    }

    $('dot').classList.toggle('on', res.connected);
    const loginWrap = $('login-wrap');
    if (loginWrap) loginWrap.style.display = res.authRequired ? 'block' : 'none';
    $('status-text').textContent = res.authRequired
      ? 'Log in on the Duet site first'
      : res.connected
        ? `In room ${res.config.room}`
        : res.config.room ? 'Reconnecting…' : 'Not connected';

    const rtt = Math.round(res.rtt || 0);
    const offset = Math.round(res.offset || 0);
    $('readout').innerHTML = res.connected
      ? `round trip <b>${rtt}ms</b> · clock offset <b>${offset >= 0 ? '+' : ''}${offset}ms</b>`
      : '';

    const base = (($('server') && $('server').value) || res.config.server || DUET_DEFAULT_SERVER).replace(/\/+$/, '');
    const room = roomEl.value || res.config.room || '';
    $('console-link').href = room ? `${base}/companion.html#${room}` : base || '#';
  });
}

$('room').addEventListener('input', () => {
  $('room').value = sanitizeRoom($('room').value);
});

$('room').addEventListener('paste', (event) => {
  event.preventDefault();
  const text = (event.clipboardData || window.clipboardData).getData('text');
  $('room').value = sanitizeRoom(text);
});

$('join').addEventListener('click', () => {
  const serverEl = $('server');
  const config = {
    server: (serverEl ? serverEl.value.trim() : '') || DUET_DEFAULT_SERVER,
    room: sanitizeRoom($('room').value),
  };
  if (!config.room) { $('room').focus(); return; }
  chrome.runtime.sendMessage({ type: 'setConfig', config }, () => setTimeout(refresh, 400));
});

$('leave').addEventListener('click', () => chrome.runtime.sendMessage({ type: 'leave' }, () => setTimeout(refresh, 200)));
$('cue').addEventListener('click', () => chrome.runtime.sendMessage({ type: 'cue' }));
$('resync').addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'resync' }, (res) => {
    $('status-text').textContent = res?.connected ? 'Resync sent' : 'Join a room first';
  });
});

refresh();
setInterval(refresh, 1000);
