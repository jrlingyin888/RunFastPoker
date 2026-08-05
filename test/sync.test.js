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

test('parseRoomCode：邀请链接、群里那段话、纯房号都能认出来', () => {
  // 我们自己的邀请链接与邀请文字
  assert.equal(S.parseRoomCode('https://ipa.ydyrx.top/?room=314159'), '314159');
  assert.equal(S.parseRoomCode('http://192.168.1.9:8787/?room=012345'), '012345');
  assert.equal(S.parseRoomCode('来跑得快记分房间围观/记分：https://ipa.ydyrx.top/?room=314159（房号 314159）'), '314159');
  // 只有「房号 xxxxxx」没有链接
  assert.equal(S.parseRoomCode('房号 271828'), '271828');
  assert.equal(S.parseRoomCode('房号：271828'), '271828');
  // 干脆就是 6 位数字，前后带空格也行
  assert.equal(S.parseRoomCode('161803'), '161803');
  assert.equal(S.parseRoomCode('  161803  '), '161803');
  // 全角数字（中文输入法容易带出来）
  assert.equal(S.parseRoomCode('１６１８０３'), '161803');
});

test('parseRoomCode：认不出来时返回 null，不瞎猜', () => {
  assert.equal(S.parseRoomCode('12345'), null);        // 5 位
  assert.equal(S.parseRoomCode('1234567'), null);      // 7 位，不能截前 6 位
  assert.equal(S.parseRoomCode('20260805'), null);     // 8 位日期，不能当房号
  assert.equal(S.parseRoomCode('没有数字'), null);
  assert.equal(S.parseRoomCode(''), null);
  assert.equal(S.parseRoomCode(null), null);
  assert.equal(S.parseRoomCode(123456), null);         // 不是字符串
});

test('parseRoomCode：room= 参数优先于文本里别的 6 位数', () => {
  // 邀请文字里既有日期又有房号，room= 说了算
  assert.equal(S.parseRoomCode('8月5日 20:30 开局 https://x/?room=987654'), '987654');
  // 没有 room= 时「房号」标签优先于前面那串孤立数字
  assert.equal(S.parseRoomCode('密码 111222，房号 333444'), '333444');
});

// ---------- 一局一组：分组逻辑 ----------
const M = 60000;
// 三个老玩家 + 一个中途加入的（模拟用户实测里的 Kog）
const roomWithLateJoiner = () => ({
  p_rong: { name: '荣', uid: 'd1', at: 0 },
  p_mei:  { name: '美伶', uid: 'd2', at: 0 },
  p_ye:   { name: '叶', uid: 'd3', at: 0 },
  p_kog:  { name: 'Kog', uid: 'd4', at: 30 * M },   // 30 分钟后才进来
});
const tx = (from, to, at, points) => ({ id: 't' + at + from, from, to, points: points || 1, at });

test('groupRounds：3 人时一局最多 2 笔，第 3 笔另起一局', () => {
  const ps = roomWithLateJoiner();
  const gs = S.groupRounds([
    tx('p_rong', 'p_ye', 1 * M), tx('p_mei', 'p_ye', 1 * M + 5000),   // 第1局
    tx('p_rong', 'p_ye', 2 * M), tx('p_mei', 'p_ye', 2 * M + 5000),   // 第2局（同一个赢家，靠付款人重复切开）
  ], ps);
  assert.deepEqual(gs.map((g) => g.items.length), [2, 2]);
  assert.deepEqual(gs.map((g) => g.no), [1, 2]);
});

test('groupRounds：中途加入的人，第一笔不会被吸进他还没进房的那一局', () => {
  const ps = roomWithLateJoiner();
  const gs = S.groupRounds([
    // 第1局：Kog 还没来，只有荣和美伶给叶
    tx('p_rong', 'p_ye', 29 * M), tx('p_mei', 'p_ye', 29 * M + 5000),
    // Kog 30 分钟时进房；第2局三人都给叶，Kog 先付
    tx('p_kog', 'p_ye', 31 * M), tx('p_rong', 'p_ye', 31 * M + 5000), tx('p_mei', 'p_ye', 31 * M + 9000),
  ], ps);
  assert.deepEqual(gs.map((g) => g.items.length), [2, 3], 'Kog 那笔必须开新的一局');
  assert.ok(!gs[0].items.some((t) => t.from === 'p_kog'), '第1局里不该出现 Kog');
  assert.equal(gs[1].items[0].from, 'p_kog');
  assert.deepEqual(gs.map((g) => g.max), [2, 3], '满员笔数按开打时人数算：先2后3');
});

test('groupRounds：4 人时一局 3 笔收满，第 4 笔另起一局', () => {
  const ps = roomWithLateJoiner();
  const gs = S.groupRounds([
    tx('p_kog', 'p_ye', 40 * M), tx('p_rong', 'p_ye', 40 * M + 3000), tx('p_mei', 'p_ye', 40 * M + 6000),
    tx('p_kog', 'p_ye', 41 * M),
  ], ps);
  assert.deepEqual(gs.map((g) => g.items.length), [3, 1]);
});

test('groupRounds：换个赢家就是新的一局', () => {
  const ps = roomWithLateJoiner();
  const gs = S.groupRounds([
    tx('p_rong', 'p_ye', 40 * M), tx('p_mei', 'p_ye', 40 * M + 3000),
    tx('p_ye', 'p_rong', 41 * M), tx('p_mei', 'p_rong', 41 * M + 3000),
  ], ps);
  assert.deepEqual(gs.map((g) => g.to), ['p_ye', 'p_rong']);
  assert.deepEqual(gs.map((g) => g.items.length), [2, 2]);
});

test('groupRounds：隔太久（吃饭去了）不算同一局', () => {
  const ps = roomWithLateJoiner();
  const gs = S.groupRounds([
    tx('p_rong', 'p_ye', 40 * M),
    tx('p_mei', 'p_ye', 55 * M),   // 15 分钟后
  ], ps);
  assert.deepEqual(gs.map((g) => g.items.length), [1, 1]);
});

test('groupRounds：已退出的人不算进当时的人数', () => {
  const ps = {
    p_a: { name: 'A', uid: 'd1', at: 0 },
    p_b: { name: 'B', uid: 'd2', at: 0 },
    p_c: { name: 'C', uid: 'd3', at: 0, left: true, leftAt: 10 * M },
  };
  // C 走后只剩 A、B，一局最多 1 笔
  const gs = S.groupRounds([tx('p_a', 'p_b', 20 * M), tx('p_a', 'p_b', 21 * M)], ps);
  assert.deepEqual(gs.map((g) => g.max), [1, 1]);
  assert.deepEqual(gs.map((g) => g.items.length), [1, 1]);
});

test('groupRounds：offset 让升级前记过的旧局接着往下编号', () => {
  const ps = roomWithLateJoiner();
  const gs = S.groupRounds([tx('p_rong', 'p_ye', 40 * M)], ps, 3);
  assert.equal(gs[0].no, 4);
});

test('groupRounds：空流水与缺字段不炸', () => {
  assert.deepEqual(S.groupRounds([], {}), []);
  assert.deepEqual(S.groupRounds(null, null), []);
  const gs = S.groupRounds([{ id: 't1', from: 'p_x', to: 'p_y' }], {});   // 没有 at、玩家也不在名单里
  assert.equal(gs.length, 1);
  assert.equal(gs[0].no, 1);
});

test('roomSizeAt：按时刻算人数', () => {
  const ps = roomWithLateJoiner();
  assert.equal(S.roomSizeAt(ps, 10 * M), 3);   // Kog 还没进
  assert.equal(S.roomSizeAt(ps, 30 * M), 4);   // 正好进来
  assert.equal(S.roomSizeAt(ps, 40 * M), 4);
});
