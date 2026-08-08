'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const WebSocket = require('ws');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'duet-auth-'));
process.env.PORT = process.env.PORT || '8097';
process.env.DUET_AUTH = 'on';
process.env.DUET_OWNER_EMAIL = 'owner@example.com';
process.env.DUET_SETUP_TOKEN = 'setup-token-for-tests-ok';
process.env.DUET_DATA_DIR = dir;

const { server, start, PORT } = require('../server/index');
const base = () => `http://127.0.0.1:${PORT}`;

function jsonHeaders(extra = {}) {
  return { origin: base(), 'content-type': 'application/json', ...extra };
}

let cookie = '';
function withCookie(extra = {}) {
  return jsonHeaders(cookie ? { cookie, ...extra } : extra);
}

function takeCookie(res) {
  const header = res.headers.get('set-cookie');
  if (!header) return;
  const match = String(header).match(/duet_session=([^;]+)/);
  if (match) cookie = `duet_session=${decodeURIComponent(match[1])}`;
}

test.before(async () => {
  await start();
});

test.after(() => {
  server.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('extension install assets are public', async () => {
  const version = await fetch(`${base()}/version.json`);
  assert.strictEqual(version.status, 200);
  const info = await version.json();
  assert.match(info.version, /^\d+\.\d+\.\d+$/);

  const script = await fetch(`${base()}/install-duet.sh`);
  assert.strictEqual(script.status, 200);
  assert.match(await script.text(), /Library\/Application Support\/Duet\/extension/);

  const files = await fetch(`${base()}/api/extension/files`);
  assert.strictEqual(files.status, 200);
  const listing = await files.json();
  assert.ok(listing.files.includes('manifest.json'));
  const manifest = await fetch(`${base()}/extension-dist/manifest.json`);
  assert.strictEqual(manifest.status, 200);
  assert.match(await manifest.text(), /"manifest_version"/);
});

test('the landing page is public but room surfaces require login', async () => {
  const landing = await fetch(`${base()}/`, { redirect: 'manual' });
  assert.strictEqual(landing.status, 200);
  assert.match(await landing.text(), /Press play/);
  const protectedPage = await fetch(`${base()}/companion.html`, { redirect: 'manual' });
  assert.strictEqual(protectedPage.status, 302);
  assert.match(protectedPage.headers.get('location'), /^\/login\?next=/);
});

test('room API requires a session', async () => {
  const res = await fetch(`${base()}/api/room/new`);
  assert.strictEqual(res.status, 401);
});

test('websocket hello without a session is rejected', async () => {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
  await new Promise((resolve) => ws.on('open', resolve));
  ws.send(JSON.stringify({ type: 'hello', room: 'AUTHAA', name: 'X', surface: 'browser' }));
  const msg = await new Promise((resolve) => ws.on('message', (raw) => resolve(JSON.parse(raw))));
  assert.strictEqual(msg.error, 'auth_required');
  ws.close();
});

test('owner setup, login, invite, and invited user can create a room', async () => {
  const setup = await fetch(`${base()}/setup`, {
    method: 'POST',
    headers: jsonHeaders(),
    body: JSON.stringify({ token: 'setup-token-for-tests-ok', password: 'super-secret-password' }),
  });
  assert.strictEqual(setup.status, 200);

  const login = await fetch(`${base()}/login`, {
    method: 'POST',
    headers: jsonHeaders(),
    body: JSON.stringify({ email: 'owner@example.com', password: 'super-secret-password' }),
  });
  assert.strictEqual(login.status, 200);
  takeCookie(login);

  const invite = await fetch(`${base()}/api/invites`, {
    method: 'POST',
    headers: withCookie(),
    body: JSON.stringify({ email: 'friend@example.com' }),
  });
  assert.strictEqual(invite.status, 200);
  const invited = await invite.json();
  assert.match(invited.url, /^\/invite\//);

  cookie = '';
  const accept = await fetch(`${base()}${invited.url}`, {
    method: 'POST',
    headers: jsonHeaders(),
    body: JSON.stringify({ name: 'Sam', password: 'another-strong-pw' }),
  });
  assert.strictEqual(accept.status, 200);
  takeCookie(accept);

  const me = await fetch(`${base()}/api/me`, { headers: withCookie() });
  assert.strictEqual(me.status, 200);
  const meBody = await me.json();
  assert.strictEqual(meBody.name, 'Sam');
  assert.strictEqual(meBody.canSetName, false);

  const renamed = await fetch(`${base()}/api/me`, {
    method: 'POST',
    headers: withCookie(),
    body: JSON.stringify({ name: 'Samira' }),
  });
  assert.strictEqual(renamed.status, 409);
  assert.strictEqual((await renamed.json()).error, 'name_locked');

  const room = await fetch(`${base()}/api/room/new`, { headers: withCookie() });
  assert.strictEqual(room.status, 200);
  const body = await room.json();
  assert.match(body.code, /^[A-Z0-9]{6}$/);
  assert.strictEqual(body.creator.name, 'Sam');
  assert.match(body.joinUrl, /^\/r\/[A-Z0-9]{6}$/);

  const page = await fetch(`${base()}${body.joinUrl}`, { headers: withCookie() });
  assert.strictEqual(page.status, 200);
  assert.match(await page.text(), /Join this room/);

  const mine = await fetch(`${base()}/api/rooms/mine`, { headers: withCookie() });
  assert.strictEqual(mine.status, 200);
  const listed = await mine.json();
  assert.ok(listed.rooms.some((room) => room.code === body.code));
});

test('rooms/mine requires a session', async () => {
  const res = await fetch(`${base()}/api/rooms/mine`);
  assert.strictEqual(res.status, 401);
});

test('a device agent with a session can join a room', async () => {
  assert.ok(cookie, 'previous test should leave a session cookie');
  const token = cookie.replace(/^duet_session=/, '');

  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
  await new Promise((resolve) => ws.on('open', resolve));
  ws.send(JSON.stringify({ type: 'hello', room: 'ROKUAA', name: 'Living room', surface: 'device', session: token }));
  const msg = await new Promise((resolve) => ws.on('message', (raw) => resolve(JSON.parse(raw))));
  assert.strictEqual(msg.type, 'welcome');
  assert.strictEqual(msg.room, 'ROKUAA');
  ws.close();
});

test('owner can disable, reset, and delete a member', async () => {
  cookie = '';
  const login = await fetch(`${base()}/login`, {
    method: 'POST',
    headers: jsonHeaders(),
    body: JSON.stringify({ email: 'owner@example.com', password: 'super-secret-password' }),
  });
  assert.strictEqual(login.status, 200);
  takeCookie(login);

  const directory = await fetch(`${base()}/api/invites`, { headers: withCookie() });
  assert.strictEqual(directory.status, 200);
  const listed = await directory.json();
  const member = listed.users.find((user) => user.email === 'friend@example.com');
  assert.ok(member?.id);
  assert.strictEqual(member.disabled, false);

  const owner = listed.users.find((user) => user.role === 'owner');
  const blockOwner = await fetch(`${base()}/api/users/${owner.id}/disable`, {
    method: 'POST',
    headers: withCookie(),
  });
  assert.strictEqual(blockOwner.status, 400);

  const disable = await fetch(`${base()}/api/users/${member.id}/disable`, {
    method: 'POST',
    headers: withCookie(),
  });
  assert.strictEqual(disable.status, 200);
  assert.strictEqual((await disable.json()).user.disabled, true);

  const memberLogin = await fetch(`${base()}/login`, {
    method: 'POST',
    headers: jsonHeaders(),
    body: JSON.stringify({ email: 'friend@example.com', password: 'another-strong-pw' }),
  });
  assert.strictEqual(memberLogin.status, 403);

  const enable = await fetch(`${base()}/api/users/${member.id}/enable`, {
    method: 'POST',
    headers: withCookie(),
  });
  assert.strictEqual(enable.status, 200);

  const reset = await fetch(`${base()}/api/users/${member.id}/reset`, {
    method: 'POST',
    headers: withCookie(),
  });
  assert.strictEqual(reset.status, 200);
  const resetBody = await reset.json();
  assert.match(resetBody.url, /^\/reset\//);

  cookie = '';
  const acceptReset = await fetch(`${base()}${resetBody.url}`, {
    method: 'POST',
    headers: jsonHeaders(),
    body: JSON.stringify({ password: 'brand-new-password' }),
  });
  assert.strictEqual(acceptReset.status, 200);
  takeCookie(acceptReset);

  const me = await fetch(`${base()}/api/me`, { headers: withCookie() });
  assert.strictEqual(me.status, 200);
  assert.strictEqual((await me.json()).email, 'friend@example.com');

  const oldPassword = await fetch(`${base()}/login`, {
    method: 'POST',
    headers: jsonHeaders(),
    body: JSON.stringify({ email: 'friend@example.com', password: 'another-strong-pw' }),
  });
  assert.strictEqual(oldPassword.status, 401);

  cookie = '';
  const ownerAgain = await fetch(`${base()}/login`, {
    method: 'POST',
    headers: jsonHeaders(),
    body: JSON.stringify({ email: 'owner@example.com', password: 'super-secret-password' }),
  });
  takeCookie(ownerAgain);

  const remove = await fetch(`${base()}/api/users/${member.id}`, {
    method: 'DELETE',
    headers: withCookie(),
  });
  assert.strictEqual(remove.status, 200);

  const after = await fetch(`${base()}/api/invites`, { headers: withCookie() });
  const afterBody = await after.json();
  assert.ok(!afterBody.users.some((user) => user.email === 'friend@example.com'));
});
