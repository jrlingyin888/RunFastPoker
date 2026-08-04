const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createRunfastServer, canWrite, injectHostFlag, setPath, canPatch, isValidTx } = require('../server.js');

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
      let b = ''; res.on('data', (c) => b += c); res.on('end', () => resolve({ status: res.statusCode, body: b, headers: res.headers }));
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}
const sampleRoom = () => ({
  creatorUid: 'boss', sid: 's1', createdAt: '2026-08-03T10:00:00.000Z',
  pricePerCardFen: 100, status: 'active',
  players: { p_a: { name: 'A', uid: 'boss', at: 1 }, p_b: { name: 'B', uid: 'x', at: 2 },
             p_c: { name: 'C', uid: null, at: 3 } },
  tx: { t_1: { from: 'p_b', to: 'p_a', points: 5, byUid: 'x', at: 10 } },
});

test('injectHostFlag：有占位注释则替换为主机标志脚本，无则原样', () => {
  const withPlaceholder = '<div id="app"></div><!--RUNFAST_HOST--><script src="app.js"></script>';
  assert.ok(injectHostFlag(withPlaceholder).includes('window.__RUNFAST_HOST__=true'));
  assert.ok(!injectHostFlag(withPlaceholder).includes('<!--RUNFAST_HOST-->'));
  const noPlaceholder = '<div id="app"></div>';
  assert.equal(injectHostFlag(noPlaceholder), noPlaceholder);
});

test('canWrite：只允许建房，房间已存在则禁止整房覆盖', () => {
  assert.ok(canWrite(null, { creatorUid: 'me' }, 'me'));
  assert.ok(!canWrite(null, { creatorUid: 'other' }, 'me'));
  assert.ok(!canWrite(null, { creatorUid: 'me' }, undefined));
  assert.ok(!canWrite(sampleRoom(), { creatorUid: 'boss' }, 'boss')); // 房主也不能整房覆盖
});

test('isValidTx：from/to 必须是房内玩家、不能自转、分数是 1~9999 的整数', () => {
  const ps = sampleRoom().players;
  assert.ok(isValidTx({ from: 'p_b', to: 'p_a', points: 20 }, ps));
  assert.ok(!isValidTx({ from: 'p_b', to: 'p_zz', points: 20 }, ps));  // 收款人不存在
  assert.ok(!isValidTx({ from: 'p_a', to: 'p_a', points: 20 }, ps));   // 自转
  assert.ok(!isValidTx({ from: 'p_b', to: 'p_a', points: 0 }, ps));
  assert.ok(!isValidTx({ from: 'p_b', to: 'p_a', points: -3 }, ps));
  assert.ok(!isValidTx({ from: 'p_b', to: 'p_a', points: 2.5 }, ps));
  assert.ok(!isValidTx({ from: 'p_b', to: 'p_a', points: 10000 }, ps));
  assert.ok(!isValidTx(null, ps));
});

test('canPatch：流水只增不删，任何设备都能记新的一笔', () => {
  const r = sampleRoom();
  const tx = { from: 'p_b', to: 'p_a', points: 8, byUid: 'x', at: 20 };
  assert.ok(canPatch(r, '/tx/t_2', tx, 'x'));        // 牌友
  assert.ok(canPatch(r, '/tx/t_3', tx, 'boss'));     // 建房人
  assert.ok(canPatch(r, '/tx/t_4', tx, 'anyone'));   // 没座位概念，谁都能记
  assert.ok(!canPatch(r, '/tx/t_1', tx, 'x'));       // 已存在的 id → 拒（只增不删）
  assert.ok(!canPatch(r, '/tx/t_2', { from: 'p_b', to: 'p_a', points: 0 }, 'x')); // 分数非法
  assert.ok(!canPatch(r, '/tx/t_2', tx, undefined)); // 没设备 id
});

test('canPatch：建玩家可以，但不能冒充别的设备', () => {
  const r = sampleRoom();
  assert.ok(canPatch(r, '/players/p_new', { name: '丁', uid: 'x', at: 9 }, 'x'));
  assert.ok(canPatch(r, '/players/p_new', { name: '没手机的', uid: null, at: 9 }, 'x'));
  assert.ok(!canPatch(r, '/players/p_new', { name: '丁', uid: 'boss', at: 9 }, 'x')); // 冒充
  assert.ok(!canPatch(r, '/players/p_a', { name: '丁', uid: 'x', at: 9 }, 'x'));      // id 已存在
  assert.ok(!canPatch(r, '/players/p_new', { uid: 'x' }, 'x'));                        // 没名字
});

test('canPatch：改名限自己的和代记的；left 只能自己置自己清；uid 永不可改', () => {
  const r = sampleRoom();
  assert.ok(canPatch(r, '/players/p_b/name', '小B', 'x'));      // 自己的
  assert.ok(canPatch(r, '/players/p_c/name', '小C', 'x'));      // uid=null 的代记玩家
  assert.ok(!canPatch(r, '/players/p_a/name', '坏人', 'x'));    // 别人的
  assert.ok(canPatch(r, '/players/p_b/left', true, 'x'));
  assert.ok(canPatch(r, '/players/p_b/left', null, 'x'));
  assert.ok(canPatch(r, '/players/p_b/leftAt', 123, 'x'));
  assert.ok(!canPatch(r, '/players/p_b/left', true, 'boss'));   // 建房人也不能替别人退
  assert.ok(!canPatch(r, '/players/p_c/left', true, 'x'));      // 代记玩家没设备，不能退
  assert.ok(!canPatch(r, '/players/p_b/uid', 'y', 'y'));        // 抢身份
  assert.ok(!canPatch(r, '/players/p_b/uid', 'x', 'x'));        // 自己也不能改
});

test('canPatch：名字要过字符集校验（与前端 validName 一致），建玩家和改名两条路径都挡单引号/尖括号', () => {
  const r = sampleRoom();
  // 建玩家：带单引号/尖括号的名字被拒；正常名字放行
  assert.ok(!canPatch(r, '/players/p_new', { name: "a'b", uid: 'x', at: 9 }, 'x'));
  assert.ok(!canPatch(r, '/players/p_new', { name: '<script>', uid: 'x', at: 9 }, 'x'));
  assert.ok(!canPatch(r, '/players/p_new', { name: '', uid: 'x', at: 9 }, 'x'));           // 空名字
  assert.ok(!canPatch(r, '/players/p_new', { name: '123456789', uid: 'x', at: 9 }, 'x'));  // 超 8 字
  assert.ok(canPatch(r, '/players/p_new', { name: '正常名字', uid: 'x', at: 9 }, 'x'));
  // 改名：同样的字符集校验，且权限判断不变（自己的/代记的才能改）
  assert.ok(!canPatch(r, '/players/p_b/name', "坏'名字", 'x'));
  assert.ok(!canPatch(r, '/players/p_b/name', '<b>坏</b>', 'x'));
  assert.ok(!canPatch(r, '/players/p_b/name', { name: '对象不是字符串' }, 'x'));
  assert.ok(canPatch(r, '/players/p_b/name', '正常改名', 'x'));
  assert.ok(!canPatch(r, '/players/p_a/name', '正常改名', 'x'));  // 名字合法但不是自己的，仍应拒
});

test('canPatch：结束本场全开放，其他路径一律拒', () => {
  const r = sampleRoom();
  assert.ok(canPatch(r, '/status', 'finished', 'anyone'));
  assert.ok(canPatch(r, '/finishedAt', '2026-08-03T12:00:00.000Z', 'anyone'));
  assert.ok(!canPatch(r, '/status', 'whatever', 'anyone'));
  assert.ok(!canPatch(r, '/creatorUid', 'me', 'x'));
  assert.ok(!canPatch(r, '/pricePerCardFen', 999, 'x'));
  assert.ok(!canPatch(r, '/', {}, 'x'));
  assert.ok(!canPatch(null, '/tx/t_9', {}, 'x'));               // 房间不存在
});

test('canPatch / setPath：拒绝写进原型链，杜绝远程原型污染', () => {
  const r = sampleRoom();
  assert.ok(!canPatch(r, '/players/__proto__/name', 'PWNED', 'evil'));
  assert.ok(!canPatch(r, '/players/__proto__', { name: 'x', uid: null }, 'evil'));
  assert.ok(!canPatch(r, '/players/constructor/name', 'PWNED', 'evil'));
  assert.ok(!canPatch(r, '/players/hasOwnProperty/name', 'PWNED', 'evil'));
  assert.ok(!canPatch(r, '/tx/__proto__', { from: 'p_b', to: 'p_a', points: 1 }, 'evil'));
  setPath({ players: {} }, '/players/__proto__/name', 'PWNED');
  assert.equal({}.name, undefined);   // 原型没被污染
});

test('REST：建房只此一次/房间已存在后整房覆盖一律拒/删房/GET 不存在为 null', async () => {
  const df = tmpData();
  const server = createRunfastServer({ dataFile: df });
  const port = await listen(server);
  try {
    let r = await req(port, 'GET', '/rooms/100200');
    assert.equal(r.status, 200); assert.equal(r.body, 'null');

    r = await req(port, 'PUT', '/rooms/100200', sampleRoom(), { 'X-Device-Id': 'boss' });
    assert.equal(r.status, 200);

    r = await req(port, 'PUT', '/rooms/100200', { ...sampleRoom(), pricePerCardFen: 200 }, { 'X-Device-Id': 'stranger' });
    assert.equal(r.status, 403);

    r = await req(port, 'PUT', '/rooms/100200', { ...sampleRoom(), pricePerCardFen: 200 }, { 'X-Device-Id': 'boss' });
    assert.equal(r.status, 403); // 房主也不例外：房间已存在就不能再整房覆盖，后续变更都得走 PATCH

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
          const isPut = chunk.split('\n').some((l) => l.startsWith('event: put'));
          const line = chunk.split('\n').find((l) => l.startsWith('data: '));
          if (!isPut || !line) continue;
          frames.push(JSON.parse(line.slice(6)));
          if (frames.length === 1) {
            req(port, 'PATCH', '/rooms/777888', { path: '/status', value: 'finished' }, { 'X-Device-Id': 'boss' });
          } else if (frames.length === 2) { clearTimeout(timer); res.destroy(); resolve(); }
        }
      });
    });
    r.on('error', reject); r.end();
  });
  try {
    assert.equal(frames[0].path, '/');
    assert.equal(frames[0].data.status, 'active');    // 首帧全量
    assert.equal(frames[1].data.status, 'finished');  // 广播到更新（PATCH 结束本场触发）
  } finally { server.close(); try { fs.unlinkSync(df); } catch (e) {} }
});

test('静态：/ 注入主机标志；/host 含本机地址与内联二维码；/status 返回计数', async () => {
  const df = tmpData();
  const server = createRunfastServer({ dataFile: df });
  const port = await listen(server);
  try {
    let r = await req(port, 'GET', '/');
    // dist 存在则发出记分页（含占位注释时会注入主机标志，注入逻辑由上面的单测覆盖）；
    // dist 缺失则给可读错误。二者都算通过，避免与 Task 4 的构建顺序耦合。
    if (r.status === 200) {
      assert.ok(r.body.includes('id="app"'));
      assert.match(r.headers['cache-control'] || '', /no-store/); // 禁缓存，避免手机跑旧代码
    } else assert.match(r.body, /dist\/index\.html/);

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

test('/host：经反代的公网请求生成公网地址（而非 localhost），LAN 直连仍给局域网地址', async () => {
  const df = tmpData();
  const server = createRunfastServer({ dataFile: df });
  const port = await listen(server);
  try {
    // 公网（Nginx 反代）：Host=域名 + X-Forwarded-Proto=https ⇒ 二维码/地址应为 https 公网入口
    let r = await req(port, 'GET', '/host', undefined, { Host: 'ipa.ydyrx.top', 'X-Forwarded-Proto': 'https' });
    assert.equal(r.status, 200);
    assert.ok(r.body.includes('https://ipa.ydyrx.top/'), '反代公网请求应显示公网地址');
    assert.ok(!/localhost:\d+/.test(r.body), '反代公网请求不应回退到 localhost');

    // 局域网直连（Host 为局域网 IP:端口）：按访问地址原样给出，手机可达
    r = await req(port, 'GET', '/host', undefined, { Host: '192.168.1.7:' + port });
    assert.equal(r.status, 200);
    assert.ok(r.body.includes('http://192.168.1.7:' + port + '/'), 'LAN 直连应显示局域网地址');
  } finally { server.close(); try { fs.unlinkSync(df); } catch (e) {} }
});

test('setPath：按路径深设，返回新对象不改原对象', () => {
  const r = { players: { p_a: { name: 'A', uid: 'd1' } }, tx: {} };
  assert.equal(setPath(r, '/tx/t_1', { points: 5 }).tx.t_1.points, 5);
  assert.equal(setPath(r, '/players/p_a/name', 'AA').players.p_a.name, 'AA');
  assert.ok(!('uid' in setPath(r, '/players/p_a/uid', null).players.p_a));
  assert.deepEqual(setPath(r, '/', { x: 1 }), { x: 1 });
  assert.deepEqual(r.tx, {});  // 不改原对象
});

test('REST PATCH：三台设备同时记分，三笔全部入账互不覆盖', async () => {
  const df = tmpData();
  const server = createRunfastServer({ dataFile: df });
  const port = await listen(server);
  try {
    await req(port, 'PUT', '/rooms/300400', sampleRoom(), { 'X-Device-Id': 'boss' });
    const tx = (from) => ({ from, to: 'p_a', points: 3, byUid: 'd', at: 1 });
    const rs = await Promise.all([
      req(port, 'PATCH', '/rooms/300400', { path: '/tx/t_x1', value: tx('p_b') }, { 'X-Device-Id': 'd1' }),
      req(port, 'PATCH', '/rooms/300400', { path: '/tx/t_x2', value: tx('p_c') }, { 'X-Device-Id': 'd2' }),
      req(port, 'PATCH', '/rooms/300400', { path: '/tx/t_x3', value: tx('p_b') }, { 'X-Device-Id': 'd3' }),
    ]);
    rs.forEach((r) => assert.equal(r.status, 200));
    const room = JSON.parse((await req(port, 'GET', '/rooms/300400')).body);
    assert.equal(Object.keys(room.tx).length, 4);  // 原有 1 笔 + 新 3 笔
    // 重复 id 被拒，且不覆盖原值
    const dup = await req(port, 'PATCH', '/rooms/300400',
      { path: '/tx/t_x1', value: tx('p_c') }, { 'X-Device-Id': 'd9' });
    assert.equal(dup.status, 403);
    const after = JSON.parse((await req(port, 'GET', '/rooms/300400')).body);
    assert.equal(after.tx.t_x1.from, 'p_b');
  } finally { server.close(); fs.rmSync(df, { force: true }); }
});

test('REST PATCH：走真实 HTTP 打原型污染路径，应 403 且不留后患', async () => {
  const df = tmpData();
  const server = createRunfastServer({ dataFile: df });
  const port = await listen(server);
  try {
    await req(port, 'PUT', '/rooms/300500', sampleRoom(), { 'X-Device-Id': 'boss' });
    const r = await req(port, 'PATCH', '/rooms/300500',
      { path: '/players/__proto__/name', value: 'PWNED' }, { 'X-Device-Id': 'evil' });
    assert.equal(r.status, 403);
    assert.equal(({}).name, undefined); // 全局 Object.prototype 没被污染

    // 挨这一下之后服务器还得能正常接单，不能被这次攻击拖垮
    const ok = await req(port, 'GET', '/rooms/300500');
    assert.equal(JSON.parse(ok.body).creatorUid, 'boss');
  } finally { server.close(); try { fs.unlinkSync(df); } catch (e) {} }
});

test('REST PATCH：body 是合法 JSON 的 null 不该崩进程，返回 400 且后续请求仍正常', async () => {
  const df = tmpData();
  const server = createRunfastServer({ dataFile: df });
  const port = await listen(server);
  try {
    await req(port, 'PUT', '/rooms/300600', sampleRoom(), { 'X-Device-Id': 'boss' });
    const r = await req(port, 'PATCH', '/rooms/300600', null, { 'X-Device-Id': 'boss' });
    assert.equal(r.status, 400);

    const ok = await req(port, 'GET', '/rooms/300600'); // 进程没被打挂，还能正常响应下一个请求
    assert.equal(JSON.parse(ok.body).creatorUid, 'boss');
  } finally { server.close(); try { fs.unlinkSync(df); } catch (e) {} }
});

test('REST PATCH：byUid 由服务端按 X-Device-Id 覆写，客户端填的会被无视', async () => {
  const df = tmpData();
  const server = createRunfastServer({ dataFile: df });
  const port = await listen(server);
  try {
    await req(port, 'PUT', '/rooms/300700', sampleRoom(), { 'X-Device-Id': 'boss' });
    const r = await req(port, 'PATCH', '/rooms/300700',
      { path: '/tx/t_fake', value: { from: 'p_b', to: 'p_a', points: 4, byUid: '别人的设备id' } },
      { 'X-Device-Id': 'x' });
    assert.equal(r.status, 200);
    const room = JSON.parse((await req(port, 'GET', '/rooms/300700')).body);
    assert.equal(room.tx.t_fake.byUid, 'x'); // 不是客户端伪造的那个，是请求头里真实的设备 id
  } finally { server.close(); try { fs.unlinkSync(df); } catch (e) {} }
});

test('REST PATCH：建玩家做字段白名单，杂字段（含 left）落库前被剥离', async () => {
  const df = tmpData();
  const server = createRunfastServer({ dataFile: df });
  const port = await listen(server);
  try {
    await req(port, 'PUT', '/rooms/300800', sampleRoom(), { 'X-Device-Id': 'boss' });
    const r = await req(port, 'PATCH', '/rooms/300800',
      { path: '/players/p_new', value: { name: '幽灵', uid: null, left: true, leftAt: 999, extra: 'x' } },
      { 'X-Device-Id': 'boss' });
    assert.equal(r.status, 200);
    const room = JSON.parse((await req(port, 'GET', '/rooms/300800')).body);
    assert.deepEqual(Object.keys(room.players.p_new).sort(), ['at', 'name', 'uid']); // 只剩三个白名单字段
    assert.equal(room.players.p_new.name, '幽灵');
    assert.equal(room.players.p_new.uid, null);
  } finally { server.close(); try { fs.unlinkSync(df); } catch (e) {} }
});

test('/qr：正常返回内联 SVG；缺 text 或超长返回 400', async () => {
  const df = tmpData();
  const server = createRunfastServer({ dataFile: df });
  const port = await listen(server);
  try {
    let r = await req(port, 'GET', '/qr?text=' + encodeURIComponent('http://192.168.1.7:8787/?room=123456'));
    assert.equal(r.status, 200);
    assert.match(r.headers['content-type'] || '', /image\/svg\+xml/);
    assert.ok(r.body.includes('<svg'));

    r = await req(port, 'GET', '/qr');                       // 缺 text
    assert.equal(r.status, 400);

    r = await req(port, 'GET', '/qr?text=' + 'a'.repeat(600)); // 超长
    assert.equal(r.status, 400);
  } finally { server.close(); try { fs.unlinkSync(df); } catch (e) {} }
});
