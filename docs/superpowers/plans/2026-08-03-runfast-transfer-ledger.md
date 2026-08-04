# 跑得快记分 · 转账流水改版 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把联机记分从「赢家先点 → 各人填剩几张 → 各自确认 → 房主提交」的回合协作草稿，改成「谁赢了点谁的头像，弹框输分数，一笔即入账」的转账流水，去掉房主特权与大厅，彻底消除多人同时操作的 403 报错和房主掉线卡死。

**Architecture:** 云端房间结构换成扁平 map（`players` / `tx`），key 由客户端生成唯一 id，每笔写入是一次独立 `PATCH /tx/<新id>`，服务器单线程逐个落盘，并发天然无冲突；流水只增不删。结算沿用现有 `sessionNet → settleUp` 管线，只是净额改成「rounds 净额 + transfers 净额」相加，历史旧场因此零迁移兼容。前端把 1277 行的 `src/app.js` 拆成三个各司其职的文件：`ui.js`（无状态展示工具）、`room.js`（联机房间的状态/视图/交互）、`app.js`（路由、首页、历史、结算、导入导出）。

**Tech Stack:** 零第三方依赖。前端为浏览器全局 IIFE 模块（`RunfastLogic` / `RunfastSync` / `RunfastUI` / `RunfastRoom` / `RunfastShare`），构建靠 `node build.js` 把 `src/` 内联成单文件 `dist/index.html`；后端是 Node 内置 `http` 模块（`server.js`），REST + SSE；测试用 `node --test`（`node:test` + `node:assert/strict`）。

## Global Constraints

- **零第三方依赖**：不许 `npm install` 任何东西，前后端都只用内置能力和仓库内已 vendored 的 `src/vendor/qrcode.js`。
- **注释与文案一律中文**，跟现有代码风格一致（解释「为什么」而不是复述代码）。
- **金额一律以「分」（整数）计算**，展示时用 `RunfastLogic.fenToYuan`。
- **分数（points）是正整数**，范围 1–9999；`points × pricePerCardFen = 金额（分）`。
- **玩家名字规则**：`/^[^'"<>\\]{1,8}$/`，1–8 字，不含引号尖括号反斜杠。
- **所有插入 HTML 的用户输入必须过 `esc()`**，视图是字符串拼接，漏一个就是 XSS。
- **流水只增不删**：没有任何删除单笔转账的入口，服务端也拒绝覆盖已存在的 `tx` key。
- **身份认设备 id，不认名字**：设备 id 是 `localStorage['runfast.device']`，玩家的 `uid` 只在创建那一刻写入，之后服务端一律拒绝修改。
- **每个任务结束前跑 `node --test` 必须全绿**，涉及前端的还要跑 `node build.js` 确认能内联成功。
- 提交信息用现有风格：`feat(范围): 中文描述` / `fix(范围): …` / `refactor(范围): …`。

---

## 文件结构

| 文件 | 职责 | 变化 |
|---|---|---|
| `src/logic.js` | 纯计算：分/元换算、净额、最少笔数转账、战绩文字 | 改：`sessionNet` 支持 transfers |
| `src/sync.js` | 设备身份、REST/SSE、房间纯函数 | 改：新房间模型的读写与纯函数 |
| `src/ui.js` | **新建**。无状态展示工具：转义、顶栏、底部面板、剪贴板、头像取色 | 新建（从 app.js 抽出 + 新增头像工具） |
| `src/room.js` | **新建**。联机/本地记分房间：状态、进房、头像行、流水、支出弹窗、结算与退出 | 新建 |
| `src/app.js` | 路由、首页、建场、历史、结算页、每局明细、导入导出 | 大幅瘦身，删掉 draft/record/lobby/seats 全部旧代码 |
| `src/style.css` | 样式 | 加头像行、流水、支出弹窗样式；删 `.numgrid` |
| `src/index.html` | 脚本清单 | 加 `ui.js` / `room.js` |
| `build.js` | 内联打包 | 文件清单加两个新文件 |
| `server.js` | 房间 REST/SSE + 权限 | 重写 `canPatch`、收窄 `canWrite`、删整套 presence |
| `test/logic.test.js` | 纯计算测试 | 加 transfers 用例，旧 rounds 用例全留 |
| `test/sync.test.js` | 前端纯函数测试 | 删 draft/observer 用例，加新模型用例 |
| `test/server.test.js` | 服务端权限与 REST 测试 | 删 draft/seats/presence 用例，加新权限用例 |

**加载顺序**（`index.html` 与 `build.js` 必须一致）：`logic.js` → `sync.js` → `ui.js` → `share-card.js` → `room.js` → `app.js`。`app.js` 在顶层就要引用 `RunfastRoom.views`，所以它必须最后加载。

---

### Task 1: logic.js — 净额支持转账流水

**Files:**
- Modify: `src/logic.js:44-55`（`sessionNet`）
- Test: `test/logic.test.js`

**Interfaces:**
- Consumes: 无（本任务是全链路的起点）
- Produces:
  - `RunfastLogic.sessionNet(session) -> Array<{name: string, cards: number, fen: number}>`，顺序同 `session.players`。现在同时吃 `session.rounds`（旧）和 `session.transfers`（新），两者净额相加。
  - `session.transfers` 的元素形状：`{ id: string, from: string, to: string, points: number, at: number }`，`from`/`to` 是**玩家名字**（快照，不是 pid）。
  - `RunfastLogic.settleUp` / `summaryText` / `roundTransfers` / `countedCards` / `fenToYuan` / `yuanToFen` 签名不变。

- [ ] **Step 1: 写失败的测试**

在 `test/logic.test.js` 末尾追加：

```js
test('sessionNet：转账流水的净额（from 减、to 加，顺序同 players）', () => {
  const s = {
    players: ['张三', '李四', '王五'],
    pricePerCardFen: 100,
    rounds: [],
    transfers: [
      { id: 't1', from: '李四', to: '张三', points: 4, at: 1 },
      { id: 't2', from: '王五', to: '张三', points: 20, at: 2 },
      { id: 't3', from: '张三', to: '李四', points: 2, at: 3 },
    ],
  };
  assert.deepEqual(L.sessionNet(s), [
    { name: '张三', cards: 22, fen: 2200 },
    { name: '李四', cards: -2, fen: -200 },
    { name: '王五', cards: -20, fen: -2000 },
  ]);
});

test('sessionNet：rounds 与 transfers 相加（旧场用新界面接着记）', () => {
  const s = {
    players: ['张三', '李四'],
    pricePerCardFen: 50,
    rounds: [{ id: 'r1', winner: '张三', losers: [{ name: '李四', cardsLeft: 3, shutout: false }] }],
    transfers: [{ id: 't1', from: '张三', to: '李四', points: 1, at: 1 }],
  };
  assert.deepEqual(L.sessionNet(s), [
    { name: '张三', cards: 2, fen: 100 },
    { name: '李四', cards: -2, fen: -100 },
  ]);
});

test('sessionNet：没有 transfers 字段的旧场行为不变', () => {
  const s = {
    players: ['张三', '李四'],
    pricePerCardFen: 100,
    rounds: [{ id: 'r1', winner: '张三', losers: [{ name: '李四', cardsLeft: 4, shutout: false }] }],
  };
  assert.deepEqual(L.sessionNet(s), [
    { name: '张三', cards: 4, fen: 400 },
    { name: '李四', cards: -4, fen: -400 },
  ]);
});

test('settleUp / summaryText 吃只有 transfers 的场', () => {
  const s = {
    createdAt: '2026-08-03T10:00:00.000Z',
    players: ['张三', '李四', '王五'],
    pricePerCardFen: 100,
    rounds: [],
    transfers: [
      { id: 't1', from: '李四', to: '张三', points: 5, at: 1 },
      { id: 't2', from: '王五', to: '张三', points: 3, at: 2 },
    ],
  };
  assert.deepEqual(L.settleUp(L.sessionNet(s)), [
    { from: '李四', to: '张三', fen: 500 },
    { from: '王五', to: '张三', fen: 300 },
  ]);
  const txt = L.summaryText(s);
  assert.ok(txt.includes('张三：+8 元'));
  assert.ok(txt.includes('李四 → 张三：5 元'));
});
```

- [ ] **Step 2: 跑测试确认它失败**

Run: `node --test test/logic.test.js`
Expected: FAIL —— 前三个新用例里带 transfers 的会得到不含转账贡献的结果（张三 cards 为 0），最后一个 `settleUp` 返回空数组。

- [ ] **Step 3: 改 `sessionNet`**

把 `src/logic.js` 第 43–55 行整段替换为：

```js
  // 转账流水对净额的贡献：一笔 = from 减 points 分、to 加 points 分。
  // 返回 {名字: 净分}，只含流水里出现过的人。
  function transferNet(session) {
    const out = Object.create(null);
    (session.transfers || []).forEach((t) => {
      out[t.from] = (out[t.from] || 0) - t.points;
      out[t.to] = (out[t.to] || 0) + t.points;
    });
    return out;
  }

  // 整场累计净额。同时吃「按局记」的 rounds 和「按笔记」的 transfers，两者相加——
  // 历史旧场只有 rounds、新场只有 transfers，没打完的旧场两边都有，因而不需要数据迁移。
  // 包含 session.players 中所有人（未参与者为 0），顺序同 players。
  function sessionNet(session) {
    const net = Object.create(null);
    const entry = (n) => (net[n] ||= { name: n, cards: 0, fen: 0 });
    session.players.forEach(entry);
    (session.rounds || []).forEach((round) => {
      roundTransfers(round, session.pricePerCardFen).forEach((t) => {
        entry(t.from).cards -= t.cards; entry(t.from).fen -= t.fen;
        entry(t.to).cards += t.cards;   entry(t.to).fen += t.fen;
      });
    });
    const tn = transferNet(session);
    Object.keys(tn).forEach((n) => {
      const e = entry(n);
      e.cards += tn[n];
      e.fen += tn[n] * session.pricePerCardFen;
    });
    return session.players.map((n) => net[n]);
  }
```

把导出那行（原 98 行）改成：

```js
  const api = { HAND_SIZE, yuanToFen, fenToYuan, countedCards, roundTransfers, transferNet, sessionNet, settleUp, summaryText };
```

- [ ] **Step 4: 跑测试确认全绿**

Run: `node --test`
Expected: PASS，包括原有全部 rounds 用例。

- [ ] **Step 5: 提交**

```bash
git add src/logic.js test/logic.test.js
git commit -m "feat(logic): 净额支持转账流水，与旧的按局记分相加"
```

---

### Task 2: server.js — 权限重写与 presence 移除

**Files:**
- Modify: `server.js:110-155`（`canWrite` / `canPatch`）、`server.js:163-191`（presence）、`server.js:277-296`（SSE 分支）、`server.js:369`（导出）
- Test: `test/server.test.js`

**Interfaces:**
- Consumes: 无
- Produces:
  - `canWrite(old, neu, me) -> boolean`：只有「房间不存在且 `neu.creatorUid === me`」为 true，其余一律 false（房间存在后禁止整房覆盖）。
  - `canPatch(old, path, value, me) -> boolean`：见下表。
  - `isValidTx(value, players) -> boolean`：导出供测试。
  - 服务器不再发 `event: presence`，`/rooms/<code>/events` 不再读 `?dev=` 查询参数。`GET /status` 的 `clients` 字段仍来自 `clientCount()`，不受影响。

| path | 规则 |
|---|---|
| `/tx/<新id>` | 任何带 `X-Device-Id` 的请求可写，且 value 通过 `isValidTx`；id 已存在 → 拒 |
| `/players/<新id>` | id 不存在时可建，`value.name` 是字符串且 `value.uid` 是 `me` 或 `null`/缺省 |
| `/players/<id>/name` | 该玩家 `uid === me`（自己的）或 `uid == null`（代记的人） |
| `/players/<id>/left`、`/players/<id>/leftAt` | 仅 `uid === me` |
| `/players/<id>/uid` | 一律拒 |
| `/status` | value 必须是 `'active'` 或 `'finished'` |
| `/finishedAt` | 任何人可写 |
| 其他 | 拒 |

- [ ] **Step 1: 写失败的测试**

先删掉 `test/server.test.js` 里三个基于旧模型的用例：`canWrite：房主全权；他人受 allowEdit 限制…`、`setPath：按路径深设…`（保留但改样例，见下）、`canPatch：座位 CAS 与草稿分格…`、`REST PATCH：抢座 CAS…`、`presence：带 dev 的连接会进在线名单…`。再把文件顶部的 `sampleRoom` 与 `canPatch` 导入行改成新模型：

```js
const { createRunfastServer, canWrite, injectHostFlag, setPath, canPatch, isValidTx } = require('../server.js');
```

```js
const sampleRoom = () => ({
  creatorUid: 'boss', sid: 's1', createdAt: '2026-08-03T10:00:00.000Z',
  pricePerCardFen: 100, status: 'active',
  players: { p_a: { name: 'A', uid: 'boss', at: 1 }, p_b: { name: 'B', uid: 'x', at: 2 },
             p_c: { name: 'C', uid: null, at: 3 } },
  tx: { t_1: { from: 'p_b', to: 'p_a', points: 5, byUid: 'x', at: 10 } },
});
```

追加新用例：

```js
test('canWrite：只允许建房，房间已存在则禁止整房覆盖', () => {
  assert.ok(canWrite(null, { creatorUid: 'me' }, 'me'));
  assert.ok(!canWrite(null, { creatorUid: 'other' }, 'me'));
  assert.ok(!canWrite(null, { creatorUid: 'me' }, undefined));
  assert.ok(!canWrite(sampleRoom(), { creatorUid: 'boss' }, 'boss')); // 房主也不能整房覆盖
});

test('isValidTx：from/to 必须是房内玩家、不能自转、分数是 1~9999 的整数', () => {
  const ps = sampleRoom().players;
  assert.ok(isValidTx({ from: 'p_b', to: 'p_a', points: 20 }, ps));
  assert.ok(!isValidTx({ from: 'p_b', to: 'p_zz', points: 20 }, ps));  // 收款人不存在
  assert.ok(!isValidTx({ from: 'p_a', to: 'p_a', points: 20 }, ps));   // 自转
  assert.ok(!isValidTx({ from: 'p_b', to: 'p_a', points: 0 }, ps));
  assert.ok(!isValidTx({ from: 'p_b', to: 'p_a', points: -3 }, ps));
  assert.ok(!isValidTx({ from: 'p_b', to: 'p_a', points: 2.5 }, ps));
  assert.ok(!isValidTx({ from: 'p_b', to: 'p_a', points: 10000 }, ps));
  assert.ok(!isValidTx(null, ps));
});

test('canPatch：流水只增不删，任何设备都能记新的一笔', () => {
  const r = sampleRoom();
  const tx = { from: 'p_b', to: 'p_a', points: 8, byUid: 'x', at: 20 };
  assert.ok(canPatch(r, '/tx/t_2', tx, 'x'));        // 牌友
  assert.ok(canPatch(r, '/tx/t_3', tx, 'boss'));     // 建房人
  assert.ok(canPatch(r, '/tx/t_4', tx, 'anyone'));   // 没座位概念，谁都能记
  assert.ok(!canPatch(r, '/tx/t_1', tx, 'x'));       // 已存在的 id → 拒（只增不删）
  assert.ok(!canPatch(r, '/tx/t_2', { from: 'p_b', to: 'p_a', points: 0 }, 'x')); // 分数非法
  assert.ok(!canPatch(r, '/tx/t_2', tx, undefined)); // 没设备 id
});

test('canPatch：建玩家可以，但不能冒充别的设备', () => {
  const r = sampleRoom();
  assert.ok(canPatch(r, '/players/p_new', { name: '丁', uid: 'x', at: 9 }, 'x'));
  assert.ok(canPatch(r, '/players/p_new', { name: '没手机的', uid: null, at: 9 }, 'x'));
  assert.ok(!canPatch(r, '/players/p_new', { name: '丁', uid: 'boss', at: 9 }, 'x')); // 冒充
  assert.ok(!canPatch(r, '/players/p_a', { name: '丁', uid: 'x', at: 9 }, 'x'));      // id 已存在
  assert.ok(!canPatch(r, '/players/p_new', { uid: 'x' }, 'x'));                        // 没名字
});

test('canPatch：改名限自己的和代记的；left 只能自己置自己清；uid 永不可改', () => {
  const r = sampleRoom();
  assert.ok(canPatch(r, '/players/p_b/name', '小B', 'x'));      // 自己的
  assert.ok(canPatch(r, '/players/p_c/name', '小C', 'x'));      // uid=null 的代记玩家
  assert.ok(!canPatch(r, '/players/p_a/name', '坏人', 'x'));    // 别人的
  assert.ok(canPatch(r, '/players/p_b/left', true, 'x'));
  assert.ok(canPatch(r, '/players/p_b/left', null, 'x'));
  assert.ok(canPatch(r, '/players/p_b/leftAt', 123, 'x'));
  assert.ok(!canPatch(r, '/players/p_b/left', true, 'boss'));   // 建房人也不能替别人退
  assert.ok(!canPatch(r, '/players/p_c/left', true, 'x'));      // 代记玩家没设备，不能退
  assert.ok(!canPatch(r, '/players/p_b/uid', 'y', 'y'));        // 抢身份
  assert.ok(!canPatch(r, '/players/p_b/uid', 'x', 'x'));        // 自己也不能改
});

test('canPatch：结束本场全开放，其他路径一律拒', () => {
  const r = sampleRoom();
  assert.ok(canPatch(r, '/status', 'finished', 'anyone'));
  assert.ok(canPatch(r, '/finishedAt', '2026-08-03T12:00:00.000Z', 'anyone'));
  assert.ok(!canPatch(r, '/status', 'whatever', 'anyone'));
  assert.ok(!canPatch(r, '/creatorUid', 'me', 'x'));
  assert.ok(!canPatch(r, '/pricePerCardFen', 999, 'x'));
  assert.ok(!canPatch(r, '/', {}, 'x'));
  assert.ok(!canPatch(null, '/tx/t_9', {}, 'x'));               // 房间不存在
});

test('REST PATCH：三台设备同时记分，三笔全部入账互不覆盖', async () => {
  const df = tmpData();
  const server = createRunfastServer({ dataFile: df });
  const port = await listen(server);
  try {
    await req(port, 'PUT', '/rooms/300400', sampleRoom(), { 'X-Device-Id': 'boss' });
    const tx = (from) => ({ from, to: 'p_a', points: 3, byUid: 'd', at: 1 });
    const rs = await Promise.all([
      req(port, 'PATCH', '/rooms/300400', { path: '/tx/t_x1', value: tx('p_b') }, { 'X-Device-Id': 'd1' }),
      req(port, 'PATCH', '/rooms/300400', { path: '/tx/t_x2', value: tx('p_c') }, { 'X-Device-Id': 'd2' }),
      req(port, 'PATCH', '/rooms/300400', { path: '/tx/t_x3', value: tx('p_b') }, { 'X-Device-Id': 'd3' }),
    ]);
    rs.forEach((r) => assert.equal(r.status, 200));
    const room = JSON.parse((await req(port, 'GET', '/rooms/300400')).body);
    assert.equal(Object.keys(room.tx).length, 4);  // 原有 1 笔 + 新 3 笔
    // 重复 id 被拒，且不覆盖原值
    const dup = await req(port, 'PATCH', '/rooms/300400',
      { path: '/tx/t_x1', value: tx('p_c') }, { 'X-Device-Id': 'd9' });
    assert.equal(dup.status, 403);
    const after = JSON.parse((await req(port, 'GET', '/rooms/300400')).body);
    assert.equal(after.tx.t_x1.from, 'p_b');
  } finally { server.close(); fs.rmSync(df, { force: true }); }
});
```

同时把原有的 `setPath` 用例改成新模型样例（保留这个测试，只换数据）：

```js
test('setPath：按路径深设，返回新对象不改原对象', () => {
  const r = { players: { p_a: { name: 'A', uid: 'd1' } }, tx: {} };
  assert.equal(setPath(r, '/tx/t_1', { points: 5 }).tx.t_1.points, 5);
  assert.equal(setPath(r, '/players/p_a/name', 'AA').players.p_a.name, 'AA');
  assert.ok(!('uid' in setPath(r, '/players/p_a/uid', null).players.p_a));
  assert.deepEqual(setPath(r, '/', { x: 1 }), { x: 1 });
  assert.deepEqual(r.tx, {});  // 不改原对象
});
```

- [ ] **Step 2: 跑测试确认它失败**

Run: `node --test test/server.test.js`
Expected: FAIL —— `isValidTx is not a function`，以及旧 `canPatch` 对 `/tx/...` 返回 false（因为它只认 `/seats` `/draft`，其余走 `isCreator` 分支）。

- [ ] **Step 3: 重写权限函数**

把 `server.js` 第 110–117 行的 `canWrite` 替换为：

```js
// ---------- 权限校验（服务器强制）----------
// 建房走 PUT，此后一切增量走 PATCH——房间已存在时禁止整房覆盖，避免有人拿旧快照盖掉别人刚记的分。
function canWrite(old, neu, me) {
  if (!me) return false;
  if (old) return false;
  return !!neu && neu.creatorUid === me;
}
```

把第 135–155 行的 `canPatch` 整段替换为：

```js
// 一笔转账是否合法：双方都得是房内玩家、不能自己转自己、分数是正整数。
function isValidTx(v, players) {
  if (!v || typeof v !== 'object') return false;
  const has = (k) => typeof k === 'string' && Object.prototype.hasOwnProperty.call(players, k);
  return has(v.from) && has(v.to) && v.from !== v.to
    && Number.isInteger(v.points) && v.points > 0 && v.points <= 9999;
}

// 字段级写权限（服务器强制）。me = X-Device-Id。
// 房间模型是扁平 map：players/tx 的 key 由客户端生成，谁都能往自己的新 key 上写，
// 因此不存在「同一格互相覆盖」的并发冲突，也就没有房主特权可言。
function canPatch(old, path, value, me) {
  if (!me || !old || typeof path !== 'string') return false;
  const players = (old.players && typeof old.players === 'object') ? old.players : {};

  // 记一笔转账：只收没用过的 id。已存在的 id 一律拒 → 流水只增不删、不可篡改。
  let m = path.match(/^\/tx\/([A-Za-z0-9_-]{1,64})$/);
  if (m) {
    if (Object.prototype.hasOwnProperty.call(old.tx || {}, m[1])) return false;
    return isValidTx(value, players);
  }

  // 建玩家：只收没用过的 id；uid 只能填自己或 null（代记没带手机的人）。
  m = path.match(/^\/players\/([A-Za-z0-9_-]{1,64})$/);
  if (m) {
    if (Object.prototype.hasOwnProperty.call(players, m[1])) return false;
    return !!value && typeof value === 'object' && typeof value.name === 'string'
      && (value.uid === me || value.uid === null || value.uid === undefined);
  }

  // 改玩家字段
  m = path.match(/^\/players\/([A-Za-z0-9_-]{1,64})\/(name|left|leftAt)$/);
  if (m) {
    const p = players[m[1]];
    if (!p) return false;
    if (m[2] === 'name') return p.uid === me || p.uid == null;  // 自己的，或没设备的代记玩家
    return p.uid === me;                                        // 退出/回归只能自己来
  }

  // uid 在建玩家那一刻定死，之后谁都不能改 —— 身份没法被抢。
  if (/^\/players\/[^/]+\/uid$/.test(path)) return false;

  if (path === '/status') return value === 'active' || value === 'finished';
  if (path === '/finishedAt') return true;                      // 结束本场全开放
  return false;
}
```

- [ ] **Step 4: 删掉整套 presence**

`server.js` 里删除第 164–191 行的 `presenceDevices` / `sendPresence` / `broadcastPresence` / `addPresence` / `removePresence`，以及第 164 行的 `const presence = new Map(); // code -> Map<deviceId, refCount>`。

再把 SSE 分支（原 277–296 行）改成：

```js
      if (isEvents && req.method === 'GET') {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        });
        sendFrame(res, rooms[code] || null);              // 首帧全量
        let set = subscribers.get(code);
        if (!set) { set = new Set(); subscribers.set(code, set); }
        set.add(res);
        const hb = setInterval(() => res.write(':keep-alive\n\n'), 30000);
        req.on('close', () => {
          clearInterval(hb); set.delete(res); if (!set.size) subscribers.delete(code);
        });
        return;
      }
```

最后把导出行（原 369 行）改成：

```js
module.exports = { createRunfastServer, canWrite, canPatch, isValidTx, setPath, lanIP, lanURL, reqBaseURL, qrSvg, injectHostFlag };
```

- [ ] **Step 5: 跑测试确认全绿**

Run: `node --test`
Expected: PASS。若 `test/server.test.js` 里还有引用 `presence` 或 `allowEdit` 的残留用例，一并删掉。

- [ ] **Step 6: 提交**

```bash
git add server.js test/server.test.js
git commit -m "feat(server): 权限改为按 map key 写入的转账流水模型，流水只增不删；移除观战 presence"
```

---

### Task 3: sync.js — 新房间模型的读写与纯函数

**Files:**
- Modify: `src/sync.js`（整体调整）
- Test: `test/sync.test.js`

**Interfaces:**
- Consumes: Task 2 的服务端路径契约
- Produces（`RunfastSync` 新增/变更）：
  - `newKey(prefix: string) -> string`：`prefix + 36 进制时间 + 6 位随机`，供 `p_` / `t_` 生成不冲突的 key。
  - `findMyPid(room, uid) -> string | null`：按设备 id 找回自己那条玩家记录的 pid。
  - `playingCount(room) -> number`：未退出的玩家数。
  - `nameTaken(room, name, exceptPid) -> boolean`：房内是否已有别人叫这个名字。
  - `txList(room) -> Array<{id, from, to, points, byUid, at}>`：按 `at` 升序。
  - `normalizeRoom(room)`：补 `players` / `tx` 空对象。
  - `createRoom({ name, pricePerCardFen }) -> Promise<{ code: string, pid: string }>`。
  - 保留不变：`configured` / `genRoomCode` / `validRoomCode` / `applyEvent` / `signIn` / `getUid` / `readRoom` / `writeRoom` / `patch` / `subscribe` / `deleteRoom` / `close`。
  - `subscribe(code, { onRoom, onStatus, onDeleted })` —— **`onPresence` 回调取消**。
- 删除：`canEdit` / `canAdmin` / `isDraftSaveable` / `draftToRound` / `observerCount` / `mutate`。

- [ ] **Step 1: 写失败的测试**

删掉 `test/sync.test.js` 里的 `canEdit / canAdmin 权限判定`、`isDraftSaveable / draftToRound…`、`observerCount / playingCount…`、`normalizeRoom：RTDB 丢掉的空数组字段被补回` 四个用例，追加：

```js
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
```

`applyEvent：子路径定点更新不改原对象` 那个用例把样例换成新模型：

```js
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
```

- [ ] **Step 2: 跑测试确认它失败**

Run: `node --test test/sync.test.js`
Expected: FAIL —— `S.newKey is not a function` 等。

- [ ] **Step 3: 改 sync.js**

把 `src/sync.js` 第 16–18 行的 `validRoomCode` / `canEdit` / `canAdmin` 三行改为只留：

```js
  const validRoomCode = (s) => typeof s === 'string' && /^[0-9]{6}$/.test(s);
```

把第 33–66 行（`normalizeRoom` 到 `playingCount`）整段替换为：

```js
  // 兜底：把可能缺失的 map 字段补回（幂等，无害）
  function normalizeRoom(room) {
    if (room) { room.players ||= {}; room.tx ||= {}; }
    return room;
  }

  // ---------- 房间纯函数 ----------
  // 唯一 key：并发写落在不同 key 上，服务器逐个落盘就不会互相覆盖。
  function newKey(prefix) {
    return prefix + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  // 按设备 id 找回自己那条玩家记录 —— 回归房间认的是设备，不是名字。
  function findMyPid(room, uid) {
    if (!room || !room.players || !uid) return null;
    return Object.keys(room.players).find((pid) => room.players[pid].uid === uid) || null;
  }

  // 在玩的人数（已退出的不算）
  function playingCount(room) {
    const ps = (room && room.players) || {};
    return Object.keys(ps).filter((pid) => !ps[pid].left).length;
  }

  // 名字是否被别人占了。流水按名字展示，重名就认不出谁是谁，所以进房和改名都要挡。
  function nameTaken(room, name, exceptPid) {
    const ps = (room && room.players) || {};
    return Object.keys(ps).some((pid) => pid !== exceptPid && ps[pid].name === name);
  }

  // 流水 map → 按时间升序的数组
  function txList(room) {
    const tx = (room && room.tx) || {};
    return Object.keys(tx)
      .map((id) => Object.assign({ id }, tx[id]))
      .sort((a, b) => (a.at || 0) - (b.at || 0));
  }
```

把 `createRoom`（原 124–143 行）替换为：

```js
  // 建房：房号试 5 次，建房人自己就是第一个玩家。
  async function createRoom(init) {
    await signIn();
    for (let i = 0; i < 5; i++) {
      const code = genRoomCode();
      const { data } = await readRoom(code);
      if (data !== null) continue; // 房号被占用，换一个
      const pid = newKey('p_');
      await writeRoom(code, {
        creatorUid: deviceId,
        sid: 's' + Date.now(),
        createdAt: new Date().toISOString(),
        pricePerCardFen: init.pricePerCardFen,
        status: 'active',
        players: { [pid]: { name: init.name, uid: deviceId, at: Date.now() } },
        tx: {},
      });
      return { code, pid };
    }
    throw new Error('建房失败，请重试');
  }
```

删掉 `mutate`（原 115–122 行）。

SSE 部分：`openStream` 里去掉 `?dev=` 与 presence 监听，`onPresence` 函数整个删掉：

```js
    es = new EventSource(roomUrl(currentCode) + '/events');
    es.addEventListener('put', onEvt);
```

最后导出行改成：

```js
  const api = { configured, genRoomCode, validRoomCode,
    newKey, findMyPid, playingCount, nameTaken, txList,
    applyEvent, normalizeRoom, signIn, getUid, createRoom, readRoom, subscribe, patch, writeRoom, deleteRoom, close };
```

- [ ] **Step 4: 跑测试确认全绿**

Run: `node --test test/sync.test.js`
Expected: PASS。

> `node --test` 整体此时会因为 `src/app.js` 还在用 `RunfastSync.canEdit` 而在**浏览器里**报错，但 Node 测试不加载 app.js，所以测试是绿的。Task 8 会补上前端接线。

- [ ] **Step 5: 提交**

```bash
git add src/sync.js test/sync.test.js
git commit -m "refactor(sync): 房间模型换成 players/tx 扁平 map，身份按设备 id 找回"
```

---

### Task 4: ui.js — 抽出共享展示工具

**Files:**
- Create: `src/ui.js`
- Modify: `src/app.js`（删掉被搬走的 `esc` / `topbar` / `openSheet` / `closeSheet` / `copyToClipboard`，改用 `RunfastUI`）
- Modify: `src/index.html`、`build.js`（加入 `ui.js`）
- Test: `test/ui.test.js`（新建）

**Interfaces:**
- Consumes: 无
- Produces（`RunfastUI`）：
  - `esc(s) -> string`：HTML 转义 `& < > " '`
  - `topbar(title, backJs, actionsHtml) -> string`
  - `openSheet(items: Array<{label, onclick, danger?}>, headerHtml?: string) -> void`
  - `closeSheet() -> void`
  - `copyToClipboard(text) -> Promise<boolean>`
  - `avatarColor(name) -> string`：名字 → 稳定的十六进制底色
  - `initial(name) -> string`：名字第一个字符（按码点取，emoji 不会被劈开）
  - `validName(name) -> boolean`：`/^[^'"<>\\]{1,8}$/`

- [ ] **Step 1: 写失败的测试**

新建 `test/ui.test.js`：

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const U = require('../src/ui.js');

test('esc：转义会撑破属性和标签的字符', () => {
  assert.equal(U.esc('<b>&"\'</b>'), '&lt;b&gt;&amp;&quot;&#39;&lt;/b&gt;');
  assert.equal(U.esc(123), '123');
});

test('validName：1~8 字且不含引号尖括号反斜杠', () => {
  assert.ok(U.validName('张三'));
  assert.ok(U.validName('12345678'));
  assert.ok(!U.validName(''));
  assert.ok(!U.validName('123456789'));
  assert.ok(!U.validName('a"b'));
  assert.ok(!U.validName("a'b"));
  assert.ok(!U.validName('a<b'));
  assert.ok(!U.validName('a\\b'));
});

test('avatarColor：同名同色、结果是合法十六进制色', () => {
  assert.equal(U.avatarColor('张三'), U.avatarColor('张三'));
  assert.match(U.avatarColor('张三'), /^#[0-9a-f]{6}$/);
  assert.match(U.avatarColor(''), /^#[0-9a-f]{6}$/);
});

test('initial：取第一个字符，emoji 不被劈成半个', () => {
  assert.equal(U.initial('张三'), '张');
  assert.equal(U.initial('Hua'), 'H');
  assert.equal(U.initial('🌹小丽'), '🌹');
  assert.equal(U.initial(''), '?');
});
```

- [ ] **Step 2: 跑测试确认它失败**

Run: `node --test test/ui.test.js`
Expected: FAIL —— `Cannot find module '../src/ui.js'`。

- [ ] **Step 3: 新建 `src/ui.js`**

```js
// 与业务无关的展示工具：转义、顶栏、底部弹出面板、剪贴板、头像取色。
// 浏览器：全局 RunfastUI；Node：module.exports（供测试）。
var RunfastUI = (function () {
  'use strict';

  const esc = (s) => String(s).replace(/[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const validName = (s) => /^[^'"<>\\]{1,8}$/.test(s);

  // 没有真实头像，用名字首字 + 一个稳定色块代替。
  // 同一个名字在每台设备上算出同一个颜色，牌友之间看到的头像才是一致的。
  const AVATAR_BG = ['#1b6b3a', '#b45309', '#1d4ed8', '#7c3aed', '#be123c', '#0f766e', '#a16207', '#4338ca'];
  function avatarColor(name) {
    let h = 0;
    const s = String(name);
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
    return AVATAR_BG[h % AVATAR_BG.length];
  }
  // 按码点取首字，否则 emoji 名字会被劈成半个字符渲染成乱码
  const initial = (name) => Array.from(String(name))[0] || '?';

  const topbar = (title, backJs, actionsHtml) =>
    `<div class="topbar${actionsHtml ? ' has-actions' : ''}">${backJs ? `<button class="back" onclick="${backJs}">‹ 返回</button>` : ''}<div class="title">${title}</div>${actionsHtml ? `<span class="actions">${actionsHtml}</span>` : ''}</div>`;

  // 底部弹出面板。挂在 body 上而不是 #app 里，这样房间广播频繁重绘 #app 时面板不会被抖掉。
  function closeSheet() { const el = document.getElementById('sheet'); if (el) el.remove(); }
  function openSheet(items, headerHtml) {
    closeSheet();
    const el = document.createElement('div');
    el.id = 'sheet';
    el.className = 'sheet-mask';
    el.innerHTML = `<div class="sheet">
      ${headerHtml || ''}
      ${items.map((it) => `<button class="sheet-item${it.danger ? ' danger' : ''}" onclick="${it.onclick}">${esc(it.label)}</button>`).join('')}
      <button class="sheet-item cancel">取消</button>
    </div>`;
    // 按钮的内联 onclick 先在目标上执行，这个委托监听随后关闭面板
    el.addEventListener('click', (ev) => {
      if (ev.target === el || ev.target.classList.contains('sheet-item')) closeSheet();
    });
    document.body.appendChild(el);
  }

  async function copyToClipboard(text) {
    try { await navigator.clipboard.writeText(text); return true; }
    catch (e) {
      const ta = document.createElement('textarea');
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      return ok;
    }
  }

  const api = { esc, validName, avatarColor, initial, topbar, openSheet, closeSheet, copyToClipboard };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  return api;
})();
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test test/ui.test.js`
Expected: PASS。

- [ ] **Step 5: 接进构建**

`src/index.html` 的脚本清单改成（顺序即加载顺序）：

```html
<script src="logic.js"></script>
<script src="sync.js"></script>
<script src="ui.js"></script>
<script src="share-card.js"></script>
<script src="room.js"></script>
<script src="app.js"></script>
```

`build.js` 第 9 行的文件清单改成：

```js
for (const js of ['logic.js', 'sync.js', 'ui.js', 'share-card.js', 'room.js', 'app.js']) {
```

新建一个占位的 `src/room.js`，让这一步的构建能通过（Task 5 会写真正的内容）：

```js
// 联机/本地记分房间：状态、进房、头像行、流水、支出弹窗、结算与退出。
var RunfastRoom = (function () {
  'use strict';
  return {};
})();
```

- [ ] **Step 6: 确认构建通过**

Run: `node build.js`
Expected: 打印「已生成 dist/index.html（… KB）」，不抛「仍有未内联的外部引用」。

- [ ] **Step 7: 提交**

```bash
git add src/ui.js src/room.js src/index.html build.js test/ui.test.js
git commit -m "refactor(ui): 抽出无状态展示工具模块，新增头像取色与首字"
```

---

### Task 5: room.js — 房间状态、进房、身份与退出

**Files:**
- Modify: `src/room.js`（替换 Task 4 的占位内容）

**Interfaces:**
- Consumes: `RunfastSync.{signIn,getUid,readRoom,patch,subscribe,close,createRoom,findMyPid,nameTaken,newKey,txList,playingCount}`、`RunfastUI.{esc,validName,openSheet}`、`RunfastLogic.{fenToYuan,sessionNet}`
- Produces（`RunfastRoom`）：
  - `init(host)`：`host = { go(view), render(), view(), directory(), onFinished(session), saveName(name) }`
    - `go(view)` / `render()`：app.js 的路由与重绘
    - `view()`：返回 app.js 当前的 view 对象（读路由参数）
    - `directory()`：返回 `db.playerDirectory`（名字快选）
    - `onFinished(session)`：房间结束时把快照交给 app.js 存历史并跳结算页
    - `saveName(name)`：把名字记进 `db.playerDirectory` 与 `localStorage['runfast.lastName']`
    - `saveLocal()`：本地单机改动后落盘并重绘（Task 6 才用到）
  - `preview(code) -> Promise<void>`：读房间 → 跳「输名字/确认」页；房间不存在时提示并跳「加入联机场」
  - `views.joinName() -> string`：输名字/确认页 HTML
  - `views.room() -> string`：记分主页 HTML（Task 6 实现）
  - `startLocal(session)`：以本地单机模式进入记分页
  - `snapshot() -> session`：把当前房间/本地场快照成结算用的 session
  - `state`：`{ active, local, code, room, session, uid, pid, status }`
  - `window.Room`：全部 onclick 交互
  - `lastName() -> string`：读 `localStorage['runfast.lastName']`

- [ ] **Step 1: 写 room.js 的状态与进房骨架**

把 `src/room.js` 全文替换为：

```js
// 联机/本地记分房间：状态、进房、头像行、流水、支出弹窗、结算与退出。
// 联机时 state.room 是云端房间（players/tx 都是 map）；本地单机时 state.local=true，
// 用 state.session（db 里那条本地场）现搭一个同形状的房间，两边共用同一套视图与交互。
var RunfastRoom = (function () {
  'use strict';
  const S = RunfastSync, U = RunfastUI, L = RunfastLogic;
  const esc = U.esc;

  // 宿主接线：app.js 启动时注入路由、名录、结束回调
  let host = {
    go() {}, render() {}, view() { return {}; },
    directory() { return []; }, onFinished() {}, saveName() {},
  };
  function init(h) { host = Object.assign(host, h); }

  const state = { active: false, local: false, code: null, room: null, session: null,
    uid: null, pid: null, status: 'idle', payFrom: null, payTo: null };

  const LAST_NAME_KEY = 'runfast.lastName';
  const ROOM_KEY = 'runfast.sync.room';
  function lastName() { try { return localStorage.getItem(LAST_NAME_KEY) || ''; } catch (e) { return ''; } }

  // ---------- 进房 ----------
  // 先只读一次房间，决定进「新加入」还是「回到原位置」，真正订阅放到用户确认之后。
  async function preview(code) {
    try {
      await S.signIn();
      state.uid = S.getUid();
      const { data } = await S.readRoom(code);
      if (data === null) {
        let saved = null;
        try { saved = JSON.parse(localStorage.getItem(ROOM_KEY) || 'null'); } catch (e) { /* 忽略 */ }
        if (saved && saved.code === code) localStorage.removeItem(ROOM_KEY);
        alert('房间 ' + code + ' 暂时进不去，可能房主还没建好或已关闭。已帮你填好房号，稍后点「进入房间」重试即可。');
        host.go({ name: 'joinRoom', code });
        return;
      }
      const pid = S.findMyPid(data, state.uid);
      state.room = data;
      // 字段叫 myName 不叫 name —— 路由对象上的 name 是视图名（'joinName'），撞了会把视图名渲染进输入框
      host.go({ name: 'joinName', code, pid, myName: pid ? data.players[pid].name : lastName() });
    } catch (e) { alert('进入房间失败：' + e.message); }
  }

  // ---------- 输名字 / 确认回归 ----------
  function joinView() {
    const v = host.view();
    const back = !!v.pid;   // 本机在这房间有过身份 → 这页是「确认回来」而不是「新加入」
    const dir = host.directory();
    return `
      ${U.topbar((back ? '回到房间 ' : '加入房间 ') + esc(v.code), 'App.goHome()')}
      <div class="card">
        ${back ? `<div class="muted" style="margin-bottom:10px">你之前是「${esc(v.myName)}」，改个名也行，位置和分数不变。</div>` : ''}
        <div class="section-title">你的名字</div>
        <input type="text" id="myName" maxlength="8" placeholder="输入你的名字（8 字以内）" value="${esc(v.myName || '')}">
        ${dir.length ? `<div class="chips" style="margin-top:10px">${dir.map((n) =>
          `<button class="chip" onclick="Room.fillName('${esc(n)}')">${esc(n)}</button>`).join('')}</div>` : ''}
      </div>
      <button class="btn btn-primary" onclick="Room.confirmJoin()">${back ? '回到房间' : '进入房间'}</button>`;
  }

  // ---------- 订阅并进入记分页 ----------
  async function attach(code, pid) {
    await S.signIn();
    state.uid = S.getUid();          // 建房那条路没走过 preview()，这里补上设备 id
    state.active = true; state.local = false;
    state.code = code; state.pid = pid; state.status = 'connecting';
    try { localStorage.setItem(ROOM_KEY, JSON.stringify({ code })); } catch (e) { /* 忽略 */ }
    await S.subscribe(code, {
      onRoom(room) {
        state.room = room;
        if (room.status === 'finished') { finishLocally(); return; }
        if (['room', 'rounds', 'settle'].includes(host.view().name)) host.render();
        else host.go({ name: 'room' });
      },
      onStatus(st) {
        state.status = st;
        if (host.view().name === 'room') host.render();
      },
      onDeleted() {
        const mine = state.room && state.room.creatorUid === state.uid;
        close();
        if (!mine) alert('房间已被关闭');
        host.go({ name: 'home' });
      },
    });
    host.go({ name: 'room' });
  }

  // 结束本场：各端把快照存进自己手机的历史，然后断开连接跳结算页
  function finishLocally() {
    const snap = snapshot();
    close();
    host.onFinished(snap);
  }

  // 断开并清空内存态（不动 localStorage）
  function resetState() {
    S.close();
    state.active = false; state.local = false; state.code = null;
    state.room = null; state.session = null; state.pid = null; state.status = 'idle';
    state.payFrom = null; state.payTo = null;
  }
  // 主动退出 / 房间被关：额外忘掉「回到联机房间」入口，首页就不再显示它
  function close() {
    resetState();
    try { localStorage.removeItem(ROOM_KEY); } catch (e) { /* 忽略 */ }
  }

  const api = { init, preview, attach, close, lastName, state,
    views: { joinName: joinView } };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  return api;
})();
```

- [ ] **Step 2: 在 IIFE 内加入 `window.Room` 的进房交互**

在 `const api = {...}` 之前插入：

```js
  // ---------- 交互（视图里的 onclick 走这里）----------
  const Room = {
    fillName(n) {
      const el = document.getElementById('myName');
      if (el) el.value = n;
    },

    // 进房：本机在这房间有过身份就复用同一个 pid（清掉退出标记、按需改名），
    // 否则建一个新玩家。认的是设备 id，不是名字。
    async confirmJoin() {
      const v = host.view();
      const name = (document.getElementById('myName').value || '').trim();
      if (!U.validName(name)) { alert('名字需 1～8 个字，且不能含引号等特殊符号'); return; }
      if (S.nameTaken(state.room, name, v.pid || undefined)) {
        alert('房间里已经有人叫「' + name + '」了，换一个吧'); return;
      }
      try {
        let pid = v.pid;
        if (pid) {
          const me = state.room.players[pid];
          if (me.name !== name) await S.patch(v.code, '/players/' + pid + '/name', name);
          if (me.left) {
            await S.patch(v.code, '/players/' + pid + '/left', null);
            await S.patch(v.code, '/players/' + pid + '/leftAt', null);
          }
        } else {
          pid = S.newKey('p_');
          await S.patch(v.code, '/players/' + pid,
            { name, uid: state.uid, at: Date.now() });
        }
        host.saveName(name);
        await attach(v.code, pid);
      } catch (e) { alert('进入房间失败：' + e.message); }
    },

    // 退出：只打个 left 标记，玩家和已记的分一笔都不删。
    // 想回来就让牌友把房号或二维码发过来，重进会自动认回原位置。
    async leave() {
      if (!confirm('退出房间？分数会留在房间里，想回来让牌友把房号或二维码发给你。')) return;
      if (!state.local) {
        try {
          await S.patch(state.code, '/players/' + state.pid + '/left', true);
          await S.patch(state.code, '/players/' + state.pid + '/leftAt', Date.now());
        } catch (e) { /* 网络不好也让他走，回来时重新认设备即可 */ }
      }
      close();
      host.go({ name: 'home' });
    },
  };
  if (typeof window !== 'undefined') window.Room = Room;
```

- [ ] **Step 3: 构建确认没有语法错误**

Run: `node build.js && node --test`
Expected: 构建成功；测试全绿（room.js 目前不被 Node 测试加载）。

- [ ] **Step 4: 提交**

```bash
git add src/room.js
git commit -m "feat(room): 房间状态与进房流程，身份按设备 id 认回、退出只做灰显标记"
```

---

### Task 6: room.js — 记分主页与支出弹窗

**Files:**
- Modify: `src/room.js`
- Modify: `src/style.css`

**Interfaces:**
- Consumes: Task 5 的 `state` / `host` / `Room`
- Produces:
  - `RunfastRoom.views.room() -> string`
  - `RunfastRoom.startLocal(session)`：本地单机进入同一套记分页
  - `RunfastRoom.snapshot() -> session`
  - `window.Room` 新增：`tapSeat(pid)` / `addMenu()` / `addOffline()` / `share()` / `closePay()` / `pickPayer()` / `setPayer(pid)` / `submitPay()` / `previewPay(v)`

- [ ] **Step 1: 在 room.js 里加入净额、快照与本地模式**

在 `joinView` 之后插入：

```js
  // ---------- 本地单机 ----------
  // 用本地场现搭一个同形状的房间：pid 就是名字（本地没有设备身份，也就没有「我」）。
  function localRoom(session) {
    const players = Object.create(null);
    session.players.forEach((n, i) => { players[n] = { name: n, uid: null, at: i }; });
    const tx = Object.create(null);
    (session.transfers || []).forEach((t) => { tx[t.id] = t; });
    return { creatorUid: null, sid: session.id, createdAt: session.createdAt,
      pricePerCardFen: session.pricePerCardFen, status: session.status, players, tx };
  }
  function startLocal(session) {
    resetState();   // 用 resetState 不用 close：别把「回到联机房间」的房号也顺手清了
    state.active = true; state.local = true;
    state.session = session; state.room = localRoom(session);
    state.pid = null; state.status = 'connected';
    host.go({ name: 'room' });
  }
  // 本地写入：直接改 db 里那条场，再让 app.js 落盘重绘
  function localApply(fn) {
    fn(state.session);
    state.room = localRoom(state.session);
    host.saveLocal();
  }

  // ---------- 净额与快照 ----------
  // 每人当前净分。本地场可能还带着旧的 rounds，交给 logic 一起算。
  function netOf() {
    if (state.local) {
      const out = Object.create(null);
      L.sessionNet(state.session).forEach((p) => { out[p.name] = p.cards; });
      return out;
    }
    const r = state.room, net = Object.create(null);
    Object.keys(r.players).forEach((pid) => { net[pid] = 0; });
    S.txList(r).forEach((t) => {
      if (net[t.from] === undefined || net[t.to] === undefined) return;  // 引用了不存在的人，跳过
      net[t.from] -= t.points;
      net[t.to] += t.points;
    });
    return net;
  }

  // 把当前房间快照成一个 session：名字取快照，历史因此不依赖房间还在不在。
  function snapshot() {
    if (state.local) return state.session;
    const r = state.room;
    const nameOf = (pid) => (r.players[pid] || {}).name || '?';
    const pids = Object.keys(r.players).sort((a, b) => (r.players[a].at || 0) - (r.players[b].at || 0));
    return {
      id: r.sid,
      createdAt: r.createdAt,
      pricePerCardFen: r.pricePerCardFen,
      players: pids.map(nameOf),
      status: r.status === 'finished' ? 'finished' : 'active',
      finishedAt: r.finishedAt,
      rounds: [],
      transfers: S.txList(r).map((t) => ({ id: t.id, from: nameOf(t.from), to: nameOf(t.to),
        points: t.points, at: t.at })),
    };
  }
```

同时把 Task 5 里 `init` 的 host 默认值补上 `saveLocal`：

```js
  let host = {
    go() {}, render() {}, view() { return {}; },
    directory() { return []; }, onFinished() {}, saveName() {}, saveLocal() {},
  };
```

- [ ] **Step 2: 加入记分主页视图**

在 `snapshot()` 之后插入：

```js
  // ---------- 记分主页 ----------
  function seatHtml(pid, points) {
    const p = state.room.players[pid];
    const left = !!p.left;
    const tag = left ? '<span class="left-tag">已退出</span>'
      : (!state.local && pid === state.pid) ? '<span class="me-tag">我</span>'
      : (!state.local && p.uid == null) ? '<span class="proxy-tag">代</span>' : '';
    const sign = points > 0 ? '+' : '';
    return `<button class="seat${left ? ' left' : ''}${(!state.local && pid === state.pid) ? ' me' : ''}"
        onclick="Room.tapSeat('${esc(pid)}')">
      <span class="ava" style="background:${U.avatarColor(p.name)}">${esc(U.initial(p.name))}</span>
      <span class="nm">${esc(p.name)}${tag}</span>
      <span class="pts ${points > 0 ? 'pos' : points < 0 ? 'neg' : ''}">${sign}${points}</span>
    </button>`;
  }

  function txRowHtml(t) {
    const r = state.room;
    const from = r.players[t.from], to = r.players[t.to];
    if (!from || !to) return '';
    // 代记：提交这笔的设备不是付款人本人（本地单机没有设备身份，不标）
    const proxy = (!state.local && t.byUid && from.uid !== t.byUid) ? deviceName(t.byUid) : '';
    return `<div class="row">
      <span><b class="who">${esc(from.name)}</b> 记分给 <b class="who">${esc(to.name)}</b>${
        proxy ? ` <span class="proxy-tag">${esc(proxy)}代记</span>` : ''}</span>
      <span class="amt">${t.points}</span>
    </div>`;
  }
  // 设备 id → 该设备绑定的玩家名（找不到就空字符串）
  function deviceName(uid) {
    const ps = state.room.players;
    const pid = Object.keys(ps).find((k) => ps[k].uid === uid);
    return pid ? ps[pid].name : '';
  }

  function roomView() {
    const r = state.room;
    if (!r) return '';
    const price = L.fenToYuan(r.pricePerCardFen);
    const list = S.txList(r).slice().reverse();          // 最新在上
    const net = netOf();
    const pids = Object.keys(r.players).sort((a, b) => (r.players[a].at || 0) - (r.players[b].at || 0));
    const actions = (state.local ? '' : '<button class="icon-btn" onclick="Room.share()">分享</button>')
      + '<button class="icon-btn" onclick="Room.more()">⋯</button>';
    const bar = state.local ? ''
      : `<div class="sync-bar"><span><span class="sync-dot ${state.status === 'connected' ? '' : 'off'}"></span>房号 ${esc(state.code)} · ${S.playingCount(r)} 人在玩</span></div>`;
    return `
      ${U.topbar('已记 ' + S.txList(r).length + ' 笔 · ' + price + '元/张', state.local ? 'App.goHome()' : '', actions)}
      ${bar}
      <div class="card">
        <div class="players">
          ${pids.map((pid) => seatHtml(pid, net[pid] || 0)).join('')}
          <button class="seat" onclick="Room.addMenu()">
            <span class="ava add">＋</span><span class="nm">加人</span><span class="pts">&nbsp;</span>
          </button>
        </div>
      </div>
      <div class="tip">谁赢了就点谁的头像${state.local ? '' : ' · 点自己头像改名或退出'}</div>
      <div class="card">
        ${list.map(txRowHtml).join('') || '<div class="muted">还没有记录，谁赢了就点谁的头像</div>'}
      </div>`;
  }
```

把 `api` 的 `views` 改成 `views: { joinName: joinView, room: roomView }`，并把 `startLocal` / `snapshot` 加进导出。

- [ ] **Step 3: 加入支出弹窗**

在 `roomView` 之后插入：

```js
  // ---------- 支出弹窗 ----------
  // 独立的 overlay（不走 openSheet），因为要控制「校验没过时不关窗」。
  function closePay() {
    const el = document.getElementById('pay');
    if (el) el.remove();
    state.payFrom = null; state.payTo = null;
  }
  function openPay(toPid) {
    state.payTo = toPid;
    // 联机默认「我付」；本地单机没有「我」，沿用上次选的付款人
    if (!state.local) state.payFrom = state.pid;
    if (!state.payFrom || state.payFrom === toPid || !state.room.players[state.payFrom]) {
      state.payFrom = Object.keys(state.room.players)
        .find((pid) => pid !== toPid && !state.room.players[pid].left) || null;
    }
    if (!state.payFrom) { alert('房间里还没有别人，先加个人吧'); return; }
    renderPay();
  }
  function renderPay() {
    const r = state.room;
    const from = r.players[state.payFrom], to = r.players[state.payTo];
    const keep = (document.getElementById('payPoints') || {}).value || '';
    let el = document.getElementById('pay');
    if (!el) {
      el = document.createElement('div');
      el.id = 'pay';
      el.className = 'overlay';
      document.body.appendChild(el);
    }
    el.innerHTML = `<div class="pay">
      <button class="pay-x" onclick="Room.closePay()">×</button>
      <div class="pay-head">
        <button class="pay-who" onclick="Room.pickPayer()">
          <span class="ava" style="background:${U.avatarColor(from.name)}">${esc(U.initial(from.name))}</span>
          <span class="nm">${esc(from.name)} ▾</span><span class="muted">点这里换人</span>
        </button>
        <div class="pay-arrow"><div>支出 分数</div><div>→</div></div>
        <div class="pay-who">
          <span class="ava" style="background:${U.avatarColor(to.name)}">${esc(U.initial(to.name))}</span>
          <span class="nm">${esc(to.name)}</span><span class="muted">赢家</span>
        </div>
      </div>
      <input type="text" id="payPoints" inputmode="numeric" placeholder="输入支出分数"
             value="${esc(keep)}" oninput="Room.previewPay(this.value)">
      <div class="muted pay-hint" id="payHint">${payHint(keep)}</div>
      <button class="btn btn-primary" onclick="Room.submitPay()">支出</button>
    </div>`;
    const inp = document.getElementById('payPoints');
    if (inp) inp.focus();
  }
  // 输入实时折算成钱；没填就提示单价
  function payHint(v) {
    const n = Number(String(v).trim());
    const price = state.room.pricePerCardFen;
    if (!Number.isInteger(n) || n <= 0) return '1 分 = ' + L.fenToYuan(price) + ' 元 · 全关就输 20';
    return n + ' 分 = ' + L.fenToYuan(n * price) + ' 元';
  }
```

- [ ] **Step 4: 补齐 `window.Room` 的记分交互**

在 Task 5 建立的 `const Room = {...}` 里追加：

```js
    tapSeat(pid) {
      const p = state.room.players[pid];
      if (!p) return;
      if (p.left) { alert('该用户已退出房间'); return; }
      if (!state.local && pid === state.pid) { Room.mePanel(); return; }
      openPay(pid);
    },

    closePay() { closePay(); },
    previewPay(v) {
      const el = document.getElementById('payHint');
      if (el) el.textContent = payHint(v);
    },
    pickPayer() {
      const r = state.room;
      const items = Object.keys(r.players)
        .filter((pid) => !r.players[pid].left && pid !== state.payTo)
        .sort((a, b) => (r.players[a].at || 0) - (r.players[b].at || 0))
        .map((pid) => ({
          label: r.players[pid].name + (!state.local && pid === state.pid ? '（我）' : ''),
          onclick: `Room.setPayer('${esc(pid)}')`,
        }));
      U.openSheet(items, '<div class="sheet-head">谁支出这笔分？</div>');
    },
    setPayer(pid) { state.payFrom = pid; renderPay(); },

    async submitPay() {
      const raw = ((document.getElementById('payPoints') || {}).value || '').trim();
      const n = Number(raw);
      if (!/^\d+$/.test(raw) || !Number.isInteger(n) || n <= 0 || n > 9999) {
        alert('请输入 1～9999 的整数分数'); return;
      }
      const from = state.payFrom, to = state.payTo;
      if (from === to) { alert('不能给自己记分'); return; }
      const tx = { from, to, points: n, byUid: state.uid || null, at: Date.now() };
      if (state.local) {
        localApply((s) => {
          s.transfers = (s.transfers || []).concat([{ id: S.newKey('t_'),
            from: state.room.players[from].name, to: state.room.players[to].name, points: n, at: tx.at }]);
        });
        closePay();
        return;
      }
      try {
        await S.patch(state.code, '/tx/' + S.newKey('t_'), tx);
        closePay();
      } catch (e) { alert('记分失败，请重试：' + e.message); }
    },

    // mePanel / more / share 在 Task 7 补齐。做完 Task 6 时点自己头像或「⋯」会报
    // 「Room.mePanel is not a function」，这是预期的，别当成 bug 去改。

    // ＋：邀请牌友扫码 / 直接加没带手机的人
    addMenu() {
      const items = [{ label: '➕ 加没带手机的人', onclick: 'Room.addOffline()' }];
      if (!state.local) items.unshift({ label: '📤 邀请牌友扫码', onclick: 'Room.share()' });
      U.openSheet(items);
    },
    async addOffline() {
      const name = (window.prompt('加个人（没带手机的，大家都能替 TA 记分）：', '') || '').trim();
      if (!name) return;
      if (!U.validName(name)) { alert('名字需 1～8 个字，且不能含引号等特殊符号'); return; }
      if (S.nameTaken(state.room, name)) { alert('房间里已经有人叫这个名字了'); return; }
      host.saveName(name);
      if (state.local) { localApply((s) => { s.players.push(name); }); return; }
      try { await S.patch(state.code, '/players/' + S.newKey('p_'), { name, uid: null, at: Date.now() }); }
      catch (e) { alert('加人失败：' + e.message); }
    },
```

`api` 里补上 `startLocal` / `snapshot`：

```js
  const api = { init, preview, attach, close, lastName, startLocal, snapshot, state,
    views: { joinName: joinView, room: roomView } };
```

- [ ] **Step 5: 加样式**

`src/style.css` 里删掉 `.numgrid` 与 `.numgrid button` 两条规则（第 49–52 行，数字键盘已不再使用），在文件末尾追加：

```css
/* 头像行：谁赢了点谁 */
.players { display: flex; gap: 10px; overflow-x: auto; padding-bottom: 4px; }
.seat { flex: 0 0 auto; width: 64px; border: 0; background: none; padding: 0; cursor: pointer; color: var(--ink); }
.seat .ava { display: flex; align-items: center; justify-content: center; width: 48px; height: 48px;
  margin: 0 auto 5px; border-radius: 50%; color: #fff; font-size: 20px; font-weight: 700; }
.seat .ava.add { background: none; border: 2px dashed #c8c2b0; color: #9a927c; font-size: 22px; }
.seat .nm { display: block; font-size: 12px; line-height: 1.4; white-space: nowrap;
  overflow: hidden; text-overflow: ellipsis; }
.seat .pts { display: block; font-size: 13px; font-weight: 800; }
.seat.me .ava { box-shadow: 0 0 0 2px var(--gold); }
.seat.left { opacity: .45; }
.left-tag { display: inline-block; margin-left: 4px; padding: 0 5px; border-radius: 999px;
  background: #9ca3af; color: #fff; font-size: 11px; font-weight: 700; }
.tip { background: rgba(0,0,0,.28); border: 1px solid rgba(212,175,55,.4); color: var(--gold-soft);
  border-radius: 10px; padding: 8px 12px; margin-bottom: 12px; font-size: 13px; }
.who { color: #1d4ed8; font-weight: 700; }
.amt { font-weight: 800; font-size: 17px; flex-shrink: 0; }
/* 支出弹窗 */
.pay { position: relative; width: 100%; max-width: 340px; background: var(--cream); color: var(--ink);
  border-radius: 18px; padding: 22px 18px 18px; }
.pay .muted { color: #6b7280; }
.pay-x { position: absolute; top: 6px; right: 10px; border: 0; background: none;
  font-size: 26px; line-height: 1; color: #9ca3af; cursor: pointer; }
.pay-head { display: flex; align-items: flex-start; justify-content: space-between; margin: 6px 0 16px; }
.pay-who { flex: 1; border: 0; background: none; padding: 0; text-align: center; color: var(--ink); cursor: pointer; }
.pay-who .ava { display: flex; align-items: center; justify-content: center; width: 52px; height: 52px;
  margin: 0 auto 5px; border-radius: 50%; color: #fff; font-size: 22px; font-weight: 700; }
.pay-who .nm { display: block; font-size: 14px; font-weight: 700; }
.pay-who .muted { display: block; font-size: 11px; margin-top: 2px; }
.pay-arrow { flex: 0 0 90px; text-align: center; color: #6b7280; font-size: 14px; padding-top: 16px; line-height: 1.6; }
.pay-hint { text-align: center; margin: 8px 0 14px; }
.sheet-head { padding: 14px 16px 6px; text-align: center; font-weight: 700; color: var(--ink); }
```

- [ ] **Step 6: 构建并确认无语法错误**

Run: `node build.js && node --test`
Expected: 构建成功，测试全绿。

- [ ] **Step 7: 提交**

```bash
git add src/room.js src/style.css
git commit -m "feat(room): 头像行+流水+支出弹窗，点谁的头像就给谁记分"
```

---

### Task 7: room.js — 自己头像面板、更多菜单、结算与结束本场

**Files:**
- Modify: `src/room.js`
- Modify: `src/app.js:405-406`（结算页的「关闭房间」按钮条件）

**Interfaces:**
- Consumes: Task 6 的 `snapshot()` / `state` / `host`
- Produces：`window.Room` 新增 `mePanel()` / `rename()` / `more()` / `settle()` / `finish()` / `share()` / `shareInviteImage()` / `shareInviteLink()` / `copyInvite()` / `shareFallback()` / `closeRoom()`
  - `Room.settle()` 跳 `{ name: 'settle', sid, from: 'room' }`，app.js 的结算页在 `from === 'room'` 时现调 `RunfastRoom.snapshot()` 取最新数据
  - `Room.finish()` 写 `/finishedAt` 与 `/status`，随后由 `onRoom` 触发 `host.onFinished(snapshot())`

- [ ] **Step 1: 把邀请分享从 app.js 搬进 room.js**

从 `src/app.js` 剪切 `inviteLink` / `inviteBlob` / `inviteUrl`（原 669–670 行）以及 `share` / `shareInviteImage` / `shareInviteLink` / `shareFallback` / `copyInvite`（原 857–916 行），粘进 `src/room.js` 的 IIFE 内，并做这些改写：

- `inviteLink()` 里的 `online.code` → `state.code`
- 各处 `online.code` → `state.code`
- `openSheet(...)` → `U.openSheet(...)`，`copyToClipboard(...)` → `U.copyToClipboard(...)`，`esc(...)` 已在 room.js 内可用
- 面板按钮的 `onclick` 里 `App.` 前缀全部改成 `Room.`
- 五个方法作为 `Room` 对象的成员（`share` / `shareInviteImage` / `shareInviteLink` / `shareFallback` / `copyInvite`）

- [ ] **Step 2: 加入自己头像面板与更多菜单**

在 `Room` 对象里追加：

```js
    // 点自己头像：改昵称 / 退出房间
    mePanel() {
      const p = state.room.players[state.pid];
      U.openSheet([
        { label: '✏️ 更新昵称', onclick: 'Room.rename()' },
        { label: '🚪 退出房间', onclick: 'Room.leave()', danger: true },
      ], `<div class="sheet-head">${esc(p.name)}</div>`);
    },

    async rename() {
      if (state.local) { alert('本地单机没有「我」，改名请点那个人的头像旁边的加人重来'); return; }
      const p = state.room.players[state.pid];
      const next = (window.prompt('把「' + p.name + '」改成：', p.name) || '').trim();
      if (!next || next === p.name) return;
      if (!U.validName(next)) { alert('名字需 1～8 个字，且不能含引号等特殊符号'); return; }
      if (S.nameTaken(state.room, next, state.pid)) { alert('房间里已经有人叫这个名字了'); return; }
      try { await S.patch(state.code, '/players/' + state.pid + '/name', next); host.saveName(next); }
      catch (e) { alert('改名失败：' + e.message); }
    },

    // ⋯：结算方案随时可看，结束本场谁都能点
    more() {
      const items = [
        { label: '💰 结算方案', onclick: 'Room.settle()' },
        { label: '🏁 结束本场', onclick: 'Room.finish()' },
      ];
      if (!state.local) {
        items.push({ label: '✏️ 改我的昵称', onclick: 'Room.rename()' });
        items.push({ label: '🚪 退出房间', onclick: 'Room.leave()', danger: true });
      } else {
        items.push({ label: '🚪 回首页', onclick: 'App.goHome()' });
      }
      U.openSheet(items);
    },

    // 只读地看当前结算方案：结算页在 from==='room' 时每次重绘都现取快照，不存旧数据
    settle() {
      host.go({ name: 'settle', sid: snapshot().id, from: 'room' });
    },

    async finish() {
      if (!S.txList(state.room).length) { alert('还没记过分，不能结算'); return; }
      if (!confirm('结束本场后不能再记分，确定吗？')) return;
      if (state.local) {
        localApply((s) => { s.status = 'finished'; s.finishedAt = new Date().toISOString(); });
        const snap = snapshot();
        close();
        host.onFinished(snap);
        return;
      }
      try {
        await S.patch(state.code, '/finishedAt', new Date().toISOString());
        await S.patch(state.code, '/status', 'finished');   // 各端收到推送后自己存历史、跳结算页
      } catch (e) { alert('结算失败：' + e.message); }
    },

    // 结算页的「关闭房间」：从云端删掉这个房间（战绩已存进各自手机）
    async closeRoom() {
      if (!confirm('关闭后房间从服务器删除（战绩已存进各自手机历史），确定？')) return;
      try {
        await S.deleteRoom(state.code);
        state.code = null; state.room = null;
        host.render();
      } catch (e) { alert('关闭失败：' + e.message); }
    },
```

`finishLocally()`（Task 5）保持不变——它已经在 `onRoom` 里被 `status === 'finished'` 触发。

- [ ] **Step 3: 让「关闭房间」在结算页可用**

`Room.closeRoom` 需要在房间结束后仍拿得到 `state.code`，但 `close()` 会清掉它。改 `finishLocally()`，只对建房人保留房号：

```js
  // 结束本场：各端把快照存进自己手机的历史，然后断开连接跳结算页。
  // 建房人保留房号，好在结算页上把房间从服务器删掉。
  function finishLocally() {
    const snap = snapshot();
    const mine = !!(state.room && state.room.creatorUid === state.uid);
    const code = state.code, room = state.room;
    close();
    if (mine) { state.code = code; state.room = room; }
    host.onFinished(snap);
  }
```

`src/app.js` 结算页底部那段「关闭房间」按钮（原 405–406 行）改成：

```js
      ${RunfastRoom.state.code && RunfastRoom.state.room
        && RunfastRoom.state.room.creatorUid === RunfastRoom.state.uid
        && RunfastRoom.state.room.sid === s.id ? `<div class="gap"></div>
      <button class="btn" onclick="Room.closeRoom()">关闭房间（牌友都保存后再关）</button>` : ''}`;
```

- [ ] **Step 4: 构建并确认无语法错误**

Run: `node build.js && node --test`
Expected: 构建成功，测试全绿。

- [ ] **Step 5: 提交**

```bash
git add src/room.js src/app.js
git commit -m "feat(room): 自己头像面板、更多菜单、随时可看的结算方案与结束本场"
```

---

### Task 8: app.js 接线与旧代码清理

**Files:**
- Modify: `src/app.js`（大幅删改）
- Modify: `README.md`
- Test: `node --test` 全量 + 浏览器手测

**Interfaces:**
- Consumes: `RunfastRoom.{init,preview,attach,startLocal,snapshot,state,views}`、`RunfastUI.*`、`RunfastSync.{configured,validRoomCode,createRoom,signIn,getUid,readRoom}`
- Produces: `window.App`（首页/建场/加入/历史/结算/明细/导入导出）

- [ ] **Step 1: 删掉全部旧的记分流程代码**

从 `src/app.js` 删除：

- `idTag` / `myOwnKey` / `loadMyOwn` / `saveMyOwn` / `myOwnName` / `myNames` / `mySeatIdx` / `isSeated` / `activeIdx` / `allClaimed` / `seatsOf` / `isOwner`（原 46–77 行）
- `commitSession`（原 79–94 行）
- `topbar` / `closeSheet` / `openSheet` / `copyToClipboard`（原 96–130 行，已搬进 `ui.js`）
- `emptySeatClaimCard` / `draftOpen` / `draftCard`（原 251–330 行）
- `currentLosers` / `VIEWS.record`（原 332–380 行）
- `VIEWS.joinRoom` 保留，`VIEWS.lobby` / `onlineBar` / `topActions`（原 482–517 行）删除
- `enterRoom` / `PLAYING_VIEWS` / `LOBBY_VIEWS` / `routeByPhase` / `leaveOnline` / `snapshotOnlineFinished`（原 519–606 行）
- `VIEWS.players` 与 `App.goPlayers` / `rememberJoinName` / `leave` / `comeBack` / `joinPlayer` / `renamePlayer` / `removePlayer` / `backFromPlayers`（原 608–633、1082–1191 行）——加人改名退出都在房间里做了
- `cleanEntries` / `draftAllConfirmed` / `_autoSaving` / `maybeAutoSaveDraft`（原 673–710 行）
- `App` 里的：`claimSeat` / `releaseSeat` / `startPlaying` / `draftPickWinner` / `draftFill` / `draftToggleShutout` / `draftConfirm` / `draftOpenSeat` / `draftCloseSeat` / `leaveRoom` / `openMore` / `toggleAllowEdit` / `share` / `shareInviteImage` / `shareInviteLink` / `shareFallback` / `copyInvite` / `closeRoom` / `closeRoomVoid` / `goRecord` / `cancelRecord` / `pickWinner` / `pickCards` / `toggleShutout` / `saveRound` / `editRound` / `deleteRound` / `finishSession` / `voidSession` / `togglePlayer` / `addPlayer`（后两个被新的 `pickName` / `addLocalPlayer` 取代）
- 顶部的 `online` 对象与 `sessionCtx`（原 43–44 行）
- `roundRow` 的可编辑分支（原 209–211 行）——每局明细改为只读
- `afterRecord`（原 425–431 行）

**保留**：`toggleManage` / `renameDirName` / `deleteDirName`（常用名录管理）、`VIEWS.history` 整块、`VIEWS.joinRoom`、`exportData` / `importData` / `importValid` / `historyEditOn` 等历史相关动作。

`VIEWS.rounds` 只服务历史旧场，改成：

```js
  // 只有历史里按局记的旧场才有「每局明细」；新场是流水，直接在记分页看
  VIEWS.rounds = () => {
    const s = db.sessions.find((x) => x.id === view.sid);
    if (!s) return VIEWS.home();
    return `
      ${topbar('每局明细', `App.goSettle('${view.sid}','${view.from}')`)}
      <div class="card">${s.rounds.map((r, i) => roundRow(s, r, i)).join('')
        || '<div class="muted">本场没有记录任何一局</div>'}</div>`;
  };
```

在文件顶部把工具函数换成 `RunfastUI` 的：

```js
  const L = RunfastLogic, U = RunfastUI, R = RunfastRoom;
  const esc = U.esc, topbar = U.topbar, validName = U.validName;
  const STORE_KEY = 'runfast.v1';
```

`roundRow` 简化为只读（历史旧场的每局明细）：

```js
  // 历史旧场的每局明细（新场是流水，不再有「局」）
  function roundRow(s, r, i) {
    const detail = L.roundTransfers(r, s.pricePerCardFen)
      .map((t) => `${esc(t.from)} ${t.cards}张`).join('，');
    return `<div class="row">
      <div><b>第${i + 1}局</b> ${esc(r.winner)} 赢${r.at ? ` <span class="muted">${fmtTime(r.at)}</span>` : ''}
        <div class="muted">${detail || '其他人也都出完了'}</div></div>
    </div>`;
  }
```

`VIEWS.rounds` 里对应改成 `s.rounds.map((r, i) => roundRow(s, r, i))`，`VIEWS.session` 整个删掉（记分页由 `RunfastRoom.views.room` 提供）。

- [ ] **Step 2: 接线路由与宿主回调**

在 `VIEWS` 定义之后、`App` 定义之前插入：

```js
  // 房间的两个视图挂进路由；房间需要的宿主能力在这里注入
  VIEWS.joinName = () => R.views.joinName();
  VIEWS.room = () => R.views.room();

  R.init({
    go,
    render,
    view: () => view,
    directory: () => db.playerDirectory,
    // 记住这个名字：进下一个房间时自动填、并进常用名录做快选
    saveName(name) {
      try { localStorage.setItem('runfast.lastName', name); } catch (e) { /* 忽略 */ }
      if (!db.playerDirectory.includes(name)) { db.playerDirectory.push(name); saveDB(); }
    },
    saveLocal() { saveDB(); render(); },
    // 本场结束：快照存进本机历史（幂等），跳结算页
    onFinished(session) {
      const snap = JSON.parse(JSON.stringify(session));
      snap.status = 'finished';
      const i = db.sessions.findIndex((x) => x.id === snap.id);
      if (i >= 0) db.sessions[i] = snap; else db.sessions.push(snap);
      saveDB();
      go({ name: 'settle', sid: snap.id, from: 'home' });
    },
  });
```

- [ ] **Step 3: 改首页与建场页**

`VIEWS.home` 换成：

```js
  VIEWS.home = () => {
    const act = activeSession();
    let lastRoom = null;
    try { lastRoom = JSON.parse(localStorage.getItem('runfast.sync.room') || 'null'); } catch (e) { /* 忽略 */ }
    return `
      <h1 style="text-align:center;margin:20px 0 18px">🃏 跑得快记分</h1>
      ${lastRoom && RunfastSync.configured() ? `<button class="btn btn-primary" onclick="App.rejoinRoom()">回到联机房间（${esc(lastRoom.code)}）</button><div class="gap"></div>` : ''}
      ${act ? `<button class="btn btn-primary" onclick="App.goSession()">继续本场（${act.players.map(esc).join('、')}）</button><div class="gap"></div>` : ''}
      <button class="btn btn-primary btn-hero" onclick="App.goOnlineSetup()">创建联机场<small>开个房间，牌友扫码进来一起记</small></button>
      <div class="gap"></div>
      <button class="btn" onclick="App.goJoinRoom()">加入联机场</button>
      <div class="gap"></div>
      <div style="display:flex;gap:10px">
        ${act ? '' : '<button class="btn btn-ghost" onclick="App.goSetup()">开新一场（本地）</button>'}
        <button class="btn btn-ghost" onclick="App.goHistory()">历史记录</button>
      </div>
      <div class="gap"></div>
      <div class="card">
        <div class="muted" style="margin-bottom:10px">数据保存在本手机浏览器里，换手机或清缓存前请先导出</div>
        <button class="btn btn-sm" onclick="App.exportData()">导出备份</button>
        <button class="btn btn-sm" onclick="App.importData()">导入备份</button>
      </div>`;
  };
```

> 「回到联机房间」的显隐规则不用额外写代码：`Room.leave()` 里的 `close()` 已经把 `runfast.sync.room` 清掉了，主动退出后这个按钮自然不出现。

`VIEWS.setup` 换成「我的名字 + 单价」：

```js
  VIEWS.setup = () => {
    const isOnline = view.mode === 'online';
    const dir = db.playerDirectory;
    // 注意：路由对象上的 name 是视图名，用户输入的名字存在 myName 上
    return `
      ${topbar(isOnline ? '创建联机场' : '开新一场（本地）', 'App.goHome()')}
      <div class="card">
        <div class="section-title" style="display:flex;justify-content:space-between;align-items:center">
          <span>${isOnline ? '你的名字' : '这一场有谁'}</span>
          ${dir.length ? `<button class="btn btn-sm" onclick="App.toggleManage()">${view.manage ? '完成' : '管理名录'}</button>` : ''}
        </div>
        ${view.manage
          ? dir.map((n) => `<div class="row"><span>${esc(n)}</span>
              <div style="flex-shrink:0">
                <button class="btn btn-sm" onclick="App.renameDirName('${esc(n)}')">改名</button>
                <button class="btn btn-sm" onclick="App.deleteDirName('${esc(n)}')">删除</button>
              </div></div>`).join('') +
            '<div class="muted" style="margin-top:8px">改名/删除只影响这里的常用名单，不影响历史战绩。</div>'
          : `<input type="text" id="myName" maxlength="8" placeholder="${isOnline ? '输入你的名字（8 字以内）' : '玩家名字（8 字以内）'}" value="${esc(view.myName || '')}">
             ${dir.length ? `<div class="chips" style="margin-top:10px">${dir.map((n) =>
               `<button class="chip ${!isOnline && view.sel.includes(n) ? 'on' : ''}" onclick="App.pickName('${esc(n)}')">${esc(n)}</button>`).join('')}</div>` : ''}
             ${isOnline
               ? '<div class="muted" style="margin-top:10px">建好后把二维码发给牌友，他们扫码进来自己输名字。没带手机的人，进去以后点「＋加人」补上。</div>'
               : `<div style="margin-top:10px"><button class="btn btn-sm" onclick="App.addLocalPlayer()">加入这一场</button></div>
                  ${view.sel.length ? `<div class="muted" style="margin-top:10px">本场玩家（${view.sel.length}）：${view.sel.map(esc).join('、')}</div>` : ''}`}`}
      </div>
      <div class="card">
        <div class="section-title">每张牌单价（元）</div>
        <input type="text" id="price" inputmode="decimal" value="${esc(view.price)}" placeholder="如 1 或 0.5">
      </div>
      <button class="btn btn-primary" onclick="App.startSession()">${isOnline ? '创建房间' : '开始记分'}</button>`;
  };
```

`toggleManage` / `renameDirName` / `deleteDirName` 三个动作**保留不删**（名字现在会自动累积进名录，更需要能整理），只把里面读单价的那行从 `view.price = document.getElementById('price').value` 保持原样即可——管理态下 `#price` 仍在页面上。

`App` 里对应的动作换成：

```js
    goSetup: () => go({ name: 'setup', sel: [], myName: '', price: '1', manage: false }),
    goOnlineSetup() {
      if (!RunfastSync.configured()) { alert('联机要在房主电脑上启动「跑得快联机」服务后，用手机扫主机页二维码进入才能用'); return; }
      go({ name: 'setup', sel: [], myName: R.lastName(), price: '1', manage: false, mode: 'online' });
    },

    // 名录里的名字：联机场填进「我的名字」，本地场是勾选本场玩家
    pickName(n) {
      view.price = document.getElementById('price').value;
      if (view.mode === 'online') { document.getElementById('myName').value = n; return; }
      const i = view.sel.indexOf(n);
      if (i >= 0) view.sel.splice(i, 1); else view.sel.push(n);
      render();
    },

    addLocalPlayer() {
      const name = document.getElementById('myName').value.trim();
      if (!validName(name)) { alert('名字需 1～8 个字，且不能含引号等特殊符号'); return; }
      if (view.sel.includes(name)) { alert('这一场已经有这个名字了'); return; }
      view.price = document.getElementById('price').value;
      if (!db.playerDirectory.includes(name)) db.playerDirectory.push(name);
      view.sel.push(name);
      saveDB();
      view.myName = '';
      render();
    },

    async startSession() {
      const priceFen = L.yuanToFen(document.getElementById('price').value.trim());
      if (Number.isNaN(priceFen)) { alert('单价格式不对，例：1 或 0.5'); return; }
      if (view.mode === 'online') {
        const name = (document.getElementById('myName').value || '').trim();
        if (!validName(name)) { alert('名字需 1～8 个字，且不能含引号等特殊符号'); return; }
        try {
          const { code, pid } = await RunfastSync.createRoom({ name, pricePerCardFen: priceFen });
          if (!db.playerDirectory.includes(name)) { db.playerDirectory.push(name); saveDB(); }
          try { localStorage.setItem('runfast.lastName', name); } catch (e) { /* 忽略 */ }
          await R.attach(code, pid);
        } catch (e) { alert('建房失败：' + e.message); }
        return;
      }
      if (view.sel.length < 2) { alert('本地场至少要 2 个玩家'); return; }
      if (activeSession()) { App.goSession(); return; }
      const session = {
        id: 's' + Date.now(),
        createdAt: new Date().toISOString(),
        pricePerCardFen: priceFen,
        players: view.sel.slice(),
        status: 'active',
        rounds: [],
        transfers: [],
      };
      db.sessions.push(session);
      saveDB();
      R.startLocal(session);
    },

    goSession() {
      const s = activeSession();
      if (!s) { App.goHome(); return; }
      R.startLocal(s);
    },

    rejoinRoom() {
      let saved = null;
      try { saved = JSON.parse(localStorage.getItem('runfast.sync.room') || 'null'); } catch (e) { /* 忽略 */ }
      if (saved && RunfastSync.validRoomCode(saved.code)) R.preview(saved.code);
      else { localStorage.removeItem('runfast.sync.room'); render(); }
    },

    joinRoomSubmit() {
      const code = document.getElementById('roomCode').value.trim();
      if (!RunfastSync.validRoomCode(code)) { alert('房号是 6 位数字'); return; }
      R.preview(code);
    },
```

文件末尾的 `?room=` 入口改成：

```js
  const roomParam = location.search.match(/[?&]room=([0-9]{6})\b/);
  if (roomParam && RunfastSync.configured()) R.preview(roomParam[1]);
```

- [ ] **Step 4: 结算页支持「随时可看的当前快照」**

`VIEWS.settle` 开头改成——`from === 'room'` 时每次重绘现取快照，牌局还在记分也能随时看到最新方案：

```js
  VIEWS.settle = () => {
    const s = settleSession();
    if (!s) return VIEWS.home();
    const backJs = view.from === 'history' ? 'App.goHistory()'
      : view.from === 'room' ? 'App.backToRoom()' : 'App.goHome()';
```

在 `VIEWS.settle` 之前加这个解析函数：

```js
  // 结算页看的可能是「房间的当前快照」（随时可看，实时），也可能是「历史里的一场」
  function settleSession() {
    if (view.from === 'room') return R.state.active ? R.snapshot() : null;
    return db.sessions.find((x) => x.id === view.sid);
  }
```

`VIEWS.settle` 里「查看每局明细」那个按钮加上条件——新场没有「局」，只有流水：

```js
      ${s.rounds && s.rounds.length
        ? `<div class="gap"></div><button class="btn" onclick="App.goRounds('${s.id}','${view.from}')">查看每局明细</button>` : ''}
```

`App.shareImage` / `App.copyText` 改成走同一个解析：

```js
    async copyText() {
      const s = settleSession();
      if (!s) return;
      const ok = await U.copyToClipboard(L.summaryText(s));
      alert(ok ? '已复制，去粘贴发给牌友吧' : '复制失败，请改用「分享战绩图」或截图');
    },
    shareImage() { const s = settleSession(); if (s) RunfastShare.share(s, L); },
    backToRoom() { go({ name: 'room' }); },
```

`VIEWS.settle` 里这两个按钮的 onclick 相应去掉参数：`onclick="App.shareImage()"`、`onclick="App.copyText()"`。

- [ ] **Step 5: 导入校验支持 transfers**

`importValid` 里，在 `if (!(Array.isArray(s.players) && ...))` 那一段之后插入：

```js
      if (s.transfers !== undefined) {
        if (!Array.isArray(s.transfers)) return false;
        for (const t of s.transfers) {
          if (!validId(t.id)) return false;
          if (!s.players.includes(t.from) || !s.players.includes(t.to)) return false;
          if (t.from === t.to) return false;
          if (!(Number.isInteger(t.points) && t.points > 0 && t.points <= 9999)) return false;
        }
      }
```

同时把 `activePlayers` 相关校验放宽——新场不再有这个字段：

```js
      if (!(Array.isArray(s.players) && Array.isArray(s.rounds))) return false;
      if (s.activePlayers !== undefined) {
        if (!Array.isArray(s.activePlayers)) return false;
        if (new Set(s.activePlayers).size !== s.activePlayers.length) return false;
        if (!s.activePlayers.every((n) => s.players.includes(n))) return false;
        s.activePlayers.forEach((n) => names.add(n));
      }
```

- [ ] **Step 6: 跑测试并构建**

Run: `node --test && node build.js`
Expected: 全绿 + 构建成功。

- [ ] **Step 7: 浏览器实测两台「设备」**

```bash
RUNFAST_NO_OPEN=1 node server.js
```

用 Browser 工具开两个标签页模拟两台设备（第二个标签页用无痕/不同 profile 才会拿到不同的 `runfast.device`；也可以在第二个标签页的控制台先执行 `localStorage.setItem('runfast.device','dev-2')` 再刷新）。逐条走一遍验收：

1. 标签页 A：创建联机场 → 填名字「华」+ 单价 1 → 直接进记分页，头像行只有「华」，没有大厅、没有「开始」按钮
2. 标签页 A：⋯ → 分享 → 复制链接；标签页 B 打开该链接 → 输名字「丽叶」→ 进入 → 两端头像行都出现两个人
3. 标签页 B：点「华」的头像 → 弹窗「丽叶 → 华」→ 输 20 → 支出 → 两端流水都出现「丽叶 记分给 华 20」，净分 +20 / −20
4. 标签页 A：点「＋」→ 加没带手机的人「小荣」→ 点「华」头像 → 弹窗里把付款人换成「小荣」→ 输 4 → 流水显示「小荣 记分给 华」且带「华代记」标
5. 标签页 A：点自己头像 → 更新昵称 → 改成「阿华」→ 两端流水里的名字同步变
6. 标签页 B：点自己头像 → 退出房间 → 标签页 A 上「丽叶」灰显并标「已退出」，分数还在；点她的头像提示「该用户已退出房间」；标签页 B 首页没有「回到联机房间」
7. 标签页 B：重新打开邀请链接 → 页面显示「你之前是「丽叶」」→ 直接点「回到房间」→ 回到原位置、灰显解除、净分接上；再试一次改名进入，位置分数依旧不变
8. 标签页 A：⋯ → 结算方案 → 看到盈亏与最少笔数转账；返回 → ⋯ → 结束本场 → 两端都跳结算页，各自「历史记录」里多一条
9. 首页 → 历史记录 → 打开一条**旧的**（Task 1 之前记的、按局记的）场 → 每局明细能看、战绩图能出

- [ ] **Step 8: 更新 README**

`README.md` 的「局域网联机」第 4 步与其后的说明改成：

```markdown
4. 开房的人在自己手机上扫码 → 「创建联机场」填自己的名字、设单价 → 得到 6 位房号，把二维码或链接发到群里。
5. 牌友扫码进来，各自输入名字就开始记分——**谁赢了就点谁的头像，输入你要给 TA 的分数**。没带手机的人，点头像行末尾的「＋」加进来，谁都能替 TA 记。
6. 记错了不用删，反过来再记一笔就行（流水只增不删）。
7. 打完点右上角「⋯ → 结束本场」，各手机自动存本地历史；开房的人可在结算页「关闭房间」。
```

- [ ] **Step 9: 提交**

```bash
git add src/app.js README.md dist/index.html
git commit -m "feat(记分): 记分主流程改为点头像记一笔转账，去掉大厅/草稿/房主特权"
```

---

## 自查记录

**Spec 覆盖检查**（对照 `docs/superpowers/specs/2026-08-03-runfast-transfer-ledger-design.md`）：

| Spec 章节 | 落在哪个任务 |
|---|---|
| 云端房间新结构（players/tx map） | Task 3 `createRoom` + Task 2 服务端校验 |
| 本地历史（transfers 数组） | Task 6 `snapshot()` + Task 8 `onFinished` / `importValid` |
| 结算兼容（rounds + transfers 相加） | Task 1 |
| 退出与回归（left 标记、认设备 id） | Task 5 `confirmJoin` / `leave`，Task 6 `seatHtml` 灰显，Task 8 首页规则 |
| 服务端权限重写 + presence 移除 | Task 2 |
| 首页 / 建场 / 输名字页 | Task 5 `joinView` + Task 8 `VIEWS.home` / `VIEWS.setup` |
| 记分主页（头像行 + 流水） | Task 6 |
| 支出弹窗（含代记换付款人） | Task 6 |
| ⋯ 更多菜单 / 结算页 / 结束本场 | Task 7 |
| 本地单机同一套界面 | Task 6 `startLocal` / `localApply` / `netOf` |
| 要删除的代码清单 | Task 3（sync）、Task 2（server）、Task 8（app） |
| 测试清单 | Task 1 / 2 / 3 / 4 |
| 验收标准 1–12 | Task 8 Step 7 逐条走查 + `node --test` |

**已知取舍**（spec 里明确不做，计划里也不做）：单笔流水的撤销/删除、观战身份、换设备后的身份找回、接管 `uid == null` 的代记玩家。
