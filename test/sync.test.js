const test = require('node:test');
const assert = require('node:assert/strict');
const S = require('../src/sync.js');

test('genRoomCode：6 位数字，可注入随机源', () => {
  const seq = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6];
  let i = 0;
  assert.equal(S.genRoomCode(() => seq[i++]), '123456');
  assert.match(S.genRoomCode(), /^[0-9]{6}$/);
});

test('validRoomCode', () => {
  assert.ok(S.validRoomCode('012345'));
  assert.ok(!S.validRoomCode('12345'));
  assert.ok(!S.validRoomCode('1234567'));
  assert.ok(!S.validRoomCode('12a456'));
  assert.ok(!S.validRoomCode(123456));
});

test('canEdit / canAdmin 权限判定', () => {
  const room = { creatorUid: 'u1', allowEdit: false };
  assert.ok(S.canEdit(room, 'u1'));
  assert.ok(!S.canEdit(room, 'u2'));
  assert.ok(S.canEdit({ ...room, allowEdit: true }, 'u2'));
  assert.ok(S.canAdmin(room, 'u1'));
  assert.ok(!S.canAdmin({ ...room, allowEdit: true }, 'u2'));
  assert.ok(!S.canEdit(null, 'u1'));
  assert.ok(!S.canEdit(room, null));
});

test('activeLock：记分锁在 TTL 内生效、过期或无锁返回 null', () => {
  const now = 1000000;
  assert.equal(S.activeLock(null, now), null);
  assert.equal(S.activeLock({}, now), null);
  assert.equal(S.activeLock({ editing: { uid: 'a', at: now - 1000 } }, now).uid, 'a'); // 1s 前，生效
  assert.equal(S.activeLock({ editing: { uid: 'a', at: now - 200000 } }, now), null);   // 200s 前，过期
  assert.equal(S.activeLock({ editing: { at: now } }, now), null);                       // 无 uid
});

test('applyEvent：根路径整体替换与删除', () => {
  assert.deepEqual(S.applyEvent(null, '/', { a: 1 }), { a: 1 });
  assert.equal(S.applyEvent({ a: 1 }, '/', null), null);
});

test('applyEvent：子路径定点更新不改原对象', () => {
  const room = { allowEdit: false, session: { rounds: [] } };
  const next = S.applyEvent(room, '/allowEdit', true);
  assert.equal(next.allowEdit, true);
  assert.equal(room.allowEdit, false);
  const next2 = S.applyEvent(room, '/session/status', 'finished');
  assert.equal(next2.session.status, 'finished');
  const next3 = S.applyEvent(room, '/session/status', null);
  assert.ok(!('status' in next3.session));
});

test('configured：仅当页面被主机服务器注入 __RUNFAST_HOST__ 时为 true', () => {
  assert.equal(S.configured(), false);            // Node 无 window
  global.window = { __RUNFAST_HOST__: true };
  assert.equal(S.configured(), true);
  global.window = {};
  assert.equal(S.configured(), false);
  delete global.window;
});

test('normalizeRoom：RTDB 丢掉的空数组字段被补回', () => {
  const room = { creatorUid: 'u1', allowEdit: false, session: { id: 's1' } };
  const n = S.normalizeRoom(room);
  assert.deepEqual(n.session.players, []);
  assert.deepEqual(n.session.activePlayers, []);
  assert.deepEqual(n.session.rounds, []);
  const room2 = { creatorUid: 'u1', session: { id: 's1', rounds: [{ id: 'r1', winner: 'A' }] } };
  assert.deepEqual(S.normalizeRoom(room2).session.rounds[0].losers, []);
  assert.equal(S.normalizeRoom(null), null);
});
