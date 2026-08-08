'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { parseRokuPlayer } = require('../agent/drivers/roku');

test('Roku Netflix dump can report pause without a playhead', () => {
  const parsed = parseRokuPlayer(`
<player error="false" state="pause">
  <plugin id="netflix" name="Netflix"/>
</player>
`);
  assert.deepStrictEqual(parsed, { paused: true, position: null });
});

test('Roku player dump with a playhead is closed-loop ready', () => {
  const parsed = parseRokuPlayer(
    '<player error="false" state="play"><position>615250 ms</position></player>'
  );
  assert.strictEqual(parsed.paused, false);
  assert.ok(Math.abs(parsed.position - 615.25) < 0.01);
});
