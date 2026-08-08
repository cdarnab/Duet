'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { RoomStore, Member } = require('../server/rooms');

test('listByCreator returns this user’s rooms, busiest first', () => {
  const store = new RoomStore();
  const empty = store.create({ userId: 'u1', email: 'a@b.com', name: 'Arnab' });
  const busy = store.create({ userId: 'u1', email: 'a@b.com', name: 'Arnab' });
  store.create({ userId: 'u2', email: 'other@b.com', name: 'Sam' });
  busy.add(new Member('m1', null));

  const mine = store.listByCreator({ id: 'u1', email: 'a@b.com' });
  assert.strictEqual(mine.length, 2);
  assert.strictEqual(mine[0].code, busy.code);
  assert.strictEqual(mine[1].code, empty.code);
});

test('listByCreator is empty for a stranger', () => {
  const store = new RoomStore();
  store.create({ userId: 'u1', email: 'a@b.com', name: 'Arnab' });
  assert.deepStrictEqual(store.listByCreator({ id: 'u9', email: 'nope@b.com' }), []);
  assert.deepStrictEqual(store.listByCreator(null), []);
});
