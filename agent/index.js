#!/usr/bin/env node
'use strict';

/**
 * duet-agent — run this on any machine in the same house as the TV.
 *
 *   node agent/index.js --discover
 *   node agent/index.js --room ABCDEF --device roku --host 192.168.1.42 \\
 *     --server https://duet.arnabbanik.com --email you@example.com --password '…'
 */

const { Agent } = require('./agent');
const { discoverRoku } = require('./discover');
const { timecode } = require('../shared/sync');

async function loginSession(server, email, password) {
  const base = String(server).replace(/\/+$/, '');
  const res = await fetch(`${base}/login`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin: base,
    },
    body: JSON.stringify({ email, password }),
  });
  if (res.status === 403) throw new Error('This account is disabled.');
  if (!res.ok) throw new Error('Login failed. Check --email and --password.');
  const header = res.headers.get('set-cookie') || '';
  const match = /duet_session=([^;]+)/.exec(header);
  if (!match) throw new Error('Login succeeded but no session cookie was returned.');
  return decodeURIComponent(match[1]);
}

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) args[key] = true;
    else {
      args[key] = next;
      i++;
    }
  }
  return args;
}

async function buildDriver(args) {
  const shared = {
    jumpBack: Number(args['jump-back'] || 10),
    jumpForward: Number(args['jump-forward'] || 10),
  };
  switch (args.device) {
    case 'roku': {
      const { RokuDriver } = require('./drivers/roku');
      if (!args.host) throw new Error('roku needs --host, or run --discover to find it');
      return new RokuDriver({ host: args.host, ...shared });
    }
    case 'androidtv':
    case 'firetv': {
      const { AndroidTvDriver } = require('./drivers/androidtv');
      if (!args.host) throw new Error('androidtv needs --host');
      return new AndroidTvDriver({ host: args.host, adb: args.adb || 'adb', ...shared });
    }
    case 'appletv': {
      const { AppleTvDriver } = require('./drivers/appletv');
      if (!args.id) throw new Error('appletv needs --id, from `atvscan`');
      return new AppleTvDriver({ id: args.id, credentials: args.credentials, ...shared });
    }
    case 'mock': {
      const { MockDriver } = require('./drivers/mock');
      return new MockDriver({});
    }
    default:
      throw new Error(`unknown device "${args.device}" — use roku, androidtv, appletv, or mock`);
  }
}

async function main() {
  const args = parseArgs(process.argv);

  if (args.discover) {
    console.log('Looking for Roku devices on this network…\n');
    const found = await discoverRoku();
    if (!found.length) {
      console.log('None found. Roku only answers on the same subnet — check you are on the same Wi-Fi.');
      console.log('Android TV and Apple TV are not discoverable this way; see the README.');
      return;
    }
    for (const d of found) console.log(`  ${d.name.padEnd(28)} --device roku --host ${d.host}`);
    return;
  }

  if (!args.room) {
    console.error('Missing --room. Create one at your Duet server, then pass the six-letter code.');
    process.exit(1);
  }

  const server = args.server || process.env.DUET_SERVER || 'http://localhost:8080';
  let session = args.session || process.env.DUET_SESSION || '';
  const email = args.email || process.env.DUET_EMAIL || '';
  const password = args.password || process.env.DUET_PASSWORD || '';
  if (!session && email && password) {
    session = await loginSession(server, email, password);
  }

  const driver = await buildDriver(args);
  const agent = new Agent({
    server,
    room: args.room,
    driver,
    name: args.name,
    session,
  });

  agent.on('status', ({ connected }) =>
    console.log(connected ? `Connected to room ${agent.room}` : 'Lost the server, retrying…')
  );

  agent.on('joined', () => {
    const caps = driver.capabilities;
    console.log(`Driving: ${driver.label} (${driver.name})`);
    console.log(`Command latency: ~${caps.commandLatencyMs}ms`);
    if (caps.readPosition) {
      console.log('Position readback: yes — running closed loop, expect around a second.\n');
    } else {
      console.log('Position readback: no — this app does not publish its playhead.');
      console.log('Running open loop: play, pause, and countdowns stay in sync, but drift');
      console.log('cannot be measured. Use the console to nudge by hand if you separate.\n');
    }
  });

  let lastPrint = 0;
  agent.on('drift', ({ drift, devicePosition }) => {
    if (drift === null || Date.now() - lastPrint < 3000) return;
    lastPrint = Date.now();
    const ms = Math.round(drift * 1000);
    const tag = Math.abs(ms) <= 400 ? 'in step' : `${ms > 0 ? 'ahead' : 'behind'} ${Math.abs(ms)}ms`;
    console.log(`  ${timecode(devicePosition)}  ${tag}`);
  });

  agent.on('correcting', ({ plan, drift, eta }) => {
    const how = plan.steps.map((s) => (s.op === 'jump' ? `${s.dir} ×${s.times}` : `${s.op} ${s.seconds}s`)).join(' then ');
    console.log(`  drift ${drift.toFixed(2)}s → ${how} (~${eta.toFixed(1)}s)`);
  });

  agent.on('manual', (plan) => console.log(`  ${plan.note}`));
  agent.on('cue', ({ wait }) => console.log(`  countdown: pressing play in ${(wait / 1000).toFixed(1)}s`));
  agent.on('error', (err) => console.error(`  ${err.message}`));

  await agent.start();

  process.on('SIGINT', () => {
    console.log('\nStopping.');
    agent.stop();
    process.exit(0);
  });
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}

module.exports = { parseArgs, buildDriver, loginSession };
