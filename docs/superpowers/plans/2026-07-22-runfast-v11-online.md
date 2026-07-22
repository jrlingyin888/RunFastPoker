# 跑得快记分 v1.1（牌桌皮肤 + 实时联机）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 深绿牌桌毡面皮肤 + 多手机实时联机（房主可开关"允许他人修改"）+ 作废本场，保持单机模式与单文件零依赖交付不变。

**Architecture:** 皮肤为 `style.css` 全量改版（交互结构不动）。联机用 Firebase RTDB 的 REST + SSE 开放接口（不引入 SDK）：新文件 `src/sync.js` 封装匿名认证、订阅、ETag 条件写；`app.js` 引入 `sessionCtx()/commitSession()` 读写抽象，本地/联机同一套视图与结算逻辑（`logic.js` 零改动）。

**Tech Stack:** 原生 JS/CSS、Firebase Auth REST（identitytoolkit / securetoken）、RTDB REST + EventSource、ETag `if-match` 条件写、node:test。

**设计文档:** `docs/superpowers/specs/2026-07-22-runfast-v11-online-design.md`

## Global Constraints

- 运行时零依赖：不引入 Firebase SDK 或任何第三方库；交付物仍是单个 `dist/index.html`（`node build.js` 生成）。
- 本地场行为与 v1.0 完全一致（离线可用、localStorage `runfast.v1` 结构不变）。
- 联机凭证存 localStorage `runfast.sync.v1`；上次房号存 `runfast.sync.room`。
- Firebase 配置占位符：`__FB_API_KEY__` / `__FB_DB_URL__`（Task 6 由控制器填真值；`configured()` 据此判断联机是否可用）。
- 房号为 6 位数字字符串；权限语义：房主（creatorUid）全权；非房主仅 `allowEdit===true` 时可改，且永远不能结束/作废/关房/开关权限。
- 名字安全不变量不变：所有进入 db 的玩家名必须过 `validName`；联机 session 与本地同构，云端数据渲染前同样走 `esc()`。
- 测试命令 `node --test`（Node v26，不带目录参数）；每任务结束必须全绿。
- UI 中文；提交信息中文。

## 文件结构

```
src/style.css   全量替换为牌桌皮肤（类名不变，新增 .sync-bar/.sync-dot）
src/sync.js     新增：联机同步模块（全局 RunfastSync + module.exports 双兼容）
src/app.js      修改:会话读写抽象、作废本场、联机 UI 与权限门控
src/index.html  修改:script 顺序中加入 sync.js（logic → sync → share-card → app）
build.js        修改:内联清单加入 sync.js
test/sync.test.js 新增：sync.js 纯函数测试
```

---

### Task 1: 牌桌皮肤

**Files:**
- Modify: `src/style.css`（全量替换）
- Modify: `dist/index.html`（node build.js 重建）

**Interfaces:**
- Consumes: 既有类名（card/btn/btn-primary/btn-danger/btn-sm/row/pos/neg/chips/chip/on/numgrid/overlay/muted/badge/topbar/back/section-title/gap）。
- Produces: 新增类 `.sync-bar`/`.sync-dot`（Task 5 的联机状态条使用）；所有既有类的牌桌风格实现。

- [ ] **Step 1: 全量替换 `src/style.css`**

```css
:root {
  --felt-dark: #0c3b20;
  --felt: #14532d;
  --felt-light: #1b6b3a;
  --gold: #d4af37;
  --gold-soft: #f0d98c;
  --cream: #fffdf6;
  --ink: #1f2937;
  --win: #b45309;
  --lose: #047857;
}
* { margin: 0; padding: 0; box-sizing: border-box; -webkit-tap-highlight-color: transparent; }
body {
  font-family: -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif;
  background: linear-gradient(160deg, var(--felt) 0%, var(--felt-dark) 100%) fixed;
  color: var(--cream);
  min-height: 100vh;
}
body::before {
  content: "♠"; position: fixed; top: -40px; right: -30px; font-size: 220px;
  color: rgba(255,255,255,.045); pointer-events: none; z-index: 0;
}
body::after {
  content: "♥"; position: fixed; bottom: -50px; left: -30px; font-size: 240px;
  color: rgba(0,0,0,.12); pointer-events: none; z-index: 0;
}
#app { max-width: 520px; margin: 0 auto; min-height: 100vh; padding: 14px 16px calc(24px + env(safe-area-inset-bottom)); position: relative; z-index: 1; }
h1 { font-size: 24px; color: var(--gold-soft); text-shadow: 0 1px 2px rgba(0,0,0,.4); letter-spacing: 2px; }
.card { background: var(--cream); color: var(--ink); border-radius: 16px; padding: 16px; margin-bottom: 12px;
  box-shadow: 0 4px 14px rgba(0,0,0,.28), inset 0 0 0 1px rgba(212,175,55,.25); }
.btn { display: block; width: 100%; border: 0; border-radius: 14px; padding: 15px; font-size: 17px; font-weight: 600;
  background: #ece7d8; color: var(--ink); cursor: pointer; box-shadow: 0 2px 6px rgba(0,0,0,.25); }
.btn-primary { background: linear-gradient(180deg, var(--felt-light), #135231); color: var(--gold-soft);
  border: 1.5px solid var(--gold); text-shadow: 0 1px 1px rgba(0,0,0,.35); }
.btn-danger { background: #7f1d1d; color: #fecaca; }
.btn-sm { display: inline-block; width: auto; padding: 9px 14px; font-size: 14px; border-radius: 10px; box-shadow: none; border: 1px solid #d1cbb8; }
.row { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 11px 0; border-bottom: 1px dashed #d8d2c0; font-size: 16px; }
.row:last-child { border-bottom: 0; }
.pos { color: var(--win); font-weight: 800; }
.neg { color: var(--lose); font-weight: 800; }
.chips { display: flex; flex-wrap: wrap; gap: 8px; }
.chip { padding: 10px 16px; border-radius: 999px; background: #f6f1e2; border: 1.5px solid #d1cbb8; font-size: 16px; cursor: pointer; color: var(--ink); }
.chip.on { background: var(--felt-light); border-color: var(--gold); color: var(--gold-soft); font-weight: 700; }
.numgrid { display: grid; grid-template-columns: repeat(6, 1fr); gap: 6px; }
.numgrid button { padding: 12px 0; border-radius: 9px; border: 1px solid #d1cbb8; background: #fff; font-size: 17px; font-weight: 600;
  color: var(--ink); cursor: pointer; box-shadow: 0 1px 2px rgba(0,0,0,.12); }
.numgrid button.on { background: var(--felt-light); color: var(--gold-soft); border-color: var(--gold); }
.overlay { position: fixed; inset: 0; background: rgba(4,24,13,.72); display: flex; align-items: center; justify-content: center; z-index: 50; padding: 20px; }
input[type=text] { width: 100%; padding: 12px; border: 1.5px solid #d1cbb8; border-radius: 10px; font-size: 16px; background: #fff; color: var(--ink); }
.muted { color: rgba(255,253,246,.78); font-size: 13px; }
.card .muted { color: #6b7280; }
.badge { display: inline-block; padding: 3px 10px; border-radius: 6px; background: #fef3c7; color: #92400e; font-size: 12px; font-weight: 700; border: 0; cursor: pointer; }
.topbar { display: flex; align-items: center; gap: 10px; margin-bottom: 12px; }
.topbar .title { font-weight: 800; font-size: 18px; color: var(--gold-soft); text-shadow: 0 1px 2px rgba(0,0,0,.4); }
.back { border: 0; background: none; font-size: 16px; color: var(--gold-soft); padding: 4px; cursor: pointer; }
.section-title { font-weight: 700; margin-bottom: 10px; }
.gap { height: 10px; }
.sync-bar { display: flex; align-items: center; justify-content: space-between; gap: 8px; background: rgba(0,0,0,.28);
  border: 1px solid rgba(212,175,55,.4); color: var(--gold-soft); border-radius: 10px; padding: 8px 12px; margin-bottom: 12px; font-size: 14px; }
.sync-dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; background: #22c55e; margin-right: 6px; }
.sync-dot.off { background: #f59e0b; }
```

- [ ] **Step 2: 重建并验证**

Run: `node build.js && node --test`
Expected: dist 生成，13/13 全绿。
浏览器（移动视口 375×812）逐页检查：首页/开新一场/记分主页/记一局/结算页/历史——毡面底、奶白卡片、金色赢家/绿色输家、♠♥ 水印可见、无横向溢出、控制台无错误。每页截图确认对比度可读。

- [ ] **Step 3: 提交**

```bash
git add src/style.css dist
git commit -m "feat: 牌桌毡面皮肤改版"
```

---

### Task 2: 会话读写抽象与作废本场（本地）

**Files:**
- Modify: `src/app.js`

**Interfaces:**
- Consumes: 既有 `activeSession()/saveDB()/render()/go()`。
- Produces: `online` 状态对象（本任务恒 inactive，Task 5 接线）、`sessionCtx()`、
  `async commitSession(mutator)`（mutator 接收 session 并原地修改）、`App.voidSession()`。
  之后所有会话读取用 `sessionCtx()`，所有会话修改经 `commitSession`。

- [ ] **Step 1: 在 `activeSession` 定义之后加入抽象层**

```js
  // ---------- 联机状态（Task 5 接线；本地模式恒 inactive） ----------
  const online = { active: false, code: null, room: null, status: 'idle', uid: null };
  function sessionCtx() { return online.active ? online.room.session : activeSession(); }
  async function commitSession(mutator) {
    if (online.active) {
      try {
        await RunfastSync.mutate(online.code, (room) => {
          mutator(room.session);
          room.updatedAt = Date.now();
          return room;
        });
      } catch (e) { alert('同步失败，请检查网络后重试'); }
    } else {
      mutator(activeSession());
      saveDB();
      render();
    }
  }
```

- [ ] **Step 2: 把所有会话修改方法改走抽象层**

用下面的实现**整体替换** App 对象中的同名方法（读取上下文改用 `sessionCtx()`，
修改动作改经 `commitSession`；行为与 v1.0 完全一致）：

```js
    goRecord() {
      const s = sessionCtx();
      if (s.activePlayers.length < 2) { alert('在场玩家不足 2 人，请先到「玩家管理」加人'); return; }
      go({ name: 'record', participants: s.activePlayers.slice(), winner: null, cards: Object.create(null), shutoutOff: Object.create(null), editId: null, editIndex: null });
    },

    saveRound() {
      const losers = currentLosers();
      if (!view.winner || losers.some((l) => typeof l.cardsLeft !== 'number')) return;
      const winner = view.winner;
      const editId = view.editId;
      const newRound = editId ? null : { id: 'r' + Date.now(), at: new Date().toISOString(), winner, losers };
      commitSession((s) => {
        if (editId) {
          const r = s.rounds.find((x) => x.id === editId);
          if (!r) return;
          r.winner = winner;
          r.losers = losers;
        } else {
          s.rounds.push(newRound);
        }
      });
      App.goSession();
    },

    editRound(rid) {
      const s = sessionCtx();
      const i = s.rounds.findIndex((x) => x.id === rid);
      const r = s.rounds[i];
      const cards = Object.create(null), shutoutOff = Object.create(null);
      r.losers.forEach((l) => {
        cards[l.name] = l.cardsLeft;
        if (l.cardsLeft === 10 && !l.shutout) shutoutOff[l.name] = true;
      });
      go({
        name: 'record',
        participants: [r.winner, ...r.losers.map((l) => l.name)],
        winner: r.winner, cards, shutoutOff,
        editId: rid, editIndex: i + 1,
      });
    },

    deleteRound(rid) {
      if (!confirm('删除后总分将重算，确定删除这一局？')) return;
      commitSession((s) => { s.rounds = s.rounds.filter((x) => x.id !== rid); });
    },

    leave(name) {
      commitSession((s) => { s.activePlayers = s.activePlayers.filter((n) => n !== name); });
    },

    comeBack(name) {
      const s = sessionCtx();
      if (s.activePlayers.length >= 8) { alert('在场玩家已达 8 人上限'); return; }
      commitSession((x) => { x.activePlayers.push(name); });
    },

    joinPlayer() {
      const s = sessionCtx();
      const name = document.getElementById('joinName').value.trim();
      if (!validName(name)) { alert('名字需 1～8 个字，且不能含引号等特殊符号'); return; }
      if (s.players.includes(name)) { alert('这个名字本场已存在'); return; }
      if (s.activePlayers.length >= 8) { alert('在场玩家已达 8 人上限'); return; }
      if (!db.playerDirectory.includes(name)) { db.playerDirectory.push(name); saveDB(); }
      commitSession((x) => {
        x.players.push(name);
        x.activePlayers.push(name);
      });
    },

    finishSession() {
      const s = sessionCtx();
      if (!s.rounds.length) { alert('还没记过任何一局，不能结束'); return; }
      if (!confirm('结束后不能再记新局，确定结束本场吗？')) return;
      const sid = s.id;
      commitSession((x) => {
        x.status = 'finished';
        x.finishedAt = new Date().toISOString();
      });
      if (!online.active) App.goSettle(sid, 'home');
      // 联机模式：结束状态经云端推送回来后由 onRoom 快照并跳转（Task 5）
    },

    voidSession() {
      if (!confirm('作废后本场所有记录将被删除、不进历史，确定作废？')) return;
      if (online.active) { App.closeRoomVoid(); return; }  // Task 5 实现；本任务前联机不可达
      const s = activeSession();
      db.sessions = db.sessions.filter((x) => x.id !== s.id);
      saveDB();
      App.goHome();
    },
```

同时把 `VIEWS.session` / `VIEWS.record` / `VIEWS.players` 里所有
`const s = activeSession()` 改为 `const s = sessionCtx()`（各一处），
并在 `VIEWS.session` 的按钮区把两行按钮改为三个：

```js
      <div style="display:flex;gap:10px;margin-top:10px">
        <button class="btn" onclick="App.goPlayers()">玩家管理</button>
        <button class="btn" onclick="App.voidSession()">作废本场</button>
      </div>
      <div style="margin-top:10px">
        <button class="btn btn-danger" onclick="App.finishSession()">结束本场</button>
      </div>
```

注意：`App.closeRoomVoid` 在 Task 5 才定义——本任务中 `online.active` 恒为
false，该分支不可达，属预留接线，不要删除。

- [ ] **Step 3: 回归验证**

Run: `node --check src/app.js && node --test && node build.js`
浏览器（dist）全流程回归：开新一场 → 记 2 局 → 改/删一局 → 玩家管理加人离场 →
作废本场（确认后整场消失、历史无痕）→ 再开一场记 1 局 → 结束本场 → 结算页正常。
控制台无错误。

- [ ] **Step 4: 提交**

```bash
git add src/app.js dist
git commit -m "feat: 会话读写抽象与作废本场"
```

---

### Task 3: sync.js 纯逻辑（TDD）

**Files:**
- Create: `src/sync.js`
- Create: `test/sync.test.js`
- Modify: `src/index.html`（logic.js 之后加 `<script src="sync.js"></script>`）
- Modify: `build.js`（内联清单 `['logic.js', 'share-card.js', 'app.js']` 改为 `['logic.js', 'sync.js', 'share-card.js', 'app.js']`）

**Interfaces:**
- Produces: 全局 `RunfastSync`，本任务提供纯函数
  `configured()->bool`、`genRoomCode(rand?)->'6位数字'`、`validRoomCode(s)->bool`、
  `canEdit(room, uid)->bool`、`canAdmin(room, uid)->bool`、
  `applyEvent(room, path, data)->newRoom`（SSE put 事件合并，path '/' 为整体替换，子路径为定点更新，data null 为删除）。

- [ ] **Step 1: 写失败的测试 `test/sync.test.js`**

```js
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

test('configured：占位符未替换时为 false', () => {
  assert.equal(S.configured(), false);
});
```

- [ ] **Step 2: 运行确认失败**

Run: `node --test`
Expected: sync 用例 FAIL（Cannot find module '../src/sync.js'），logic 13 例仍 PASS。

- [ ] **Step 3: 创建 `src/sync.js`（纯函数部分）**

```js
// 联机同步：Firebase RTDB REST + SSE，无 SDK。
// 浏览器全局 RunfastSync；Node 下 module.exports 供纯函数测试。
var RunfastSync = (function () {
  'use strict';

  // Task 6 由控制器替换为真实值
  const FB = { apiKey: '__FB_API_KEY__', databaseURL: '__FB_DB_URL__' };
  const configured = () => !FB.apiKey.startsWith('__');

  // ---------- 纯函数 ----------
  function genRoomCode(rand) {
    const r = rand || Math.random;
    let s = '';
    for (let i = 0; i < 6; i++) s += Math.floor(r() * 10);
    return s;
  }
  const validRoomCode = (s) => typeof s === 'string' && /^[0-9]{6}$/.test(s);
  const canEdit = (room, uid) => !!room && !!uid && (room.creatorUid === uid || room.allowEdit === true);
  const canAdmin = (room, uid) => !!room && !!uid && room.creatorUid === uid;

  // SSE put 事件 → 本地房间镜像
  function applyEvent(room, path, data) {
    if (path === '/' || room == null) return data;
    const keys = path.replace(/^\//, '').split('/');
    const next = JSON.parse(JSON.stringify(room));
    let node = next;
    for (let i = 0; i < keys.length - 1; i++) node = node[keys[i]] ||= {};
    const last = keys[keys.length - 1];
    if (data === null) delete node[last];
    else node[last] = data;
    return next;
  }

  const api = { configured, genRoomCode, validRoomCode, canEdit, canAdmin, applyEvent };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  return api;
})();
```

- [ ] **Step 4: index.html 与 build.js 接线**

`src/index.html` 的 script 区改为：

```html
<script src="logic.js"></script>
<script src="sync.js"></script>
<script src="share-card.js"></script>
<script src="app.js"></script>
```

`build.js` 的清单行改为：

```js
for (const js of ['logic.js', 'sync.js', 'share-card.js', 'app.js']) {
```

- [ ] **Step 5: 运行确认通过并提交**

Run: `node --test && node build.js`
Expected: 全绿（13+7）；dist 含四段内联 script。

```bash
git add src/sync.js test/sync.test.js src/index.html build.js dist
git commit -m "feat: 联机同步模块纯逻辑与构建接线"
```

---

### Task 4: sync.js I/O 层（认证 / SSE / 条件写）

**Files:**
- Modify: `src/sync.js`

**Interfaces:**
- Consumes: Task 3 的纯函数与 FB 配置。
- Produces（Task 5 使用，全部挂在 RunfastSync 上）：
  `async signIn()->{uid}`、`getUid()->string|null`、
  `async createRoom(session)->code`、`async readRoom(code)->{data, etag}`、
  `async subscribe(code, {onRoom, onStatus, onDeleted})`、
  `async mutate(code, opFn)`（opFn(room)->room，读-改-条件写，412 自动重试 4 次）、
  `async deleteRoom(code)`、`close()`。
  onStatus 值：'connecting' | 'connected'。

- [ ] **Step 1: 在纯函数之后、api 声明之前加入 I/O 实现**

```js
  // ---------- 匿名认证 ----------
  const AUTH_KEY = 'runfast.sync.v1';
  let auth = null; // {uid, idToken, refreshToken, expiresAt}

  async function signIn() {
    if (auth) return auth;
    try { auth = JSON.parse(localStorage.getItem(AUTH_KEY) || 'null'); } catch (e) { auth = null; }
    if (auth && auth.refreshToken) {
      if (Date.now() > auth.expiresAt - 60000) await refreshIdToken();
      return auth;
    }
    const res = await fetch('https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=' + FB.apiKey, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ returnSecureToken: true }),
    });
    if (!res.ok) throw new Error('匿名登录失败');
    const d = await res.json();
    auth = { uid: d.localId, idToken: d.idToken, refreshToken: d.refreshToken, expiresAt: Date.now() + d.expiresIn * 1000 };
    localStorage.setItem(AUTH_KEY, JSON.stringify(auth));
    return auth;
  }

  async function refreshIdToken() {
    const res = await fetch('https://securetoken.googleapis.com/v1/token?key=' + FB.apiKey, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'grant_type=refresh_token&refresh_token=' + encodeURIComponent(auth.refreshToken),
    });
    if (!res.ok) { // refresh token 失效则重新匿名注册（旧身份房间将失去房主权，可接受）
      localStorage.removeItem(AUTH_KEY);
      auth = null;
      return signIn();
    }
    const d = await res.json();
    auth = { uid: d.user_id, idToken: d.id_token, refreshToken: d.refresh_token, expiresAt: Date.now() + d.expires_in * 1000 };
    localStorage.setItem(AUTH_KEY, JSON.stringify(auth));
    return auth;
  }

  async function freshToken() {
    await signIn();
    if (Date.now() > auth.expiresAt - 60000) await refreshIdToken();
    return auth.idToken;
  }

  const getUid = () => (auth ? auth.uid : null);

  // ---------- REST ----------
  const roomUrl = (code) => FB.databaseURL + '/rooms/' + code + '.json';

  async function readRoom(code) {
    const token = await freshToken();
    const res = await fetch(roomUrl(code) + '?auth=' + token, { headers: { 'X-Firebase-ETag': 'true' } });
    if (!res.ok) throw new Error('读取失败 ' + res.status);
    return { data: await res.json(), etag: res.headers.get('ETag') };
  }

  async function writeRoom(code, data, etag) {
    const token = await freshToken();
    const res = await fetch(roomUrl(code) + '?auth=' + token, {
      method: data === null ? 'DELETE' : 'PUT',
      headers: { 'Content-Type': 'application/json', 'if-match': etag, 'X-Firebase-ETag': 'true' },
      body: data === null ? undefined : JSON.stringify(data),
    });
    if (res.status === 412) return { conflict: true };
    if (res.status === 401 || res.status === 403) throw new Error('没有修改权限');
    if (!res.ok) throw new Error('写入失败 ' + res.status);
    return { conflict: false };
  }

  // 读-改-条件写；412 重试
  async function mutate(code, opFn) {
    for (let i = 0; i < 4; i++) {
      const { data, etag } = await readRoom(code);
      if (data === null) throw new Error('房间不存在或已关闭');
      const next = opFn(JSON.parse(JSON.stringify(data)));
      const w = await writeRoom(code, next, etag);
      if (!w.conflict) return next;
    }
    throw new Error('操作冲突，请重试');
  }

  async function createRoom(session) {
    await signIn();
    for (let i = 0; i < 5; i++) {
      const code = genRoomCode();
      const { data, etag } = await readRoom(code);
      if (data !== null) continue; // 房号被占用，换一个
      const room = { creatorUid: auth.uid, allowEdit: false, updatedAt: Date.now(), session };
      const w = await writeRoom(code, room, etag);
      if (!w.conflict) return code;
    }
    throw new Error('建房失败，请重试');
  }

  async function deleteRoom(code) {
    for (let i = 0; i < 4; i++) {
      const { data, etag } = await readRoom(code);
      if (data === null) return;
      const w = await writeRoom(code, null, etag);
      if (!w.conflict) return;
    }
    throw new Error('关闭房间失败，请重试');
  }

  // ---------- SSE 订阅 ----------
  let es = null, currentCode = null, cb = null, room = null, resubTimer = null;

  async function subscribe(code, callbacks) {
    close();
    currentCode = code;
    cb = callbacks;
    await openStream();
  }

  async function openStream() {
    if (!currentCode) return;
    const token = await freshToken();
    if (cb.onStatus) cb.onStatus('connecting');
    es = new EventSource(roomUrl(currentCode) + '?auth=' + token);
    es.addEventListener('put', onEvt);
    es.addEventListener('patch', onEvt);
    es.addEventListener('auth_revoked', () => { es.close(); openStream(); });
    es.onopen = () => { if (cb.onStatus) cb.onStatus('connected'); };
    es.onerror = () => { if (cb.onStatus) cb.onStatus('connecting'); };
    clearTimeout(resubTimer);
    resubTimer = setTimeout(() => { if (es) { es.close(); openStream(); } }, 50 * 60 * 1000);
  }

  function onEvt(e) {
    const { path, data } = JSON.parse(e.data);
    room = applyEvent(room, path, data);
    if (room === null) { if (cb.onDeleted) cb.onDeleted(); return; }
    if (cb.onRoom) cb.onRoom(room);
  }

  function close() {
    clearTimeout(resubTimer);
    if (es) es.close();
    es = null; room = null; currentCode = null; cb = null;
  }
```

并把 api 行替换为：

```js
  const api = { configured, genRoomCode, validRoomCode, canEdit, canAdmin, applyEvent,
    signIn, getUid, createRoom, readRoom, subscribe, mutate, deleteRoom, close };
```

- [ ] **Step 2: 验证并提交**

Run: `node --check src/sync.js && node --test && node build.js`
Expected: 语法 OK；纯函数测试仍全绿（I/O 部分无配置不可运行，Task 7 真库验证）。

```bash
git add src/sync.js dist
git commit -m "feat: 联机同步 IO 层——匿名认证、SSE 订阅与 ETag 条件写"
```

---

### Task 5: 联机 UI 集成与权限门控

**Files:**
- Modify: `src/app.js`

**Interfaces:**
- Consumes: Task 2 的 `online/sessionCtx/commitSession`、Task 4 的 RunfastSync 全接口。
- Produces: `App.goOnlineSetup/goJoinRoom/joinRoomSubmit/enterRoom/leaveRoom/toggleAllowEdit/invite/closeRoom/closeRoomVoid/rejoinRoom`、
  `VIEWS.joinRoom`、`syncBar()`、`enterRoom(code)`、`leaveOnline()`、`snapshotOnlineFinished(session)`。
  localStorage `runfast.sync.room` 存 `{code}`。

- [ ] **Step 1: 首页加入联机入口与"回到房间"**

`VIEWS.home` 整体替换为：

```js
  VIEWS.home = () => {
    const act = activeSession();
    let lastRoom = null;
    try { lastRoom = JSON.parse(localStorage.getItem('runfast.sync.room') || 'null'); } catch (e) { /* 忽略 */ }
    return `
      <h1 style="text-align:center;margin:20px 0 18px">🃏 跑得快记分</h1>
      ${lastRoom && RunfastSync.configured() ? `<button class="btn btn-primary" onclick="App.rejoinRoom()">回到联机房间（${esc(lastRoom.code)}）</button><div class="gap"></div>` : ''}
      ${act
        ? `<button class="btn btn-primary" onclick="App.goSession()">继续本场（${act.players.map(esc).join('、')}）</button>`
        : `<button class="btn btn-primary" onclick="App.goSetup()">开新一场（本地）</button>`}
      <div class="gap"></div>
      <div style="display:flex;gap:10px">
        <button class="btn" onclick="App.goOnlineSetup()">创建联机场</button>
        <button class="btn" onclick="App.goJoinRoom()">加入联机场</button>
      </div>
      <div class="gap"></div>
      <button class="btn" onclick="App.goHistory()">历史记录</button>
      <div class="gap"></div>
      <div class="card">
        <div class="muted" style="margin-bottom:10px">数据保存在本手机浏览器里，换手机或清缓存前请先导出</div>
        <button class="btn btn-sm" onclick="App.exportData()">导出备份</button>
        <button class="btn btn-sm" onclick="App.importData()">导入备份</button>
      </div>`;
  };
```

- [ ] **Step 2: 加入 joinRoom 视图与联机辅助函数**

在 `VIEWS.history` 之后新增：

```js
  // ---------- 联机 ----------
  VIEWS.joinRoom = () => `
    ${topbar('加入联机场', 'App.goHome()')}
    <div class="card">
      <div class="section-title">输入 6 位房号</div>
      <input type="text" id="roomCode" inputmode="numeric" maxlength="6" placeholder="如 314159">
      <div class="gap"></div>
      <button class="btn btn-primary" onclick="App.joinRoomSubmit()">进入房间</button>
      <div class="muted" style="margin-top:10px">房号问房主要，或直接点房主发到群里的链接。</div>
    </div>`;

  function syncBar() {
    if (!online.active) return '';
    const admin = RunfastSync.canAdmin(online.room, online.uid);
    return `<div class="sync-bar">
      <span><span class="sync-dot ${online.status === 'connected' ? '' : 'off'}"></span>房号 ${esc(online.code)} · ${online.status === 'connected' ? '已连接' : '连接中…'}</span>
      <span>
        ${admin ? `<button class="btn btn-sm" onclick="App.toggleAllowEdit()">${online.room.allowEdit ? '✅ 允许他人修改' : '🔒 仅房主可改'}</button>` : ''}
        <button class="btn btn-sm" onclick="App.invite()">邀请</button>
        <button class="btn btn-sm" onclick="App.leaveRoom()">退出</button>
      </span>
    </div>`;
  }

  async function enterRoom(code) {
    try {
      await RunfastSync.signIn();
      online.uid = RunfastSync.getUid();
      const { data } = await RunfastSync.readRoom(code);
      if (data === null) { alert('房号不存在或已关闭'); return; }
      online.active = true;
      online.code = code;
      online.room = data;
      online.status = 'connecting';
      localStorage.setItem('runfast.sync.room', JSON.stringify({ code }));
      await RunfastSync.subscribe(code, {
        onRoom(room) {
          online.room = room;
          if (room.session.status === 'finished') { snapshotOnlineFinished(room.session); return; }
          if (['session', 'record', 'players'].includes(view.name)) render();
        },
        onStatus(s) {
          online.status = s;
          if (['session', 'players'].includes(view.name)) render();
        },
        onDeleted() {
          const wasAdmin = RunfastSync.canAdmin(online.room, online.uid);
          leaveOnline();
          if (!wasAdmin) alert('房间已被房主关闭');
          go({ name: 'home' });
        },
      });
      go({ name: 'session' });
    } catch (e) { alert('进入房间失败：' + e.message); }
  }

  function leaveOnline() {
    RunfastSync.close();
    online.active = false;
    online.code = null;
    online.room = null;
    online.status = 'idle';
    localStorage.removeItem('runfast.sync.room');
  }

  function snapshotOnlineFinished(session) {
    if (!db.sessions.some((x) => x.id === session.id)) {
      db.sessions.push(JSON.parse(JSON.stringify(session)));
      saveDB();
    }
    const code = online.code;
    const admin = RunfastSync.canAdmin(online.room, online.uid);
    RunfastSync.close();
    online.active = false;
    online.status = 'idle';
    localStorage.removeItem('runfast.sync.room');
    // 保留 code/room 供房主关闭房间
    online.code = code;
    online.room = admin ? online.room : null;
    go({ name: 'settle', sid: session.id, from: 'home' });
  }
```

- [ ] **Step 3: 视图权限门控**

`VIEWS.session` 整体替换为（在 v1.1 Task 2 版本基础上加 syncBar 与门控）：

```js
  VIEWS.session = () => {
    const s = sessionCtx();
    if (!s) return VIEWS.home();
    const editable = !online.active || RunfastSync.canEdit(online.room, online.uid);
    const admin = !online.active || (online.room && RunfastSync.canAdmin(online.room, online.uid));
    const net = L.sessionNet(s).slice().sort((a, b) => b.fen - a.fen);
    return `
      ${topbar(`已记 ${s.rounds.length} 局 · ${yuan(s.pricePerCardFen)}元/张`, online.active ? '' : 'App.goHome()')}
      ${syncBar()}
      <div class="card">
        ${net.map((p) => `<div class="row">
          <span>${esc(p.name)}${s.activePlayers.includes(p.name) ? '' : ' <span class="muted">（已离场）</span>'}</span>
          <span class="${cls(p.fen)}">${p.cards > 0 ? '+' : ''}${p.cards} 张 · ${signYuan(p.fen)} 元</span>
        </div>`).join('')}
      </div>
      ${editable ? `<button class="btn btn-primary" style="font-size:20px;padding:18px" onclick="App.goRecord()">📝 记一局</button>` : '<div class="muted" style="text-align:center;margin:6px 0">👀 观战中——房主开启「允许他人修改」后你才能记分</div>'}
      ${editable ? `<div style="display:flex;gap:10px;margin-top:10px">
        <button class="btn" onclick="App.goPlayers()">玩家管理</button>
        ${admin ? `<button class="btn" onclick="App.voidSession()">作废本场</button>` : ''}
      </div>` : ''}
      ${admin ? `<div style="margin-top:10px">
        <button class="btn btn-danger" onclick="App.finishSession()">结束本场</button>
      </div>` : ''}
      <div class="card" style="margin-top:12px">
        ${s.rounds.map((r, i) => roundRow(s, r, i, !editable)).join('')
          || '<div class="muted">还没有记录' + (editable ? '，点上面「记一局」开始' : '') + '</div>'}
      </div>`;
  };
```

`VIEWS.settle` 的按钮区在「查看每局明细」按钮之后追加（房主关房入口）：

```js
      ${online.code && online.room && RunfastSync.canAdmin(online.room, online.uid) ? `<div class="gap"></div>
      <button class="btn" onclick="App.closeRoom()">关闭房间（牌友都保存后再关）</button>` : ''}
```

- [ ] **Step 4: App 方法与 ?room= 自动进房**

App 对象新增：

```js
    goOnlineSetup() {
      if (!RunfastSync.configured()) { alert('联机功能尚未配置，请先完成 Firebase 配置'); return; }
      if (activeSession()) { alert('本地还有一场没打完，请先结束或作废它'); return; }
      go({ name: 'setup', sel: [], price: '1', manage: false, mode: 'online' });
    },

    goJoinRoom() {
      if (!RunfastSync.configured()) { alert('联机功能尚未配置，请先完成 Firebase 配置'); return; }
      go({ name: 'joinRoom' });
    },

    joinRoomSubmit() {
      const code = document.getElementById('roomCode').value.trim();
      if (!RunfastSync.validRoomCode(code)) { alert('房号是 6 位数字'); return; }
      enterRoom(code);
    },

    rejoinRoom() {
      let saved = null;
      try { saved = JSON.parse(localStorage.getItem('runfast.sync.room') || 'null'); } catch (e) { /* 忽略 */ }
      if (saved && RunfastSync.validRoomCode(saved.code)) enterRoom(saved.code);
      else { localStorage.removeItem('runfast.sync.room'); render(); }
    },

    leaveRoom() {
      if (!confirm('退出房间？（随时可用房号再进来）')) return;
      leaveOnline();
      App.goHome();
    },

    async toggleAllowEdit() {
      try {
        await RunfastSync.mutate(online.code, (room) => {
          room.allowEdit = !room.allowEdit;
          room.updatedAt = Date.now();
          return room;
        });
      } catch (e) { alert('操作失败：' + e.message); }
    },

    async invite() {
      const link = location.origin + location.pathname + '?room=' + online.code;
      const ok = await copyToClipboard('来跑得快记分房间围观/记分：' + link + '（房号 ' + online.code + '）');
      alert(ok ? '邀请链接已复制，发到群里吧' : '复制失败，请手动把房号告诉牌友：' + online.code);
    },

    async closeRoom() {
      if (!confirm('关闭后房间从云端删除（战绩已存进各自手机历史），确定？')) return;
      try {
        await RunfastSync.deleteRoom(online.code);
        online.code = null; online.room = null;
        render();
      } catch (e) { alert('关闭失败：' + e.message); }
    },

    async closeRoomVoid() {
      try {
        const code = online.code;
        leaveOnline();
        await RunfastSync.deleteRoom(code);
        App.goHome();
      } catch (e) { alert('作废失败：' + e.message); }
    },
```

`startSession()` 整体替换（本地/联机分支）：

```js
    async startSession() {
      const priceFen = L.yuanToFen(document.getElementById('price').value.trim());
      if (view.sel.length < 2 || view.sel.length > 8) { alert('请选择 2～8 名玩家'); return; }
      if (Number.isNaN(priceFen)) { alert('单价格式不对，例：1 或 0.5'); return; }
      const session = {
        id: 's' + Date.now(),
        createdAt: new Date().toISOString(),
        pricePerCardFen: priceFen,
        players: view.sel.slice(),
        activePlayers: view.sel.slice(),
        status: 'active',
        rounds: [],
      };
      if (view.mode === 'online') {
        try {
          const code = await RunfastSync.createRoom(session);
          await enterRoom(code);
        } catch (e) { alert('建房失败：' + e.message); }
        return;
      }
      if (activeSession()) { App.goSession(); return; }
      db.sessions.push(session);
      saveDB();
      App.goSession();
    },
```

IIFE 末尾 `render();` 之前加自动进房：

```js
  const roomParam = location.search.match(/[?&]room=([0-9]{6})\b/);
  if (roomParam && RunfastSync.configured()) enterRoom(roomParam[1]);
```

- [ ] **Step 5: 验证（无后端 UI 态）并提交**

Run: `node --check src/app.js && node --test && node build.js`
浏览器（dist，未配置状态）：首页出现「创建联机场/加入联机场」；点击均弹"联机功能尚未配置"；
本地场全流程回归一遍无回归；控制台无错误。

```bash
git add src/app.js dist
git commit -m "feat: 联机 UI 集成与权限门控"
```

---

### Task 6: Firebase 配置（控制器任务，需用户 Chrome 协助）

**Files:**
- Modify: `src/sync.js`（FB 常量填真值）

此任务由控制器（主会话）执行，不派子代理：

- [ ] **Step 1**: 通过 claude-in-chrome 打开 console.firebase.google.com，请用户登录 Google 账号。
- [ ] **Step 2**: 新建独立项目（如 `runfast-scorer`，关闭 Analytics）；与用户既有 IPA 项目互不影响。
- [ ] **Step 3**: Build → Realtime Database → 创建（区域选 asia-southeast1）→ Rules 页贴入设计文档 §5 的规则并 Publish。
- [ ] **Step 4**: Build → Authentication → Sign-in method → 启用 Anonymous。
- [ ] **Step 5**: 项目设置 → 取 Web API Key 与 RTDB URL；Edit 写入 `src/sync.js` 的 FB 常量；`node build.js`；提交 `feat: 写入 Firebase 配置`。

---

### Task 7: 双标签真库端到端

**Files:** 无代码变更（发现 bug 则修）

浏览器两个标签页（同机两标签共享 localStorage ⇒ 共享匿名身份；为模拟两台设备，
标签 B 用隐身窗口或在 devtools 里清 `runfast.sync.v1` 后刷新拿新身份——执行时用
Browser pane 的 tabs_create 开第二个 tab，并在 B 里 `localStorage.removeItem('runfast.sync.v1')` 后刷新）：

- [ ] A 创建联机场（张三/李四，1 元）→ 显示房号、状态条"已连接"。
- [ ] B 用房号进房 → 实时看到同一积分榜；B 无「记一局/结束/作废」（观战提示可见）。
- [ ] A 记一局 → B 秒级刷新出现该局。
- [ ] A 开「允许他人修改」→ B 立即出现记分按钮；B 记一局 → A 实时看到。
- [ ] B 尝试越权：在 B 的 console 直接调 `RunfastSync.mutate(code, r => { r.allowEdit = true; ... })` 篡改权限 → 云端规则拒绝（写失败）。
- [ ] A 关「允许他人修改」→ B 按钮消失；A 结束本场 → A、B 都自动存历史并跳到结算页；B 历史里能看到该场。
- [ ] A 结算页「关闭房间」→ B 若重进该房号提示不存在。
- [ ] 再建一房验证「作废本场」：A 作废 → B 收到"房间已被房主关闭"回首页，双方历史无痕。
- [ ] ?room= 链接自动进房、退出房间、回到联机房间按钮各验一次。
- [ ] 全程 console 无错误；`node --test` 全绿。

---

### Task 8: 回归、部署与交付

- [ ] `node build.js && node --test`；本地场全流程回归（含备份导入导出）。
- [ ] 合并到 main；`git subtree split --prefix dist -b gh-pages && git push -f origin gh-pages`；验证线上 URL。
- [ ] 交付说明：联机用法（创建/邀请/权限开关/结束与关房）、Firebase 免费额度说明、大陆网络限制提醒。

## Self-Review 结论

- 覆盖：设计 §2（Task 5）、§3（Task 5 门控 + §5 规则 Task 6）、§4（Task 3/4）、§6（Task 1）、§7（Task 6）、§9（Task 3 测试 + Task 7 e2e）、作废本场（Task 2/5）。
- 类型一致：`RunfastSync` API 名称在 Task 3/4/5 一致；`online` 形状 Task 2/5 一致；`commitSession(mutator)` 签名一致。
- 占位符：FB 配置占位符是设计内容（Task 6 填），非计划漏洞。
