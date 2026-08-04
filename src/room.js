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

  const api = { init, preview, attach, close, lastName, state,
    views: { joinName: joinView } };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  return api;
})();
