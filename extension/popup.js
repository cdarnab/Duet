const $ = (id) => document.getElementById(id);
let fieldsLoaded = false;

function refresh() {
  chrome.runtime.sendMessage({ type: 'getStatus' }, (res) => {
    if (!res) return;

    const serverFocused = document.activeElement === $('server');
    const roomFocused = document.activeElement === $('room');
    if (!fieldsLoaded || (!serverFocused && !roomFocused)) {
      if (!serverFocused) $('server').value = res.config.server || DUET_DEFAULT_SERVER;
      if (!roomFocused) $('room').value = res.config.room || '';
      fieldsLoaded = true;
    }

    $('dot').classList.toggle('on', res.connected);
    $('status-text').textContent = res.connected
      ? `In room ${res.config.room}`
      : res.config.room ? 'Reconnecting…' : 'Not connected';

    const rtt = Math.round(res.rtt || 0);
    const offset = Math.round(res.offset || 0);
    $('readout').innerHTML = res.connected
      ? `round trip <b>${rtt}ms</b> · clock offset <b>${offset >= 0 ? '+' : ''}${offset}ms</b>`
      : '';

    const base = ($('server').value || res.config.server || '').replace(/\/+$/, '');
    const room = $('room').value || res.config.room || '';
    $('console-link').href = room ? `${base}/companion.html#${room}` : base || '#';
  });
}

$('room').addEventListener('input', () => {
  $('room').value = $('room').value.toUpperCase().replace(/[^A-Z0-9]/g, '');
});

$('join').addEventListener('click', () => {
  const config = { server: $('server').value.trim() || DUET_DEFAULT_SERVER, room: $('room').value.trim() };
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
