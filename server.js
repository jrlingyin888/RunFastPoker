// 跑得快联机 · 局域网自建服务器（零第三方依赖：仅 Node 内置模块 + vendored MIT 二维码库）
// 双击「跑得快联机.command」即启动：发页面 + 房间实时同步 + 权限校验 + 数据落地。
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');
const qrcode = require('./src/vendor/qrcode.js');

const ROOT = __dirname;
const PORT = Number(process.env.PORT) || 8787;

// 记分页/主机页禁止缓存：手机(尤其微信内置浏览器)默认会缓存 HTML，
// 导致更新后仍跑旧 JS。强制每次拿最新，避免"改了还是旧行为"。
const HTML_HEADERS = {
  'Content-Type': 'text/html; charset=utf-8',
  'Cache-Control': 'no-store, no-cache, must-revalidate',
  Pragma: 'no-cache',
  Expires: '0',
};

// ---------- 局域网寻址 ----------
function lanIP() {
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const ni of ifaces[name] || []) {
      if (ni.family === 'IPv4' && !ni.internal &&
          /^(192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/.test(ni.address)) {
        return ni.address;
      }
    }
  }
  return null;
}
function lanURL(port) { return 'http://' + (lanIP() || 'localhost') + ':' + port + '/'; }

// 对外基础地址：优先按「这次请求实际打进来的域名」算。
// 公网部署（Nginx 反代 https://ipa.ydyrx.top → 本机 :8787）时 lanIP() 取不到内网段，
// 旧逻辑会退化成 http://localhost:8787/，手机扫码指向的是手机自己 ⇒ 进不去。
// 改为读 Host / X-Forwarded-* ，让同一份代码在「公网反代」和「局域网自建」两种部署都给出手机可达的地址。
function reqBaseURL(req, port) {
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();
  const isLocal = !host || /^(localhost|127\.0\.0\.1|\[?::1\]?)(:\d+)?$/i.test(host);
  if (isLocal) return lanURL(port);          // 本机/局域网自建：回退到手机可达的局域网 IP
  const proto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim()
    || (host.includes(':') ? 'http' : 'https'); // 带端口多为内网直连(HTTP)；纯域名默认按 HTTPS
  return proto + '://' + host + '/';
}

// 主机标志注入：把 dist 里的占位注释替换为设置 window.__RUNFAST_HOST__ 的脚本。
// 页面由本服务器发出时联机可用；GitHub Pages 等静态托管无此替换 ⇒ 仅单机。
function injectHostFlag(html) {
  return html.replace('<!--RUNFAST_HOST-->', '<script>window.__RUNFAST_HOST__=true</script>');
}

// ---------- 二维码（服务器端生成内联 SVG，浏览器无需任何脚本）----------
function qrSvg(text) {
  const qr = qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  return qr.createSvgTag(6, 4);
}

// ---------- 主机页 ----------
function hostPage(url) {
  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>跑得快联机 · 入口</title>
<style>
  body{margin:0;min-height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;
    background:linear-gradient(160deg,#14532d,#0c3b20);color:#f8fafc;
    font-family:-apple-system,system-ui,sans-serif;padding:24px;box-sizing:border-box}
  h1{font-size:22px;margin:0 0 6px}
  .qr{background:#fff;padding:16px;border-radius:16px;margin:18px 0}
  .qr svg{display:block;width:min(60vw,320px);height:auto}
  .url{font-size:20px;font-weight:700;color:#fbbf24;word-break:break-all;text-align:center}
  .hint{color:#86efac;font-size:14px;margin-top:12px;text-align:center;line-height:1.7;max-width:360px}
  .n{color:#fbbf24;font-weight:700}
</style></head><body>
  <h1>🃏 跑得快联机</h1>
  <div class="hint">手机用<b>相机 / 系统浏览器</b>扫码直接进入（微信里点右上角「···」→ 用浏览器打开更稳）</div>
  <div class="qr" id="qr">${qrSvg(url)}</div>
  <div class="url" id="url">${url}</div>
  <div class="hint">在线牌友：<span class="n" id="n">0</span> 人<br>
    扫码或保存这张图，随时开局。</div>
  <script>
    // 以「浏览器真实访问地址」为准重算二维码与地址：无论是否经过反代，都指向本页所在的公网/局域网入口，
    // 手机扫码即进开场界面，不必手打网址；也保证保存到相册的这张码是对的。
    (function(){
      var h = location.hostname;
      // 页面就开在本机 localhost 时，location.origin 手机不可达；保留服务端算好的局域网地址，别覆盖。
      if (h === 'localhost' || h === '127.0.0.1' || h === '::1' || h === '') return;
      var base = location.origin + '/';
      var urlEl = document.getElementById('url');
      if (urlEl) urlEl.textContent = base;
      fetch('/qr?text=' + encodeURIComponent(base))
        .then(function(r){ return r.ok ? r.text() : null; })
        .then(function(svg){ var q = document.getElementById('qr'); if (svg && q) q.innerHTML = svg; })
        .catch(function(){});
    })();
    setInterval(function(){
      fetch('/status').then(function(r){return r.json();}).then(function(s){
        document.getElementById('n').textContent = s.clients;
      }).catch(function(){});
    }, 3000);
  </script>
</body></html>`;
}

// ---------- 权限校验（服务器强制）----------
// 按路径深设：'/a/b/2/c' → 设 obj.a.b[2].c=value（value 为 null 删该键）。返回新对象，不改原对象。
function setPath(obj, path, value) {
  if (!path || path === '/') return value;
  const keys = path.replace(/^\//, '').split('/');
  // 纵深防御：canPatch 已经挡了 __proto__/constructor/prototype，这里再兜一层——
  // setPath 才是真正往对象里写值的原语，就算上层校验将来出现疏漏，也不能从这里污染原型链。
  if (keys.some((k) => k === '__proto__' || k === 'constructor' || k === 'prototype')) return obj;
  const next = obj ? JSON.parse(JSON.stringify(obj)) : {};
  let node = next;
  for (let i = 0; i < keys.length - 1; i++) {
    if (node[keys[i]] == null) node[keys[i]] = {};
    node = node[keys[i]];
  }
  const last = keys[keys.length - 1];
  if (value === null) delete node[last];
  else node[last] = value;
  return next;
}

// 名字字符集：与前端 RunfastUI.validName 保持一致（1~8 字，不含引号/尖括号/反斜杠）。
// 前端已经挡了，但服务端不能只信前端——服务端才是唯一必须守住的边界。
const VALID_NAME = /^[^'"<>\\]{1,8}$/;

// 一笔转账是否合法：双方都得是房内玩家、不能自己转自己、分数是正整数。
function isValidTx(v, players) {
  if (!v || typeof v !== 'object') return false;
  const has = (k) => typeof k === 'string' && Object.prototype.hasOwnProperty.call(players, k);
  return has(v.from) && has(v.to) && v.from !== v.to
    && Number.isInteger(v.points) && v.points > 0 && v.points <= 9999;
}

// pid / tx id 这类客户端生成的 key 的字符集：只认 [A-Za-z0-9_-]，1~64 字符
// （与 canPatch 里 /tx/、/players/ 路径正则用的是同一套字符集，这里单独抽出来给 canWrite 建房校验复用）。
const KEY_RE = /^[A-Za-z0-9_-]{1,64}$/;

// 房内是否已有人叫这个名字（exceptPid 是改名时排除的自己那条）。
// 服务端必须自己查这一条：客户端的 nameTaken 查的是「进房前读到的那份快照」，
// 用户停在输名字页的十几秒里别人同名进房，客户端就漏过去了。重名一旦落库，
// 结算页会出现两行同名（金额各算各的、净额总和不为 0），这条 session 进本地历史后
// 还会让整份备份文件导不回去（app.js 的 importValid 查玩家名唯一），换手机时全部历史一次丢光。
function nameTakenIn(players, name, exceptPid) {
  return Object.keys(players).some((pid) => pid !== exceptPid && players[pid] && players[pid].name === name);
}

// 建房走 PUT，此后一切增量走 PATCH——房间已存在时禁止整房覆盖，避免有人拿旧快照盖掉别人刚记的分。
// 建房这一刻此前只查了 creatorUid：players/tx 的内容完全没校验，等于绕开了 canPatch 逐字段做的
// 那些校验——攻击者可以直接在建房的房间快照里一次性塞进恶意 pid、恶意名字、或凭空捏造的转账。
// 建房必须补上同等级别的校验，否则「字段级校验很严格」只是错觉，口子就开在创建那一刻。
function canWrite(old, neu, me) {
  if (!me) return false;
  if (old) return false;
  if (!neu || neu.creatorUid !== me) return false;
  // 单价参与每一次结算，logic.js 一律以「分」（正整数）计算：非整数/负数/缺失都会让
  // 每个牌友的记分页与战绩图显示「NaN 元」，且这个值一建房就定死、事后改不了。
  if (!(Number.isInteger(neu.pricePerCardFen) && neu.pricePerCardFen > 0)) return false;
  // sid / createdAt 会被各端原样快照进本地历史，长期留在别人手机上：限制成合理的字符串。
  // sid 复用 KEY_RE（客户端本来就是 's'+时间戳），顺带堵死「把 JS 片段塞进 sid」这条老路。
  if (!(typeof neu.sid === 'string' && KEY_RE.test(neu.sid))) return false;
  if (!(typeof neu.createdAt === 'string' && neu.createdAt.length <= 64)) return false;
  if (neu.players !== undefined) {
    if (!neu.players || typeof neu.players !== 'object') return false;
    for (const pid of Object.keys(neu.players)) {
      if (!KEY_RE.test(pid)) return false;
      const p = neu.players[pid];
      if (!p || typeof p !== 'object' || typeof p.name !== 'string' || !VALID_NAME.test(p.name)) return false;
      // 建房那一刻就重名的话，后面每一笔流水都认不出是谁、备份也导不回去 —— 从源头堵住
      if (nameTakenIn(neu.players, p.name, pid)) return false;
    }
  }
  if (neu.tx !== undefined) {
    if (!neu.tx || typeof neu.tx !== 'object') return false;
    for (const id of Object.keys(neu.tx)) {
      if (!KEY_RE.test(id)) return false;
      if (!isValidTx(neu.tx[id], neu.players || {})) return false;
    }
  }
  return true;
}

// 字段级写权限（服务器强制）。me = X-Device-Id。
// 房间模型是扁平 map：players/tx 的 key 由客户端生成，谁都能往自己的新 key 上写，
// 因此不存在「同一格互相覆盖」的并发冲突，也就没有房主特权可言。
function canPatch(old, path, value, me) {
  if (!me || !old || typeof path !== 'string') return false;
  // 路径段是客户端可控的：__proto__ / constructor 会让 setPath 写进原型链，污染整个进程
  if (path.split('/').some((k) => k === '__proto__' || k === 'constructor' || k === 'prototype')) return false;
  const players = (old.players && typeof old.players === 'object') ? old.players : {};

  // 记一笔转账：只收没用过的 id。已存在的 id 一律拒 → 流水只增不删、不可篡改。
  let m = path.match(/^\/tx\/([A-Za-z0-9_-]{1,64})$/);
  if (m) {
    if (Object.prototype.hasOwnProperty.call(old.tx || {}, m[1])) return false;
    return isValidTx(value, players);
  }

  // 建玩家：只收没用过的 id；名字要过字符集校验且房内不重名；uid 只能填自己或 null（代记没带手机的人）。
  m = path.match(/^\/players\/([A-Za-z0-9_-]{1,64})$/);
  if (m) {
    if (Object.prototype.hasOwnProperty.call(players, m[1])) return false;
    return !!value && typeof value === 'object' && typeof value.name === 'string' && VALID_NAME.test(value.name)
      && !nameTakenIn(players, value.name)
      && (value.uid === me || value.uid === null || value.uid === undefined);
  }

  // 改玩家字段。先用 hasOwnProperty 确认这是真实存在的玩家 key，再取值——
  // 否则 'hasOwnProperty'/'toString' 这类不在黑名单里、但原型链上本来就有的名字，
  // 裸下标 players[m[1]] 也能取出一个真值，被当成「没设备的代记玩家」放行。
  m = path.match(/^\/players\/([A-Za-z0-9_-]{1,64})\/(name|left|leftAt)$/);
  if (m) {
    if (!Object.prototype.hasOwnProperty.call(players, m[1])) return false;
    const p = players[m[1]];
    if (m[2] === 'name') {
      if (typeof value !== 'string' || !VALID_NAME.test(value)) return false;
      if (nameTakenIn(players, value, m[1])) return false;      // 撞了别人的名字（改回自己原名不算撞）
      return p.uid === me || p.uid == null;  // 自己的，或没设备的代记玩家
    }
    // 退出/回归只能自己来。值也要收窄：left/leftAt 会原样落库并广播给每个牌友，
    // 放任意类型任意大小就等于给了「用一次 PATCH 把房间撑成几百 KB」的口子（同 /finishedAt）。
    if (p.uid !== me) return false;
    if (m[2] === 'left') return value === true || value === null;      // 置退出 / 清退出标记
    return value === null || Number.isFinite(value);                   // leftAt：时间戳或清除
  }

  // uid 在建玩家那一刻定死，之后谁都不能改 —— 身份没法被抢。
  if (/^\/players\/[^/]+\/uid$/.test(path)) return false;

  if (path === '/status') return value === 'active' || value === 'finished';
  // 结束本场谁都能点，但值必须是「一个 ISO 时间串的样子」。
  // 无条件放行时，一个 PATCH 就能把 500KB 字符串（或嵌套对象）塞进房间：它会经 snapshot()
  // 进每个牌友的本地历史，saveDB() 写 localStorage 超 5MB 配额 → 弹「保存失败」，此后历史全存不下。
  if (path === '/finishedAt') return typeof value === 'string' && value.length <= 64;
  return false;
}

// ---------- 服务器工厂（每实例独立房间与数据文件，便于测试隔离）----------
function createRunfastServer(options = {}) {
  const dataFile = options.dataFile || path.join(ROOT, 'server-data.json');
  let rooms = {};
  try { rooms = JSON.parse(fs.readFileSync(dataFile, 'utf8')) || {}; } catch (e) { rooms = {}; }

  const subscribers = new Map(); // code -> Set<res>
  let saveTimer = null;
  function scheduleSave() {
    if (saveTimer) return;
    saveTimer = setTimeout(() => {
      saveTimer = null;
      try { fs.writeFileSync(dataFile, JSON.stringify(rooms)); }
      catch (e) { console.error('数据落地失败：', e.message); }
    }, 500);
  }
  function flush() {
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
    try { fs.writeFileSync(dataFile, JSON.stringify(rooms)); } catch (e) { /* 忽略 */ }
  }

  function sendFrame(res, data) {
    res.write('event: put\n');
    res.write('data: ' + JSON.stringify({ path: '/', data }) + '\n\n');
  }
  function broadcast(code) {
    const set = subscribers.get(code);
    if (!set) return;
    const data = rooms[code] || null;
    for (const res of set) sendFrame(res, data);
  }
  function clientCount() {
    let n = 0;
    for (const set of subscribers.values()) n += set.size;
    return n;
  }

  function readBody(req) {
    return new Promise((resolve) => {
      let b = '';
      req.on('data', (c) => { b += c; if (b.length > 1e6) req.destroy(); });
      req.on('end', () => resolve(b));
    });
  }
  const json = (res, code, obj) => {
    res.writeHead(code, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(obj));
  };

  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://localhost');
    const p = u.pathname;

    // 记分页（注入主机标志）
    if (req.method === 'GET' && p === '/') {
      let html;
      try { html = fs.readFileSync(path.join(ROOT, 'dist', 'index.html'), 'utf8'); }
      catch (e) { res.writeHead(500); res.end('缺少 dist/index.html，请先在项目目录运行 node build.js'); return; }
      res.writeHead(200, HTML_HEADERS);
      res.end(injectHostFlag(html));
      return;
    }
    // 主机页 / 入口页（屏幕看二维码；公网可分享保存）
    if (req.method === 'GET' && p === '/host') {
      const port = server.address() ? server.address().port : PORT;
      res.writeHead(200, HTML_HEADERS);
      res.end(hostPage(reqBaseURL(req, port)));
      return;
    }
    // 在线人数
    if (req.method === 'GET' && p === '/status') {
      json(res, 200, { clients: clientCount(), rooms: Object.keys(rooms).length });
      return;
    }
    // 二维码（邀请面板用）：局域网 HTTP 是非安全上下文，没有系统分享面板，扫码进房更实用。
    // 只读、无状态；text 长度设上限避免被拿来生成超大图。
    if (req.method === 'GET' && p === '/qr') {
      const text = u.searchParams.get('text') || '';
      if (!text || text.length > 512) { res.writeHead(400); res.end('bad text'); return; }
      let svg;
      try { svg = qrSvg(text); }
      catch (e) { res.writeHead(500); res.end('qr failed'); return; } // 库抛裸字符串，兜住以免拖垮整个服务
      res.writeHead(200, { 'Content-Type': 'image/svg+xml; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(svg);
      return;
    }

    // 房间接口 /rooms/<6位> 与 /rooms/<6位>/events
    const m = p.match(/^\/rooms\/(\d{6})(\/events)?$/);
    if (m) {
      const code = m[1], isEvents = !!m[2];

      if (isEvents && req.method === 'GET') {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        });
        sendFrame(res, rooms[code] || null);              // 首帧全量
        let set = subscribers.get(code);
        if (!set) { set = new Set(); subscribers.set(code, set); }
        set.add(res);
        const hb = setInterval(() => res.write(':keep-alive\n\n'), 30000);
        req.on('close', () => {
          clearInterval(hb); set.delete(res); if (!set.size) subscribers.delete(code);
        });
        return;
      }
      if (!isEvents && req.method === 'GET') { json(res, 200, rooms[code] || null); return; }
      if (!isEvents && req.method === 'PUT') {
        const me = req.headers['x-device-id'];
        let neu;
        try { neu = JSON.parse(await readBody(req)); } catch (e) { json(res, 400, { error: 'bad json' }); return; }
        if (!canWrite(rooms[code] || null, neu, me)) { json(res, 403, { error: 'forbidden' }); return; }
        rooms[code] = neu; scheduleSave(); broadcast(code);
        json(res, 200, { ok: true });
        return;
      }
      if (!isEvents && req.method === 'PATCH') {
        const me = req.headers['x-device-id'];
        let payload;
        try { payload = JSON.parse(await readBody(req)); } catch (e) { json(res, 400, { error: 'bad json' }); return; }
        // body 可能是合法 JSON 但不是对象（比如裸的 null）：JSON.parse 不会抛，但接下来读 payload.path
        // 就会抛 TypeError，逃出这个 try 之后没人接得住（async handler 的 rejection 没人 catch），
        // 直接把整个进程打挂。一条 curl 就能秒杀公网服务，必须单独挡。
        if (!payload || typeof payload !== 'object') { json(res, 400, { error: 'bad json' }); return; }
        if (typeof payload.path === 'string' && payload.value && typeof payload.value === 'object') {
          if (payload.path.startsWith('/tx/')) {
            // 一笔流水的字段白名单：只留这五个。isValidTx 只查 from/to/points，夹带的
            // note/evil 这类字段会原样落库并广播给每个牌友（流水又只增不删，删不掉），
            // 是继 /finishedAt 之后的第二条「把房间撑大」的路。at 非数字就用服务端时间。
            // byUid 由服务端按身份头覆写，客户端传什么都不作数——前端靠它判断「别人代记」，
            // 能伪造就等于白记。
            const at = Number.isFinite(payload.value.at) ? payload.value.at : Date.now();
            payload.value = { from: payload.value.from, to: payload.value.to,
              points: payload.value.points, byUid: me, at };
          } else if (/^\/players\/[^/]+$/.test(payload.path)) {
            // 建玩家的字段白名单：只认 name/uid/at，防止夹带 left:true 之类的字段——
            // 否则一个刚建好的玩家能直接生下来就是「已退出」态，而清 left 要求 uid===me、
            // uid=null 的代记玩家永远满足不了这条，等于这个人再也回不来。
            const at = Number.isFinite(payload.value.at) ? payload.value.at : Date.now();
            payload.value = { name: payload.value.name, uid: payload.value.uid, at };
          }
        }
        const old = rooms[code] || null;
        // 从这里到下面写回 rooms[code] 为止不能出现 await：必须在同一个事件循环 tick 内原子完成，
        // 这是「已存在的 tx/players key 一律拒绝覆盖」在并发请求下依然成立的前提——
        // 一旦中间让出线程，两个并发请求就可能都读到「还没这个 key」从而先后覆盖同一笔。
        if (!canPatch(old, payload.path, payload.value, me)) { json(res, 403, { error: 'forbidden' }); return; }
        rooms[code] = setPath(old, payload.path, payload.value);
        scheduleSave(); broadcast(code);
        json(res, 200, { ok: true });
        return;
      }
      if (!isEvents && req.method === 'DELETE') {
        const me = req.headers['x-device-id'];
        const old = rooms[code] || null;
        if (old && old.creatorUid !== me) { json(res, 403, { error: 'forbidden' }); return; }
        delete rooms[code]; scheduleSave(); broadcast(code);
        json(res, 200, { ok: true });
        return;
      }
    }

    res.writeHead(404); res.end('not found');
  });

  server.flush = flush;
  server._rooms = () => rooms;
  return server;
}

// ---------- 直接运行：启动 + 打开主机页 ----------
function openBrowser(url) {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  try { execFile(cmd, args); } catch (e) { /* 打不开就让用户手动开 */ }
}

if (require.main === module) {
  const server = createRunfastServer();
  server.on('error', (e) => {
    if (e.code === 'EADDRINUSE') {
      console.error('\n  ⚠️  端口 ' + PORT + ' 已被占用，没能启动。');
      console.error('  多半是「跑得快联机」已经在另一个窗口开着了 —— 直接用那个就行，别重复双击。');
      console.error('  若确定没开（可能上次没关干净）：重启电脑最省事；或换个端口启动：');
      console.error('      PORT=8788 node server.js');
      console.error('  （换端口后手机要用新地址，主机页二维码会自动更新。）\n');
    } else {
      console.error('\n  启动失败：' + e.message + '\n');
    }
    process.exit(1);
  });
  server.listen(PORT, () => {
    const url = lanURL(PORT);
    console.log('\n  🃏 跑得快联机服务已启动');
    console.log('  ────────────────────────────');
    console.log('  记分页（手机扫码/打开）: ' + url);
    console.log('  主机页（本机看二维码）  : ' + url + 'host');
    if (!lanIP()) console.log('  ⚠️ 未检测到局域网 IP，请确认电脑已连 WiFi（现用 localhost，手机连不上）');
    console.log('  关闭此终端窗口 = 停止联机服务。\n');
    if (!process.env.RUNFAST_NO_OPEN) openBrowser(url + 'host');
  });
}

module.exports = { createRunfastServer, canWrite, canPatch, isValidTx, setPath, lanIP, lanURL, reqBaseURL, qrSvg, injectHostFlag };
