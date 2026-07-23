# 联机协作重构 · 第一期：后端字段写 + 认领/保存 CAS + 在线名单 + 纯helper 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为"角色认领 + 协作式记分"铺好**后端与同步层地基**——服务器支持字段级写（各人填各自那格互不覆盖）、抢座/操作的条件写，SSE 在线名单，以及一组纯函数 helper。

**Architecture:** 全部**增量新增**，不动 app.js，因此现有联机在第一期期间照常可用。server.js 加 `PATCH /rooms/:code`（按路径深设 + `canPatch` 权限）与 presence（SSE 带 `?dev=`、`event: presence`）；sync.js 加纯 helper（`draftToRound/isDraftSaveable/observerCount/playingCount`）+ `patch()` 写包装 + `onPresence` 回调 + 订阅带 deviceId。第二期再做 app.js 大厅/协作 UI 与移除旧锁。

**Tech Stack:** Node v26（仅内置模块）、原生 fetch/EventSource、`node --test`。

## Global Constraints

- **零第三方运行时依赖**，仅 Node 内置模块。
- **Node v26**；测试 `node --test`（不带目录参数）。
- **第一期只增不改**：不修改 `src/app.js`、不删除 `src/sync.js` 现有导出（旧的 `activeLock`/联机流程保留，第二期再清）。本地单机与现有联机在本期全程可用。
- **房间新增字段**：`phase`（`'lobby'|'playing'|'finished'`）、`seats:[{name,claimedBy}]`、`draft`（`{winner:<座位下标>|null, entries:{<座位下标>:{cardsLeft,shutout}}}`）。draft 以**座位下标**为键。
- **presence 临时态**：不写入 `server-data.json`、不进房间对象。
- **权限服务器强制**（`deviceId` 为身份，来自 `X-Device-Id` 头）。
- 座位**只增不删**（离场只标记 `claimedBy=null`，不 splice），故下标稳定。

---

### Task 1: sync.js 纯 helper（草稿转局 / 可存判据 / 人数计数）

**Files:**
- Modify: `src/sync.js`（加 4 个纯函数并导出）
- Test: `test/sync.test.js`

**Interfaces:**
- Produces（供第二期 app.js 与本期测试）：
  - `isDraftSaveable(draft, activeIdx) -> bool`：`draft.winner` 已定，且 `activeIdx` 中除赢家外每个下标在 `draft.entries` 里都有数字 `cardsLeft`。
  - `draftToRound(draft, seats, activeIdx) -> { winner:<name>, losers:[{name,cardsLeft,shutout}] }`：把草稿转成一局（不含 id/at，由调用方补）。
  - `observerCount(deviceIds, seats) -> number`：在线设备中未出现在任何 `seats.claimedBy` 的数量。
  - `playingCount(seats) -> number`：已认领（`claimedBy` 非空）的座位数。

- [ ] **Step 1: 写失败测试**

在 `test/sync.test.js` 末尾追加：
```js
test('isDraftSaveable / draftToRound：赢家定且各输家填齐才可存，并能转成一局', () => {
  const seats = [{ name: 'A', claimedBy: 'd1' }, { name: 'B', claimedBy: 'd2' }, { name: 'C', claimedBy: 'd3' }];
  const active = [0, 1, 2];
  assert.equal(S.isDraftSaveable(null, active), false);
  assert.equal(S.isDraftSaveable({ winner: 0, entries: {} }, active), false);
  assert.equal(S.isDraftSaveable({ winner: 0, entries: { 1: { cardsLeft: 3 } } }, active), false);
  const full = { winner: 0, entries: { 1: { cardsLeft: 3, shutout: false }, 2: { cardsLeft: 10, shutout: true } } };
  assert.equal(S.isDraftSaveable(full, active), true);
  const r = S.draftToRound(full, seats, active);
  assert.equal(r.winner, 'A');
  assert.deepEqual(r.losers, [{ name: 'B', cardsLeft: 3, shutout: false }, { name: 'C', cardsLeft: 10, shutout: true }]);
});

test('observerCount / playingCount：在线未占座算观战，已认领算在玩（含一台代多座）', () => {
  const seats = [{ name: 'A', claimedBy: 'd1' }, { name: 'B', claimedBy: null }, { name: 'C', claimedBy: 'd1' }];
  assert.equal(S.playingCount(seats), 2);
  assert.equal(S.observerCount(['d1', 'd9', 'd8'], seats), 2);
  assert.equal(S.observerCount(['d1'], seats), 0);
  assert.equal(S.observerCount([], seats), 0);
});
```

- [ ] **Step 2: 运行确认失败**

Run: `node --test test/sync.test.js`
Expected: FAIL（`S.isDraftSaveable is not a function` 等）。

- [ ] **Step 3: 实现并导出**

在 `src/sync.js` 里 `normalizeRoom` 之后加入：
```js
  // ---------- 协作草稿 / 人数（纯函数）----------
  // draft={winner:<座位下标>|null, entries:{<下标>:{cardsLeft,shutout}}}；activeIdx=本局参与的座位下标数组
  function isDraftSaveable(draft, activeIdx) {
    if (!draft || draft.winner == null) return false;
    return activeIdx.filter((i) => i !== draft.winner)
      .every((i) => draft.entries && draft.entries[i] && typeof draft.entries[i].cardsLeft === 'number');
  }
  function draftToRound(draft, seats, activeIdx) {
    const losers = activeIdx.filter((i) => i !== draft.winner).map((i) => ({
      name: seats[i].name,
      cardsLeft: draft.entries[i].cardsLeft,
      shutout: !!draft.entries[i].shutout,
    }));
    return { winner: seats[draft.winner].name, losers };
  }
  function observerCount(deviceIds, seats) {
    const seated = new Set((seats || []).map((s) => s.claimedBy).filter(Boolean));
    return (deviceIds || []).filter((d) => !seated.has(d)).length;
  }
  function playingCount(seats) {
    return (seats || []).filter((s) => s.claimedBy).length;
  }
```
并把这 4 个名字加进文件末尾的 `api` 对象（与现有导出并列，勿删除现有名字）：
```js
  const api = { configured, genRoomCode, validRoomCode, canEdit, canAdmin, activeLock,
    isDraftSaveable, draftToRound, observerCount, playingCount,
    applyEvent, normalizeRoom, signIn, getUid, createRoom, readRoom, subscribe, mutate, deleteRoom, close };
```

- [ ] **Step 4: 运行确认通过**

Run: `node --test test/sync.test.js`
Expected: PASS（含新 2 条）。

- [ ] **Step 5: 提交**

```bash
git add src/sync.js test/sync.test.js
git commit -m "feat: sync 纯helper——草稿转局/可存判据/在玩与观战计数"
```

---

### Task 2: server.js 字段级写 PATCH + 权限 canPatch + 抢座 CAS

**Files:**
- Modify: `server.js`（加 `setPath`、`canPatch`，PATCH 路由，导出）
- Test: `test/server.test.js`

**Interfaces:**
- Consumes: 房间现有内存 Map、`broadcast`、`scheduleSave`、`readBody`、`json`。
- Produces：
  - `setPath(obj, path, value) -> newObj`：按 `"/a/b/2/c"` 路径深设（value 为 null 则删该键），返回新对象。
  - `canPatch(old, path, value, me) -> bool`：字段级写权限（抢空座 CAS / 填自己格 / 定赢家清草稿 / 其余仅房主）。
  - `PATCH /rooms/:code`（头 `X-Device-Id`，体 `{path, value}`）：权限通过则深设 + 广播，返回 200；否则 403。

- [ ] **Step 1: 写失败测试**

在 `test/server.test.js` 顶部把 `require('../server.js')` 那行改为同时取出新导出：
```js
const { createRunfastServer, canWrite, injectHostFlag, setPath, canPatch } = require('../server.js');
```
并在文件末尾追加：
```js
test('setPath：按路径深设，支持数组下标与删除', () => {
  const r = { seats: [{ name: 'A', claimedBy: null }], draft: { winner: 1, entries: {} } };
  assert.equal(setPath(r, '/seats/0/claimedBy', 'd1').seats[0].claimedBy, 'd1');
  assert.deepEqual(setPath(r, '/draft/entries/1', { cardsLeft: 3 }).draft.entries[1], { cardsLeft: 3 });
  assert.ok(!('winner' in setPath(r, '/draft/winner', null).draft));
  assert.equal(setPath(r, '/', null), null);
  assert.equal(r.seats[0].claimedBy, null); // 不改原对象
});

test('canPatch：抢空座CAS / 填自己格 / 定赢家 / 房主专属', () => {
  const lobby = { creatorUid: 'boss', phase: 'lobby',
    seats: [{ name: 'A', claimedBy: 'boss' }, { name: 'B', claimedBy: null }], draft: null };
  assert.ok(canPatch(lobby, '/seats/1/claimedBy', 'x', 'x'));      // 抢空座
  assert.ok(!canPatch(lobby, '/seats/0/claimedBy', 'x', 'x'));     // 占用的座抢不到
  assert.ok(canPatch(lobby, '/seats/0/claimedBy', null, 'boss'));  // 房主可释放任意座
  assert.ok(!canPatch(lobby, '/seats/0/claimedBy', null, 'x'));    // 他人不能释放别人的座
  const playing = { creatorUid: 'boss', phase: 'playing',
    seats: [{ name: 'A', claimedBy: 'boss' }, { name: 'B', claimedBy: 'x' }], draft: { winner: null, entries: {} } };
  assert.ok(canPatch(playing, '/draft/entries/1', { cardsLeft: 3 }, 'x'));    // 填自己格
  assert.ok(!canPatch(playing, '/draft/entries/1', { cardsLeft: 3 }, 'y'));   // 非本座非房主
  assert.ok(canPatch(playing, '/draft/entries/1', { cardsLeft: 3 }, 'boss')); // 房主代填
  assert.ok(canPatch(playing, '/draft/winner', 0, 'x'));           // 持座者可定赢家
  assert.ok(!canPatch(playing, '/draft/winner', 0, 'z'));          // 观战者不行
  assert.ok(canPatch(playing, '/phase', 'finished', 'boss'));      // 房主
  assert.ok(!canPatch(playing, '/phase', 'finished', 'x'));        // 非房主
});

test('PATCH 集成：抢座成功、后到者越权被拒', async () => {
  const df = tmpData(); const server = createRunfastServer({ dataFile: df }); const port = await listen(server);
  try {
    const room = { creatorUid: 'boss', phase: 'lobby',
      seats: [{ name: 'A', claimedBy: null }, { name: 'B', claimedBy: null }], draft: null,
      session: { id: 's1', players: ['A', 'B'], activePlayers: ['A', 'B'], rounds: [] } };
    await req(port, 'PUT', '/rooms/300400', room, { 'X-Device-Id': 'boss' });
    let r = await req(port, 'PATCH', '/rooms/300400', { path: '/seats/0/claimedBy', value: 'x' }, { 'X-Device-Id': 'x' });
    assert.equal(r.status, 200);
    r = await req(port, 'GET', '/rooms/300400');
    assert.equal(JSON.parse(r.body).seats[0].claimedBy, 'x');
    r = await req(port, 'PATCH', '/rooms/300400', { path: '/seats/0/claimedBy', value: 'y' }, { 'X-Device-Id': 'y' });
    assert.equal(r.status, 403);
  } finally { server.close(); try { fs.unlinkSync(df); } catch (e) {} }
});
```

- [ ] **Step 2: 运行确认失败**

Run: `node --test test/server.test.js`
Expected: FAIL（`setPath is not a function` 等）。

- [ ] **Step 3: 实现 setPath / canPatch（模块级，放在 `canWrite` 之后）**

在 `server.js` 的 `canWrite` 函数之后加入：
```js
// 按路径深设：'/a/b/2/c' → 设 obj.a.b[2].c=value（value 为 null 删该键）。返回新对象，不改原对象。
function setPath(obj, path, value) {
  if (!path || path === '/') return value;
  const keys = path.replace(/^\//, '').split('/');
  const next = obj ? JSON.parse(JSON.stringify(obj)) : {};
  let node = next;
  for (let i = 0; i < keys.length - 1; i++) {
    if (node[keys[i]] == null) node[keys[i]] = {};
    node = node[keys[i]];
  }
  const last = keys[keys.length - 1];
  if (value === null) delete node[last];
  else node[last] = value;
  return next;
}

// 字段级写权限（服务器强制）。me=X-Device-Id。
function canPatch(old, path, value, me) {
  if (!me || !old) return false;                       // 房间须已存在（建房走 PUT）
  const isCreator = old.creatorUid === me;
  const seats = Array.isArray(old.seats) ? old.seats : [];
  const holdsSeat = seats.some((s) => s && s.claimedBy === me);
  let m = path.match(/^\/seats\/(\d+)\/claimedBy$/);
  if (m) {
    const seat = seats[Number(m[1])];
    if (!seat) return false;
    if (value === me && seat.claimedBy == null) return true;                 // 抢空座(CAS)
    if (value == null && (isCreator || seat.claimedBy === me)) return true;  // 释放(房主或本人)
    return false;
  }
  if (/^\/draft\/entries\/\d+$/.test(path)) {                                // 填某座那格
    const seat = seats[Number(path.split('/').pop())];
    return !!seat && (seat.claimedBy === me || isCreator);
  }
  if (path === '/draft/winner' || path === '/draft') return holdsSeat || isCreator; // 定赢家/清草稿
  return isCreator;                                                          // phase/seats结构/session 等仅房主
}
```

- [ ] **Step 4: 加 PATCH 路由**

在 `server.js` 的房间接口块里，`PUT` 分支之后、`DELETE` 分支之前插入：
```js
      if (!isEvents && req.method === 'PATCH') {
        const me = req.headers['x-device-id'];
        let payload;
        try { payload = JSON.parse(await readBody(req)); } catch (e) { json(res, 400, { error: 'bad json' }); return; }
        const old = rooms[code] || null;
        if (!canPatch(old, payload.path, payload.value, me)) { json(res, 403, { error: 'forbidden' }); return; }
        rooms[code] = setPath(old, payload.path, payload.value);
        scheduleSave(); broadcast(code);
        json(res, 200, { ok: true });
        return;
      }
```

- [ ] **Step 5: 导出 setPath/canPatch**

把 `server.js` 末尾导出行改为：
```js
module.exports = { createRunfastServer, canWrite, canPatch, setPath, lanIP, lanURL, qrSvg, injectHostFlag };
```

- [ ] **Step 6: 运行确认通过**

Run: `node --test test/server.test.js`
Expected: PASS（含新 3 条，且原有全部仍绿）。

- [ ] **Step 7: 提交**

```bash
git add server.js test/server.test.js
git commit -m "feat: 服务器字段级写 PATCH + canPatch 权限 + 抢座CAS"
```

---

### Task 3: server.js 在线名单 presence（SSE 带 dev + event: presence）

**Files:**
- Modify: `server.js`（SSE 分支加 presence 跟踪与广播）
- Test: `test/server.test.js`

**Interfaces:**
- Produces：SSE 连接 `GET /rooms/:code/events?dev=<id>` 会把 `<id>` 计入该房在线名单；名单变化时向该房所有订阅者推 `event: presence\ndata: {"devices":[...]}`；新连接连上即收到一帧当前名单。presence 为内存态、不落地。

- [ ] **Step 1: 写失败测试**

在 `test/server.test.js` 末尾追加：
```js
test('presence：带 dev 的连接会进在线名单并广播；第二人上线后名单含两人', async () => {
  const df = tmpData(); const server = createRunfastServer({ dataFile: df }); const port = await listen(server);
  const frames = [];
  let r2;
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { r1.destroy(); reject(new Error('presence 超时')); }, 4000);
    const r1 = http.request({ host: '127.0.0.1', port, method: 'GET', path: '/rooms/500600/events?dev=alice' }, (res) => {
      let buf = '';
      res.on('data', (c) => {
        buf += c; let idx;
        while ((idx = buf.indexOf('\n\n')) >= 0) {
          const chunk = buf.slice(0, idx); buf = buf.slice(idx + 2);
          const isPresence = chunk.split('\n').some((l) => l.startsWith('event: presence'));
          const dl = chunk.split('\n').find((l) => l.startsWith('data: '));
          if (!isPresence || !dl) continue;
          frames.push(JSON.parse(dl.slice(6)));
          if (frames.length === 1) {
            r2 = http.request({ host: '127.0.0.1', port, method: 'GET', path: '/rooms/500600/events?dev=bob' }, () => {});
            r2.end();
          } else if (frames.length >= 2) { clearTimeout(timer); r1.destroy(); resolve(); }
        }
      });
    });
    r1.on('error', reject); r1.end();
  });
  try {
    assert.deepEqual(frames[0].devices, ['alice']);
    const last = frames[frames.length - 1].devices;
    assert.ok(last.includes('alice') && last.includes('bob'));
  } finally { if (r2) r2.destroy(); server.close(); try { fs.unlinkSync(df); } catch (e) {} }
});
```

- [ ] **Step 2: 运行确认失败**

Run: `node --test test/server.test.js`
Expected: FAIL（首帧不是 presence / 拿不到 devices）。

- [ ] **Step 3: 在 `createRunfastServer` 内加 presence 结构与 helper**

在 `const subscribers = new Map();` 之后加：
```js
  const presence = new Map(); // code -> Map<deviceId, refCount>
  function presenceDevices(code) {
    const mm = presence.get(code);
    return mm ? Array.from(mm.keys()) : [];
  }
  function sendPresence(res, code) {
    res.write('event: presence\n');
    res.write('data: ' + JSON.stringify({ devices: presenceDevices(code) }) + '\n\n');
  }
  function broadcastPresence(code) {
    const set = subscribers.get(code);
    if (!set) return;
    for (const res of set) sendPresence(res, code);
  }
  function addPresence(code, dev) {
    let mm = presence.get(code);
    if (!mm) { mm = new Map(); presence.set(code, mm); }
    mm.set(dev, (mm.get(dev) || 0) + 1);
    broadcastPresence(code);
  }
  function removePresence(code, dev) {
    const mm = presence.get(code);
    if (!mm) return;
    const n = (mm.get(dev) || 0) - 1;
    if (n <= 0) mm.delete(dev); else mm.set(dev, n);
    if (!mm.size) presence.delete(code);
    broadcastPresence(code);
  }
```

- [ ] **Step 4: 在 SSE 分支接线 presence**

把 SSE 分支（`if (isEvents && req.method === 'GET')`）里 `set.add(res);` 之后到 `const hb = ...` 之间改成：
```js
        set.add(res);
        const dev = u.searchParams.get('dev');
        sendPresence(res, code);            // 新连接先收到当前在线名单
        if (dev) addPresence(code, dev);    // 登记并广播变化
        const hb = setInterval(() => res.write(':keep-alive\n\n'), 30000);
```
并把该分支的 `req.on('close', ...)` 改为同时下线：
```js
        req.on('close', () => {
          clearInterval(hb); set.delete(res); if (!set.size) subscribers.delete(code);
          if (dev) removePresence(code, dev);
        });
```

- [ ] **Step 5: 运行确认通过**

Run: `node --test test/server.test.js`
Expected: PASS（含 presence，且原有全部仍绿）。

- [ ] **Step 6: 提交**

```bash
git add server.js test/server.test.js
git commit -m "feat: 服务器在线名单 presence（SSE 带 dev + event: presence）"
```

---

### Task 4: sync.js 写包装 patch() + 订阅带 deviceId + onPresence

**Files:**
- Modify: `src/sync.js`
- Test: `test/sync.test.js`

**Interfaces:**
- Consumes: Task 2 的 `PATCH /rooms/:code`、Task 3 的 `event: presence`。
- Produces（供第二期 app.js）：
  - `patch(code, path, value) -> Promise<void>`：字段级写；403 抛 `Error('没有权限或座位已被占')`。
  - `subscribe(code, callbacks)`：EventSource URL 带 `?dev=<deviceId>`；新增 `callbacks.onPresence(devices: string[])` 回调（其余 `onRoom/onStatus/onDeleted` 不变）。

- [ ] **Step 1: 写失败测试**

在 `test/sync.test.js` 末尾追加（只验证导出，实连由第二期 e2e 覆盖）：
```js
test('patch：已导出为函数', () => {
  assert.equal(typeof S.patch, 'function');
});
```

- [ ] **Step 2: 运行确认失败**

Run: `node --test test/sync.test.js`
Expected: FAIL（`typeof S.patch` 为 `undefined`）。

- [ ] **Step 3: 实现 patch，订阅带 dev + presence**

在 `src/sync.js` 的 `writeRoom` 之后加入 `patch`：
```js
  async function patch(code, path, value) {
    const res = await fetch(roomUrl(code), {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', 'X-Device-Id': deviceId },
      body: JSON.stringify({ path, value }),
    });
    if (res.status === 403) throw new Error('没有权限或座位已被占');
    if (!res.ok) throw new Error('操作失败 ' + res.status);
  }
```
把 `openStream()` 里创建 EventSource 那行改为带 dev、并监听 presence：
```js
    es = new EventSource(roomUrl(currentCode) + '/events?dev=' + encodeURIComponent(deviceId || ''));
    es.addEventListener('put', onEvt);
    es.addEventListener('presence', onPresence);
```
在 `onEvt` 之后加 `onPresence`：
```js
  function onPresence(e) {
    if (!cb || !cb.onPresence) return;
    try { cb.onPresence(JSON.parse(e.data).devices || []); } catch (err) { /* 忽略坏帧 */ }
  }
```
把 `api` 里加入 `patch`（与现有并列）：
```js
  const api = { configured, genRoomCode, validRoomCode, canEdit, canAdmin, activeLock,
    isDraftSaveable, draftToRound, observerCount, playingCount,
    applyEvent, normalizeRoom, signIn, getUid, createRoom, readRoom, subscribe, patch, mutate, deleteRoom, close };
```

- [ ] **Step 4: 运行全量测试**

Run: `node --test`
Expected: 全绿（`logic/sync/server/qrcode.vendor` 四文件），无回归。

- [ ] **Step 5: 提交**

```bash
git add src/sync.js test/sync.test.js
git commit -m "feat: sync patch() 字段写 + 订阅带 deviceId + onPresence 回调"
```

---

## Self-Review

- **Spec 覆盖（本期范围）**：字段级写(§9)→ Task 2 ✓；抢座 CAS(§9)→ Task 2 `canPatch` ✓；权限矩阵(§10)→ Task 2 `canPatch` ✓；presence(§7)→ Task 3 ✓；draft 转局/可存/人数 helper(§5/§7)→ Task 1 ✓；sync 接口(§11)→ Task 4 ✓。**第二期**覆盖：大厅/认领 UI、协作记分 UI、顶部人数、玩家管理、移除 allowEdit/锁、保存幂等的 app 侧编排、e2e（spec §5/§6/§11/§12 的 UI 部分）。
- **占位符扫描**：无 TBD；每步给了完整代码与命令。
- **类型/命名一致**：`draft.winner`/`entries` 键为座位下标（整数）贯穿 Task 1/2；`canPatch(old,path,value,me)`、`setPath(obj,path,value)`、`patch(code,path,value)` 签名一致；新增导出并列于现有 `api`，未删除 `activeLock` 等（第二期再清）。
- **增量安全**：Task 1–4 全部只新增导出/新增路由/新增回调，不改 app.js，现有联机本期照常可用。

## 第二期预告（待本期验收后再出计划）
app.js 联机流程重构：建房→lobby；座位认领 UI + 抢座冲突提示；协作记分（赢家先定、各座各填、实时同屏、`isDraftSaveable` 亮保存、`mutate` 幂等把 `draftToRound` 结果 append 并清 draft）；顶部「N 人在玩·M 人观战」（用 `onPresence`+`observerCount/playingCount`）；玩家管理适配座位（加人/标离场腾座）；移除「允许他人修改」与记分锁；build + 多标签 e2e。
