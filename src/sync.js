// 联机同步：Firebase RTDB REST + SSE，无 SDK。
// 浏览器全局 RunfastSync；Node 下 module.exports 供纯函数测试。
var RunfastSync = (function () {
  'use strict';

  // Task 6 由控制器替换为真实值
  const FB = {
    apiKey: 'AIzaSyDr-5S8Q9jcDUxu4ebJUpz58NzjejTjjgE',
    databaseURL: 'https://runfast-scorer-default-rtdb.asia-southeast1.firebasedatabase.app',
  };
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

  // RTDB 不存储空数组/空对象：读回的 session 需补回数组字段，否则 .length/.map 会崩
  function normalizeRoom(room) {
    if (room && room.session) {
      const s = room.session;
      s.players ||= [];
      s.activePlayers ||= [];
      s.rounds ||= [];
      s.rounds.forEach((r) => { r.losers ||= []; });
    }
    return room;
  }

  // ---------- 匿名认证 ----------
  const AUTH_KEY = 'runfast.sync.v1';
  let auth = null; // {uid, idToken, refreshToken, expiresAt}
  let signInPromise = null;

  function saveAuth() {
    try { localStorage.setItem(AUTH_KEY, JSON.stringify(auth)); } catch (e) { /* 存储不可用时仅保留内存态 */ }
  }

  async function signIn() {
    if (auth) return auth;
    if (signInPromise) return signInPromise;
    signInPromise = (async () => {
      try {
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
        if (!res.ok) { auth = null; throw new Error('匿名登录失败'); }
        const d = await res.json();
        auth = { uid: d.localId, idToken: d.idToken, refreshToken: d.refreshToken, expiresAt: Date.now() + d.expiresIn * 1000 };
        saveAuth();
        return auth;
      } finally { signInPromise = null; }
    })();
    return signInPromise;
  }

  async function refreshIdToken() {
    const res = await fetch('https://securetoken.googleapis.com/v1/token?key=' + FB.apiKey, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'grant_type=refresh_token&refresh_token=' + encodeURIComponent(auth.refreshToken),
    });
    if (!res.ok) { // refresh token 失效则重新匿名注册（旧身份房间将失去房主权，可接受）
      try { localStorage.removeItem(AUTH_KEY); } catch (e) { /* 忽略 */ }
      auth = null;
      return signIn();
    }
    const d = await res.json();
    auth = { uid: d.user_id, idToken: d.id_token, refreshToken: d.refresh_token, expiresAt: Date.now() + d.expires_in * 1000 };
    saveAuth();
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
    if (res.status === 401 || res.status === 403) throw new Error('没有修改权限');
    if (!res.ok) throw new Error('读取失败 ' + res.status);
    return { data: normalizeRoom(await res.json()), etag: res.headers.get('ETag') };
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
  let es = null, currentCode = null, cb = null, room = null;
  let resubTimer = null, retryTimer = null, gen = 0;

  async function subscribe(code, callbacks) {
    close();
    currentCode = code;
    cb = callbacks;
    await openStream();
  }

  async function openStream(forceRefresh) {
    const g = ++gen;
    clearTimeout(resubTimer);
    clearTimeout(retryTimer);
    if (es) { es.close(); es = null; }
    if (!currentCode) return;
    if (cb && cb.onStatus) cb.onStatus('connecting');
    let token;
    try {
      if (forceRefresh) await refreshIdToken();
      token = await freshToken();
    } catch (e) { if (g === gen) scheduleRetry(); return; } // 取 token 失败（如断网）：稍后重试，订阅不死；被取代的旧尝试不再重试
    if (g !== gen || !currentCode) return;   // 期间被新的 subscribe/close 取代
    es = new EventSource(roomUrl(currentCode) + '?auth=' + token);
    es.addEventListener('put', onEvt);
    es.addEventListener('patch', onEvt);
    es.addEventListener('auth_revoked', () => { openStream(true); }); // 强制换新 token 重连
    es.onopen = () => { if (cb && cb.onStatus) cb.onStatus('connected'); };
    es.onerror = () => {
      if (cb && cb.onStatus) cb.onStatus('connecting');
      // 初始连接被拒（如 token 已失效）时浏览器置 CLOSED 且不再自动重试，需手动重开
      if (es && es.readyState === EventSource.CLOSED) scheduleRetry();
    };
    resubTimer = setTimeout(() => openStream(), 50 * 60 * 1000); // token 过期前主动换流
  }

  function scheduleRetry() {
    clearTimeout(retryTimer);
    retryTimer = setTimeout(() => openStream(), 3000);
  }

  function onEvt(e) {
    if (!cb) return; // close() 之后到达的迟到事件
    const { path, data } = JSON.parse(e.data);
    room = normalizeRoom(applyEvent(room, path, data));
    if (room === null) { if (cb.onDeleted) cb.onDeleted(); return; }
    if (cb.onRoom) cb.onRoom(room);
  }

  function close() {
    gen++;
    clearTimeout(resubTimer);
    clearTimeout(retryTimer);
    if (es) es.close();
    es = null; room = null; currentCode = null; cb = null;
  }

  const api = { configured, genRoomCode, validRoomCode, canEdit, canAdmin, applyEvent, normalizeRoom,
    signIn, getUid, createRoom, readRoom, subscribe, mutate, deleteRoom, close };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  return api;
})();
