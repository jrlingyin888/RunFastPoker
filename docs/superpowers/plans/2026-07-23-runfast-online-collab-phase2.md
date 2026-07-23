# 联机协作重构 · 第二期：app.js 大厅 + 协作记分 + 人数 + 清旧锁 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把联机前端从"一人记、别人锁"改成"按座位认领 → 大厅满员开局 → 协作式记分（各填各的、实时同屏）"，并显示「在玩/观战」人数、移除旧的「允许他人修改」开关与记分锁。

**Architecture:** 复用第一期地基（`RunfastSync.patch/isDraftSaveable/draftToRound/observerCount/playingCount` + `onPresence`）。联机房间新增 `phase`(`lobby|playing|finished`)、`seats:[{name,claimedBy}]`、`draft`。`app.js` 联机流程：建房→`lobby` 视图（认领座位、房主满员才能开局）→`playing`（记分主页内联协作草稿：赢家先定、各座各填、`isDraftSaveable` 亮保存、`mutate` 幂等把 `draftToRound` 结果 append 并清 draft）→`finished`。本地单机流程完全不变。

**Tech Stack:** 原生 JS（无框架），`RunfastSync` 同步层，`node --test`（结算/纯 helper 已覆盖），浏览器多标签 e2e。

## Global Constraints

- **本地单机流程不变**：`VIEWS.setup`（非 online 模式）→`VIEWS.session`（本地分支）→`VIEWS.record`→`saveRound`（本地分支）→结算；`logic.js` 结算不变。
- **联机房间模型**：`{creatorUid, phase, seats:[{name,claimedBy}], draft, updatedAt, session}`。`draft={winner:<座位下标>|null, entries:{<下标>:{cardsLeft,shutout}}}`。`seats[i].name===session.players[i]`，座位只增不删。
- **字段级写**：认领/填格/定赢家/确认一律用 `RunfastSync.patch(code, path, value)`；提交成局用 `RunfastSync.mutate`（读-改-写，幂等，仅房主 PUT）。
- **权限**（服务器第一期已强制）：认领空座 CAS；填/确认 `draft/entries/<idx>` 仅持座者或房主；定赢家/清草稿需持座或房主；phase/加人/离场/写 `session.rounds`（含提交本局、改删局）仅房主。
- **移除**：`editing` 记分锁（`otherEditing/acquireEditLock/releaseEditLock/activeLock` 使用）、旧 `cancelRecord` 的释放锁逻辑。
- **构建**：改完 `node build.js` 重建 `dist/index.html`；测试 `node --test`。

> **设计调整（2026-07-23 用户意见，覆盖原 Task 3/4 的"任一端点保存"与"删除 allowEdit"）：**
> 1. **确认制 + 自动记局**：`draft.entries[i]={cardsLeft,shutout,confirmed}`。各输家各自填「剩几张」后点「确认这格」（`draftConfirm` PATCH 切 `confirmed`）；改数即回未确认。**赢家已定且全部输家 confirmed → 房主端 `onRoom` 里 `maybeAutoSaveDraft` 自动提交本局**（只有房主能写 `session.rounds`，规避非房主 PUT 403；`draftAllConfirmed` 二次校验 + `_autoSaving` 锁保证幂等）。取消原 `saveDraft` 手动保存按钮。
> 2. **保留 `allowEdit`**：`createRoom` 仍写 `allowEdit:false`；`toggleAllowEdit` 保留。含义改为"**是否允许非房主修改已保存的一局**"——`editRound/deleteRound/commitSession` 用 `RunfastSync.canEdit`（房主 or `allowEdit`）门控；记分阶段的协作草稿与此无关。

---

### Task 1: 联机房间建为大厅 + app 联机派生态与阶段路由

**Files:**
- Modify: `src/sync.js`（`createRoom` 建 lobby+seats，去 allowEdit）
- Modify: `src/app.js`（`online` 加 presence；派生 helper；`enterRoom` 按 phase 路由；`onPresence` 接线）

**Interfaces:**
- Produces（供后续任务）：
  - `RunfastSync.createRoom(session)` 返回 code，房间为 `{creatorUid, phase:'lobby', seats:session.players.map(n=>({name:n,claimedBy:null})), draft:null, updatedAt, session}`。
  - app 内：`isOwner()`、`mySeatIdx()->number[]`、`isSeated()->bool`、`activeIdx()->number[]`（name∈activePlayers 的座位下标）、`online.presence:string[]`。

- [ ] **Step 1: 改 sync.createRoom 建大厅房**

`src/sync.js` 里把 `createRoom` 整体替换为：
```js
  async function createRoom(session) {
    await signIn();
    for (let i = 0; i < 5; i++) {
      const code = genRoomCode();
      const { data } = await readRoom(code);
      if (data !== null) continue; // 房号被占用，换一个
      const room = {
        creatorUid: deviceId,
        phase: 'lobby',
        seats: session.players.map((n) => ({ name: n, claimedBy: null })),
        draft: null,
        updatedAt: Date.now(),
        session,
      };
      await writeRoom(code, room);
      return code;
    }
    throw new Error('建房失败，请重试');
  }
```

- [ ] **Step 2: app.js 联机派生态与 helper**

`src/app.js`：把 `const online = { active: false, code: null, room: null, status: 'idle', uid: null };` 改为带 presence：
```js
  const online = { active: false, code: null, room: null, status: 'idle', uid: null, presence: [] };
```
在 `sessionCtx` 之后加派生 helper：
```js
  const isOwner = () => !!(online.room && online.room.creatorUid === online.uid);
  const seatsOf = () => (online.room && online.room.seats) || [];
  const mySeatIdx = () => seatsOf().reduce((a, s, i) => (s.claimedBy === online.uid ? (a.push(i), a) : a), []);
  const isSeated = () => mySeatIdx().length > 0;
  const activeIdx = () => {
    const s = online.room && online.room.session;
    if (!s) return [];
    return seatsOf().reduce((a, seat, i) => (s.activePlayers.includes(seat.name) ? (a.push(i), a) : a), []);
  };
  const allClaimed = () => seatsOf().length > 0 && seatsOf().every((s) => s.claimedBy);
```

- [ ] **Step 3: enterRoom 按 phase 路由 + onPresence**

把 `enterRoom` 里 `await RunfastSync.subscribe(code, {...})` 到 `go({ name: 'session' });` 整段替换为：
```js
      await RunfastSync.subscribe(code, {
        onRoom(room) {
          online.room = room;
          if (room.session.status === 'finished') { snapshotOnlineFinished(room.session); return; }
          routeByPhase();
        },
        onStatus(st) {
          online.status = st;
          if (['lobby', 'session'].includes(view.name)) render();
        },
        onPresence(devices) {
          online.presence = devices;
          if (['lobby', 'session'].includes(view.name)) render();
        },
        onDeleted() {
          const wasOwner = isOwner();
          leaveOnline();
          if (!wasOwner) alert('房间已被房主关闭');
          go({ name: 'home' });
        },
      });
      routeByPhase();
```
并在 `enterRoom` 函数之后加 `routeByPhase`：
```js
  // 按房间阶段决定当前应在哪个视图（大厅/记分/结算），并在原地更新
  function routeByPhase() {
    const phase = online.room.phase;
    if (phase === 'lobby') {
      if (view.name !== 'lobby') go({ name: 'lobby' }); else render();
    } else if (phase === 'playing') {
      if (view.name !== 'session') go({ name: 'session' }); else render();
    }
  }
```

- [ ] **Step 4: 构建自检（本步不改行为，编译通过即可）**

Run: `node build.js && node --test 2>&1 | grep -E "^ℹ (tests|pass|fail)"`
Expected: 构建成功；`node --test` 仍全绿（本地/后端未受影响）。

- [ ] **Step 5: 提交**

```bash
git add src/sync.js src/app.js dist/index.html
git commit -m "feat(联机2期): 建房为大厅+座位；app 派生态与 phase 路由 + onPresence"
```

---

### Task 2: 大厅视图 + 认领/退座 + 满员开局 + 顶部人数

**Files:**
- Modify: `src/app.js`（新增 `VIEWS.lobby`、`onlineBar()`、`App.claimSeat/releaseSeat/startPlaying`）

**Interfaces:**
- Consumes: Task 1 的派生 helper、`RunfastSync.patch`、`observerCount/playingCount`。
- Produces: 大厅可认领入座、房主满员可「开始记分」把 phase 改 `playing`。

- [ ] **Step 1: 顶部人数条 onlineBar()**

在 `syncBar` 函数**之后**加（syncBar 将于 Task 4 删除，这里先新增独立函数）：
```js
  function onlineBar() {
    if (!online.active) return '';
    const playing = RunfastSync.playingCount(seatsOf());
    const watching = RunfastSync.observerCount(online.presence, seatsOf());
    const dot = online.status === 'connected' ? '' : 'off';
    return `<div class="sync-bar">
      <span><span class="sync-dot ${dot}"></span>房号 ${esc(online.code)} · ${playing} 人在玩 · ${watching} 人观战</span>
      <span>
        <button class="btn btn-sm" onclick="App.invite()">邀请</button>
        <button class="btn btn-sm" onclick="App.leaveRoom()">退出</button>
      </span>
    </div>`;
  }
```

- [ ] **Step 2: 大厅视图 VIEWS.lobby**

在 `VIEWS.joinRoom` 之后加：
```js
  VIEWS.lobby = () => {
    const seats = seatsOf();
    const s = online.room.session;
    const mine = new Set(mySeatIdx());
    const owner = isOwner();
    return `
      ${topbar('等待入座 · ' + yuan(s.pricePerCardFen) + '元/张', '')}
      ${onlineBar()}
      <div class="card">
        <div class="section-title">选个座位（点灰色名字入座；没带手机的人可由你替 TA 入座）</div>
        <div class="chips">
          ${seats.map((seat, i) => seat.claimedBy
            ? `<button class="chip on" ${mine.has(i) ? `onclick="App.releaseSeat(${i})"` : 'disabled'}>${esc(seat.name)}${mine.has(i) ? '（我，点退座）' : ' ✓'}</button>`
            : `<button class="chip" onclick="App.claimSeat(${i})">${esc(seat.name)}</button>`).join('')}
        </div>
        <div class="muted" style="margin-top:10px">灰色=空位，高亮=已入座。所有座位坐满后房主才能开始。</div>
      </div>
      ${owner
        ? `<button class="btn btn-primary" ${allClaimed() ? '' : 'disabled style="opacity:.4"'} onclick="App.startPlaying()">
             ${allClaimed() ? '开始记分' : '等所有人入座…'}</button>`
        : `<div class="muted" style="text-align:center;margin:10px 0">等房主开始…先选好你的座位</div>`}`;
  };
```

- [ ] **Step 3: 认领/退座/开局 handler**

在 `App` 对象里（`joinRoomSubmit` 附近）加：
```js
    async claimSeat(i) {
      try { await RunfastSync.patch(online.code, '/seats/' + i + '/claimedBy', online.uid); }
      catch (e) { alert(e.message); } // 403 = 座位已被占，onRoom 会刷新成最新
    },
    async releaseSeat(i) {
      try { await RunfastSync.patch(online.code, '/seats/' + i + '/claimedBy', null); }
      catch (e) { alert(e.message); }
    },
    async startPlaying() {
      if (!isOwner()) { alert('只有房主可以开始'); return; }
      if (!allClaimed()) { alert('还有空座，等大家都入座再开始'); return; }
      try { await RunfastSync.patch(online.code, '/phase', 'playing'); }
      catch (e) { alert('开始失败：' + e.message); }
    },
```

- [ ] **Step 4: 构建 + 手动 e2e（认领与开局）**

Run: `node build.js`
用两标签（各设不同 `localStorage['runfast.device']`）连本机 server 建房，验证：房主建房→大厅；两端各点自己名字入座变高亮、他人座位灰/禁点；未满员时「开始记分」禁用；满员后房主可开始 → 两端都进记分页（`phase=playing`）。顶部显示「N 人在玩·M 人观战」。

- [ ] **Step 5: 提交**

```bash
git add src/app.js dist/index.html
git commit -m "feat(联机2期): 大厅认领/退座/满员开局 + 顶部在玩·观战人数"
```

---

### Task 3: 记分主页内联协作草稿（赢家先定 → 各座各填 → 幂等保存）

**Files:**
- Modify: `src/app.js`（`VIEWS.session` 联机分支改为内联草稿；新增 `App.draftPickWinner/draftFill/draftToggleShutout/saveDraft`）

**Interfaces:**
- Consumes: `RunfastSync.patch`、`isDraftSaveable`、`draftToRound`、`mutate`、`activeIdx/mySeatIdx/isOwner`。
- Produces: playing 阶段协作记一局；本地/结算/历史不变。

- [ ] **Step 1: 记分主页联机分支改内联草稿**

把 `VIEWS.session` 整体替换为（本地分支保持原逻辑，联机分支走草稿）：
```js
  VIEWS.session = () => {
    const s = sessionCtx();
    if (!s) return VIEWS.home();
    const net = L.sessionNet(s).slice().sort((a, b) => b.fen - a.fen);
    const scoreCard = `<div class="card">
      ${net.map((p) => `<div class="row">
        <span>${esc(p.name)}${s.activePlayers.includes(p.name) ? '' : ' <span class="muted">（已离场）</span>'}</span>
        <span class="${cls(p.fen)}">${p.cards > 0 ? '+' : ''}${p.cards} 张 · ${signYuan(p.fen)} 元</span>
      </div>`).join('')}</div>`;
    const roundsCard = `<div class="card" style="margin-top:12px">
      ${s.rounds.map((r, i) => roundRow(s, r, i, !online.active ? false : !isOwner())).join('')
        || '<div class="muted">还没有记录' + (online.active ? '，在上面记这一局' : '，点上面「记一局」开始') + '</div>'}</div>`;

    if (online.active) {
      return `
        ${topbar('已记 ' + s.rounds.length + ' 局 · ' + yuan(s.pricePerCardFen) + '元/张', '')}
        ${onlineBar()}
        ${scoreCard}
        ${draftCard()}
        ${isOwner() ? `<div style="display:flex;gap:10px;margin-top:10px">
          <button class="btn" onclick="App.goPlayers()">玩家管理</button>
          <button class="btn" onclick="App.voidSession()">作废本场</button>
        </div>
        <div style="margin-top:10px"><button class="btn btn-danger" onclick="App.finishSession()">结束本场</button></div>` : ''}
        ${roundsCard}`;
    }
    // 本地单机（原逻辑）
    return `
      ${topbar('已记 ' + s.rounds.length + ' 局 · ' + yuan(s.pricePerCardFen) + '元/张', 'App.goHome()')}
      ${scoreCard}
      <button class="btn btn-primary" style="font-size:20px;padding:18px" onclick="App.goRecord()">📝 记一局</button>
      <div style="display:flex;gap:10px;margin-top:10px">
        <button class="btn" onclick="App.goPlayers()">玩家管理</button>
        <button class="btn" onclick="App.voidSession()">作废本场</button>
      </div>
      <div style="margin-top:10px"><button class="btn btn-danger" onclick="App.finishSession()">结束本场</button></div>
      ${roundsCard}`;
  };
```

- [ ] **Step 2: 协作草稿卡片 draftCard()**

在 `VIEWS.session` 之后加：
```js
  // 联机协作草稿：赢家先定 → 各座各填 → 全部填齐后谁都能点保存
  function draftCard() {
    const room = online.room;
    const seats = seatsOf();
    const s = room.session;
    const idxs = activeIdx();                 // 本局参与的座位下标
    const draft = room.draft || { winner: null, entries: {} };
    const mine = new Set(mySeatIdx());
    const owner = isOwner();
    const canFill = (i) => mine.has(i) || owner;

    // 1) 谁赢了
    if (draft.winner == null) {
      return `<div class="card">
        <div class="section-title">这一局 · 谁赢了？（赢的人点自己）</div>
        <div class="chips">${idxs.map((i) =>
          `<button class="chip" ${canFill(i) || true ? '' : ''} onclick="App.draftPickWinner(${i})">${esc(seats[i].name)}</button>`).join('')}</div>
        <div class="muted" style="margin-top:8px">${isSeated() || owner ? '' : '观战中，看大家记分即可'}</div>
      </div>`;
    }

    // 2) 各座各填
    const losers = idxs.filter((i) => i !== draft.winner);
    const rows = losers.map((i) => {
      const e = draft.entries[i];
      const filled = e && typeof e.cardsLeft === 'number';
      if (!canFill(i)) {
        return `<div class="row"><span>${esc(seats[i].name)}</span>
          <span class="muted">${filled ? (e.cardsLeft + ' 张' + (e.shutout ? '（全关）' : '')) : '填写中…'}</span></div>`;
      }
      const v = filled ? e.cardsLeft : -1;
      const shutBadge = v === 10
        ? `<button class="badge" ${e.shutout ? '' : 'style="background:#e5e7eb;color:#374151"'} onclick="App.draftToggleShutout(${i})">${e.shutout ? '全关 ×2（点此取消）' : '全关已取消（点此恢复）'}</button>`
        : '';
      return `<div class="card">
        <div class="section-title">${esc(seats[i].name)}${mine.has(i) ? '（我）' : '（代填）'} 剩几张？ ${shutBadge}</div>
        <div class="numgrid">${[0,1,2,3,4,5,6,7,8,9,10].map((k) =>
          `<button class="${v === k ? 'on' : ''}" onclick="App.draftFill(${i},${k})">${k}</button>`).join('')}</div>
      </div>`;
    }).join('');

    const saveable = RunfastSync.isDraftSaveable(draft, idxs);
    return `<div class="card">
      <div class="section-title">这一局 · ${esc(seats[draft.winner].name)} 赢${(isSeated() || owner) ? ' <button class="btn btn-sm" onclick="App.draftPickWinner(null)">改赢家</button>' : ''}</div>
      <div class="muted">赢家 0 张；其余每人填自己那格，实时同步。</div>
    </div>
    ${rows}
    <button class="btn btn-primary" ${saveable && (isSeated() || owner) ? '' : 'disabled style="opacity:.4"'} onclick="App.saveDraft()">✅ 全部填好，保存这一局</button>`;
  }
```

- [ ] **Step 3: 草稿 handler（字段级写 + 幂等保存）**

在 `App` 对象里加：
```js
    async draftPickWinner(i) {
      if (!(isSeated() || isOwner())) { alert('观战中不能记分'); return; }
      try {
        // 定/改赢家：清掉新赢家自己的 entry（赢家不填）
        await RunfastSync.patch(online.code, '/draft', { winner: i, entries: cleanEntries(i) });
      } catch (e) { alert(e.message); }
    },
    async draftFill(i, k) {
      try { await RunfastSync.patch(online.code, '/draft/entries/' + i, { cardsLeft: k, shutout: k === 10 }); }
      catch (e) { alert(e.message); }
    },
    async draftToggleShutout(i) {
      const e = (online.room.draft && online.room.draft.entries[i]) || null;
      if (!e || typeof e.cardsLeft !== 'number') return;
      try { await RunfastSync.patch(online.code, '/draft/entries/' + i, { cardsLeft: e.cardsLeft, shutout: !e.shutout }); }
      catch (err) { alert(err.message); }
    },
    async saveDraft() {
      const idxs = activeIdx();
      if (!RunfastSync.isDraftSaveable(online.room.draft, idxs)) { alert('还有人没填完'); return; }
      const seats = seatsOf();
      try {
        await RunfastSync.mutate(online.code, (room) => {
          if (!RunfastSync.isDraftSaveable(room.draft, idxs)) return room; // 幂等：别人已存则不重复
          const r = RunfastSync.draftToRound(room.draft, seats, idxs);
          room.session.rounds.push({ id: 'r' + Date.now(), at: new Date().toISOString(), winner: r.winner, losers: r.losers });
          room.draft = null;
          room.updatedAt = Date.now();
          return room;
        });
      } catch (e) { alert('保存失败：' + e.message); }
    },
```
并在 `App` 之前（helper 区）加 `cleanEntries`（改赢家时保留其余已填、去掉新赢家那格）：
```js
  function cleanEntries(winnerIdx) {
    const src = (online.room.draft && online.room.draft.entries) || {};
    const out = {};
    for (const k of Object.keys(src)) if (Number(k) !== winnerIdx) out[k] = src[k];
    return out;
  }
```

- [ ] **Step 4: 构建 + 手动 e2e（协作记一局）**

Run: `node build.js`
两标签（房主+牌友，均入座、已开局）验证：一端点赢家 → 两端草稿同步显示赢家；各端只能改自己那格（他人格显示"填写中/结果"不可点）；房主可代填任意格；全部填齐后两端「保存」变亮；任一端点保存 → 生成一局、草稿清空、两端比分同步刷新；连点保存不产生两局（幂等）。

- [ ] **Step 5: 提交**

```bash
git add src/app.js dist/index.html
git commit -m "feat(联机2期): 记分主页内联协作草稿——赢家先定/各座各填/幂等保存"
```

---

### Task 4: 移除旧锁与「允许他人修改」，清理无用联机代码

**Files:**
- Modify: `src/app.js`（删 `otherEditing/acquireEditLock/releaseEditLock`、`syncBar`、`toggleAllowEdit`；`commitSession` 去锁逻辑；`goRecord/editRound/deleteRound/cancelRecord` 去锁；`enterRoom.onRoom` 已在 Task 1 改为 routeByPhase 不含锁）

**Interfaces:**
- Consumes: `RunfastSync.canEdit`（房主 or `allowEdit`）。
- Produces: 联机不再有记分锁概念；**保留 `allowEdit`**——改删「已保存的一局」= 房主，或房主开启「允许他人修改」后持座者也可；本地单机 `goRecord/saveRound/cancelRecord/editRound/deleteRound` 保持工作。

- [ ] **Step 1: 删除锁相关函数**

删除 `src/app.js` 中这三个函数整块：`otherEditing()`、`acquireEditLock()`、`releaseEditLock()`（那段"记分锁"注释与函数）。同时删除 `syncBar()` 函数整块（已由 `onlineBar()` 取代）。**不要**删 `toggleAllowEdit`（改为治理"改删已存局"）。

- [ ] **Step 2: commitSession 去锁逻辑（保留 canEdit 门控）**

把 `commitSession` 整体替换为（联机下用 `canEdit`：房主或 allowEdit 的持座者都能写会话；仅去掉 `editing` 锁）：
```js
  async function commitSession(mutator) {
    if (online.active) {
      if (!RunfastSync.canEdit(online.room, online.uid)) { alert('房主未开启「允许他人修改」，暂不能改动'); render(); return; }
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

- [ ] **Step 3: 记一局/改/删/取消去锁；改删局用 canEdit（本地路径不变）**

把 `App.goRecord` 替换为（联机不走这里，本地照旧）：
```js
    goRecord() {
      const s = sessionCtx();
      if (s.activePlayers.length < 2) { alert('在场玩家不足 2 人，请先到「玩家管理」加人'); return; }
      go({ name: 'record', participants: s.activePlayers.slice(), winner: null, cards: Object.create(null), shutoutOff: Object.create(null), editId: null, editIndex: null });
    },
```
把 `App.cancelRecord` 替换为：
```js
    cancelRecord() { App.goSession(); },
```
把 `App.editRound` 开头的锁判断与 `acquireEditLock` 去掉，改删局用 `canEdit`（房主或 allowEdit 持座者）：
```js
    editRound(rid) {
      if (online.active && !RunfastSync.canEdit(online.room, online.uid)) { alert('房主未开启「允许他人修改」，只有房主可以改这一局'); return; }
      const s = sessionCtx();
      const i = s.rounds.findIndex((x) => x.id === rid);
      const r = s.rounds[i];
      const cards = Object.create(null), shutoutOff = Object.create(null);
      r.losers.forEach((l) => {
        cards[l.name] = l.cardsLeft;
        if (l.cardsLeft === 10 && !l.shutout) shutoutOff[l.name] = true;
      });
      go({ name: 'record', participants: [r.winner, ...r.losers.map((l) => l.name)], winner: r.winner, cards, shutoutOff, editId: rid, editIndex: i + 1 });
    },
```
把 `App.deleteRound` 的锁判断改为 `canEdit`：
```js
    deleteRound(rid) {
      if (online.active && !RunfastSync.canEdit(online.room, online.uid)) { alert('房主未开启「允许他人修改」，只有房主可以删这一局'); return; }
      if (!confirm('删除后总分将重算，确定删除这一局？')) return;
      commitSession((s) => { s.rounds = s.rounds.filter((x) => x.id !== rid); });
    },
```
**保留** `App.toggleAllowEdit`（原样：`canAdmin` 守卫 + 翻 `allowEdit`）。

- [ ] **Step 3b: session 联机分支——房主控制区加「允许他人修改」开关；已存局按 canEdit 只读**

`VIEWS.session` 联机分支：`roundsCard` 的 `roundRow` 只读判据由 `!isOwner()` 改为 `!RunfastSync.canEdit(online.room, online.uid)`；房主控制区（玩家管理/作废本场旁）加一枚开关按钮：
```js
<button class="btn" onclick="App.toggleAllowEdit()">${online.room.allowEdit ? '✅ 牌友可改已存局' : '🔒 改局仅房主'}</button>
```

- [ ] **Step 4: 结算页「关闭房间」判据用 isOwner**

`VIEWS.settle` 里把 `RunfastSync.canAdmin(online.room, online.uid)` 改为 `isOwner()`（该处判断房主是否显示「关闭房间」）。

- [ ] **Step 5: 构建 + 回归**

Run: `node build.js && node --test 2>&1 | grep -E "^ℹ (tests|pass|fail)"`
Expected: 构建成功、`node --test` 全绿。用一个本地单机场手动过一遍「开新一场→记一局→改→删→结束」确保本地未坏。

- [ ] **Step 6: 提交**

```bash
git add src/app.js dist/index.html
git commit -m "refactor(联机2期): 移除允许他人修改开关与记分锁，改删局改房主专属"
```

---

### Task 5: 玩家管理适配座位（加人/离场腾座）+ 双机全链路 e2e

**Files:**
- Modify: `src/app.js`（`App.joinPlayer/leave/comeBack` 联机下同步维护 seats）
- 验证：多标签 e2e。

**Interfaces:**
- Consumes: `commitSession`（会话写）、`RunfastSync.patch`（座位写）。
- Produces: 联机下加人=追加座位（灰待认领）；离场=移出 activePlayers 且释放该座。

- [ ] **Step 1: 玩家管理联机适配**

把 `App.joinPlayer` 替换为（联机下同时追加座位）：
```js
    async joinPlayer() {
      const s = sessionCtx();
      const name = document.getElementById('joinName').value.trim();
      if (!validName(name)) { alert('名字需 1～8 个字，且不能含引号等特殊符号'); return; }
      if (s.players.includes(name)) { alert('这个名字本场已存在'); return; }
      if (s.activePlayers.length >= 8) { alert('在场玩家已达 8 人上限'); return; }
      if (!db.playerDirectory.includes(name)) { db.playerDirectory.push(name); saveDB(); }
      if (online.active) {
        if (!isOwner()) { alert('只有房主可以加人'); return; }
        try {
          await RunfastSync.mutate(online.code, (room) => {
            room.session.players.push(name);
            room.session.activePlayers.push(name);
            room.seats.push({ name, claimedBy: null }); // 新座位待认领
            room.updatedAt = Date.now();
            return room;
          });
        } catch (e) { alert('加人失败：' + e.message); }
        return;
      }
      commitSession((x) => { x.players.push(name); x.activePlayers.push(name); });
    },
```
把 `App.leave` 替换为（联机下离场同时释放座位）：
```js
    leave(name) {
      if (online.active) {
        if (!isOwner()) { alert('只有房主可以标记离场'); return; }
        const i = seatsOf().findIndex((s) => s.name === name);
        RunfastSync.mutate(online.code, (room) => {
          room.session.activePlayers = room.session.activePlayers.filter((n) => n !== name);
          if (room.seats[i]) room.seats[i].claimedBy = null; // 腾座
          room.updatedAt = Date.now();
          return room;
        }).catch((e) => alert('操作失败：' + e.message));
        return;
      }
      commitSession((s) => { s.activePlayers = s.activePlayers.filter((n) => n !== name); });
    },
```
`App.comeBack` 联机下加房主守卫（回归即重新进入 activePlayers，座位仍需本人重新认领）：
```js
    comeBack(name) {
      const s = sessionCtx();
      if (s.activePlayers.length >= 8) { alert('在场玩家已达 8 人上限'); return; }
      if (online.active && !isOwner()) { alert('只有房主可以让玩家回归'); return; }
      commitSession((x) => { x.activePlayers.push(name); });
    },
```

- [ ] **Step 2: 构建**

Run: `node build.js`
Expected: 构建成功。

- [ ] **Step 3: 双机全链路 e2e（多标签，各设 deviceId）**

启动本机 server，用 2–3 个标签验证全链路：
1. 房主建 3 人局 → 大厅；三端各入座（其中房主可代填第三座模拟没手机）；满员房主开局。
2. 记一局：赢家点自己 → 各端同步；各填各格（他人格只读）；房主代填空手机那座；填齐后保存，比分同步、幂等不双记。
3. 顶部「在玩·观战」数正确；再开一标签不入座 = 观战 +1、只读。
4. 玩家管理：房主加人 → 新座灰色、可认领；标某人离场 → 其座腾空、后续局不含 TA、历史分保留。
5. 结束本场 → 各端存本地历史、房主结算页可关房；关房后观战端被提示回首页。
6. 全程控制台无红色报错。

- [ ] **Step 4: 提交**

```bash
git add src/app.js dist/index.html
git commit -m "feat(联机2期): 玩家管理适配座位（加人追加座位/离场腾座）"
```

---

## Self-Review

- **Spec 覆盖**：大厅/认领/满员开局(§3/§4)→ Task 1/2；协作草稿赢家先定+各填+幂等保存(§5)→ Task 3；在玩/观战人数(§7)→ Task 2 `onlineBar`；移除 allowEdit/锁(§1/§11)→ Task 4；加人/离场腾座(§6)→ Task 5；改删局房主专属(§6)→ Task 4；观战只读(§5)→ Task 3 `canFill`/按钮门控；迟到者观战(§6)→ 未入座即无座 = 只读观战（自然满足）。
- **占位符扫描**：无 TBD；每步给完整代码或精确替换。
- **类型/命名一致**：`isOwner/mySeatIdx/isSeated/activeIdx/allClaimed/seatsOf` 贯穿；draft 键=座位下标；`patch(code,path,value)`/`mutate` 与第一期一致；`onlineBar` 取代 `syncBar`；`routeByPhase` 统一阶段跳转。
- **增量顺序安全**：Task 1 建大厅但视图未变可能短暂错位——故 Task 1 已加 routeByPhase 并在 Step 4 只做构建自检；Task 2 起补齐 lobby 视图。执行顺序 1→2→3→4→5，每步构建通过。
- **风险点**：`saveDraft` 用 `mutate` 幂等（存前再判 `isDraftSaveable`）防双记；抢座/填格 403 由 `onRoom` 广播刷新为最新，前端只提示不崩。
