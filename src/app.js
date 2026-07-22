(() => {
  'use strict';
  const L = RunfastLogic;
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
  const esc = (s) => String(s).replace(/[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const validName = (s) => /^[^'"<>\\]{1,8}$/.test(s);
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
  const topbar = (title, backJs) =>
    `<div class="topbar">${backJs ? `<button class="back" onclick="${backJs}">‹ 返回</button>` : ''}<div class="title">${title}</div></div>`;

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

  // ---------- 导航与渲染 ----------
  let view = { name: 'home' };
  function go(v) { view = v; render(); window.scrollTo(0, 0); }
  const VIEWS = {};
  function render() { $app.innerHTML = VIEWS[view.name](); }

  // ---------- 首页 ----------
  VIEWS.home = () => {
    const act = activeSession();
    return `
      <h1 style="text-align:center;margin:20px 0 18px">🃏 跑得快记分</h1>
      ${act
        ? `<button class="btn btn-primary" onclick="App.goSession()">继续本场（${act.players.map(esc).join('、')}）</button>`
        : `<button class="btn btn-primary" onclick="App.goSetup()">开新一场</button>`}
      <div class="gap"></div>
      <button class="btn" onclick="App.goHistory()">历史记录</button>
      <div class="gap"></div>
      <div class="card">
        <div class="muted" style="margin-bottom:10px">数据保存在本手机浏览器里，换手机或清缓存前请先导出</div>
        <button class="btn btn-sm" onclick="App.exportData()">导出备份</button>
        <button class="btn btn-sm" onclick="App.importData()">导入备份</button>
      </div>`;
  };

  // ---------- 开新一场 ----------
  VIEWS.setup = () => {
    const sel = view.sel;
    const dir = db.playerDirectory;
    return `
      ${topbar('开新一场', 'App.goHome()')}
      <div class="card">
        <div class="section-title" style="display:flex;justify-content:space-between;align-items:center">
          <span>选择玩家（2～8 人）</span>
          ${dir.length ? `<button class="btn btn-sm" onclick="App.toggleManage()">${view.manage ? '完成' : '管理名录'}</button>` : ''}
        </div>
        ${view.manage
          ? dir.map((n) => `<div class="row"><span>${esc(n)}</span>
              <div style="flex-shrink:0">
                <button class="btn btn-sm" onclick="App.renameDirName('${esc(n)}')">改名</button>
                <button class="btn btn-sm" onclick="App.deleteDirName('${esc(n)}')">删除</button>
              </div></div>`).join('') +
            '<div class="muted" style="margin-top:8px">改名/删除只影响这里的常用名单，不影响历史战绩。</div>'
          : `<div class="chips">
              ${dir.map((n) =>
                `<button class="chip ${sel.includes(n) ? 'on' : ''}" onclick="App.togglePlayer('${esc(n)}')">${esc(n)}</button>`).join('')
              || '<span class="muted">还没有常用玩家，在下面添加第一位吧</span>'}
            </div>`}
        <div style="display:flex;gap:8px;margin-top:12px">
          <input type="text" id="newName" placeholder="新玩家名字（8 字以内）" maxlength="8">
          <button class="btn btn-sm" onclick="App.addPlayer()">添加</button>
        </div>
        ${sel.length ? `<div class="muted" style="margin-top:10px">已选 ${sel.length} 人：${sel.map(esc).join('、')}</div>` : ''}
      </div>
      <div class="card">
        <div class="section-title">每张牌单价（元）</div>
        <input type="text" id="price" inputmode="decimal" value="${esc(view.price)}" placeholder="如 1 或 0.5">
      </div>
      <button class="btn btn-primary" onclick="App.startSession()">开始记分</button>`;
  };

  // ---------- 记分主页 ----------
  function roundRow(s, r, i, readonly) {
    const detail = L.roundTransfers(r, s.pricePerCardFen)
      .map((t) => `${esc(t.from)} ${t.cards}张`).join('，');
    return `<div class="row">
      <div><b>第${i + 1}局</b> ${esc(r.winner)} 赢${r.at ? ` <span class="muted">${fmtTime(r.at)}</span>` : ''}
        <div class="muted">${detail || '其他人也都出完了'}</div></div>
      ${readonly ? '' : `<div style="flex-shrink:0">
        <button class="btn btn-sm" onclick="App.editRound('${r.id}')">改</button>
        <button class="btn btn-sm" onclick="App.deleteRound('${r.id}')">删</button></div>`}
    </div>`;
  }

  VIEWS.session = () => {
    const s = activeSession();
    if (!s) return VIEWS.home();
    const net = L.sessionNet(s).slice().sort((a, b) => b.fen - a.fen);
    return `
      ${topbar(`已记 ${s.rounds.length} 局 · ${yuan(s.pricePerCardFen)}元/张`, 'App.goHome()')}
      <div class="card">
        ${net.map((p) => `<div class="row">
          <span>${esc(p.name)}${s.activePlayers.includes(p.name) ? '' : ' <span class="muted">（已离场）</span>'}</span>
          <span class="${cls(p.fen)}">${p.cards > 0 ? '+' : ''}${p.cards} 张 · ${signYuan(p.fen)} 元</span>
        </div>`).join('')}
      </div>
      <button class="btn btn-primary" style="font-size:20px;padding:18px" onclick="App.goRecord()">📝 记一局</button>
      <div style="display:flex;gap:10px;margin-top:10px">
        <button class="btn" onclick="App.goPlayers()">玩家管理</button>
        <button class="btn btn-danger" onclick="App.finishSession()">结束本场</button>
      </div>
      <div class="card" style="margin-top:12px">
        ${s.rounds.map((r, i) => roundRow(s, r, i, false)).join('')
          || '<div class="muted">还没有记录，点上面「记一局」开始</div>'}
      </div>`;
  };

  // ---------- 记一局 ----------
  function currentLosers() {
    return view.participants
      .filter((n) => n !== view.winner)
      .map((n) => ({
        name: n,
        cardsLeft: view.cards[n],
        shutout: view.cards[n] === 10 && !view.shutoutOff[n],
      }));
  }

  VIEWS.record = () => {
    const s = activeSession();
    const ps = view.participants;
    const w = view.winner;
    const losers = ps.filter((n) => n !== w);
    const ready = w && losers.every((n) => typeof view.cards[n] === 'number');
    let previewHtml = '';
    if (ready) {
      const ts = L.roundTransfers({ winner: w, losers: currentLosers() }, s.pricePerCardFen);
      previewHtml = `<div class="card"><div class="section-title">本局结算预览</div>
        ${ts.map((t) => `<div class="row"><span>${esc(t.from)} → ${esc(t.to)}</span><span>${t.cards} 张 · ${yuan(t.fen)} 元</span></div>`).join('')
          || '<div class="muted">其他人都 0 张，本局无转账</div>'}</div>`;
    }
    return `
      ${topbar(view.editId ? `修改第 ${view.editIndex} 局` : `记第 ${s.rounds.length + 1} 局`, 'App.goSession()')}
      <div class="card">
        <div class="section-title">1️⃣ 谁赢了？</div>
        <div class="chips">${ps.map((n) =>
          `<button class="chip ${w === n ? 'on' : ''}" onclick="App.pickWinner('${esc(n)}')">${esc(n)}</button>`).join('')}</div>
      </div>
      ${w ? losers.map((n) => {
        const v = view.cards[n];
        const shutBadge =
          v === 10 && !view.shutoutOff[n]
            ? `<button class="badge" onclick="App.toggleShutout('${esc(n)}')">全关 ×2（点此取消）</button>`
            : v === 10
              ? `<button class="badge" style="background:#e5e7eb;color:#374151" onclick="App.toggleShutout('${esc(n)}')">全关已取消（点此恢复）</button>`
              : '';
        return `<div class="card">
          <div class="section-title">${esc(n)} 剩几张？ ${shutBadge}</div>
          <div class="numgrid">${[0,1,2,3,4,5,6,7,8,9,10].map((k) =>
            `<button class="${v === k ? 'on' : ''}" onclick="App.pickCards('${esc(n)}',${k})">${k}</button>`).join('')}</div>
        </div>`;
      }).join('') : ''}
      ${previewHtml}
      <button class="btn btn-primary" ${ready ? '' : 'disabled style="opacity:.4"'} onclick="App.saveRound()">
        ${view.editId ? '保存修改' : '✅ 确认保存'}</button>`;
  };

  // ---------- 结算页（结束本场后 & 历史详情共用） ----------
  VIEWS.settle = () => {
    const s = db.sessions.find((x) => x.id === view.sid);
    const backJs = view.from === 'history' ? 'App.goHistory()' : 'App.goHome()';
    const net = L.sessionNet(s).slice().sort((a, b) => b.fen - a.fen);
    const pays = L.settleUp(L.sessionNet(s));
    return `
      ${topbar(fmtDate(s.createdAt) + ' 战绩', backJs)}
      <div class="card">
        <div class="section-title">最终盈亏（${s.rounds.length} 局 · ${yuan(s.pricePerCardFen)}元/张）</div>
        ${net.map((p) => `<div class="row"><span>${esc(p.name)}</span>
          <span class="${cls(p.fen)}">${p.cards > 0 ? '+' : ''}${p.cards} 张 · ${signYuan(p.fen)} 元</span></div>`).join('')}
      </div>
      <div class="card">
        <div class="section-title">💸 转账方案（最少笔数）</div>
        ${pays.map((t) => `<div class="row"><span>${esc(t.from)} 转给 ${esc(t.to)}</span><span class="pos">${yuan(t.fen)} 元</span></div>`).join('')
          || '<div class="muted">全部打平，无需转账</div>'}
      </div>
      <button class="btn btn-primary" onclick="App.shareImage('${s.id}')">📤 分享战绩图</button>
      <div class="gap"></div>
      <button class="btn" onclick="App.copyText('${s.id}')">📋 复制战绩文字</button>
      <div class="gap"></div>
      <button class="btn" onclick="App.goRounds('${s.id}','${view.from}')">查看每局明细</button>`;
  };

  // ---------- 只读局明细 ----------
  VIEWS.rounds = () => {
    const s = db.sessions.find((x) => x.id === view.sid);
    return `
      ${topbar('每局明细', `App.goSettle('${view.sid}','${view.from}')`)}
      <div class="card">${s.rounds.map((r, i) => roundRow(s, r, i, true)).join('')
        || '<div class="muted">本场没有记录任何一局</div>'}</div>`;
  };

  // ---------- 历史记录 ----------
  VIEWS.history = () => {
    const list = db.sessions.filter((s) => s.status === 'finished')
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
    return `
      ${topbar('历史记录', 'App.goHome()')}
      <div class="card">
        ${list.map((s) => `<div class="row" onclick="App.goSettle('${s.id}','history')" style="cursor:pointer">
          <div><b>${fmtDate(s.createdAt)}</b><div class="muted">${s.players.map(esc).join('、')}</div></div>
          <span class="muted">${s.rounds.length} 局 ›</span>
        </div>`).join('') || '<div class="muted">还没有打完的场</div>'}
      </div>`;
  };

  // ---------- 玩家管理 ----------
  VIEWS.players = () => {
    const s = activeSession();
    return `
      ${topbar('玩家管理', 'App.goSession()')}
      <div class="card">
        ${s.players.map((n) => `<div class="row"><span>${esc(n)}</span>
          ${s.activePlayers.includes(n)
            ? `<button class="btn btn-sm" onclick="App.leave('${esc(n)}')">标记离场</button>`
            : `<button class="btn btn-sm" onclick="App.comeBack('${esc(n)}')">回归</button>`}
        </div>`).join('')}
        <div style="display:flex;gap:8px;margin-top:12px">
          <input type="text" id="joinName" placeholder="中途加入的玩家名字" maxlength="8">
          <button class="btn btn-sm" onclick="App.joinPlayer()">加入</button>
        </div>
        <div class="muted" style="margin-top:10px">离场玩家不再出现在新局录入中；历史成绩保留，仍参与最终结算。</div>
      </div>`;
  };

  // ---------- 导入前校验 ----------
  const validId = (s) => typeof s === 'string' && /^[A-Za-z0-9_-]{1,32}$/.test(s);
  function importValid(data) {
    const names = new Set(data.playerDirectory);
    let activeCount = 0;
    for (const s of data.sessions) {
      if (!validId(s.id)) return false;
      if (!(Number.isInteger(s.pricePerCardFen) && s.pricePerCardFen > 0)) return false;
      if (!(s.status === 'active' || s.status === 'finished')) return false;
      if (!(Array.isArray(s.players) && Array.isArray(s.activePlayers) && Array.isArray(s.rounds))) return false;
      if (new Set(s.players).size !== s.players.length) return false;
      if (new Set(s.activePlayers).size !== s.activePlayers.length) return false;
      if (!s.activePlayers.every((n) => s.players.includes(n))) return false;
      if (s.status === 'active') activeCount++;
      s.players.forEach((n) => names.add(n));
      s.activePlayers.forEach((n) => names.add(n));
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

  // ---------- 交互 ----------
  const App = {
    goHome: () => go({ name: 'home' }),
    goSetup: () => go({ name: 'setup', sel: [], price: '1', manage: false }),
    goSession: () => go({ name: 'session' }),
    goHistory: () => go({ name: 'history' }),

    togglePlayer(name) {
      view.price = document.getElementById('price').value; // 保留已输入的单价
      const i = view.sel.indexOf(name);
      if (i >= 0) view.sel.splice(i, 1); else view.sel.push(name);
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

    addPlayer() {
      const inp = document.getElementById('newName');
      const name = inp.value.trim();
      if (!validName(name)) { alert('名字需 1～8 个字，且不能含引号等特殊符号'); return; }
      if (db.playerDirectory.includes(name)) { alert('已有同名玩家，直接点选即可'); return; }
      view.price = document.getElementById('price').value;
      db.playerDirectory.push(name);
      view.sel.push(name);
      saveDB();
      render();
    },

    startSession() {
      if (activeSession()) { App.goSession(); return; }
      const priceFen = L.yuanToFen(document.getElementById('price').value.trim());
      if (view.sel.length < 2 || view.sel.length > 8) { alert('请选择 2～8 名玩家'); return; }
      if (Number.isNaN(priceFen)) { alert('单价格式不对，例：1 或 0.5'); return; }
      db.sessions.push({
        id: 's' + Date.now(),
        createdAt: new Date().toISOString(),
        pricePerCardFen: priceFen,
        players: view.sel.slice(),
        activePlayers: view.sel.slice(),
        status: 'active',
        rounds: [],
      });
      saveDB();
      App.goSession();
    },

    goRecord() {
      const s = activeSession();
      if (s.activePlayers.length < 2) { alert('在场玩家不足 2 人，请先到「玩家管理」加人'); return; }
      go({ name: 'record', participants: s.activePlayers.slice(), winner: null, cards: Object.create(null), shutoutOff: Object.create(null), editId: null, editIndex: null });
    },

    pickWinner(name) {
      view.winner = name;
      delete view.cards[name]; // 赢家固定 0 张
      render();
    },

    pickCards(name, k) {
      view.cards[name] = k;
      delete view.shutoutOff[name]; // 改牌数后全关标记回到自动状态
      render();
    },

    toggleShutout(name) {
      if (view.shutoutOff[name]) delete view.shutoutOff[name];
      else view.shutoutOff[name] = true;
      render();
    },

    saveRound() {
      const s = activeSession();
      const losers = currentLosers();
      if (!view.winner || losers.some((l) => typeof l.cardsLeft !== 'number')) return;
      if (view.editId) {
        const r = s.rounds.find((x) => x.id === view.editId);
        r.winner = view.winner;
        r.losers = losers;
      } else {
        s.rounds.push({
          id: 'r' + Date.now(),
          at: new Date().toISOString(),
          winner: view.winner,
          losers,
        });
      }
      saveDB();
      App.goSession();
    },

    editRound(rid) {
      const s = activeSession();
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
      const s = activeSession();
      s.rounds = s.rounds.filter((x) => x.id !== rid);
      saveDB();
      render();
    },

    goPlayers: () => go({ name: 'players' }),

    leave(name) {
      const s = activeSession();
      s.activePlayers = s.activePlayers.filter((n) => n !== name);
      saveDB();
      render();
    },

    comeBack(name) {
      const s = activeSession();
      if (s.activePlayers.length >= 8) { alert('在场玩家已达 8 人上限'); return; }
      s.activePlayers.push(name);
      saveDB();
      render();
    },

    joinPlayer() {
      const s = activeSession();
      const name = document.getElementById('joinName').value.trim();
      if (!validName(name)) { alert('名字需 1～8 个字，且不能含引号等特殊符号'); return; }
      if (s.players.includes(name)) { alert('这个名字本场已存在'); return; }
      if (s.activePlayers.length >= 8) { alert('在场玩家已达 8 人上限'); return; }
      s.players.push(name);
      s.activePlayers.push(name);
      if (!db.playerDirectory.includes(name)) db.playerDirectory.push(name);
      saveDB();
      render();
    },

    finishSession() {
      const s = activeSession();
      if (!s.rounds.length) { alert('还没记过任何一局，不能结束'); return; }
      if (!confirm('结束后不能再记新局，确定结束本场吗？')) return;
      s.status = 'finished';
      s.finishedAt = new Date().toISOString();
      saveDB();
      App.goSettle(s.id, 'home');
    },

    goSettle: (sid, from) => go({ name: 'settle', sid, from: from || 'home' }),
    goRounds: (sid, from) => go({ name: 'rounds', sid, from: from || 'home' }),

    async copyText(sid) {
      const s = db.sessions.find((x) => x.id === sid);
      const ok = await copyToClipboard(L.summaryText(s));
      alert(ok ? '已复制，去粘贴发给牌友吧' : '复制失败，请改用「分享战绩图」或截图');
    },

    shareImage(sid) {
      const s = db.sessions.find((x) => x.id === sid);
      RunfastShare.share(s, L);
    },

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

  render();
})();
