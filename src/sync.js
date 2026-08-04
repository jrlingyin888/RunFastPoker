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

  // 兜底：把可能缺失的 map 字段补回（幂等，无害）
  function normalizeRoom(room) {
    if (room) { room.players ||= {}; room.tx ||= {}; }
    return room;
  }

  // ---------- 房间纯函数 ----------
  // 唯一 key：并发写落在不同 key 上，服务器逐个落盘就不会互相覆盖。
  function newKey(prefix) {
    return prefix + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  // 按设备 id 找回自己那条玩家记录 —— 回归房间认的是设备，不是名字。
  function findMyPid(room, uid) {
    if (!room || !room.players || !uid) return null;
    return Object.keys(room.players).find((pid) => room.players[pid].uid === uid) || null;
  }

  // 在玩的人数（已退出的不算）
  function playingCount(room) {
    const ps = (room && room.players) || {};
    return Object.keys(ps).filter((pid) => !ps[pid].left).length;
  }

  // 名字是否被别人占了。流水按名字展示，重名就认不出谁是谁，所以进房和改名都要挡。
  function nameTaken(room, name, exceptPid) {
    const ps = (room && room.players) || {};
    return Object.keys(ps).some((pid) => pid !== exceptPid && ps[pid].name === name);
  }

  // 流水 map → 按时间升序的数组
  function txList(room) {
    const tx = (room && room.tx) || {};
    return Object.keys(tx)
      .map((id) => Object.assign({ id }, tx[id]))
      .sort((a, b) => (a.at || 0) - (b.at || 0));
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

  // 字段级写：只更新指定路径（各人填各自那格互不覆盖）。403 → 没权限/座位已被占。
  async function patch(code, path, value) {
    const res = await fetch(roomUrl(code), {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', 'X-Device-Id': deviceId },
      body: JSON.stringify({ path, value }),
    });
    if (res.status === 403) throw new Error('没有权限或座位已被占');
    if (!res.ok) throw new Error('操作失败 ' + res.status);
  }

  // 建房：房号试 5 次，建房人自己就是第一个玩家。
  async function createRoom(init) {
    await signIn();
    for (let i = 0; i < 5; i++) {
      const code = genRoomCode();
      const { data } = await readRoom(code);
      if (data !== null) continue; // 房号被占用，换一个
      const pid = newKey('p_');
      await writeRoom(code, {
        creatorUid: deviceId,
        sid: 's' + Date.now(),
        createdAt: new Date().toISOString(),
        pricePerCardFen: init.pricePerCardFen,
        status: 'active',
        players: { [pid]: { name: init.name, uid: deviceId, at: Date.now() } },
        tx: {},
      });
      return { code, pid };
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

  const api = { configured, genRoomCode, validRoomCode,
    newKey, findMyPid, playingCount, nameTaken, txList,
    applyEvent, normalizeRoom, signIn, getUid, createRoom, readRoom, subscribe, patch, writeRoom, deleteRoom, close };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  return api;
})();
