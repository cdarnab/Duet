const $ = (id) => document.getElementById(id);
let fieldsLoaded = false;

function sanitizeRoom(value) {
  return String(value || '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .slice(0, 6);
}

function joinUrl(server, room) {
  return `${String(server || DUET_DEFAULT_SERVER).replace(/\/+$/, '')}/r/${room}`;
}

function sharePayload(server, room, hostName) {
  const url = joinUrl(server, room);
  const who = hostName ? ` ${hostName}'s` : '';
  return {
    url,
    subject: 'Watch together on Duet',
    text: `Watch together on Duet.${who ? ` Join${who} room.` : ''}\nRoom ${room}\n\n${url}`,
  };
}

function updateShareLinks(server, room, hostName) {
  const share = sharePayload(server, room, hostName);
  $('share-messages').href = `sms:?&body=${encodeURIComponent(share.text)}`;
  $('share-email').href = `mailto:?subject=${encodeURIComponent(share.subject)}&body=${encodeURIComponent(share.text)}`;
  const sheet = $('share-sheet');
  if (navigator.share) {
    sheet.hidden = false;
    sheet.onclick = () => navigator.share({ title: share.subject, text: share.text, url: share.url }).catch(() => {});
  } else {
    sheet.hidden = true;
  }
}

function showInRoom(on) {
  $('idle').hidden = on;
  $('in-room').hidden = !on;
}

function refresh() {
  chrome.runtime.sendMessage({ type: 'getStatus' }, (res) => {
    if (!res) return;

    const roomEl = $('room');
    const roomFocused = document.activeElement === roomEl;
    const room = sanitizeRoom((!roomFocused && res.config.room) || roomEl.value || res.config.room || '');
    const inRoom = Boolean(res.config.room);

    if (!fieldsLoaded) {
      roomEl.value = sanitizeRoom(res.config.room || '');
      fieldsLoaded = true;
    } else if (!roomFocused && res.config.room) {
      roomEl.value = sanitizeRoom(res.config.room);
    }

    showInRoom(inRoom);
    if (inRoom) {
      const code = sanitizeRoom(res.config.room);
      const creatorName = res.creator?.name || res.members?.find((m) => m.host)?.name || '';
      const selfIsHost = Boolean(res.members?.find((m) => m.id === res.selfId && m.host));
      const guests = (res.members || []).filter((m) => m.id !== res.selfId);
      $('room-display').textContent = code;
      $('host-line').textContent = creatorName
        ? (selfIsHost ? "You're the host" : `Hosted by ${creatorName}`)
        : '';
      $('people-line').textContent = !res.connected
        ? 'Connecting…'
        : guests.length
          ? `With ${guests.map((m) => m.name || 'Guest').join(', ')}`
          : 'Waiting for someone to join';
      updateShareLinks(res.config.server, code, creatorName);
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

    const base = (res.config.server || DUET_DEFAULT_SERVER).replace(/\/+$/, '');
    $('console-link').href = room || res.config.room ? `${base}/companion.html#${room || res.config.room}` : base || '#';
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
  const config = {
    server: DUET_DEFAULT_SERVER,
    room: sanitizeRoom($('room').value),
  };
  if (!config.room) { $('room').focus(); return; }
  chrome.runtime.sendMessage({ type: 'setConfig', config }, () => setTimeout(refresh, 400));
});

$('create').addEventListener('click', () => {
  $('status-text').textContent = 'Creating room…';
  chrome.runtime.sendMessage({ type: 'createRoom' }, (res) => {
    if (res?.authRequired) {
      const loginWrap = $('login-wrap');
      if (loginWrap) loginWrap.style.display = 'block';
      $('status-text').textContent = 'Log in on the Duet site first';
      return;
    }
    if (!res?.ok || !res.code) {
      $('status-text').textContent = 'Could not create a room';
      return;
    }
    $('room').value = sanitizeRoom(res.code);
    showInRoom(true);
    $('room-display').textContent = sanitizeRoom(res.code);
    $('host-line').textContent = "You're the host";
    $('people-line').textContent = 'Joining…';
    updateShareLinks(res.config?.server || DUET_DEFAULT_SERVER, sanitizeRoom(res.code), '');
    setTimeout(refresh, 400);
  });
});

$('share-copy').addEventListener('click', async () => {
  const code = sanitizeRoom($('room-display').textContent);
  const status = $('status-text');
  try {
    const res = await new Promise((resolve) => chrome.runtime.sendMessage({ type: 'getStatus' }, resolve));
    const url = joinUrl(res?.config?.server, code);
    await navigator.clipboard.writeText(url);
    status.textContent = 'Link copied';
  } catch {
    try {
      await navigator.clipboard.writeText(code);
      status.textContent = 'Code copied';
    } catch {
      status.textContent = 'Copy failed';
    }
  }
});

$('leave').addEventListener('click', () => chrome.runtime.sendMessage({ type: 'leave' }, () => {
  showInRoom(false);
  $('room').value = '';
  setTimeout(refresh, 200);
}));
$('cue').addEventListener('click', () => chrome.runtime.sendMessage({ type: 'cue' }));
$('resync').addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'resync' }, (res) => {
    $('status-text').textContent = res?.connected ? 'Resync sent' : 'Join a room first';
  });
});

refresh();
setInterval(refresh, 1000);
