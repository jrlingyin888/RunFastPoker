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

  // 从粘贴进来的任意文本里抠出 6 位房号：整条邀请链接、群里那段邀请话、或者干脆就是 6 位数字。
  // 优先认 room= 参数（我们自己链接的格式，最可靠），再认「房号 xxxxxx」，最后才找孤立的 6 位数。
  // 不用 (?<!\d) 这种后行断言——iOS 16.4 之前的 Safari 不支持，整个脚本会直接语法错误。
  function parseRoomCode(text) {
    if (typeof text !== 'string') return null;
    // 全角数字先转半角：中文输入法和某些复制粘贴会带全角
    const s = text.replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));
    const byParam = s.match(/room=(\d{6})(?!\d)/i);
    if (byParam) return byParam[1];
    const byLabel = s.match(/房号[^\d]{0,4}(\d{6})(?!\d)/);
    if (byLabel) return byLabel[1];
    const bare = s.match(/(?:^|\D)(\d{6})(?!\d)/);
    return bare ? bare[1] : null;
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

  // HTTP 状态码挂在 error 上：调用方要靠它区分「服务端拒了」和「网络挂了」，
  // 才能给出「这个名字刚被人用了」这种能看懂的提示，而不是笼统的失败。
  function httpError(msg, status) {
    const e = new Error(msg);
    e.status = status;
    return e;
  }

  async function writeRoom(code, data) {
    const res = await fetch(roomUrl(code), {
      method: data === null ? 'DELETE' : 'PUT',
      headers: { 'Content-Type': 'application/json', 'X-Device-Id': deviceId },
      body: data === null ? undefined : JSON.stringify(data),
    });
    if (res.status === 403) throw httpError('没有修改权限', 403);
    if (!res.ok) throw httpError('写入失败 ' + res.status, res.status);
  }

  // 字段级写：只更新指定路径（各人填各自那格互不覆盖）。403 → 服务端校验没过（名字被占/座位已被占等）。
  async function patch(code, path, value) {
    const res = await fetch(roomUrl(code), {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', 'X-Device-Id': deviceId },
      body: JSON.stringify({ path, value }),
    });
    if (res.status === 403) throw httpError('没有权限或座位已被占', 403);
    if (!res.ok) throw httpError('操作失败 ' + res.status, res.status);
  }

  // 建房：房号试 5 次，建房人自己就是第一个玩家。
  async function createRoom(init) {
    await signIn();
    for (let i = 0; i < 5; i++) {
      const code = genRoomCode();
      const { data } = await readRoom(code);
      if (data !== null) continue; // 房号被占用，换一个
      const pid = newKey('p_');
      try {
        await writeRoom(code, {
          creatorUid: deviceId,
          sid: 's' + Date.now(),
          createdAt: new Date().toISOString(),
          pricePerCardFen: init.pricePerCardFen,
          status: 'active',
          players: { [pid]: { name: init.name, uid: deviceId, at: Date.now() } },
          tx: {},
        });
      } catch (e) {
        // 读到「没人用」和真正写进去之间，别人可能刚好占了这个号：服务端禁止整房覆盖 ⇒ 403。
        // 这是「换个号重试」的场景，不是错误——直接冲出循环的话用户看到的是词不达意的
        // 「建房失败：没有修改权限」。非 403（网络挂了、服务端 500）照旧抛出去。
        if (e.status !== 403) throw e;
        continue;
      }
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

  const api = { configured, genRoomCode, validRoomCode, parseRoomCode,
    newKey, findMyPid, playingCount, nameTaken, txList,
    applyEvent, normalizeRoom, signIn, getUid, createRoom, readRoom, subscribe, patch, writeRoom, deleteRoom, close };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  return api;
})();
