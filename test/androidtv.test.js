'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { parseMediaSession, parseAudioPlayback, parseAdbDevices, pickAdbSerial } = require('../agent/drivers/androidtv');

const DUMP = `
Sessions Stack - have 2 sessions:
Session #1 com.spotify.music/Ready
  state=PlaybackState {state=3, position=12000, buffered position=15000, speed=1.0, updated=1000}
Session #2 com.netflix.mediaclient/Netflix
  state=PlaybackState {state=2, position=615250, buffered position=700000, speed=1.0, updated=4242}
`;

test('media session parsing prefers the Netflix player', () => {
  const parsed = parseMediaSession(DUMP);
  assert.ok(parsed);
  assert.strictEqual(parsed.paused, true);
  assert.ok(Math.abs(parsed.position - 615.25) < 0.01);
  assert.strictEqual(parsed.updatedAt, 4242);
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
