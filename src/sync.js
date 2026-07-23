// 联机同步：局域网自建服务器（同源 REST + SSE，无 SDK、无第三方依赖）。
// 浏览器全局 RunfastSync；Node 下 module.exports 供纯函数测试。
var RunfastSync = (function () {
  'use strict';

  // 页面由主机服务器（server.js）发出时会注入 window.__RUNFAST_HOST__=true
  const configured = () => (typeof window !== 'undefined' && window.__RUNFAST_HOST__ === true);

  // ---------- 纯函数（与 v1.1 一致，原样保留）----------
  function genRoomCode(rand) {
    const r = rand || Math.random;
    let s = '';
    for (let i = 0; i < 6; i++) s += Math.floor(r() * 10);
    return s;
  }
  const validRoomCode = (s) => typeof s === 'string' && /^[0-9]{6}$/.test(s);
  const canEdit = (room, uid) => !!room && !!uid && (room.creatorUid === uid || room.allowEdit === true);
  const canAdmin = (room, uid) => !!room && !!uid && room.creatorUid === uid;

  // 记分锁：房间里有人正在「记一局」时占用 room.editing={uid,at}；
  // 超过 TTL 视为失效（防止有人中途退出/断线把整桌卡死）。返回生效中的锁或 null。
  const LOCK_TTL = 120000;
  function activeLock(room, now) {
    const e = room && room.editing;
    if (!e || !e.uid) return null;
    return (now - e.at < LOCK_TTL) ? e : null;
  }

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

  // 兜底：把可能缺失的数组字段补回（本服务器用 JSON 落地不会丢空数组，但保持幂等无害）
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

  // ---------- 设备身份（取代 Firebase 匿名认证）----------
  const DEV_KEY = 'runfast.device';
  let deviceId = null;
  function newId() {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
    return 'd' + Math.random().toString(36).slice(2) + Date.now().toString(36);
  }
  async function signIn() {
    if (deviceId) return { uid: deviceId };
    try {
      deviceId = localStorage.getItem(DEV_KEY);
      if (!deviceId) { deviceId = newId(); localStorage.setItem(DEV_KEY, deviceId); }
    } catch (e) { if (!deviceId) deviceId = newId(); } // localStorage 不可用则仅内存态
    return { uid: deviceId };
  }
  const getUid = () => deviceId;

  // ---------- REST（同源相对路径，带 X-Device-Id）----------
  const roomUrl = (code) => '/rooms/' + code;

  async function readRoom(code) {
    const res = await fetch(roomUrl(code));
    if (!res.ok) throw new Error('读取失败 ' + res.status);
    return { data: normalizeRoom(await res.json()) };
  }

  async function writeRoom(code, data) {
    const res = await fetch(roomUrl(code), {
      method: data === null ? 'DELETE' : 'PUT',
      headers: { 'Content-Type': 'application/json', 'X-Device-Id': deviceId },
      body: data === null ? undefined : JSON.stringify(data),
    });
    if (res.status === 403) throw new Error('没有修改权限');
    if (!res.ok) throw new Error('写入失败 ' + res.status);
  }

  // 读-改-写（局域网服务器按请求串行处理，无需 ETag 乐观锁）
  async function mutate(code, opFn) {
    const { data } = await readRoom(code);
    if (data === null) throw new Error('房间不存在或已关闭');
    const next = opFn(JSON.parse(JSON.stringify(data)));
    await writeRoom(code, next);
    return next;
  }

  async function createRoom(session) {
    await signIn();
    for (let i = 0; i < 5; i++) {
      const code = genRoomCode();
      const { data } = await readRoom(code);
      if (data !== null) continue; // 房号被占用，换一个
      const room = { creatorUid: deviceId, allowEdit: false, updatedAt: Date.now(), session };
      await writeRoom(code, room);
      return code;
    }
    throw new Error('建房失败，请重试');
  }

  async function deleteRoom(code) {
    await writeRoom(code, null);
  }

  // ---------- SSE 订阅（同源，无 token）----------
  let es = null, currentCode = null, cb = null, room = null, retryTimer = null, gen = 0;

  async function subscribe(code, callbacks) {
    close();
    currentCode = code;
    cb = callbacks;
    openStream();
  }

  function openStream() {
    const g = ++gen;
    clearTimeout(retryTimer);
    if (es) { es.close(); es = null; }
    if (!currentCode) return;
    if (cb && cb.onStatus) cb.onStatus('connecting');
    es = new EventSource(roomUrl(currentCode) + '/events');
    es.addEventListener('put', onEvt);
    es.onopen = () => { if (g === gen && cb && cb.onStatus) cb.onStatus('connected'); };
    es.onerror = () => {
      if (g !== gen) return;
      if (cb && cb.onStatus) cb.onStatus('connecting');
      // 初始连接失败时浏览器置 CLOSED 且不再自动重试，需手动重开
      if (es && es.readyState === EventSource.CLOSED) scheduleRetry();
    };
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
    clearTimeout(retryTimer);
    if (es) es.close();
    es = null; room = null; currentCode = null; cb = null;
  }

  const api = { configured, genRoomCode, validRoomCode, canEdit, canAdmin, activeLock, applyEvent, normalizeRoom,
    signIn, getUid, createRoom, readRoom, subscribe, mutate, deleteRoom, close };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  return api;
})();
