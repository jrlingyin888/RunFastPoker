(() => {
  'use strict';
  const L = RunfastLogic, U = RunfastUI, R = RunfastRoom;
  const esc = U.esc, topbar = U.topbar, validName = U.validName;
  const STORE_KEY = 'runfast.v1';

  // ---------- 存储 ----------
  function loadDB() {
    try {
      const raw = localStorage.getItem(STORE_KEY);
      if (raw) {
        const data = JSON.parse(raw);
        if (data.version === 1 && Array.isArray(data.sessions) && Array.isArray(data.playerDirectory)) return data;
      }
    } catch (e) { /* 损坏数据按空库处理 */ }
    return { version: 1, playerDirectory: [], sessions: [] };
  }
  function saveDB() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(db)); }
    catch (e) { alert('保存失败：浏览器本地存储不可用（可能是无痕模式）。请尽快导出备份！'); }
  }
  let db = loadDB();

  // ---------- 工具 ----------
  const $app = document.getElementById('app');
  const yuan = (fen) => L.fenToYuan(fen);
  const signYuan = (fen) => (fen > 0 ? '+' : '') + L.fenToYuan(fen);
  const cls = (fen) => (fen > 0 ? 'pos' : fen < 0 ? 'neg' : '');
  const fmtDate = (iso) => {
    const d = new Date(iso);
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  };
  const fmtTime = (iso) => {
    if (!iso) return '';
    const d = new Date(iso);
    return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
  };
  const activeSession = () => db.sessions.find((s) => s.status === 'active') || null;

  // ---------- 导航与渲染 ----------
  let view = { name: 'home' };
  function go(v) { U.closeSheet(); view = v; render(); window.scrollTo(0, 0); }
  const VIEWS = {};
  function render() { $app.innerHTML = VIEWS[view.name](); }

  // ---------- 首页 ----------
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

  // ---------- 开新一场 / 创建联机场（同一张表单，按 view.mode 换文案） ----------
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

  // 历史旧场的每局明细（新场是流水，不再有「局」）
  function roundRow(s, r, i) {
    const detail = L.roundTransfers(r, s.pricePerCardFen)
      .map((t) => `${esc(t.from)} ${t.cards}张`).join('，');
    return `<div class="row">
      <div><b>第${i + 1}局</b> ${esc(r.winner)} 赢${r.at ? ` <span class="muted">${fmtTime(r.at)}</span>` : ''}
        <div class="muted">${detail || '其他人也都出完了'}</div></div>
    </div>`;
  }

  // ---------- 结算页（记分页「⋯ → 结算方案」& 结束本场后 & 历史详情共用） ----------
  // 结算页看的可能是「房间的当前快照」（随时可看，实时），也可能是「历史里的一场」
  function settleSession() {
    if (view.from === 'room') return R.state.active ? R.snapshot() : null;
    return db.sessions.find((x) => x.id === view.sid);
  }

  VIEWS.settle = () => {
    const s = settleSession();
    if (!s) return VIEWS.home();
    const backJs = view.from === 'history' ? 'App.goHistory()'
      : view.from === 'room' ? 'App.backToRoom()' : 'App.goHome()';
    const net = L.sessionNet(s).slice().sort((a, b) => b.fen - a.fen);
    const pays = L.settleUp(L.sessionNet(s));
    return `
      ${topbar(fmtDate(s.createdAt) + ' 战绩', backJs)}
      <div class="card">
        <div class="section-title">${view.from === 'room' ? '当前' : '最终'}盈亏（${L.sessionSize(s)} · ${yuan(s.pricePerCardFen)}元/张）</div>
        ${net.map((p) => `<div class="row"><span>${esc(p.name)}</span>
          <span class="${cls(p.fen)}">${p.cards > 0 ? '+' : ''}${p.cards} 张 · ${signYuan(p.fen)} 元</span></div>`).join('')}
      </div>
      <div class="card">
        <div class="section-title">💸 转账方案（最少笔数）</div>
        ${pays.map((t) => `<div class="row"><span>${esc(t.from)} 转给 ${esc(t.to)}</span><span class="pos">${yuan(t.fen)} 元</span></div>`).join('')
          || '<div class="muted">全部打平，无需转账</div>'}
      </div>
      <button class="btn btn-primary" onclick="App.shareImage()">📤 分享战绩图</button>
      <div class="gap"></div>
      <button class="btn" onclick="App.copyText()">📋 复制战绩文字</button>
      ${s.rounds && s.rounds.length
        ? '<div class="gap"></div><button class="btn" onclick="App.goRoundsFromSettle()">查看每局明细</button>' : ''}
      ${!R.state.active && R.state.code && R.state.room
        && R.state.room.creatorUid === R.state.uid
        && R.state.room.sid === s.id ? `<div class="gap"></div>
      <button class="btn" onclick="Room.closeRoom()">关闭房间（牌友都保存后再关）</button>` : ''}`;
  };

  // ---------- 每局明细（只读） ----------
  // 只有历史里按局记的旧场才有「每局明细」；新场是流水，直接在记分页看
  VIEWS.rounds = () => {
    const s = db.sessions.find((x) => x.id === view.sid);
    if (!s) return VIEWS.home();
    return `
      ${topbar('每局明细', 'App.backFromRounds()')}
      <div class="card">${s.rounds.map((r, i) => roundRow(s, r, i)).join('')
        || '<div class="muted">本场没有记录任何一局</div>'}</div>`;
  };

  // ---------- 历史记录 ----------
  // 行上的 sid 可能来自别人的房间快照（服务器不校验 sid），一律走 data-* + 事件委托，
  // 不拼进 onclick —— 那是当 JS 源码编译的位置，esc() 挡不住。
  VIEWS.history = () => {
    const list = db.sessions.filter((s) => s.status === 'finished')
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
    if (!list.length) {
      return `${topbar('历史记录', 'App.goHome()')}
        <div class="card"><div class="muted">还没有打完的场</div></div>`;
    }
    const edit = !!view.editMode;
    const sel = view.sel || [];
    const actions = edit
      ? '<button class="icon-btn" onclick="App.historyEditOff()">完成</button>'
      : '<button class="icon-btn" onclick="App.historyEditOn()">编辑</button>';
    const allSel = sel.length === list.length;
    const bar = edit ? `<div class="card" style="display:flex;justify-content:space-between;align-items:center;padding:12px 16px">
        <button class="btn btn-sm" onclick="App.historySelectAll()">${allSel ? '取消全选' : '全选'}</button>
        <button class="btn btn-sm btn-danger" ${sel.length ? '' : 'disabled style="opacity:.4"'} onclick="App.historyDeleteSel()">删除所选（${sel.length}）</button>
      </div>` : '';
    return `
      ${topbar('历史记录', 'App.goHome()', actions)}
      ${bar}
      <div class="card">
        ${list.map((s) => {
          const info =`<div><b>${fmtDate(s.createdAt)}</b><div class="muted">${s.players.map(esc).join('、')}</div></div>`;
          if (edit) {
            const on = sel.includes(s.id);
            const box = on
              ? '<span style="flex-shrink:0;width:22px;height:22px;border-radius:6px;background:var(--felt-light);color:#fff;text-align:center;line-height:22px;font-size:14px">✓</span>'
              : '<span style="flex-shrink:0;width:22px;height:22px;border-radius:6px;border:2px solid #cbd5e1;display:inline-block"></span>';
            return `<div class="row" data-app-act="pick" data-sid="${esc(s.id)}" style="cursor:pointer">
              <span style="display:flex;align-items:center;gap:12px">${box}${info}</span></div>`;
          }
          return `<div class="row" data-app-act="open" data-sid="${esc(s.id)}" style="cursor:pointer">
            ${info}<span class="muted">${L.sessionSize(s)} ›</span></div>`;
        }).join('')}
      </div>`;
  };

  // ---------- 加入联机场 ----------
  VIEWS.joinRoom = () => `
    ${topbar('加入联机场', 'App.goHome()')}
    <div class="card">
      <div class="section-title">输入 6 位房号</div>
      <input type="text" id="roomCode" inputmode="numeric" maxlength="6" placeholder="如 314159" value="${view.code ? esc(view.code) : ''}">
      <div class="gap"></div>
      <button class="btn btn-primary" onclick="App.joinRoomSubmit()">进入房间</button>
      <div class="muted" style="margin-top:10px">${view.code ? '房号已自动填好，点「进入房间」即可（若进不去，可能房主还没建好或已关闭，稍等再试）。' : '房号问房主要，或直接点房主发到群里的链接。'}</div>
    </div>`;

  // ---------- 导入前校验 ----------
  const validId = (s) => typeof s === 'string' && /^[A-Za-z0-9_-]{1,32}$/.test(s);
  function importValid(data) {
    const names = new Set(data.playerDirectory);
    let activeCount = 0;
    for (const s of data.sessions) {
      if (!validId(s.id)) return false;
      if (!(Number.isInteger(s.pricePerCardFen) && s.pricePerCardFen > 0)) return false;
      if (!(s.status === 'active' || s.status === 'finished')) return false;
      if (!(Array.isArray(s.players) && Array.isArray(s.rounds))) return false;
      if (new Set(s.players).size !== s.players.length) return false;
      // 旧场才有 activePlayers（在场名单）；新的流水场没有这个字段
      if (s.activePlayers !== undefined) {
        if (!Array.isArray(s.activePlayers)) return false;
        if (new Set(s.activePlayers).size !== s.activePlayers.length) return false;
        if (!s.activePlayers.every((n) => s.players.includes(n))) return false;
        s.activePlayers.forEach((n) => names.add(n));
      }
      if (s.status === 'active') activeCount++;
      s.players.forEach((n) => names.add(n));
      if (s.transfers !== undefined) {
        if (!Array.isArray(s.transfers)) return false;
        for (const t of s.transfers) {
          if (!validId(t.id)) return false;
          if (!s.players.includes(t.from) || !s.players.includes(t.to)) return false;
          if (t.from === t.to) return false;
          if (!(Number.isInteger(t.points) && t.points > 0 && t.points <= 9999)) return false;
        }
      }
      for (const r of s.rounds) {
        if (!validId(r.id)) return false;
        if (r.at !== undefined && typeof r.at !== 'string') return false;
        if (typeof r.winner !== 'string' || !s.players.includes(r.winner)) return false;
        if (!Array.isArray(r.losers)) return false;
        for (const l of r.losers) {
          if (!s.players.includes(l.name)) return false;
          if (!(Number.isInteger(l.cardsLeft) && l.cardsLeft >= 0 && l.cardsLeft <= 10)) return false;
          if (typeof l.shutout !== 'boolean') return false;
        }
        names.add(r.winner);
        r.losers.forEach((l) => names.add(l.name));
      }
    }
    if (activeCount > 1) return false;
    return Array.from(names).every((n) => validName(n));
  }

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

  // ---------- 交互 ----------
  const App = {
    goHome: () => go({ name: 'home' }),
    goSetup: () => go({ name: 'setup', sel: [], myName: '', price: '1', manage: false }),
    goHistory: () => go({ name: 'history', editMode: false, sel: [] }),
    historyEditOn() { view.editMode = true; view.sel = []; render(); },
    historyEditOff() { view.editMode = false; view.sel = []; render(); },
    historyToggle(id) {
      view.sel = view.sel || [];
      view.sel = view.sel.includes(id) ? view.sel.filter((x) => x !== id) : view.sel.concat(id);
      render();
    },
    historySelectAll() {
      const ids = db.sessions.filter((s) => s.status === 'finished').map((s) => s.id);
      view.sel = (view.sel && view.sel.length === ids.length) ? [] : ids;
      render();
    },
    historyDeleteSel() {
      const sel = view.sel || [];
      if (!sel.length) return;
      if (!confirm('删除所选的 ' + sel.length + ' 场历史记录？删除后无法恢复。')) return;
      db.sessions = db.sessions.filter((s) => !sel.includes(s.id));
      saveDB();
      view.sel = [];
      view.editMode = false;
      render();
    },

    goOnlineSetup() {
      if (!RunfastSync.configured()) { alert('联机要在房主电脑上启动「跑得快联机」服务后，用手机扫主机页二维码进入才能用'); return; }
      go({ name: 'setup', sel: [], myName: R.lastName(), price: '1', manage: false, mode: 'online' });
    },

    goJoinRoom() {
      if (!RunfastSync.configured()) { alert('联机要在房主电脑上启动「跑得快联机」服务后，用手机扫主机页二维码进入才能用'); return; }
      go({ name: 'joinRoom' });
    },

    joinRoomSubmit() {
      const code = document.getElementById('roomCode').value.trim();
      if (!RunfastSync.validRoomCode(code)) { alert('房号是 6 位数字'); return; }
      R.preview(code);
    },

    rejoinRoom() {
      let saved = null;
      try { saved = JSON.parse(localStorage.getItem('runfast.sync.room') || 'null'); } catch (e) { /* 忽略 */ }
      if (saved && RunfastSync.validRoomCode(saved.code)) R.preview(saved.code);
      else { localStorage.removeItem('runfast.sync.room'); render(); }
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

    toggleManage() {
      view.price = document.getElementById('price').value;
      view.manage = !view.manage;
      render();
    },

    renameDirName(name) {
      const next = (window.prompt('把「' + name + '」改为（不影响历史战绩）：', name) || '').trim();
      if (!next || next === name) return;
      if (!validName(next)) { alert('名字需 1～8 个字，且不能含引号等特殊符号'); return; }
      if (db.playerDirectory.includes(next)) { alert('名单里已有这个名字'); return; }
      view.price = document.getElementById('price').value;
      db.playerDirectory = db.playerDirectory.map((n) => (n === name ? next : n));
      view.sel = view.sel.map((n) => (n === name ? next : n));
      saveDB();
      render();
    },

    deleteDirName(name) {
      if (!confirm('从常用名单删除「' + name + '」？不影响历史战绩。')) return;
      view.price = document.getElementById('price').value;
      db.playerDirectory = db.playerDirectory.filter((n) => n !== name);
      view.sel = view.sel.filter((n) => n !== name);
      if (!db.playerDirectory.length) view.manage = false;
      saveDB();
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

    goSettle: (sid, from) => go({ name: 'settle', sid, from: from || 'home' }),
    backToRoom() { go({ name: 'room' }); },
    // 结算页 ↔ 每局明细：sid / from 都从当前 view 取，不拼进 onclick
    goRoundsFromSettle() {
      const s = settleSession();
      if (s) go({ name: 'rounds', sid: s.id, from: view.from });
    },
    backFromRounds() { go({ name: 'settle', sid: view.sid, from: view.from }); },

    async copyText() {
      const s = settleSession();
      if (!s) return;
      const ok = await U.copyToClipboard(L.summaryText(s));
      alert(ok ? '已复制，去粘贴发给牌友吧' : '复制失败，请改用「分享战绩图」或截图');
    },

    shareImage() { const s = settleSession(); if (s) RunfastShare.share(s, L); },

    exportData() {
      const blob = new Blob([JSON.stringify(db, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'runfast-backup-' + fmtDate(new Date().toISOString()) + '.json';
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    },

    importData() {
      const inp = document.createElement('input');
      inp.type = 'file';
      inp.accept = '.json,application/json';
      inp.style.display = 'none';
      document.body.appendChild(inp);
      inp.onchange = () => {
        const f = inp.files[0];
        if (!f) { inp.remove(); return; }
        const r = new FileReader();
        r.onload = () => {
          try {
            const data = JSON.parse(r.result);
            if (data.version !== 1 || !Array.isArray(data.sessions) || !Array.isArray(data.playerDirectory)) {
              throw new Error('bad format');
            }
            if (!importValid(data)) throw new Error('bad format');
            if (!confirm('导入将覆盖本手机上现有的全部记分数据，确定？')) return;
            db = data;
            saveDB();
            go({ name: 'home' });
            alert('导入成功');
          } catch (e) { alert('文件格式不对，导入失败'); }
          finally { inp.remove(); }
        };
        r.readAsText(f);
      };
      inp.click();
    },
  };
  window.App = App;

  // 历史列表的行带 sid，走 data-* 事件委托（见 VIEWS.history 的注释）
  document.addEventListener('click', (ev) => {
    const t = ev.target;
    const el = t && t.closest ? t.closest('[data-app-act]') : null;
    if (!el) return;
    const sid = el.getAttribute('data-sid');
    const act = el.getAttribute('data-app-act');
    if (act === 'open') App.goSettle(sid, 'history');
    else if (act === 'pick') App.historyToggle(sid);
  });

  const roomParam = location.search.match(/[?&]room=([0-9]{6})\b/);
  if (roomParam && RunfastSync.configured()) R.preview(roomParam[1]);

  render();
})();
