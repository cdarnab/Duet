'use strict';

const test = require('node:test');
const assert = require('node:assert');
const {
  parseMediaSession,
  parseAudioPlayback,
  parseAdbDevices,
  pickAdbSerial,
  waitForAdbAuthorized,
  isLivePlayhead,
  AndroidTvDriver,
} = require('../agent/drivers/androidtv');

const DUMP = `
Sessions Stack - have 2 sessions:
Session #1 com.spotify.music/Ready
  state=PlaybackState {state=3, position=12000, buffered position=15000, speed=1.0, updated=1000}
Session #2 com.netflix.mediaclient/Netflix
  state=PlaybackState {state=2, position=615250, buffered position=700000, speed=1.0, updated=4242}
`;

const FIRE_DUMP = `
MEDIA SESSION SERVICE (dumpsys media_session)
  Media button session is com.netflix.ninja/Netflix media session (userId=0)
  Sessions Stack - have 3 sessions:
    Netflix media session com.netflix.ninja/Netflix media session (userId=0)
      package=com.netflix.ninja
      active=false
      state=PlaybackState {state=3, position=98435, buffered position=0, speed=1.0, updated=1984846954, actions=1049466, custom actions=[], active item id=-1, error=null}
    TtsPlayerServer com.amazon.vizzini/TtsPlayerServer (userId=0)
      package=com.amazon.vizzini
      active=false
      state=null
    AlexaMediaPlayerRuntime com.amazon.alexamediaplayer.runtime.ftv/AlexaMediaPlayerRuntime (userId=0)
      package=com.amazon.alexamediaplayer.runtime.ftv
      active=false
      state=PlaybackState {state=0, position=0, buffered position=0, speed=0.0, updated=0, actions=6, custom actions=[], active item id=-1, error=null}
`;

test('media session parsing prefers Fire TV Netflix ninja over Alexa', () => {
  const parsed = parseMediaSession(FIRE_DUMP);
  assert.ok(parsed);
  assert.strictEqual(parsed.paused, false);
  assert.ok(Math.abs(parsed.position - 98.435) < 0.01);
  assert.strictEqual(parsed.updatedAt, 1984846954);
});

test('a frozen Fire TV playhead is not treated as live', () => {
  assert.strictEqual(
    isLivePlayhead({ position: 98.435, updatedAt: 1984846954 }, 1984963930),
    false
  );
  assert.strictEqual(isLivePlayhead({ position: 10, updatedAt: 1000 }, 1500), true);
});

test('firetv driver stays open-loop and uses the Fire play/pause key', async () => {
  const calls = [];
  const driver = new AndroidTvDriver({
    serial: '192.168.1.146:5555',
    flavor: 'firetv',
    exec: async (_adb, args) => {
      calls.push(args.join(' '));
      return { stdout: 'AFTHA004\n' };
    },
  });
  assert.strictEqual(driver.flavor, 'firetv');
  assert.strictEqual(driver.capabilities.canJump, false);
  assert.strictEqual(await driver.position(), null);
  await driver.pause();
  await driver.play();
  assert.ok(calls.some((c) => c.includes('keyevent 85')));
  assert.ok(calls.some((c) => c.includes('media dispatch pause')));
  assert.ok(calls.some((c) => c.includes('media dispatch play')));
  assert.ok(!calls.some((c) => /keyevent 12[67]/.test(c)));
});

test('media session parsing prefers the Netflix player', () => {
  const parsed = parseMediaSession(DUMP);
  assert.ok(parsed);
  assert.strictEqual(parsed.paused, true);
  assert.ok(Math.abs(parsed.position - 615.25) < 0.01);
  assert.strictEqual(parsed.updatedAt, 4242);
});

test('adb devices parser prefers a Fire TV when asked', () => {
  const devices = parseAdbDevices(`
List of devices attached
adb-D2426F3123270432-tz6ENw._adb-tls-connect._tcp	device product:d2426 model:D2426
192.168.1.60:5555	device product:mantis model:AFTM device:mantis
`);
  assert.strictEqual(
    pickAdbSerial(devices, { prefer: 'firetv' }),
    '192.168.1.60:5555'
  );
});

test('waitForAdbAuthorized waits until the TV is allowed', async () => {
  let n = 0;
  const serial = await waitForAdbAuthorized('192.168.1.146:5555', {
    listDevices: async () => {
      n += 1;
      return [
        {
          serial: '192.168.1.146:5555',
          status: n < 3 ? 'unauthorized' : 'device',
          extra: '',
        },
      ];
    },
    sleep: async () => {},
    timeoutMs: 10_000,
    intervalMs: 1,
  });
  assert.strictEqual(serial, '192.168.1.146:5555');
  assert.ok(n >= 3);
});

test('waitForAdbAuthorized times out with a Fire TV hint', async () => {
  await assert.rejects(
    () =>
      waitForAdbAuthorized('192.168.1.146:5555', {
        listDevices: async () => [{ serial: '192.168.1.146:5555', status: 'unauthorized', extra: '' }],
        sleep: async () => {},
        timeoutMs: 5,
        intervalMs: 1,
      }),
    /Always allow/
  );
});

test('adb devices parser prefers a live wireless Capsule', () => {
  const devices = parseAdbDevices(`
List of devices attached
192.168.1.108:41275	offline
adb-D2426F3123270432-tz6ENw._adb-tls-connect._tcp	device product:d2426 model:D2426
emulator-5554	device
`);
  assert.strictEqual(devices.length, 3);
  assert.strictEqual(pickAdbSerial(devices), 'adb-D2426F3123270432-tz6ENw._adb-tls-connect._tcp');
});

test('media session parsing treats state 3 as playing', () => {
  const parsed = parseMediaSession(
    'state=PlaybackState {state=3, position=8000, updated=9}'
  );
  assert.strictEqual(parsed.paused, false);
  assert.strictEqual(parsed.position, 8);
});

test('media session parsing can return pause without a playhead', () => {
  const parsed = parseMediaSession(
    'Session #1 com.netflix.mediaclient/Netflix\n  state=PlaybackState {state=2}'
  );
  assert.strictEqual(parsed.paused, true);
  assert.strictEqual(parsed.position, null);
});

test('audio playback dump reports Netflix pause without a MediaSession', () => {
  const dump = `
AudioPlaybackConfiguration piid:3 uid:10080 state:started attr:AudioAttributes: usage=USAGE_NOTIFICATION content=CONTENT_TYPE_SONIFICATION
AudioPlaybackConfiguration piid:9 uid:10123 state:paused attr:AudioAttributes: usage=USAGE_MEDIA content=CONTENT_TYPE_MOVIE
`;
  const parsed = parseAudioPlayback(dump);
  assert.deepStrictEqual(parsed, { paused: true, position: null });
});

test('audio playback dump treats USAGE_MEDIA started as playing', () => {
  const parsed = parseAudioPlayback(
    'AudioPlaybackConfiguration piid:9 state:started attr:AudioAttributes: usage=USAGE_MEDIA content=CONTENT_TYPE_MOVIE'
  );
  assert.strictEqual(parsed.paused, false);
});
