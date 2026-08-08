'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const { RoomStore, Member, validRoomCode, normalizeRoomCode } = require('./rooms');

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

const server = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, securityHeaders({ 'content-type': 'application/json' }));
    return res.end(JSON.stringify({ ok: true, rooms: store.rooms.size, uptime: process.uptime() }));
  }

  if (req.url.startsWith('/api/room/new')) {
    const room = store.create();
    res.writeHead(200, securityHeaders({ 'content-type': 'application/json' }));
    return res.end(JSON.stringify({ code: room.code }));
  }

  let file = resolveStatic(req.url);
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

wss.on('connection', (socket) => {
  const member = new Member(crypto.randomUUID(), socket);
  let room = null;

  socket.isAlive = true;
  socket.on('pong', () => {
    socket.isAlive = true;
  });

  socket.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (!msg || typeof msg.type !== 'string') return;
    member.lastSeen = Date.now();

    switch (msg.type) {
      /* Clock alignment. Answered before anything else and never queued. */
      case 'ping':
        return send(socket, { type: 'pong', t0: msg.t0, t1: Date.now() });

      case 'hello': {
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
        member.name = sanitizeText(msg.name || 'Guest', 32) || 'Guest';
        member.surface = sanitizeText(msg.surface || 'unknown', 16) || 'unknown';
        room.add(member);
        send(socket, {
          type: 'welcome',
          selfId: member.id,
          room: room.code,
          serverTime: Date.now(),
          state: room.state,
          members: room.roster(),
          chat: room.chat.slice(-50),
        });
        broadcast(room, { type: 'joined', member: member.toPublic() }, member.id);
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

      /* Snap every player back to the room clock — not just the requester. */
      case 'resync':
        if (!room) return;
        broadcast(room, { type: 'state', state: room.state, serverTime: Date.now(), resync: true });
        return;

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

/* Drop sockets that stopped answering — a dead peer should not show as present. */
const heartbeat = setInterval(() => {
  for (const socket of wss.clients) {
    if (socket.isAlive === false) {
      socket.terminate();
      continue;
    }
    socket.isAlive = false;
    socket.ping();
  }
  store.sweep();
}, 15000);
heartbeat.unref?.();

function start() {
  return new Promise((resolve) => server.listen(PORT, HOST, () => resolve(server)));
}

if (require.main === module) {
  start().then(() => {
    console.log(`Duet listening on http://${HOST}:${PORT}`);
  });
}

module.exports = { server, wss, store, start, PORT };
