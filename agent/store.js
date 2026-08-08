'use strict';

/**
 * Local Duet login for the laptop agent. Session lives in ~/.duet/config.json
 * (mode 600). The password is kept in the macOS Keychain when possible, or a
 * mode-600 file next to the config. Never put the password on the command line.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const run = promisify(execFile);

const KEYCHAIN_SERVICE = 'duet.capsule';

function configDir() {
  return process.env.DUET_CONFIG_DIR || path.join(os.homedir(), '.duet');
}

function configPath() {
  return path.join(configDir(), 'config.json');
}

function passwordFile(email) {
  const safe = String(email || 'default')
    .toLowerCase()
    .replace(/[^a-z0-9._@-]+/g, '_');
  return path.join(configDir(), `password-${safe}`);
}

function passwordBackend() {
  if (process.env.DUET_PASSWORD_BACKEND) return process.env.DUET_PASSWORD_BACKEND;
  if (process.env.DUET_CONFIG_DIR) return 'file';
  return process.platform === 'darwin' ? 'keychain' : 'file';
}

function ensurePrivateDir() {
  const dir = configDir();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(dir, 0o700);
  } catch {
    /* ignore */
  }
  return dir;
}

function loadConfig() {
  try {
    const parsed = JSON.parse(fs.readFileSync(configPath(), 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const copy = { ...parsed };
    delete copy.password;
    return copy;
  } catch {
    return {};
  }
}

function saveConfig(patch) {
  ensurePrivateDir();
  const next = { ...loadConfig(), ...patch };
  for (const key of Object.keys(next)) {
    if (next[key] === undefined || next[key] === null || next[key] === '') delete next[key];
  }
  delete next.password;
  fs.writeFileSync(configPath(), `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  try {
    fs.chmodSync(configPath(), 0o600);
  } catch {
    /* ignore */
  }
  return next;
}

function clearConfig() {
  try {
    fs.unlinkSync(configPath());
  } catch {
    /* ignore */
  }
}

function readPasswordFile(email) {
  try {
    return fs.readFileSync(passwordFile(email), 'utf8').replace(/\n$/, '');
  } catch {
    return '';
  }
}

async function getPassword(email) {
  if (!email) return '';
  if (passwordBackend() === 'keychain') {
    try {
      const { stdout } = await run(
        'security',
        ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-a', email, '-w'],
        { timeout: 8000 }
      );
      return String(stdout || '').replace(/\n$/, '');
    } catch {
      return readPasswordFile(email);
    }
  }
  return readPasswordFile(email);
}

async function setPassword(email, password) {
  if (!email || !password) return;
  if (passwordBackend() === 'keychain') {
    try {
      await run(
        'security',
        ['add-generic-password', '-U', '-s', KEYCHAIN_SERVICE, '-a', email, '-w', password],
        { timeout: 8000 }
      );
      return;
    } catch {
      /* fall through to file */
    }
  }
  ensurePrivateDir();
  fs.writeFileSync(passwordFile(email), password, { mode: 0o600 });
  try {
    fs.chmodSync(passwordFile(email), 0o600);
  } catch {
    /* ignore */
  }
}

async function deletePassword(email) {
  if (!email) return;
  if (passwordBackend() === 'keychain') {
    try {
      await run('security', ['delete-generic-password', '-s', KEYCHAIN_SERVICE, '-a', email], {
        timeout: 8000,
      });
    } catch {
      /* ignore */
    }
  }
  try {
    fs.unlinkSync(passwordFile(email));
  } catch {
    /* ignore */
  }
}

module.exports = {
  KEYCHAIN_SERVICE,
  configDir,
  configPath,
  loadConfig,
  saveConfig,
  clearConfig,
  getPassword,
  setPassword,
  deletePassword,
  passwordBackend,
};
