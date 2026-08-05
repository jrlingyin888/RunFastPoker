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
    directory() { return []; }, onFinished() {}, onVoided() {}, saveName() {}, saveLocal() {},
  };
  function init(h) { host = Object.assign(host, h); }

  const state = { active: false, local: false, code: null, room: null, session: null,
    uid: null, pid: null, status: 'idle', payFrom: null, payTo: null };

  const LAST_NAME_KEY = 'runfast.lastName';
  const ROOM_KEY = 'runfast.sync.room';
  function lastName() { try { return localStorage.getItem(LAST_NAME_KEY) || ''; } catch (e) { return ''; } }

  // ---------- 进房 ----------
  // 先只读一次房间，再决定去哪：
  //   还在房里（没点过退出）→ 直接回记分页。刷新、切后台回来、重新扫码都走这条，
  //     用户没退出就不该被拦一道确认页——这是最常见的路径，必须一步到位。
  //   退出过 / 没进过 → 输名字页（退出过的会预填原名，可改，位置和分数不变）。
  // opts.silent：开机自动回房用，房间没了就安静回首页，不要弹窗吓人。
  async function preview(code, opts) {
    const silent = !!(opts && opts.silent);
    try {
      await S.signIn();
      state.uid = S.getUid();
      const { data } = await S.readRoom(code);
      if (data === null) {
        let saved = null;
        try { saved = JSON.parse(localStorage.getItem(ROOM_KEY) || 'null'); } catch (e) { /* 忽略 */ }
        if (saved && saved.code === code) localStorage.removeItem(ROOM_KEY);
        if (silent) { host.go({ name: 'home' }); return; }
        alert('房间 ' + code + ' 暂时进不去，可能房主还没建好或已关闭。已帮你填好房号，稍后点「进入房间」重试即可。');
        host.go({ name: 'joinRoom', code });
        return;
      }
      const pid = S.findMyPid(data, state.uid);
      state.room = data;
      if (pid && !data.players[pid].left) { await attach(code, pid); return; }
      // 字段叫 myName 不叫 name —— 路由对象上的 name 是视图名（'joinName'），撞了会把视图名渲染进输入框
      host.go({ name: 'joinName', code, pid, myName: pid ? data.players[pid].name : lastName() });
    } catch (e) {
      if (silent) { host.go({ name: 'home' }); return; }
      alert('进入房间失败：' + e.message);
    }
  }

  // ---------- 输名字 / 确认回归 ----------
  function joinView() {
    const v = host.view();
    const back = !!v.pid;   // 本机在这房间有过身份 → 这页是「确认回来」而不是「新加入」
    const dir = host.directory();
    return `
      ${U.topbar((back ? '回到房间 ' : '加入房间 ') + v.code, 'App.goHome()')}
      <div class="card">
        ${back ? `<div class="muted" style="margin-bottom:10px">你之前是「${esc(v.myName)}」，改个名也行，位置和分数不变。</div>` : ''}
        <div class="section-title">你的名字</div>
        <input type="text" id="myName" maxlength="8" placeholder="输入你的名字（8 字以内）" value="${esc(v.myName || '')}">
        ${dir.length ? `<div class="chips" style="margin-top:10px">${dir.map((n) =>
          `<button class="chip" onclick="Room.fillName('${esc(n)}')">${esc(n)}</button>`).join('')}</div>` : ''}
      </div>
      <button class="btn btn-primary" onclick="Room.confirmJoin()">${back ? '回到房间' : '进入房间'}</button>`;
  }

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

  // ---------- 记分主页 ----------
  function seatHtml(pid, points) {
    const p = state.room.players[pid];
    const left = !!p.left;
    const tag = left ? '<span class="left-tag">已退出</span>'
      : (!state.local && pid === state.pid) ? '<span class="me-tag">我</span>'
      : (!state.local && p.uid == null) ? '<span class="proxy-tag">代</span>' : '';
    const sign = points > 0 ? '+' : '';
    // 身份小药丸叠在头像右下角：跟着名字排会被 nowrap+省略号裁掉（「丽叶已退出」只剩「丽叶…」），
    // 自成一行又会把整列撑高一截。压在头像角上两个毛病都没有。
    return `<button class="seat${left ? ' left' : ''}${(!state.local && pid === state.pid) ? ' me' : ''}"
        data-room-act="seat" data-pid="${esc(pid)}">
      <span class="ava-wrap">
        <span class="ava" style="background:${U.avatarColor(p.name)}">${esc(U.initial(p.name))}</span>${tag}
      </span>
      <span class="nm">${esc(p.name)}</span>
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
  // 流水每隔一段时间插一条时间戳（像聊天记录那样），不是每笔都标。
  // 这一版不记「第几局」，牌友只能靠时间线判断哪几笔是同一局的，
  // 所以按「距上一组开头超过 2 分钟就另起一组」分段——正好接近牌桌上一局的节奏。
  const TX_GROUP_GAP = 2 * 60 * 1000;
  const pad2 = (n) => String(n).padStart(2, '0');
  function txTimeHtml(at) {
    const d = new Date(at);
    const now = new Date();
    const sameDay = d.getFullYear() === now.getFullYear()
      && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
    const label = (sameDay ? '' : (d.getMonth() + 1) + '月' + d.getDate() + '日 ')
      + pad2(d.getHours()) + ':' + pad2(d.getMinutes());
    return `<div class="tx-time"><span>${label}</span></div>`;
  }
  // 吃升序流水，吐倒序 HTML（最新在上）：每组顶上标该组最晚那笔的时间
  function txListHtml(list) {
    const groups = [];
    list.forEach((t) => {
      const at = t.at || 0;
      const g = groups[groups.length - 1];
      if (!g || at - g.start >= TX_GROUP_GAP) groups.push({ start: at, end: at, items: [t] });
      else { g.end = at; g.items.push(t); }
    });
    return groups.reverse()
      .map((g) => txTimeHtml(g.end) + g.items.slice().reverse().map(txRowHtml).join(''))
      .join('');
  }

  // 设备 id → 该设备绑定的玩家名（找不到就空字符串）
  function deviceName(uid) {
    const ps = state.room.players;
    const pid = Object.keys(ps).find((k) => ps[k].uid === uid);
    return pid ? ps[pid].name : '';
  }

  function roomView() {
    const r = state.room;
    // attach() 订阅完就立刻跳这一页，而 state.room 要等 SSE 第一帧才有。
    // 返回空串的话，微信内置浏览器 + 弱网下用户看到的是一整页空白：零按钮零文字，
    // 连返回和房号都没有，只能杀进程。给个能看出「在干什么」且退得出去的占位。
    if (!r) {
      return `
        ${U.topbar('连接中…' + (state.code ? ' · 房号 ' + state.code : ''), 'App.goHome()')}
        <div class="card">
          <div class="muted">正在连接房间${state.code ? ' ' + esc(state.code) : ''}，网络慢的话要几秒……</div>
        </div>
        <button class="btn" onclick="App.goHome()">返回首页</button>`;
    }
    const price = L.fenToYuan(r.pricePerCardFen);
    const list = S.txList(r);          // 升序；txListHtml 负责分组、插时间戳、倒序输出
    const net = netOf();
    const pids = Object.keys(r.players).sort((a, b) => (r.players[a].at || 0) - (r.players[b].at || 0));
    const actions = (state.local ? '' : '<button class="icon-btn" onclick="Room.share()">分享</button>')
      + '<button class="icon-btn" onclick="Room.more()">⋯</button>';
    const bar = state.local ? ''
      : `<div class="sync-bar"><span><span class="sync-dot ${state.status === 'connected' ? '' : 'off'}"></span>房号 ${esc(state.code)} · ${S.playingCount(r)} 人在玩</span></div>`;
    // 升级前记的半场本地牌局只有 rounds 没有 transfers：只数 tx 会显示「已记 0 笔」，
    // 而头像上明明有分，看着像分丢了。本地场一律交给 sessionSize 按「局/笔」算。
    const oldRounds = state.local ? (state.session.rounds || []).length : 0;
    const size = state.local ? L.sessionSize(state.session) : S.txList(r).length + ' 笔';
    return `
      ${U.topbar('已记 ' + size + ' · ' + price + '元/张', 'App.goHome()', actions)}
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
        ${txListHtml(list) || (oldRounds ? '' : '<div class="muted">还没有记录，谁赢了就点谁的头像</div>')}
        ${oldRounds ? `<div class="muted">这一场升级前按「局」记过 ${oldRounds} 局，分已经算进上面的头像里；从现在起每记一笔都会列在这里。</div>` : ''}
      </div>`;
  }

  // ---------- 支出弹窗 ----------
  // 独立的 overlay（不走 openSheet），因为要控制「校验没过时不关窗」。
  function closePay() {
    const el = document.getElementById('pay');
    if (el) el.remove();
    state.payTo = null;
    // payFrom 故意不清：本地单机没有「我」，下次开支出框要沿用这次选的付款人（见 openPay 的注释）
  }
  // 能当付款人的：不是收款人自己、且没退出。排序口径和 pickPayer 一致（按加入时间），
  // 否则兜底挑的人和面板上第一个人不是同一个，看着像随机的。
  function payerCandidates(toPid) {
    const ps = state.room.players;
    return Object.keys(ps)
      .filter((pid) => pid !== toPid && !ps[pid].left)
      .sort((a, b) => (ps[a].at || 0) - (ps[b].at || 0));
  }
  // preselect === false：从「有人给我记分」进来的。收款人是我、付款人只能是别人，
  // 而这一步正是用户要做的选择；替他默认选一个，输个数字点「支出」就把分记到别人头上了，
  // 流水又只增不删（只能反向再记一笔冲掉）。这条路径要求先显式点一次选人。
  function openPay(toPid, preselect) {
    const cands = payerCandidates(toPid);
    if (!cands.length) { alert('房间里还没有别人，先加个人吧'); return; }
    state.payTo = toPid;
    // 联机默认「我付」；本地单机没有「我」，沿用上次选的付款人（由 closePay 保留）
    if (!state.local) state.payFrom = state.pid;
    const fromOk = state.payFrom && state.payFrom !== toPid
      && state.room.players[state.payFrom] && !state.room.players[state.payFrom].left;
    if (!fromOk) state.payFrom = preselect === false ? null : cands[0];
    renderPay();
  }
  function renderPay() {
    const r = state.room;
    const from = state.payFrom ? r.players[state.payFrom] : null;  // 还没选付款人时为 null
    const to = r.players[state.payTo];
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
          ${from
            ? `<span class="ava" style="background:${U.avatarColor(from.name)}">${esc(U.initial(from.name))}</span>
               <span class="nm">${esc(from.name)} ▾</span><span class="muted">点这里换人</span>`
            : `<span class="ava" style="background:#9ca3af">?</span>
               <span class="nm">选择付款人 ▾</span><span class="muted">点这里选人</span>`}
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
      <button class="btn btn-primary" ${from ? '' : 'disabled style="opacity:.4"'} onclick="Room.submitPay()">支出</button>
    </div>`;
    const inp = document.getElementById('payPoints');
    if (inp) inp.focus();
  }
  // 输入实时折算成钱；没填就提示单价。校验口径必须和 submitPay 一致——
  // 否则 '1e3'/'99999'/'12.5' 这类会被提交拒掉的输入，这里却显示着看似正常的金额或默认提示，
  // 用户会以为能提交、点了才发现不行。
  function payHint(v) {
    const raw = String(v).trim();
    const price = state.room.pricePerCardFen;
    if (!raw) return '1 分 = ' + L.fenToYuan(price) + ' 元 · 全关就输 20';
    const n = Number(raw);
    if (!/^\d+$/.test(raw) || !Number.isInteger(n) || n <= 0 || n > 9999) return '请输入 1～9999 的整数分数';
    return n + ' 分 = ' + L.fenToYuan(n * price) + ' 元';
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
        // 只重绘、不跳转：进房那一下 attach 末尾已经跳过了。这里再跳的话，
        // 人跑去首页/历史看东西时，房里别人一记分就把他拽回记分页。
        if (['room', 'rounds', 'settle'].includes(host.view().name)) host.render();
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

  // 断开并清空内存态（不动 localStorage）
  function resetState() {
    S.close();
    closePay();   // 支出弹窗可能还开着（房间被删/结算/退出这类打断），别让黑色蒙层卡在下一页上
    state.active = false; state.local = false; state.code = null;
    state.room = null; state.session = null; state.pid = null; state.status = 'idle';
    state.payFrom = null; state.payTo = null;
  }
  // 主动退出 / 房间被关：额外忘掉「回到联机房间」入口，首页就不再显示它
  function close() {
    resetState();
    try { localStorage.removeItem(ROOM_KEY); } catch (e) { /* 忽略 */ }
  }

  // 邀请链接与邀请卡图片缓存（供分享面板用；下次分享时释放旧的）
  const inviteLink = () => location.origin + location.pathname + '?room=' + state.code;
  let inviteBlob = null, inviteUrl = null;

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
      } catch (e) {
        // 上面的 nameTaken 查的是 preview() 那一刻的快照；用户在这一页停留的十几秒里
        // 别人同名进了房，只有服务端在写入这一刻才看得见 ⇒ 403。这条路径上的 403 只可能是重名
        // （清 left/leftAt 走的是自己那条记录，权限恒过），给一条能直接照做的提示。
        if (e.status === 403) { alert('这个名字刚被人用了，换一个吧'); return; }
        alert('进入房间失败：' + e.message);
      }
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
      const items = payerCandidates(state.payTo).map((pid) => ({
        label: r.players[pid].name + (!state.local && pid === state.pid ? '（我）' : ''),
        data: { 'room-act': 'payer', pid },
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
      const ps = state.room.players;
      const from = state.payFrom, to = state.payTo;
      if (!from) { alert('先点上面的头像选一下：这笔分是谁支出的'); return; }
      // 弹窗开着的这段时间房间可能变了（对方退出、甚至联机端收到别的设备的广播）——提交前复查一遍，
      // 不能光信弹窗打开那一刻缓存的 from/to 还有效。
      if (!ps[from] || ps[from].left || !ps[to] || ps[to].left) {
        alert('TA 已退出房间');
        if (!ps[to] || ps[to].left) closePay(); else openPay(to);
        return;
      }
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
      // 本地场的数据形状里 players（花名册）和 activePlayers（在场）并存，只 push 前者的话，
      // 旧的（还没接线到 RunfastRoom 的）视图会把新人当成「已离场」——两个数组一起同步。
      if (state.local) { localApply((s) => { s.players.push(name); if (s.activePlayers) s.activePlayers.push(name); }); return; }
      try { await S.patch(state.code, '/players/' + S.newKey('p_'), { name, uid: null, at: Date.now() }); }
      catch (e) {
        // 服务端在写入这一刻做最终重名判定（本机看到的房间可能已经旧了几秒）
        if (e.status === 403) { alert('这个名字刚被人用了，换一个吧'); return; }
        alert('加人失败：' + e.message);
      }
    },

    // 分享：先生成「邀请卡」图片（房号+二维码），弹面板——主按钮把图片走系统分享（牌友收到图直接扫码进房），
    // 次按钮走系统分享发链接文字，长按卡片存整张。生成失败退回旧的简单面板（房号+二维码+复制），不卡住。
    async share() {
      const link = inviteLink(), code = state.code;
      let cv;
      try { cv = await RunfastShare.drawInviteCard(code, link); }
      catch (e) { Room.shareFallback(); return; }
      const blob = await RunfastShare.toBlob(cv);
      if (!blob) { Room.shareFallback(); return; }
      if (inviteUrl) URL.revokeObjectURL(inviteUrl);
      inviteBlob = blob;
      inviteUrl = URL.createObjectURL(blob);
      const header = `<div style="text-align:center;padding:4px 0 2px">
        <img src="${inviteUrl}" alt="扫码进房" style="width:100%;max-width:270px;border-radius:14px;display:block;margin:0 auto;box-shadow:0 6px 18px rgba(0,0,0,.35)">
        <div class="muted" style="margin-top:10px">长按上图保存整张 · 或用下面按钮发出去</div>
      </div>`;
      U.openSheet([
        { label: '📤 分享二维码图片', onclick: 'Room.shareInviteImage()' },
        { label: '🔗 分享链接文字', onclick: 'Room.shareInviteLink()' },
        { label: '复制链接', onclick: 'Room.copyInvite()' },
      ], header);
    },

    // 主：把邀请卡当图片文件走系统分享（微信/群里收到的是图，直接扫码进房）；不支持文件分享则桌面下载 / 手机提示长按
    async shareInviteImage() {
      if (!inviteBlob) return;
      const file = new File([inviteBlob], '跑得快房间' + (state.code || '') + '.png', { type: 'image/png' });
      if (navigator.canShare && navigator.canShare({ files: [file] })) {
        try { await navigator.share({ files: [file], title: '跑得快记分', text: '扫码进房记分（房号 ' + state.code + '）' }); return; }
        catch (e) { if (e.name === 'AbortError') return; }
      }
      if (!('ontouchstart' in window)) { const a = document.createElement('a'); a.href = inviteUrl; a.download = file.name; a.click(); }
      else alert('长按上面的图片即可保存或转发到微信');
    },

    // 次：走系统分享把邀请链接文字发出去（需要可点链接时用）；无系统分享则退回复制
    async shareInviteLink() {
      const link = inviteLink();
      if (navigator.share) {
        try { await navigator.share({ title: '跑得快记分', text: '一起来记分（房号 ' + state.code + '）', url: link }); return; }
        catch (e) { if (e.name === 'AbortError') return; }
      }
      Room.copyInvite();
    },

    shareFallback() {
      const link = inviteLink();
      const header = `<div style="text-align:center;padding:10px 0 4px">
        <div class="muted">房号</div>
        <div style="font-size:34px;font-weight:800;letter-spacing:4px">${U.esc(state.code)}</div>
        <img src="qr?text=${encodeURIComponent(link)}" alt="扫码进房" onerror="this.remove()"
             style="width:180px;height:180px;margin:10px auto 6px;display:block">
        <div class="muted">让牌友扫码，或复制链接发群里</div>
        <div class="muted" style="word-break:break-all;margin-top:4px">${U.esc(link)}</div>
      </div>`;
      U.openSheet([{ label: '复制链接', onclick: 'Room.copyInvite()' }], header);
    },

    async copyInvite() {
      const ok = await U.copyToClipboard('来跑得快记分房间围观/记分：' + inviteLink() + '（房号 ' + state.code + '）');
      alert(ok ? '邀请链接已复制，发到群里吧' : '复制失败，请手动把房号告诉牌友：' + state.code);
    },

    // 点自己头像：替别人记一笔给我 / 改昵称 / 退出房间
    mePanel() {
      const p = state.room.players[state.pid];
      U.openSheet([
        // 「谁赢了点谁的头像」记的是「我付给 TA」，自己赢了就得由输的人点。可输的人不一定有手机
        // （＋加进来的代记玩家），或干脆只有我这一台设备在记——没有这个入口就永远记不上自己赢的分。
        { label: '💰 有人给我记分', onclick: 'Room.payMe()' },
        { label: '✏️ 更新昵称', onclick: 'Room.rename()' },
        { label: '🚪 退出房间', onclick: 'Room.leave()', danger: true },
      ], `<div class="sheet-head">${esc(p.name)}</div>`);
    },
    // 收款人是我；付款人不预选，必须自己点一次（记一笔就删不掉，见 openPay 的注释）
    payMe() { openPay(state.pid, false); },

    async rename() {
      if (state.local) { alert('本地单机没有「我」，改名请点那个人的头像旁边的加人重来'); return; }
      const p = state.room.players[state.pid];
      const next = (window.prompt('把「' + p.name + '」改成：', p.name) || '').trim();
      if (!next || next === p.name) return;
      if (!U.validName(next)) { alert('名字需 1～8 个字，且不能含引号等特殊符号'); return; }
      if (S.nameTaken(state.room, next, state.pid)) { alert('房间里已经有人叫这个名字了'); return; }
      try { await S.patch(state.code, '/players/' + state.pid + '/name', next); host.saveName(next); }
      catch (e) {
        // 同 confirmJoin：本机的重名判断基于可能已过期的房间快照，服务端才是最终裁决
        if (e.status === 403) { alert('这个名字刚被人用了，换一个吧'); return; }
        alert('改名失败：' + e.message);
      }
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
        // 本地场只能有一个 active，没有出口就锁死了：新开一场、一笔没记就返回首页，
        // 「开新一场（本地）」从此消失（首页只剩「继续本场」），而「结束本场」又要求至少记过一笔——
        // 用户只能记一笔假账或清浏览器数据才能脱身。联机场不给这个入口：作废等于删别人的房间，
        // 本次改版已去房主化，不恢复。
        items.push({ label: '🗑 作废本场', onclick: 'Room.voidLocal()', danger: true });
      }
      U.openSheet(items);
    },

    // 作废本场（仅本地场）：整条 session 删掉、不进历史，首页立刻恢复「开新一场（本地）」
    voidLocal() {
      if (!state.local || !state.session) return;
      if (!confirm('作废后本场所有记录将被删除、不进历史，确定作废？')) return;
      const sid = state.session.id;
      resetState();   // 用 resetState 不用 close：别把「回到联机房间」的房号也顺手清了
      host.onVoided(sid);
    },

    // 只读地看当前结算方案：结算页在 from==='room' 时每次重绘都现取快照，不存旧数据
    settle() {
      host.go({ name: 'settle', sid: snapshot().id, from: 'room' });
    },

    async finish() {
      // 升级前按「局」记的半场本地牌局只有 rounds 没有 tx。只看 tx 会把它判成「没记过分」而拒绝结算，
      // 于是它永远停在 active：首页永远显示「继续本场」、永远开不了新的本地场，且流水只增不删，
      // 用户只能靠记一笔假账脱身。本地场必须把 rounds 也算上（联机场没有 rounds，不受影响）。
      const hasOldRounds = state.local && (state.session.rounds || []).length > 0;
      if (!S.txList(state.room).length && !hasOldRounds) { alert('还没记过分，不能结算'); return; }
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
  };
  if (typeof window !== 'undefined') window.Room = Room;

  // 座位/换人这类带「玩家」数据的按钮一律走 data-*，不把任何数据拼进内联 onclick——
  // onclick 的内容是当 JS 源码编译的，浏览器会先把属性值里的 &#39; 解回 '，esc() 只挡得住
  // HTML 属性这一层，挡不住紧接着的 JS 字符串拼接（pid/名字都可能来自别的设备，不可信）。
  if (typeof document !== 'undefined') {
    document.addEventListener('click', (ev) => {
      const t = ev.target;
      const el = t && t.closest ? t.closest('[data-room-act]') : null;
      if (!el) return;
      const pid = el.getAttribute('data-pid');
      const act = el.getAttribute('data-room-act');
      if (act === 'seat') Room.tapSeat(pid);
      else if (act === 'payer') Room.setPayer(pid);
    });
  }

  const api = { init, preview, attach, close, lastName, startLocal, snapshot, state,
    views: { joinName: joinView, room: roomView } };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  return api;
})();
