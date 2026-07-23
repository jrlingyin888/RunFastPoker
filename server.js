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
<title>跑得快联机 · 主机页</title>
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
  <div class="hint">手机用<b>相机 / 系统浏览器</b>扫下面的码进入（比微信内置浏览器稳）</div>
  <div class="qr">${qrSvg(url)}</div>
  <div class="url">${url}</div>
  <div class="hint">在线牌友（含本机页面）：<span class="n" id="n">0</span> 人<br>
    电脑和手机要连<b>同一个 WiFi</b>；别用「访客网络」。关掉启动服务的终端窗口即停止。</div>
  <script>
    setInterval(function(){
      fetch('/status').then(function(r){return r.json();}).then(function(s){
        document.getElementById('n').textContent = s.clients;
      }).catch(function(){});
    }, 3000);
  </script>
</body></html>`;
}

// ---------- 权限校验（服务器强制，等价 v1.1 Firebase 规则）----------
function canWrite(old, neu, me) {
  if (!me) return false;
  if (!old) return !!neu && neu.creatorUid === me;                 // 建房：登记自己为房主
  if (old.creatorUid === me) return true;                          // 房主全权
  return old.allowEdit === true && !!neu &&                        // 他人：仅 allowEdit 且不篡改房主/权限位
    neu.creatorUid === old.creatorUid && neu.allowEdit === old.allowEdit;
}

// 按路径深设：'/a/b/2/c' → 设 obj.a.b[2].c=value（value 为 null 删该键）。返回新对象，不改原对象。
function setPath(obj, path, value) {
  if (!path || path === '/') return value;
  const keys = path.replace(/^\//, '').split('/');
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

// 字段级写权限（服务器强制）。me=X-Device-Id。
function canPatch(old, path, value, me) {
  if (!me || !old) return false;                       // 房间须已存在（建房走 PUT）
  const isCreator = old.creatorUid === me;
  const seats = Array.isArray(old.seats) ? old.seats : [];
  const holdsSeat = seats.some((s) => s && s.claimedBy === me);
  const m = path.match(/^\/seats\/(\d+)\/claimedBy$/);
  if (m) {
    const seat = seats[Number(m[1])];
    if (!seat) return false;
    if (value === me && seat.claimedBy == null) return true;                 // 抢空座(CAS)
    if (value == null && (isCreator || seat.claimedBy === me)) return true;  // 释放(房主或本人)
    return false;
  }
  if (/^\/draft\/entries\/\d+$/.test(path)) {                                // 填某座那格
    const seat = seats[Number(path.split('/').pop())];
    return !!seat && (seat.claimedBy === me || isCreator);
  }
  if (path === '/draft/winner' || path === '/draft') return holdsSeat || isCreator; // 定赢家/清草稿
  return isCreator;                                                          // phase/seats结构/session 等仅房主
}

// ---------- 服务器工厂（每实例独立房间与数据文件，便于测试隔离）----------
function createRunfastServer(options = {}) {
  const dataFile = options.dataFile || path.join(ROOT, 'server-data.json');
  let rooms = {};
  try { rooms = JSON.parse(fs.readFileSync(dataFile, 'utf8')) || {}; } catch (e) { rooms = {}; }

  const subscribers = new Map(); // code -> Set<res>
  const presence = new Map();    // code -> Map<deviceId, refCount>（在线名单，临时态，不落地）
  function presenceDevices(code) {
    const mm = presence.get(code);
    return mm ? Array.from(mm.keys()) : [];
  }
  function sendPresence(res, code) {
    res.write('event: presence\n');
    res.write('data: ' + JSON.stringify({ devices: presenceDevices(code) }) + '\n\n');
  }
  function broadcastPresence(code) {
    const set = subscribers.get(code);
    if (!set) return;
    for (const res of set) sendPresence(res, code);
  }
  function addPresence(code, dev) {
    let mm = presence.get(code);
    if (!mm) { mm = new Map(); presence.set(code, mm); }
    mm.set(dev, (mm.get(dev) || 0) + 1);
    broadcastPresence(code);
  }
  function removePresence(code, dev) {
    const mm = presence.get(code);
    if (!mm) return;
    const n = (mm.get(dev) || 0) - 1;
    if (n <= 0) mm.delete(dev); else mm.set(dev, n);
    if (!mm.size) presence.delete(code);
    broadcastPresence(code);
  }
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
    // 主机页（本机屏幕看二维码）
    if (req.method === 'GET' && p === '/host') {
      const port = server.address() ? server.address().port : PORT;
      res.writeHead(200, HTML_HEADERS);
      res.end(hostPage(lanURL(port)));
      return;
    }
    // 在线人数
    if (req.method === 'GET' && p === '/status') {
      json(res, 200, { clients: clientCount(), rooms: Object.keys(rooms).length });
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
        const dev = u.searchParams.get('dev');
        if (dev) addPresence(code, dev);    // 登记并广播（含本连接）最新在线名单
        else sendPresence(res, code);       // 无 dev 的连接也给一帧当前名单
        const hb = setInterval(() => res.write(':keep-alive\n\n'), 30000);
        req.on('close', () => {
          clearInterval(hb); set.delete(res); if (!set.size) subscribers.delete(code);
          if (dev) removePresence(code, dev);
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
        const old = rooms[code] || null;
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

module.exports = { createRunfastServer, canWrite, canPatch, setPath, lanIP, lanURL, qrSvg, injectHostFlag };
