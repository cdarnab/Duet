'use strict';

const test = require('node:test');
const assert = require('node:assert');
const {
  pickRoom,
  pickRokuHost,
  sortMine,
  normalizeRoomInput,
  resolveCapsuleLaunch,
  resolveDeviceLaunch,
} = require('../agent/launch');

function fakeStore(initial = {}) {
  let cfg = { ...initial };
  const passwords = {};
  return {
    loadConfig: () => ({ ...cfg }),
    saveConfig: (patch) => {
      cfg = { ...cfg, ...patch };
      delete cfg.password;
      return cfg;
    },
    getPassword: async (email) => passwords[email] || '',
    setPassword: async (email, password) => {
      passwords[email] = password;
    },
    passwordBackend: () => 'file',
  };
}

test('room picker uses an explicit code first', () => {
  const picked = pickRoom({
    explicit: 'wyr-4aq',
    mine: [{ code: 'AAAAAA', members: 2, createdAt: 9 }],
  });
  assert.deepStrictEqual(picked, { code: 'WYR4AQ', source: 'explicit' });
});

test('room picker uses the creator’s busiest room', () => {
  const picked = pickRoom({
    mine: [
      { code: 'OLDONE', members: 0, createdAt: 100 },
      { code: 'WYR4AQ', members: 1, createdAt: 50 },
    ],
  });
  assert.strictEqual(picked.source, 'created');
  assert.strictEqual(picked.code, 'WYR4AQ');
});

test('sortMine prefers members then recency', () => {
  const sorted = sortMine([
    { code: 'A', members: 0, createdAt: 9 },
    { code: 'B', members: 0, createdAt: 3 },
    { code: 'C', members: 2, createdAt: 1 },
  ]);
  assert.deepStrictEqual(
    sorted.map((r) => r.code),
    ['C', 'A', 'B']
  );
});

test('normalizeRoomInput strips junk', () => {
  assert.strictEqual(normalizeRoomInput('  wy r4aq! '), 'WYR4AQ');
});

test('capsule launch uses the host room and a live ADB serial', async () => {
  const resolved = await resolveCapsuleLaunch(
    { device: 'nebula' },
    fakeStore({
      server: 'https://duet.example',
      email: 'host@example.com',
      session: 'live-token',
    }),
    {
      canPrompt: () => false,
      sessionValid: async () => true,
      fetchMineRooms: async () => [{ code: 'WYR4AQ', members: 1, createdAt: 1 }],
      listDevices: async () => [{ serial: 'adb-D2426.tcp', status: 'device' }],
      log: () => {},
    }
  );
  assert.strictEqual(resolved.onlyLogin, false);
  assert.strictEqual(resolved.room, 'WYR4AQ');
  assert.strictEqual(resolved.roomSource, 'created');
  assert.strictEqual(resolved.serial, 'adb-D2426.tcp');
  assert.strictEqual(resolved.email, 'host@example.com');
});

test('capsule launch asks for a code when the user did not create a room', async () => {
  let asked = '';
  const resolved = await resolveCapsuleLaunch(
    { device: 'nebula' },
    fakeStore({ email: 'guest@example.com', session: 'tok' }),
    {
      canPrompt: () => true,
      sessionValid: async () => true,
      fetchMineRooms: async () => [],
      askLine: async (question) => {
        asked = question;
        return 'join99';
      },
      listDevices: async () => [{ serial: '192.168.1.8:5555', status: 'device' }],
      log: () => {},
    }
  );
  assert.match(asked, /Room code/i);
  assert.strictEqual(resolved.room, 'JOIN99');
  assert.strictEqual(resolved.roomSource, 'prompt');
});

test('pickRokuHost prefers a saved IP that is still on the LAN', () => {
  const picked = pickRokuHost(
    [
      { host: '192.168.1.40', name: 'Bedroom' },
      { host: '192.168.1.50', name: 'Living Room' },
    ],
    { savedHost: '192.168.1.50' }
  );
  assert.strictEqual(picked.name, 'Living Room');
});

test('roku launch discovers the TV and joins the host room', async () => {
  const resolved = await resolveDeviceLaunch(
    { device: 'roku' },
    fakeStore({
      server: 'https://duet.example',
      email: 'host@example.com',
      session: 'live-token',
    }),
    {
      kind: 'roku',
      canPrompt: () => false,
      sessionValid: async () => true,
      fetchMineRooms: async () => [{ code: 'JPKAZT', members: 1, createdAt: 1 }],
      discoverRoku: async () => [{ host: '192.168.1.50', name: 'Living Room' }],
      log: () => {},
    }
  );
  assert.strictEqual(resolved.device, 'roku');
  assert.strictEqual(resolved.room, 'JPKAZT');
  assert.strictEqual(resolved.host, '192.168.1.50');
  assert.strictEqual(resolved.name, 'Living Room');
});

test('roku launch fails when none are on the Wi-Fi', async () => {
  await assert.rejects(
    () =>
      resolveDeviceLaunch(
        { device: 'roku' },
        fakeStore({ email: 'host@example.com', session: 'tok' }),
        {
          kind: 'roku',
          canPrompt: () => false,
          sessionValid: async () => true,
          fetchMineRooms: async () => [{ code: 'AAAAAA', members: 1, createdAt: 1 }],
          discoverRoku: async () => [],
          log: () => {},
        }
      ),
    /No Roku on this Wi-Fi/
  );
});

test('capsule launch fails without a room when not a TTY', async () => {
  await assert.rejects(
    () =>
      resolveCapsuleLaunch(
        { device: 'nebula' },
        fakeStore({ email: 'guest@example.com', session: 'tok' }),
        {
          canPrompt: () => false,
          sessionValid: async () => true,
          fetchMineRooms: async () => [],
          listDevices: async () => [{ serial: 'x', status: 'device' }],
          log: () => {},
        }
      ),
    /No room of yours is open/
  );
});
