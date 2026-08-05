// room.js 在 Node 下的最小宿主：它靠全局拿 Sync/UI/Logic，DOM 只用到 document 的两三个方法。
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

function mkRoom(np, ntx, extra) {
  const players = {}, tx = {};
  for (let i = 0; i < np; i++) players['p' + i] = { name: '玩家' + i, uid: 'u' + i, at: i };
  let at = 1750000000000;
  for (let i = 0; i < ntx; i++) {
    const to = 'p' + (i % np);
    let from = 'p' + ((i + 1 + (i % Math.max(1, np - 1))) % np);
    if (from === to) from = 'p' + ((i + 2) % np);
    tx['t' + i] = { from, to, points: 3, at: (at += 20000), byUid: 'u0' };
  }
  return Object.assign({ creatorUid: 'u0', sid: 's1', createdAt: '2026-08-05T10:00:00.000Z',
    pricePerCardFen: 100, status: 'active', players, tx }, extra);
}

function loadRoom(stubs) {
  const g = globalThis;
  g.RunfastLogic = require('../src/logic.js');
  g.RunfastUI = require('../src/ui.js');
  g.RunfastSync = Object.assign(Object.create(require('../src/sync.js')), stubs.sync || {});
  g.RunfastShare = stubs.share || {};
  g.window = {};
  g.document = { getElementById: () => null, addEventListener: () => {} };
  g.location = { origin: 'https://ipa.ydyrx.top', pathname: '/' };
  g.URL = { createObjectURL: () => 'blob:fake', revokeObjectURL: () => {} };
  delete require.cache[require.resolve('../src/room.js')];
  return require('../src/room.js');
}

// 进房那一刻，state.room 必须是「这个房间的」或者空——不能是上一个房间留下的。
// 留着的话 roomView() 会拿旧 players 渲染：新房号旁边挂着上一局的人数和流水，
// 直到首帧 SSE 到达才跳回正确画面，也就是用户看到的「残留数据 + 闪一下」。
test('attach：换房时不能把上一个房间的数据留在 state.room 里', async () => {
  let sub = null;
  const R = loadRoom({
    sync: {
      signIn: async () => ({ uid: 'dev-me' }),
      getUid: () => 'dev-me',
      subscribe: async (code, cb) => { sub = cb; },
      close: () => {},
    },
  });
  R.init({ go() {}, render() {}, view: () => ({ name: 'room' }) });

  await R.attach('111111', 'p1');
  const roomA = {
    creatorUid: 'dev-me', sid: 's1', createdAt: '2026-08-05T10:00:00.000Z',
    pricePerCardFen: 100, status: 'active',
    players: { p1: { name: '甲', uid: 'dev-me', at: 1 }, p2: { name: '乙', uid: 'x', at: 2 },
      p3: { name: '丙', uid: 'y', at: 3 }, p4: { name: '丁', uid: 'z', at: 4 } },
    tx: { t1: { from: 'p2', to: 'p1', points: 5, at: 10 } },
  };
  sub.onRoom(roomA);
  assert.equal(RunfastSync.playingCount(R.state.room), 4);

  // 结束本场：建房人会保留旧房，好在结算页上「关闭房间」——这是有意的
  sub.onRoom(Object.assign({}, roomA, { status: 'finished' }));
  assert.equal(R.state.room.sid, 's1', '建房人结算页还要用这份旧房');

  // 然后他回首页，又建了一个新房
  await R.attach('222222', 'p9');
  assert.notEqual(R.state.room && R.state.room.sid, 's1',
    'attach 到新房后，state.room 不能还是上一个房间的数据');
});

// 清 state.room 只能清「别的房间」的：preview() 刚读到的这个房的快照要留着直接渲染，
// 否则回房/刷新这条最常走的路要先白闪一下「连接中…」占位页。
test('preview→attach：回自己房间时要沿用刚读到的快照，不闪占位页', async () => {
  const roomA = {
    creatorUid: 'dev-me', sid: 's1', createdAt: '2026-08-05T10:00:00.000Z',
    pricePerCardFen: 100, status: 'active',
    players: { p1: { name: '甲', uid: 'dev-me', at: 1 }, p2: { name: '乙', uid: 'x', at: 2 } },
    tx: {},
  };
  const R = loadRoom({
    sync: {
      signIn: async () => ({ uid: 'dev-me' }),
      getUid: () => 'dev-me',
      readRoom: async () => ({ data: roomA }),
      subscribe: async () => {},
      close: () => {},
    },
  });
  R.init({ go() {}, render() {}, view: () => ({ name: 'room' }) });
  await R.preview('111111');
  assert.equal(R.state.room && R.state.room.sid, 's1', '首帧还没到就该有得渲染');
  assert.equal(R.state.code, '111111');
});

// toBlob 会抛：canvas 被二维码 SVG 污染（老 WebKit / 微信 X5 内核）→ SecurityError；
// 或老 WebView 根本没有 canvas.toBlob → TypeError。两种都逃出 share()，
// 触发它的那个菜单已经被关掉（用户看到「闪一下」），新面板永远不弹，也没有任何提示。
test('share：toBlob 抛异常时要退回简单面板，而不是静默什么都不弹', async () => {
  let opened = 0;
  const R = loadRoom({
    sync: { signIn: async () => ({ uid: 'u' }), getUid: () => 'u', subscribe: async () => {}, close: () => {} },
    share: {
      drawInviteCard: async () => ({}),
      toBlob: async () => { const e = new Error('The operation is insecure.'); e.name = 'SecurityError'; throw e; },
    },
  });
  const openSheet = RunfastUI.openSheet;
  RunfastUI.openSheet = () => { opened++; };
  R.state.code = '314159';
  try {
    await assert.doesNotReject(() => window.Room.share(), '分享不能抛出未处理的 rejection');
    assert.equal(opened, 1, 'toBlob 挂了也必须弹出降级面板（房号+二维码+复制链接）');
  } finally { RunfastUI.openSheet = openSheet; }
});

// ---------- 流畅性 ----------

// 记一笔以前要等 PATCH 打个来回（4G 上 200~400ms）才关弹窗、再等 SSE 回声才看到分数。
// 现在本地立刻记上，网络在后台跑。
test('记分：本地立刻生效，不等网络往返', async () => {
  let resolvePatch, patched = new Promise((r) => { resolvePatch = r; });
  let rendered = 0;
  const R = loadRoom({
    sync: {
      signIn: async () => ({ uid: 'u0' }), getUid: () => 'u0',
      subscribe: async () => {}, close: () => {},
      patch: () => patched,                    // 网络挂在那儿不返回
    },
  });
  R.init({ go() {}, render() { rendered++; }, view: () => ({ name: 'room' }) });
  R.state.active = true; R.state.code = '123456'; R.state.uid = 'u0';
  R.state.pid = 'p0'; R.state.room = mkRoom(4, 2);
  R.state.payTo = 'p0'; R.state.payFrom = 'p1';
  globalThis.document.getElementById = (id) => (id === 'payPoints' ? { value: '7' } : null);

  const before = RunfastSync.txList(R.state.room).length;
  window.Room.submitPay();                     // 不 await：网络还没回来
  assert.equal(RunfastSync.txList(R.state.room).length, before + 1, '这笔应该已经在流水里了');
  assert.ok(rendered > 0, '应该已经重绘过，用户马上看得到');
  resolvePatch();
  await patched;
});

// 发失败要撤回，不能让一笔根本没记上的分留在屏幕上骗人
test('记分：服务端拒了就撤回本地那笔并告诉用户', async () => {
  const R = loadRoom({
    sync: {
      signIn: async () => ({ uid: 'u0' }), getUid: () => 'u0',
      subscribe: async () => {}, close: () => {},
      patch: async () => { throw new Error('网络挂了'); },
    },
  });
  R.init({ go() {}, render() {}, view: () => ({ name: 'room' }) });
  R.state.active = true; R.state.code = '123456'; R.state.uid = 'u0';
  R.state.pid = 'p0'; R.state.room = mkRoom(4, 2);
  R.state.payTo = 'p0'; R.state.payFrom = 'p1';
  globalThis.document.getElementById = (id) => (id === 'payPoints' ? { value: '7' } : null);
  let alerted = '';
  globalThis.alert = (m) => { alerted = m; };

  const before = RunfastSync.txList(R.state.room).length;
  window.Room.submitPay();
  assert.equal(RunfastSync.txList(R.state.room).length, before + 1);
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(RunfastSync.txList(R.state.room).length, before, '失败后要撤回');
  assert.match(alerted, /没记上/);
});

// 待确认那笔不能写进 sync 的权威镜像，否则「服务端到底收下没有」就分不清了
test('记分：乐观那笔不污染服务端镜像；回声到了就换成权威那份', async () => {
  let sub = null;
  const R = loadRoom({
    sync: {
      signIn: async () => ({ uid: 'u0' }), getUid: () => 'u0',
      subscribe: async (c, cb) => { sub = cb; }, close: () => {},
      patch: async () => {},
    },
  });
  R.init({ go() {}, render() {}, view: () => ({ name: 'room' }) });
  await R.attach('123456', 'p0');
  const mirror = mkRoom(4, 2);
  sub.onRoom(mirror);
  R.state.payTo = 'p0'; R.state.payFrom = 'p1';
  globalThis.document.getElementById = (id) => (id === 'payPoints' ? { value: '7' } : null);

  window.Room.submitPay();
  assert.equal(Object.keys(mirror.tx).length, 2, 'sync 那份镜像不该被本地这笔改动');
  assert.equal(RunfastSync.txList(R.state.room).length, 3);

  // 服务端回声：同一个 id 出现在权威房间里
  const id = Object.keys(R.state.room.tx).find((k) => !mirror.tx[k]);
  const echoed = mkRoom(4, 2);
  echoed.tx[id] = { from: 'p1', to: 'p0', points: 7, byUid: 'u0', at: 1750000099999 };
  sub.onRoom(echoed);
  assert.equal(RunfastSync.txList(R.state.room).length, 3, '不能变成两笔');
  assert.equal(R.state.room.tx[id].at, 1750000099999, '应该换成服务端那份权威时间');
});

// 八个人同时记分就是一串背靠背广播，每帧都整页重绘的话主线程要连着做八次拆建
test('重绘：同一帧内的多次广播只重绘一次', async () => {
  let rendered = 0, frameCbs = [];
  // 两个都要有：room.js 只在 rAF 和 cancelAnimationFrame 都在时才走 rAF 那条路
  globalThis.requestAnimationFrame = (fn) => { frameCbs.push(fn); return frameCbs.length; };
  globalThis.cancelAnimationFrame = (id) => { frameCbs[id - 1] = () => {}; };
  let sub = null;
  const R = loadRoom({
    sync: { signIn: async () => ({ uid: 'u0' }), getUid: () => 'u0',
      subscribe: async (c, cb) => { sub = cb; }, close: () => {} },
  });
  R.init({ go() {}, render() { rendered++; }, view: () => ({ name: 'room' }) });
  await R.attach('123456', 'p0');
  for (let i = 0; i < 8; i++) sub.onRoom(mkRoom(8, 10 + i));
  assert.equal(rendered, 0, '还没到下一帧，不该重绘');
  frameCbs.forEach((fn) => fn());
  assert.equal(rendered, 1, '八次广播合并成一次重绘');
  delete globalThis.requestAnimationFrame; delete globalThis.cancelAnimationFrame;
});

// 打一晚上能记几百笔，全渲染每次广播都要拆建几千个节点；没人会往回翻那么多行
test('流水：默认只渲染最近若干局，DOM 不随打得久而膨胀', () => {
  const R = loadRoom({ sync: { signIn: async () => ({}), getUid: () => 'u0', subscribe: async () => {}, close: () => {} } });
  R.init({ go() {}, render() {}, view: () => ({ name: 'room' }) });
  R.state.active = true; R.state.local = false; R.state.code = '123456';
  R.state.pid = 'p0'; R.state.uid = 'u0'; R.state.status = 'connected';
  R.state.room = mkRoom(8, 600);

  const short = R.views.room();
  R.state.room = mkRoom(8, 30);
  const tiny = R.views.room();
  assert.ok(short.length < tiny.length * 3,
    `600 笔的页面不该比 30 笔的大出量级：${short.length} vs ${tiny.length}`);
  assert.match(short, /展开更早的 \d+ 局（共 600 笔）/);

  // 分数是按全部流水算的，跟渲染几局无关
  R.state.room = mkRoom(8, 600);
  const net = RunfastSync.txList(R.state.room).reduce((s, t) => s + t.points, 0);
  assert.equal(net, 1800, '600 笔 × 3 分，一分都不能少算');

  window.Room.showAllTx();
  assert.ok(R.views.room().length > short.length * 3, '展开后要真的全渲染出来');
});
