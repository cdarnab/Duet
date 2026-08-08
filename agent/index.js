#!/usr/bin/env node
'use strict';

/**
 * duet-agent — run this on any machine in the same house as the TV.
 *
 *   node agent/index.js --discover
 *   node agent/index.js --room ABCDEF --device roku --host 192.168.1.42 \\
 *     --server https://duet.arnabbanik.com
 *
 * Capsule from this laptop (login once, then double-click or npm run capsule):
 *
 *   node agent/index.js --device nebula
 */

const { Agent } = require('./agent');
const { discoverRoku } = require('./discover');
const { timecode } = require('../shared/sync');
const store = require('./store');
const {
  DEFAULT_SERVER,
  loginSession,
  resolveCapsuleLaunch,
} = require('./launch');
const { listAdbDevices } = require('./drivers/androidtv');

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
    case 'firetv':
    case 'nebula': {
      const { AndroidTvDriver } = require('./drivers/androidtv');
      if (!args.host && !args.serial) {
        throw new Error(`${args.device} needs --host IP or --serial from \`adb devices\``);
      }
      return new AndroidTvDriver({
        host: args.host,
        port: Number(args.port || 5555),
        serial: args.serial,
        adb: args.adb || 'adb',
        flavor: args.device === 'nebula' ? 'nebula' : 'androidtv',
        ...shared,
      });
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
      throw new Error(`unknown device "${args.device}" — use roku, androidtv, nebula, appletv, or mock`);
  }
}

function wireAgent(agent, driver) {
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
}

async function startAgent({ server, room, driver, name, session }) {
  const agent = new Agent({ server, room, driver, name, session });
  wireAgent(agent, driver);
  await agent.start();
  process.on('SIGINT', () => {
    console.log('\nStopping.');
    agent.stop();
    process.exit(0);
  });
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.capsule && !args.device) args.device = 'nebula';

  if (args.logout) {
    const cfg = store.loadConfig();
    if (cfg.email) await store.deletePassword(cfg.email);
    store.clearConfig();
    console.log('Cleared saved Duet login.');
    return;
  }

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

  if (args.device === 'nebula' || args.login) {
    const resolved = await resolveCapsuleLaunch(args, store, { listDevices: listAdbDevices });
    if (resolved.onlyLogin) {
      console.log(`Ready. Next time just run npm run capsule (or double-click scripts/duet-capsule.command).`);
      return;
    }
    const driver = await buildDriver({
      device: 'nebula',
      host: resolved.host,
      port: resolved.port,
      serial: resolved.serial,
      adb: resolved.adb,
      'jump-back': args['jump-back'],
      'jump-forward': args['jump-forward'],
    });
    await startAgent({
      server: resolved.server,
      room: resolved.room,
      driver,
      name: resolved.name,
      session: resolved.session,
    });
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
  await startAgent({
    server,
    room: args.room,
    driver,
    name: args.name,
    session,
  });
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}

module.exports = { parseArgs, buildDriver, loginSession, DEFAULT_SERVER };
