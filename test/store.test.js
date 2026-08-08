'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'duet-store-'));
process.env.DUET_CONFIG_DIR = dir;
process.env.DUET_PASSWORD_BACKEND = 'file';

const store = require('../agent/store');

test.after(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

test('config is written privately without the password', async () => {
  store.saveConfig({
    server: 'https://duet.arnabbanik.com',
    email: 'you@example.com',
    session: 'tok_abc',
    password: 'should-not-be-saved',
  });
  await store.setPassword('you@example.com', 'secret-pass');

  const cfg = store.loadConfig();
  assert.strictEqual(cfg.email, 'you@example.com');
  assert.strictEqual(cfg.session, 'tok_abc');
  assert.strictEqual(cfg.password, undefined);
  assert.strictEqual(await store.getPassword('you@example.com'), 'secret-pass');

  const stat = fs.statSync(store.configPath());
  assert.strictEqual(stat.mode & 0o777, 0o600);
});

test('clearing config drops the session file', async () => {
  store.saveConfig({ email: 'you@example.com', session: 'tok_abc' });
  store.clearConfig();
  assert.deepStrictEqual(store.loadConfig(), {});
});
