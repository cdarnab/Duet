'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { promisify } = require('util');

const scrypt = promisify(crypto.scrypt);

const OWNER_EMAIL = String(process.env.DUET_OWNER_EMAIL || '').trim().toLowerCase();
const SETUP_TOKEN = String(process.env.DUET_SETUP_TOKEN || '');
const AUTH_ON = process.env.DUET_AUTH === 'on';
const DATA_DIR = process.env.DUET_DATA_DIR || path.join(__dirname, '..', 'data');
const STORE_PATH = path.join(DATA_DIR, 'auth.json');
const WEB = path.join(__dirname, '..', 'web');
const COOKIE = 'duet_session';
const SESSION_MS = 1000 * 60 * 60 * 24 * 30;
const MIN_PASSWORD = 12;

const store = { users: [], invites: [], sessions: [], resets: [] };
let writeChain = Promise.resolve();

function enabled() {
  return AUTH_ON && Boolean(OWNER_EMAIL);
}

function load() {
  try {
    const parsed = JSON.parse(fs.readFileSync(STORE_PATH, 'utf8'));
    store.users = Array.isArray(parsed.users) ? parsed.users : [];
    store.invites = Array.isArray(parsed.invites) ? parsed.invites : [];
    store.sessions = Array.isArray(parsed.sessions) ? parsed.sessions : [];
    store.resets = Array.isArray(parsed.resets) ? parsed.resets : [];
  } catch {
    store.users = [];
    store.invites = [];
    store.sessions = [];
    store.resets = [];
  }
}

function persist() {
  writeChain = writeChain
    .then(() => {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      const tmp = `${STORE_PATH}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(store, null, 2));
      fs.renameSync(tmp, STORE_PATH);
    })
    .catch((err) => console.error('auth persist failed', err));
  return writeChain;
}

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function validEmail(email) {
  return /^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/i.test(email) && email.length <= 120;
}

function validPassword(password) {
  return typeof password === 'string' && password.length >= MIN_PASSWORD && password.length <= 200;
}

function normalizeName(value) {
  return String(value || '')
    .replace(/[\u0000-\u001F]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 24);
}

function validName(value) {
  const name = normalizeName(value);
  return name.length >= 2 && /^[\p{L}\p{N} .'\-]+$/u.test(name);
}

function displayName(user) {
  if (user && validName(user.name)) return normalizeName(user.name);
  const fallback = String(user?.email || 'Guest').split('@')[0];
  return fallback.slice(0, 24) || 'Guest';
}

function hashToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('base64url');
}

function safeEqual(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

function parseCookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function cookieFlags(req) {
  const proto = String(req.headers['x-forwarded-proto'] || '');
  const secure = proto === 'https' || Boolean(req.socket && req.socket.encrypted);
  return `HttpOnly; SameSite=Lax; Path=/; Max-Age=${Math.floor(SESSION_MS / 1000)}${secure ? '; Secure' : ''}`;
}

function clientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded) return String(forwarded).split(',')[0].trim();
  return req.socket?.remoteAddress || 'unknown';
}

const buckets = new Map();
function rateLimit(key, max, windowMs) {
  const now = Date.now();
  let bucket = buckets.get(key);
  if (!bucket || now > bucket.reset) bucket = { n: 0, reset: now + windowMs };
  bucket.n += 1;
  buckets.set(key, bucket);
  return bucket.n <= max;
}

function sameOrigin(req) {
  const host = req.headers.host;
  if (!host) return false;
  if (req.headers.origin) {
    try {
      return new URL(req.headers.origin).host === host;
    } catch {
      return false;
    }
  }
  if (req.method === 'GET' || req.method === 'HEAD') return true;
  const referer = req.headers.referer;
  if (!referer) return false;
  try {
    return new URL(referer).host === host;
  } catch {
    return false;
  }
}

function readBody(req, limit = 8192) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('too_large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      const type = String(req.headers['content-type'] || '');
      if (type.includes('application/json')) {
        try {
          resolve(JSON.parse(raw || '{}'));
        } catch {
          resolve({});
        }
        return;
      }
      resolve(Object.fromEntries(new URLSearchParams(raw)));
    });
    req.on('error', reject);
  });
}

async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(password, salt, 32, { N: 16384, r: 8, p: 1 });
  return `scrypt$16384$8$1$${salt.toString('base64')}$${Buffer.from(key).toString('base64')}`;
}

async function verifyPassword(password, stored) {
  const parts = String(stored || '').split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  try {
    const salt = Buffer.from(parts[4], 'base64');
    const expected = Buffer.from(parts[5], 'base64');
    const key = Buffer.from(await scrypt(password, salt, expected.length, { N: Number(parts[1]), r: Number(parts[2]), p: Number(parts[3]) }));
    if (key.length !== expected.length) return false;
    return crypto.timingSafeEqual(key, expected);
  } catch {
    return false;
  }
}

function pruneSessions() {
  const now = Date.now();
  store.sessions = store.sessions.filter((row) => row.expiresAt > now);
}

function userByEmail(email) {
  return store.users.find((user) => user.email === normalizeEmail(email));
}

function userById(id) {
  return store.users.find((user) => user.id === id);
}

function isOwner(user) {
  return Boolean(user && user.email === OWNER_EMAIL);
}

function publicUser(user) {
  return {
    id: user.id,
    email: user.email,
    name: displayName(user),
    role: user.role || (isOwner(user) ? 'owner' : 'member'),
    disabled: Boolean(user.disabled),
    createdAt: user.createdAt || 0,
  };
}

function pruneInvites() {
  const now = Date.now();
  store.invites = store.invites.filter((invite) => !invite.usedAt && invite.expiresAt > now);
}

function pruneResets() {
  const now = Date.now();
  store.resets = store.resets.filter((reset) => !reset.usedAt && reset.expiresAt > now);
}

function destroySessionsForUser(userId) {
  store.sessions = store.sessions.filter((row) => row.userId !== userId);
}

function requireOwner(req, res, securityHeaders, { html = false } = {}) {
  const session = sessionFromRequest(req);
  if (session && isOwner(session.user)) return session;
  if (html) redirect(res, securityHeaders, '/login');
  else json(res, securityHeaders, 403, { error: 'forbidden' });
  return null;
}

function sessionFromToken(token) {
  if (!token) return null;
  pruneSessions();
  const row = store.sessions.find((session) => session.hash === hashToken(token));
  if (!row) return null;
  const user = store.users.find((entry) => entry.id === row.userId);
  if (!user || user.disabled) return null;
  return { user, session: row };
}

function sessionFromRequest(req) {
  return sessionFromToken(parseCookies(req)[COOKIE]);
}

function sessionFromHello(req, explicitToken) {
  return sessionFromToken(explicitToken || parseCookies(req)[COOKIE]);
}

async function createSession(userId) {
  const token = randomToken();
  store.sessions.push({ hash: hashToken(token), userId, expiresAt: Date.now() + SESSION_MS });
  await persist();
  return token;
}

function destroySession(token) {
  if (!token) return;
  store.sessions = store.sessions.filter((row) => row.hash !== hashToken(token));
  persist();
}

function ownerExists() {
  return Boolean(userByEmail(OWNER_EMAIL)?.passwordHash);
}

function json(res, securityHeaders, status, body) {
  res.writeHead(status, securityHeaders({ 'content-type': 'application/json; charset=utf-8' }));
  res.end(JSON.stringify(body));
  return true;
}

function redirect(res, securityHeaders, location, extraHeaders = {}) {
  res.writeHead(302, securityHeaders({ location, ...extraHeaders }));
  res.end();
  return true;
}

function sendHtml(res, securityHeaders, name, status = 200, extraHeaders = {}) {
  const file = path.join(WEB, name);
  const buf = fs.readFileSync(file);
  res.writeHead(status, securityHeaders({ 'content-type': 'text/html; charset=utf-8', ...extraHeaders }));
  res.end(buf);
  return true;
}

async function handleHttp(req, res, url, { securityHeaders }) {
  if (!enabled()) return false;

  const pathname = url.pathname.replace(/\/+$/, '') || '/';

  if (pathname === '/api/me') {
    const session = sessionFromRequest(req);
    if (!session) return json(res, securityHeaders, 401, { error: 'auth_required' });
    if (req.method === 'POST') {
      if (!sameOrigin(req)) return json(res, securityHeaders, 403, { error: 'forbidden' });
      const body = await readBody(req);
      if (!validName(body.name)) return json(res, securityHeaders, 400, { error: 'invalid_name' });
      session.user.name = normalizeName(body.name);
      await persist();
      return json(res, securityHeaders, 200, {
        email: session.user.email,
        name: displayName(session.user),
        owner: isOwner(session.user),
      });
    }
    return json(res, securityHeaders, 200, {
      email: session.user.email,
      name: displayName(session.user),
      owner: isOwner(session.user),
    });
  }

  if (pathname === '/login') {
    if (req.method === 'GET') return sendHtml(res, securityHeaders, 'login.html');
    if (req.method !== 'POST' || !sameOrigin(req)) return json(res, securityHeaders, 403, { error: 'forbidden' });
    if (!rateLimit(`login:${clientIp(req)}`, 5, 15 * 60 * 1000)) {
      return json(res, securityHeaders, 429, { error: 'too_many_attempts' });
    }
    const body = await readBody(req);
    const email = normalizeEmail(body.email);
    const password = String(body.password || '');
    const user = userByEmail(email);
    const ok = user ? await verifyPassword(password, user.passwordHash) : await verifyPassword(password, 'scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=');
    if (!user || !ok) return json(res, securityHeaders, 401, { error: 'invalid_credentials' });
    if (user.disabled) return json(res, securityHeaders, 403, { error: 'disabled' });
    const token = await createSession(user.id);
    res.setHeader('set-cookie', `${COOKIE}=${encodeURIComponent(token)}; ${cookieFlags(req)}`);
    return json(res, securityHeaders, 200, { ok: true, owner: isOwner(user) });
  }

  if (pathname === '/logout') {
    if (req.method !== 'POST' || !sameOrigin(req)) return json(res, securityHeaders, 403, { error: 'forbidden' });
    destroySession(parseCookies(req)[COOKIE]);
    res.setHeader('set-cookie', `${COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`);
    return redirect(res, securityHeaders, '/login');
  }

  if (pathname === '/setup') {
    if (ownerExists()) return json(res, securityHeaders, 404, { error: 'not_found' });
    if (req.method === 'GET') return sendHtml(res, securityHeaders, 'setup.html');
    if (req.method !== 'POST' || !sameOrigin(req)) return json(res, securityHeaders, 403, { error: 'forbidden' });
    if (!rateLimit(`setup:${clientIp(req)}`, 10, 15 * 60 * 1000)) {
      return json(res, securityHeaders, 429, { error: 'too_many_attempts' });
    }
    const body = await readBody(req);
    if (!SETUP_TOKEN || !safeEqual(body.token, SETUP_TOKEN)) {
      return json(res, securityHeaders, 401, { error: 'invalid_setup' });
    }
    if (!validPassword(body.password)) return json(res, securityHeaders, 400, { error: 'weak_password' });
    const ownerName = validName(body.name) ? normalizeName(body.name) : displayName({ email: OWNER_EMAIL });
    store.users.push({
      id: crypto.randomUUID(),
      email: OWNER_EMAIL,
      name: ownerName,
      passwordHash: await hashPassword(body.password),
      role: 'owner',
      createdAt: Date.now(),
    });
    await persist();
    return json(res, securityHeaders, 200, { ok: true, email: OWNER_EMAIL });
  }

  const inviteMatch = pathname.match(/^\/invite\/([A-Za-z0-9_-]+)$/);
  if (inviteMatch) {
    if (req.method === 'GET') return sendHtml(res, securityHeaders, 'invite.html');
    if (req.method !== 'POST' || !sameOrigin(req)) return json(res, securityHeaders, 403, { error: 'forbidden' });
    if (!rateLimit(`invite:${clientIp(req)}`, 10, 15 * 60 * 1000)) {
      return json(res, securityHeaders, 429, { error: 'too_many_attempts' });
    }
    const body = await readBody(req);
    if (!validPassword(body.password)) return json(res, securityHeaders, 400, { error: 'weak_password' });
    if (!validName(body.name)) return json(res, securityHeaders, 400, { error: 'invalid_name' });
    pruneSessions();
    pruneInvites();
    const invite = store.invites.find((row) => row.hash === hashToken(inviteMatch[1]));
    if (!invite) return json(res, securityHeaders, 401, { error: 'invalid_invite' });
    if (userByEmail(invite.email)) return json(res, securityHeaders, 409, { error: 'already_registered' });
    const user = {
      id: crypto.randomUUID(),
      email: invite.email,
      name: normalizeName(body.name),
      passwordHash: await hashPassword(body.password),
      role: 'member',
      createdAt: Date.now(),
    };
    store.users.push(user);
    invite.usedAt = Date.now();
    const token = await createSession(user.id);
    res.setHeader('set-cookie', `${COOKIE}=${encodeURIComponent(token)}; ${cookieFlags(req)}`);
    return json(res, securityHeaders, 200, { ok: true });
  }

  const resetMatch = pathname.match(/^\/reset\/([A-Za-z0-9_-]+)$/);
  if (resetMatch) {
    if (req.method === 'GET') return sendHtml(res, securityHeaders, 'reset.html');
    if (req.method !== 'POST' || !sameOrigin(req)) return json(res, securityHeaders, 403, { error: 'forbidden' });
    if (!rateLimit(`reset:${clientIp(req)}`, 10, 15 * 60 * 1000)) {
      return json(res, securityHeaders, 429, { error: 'too_many_attempts' });
    }
    const body = await readBody(req);
    if (!validPassword(body.password)) return json(res, securityHeaders, 400, { error: 'weak_password' });
    pruneResets();
    const reset = store.resets.find((row) => row.hash === hashToken(resetMatch[1]));
    if (!reset) return json(res, securityHeaders, 401, { error: 'invalid_reset' });
    const user = userById(reset.userId) || userByEmail(reset.email);
    if (!user) return json(res, securityHeaders, 401, { error: 'invalid_reset' });
    user.passwordHash = await hashPassword(body.password);
    reset.usedAt = Date.now();
    destroySessionsForUser(user.id);
    if (user.disabled) {
      await persist();
      return json(res, securityHeaders, 200, { ok: true, disabled: true });
    }
    const token = await createSession(user.id);
    res.setHeader('set-cookie', `${COOKIE}=${encodeURIComponent(token)}; ${cookieFlags(req)}`);
    return json(res, securityHeaders, 200, { ok: true });
  }

  if (pathname === '/admin') {
    if (!requireOwner(req, res, securityHeaders, { html: true })) return true;
    if (req.method === 'GET') return sendHtml(res, securityHeaders, 'admin.html');
    return json(res, securityHeaders, 405, { error: 'method_not_allowed' });
  }

  if (pathname === '/api/invites') {
    const session = requireOwner(req, res, securityHeaders);
    if (!session) return true;
    if (req.method === 'GET') {
      pruneSessions();
      pruneInvites();
      return json(res, securityHeaders, 200, {
        users: store.users.map(publicUser),
        invites: store.invites.map((invite) => ({
          email: invite.email,
          expiresAt: invite.expiresAt,
          createdAt: invite.createdAt || 0,
        })),
      });
    }
    if (req.method === 'POST') {
      if (!sameOrigin(req)) return json(res, securityHeaders, 403, { error: 'forbidden' });
      if (!rateLimit(`create-invite:${session.user.id}`, 20, 60 * 60 * 1000)) {
        return json(res, securityHeaders, 429, { error: 'too_many_attempts' });
      }
      const body = await readBody(req);
      const email = normalizeEmail(body.email);
      if (!validEmail(email)) return json(res, securityHeaders, 400, { error: 'invalid_email' });
      if (userByEmail(email)) return json(res, securityHeaders, 409, { error: 'already_registered' });
      store.invites = store.invites.filter((invite) => invite.email !== email || invite.usedAt);
      const token = randomToken();
      store.invites.push({
        hash: hashToken(token),
        email,
        createdAt: Date.now(),
        expiresAt: Date.now() + 1000 * 60 * 60 * 24 * 7,
        usedAt: null,
      });
      await persist();
      return json(res, securityHeaders, 200, { ok: true, email, url: `/invite/${token}`, expiresAt: Date.now() + 1000 * 60 * 60 * 24 * 7 });
    }
    return json(res, securityHeaders, 405, { error: 'method_not_allowed' });
  }

  const userAction = pathname.match(/^\/api\/users\/([0-9a-f-]{36})\/(disable|enable|reset)$/i);
  if (userAction) {
    const session = requireOwner(req, res, securityHeaders);
    if (!session) return true;
    if (req.method !== 'POST' || !sameOrigin(req)) return json(res, securityHeaders, 403, { error: 'forbidden' });
    const user = userById(userAction[1]);
    if (!user) return json(res, securityHeaders, 404, { error: 'not_found' });
    if (isOwner(user)) return json(res, securityHeaders, 400, { error: 'owner_protected' });
    const action = userAction[2].toLowerCase();
    if (action === 'disable') {
      user.disabled = true;
      user.disabledAt = Date.now();
      destroySessionsForUser(user.id);
      await persist();
      return json(res, securityHeaders, 200, { ok: true, user: publicUser(user) });
    }
    if (action === 'enable') {
      user.disabled = false;
      user.disabledAt = null;
      await persist();
      return json(res, securityHeaders, 200, { ok: true, user: publicUser(user) });
    }
    if (!rateLimit(`reset-link:${session.user.id}`, 20, 60 * 60 * 1000)) {
      return json(res, securityHeaders, 429, { error: 'too_many_attempts' });
    }
    pruneResets();
    store.resets = store.resets.filter((reset) => reset.userId !== user.id || reset.usedAt);
    const token = randomToken();
    const expiresAt = Date.now() + 1000 * 60 * 60 * 24;
    store.resets.push({
      hash: hashToken(token),
      userId: user.id,
      email: user.email,
      createdAt: Date.now(),
      expiresAt,
      usedAt: null,
    });
    await persist();
    return json(res, securityHeaders, 200, { ok: true, email: user.email, url: `/reset/${token}`, expiresAt });
  }

  const userDelete = pathname.match(/^\/api\/users\/([0-9a-f-]{36})$/i);
  if (userDelete) {
    const session = requireOwner(req, res, securityHeaders);
    if (!session) return true;
    if (req.method !== 'DELETE' || !sameOrigin(req)) return json(res, securityHeaders, 403, { error: 'forbidden' });
    const user = userById(userDelete[1]);
    if (!user) return json(res, securityHeaders, 404, { error: 'not_found' });
    if (isOwner(user)) return json(res, securityHeaders, 400, { error: 'owner_protected' });
    store.users = store.users.filter((entry) => entry.id !== user.id);
    destroySessionsForUser(user.id);
    store.invites = store.invites.filter((invite) => invite.email !== user.email || invite.usedAt);
    store.resets = store.resets.filter((reset) => reset.userId !== user.id || reset.usedAt);
    await persist();
    return json(res, securityHeaders, 200, { ok: true });
  }

  return false;
}

load();

module.exports = {
  enabled,
  ownerEmail: () => OWNER_EMAIL,
  ownerExists,
  handleHttp,
  sessionFromRequest,
  sessionFromHello,
  displayName,
  load,
};
