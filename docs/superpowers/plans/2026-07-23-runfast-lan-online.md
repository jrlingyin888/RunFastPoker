# 跑得快记分 · 局域网自建服务器联机 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 v1.1 的 Firebase 联机后端换成「房主电脑跑的零依赖 Node 服务」，手机同 WiFi 扫码进入、实时同步，彻底摆脱翻墙依赖。

**Architecture:** 新增 `server.js`（Node 内置 http/fs/os，唯一后端，既发页面又当同步中心，SSE 广播 + 内存房间 Map + 落地 `server-data.json` + 服务器强制权限）。`sync.js` 保持对外 15 个接口签名不变，仅把内部连接实现从「Firebase 绝对地址 + 匿名 token + ETag」换成「同源相对路径 + `X-Device-Id`」。`app.js`/`logic.js`/结算/皮肤/分享/历史/本地单机全部不变。主机页二维码由服务器端用内联 MIT 库生成 SVG，浏览器零脚本。

**Tech Stack:** Node v26（仅内置模块）、原生 `EventSource`/`fetch`、`node --test`、vendored `qrcode-generator`(MIT)。

## Global Constraints

- **零第三方运行时依赖**：只用 Node 内置模块（http/fs/path/os/child_process）。二维码库是 vendored MIT 源码（构建/服务器侧），不是 npm 依赖。
- **Node 版本**：v26；跑测试用 `node --test`（不带目录参数，会自动跑 `test/*.test.js`）。
- **`sync.js` 对外导出的 15 个名字必须保持不变**：`configured, genRoomCode, validRoomCode, canEdit, canAdmin, applyEvent, normalizeRoom, signIn, getUid, createRoom, readRoom, subscribe, mutate, deleteRoom, close`。
- **房间数据模型与 v1.1 云端同构**：`{ creatorUid, allowEdit, updatedAt, session }`，`session` 与本地 session 完全同构 ⇒ `logic.js` 纯函数零改动复用。
- **单文件 dist 交付不变**：`node build.js` 仍把 src 内联进 `dist/index.html`；GitHub Pages 版继续作为「电脑没开时的离线单机版」。
- **服务器只服务局域网**：不做公网映射；README 明确提示不要把端口暴露到公网。
- **端口** 固定 `8787`，可被环境变量 `PORT` 覆盖。
- **权限语义**（服务器强制，等价 v1.1 Firebase 规则）：建房者登记自己为 `creatorUid`；房主全权（含删房、改 `allowEdit`、结束）；他人仅当 `allowEdit===true` 且不篡改 `creatorUid`/`allowEdit` 时可写；删房仅房主。

---

### Task 1: Vendor MIT 二维码库

**Files:**
- Create: `src/vendor/qrcode.js`（从 unpkg 拉取的 `qrcode-generator@1.4.4`，MIT / Kazuhiko Arase）
- Test: `test/qrcode.vendor.test.js`

**Interfaces:**
- Produces: 一个 UMD 模块，Node 下 `require('../src/vendor/qrcode.js')` 返回 `qrcode` 函数；用法 `const qr = qrcode(0, 'M'); qr.addData(str); qr.make(); qr.createSvgTag(cellSize, margin)` 返回 SVG 字符串。server.js 会 `require` 它在服务器端生成二维码 SVG。

- [ ] **Step 1: 拉取并落地库文件**

Run:
```bash
mkdir -p src/vendor
curl -sS --connect-timeout 8 -m 20 -o src/vendor/qrcode.js "https://unpkg.com/qrcode-generator@1.4.4/qrcode.js"
```
Expected: 文件约 56KB，头部含 `Copyright (c) 2009 Kazuhiko Arase` 与 `Licensed under the MIT license`。

- [ ] **Step 2: 写失败测试**

`test/qrcode.vendor.test.js`:
```js
const test = require('node:test');
const assert = require('node:assert/strict');
const qrcode = require('../src/vendor/qrcode.js');

test('vendored 二维码库：能对 URL 生成非空 SVG', () => {
  assert.equal(typeof qrcode, 'function');
  const qr = qrcode(0, 'M');
  qr.addData('http://192.168.1.5:8787/');
  qr.make();
  const svg = qr.createSvgTag(6, 4);
  assert.equal(typeof svg, 'string');
  assert.ok(svg.includes('<svg'));
  assert.ok(svg.length > 500);
});
```

- [ ] **Step 3: 运行测试确认通过**

Run: `node --test test/qrcode.vendor.test.js`
Expected: PASS（若 FAIL，检查 Step 1 是否拉到正确文件）。

- [ ] **Step 4: 提交**

```bash
git add src/vendor/qrcode.js test/qrcode.vendor.test.js
git commit -m "chore: vendor qrcode-generator (MIT) 用于主机页二维码"
```

---

### Task 2: server.js — 局域网同步服务器

**Files:**
- Create: `server.js`
- Test: `test/server.test.js`

**Interfaces:**
- Consumes: `src/vendor/qrcode.js`（Task 1）；`dist/index.html`（运行期读取，测试期可缺失但会给可读错误）。
- Produces:
  - `createRunfastServer({ dataFile }) -> http.Server`，附带 `server.flush()`（立即落地，跳过 500ms 防抖，供测试）。
  - `canWrite(old, neu, me) -> boolean`（权限判定纯函数）。
  - `lanIP() -> string|null`、`lanURL(port) -> string`、`qrSvg(text) -> string`。
  - HTTP 接口：`GET /`（注入 `window.__RUNFAST_HOST__=true`）、`GET /host`、`GET /status`、`GET /rooms/:code`、`GET /rooms/:code/events`(SSE)、`PUT /rooms/:code`（头 `X-Device-Id`）、`DELETE /rooms/:code`。
  - SSE 帧格式对齐 Firebase：`event: put\ndata: {"path":"/","data":<room|null>}\n\n`；心跳 `:keep-alive\n\n`。

- [ ] **Step 1: 写 server.js 全文**

`server.js`:
```js
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
      html = html.replace('<!--RUNFAST_HOST-->', '<script>window.__RUNFAST_HOST__=true</script>');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
      return;
    }
    // 主机页（本机屏幕看二维码）
    if (req.method === 'GET' && p === '/host') {
      const port = server.address() ? server.address().port : PORT;
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
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
        const hb = setInterval(() => res.write(':keep-alive\n\n'), 30000);
        req.on('close', () => { clearInterval(hb); set.delete(res); if (!set.size) subscribers.delete(code); });
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
  server.listen(PORT, () => {
    const url = lanURL(PORT);
    console.log('\n  🃏 跑得快联机服务已启动');
    console.log('  ────────────────────────────');
    console.log('  记分页（手机扫码/打开）: ' + url);
    console.log('  主机页（本机看二维码）  : ' + url + 'host');
    if (!lanIP()) console.log('  ⚠️ 未检测到局域网 IP，请确认电脑已连 WiFi（现用 localhost，手机连不上）');
    console.log('  关闭此终端窗口 = 停止联机服务。\n');
    openBrowser(url + 'host');
  });
}

module.exports = { createRunfastServer, canWrite, lanIP, lanURL, qrSvg };
```

- [ ] **Step 2: 写失败测试**

`test/server.test.js`:
```js
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createRunfastServer, canWrite } = require('../server.js');

let seq = 0;
function tmpData() { return path.join(os.tmpdir(), 'runfast-test-' + process.pid + '-' + (seq++) + '.json'); }
function listen(server) {
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port)));
}
function req(port, method, p, body, headers) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : JSON.stringify(body);
    const r = http.request({ host: '127.0.0.1', port, method, path: p,
      headers: Object.assign({ 'Content-Type': 'application/json' }, headers || {}) }, (res) => {
      let b = ''; res.on('data', (c) => b += c); res.on('end', () => resolve({ status: res.statusCode, body: b }));
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}
const sampleRoom = () => ({ creatorUid: 'boss', allowEdit: false, updatedAt: 1,
  session: { id: 's1', players: ['A'], activePlayers: ['A'], rounds: [] } });

test('canWrite：建房只能把自己登记为房主', () => {
  assert.ok(canWrite(null, { creatorUid: 'me' }, 'me'));
  assert.ok(!canWrite(null, { creatorUid: 'other' }, 'me'));
  assert.ok(!canWrite(null, { creatorUid: 'me' }, undefined));
});

test('canWrite：房主全权；他人受 allowEdit 限制且不能篡改房主/权限位', () => {
  const closed = { creatorUid: 'boss', allowEdit: false };
  assert.ok(canWrite(closed, { creatorUid: 'boss', allowEdit: true }, 'boss'));  // 房主可改权限
  assert.ok(!canWrite(closed, { creatorUid: 'boss', allowEdit: false }, 'x'));   // 他人在关闭态 → 拒
  const open = { creatorUid: 'boss', allowEdit: true };
  assert.ok(canWrite(open, { creatorUid: 'boss', allowEdit: true, session: {} }, 'x'));  // 开放后他人可写
  assert.ok(!canWrite(open, { creatorUid: 'x', allowEdit: true }, 'x'));         // 篡改房主 → 拒
  assert.ok(!canWrite(open, { creatorUid: 'boss', allowEdit: false }, 'x'));     // 篡改权限位 → 拒
});

test('REST：建房/越权/开放后可写/删房/GET 不存在为 null', async () => {
  const df = tmpData();
  const server = createRunfastServer({ dataFile: df });
  const port = await listen(server);
  try {
    let r = await req(port, 'GET', '/rooms/100200');
    assert.equal(r.status, 200); assert.equal(r.body, 'null');

    r = await req(port, 'PUT', '/rooms/100200', sampleRoom(), { 'X-Device-Id': 'boss' });
    assert.equal(r.status, 200);

    r = await req(port, 'PUT', '/rooms/100200', { ...sampleRoom(), updatedAt: 2 }, { 'X-Device-Id': 'stranger' });
    assert.equal(r.status, 403);

    r = await req(port, 'PUT', '/rooms/100200', { ...sampleRoom(), allowEdit: true }, { 'X-Device-Id': 'boss' });
    assert.equal(r.status, 200);

    r = await req(port, 'PUT', '/rooms/100200',
      { creatorUid: 'boss', allowEdit: true, updatedAt: 3, session: sampleRoom().session }, { 'X-Device-Id': 'stranger' });
    assert.equal(r.status, 200);

    r = await req(port, 'DELETE', '/rooms/100200', undefined, { 'X-Device-Id': 'stranger' });
    assert.equal(r.status, 403);

    r = await req(port, 'DELETE', '/rooms/100200', undefined, { 'X-Device-Id': 'boss' });
    assert.equal(r.status, 200);

    r = await req(port, 'GET', '/rooms/100200');
    assert.equal(r.body, 'null');
  } finally { server.close(); try { fs.unlinkSync(df); } catch (e) {} }
});

test('持久化：写入落地后新实例能恢复', async () => {
  const df = tmpData();
  const s1 = createRunfastServer({ dataFile: df });
  const p1 = await listen(s1);
  await req(p1, 'PUT', '/rooms/424242', sampleRoom(), { 'X-Device-Id': 'boss' });
  s1.flush();
  await new Promise((r) => s1.close(r));
  const s2 = createRunfastServer({ dataFile: df });
  const p2 = await listen(s2);
  try {
    const r = await req(p2, 'GET', '/rooms/424242');
    assert.equal(JSON.parse(r.body).creatorUid, 'boss');
  } finally { s2.close(); try { fs.unlinkSync(df); } catch (e) {} }
});

test('SSE：连上先收首帧全量，房间更新后收到广播', async () => {
  const df = tmpData();
  const server = createRunfastServer({ dataFile: df });
  const port = await listen(server);
  await req(port, 'PUT', '/rooms/777888', sampleRoom(), { 'X-Device-Id': 'boss' });
  const frames = [];
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { r.destroy(); reject(new Error('SSE 超时')); }, 4000);
    const r = http.request({ host: '127.0.0.1', port, method: 'GET', path: '/rooms/777888/events' }, (res) => {
      let buf = '';
      res.on('data', (c) => {
        buf += c;
        let idx;
        while ((idx = buf.indexOf('\n\n')) >= 0) {
          const chunk = buf.slice(0, idx); buf = buf.slice(idx + 2);
          const line = chunk.split('\n').find((l) => l.startsWith('data: '));
          if (!line) continue;
          frames.push(JSON.parse(line.slice(6)));
          if (frames.length === 1) {
            req(port, 'PUT', '/rooms/777888', { ...sampleRoom(), allowEdit: true }, { 'X-Device-Id': 'boss' });
          } else if (frames.length === 2) { clearTimeout(timer); res.destroy(); resolve(); }
        }
      });
    });
    r.on('error', reject); r.end();
  });
  try {
    assert.equal(frames[0].path, '/');
    assert.equal(frames[0].data.allowEdit, false);   // 首帧全量
    assert.equal(frames[1].data.allowEdit, true);    // 广播到更新
  } finally { server.close(); try { fs.unlinkSync(df); } catch (e) {} }
});

test('静态：/ 注入主机标志；/host 含本机地址与内联二维码；/status 返回计数', async () => {
  const df = tmpData();
  const server = createRunfastServer({ dataFile: df });
  const port = await listen(server);
  try {
    let r = await req(port, 'GET', '/');
    if (r.status === 200) assert.ok(r.body.includes('window.__RUNFAST_HOST__=true'));
    else assert.match(r.body, /dist\/index\.html/);   // dist 尚未构建时给可读错误

    r = await req(port, 'GET', '/host');
    assert.equal(r.status, 200);
    assert.ok(r.body.includes(':' + port + '/'));      // 显示本机地址
    assert.ok(r.body.includes('<svg'));                // 内联二维码

    r = await req(port, 'GET', '/status');
    const s = JSON.parse(r.body);
    assert.equal(typeof s.clients, 'number');
    assert.equal(typeof s.rooms, 'number');
  } finally { server.close(); try { fs.unlinkSync(df); } catch (e) {} }
});
```

- [ ] **Step 3: 运行测试**

Run: `node --test test/server.test.js`
Expected: 全部 PASS。（`GET /` 那条即使此刻 dist 还没重建也能过——分支容忍 500 + 可读错误；Task 5 之后 dist 会被重建。）

- [ ] **Step 4: 提交**

```bash
git add server.js test/server.test.js
git commit -m "feat: 局域网同步服务器 server.js（REST+SSE+权限+落地）"
```

---

### Task 3: sync.js — 换成局域网后端（对外接口不变）

**Files:**
- Modify: `src/sync.js`（整文件替换）
- Modify: `test/sync.test.js`（仅改 `configured` 那条；其余纯函数测试不动）

**Interfaces:**
- Consumes: 同源 HTTP 接口（Task 2 的 `/rooms/:code`、`/rooms/:code/events`）。
- Produces: 与旧版**完全相同的 15 个导出名**（见 Global Constraints）。语义变化仅两处对外可见：
  - `configured()` 现在表示「页面是否由主机服务器发出」= `window.__RUNFAST_HOST__ === true`；Node 无 `window` ⇒ `false`。
  - `signIn()` 不再匿名登录，改为「确保本机有 deviceId」，返回 `{ uid: deviceId }`；`getUid()` 返回该 deviceId。
- app.js 现有调用（`signIn/getUid/createRoom/readRoom({data})/mutate/deleteRoom/subscribe/canEdit/canAdmin/configured/validRoomCode`）签名全部兼容，无需改 app.js 逻辑。

- [ ] **Step 1: 整文件替换 src/sync.js**

`src/sync.js`:
```js
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

  const api = { configured, genRoomCode, validRoomCode, canEdit, canAdmin, applyEvent, normalizeRoom,
    signIn, getUid, createRoom, readRoom, subscribe, mutate, deleteRoom, close };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  return api;
})();
```

- [ ] **Step 2: 改 test/sync.test.js 的 configured 用例**

把现有这段（第 47–49 行附近）：
```js
test('configured：Firebase 配置已填入时为 true', () => {
  assert.equal(S.configured(), true);
});
```
替换为：
```js
test('configured：仅当页面被主机服务器注入 __RUNFAST_HOST__ 时为 true', () => {
  assert.equal(S.configured(), false);            // Node 无 window
  global.window = { __RUNFAST_HOST__: true };
  assert.equal(S.configured(), true);
  global.window = {};
  assert.equal(S.configured(), false);
  delete global.window;
});
```

- [ ] **Step 3: 运行全部纯函数测试**

Run: `node --test`
Expected: `logic.test.js`、`sync.test.js`、`qrcode.vendor.test.js`、`server.test.js` 全部 PASS。（`sync.test.js` 的 `genRoomCode/validRoomCode/canEdit/canAdmin/applyEvent/normalizeRoom` 不受影响；只有 configured 改了。）

- [ ] **Step 4: 提交**

```bash
git add src/sync.js test/sync.test.js
git commit -m "feat: sync.js 换局域网后端——同源 REST+SSE、deviceId 身份，接口不变"
```

---

### Task 4: index.html 主机标志 + app.js 文案

**Files:**
- Modify: `src/index.html`
- Modify: `src/app.js:445` 与 `src/app.js:451`

**Interfaces:**
- Consumes: server.js 在 `GET /` 时把 `<!--RUNFAST_HOST-->` 替换为设置 `window.__RUNFAST_HOST__=true` 的脚本（Task 2）。
- Produces: GitHub Pages（无服务器）下注释原样保留 ⇒ `configured()` 为 false ⇒ 只单机；主机服务器发出时 ⇒ true ⇒ 联机可用。

- [ ] **Step 1: 在 src/index.html 加主机标志占位注释**

把：
```html
<body>
<div id="app"></div>
<script src="logic.js"></script>
```
改为（占位注释放在所有脚本之前，确保 `window.__RUNFAST_HOST__` 在 app.js 执行前就位）：
```html
<body>
<div id="app"></div>
<!--RUNFAST_HOST-->
<script src="logic.js"></script>
```

- [ ] **Step 2: 改 app.js 两处联机入口提示文案**

`src/app.js` 中 `goOnlineSetup` 与 `goJoinRoom` 里各有一句（第 445、451 行）：
```js
      if (!RunfastSync.configured()) { alert('联机功能尚未配置，请先完成 Firebase 配置'); return; }
```
两处都替换为：
```js
      if (!RunfastSync.configured()) { alert('联机要在房主电脑上启动「跑得快联机」服务后，用手机扫主机页二维码进入才能用'); return; }
```

- [ ] **Step 3: 重建并核对 dist**

Run:
```bash
node build.js
grep -c "RUNFAST_HOST" dist/index.html
grep -c "扫主机页二维码" dist/index.html
grep -c "完成 Firebase 配置" dist/index.html
```
Expected: 第一条 ≥ 1（占位注释进了 dist）、第二条 = 2（新文案两处）、第三条 = 0（旧文案已清除）。

- [ ] **Step 4: 提交**

```bash
git add src/index.html src/app.js dist/index.html
git commit -m "feat: 注入主机标志占位 + 联机入口文案改为扫码引导"
```

---

### Task 5: 启动器 + README

**Files:**
- Create: `跑得快联机.command`
- Create: `README.md`

**Interfaces:**
- Consumes: `server.js`（Task 2）、`dist/index.html`（Task 4 已重建）。
- Produces: 房主双击即启动的入口；交付说明文档。

- [ ] **Step 1: 写启动器脚本**

`跑得快联机.command`:
```bash
#!/bin/bash
cd "$(dirname "$0")"
if ! command -v node >/dev/null 2>&1; then
  echo "未检测到 Node.js。请先安装：https://nodejs.org （装 LTS 版即可），装好后再双击本文件。"
  read -n 1 -s -r -p "按任意键关闭…"
  exit 1
fi
echo "正在启动「跑得快」联机服务……（关闭本窗口 = 停止服务）"
node server.js
```

- [ ] **Step 2: 赋予可执行权限**

Run: `chmod +x 跑得快联机.command`
Expected: 无输出；`ls -l 跑得快联机.command` 显示 `-rwxr-xr-x`。

- [ ] **Step 3: 写 README**

`README.md`:
```markdown
# 跑得快记分

零依赖单文件记分 H5 + 局域网实时联机。

## 单机使用
直接打开 `dist/index.html`（或线上离线版 https://jrlingyin888.github.io/runfast/）即可记分，数据存在本机浏览器。

## 局域网联机（面对面、同一个 WiFi）
1. 房主电脑（Mac，需已装 Node.js）双击 **`跑得快联机.command`**。
   - 首次可能提示「未验证的开发者」：**右键 → 打开**，或「系统设置 → 隐私与安全性 → 仍要打开」。
2. 电脑会自动弹出「主机页」，上面有**大二维码**和形如 `http://192.168.x.x:8787/` 的地址。
3. 牌友用**手机相机 / 系统浏览器**（Safari/Chrome，比微信内置浏览器稳）扫码进入。
4. 房主在自己手机上扫码 → 「创建联机场」选人、设单价 → 得到 6 位房号，招呼牌友扫码后「加入联机场」输房号。
5. 结束本场后各手机自动存本地历史；房主可在结算页「关闭房间」。关掉启动服务的终端窗口即停止联机。

### 要点 / 排错
- **电脑和所有手机必须连同一个 WiFi**；不要用路由器的「访客网络」，也别开「AP 客户端隔离」，否则手机连不到电脑。
- 电脑重启后当前牌局已落地 `server-data.json`，重启服务可恢复。
- 数据只在你家局域网内流转，不过公网、不依赖翻墙。**请勿把 8787 端口映射到公网。**
- 异地联机（电脑和手机不在同一网络）不在此方案内——后续会迁移到国内云服务器。

## 开发
- 改源码在 `src/`，`node build.js` 内联生成 `dist/index.html`。
- 测试：`node --test`。
```

- [ ] **Step 4: 提交**

```bash
git add 跑得快联机.command README.md
git commit -m "feat: 傻瓜启动器 跑得快联机.command + README 联机说明"
```

---

### Task 6: 全量测试 + 双标签本机端到端验证

**Files:**（不改代码，仅验证；如发现缺陷回到对应任务修复）
- 运行 `server.js`、驱动浏览器验证。

**Interfaces:**
- Consumes: 全部前置任务产物。
- Produces: 「本机联机全链路通过」的证据（截图 + 控制台无错）。

- [ ] **Step 1: 跑全部单元/集成测试**

Run: `node --test`
Expected: 4 个测试文件全部 PASS，0 失败。

- [ ] **Step 2: 启动服务器（后台）**

Run（后台运行）: `PORT=8787 node server.js`
Expected: 终端打印记分页与主机页地址；`server-data.json` 出现在项目根（若之前有测试残留请先删）。

- [ ] **Step 3: 双标签端到端（用浏览器预览工具）**

在预览浏览器打开 `http://localhost:8787/`（tab1）与再开一个 `http://localhost:8787/`（tab2）。逐项验证：
1. tab1：确认首页「创建联机场/加入联机场」可点（`window.__RUNFAST_HOST__` 已注入，`configured()` 为 true）。
2. tab1：创建联机场 → 选 2 名玩家、单价 1 → 开始记分 → 得到 6 位房号（记下）。顶部状态条应显示「已连接」。
3. tab2：加入联机场 → 输入该房号 → 进入 → 看到同一场比分（观战态，非房主）。
4. tab1：开启「允许他人修改」→ tab2 顶部按钮/记分按钮实时出现。
5. tab2：记一局（选赢家、填剩牌、保存）→ tab1 **实时**看到该局与比分变化（验证 SSE 广播 + 权限放开后他人可写）。
6. tab1：关闭「允许他人修改」→ tab2 回到观战态、记分按钮消失。
7. tab1：结束本场 → 两个 tab 都进入结算页；tab1（房主）出现「关闭房间」→ 点击 → 云端房间删除，tab2 收到「房间已被房主关闭」。
8. 期间打开控制台，确认**无红色报错**。

- [ ] **Step 4: 收尾**

- 停止后台 server；删除验证产生的 `server-data.json`（或将其加入 `.gitignore`，见下）。
- 新建/追加 `.gitignore`：
```
server-data.json
```

- [ ] **Step 5: 提交**

```bash
git add .gitignore
git commit -m "chore: 忽略运行期 server-data.json"
```

- [ ] **Step 6（可选，交付时）：真机扫码**

房主双击 `跑得快联机.command`，手机连同一 WiFi 扫主机页二维码，两台手机建房/进房/实时同步走一遍。

---

## Self-Review

- **Spec 覆盖**（对照 `2026-07-23-runfast-lan-online-design.md`）：
  - §5 server.js（寻址/数据模型/6 接口/并发串行/SSE 对齐 Firebase/权限）→ Task 2 ✓
  - §5.4 权限（建房/房主/他人/删房）→ Task 2 `canWrite` + 测试 ✓
  - §6 sync.js 改造（删 Firebase 认证栈、configured 改判据、signIn=deviceId、相对路径、去 ETag、subscribe 同源）→ Task 3 ✓
  - §7 app.js（configured 语义、入口文案、加入靠手输房号）→ Task 4 ✓（保留手输房号，未加房间列表——符合 §12 范围外）
  - §3 主机页二维码（内联、不依赖外网）→ Task 1+2（服务器端生成内联 SVG）✓
  - §2/§4 傻瓜启动 + 扫码 → Task 5 `.command` + README ✓
  - §8 兜底（GitHub Pages 单机、重启恢复）→ Task 4 占位注释保证 Pages 单机；Task 2 落地/恢复 ✓
  - §10 测试策略（server 单测 + 双客户端 e2e）→ Task 2 + Task 6 ✓
- **占位符扫描**：无 TBD/TODO；每个改代码的步骤都给了完整代码或精确 old→new 替换。
- **类型/命名一致**：`createRunfastServer`、`canWrite`、`flush`、`readRoom` 返回 `{ data }`、SSE 帧 `{path,data}` 在 server.js（产出）与 sync.js（消费）两侧一致；`window.__RUNFAST_HOST__` 在 index.html 占位、server.js 注入、sync.js `configured()` 三处名字一致。
- **范围外未做**（符合设计 §12）：内网穿透/公网、国内云 BaaS（后续迁移，接口已按同构预留）、房间列表页。
