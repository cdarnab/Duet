'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const { RoomStore, Member, validRoomCode, normalizeRoomCode } = require('./rooms');
const auth = require('./auth');
const DuetSync = require('../shared/sync');

const PORT = Number(process.env.PORT || 8080);
const HOST = process.env.HOST || '0.0.0.0';
const ROOT = path.join(__dirname, '..');

const store = new RoomStore();

/* ------------------------------------------------------------------ static */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
  '.zip': 'application/zip',
};

const STATIC_DIRS = { '/': path.join(ROOT, 'web'), '/shared/': path.join(ROOT, 'shared') };

function resolveStatic(urlPath) {
  let rel = decodeURIComponent(urlPath.split('?')[0]);
  if (rel === '/') rel = '/index.html';
  const base = rel.startsWith('/shared/') ? STATIC_DIRS['/shared/'] : STATIC_DIRS['/'];
  const trimmed = rel.startsWith('/shared/') ? rel.slice('/shared/'.length) : rel.slice(1);
  const full = path.join(base, trimmed);
  // Block traversal outside the served directories.
  if (!full.startsWith(base)) return null;
  return full;
}

function securityHeaders(extra = {}) {
  return {
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    'referrer-policy': 'same-origin',
    'permissions-policy': 'camera=(), microphone=(self), geolocation=()',
    'content-security-policy':
      "default-src 'self'; img-src 'self' data:; media-src 'self' blob: https:; connect-src 'self' ws: wss:; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; script-src 'self' 'unsafe-inline'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
    ...extra,
  };
}

function sanitizeText(value, max) {
  return String(value || '')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
    .slice(0, max);
}

function isPublicAsset(pathname) {
  return (
    pathname === '/' ||
    pathname === '/index.html' ||
    pathname === '/app.css' ||
    pathname === '/i18n.js' ||
    pathname === '/home.js' ||
    pathname === '/extension-status.js' ||
    pathname === '/favicon.ico' ||
    pathname === '/favicon-16.png' ||
    pathname === '/favicon-32.png' ||
    pathname === '/apple-touch-icon.png' ||
    pathname === '/version.json' ||
    pathname === '/duet-extension.zip' ||
    pathname === '/install-duet.sh' ||
    pathname === '/install-duet.command' ||
    pathname === '/api/session' ||
    pathname === '/api/extension/files' ||
    pathname.startsWith('/assets/') ||
    pathname.startsWith('/extension-dist/')
  );
}

const EXT_ROOT = path.join(ROOT, 'extension');

function listExtensionFiles(dir, rel = '') {
  const out = [];
  for (const name of fs.readdirSync(dir)) {
    if (name.startsWith('.')) continue;
    const full = path.join(dir, name);
    const relPath = rel ? `${rel}/${name}` : name;
    if (fs.statSync(full).isDirectory()) out.push(...listExtensionFiles(full, relPath));
    else out.push(relPath);
  }
  return out.sort();
}

async function handleRequest(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  if (url.pathname === '/health') {
    res.writeHead(200, securityHeaders({ 'content-type': 'application/json' }));
    return res.end(JSON.stringify({ ok: true, rooms: store.rooms.size, uptime: process.uptime() }));
  }

  if (url.pathname === '/api/extension/files') {
    const manifest = JSON.parse(fs.readFileSync(path.join(EXT_ROOT, 'manifest.json'), 'utf8'));
    res.writeHead(200, securityHeaders({ 'content-type': 'application/json; charset=utf-8' }));
    return res.end(JSON.stringify({ version: manifest.version, files: listExtensionFiles(EXT_ROOT) }));
  }

  if (url.pathname.startsWith('/extension-dist/')) {
    const rel = decodeURIComponent(url.pathname.slice('/extension-dist/'.length)).replace(/^\/+/, '');
    if (!rel || rel.includes('..') || path.isAbsolute(rel)) {
      res.writeHead(403, securityHeaders({ 'content-type': 'text/plain; charset=utf-8' }));
      return res.end('Forbidden');
    }
    const full = path.join(EXT_ROOT, rel);
    if (!full.startsWith(EXT_ROOT + path.sep)) {
      res.writeHead(403, securityHeaders({ 'content-type': 'text/plain; charset=utf-8' }));
      return res.end('Forbidden');
    }
    if (!fs.existsSync(full) || fs.statSync(full).isDirectory()) {
      res.writeHead(404, securityHeaders({ 'content-type': 'text/plain; charset=utf-8' }));
      return res.end('Not found');
    }
    const headers = securityHeaders({ 'content-type': MIME[path.extname(full)] || 'application/octet-stream' });
    res.writeHead(200, headers);
    return res.end(fs.readFileSync(full));
  }

  if (url.pathname === '/install-duet.sh' || url.pathname === '/install-duet.command') {
    const host = String(req.headers.host || 'duet.arnabbanik.com').split(',')[0].trim();
    const proto = String(req.headers['x-forwarded-proto'] || 'https').split(',')[0].trim();
    const base = `${proto}://${host}`;
    const script = `#!/bin/bash
set -euo pipefail
DEST="\${HOME}/Library/Application Support/Duet/extension"
mkdir -p "\$DEST"
TMP="\$(mktemp -t duet-ext)"
echo "Installing Duet to \$DEST"
curl -fsSL "${base}/duet-extension.zip" -o "\$TMP.zip"
unzip -o "\$TMP.zip" -d "\$DEST"
rm -f "\$TMP.zip"
echo
echo "Installed. In Chrome:"
echo "  1. Open chrome://extensions"
echo "  2. Turn on Developer mode"
echo "  3. Load unpacked → \$DEST"
echo "If Duet was already loaded from that folder, click Reload."
open "\$DEST" >/dev/null 2>&1 || true
`;
    res.writeHead(200, securityHeaders({
      'content-type': 'text/x-shellscript; charset=utf-8',
      'content-disposition': url.pathname.endsWith('.command')
        ? 'attachment; filename="Install Duet Extension.command"'
        : 'inline; filename="install-duet.sh"',
    }));
    return res.end(script);
  }

  if (await auth.handleHttp(req, res, url, { securityHeaders })) return;

  if (url.pathname === '/api/session' && (req.method === 'GET' || req.method === 'HEAD')) {
    const session = auth.sessionFromRequest(req);
    const user = session
      ? {
          email: session.user.email,
          name: auth.displayName(session.user),
          owner: session.user.email === auth.ownerEmail(),
        }
      : null;
    res.writeHead(200, securityHeaders({ 'content-type': 'application/json; charset=utf-8' }));
    return res.end(JSON.stringify({ authEnabled: auth.enabled(), authenticated: Boolean(session), user }));
  }

  if (auth.enabled() && !auth.sessionFromRequest(req) && !isPublicAsset(url.pathname)) {
    if (url.pathname.startsWith('/api/')) {
      res.writeHead(401, securityHeaders({ 'content-type': 'application/json; charset=utf-8' }));
      return res.end(JSON.stringify({ error: 'auth_required' }));
    }
    const next = `${url.pathname}${url.search}`;
    const safe = next.startsWith('/') && !next.startsWith('//') && !next.startsWith('/login');
    res.writeHead(302, securityHeaders({
      location: safe ? `/login?next=${encodeURIComponent(next)}` : '/login',
    }));
    return res.end();
  }

  if (url.pathname === '/api/rooms/mine' && (req.method === 'GET' || req.method === 'HEAD')) {
    const session = auth.sessionFromRequest(req);
    if (auth.enabled() && !session) {
      res.writeHead(401, securityHeaders({ 'content-type': 'application/json; charset=utf-8' }));
      return res.end(JSON.stringify({ error: 'auth_required' }));
    }
    const rooms = session ? store.listByCreator(session.user) : [];
    res.writeHead(200, securityHeaders({ 'content-type': 'application/json; charset=utf-8' }));
    return res.end(
      JSON.stringify({
        rooms: rooms.map((room) => ({
          code: room.code,
          createdAt: room.createdAt,
          members: room.size,
          creator: room.publicCreator(),
        })),
      })
    );
  }

  if (url.pathname.startsWith('/api/room/new')) {
    const session = auth.sessionFromRequest(req);
    const creator = session
      ? {
          userId: session.user.id,
          email: session.user.email,
          name: auth.displayName(session.user),
          memberId: null,
        }
      : null;
    const room = store.create(creator);
    res.writeHead(200, securityHeaders({ 'content-type': 'application/json' }));
    return res.end(JSON.stringify({
      code: room.code,
      creator: room.publicCreator(),
      joinUrl: `/r/${room.code}`,
    }));
  }

  const roomInfo = url.pathname.match(/^\/api\/room\/([A-Za-z0-9]{4,8})$/i);
  if (roomInfo && req.method === 'GET') {
    const room = store.get(roomInfo[1]);
    if (!room) {
      res.writeHead(404, securityHeaders({ 'content-type': 'application/json; charset=utf-8' }));
      return res.end(JSON.stringify({ error: 'not_found' }));
    }
    res.writeHead(200, securityHeaders({ 'content-type': 'application/json' }));
    return res.end(JSON.stringify({
      code: room.code,
      creator: room.publicCreator(),
      members: room.roster().map((m) => ({ id: m.id, name: m.name, host: m.host, surface: m.surface })),
    }));
  }

  const joinPath = url.pathname.match(/^\/r\/([A-Za-z0-9]{4,8})$/i);
  if (joinPath && (req.method === 'GET' || req.method === 'HEAD')) {
    const file = path.join(ROOT, 'web', 'join.html');
    const buf = fs.readFileSync(file);
    res.writeHead(200, securityHeaders({ 'content-type': 'text/html; charset=utf-8' }));
    return res.end(buf);
  }

  let file = resolveStatic(url.pathname);
  if (!file) {
    res.writeHead(403, securityHeaders({ 'content-type': 'text/plain; charset=utf-8' }));
    return res.end('Forbidden');
  }
  if (!fs.existsSync(file) && !path.extname(file)) file += '.html';

  fs.readFile(file, (err, buf) => {
    if (err) {
      res.writeHead(404, securityHeaders({ 'content-type': 'text/plain; charset=utf-8' }));
      return res.end('Not found');
    }
    const headers = securityHeaders({ 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
    if (path.extname(file) === '.zip') {
      headers['content-disposition'] = `attachment; filename="${path.basename(file)}"`;
    }
    res.writeHead(200, headers);
    res.end(buf);
  });
}

const server = http.createServer((req, res) => {
  handleRequest(req, res).catch((err) => {
    console.error(err);
    if (!res.headersSent) {
      res.writeHead(500, securityHeaders({ 'content-type': 'text/plain; charset=utf-8' }));
      res.end('Server error');
    }
  });
});

/* --------------------------------------------------------------- websocket */

const wss = new WebSocketServer({ server, path: '/ws' });

function send(socket, msg) {
  if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(msg));
}

function broadcast(room, msg, exceptId) {
  for (const member of room.members.values()) {
    if (member.id === exceptId) continue;
    send(member.socket, msg);
  }
}

wss.on('connection', (socket, req) => {
  const member = new Member(crypto.randomUUID(), socket);
  let room = null;
  socket.lastSeenApp = Date.now();

  socket.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (!msg || typeof msg.type !== 'string') return;
    member.lastSeen = Date.now();
    socket.lastSeenApp = Date.now();

    switch (msg.type) {
      /* Clock alignment. Answered before anything else and never queued. */
      case 'ping':
        return send(socket, { type: 'pong', t0: msg.t0, t1: Date.now() });

      case 'hello': {
        if (auth.enabled()) {
          const session = auth.sessionFromHello(req, msg.session);
          if (!session) {
            send(socket, { type: 'error', error: 'auth_required' });
            socket.close();
            return;
          }
          member.userId = session.user.id;
          member.email = session.user.email;
          member.name = auth.displayName(session.user);
        }
        const code = normalizeRoomCode(msg.room);
        if (!validRoomCode(code)) {
          send(socket, { type: 'error', error: 'invalid_room' });
          return;
        }
        room = store.ensure(code);
        if (!room) {
          send(socket, { type: 'error', error: 'invalid_room' });
          return;
        }
        if (!auth.enabled() || !member.userId) {
          const named = sanitizeText(msg.name, 32);
          if (named) member.name = named;
        }
        if (!member.name) {
          member.name = sanitizeText(member.email ? member.email.split('@')[0] : 'Guest', 32) || 'Guest';
        }
        member.surface = sanitizeText(msg.surface || 'unknown', 16) || 'unknown';
        room.claimCreator(member);
        room.add(member);
        send(socket, {
          type: 'welcome',
          selfId: member.id,
          room: room.code,
          serverTime: Date.now(),
          state: room.state,
          members: room.roster(),
          creator: room.publicCreator(),
          chat: room.chat.slice(-50),
        });
        broadcast(room, {
          type: 'joined',
          member: { ...member.toPublic(), host: room.isHost(member) },
          creator: room.publicCreator(),
        }, member.id);
        return;
      }

      case 'state': {
        if (!room) return;
        const state = room.applyState(
          {
            paused: msg.paused,
            position: msg.position,
            rate: msg.rate,
            source: msg.source !== undefined ? msg.source : room.state.source,
            title: msg.title !== undefined ? msg.title : room.state.title,
          },
          member.id
        );
        member.paused = state.paused;
        member.position = state.position;
        // Sender gets self:true so they don't re-apply their own play/pause.
        broadcast(room, { type: 'state', state, serverTime: Date.now() }, member.id);
        send(socket, { type: 'state', state, serverTime: Date.now(), self: true });
        return;
      }

      /* Pause everyone, then count in. Seek-only resync is a no-op on Fire/Nebula. */
      case 'resync': {
        if (!room) return;
        const at = DuetSync.projected(room.state, Date.now());
        const state = room.applyState({ paused: true, position: at, rate: 1 }, member.id);
        broadcast(room, { type: 'state', state, serverTime: Date.now(), resync: true });
        const startAt = Date.now() + 3200;
        broadcast(room, { type: 'cue', startAt, from: member.id, position: state.position });
        return;
      }

      /* Position heartbeat — powers the live drift readout on every surface. */
      case 'tick': {
        if (!room) return;
        member.position = Number(msg.position) || 0;
        member.paused = Boolean(msg.paused);
        member.title = msg.title ? sanitizeText(msg.title, 120) : member.title;
        broadcast(room, { type: 'tick', id: member.id, position: member.position, paused: member.paused, title: member.title }, member.id);
        return;
      }

      case 'chat': {
        if (!room) return;
        const entry = room.pushChat({
          id: crypto.randomUUID(),
          from: member.id,
          name: member.name,
          text: sanitizeText(msg.text, 500),
          at: Date.now(),
        });
        broadcast(room, { type: 'chat', entry });
        send(socket, { type: 'chat', entry, self: true });
        return;
      }

      /* Synchronised countdown — everyone starts on the same server timestamp. */
      case 'cue': {
        if (!room) return;
        const startAt = Date.now() + Math.min(15000, Math.max(1000, Number(msg.inMs) || 3000));
        broadcast(room, { type: 'cue', startAt, from: member.id, position: Number(msg.position) || room.state.position });
        send(socket, { type: 'cue', startAt, from: member.id, position: Number(msg.position) || room.state.position, self: true });
        return;
      }

      /* WebRTC voice signalling. The server never inspects the payload. */
      case 'signal': {
        if (!room) return;
        const target = room.members.get(msg.to);
        if (target) send(target.socket, { type: 'signal', from: member.id, data: msg.data });
        return;
      }

      default:
        return;
    }
  });

  socket.on('close', () => {
    if (!room) return;
    room.remove(member.id);
    broadcast(room, { type: 'left', id: member.id });
  });

  socket.on('error', () => {});
});

/* Drop sockets that stopped sending app-level pings. Protocol ping/pong is
   unreliable through some reverse proxies and was causing reconnect loops. */
const heartbeat = setInterval(() => {
  const now = Date.now();
  for (const socket of wss.clients) {
    if (now - (socket.lastSeenApp || 0) > 45000) socket.terminate();
  }
  store.sweep();
}, 15000);
heartbeat.unref?.();

function start() {
  return new Promise((resolve) => server.listen(PORT, HOST, () => resolve(server)));
}

if (require.main === module) {
  if (process.env.DUET_AUTH === 'on' && !auth.enabled()) {
    console.error('DUET_AUTH=on requires DUET_OWNER_EMAIL');
    process.exit(1);
  }
  start().then(() => {
    console.log(`Duet listening on http://${HOST}:${PORT}${auth.enabled() ? ' (invite-only auth on)' : ''}`);
  });
}

module.exports = { server, wss, store, start, PORT };
