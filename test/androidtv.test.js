'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { parseMediaSession } = require('../agent/drivers/androidtv');

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

test('media session parsing treats state 3 as playing', () => {
  const parsed = parseMediaSession(
    'state=PlaybackState {state=3, position=8000, updated=9}'
  );
  assert.strictEqual(parsed.paused, false);
  assert.strictEqual(parsed.position, 8);
});
