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
        if (data.version === 1 && Array.isArray(data.sessions)) return data;
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
  const activeSession = () => db.sessions.find((s) => s.status === 'active') || null;
  const topbar = (title, backJs) =>
    `<div class="topbar">${backJs ? `<button class="back" onclick="${backJs}">‹ 返回</button>` : ''}<div class="title">${title}</div></div>`;

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
    return `
      ${topbar('开新一场', 'App.goHome()')}
      <div class="card">
        <div class="section-title">选择玩家（2～8 人）</div>
        <div class="chips">
          ${db.playerDirectory.map((n) =>
            `<button class="chip ${sel.includes(n) ? 'on' : ''}" onclick="App.togglePlayer('${esc(n)}')">${esc(n)}</button>`).join('')
          || '<span class="muted">还没有玩家，先在下面添加</span>'}
        </div>
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

  // 其余视图占位（后续任务实现）
  VIEWS.session = () => topbar('记分主页', 'App.goHome()') + '<div class="card muted">建设中</div>';
  VIEWS.history = () => topbar('历史记录', 'App.goHome()') + '<div class="card muted">建设中</div>';

  // ---------- 交互 ----------
  const App = {
    goHome: () => go({ name: 'home' }),
    goSetup: () => go({ name: 'setup', sel: [], price: '1' }),
    goSession: () => go({ name: 'session' }),
    goHistory: () => go({ name: 'history' }),

    togglePlayer(name) {
      view.price = document.getElementById('price').value; // 保留已输入的单价
      const i = view.sel.indexOf(name);
      if (i >= 0) view.sel.splice(i, 1); else view.sel.push(name);
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

    exportData() { alert('导出功能即将上线'); },  // Task 8 实现
    importData() { alert('导入功能即将上线'); },  // Task 8 实现
  };
  window.App = App;

  render();
})();
