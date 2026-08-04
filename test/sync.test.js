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

test('applyEvent：根路径整体替换与删除', () => {
  assert.deepEqual(S.applyEvent(null, '/', { a: 1 }), { a: 1 });
  assert.equal(S.applyEvent({ a: 1 }, '/', null), null);
});

test('applyEvent：子路径定点更新不改原对象', () => {
  const r = { status: 'active', players: { p_a: { name: 'A' } } };
  const next = S.applyEvent(r, '/status', 'finished');
  assert.equal(next.status, 'finished');
  assert.equal(r.status, 'active');
  const next2 = S.applyEvent(r, '/players/p_a/name', 'AA');
  assert.equal(next2.players.p_a.name, 'AA');
  const next3 = S.applyEvent(r, '/players/p_a/name', null);
  assert.ok(!('name' in next3.players.p_a));
});

test('configured：仅当页面被主机服务器注入 __RUNFAST_HOST__ 时为 true', () => {
  assert.equal(S.configured(), false);            // Node 无 window
  global.window = { __RUNFAST_HOST__: true };
  assert.equal(S.configured(), true);
  global.window = {};
  assert.equal(S.configured(), false);
  delete global.window;
});

test('patch：已导出为函数（实连由第二期 e2e 覆盖）', () => {
  assert.equal(typeof S.patch, 'function');
});

// createRoom 撞房号：读到「没人用」和真正写进去之间别人抢先建了同号房，服务端禁止整房覆盖 ⇒ 403。
// 修复前这个 403 会直接冲出 for 循环，用户看到词不达意的「建房失败：没有修改权限」。
test('createRoom：撞房号（写入 403）时换个号重试，不把 403 冒泡成建房失败', async () => {
  const realFetch = global.fetch;
  const puts = [];
  global.fetch = async (url, opt) => {
    const method = (opt && opt.method) || 'GET';
    if (method === 'GET') return { ok: true, status: 200, json: async () => null };   // 每个号都「没人用」
    puts.push(String(url));
    // 前两次 PUT 撞号（服务端 403），第三次成功
    if (puts.length <= 2) return { ok: false, status: 403 };
    return { ok: true, status: 200, json: async () => ({ ok: true }) };
  };
  try {
    const { code, pid } = await S.createRoom({ name: '甲', pricePerCardFen: 100 });
    assert.match(code, /^[0-9]{6}$/);
    assert.match(pid, /^p_/);
    assert.equal(puts.length, 3);                       // 撞了两次，第三次才建成
    assert.equal(new Set(puts).size, 3);                // 每次都换了新房号，不是死磕同一个
  } finally { global.fetch = realFetch; }
});

test('createRoom：非 403 的写入失败照旧抛出去，不被当成撞号吞掉', async () => {
  const realFetch = global.fetch;
  global.fetch = async (url, opt) => {
    if (!opt || (opt.method || 'GET') === 'GET') return { ok: true, status: 200, json: async () => null };
    return { ok: false, status: 500 };
  };
  try {
    await assert.rejects(() => S.createRoom({ name: '甲', pricePerCardFen: 100 }), /写入失败 500/);
  } finally { global.fetch = realFetch; }
});

const room = () => ({
  creatorUid: 'boss', sid: 's1', pricePerCardFen: 100, status: 'active',
  players: {
    p_a: { name: '张三', uid: 'd1', at: 1 },
    p_b: { name: '李四', uid: 'd2', at: 2 },
    p_c: { name: '王五', uid: null, at: 3 },
    p_d: { name: '赵六', uid: 'd4', at: 4, left: true, leftAt: 9 },
  },
  tx: {
    t_2: { from: 'p_b', to: 'p_a', points: 6, byUid: 'd2', at: 20 },
    t_1: { from: 'p_c', to: 'p_a', points: 4, byUid: 'd1', at: 10 },
  },
});

test('newKey：带前缀、够长、连续生成不重复', () => {
  const a = S.newKey('t_'), b = S.newKey('t_');
  assert.match(a, /^t_[a-z0-9]{10,}$/);
  assert.notEqual(a, b);
  const many = new Set(Array.from({ length: 500 }, () => S.newKey('p_')));
  assert.equal(many.size, 500);
});

test('findMyPid：按设备 id 找回自己那条（含已退出的）', () => {
  const r = room();
  assert.equal(S.findMyPid(r, 'd1'), 'p_a');
  assert.equal(S.findMyPid(r, 'd4'), 'p_d');   // 退出过也认得，回归靠这个
  assert.equal(S.findMyPid(r, 'd9'), null);    // 新设备
  assert.equal(S.findMyPid(r, null), null);
  assert.equal(S.findMyPid(null, 'd1'), null);
});

test('playingCount：不含已退出的人', () => {
  assert.equal(S.playingCount(room()), 3);
  assert.equal(S.playingCount({ players: {} }), 0);
  assert.equal(S.playingCount(null), 0);
});

test('nameTaken：重名判定，排除自己那条', () => {
  const r = room();
  assert.ok(S.nameTaken(r, '张三'));
  assert.ok(!S.nameTaken(r, '张三', 'p_a'));   // 自己改回自己的名字不算占用
  assert.ok(!S.nameTaken(r, '新来的'));
  assert.ok(S.nameTaken(r, '赵六'));            // 已退出的名字也占着，避免流水认错人
});

test('txList：按时间升序展开成数组并带上 id', () => {
  const list = S.txList(room());
  assert.deepEqual(list.map((t) => t.id), ['t_1', 't_2']);
  assert.equal(list[0].points, 4);
  assert.deepEqual(S.txList({}), []);
  assert.deepEqual(S.txList(null), []);
});

test('normalizeRoom：补上可能缺失的 players / tx', () => {
  const n = S.normalizeRoom({ creatorUid: 'boss' });
  assert.deepEqual(n.players, {});
  assert.deepEqual(n.tx, {});
  assert.equal(S.normalizeRoom(null), null);
});

test('旧的房主/草稿纯函数已移除', () => {
  ['canEdit', 'canAdmin', 'isDraftSaveable', 'draftToRound', 'observerCount', 'mutate']
    .forEach((k) => assert.equal(S[k], undefined, k + ' 应该已删除'));
});
