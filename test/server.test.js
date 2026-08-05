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

// 建房必带的基础字段（单价/sid/createdAt 都会被服务端校验，见 canWrite）
const baseRoom = () => ({ creatorUid: 'me', sid: 's1', createdAt: '2026-08-03T10:00:00.000Z', pricePerCardFen: 100 });

test('canWrite：只允许建房，房间已存在则禁止整房覆盖', () => {
  assert.ok(canWrite(null, baseRoom(), 'me'));
  assert.ok(!canWrite(null, { ...baseRoom(), creatorUid: 'other' }, 'me'));
  assert.ok(!canWrite(null, baseRoom(), undefined));
  assert.ok(!canWrite(sampleRoom(), { ...baseRoom(), creatorUid: 'boss' }, 'boss')); // 房主也不能整房覆盖
});

test('canWrite：建房时校验单价与 sid/createdAt（缺失/非整数/负数单价一律拒）', () => {
  const base = baseRoom();
  // 单价：必须是正整数「分」，否则各端结算页会显示 NaN 元
  assert.ok(!canWrite(null, { ...base, pricePerCardFen: undefined }, 'me'));   // 缺失
  assert.ok(!canWrite(null, { ...base, pricePerCardFen: 0 }, 'me'));           // 0
  assert.ok(!canWrite(null, { ...base, pricePerCardFen: -100 }, 'me'));        // 负数
  assert.ok(!canWrite(null, { ...base, pricePerCardFen: 1.5 }, 'me'));         // 非整数
  assert.ok(!canWrite(null, { ...base, pricePerCardFen: '100' }, 'me'));       // 字符串
  assert.ok(!canWrite(null, { ...base, pricePerCardFen: NaN }, 'me'));
  assert.ok(canWrite(null, { ...base, pricePerCardFen: 50 }, 'me'));           // 0.5 元/张，合法
  // sid：会被各端快照进本地历史，只认 KEY_RE 字符集（堵死往 sid 里塞 JS 片段）
  assert.ok(!canWrite(null, { ...base, sid: "'); alert(1);//" }, 'me'));
  assert.ok(!canWrite(null, { ...base, sid: undefined }, 'me'));
  assert.ok(!canWrite(null, { ...base, sid: 12345 }, 'me'));
  assert.ok(!canWrite(null, { ...base, sid: 'x'.repeat(65) }, 'me'));
  // createdAt：字符串且长度合理
  assert.ok(!canWrite(null, { ...base, createdAt: undefined }, 'me'));
  assert.ok(!canWrite(null, { ...base, createdAt: 1785830659981 }, 'me'));
  assert.ok(!canWrite(null, { ...base, createdAt: 'x'.repeat(65) }, 'me'));
});

test('canWrite：建房时逐个校验 players/tx 内容，不再是只查 creatorUid（评审 Critical 修复）', () => {
  const base = baseRoom();
  // 没带 players/tx 字段：维持原有宽松行为，不新增「必须带」这条要求
  assert.ok(canWrite(null, { ...base }, 'me'));
  // 合法建房：players/tx 都合法
  assert.ok(canWrite(null, { ...base, players: { p_a: { name: 'A', uid: 'me', at: 1 } }, tx: {} }, 'me'));
  // 评审实测的攻击 payload：pid 里带 JS 片段
  assert.ok(!canWrite(null, { ...base, players: { "p_x'),alert(1),('": { name: 'A' } } }, 'me'));
  // name 带 HTML/属性注入字符
  assert.ok(!canWrite(null, { ...base, players: { p_x: { name: '<img src=x onerror=1>' } } }, 'me'));
  assert.ok(!canWrite(null, { ...base, players: { p_x: { name: 123 } } }, 'me'));      // name 不是字符串
  assert.ok(!canWrite(null, { ...base, players: 'nope' }, 'me'));                       // players 不是对象
  // tx：key 不合法字符
  assert.ok(!canWrite(null, { ...base, players: { p_a: { name: 'A' } },
    tx: { "t'x": { from: 'p_a', to: 'p_a', points: 1 } } }, 'me'));
  // tx：内容不合法（自转）
  assert.ok(!canWrite(null, { ...base, players: { p_a: { name: 'A' }, p_b: { name: 'B' } },
    tx: { t_1: { from: 'p_a', to: 'p_a', points: 1 } } }, 'me'));
  // tx：引用了不存在的玩家
  assert.ok(!canWrite(null, { ...base, players: { p_a: { name: 'A' } },
    tx: { t_1: { from: 'p_a', to: 'p_zz', points: 1 } } }, 'me'));
  // tx：合法引用，应通过
  assert.ok(canWrite(null, { ...base, players: { p_a: { name: 'A' }, p_b: { name: 'B' } },
    tx: { t_1: { from: 'p_a', to: 'p_b', points: 1 } } }, 'me'));
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

test('canPatch：房内名字唯一（建玩家/改名都挡），改回自己原名仍放行（评审 Critical 修复）', () => {
  const r = sampleRoom();   // 房里已有 A / B / C
  // 建玩家：撞已有名字一律拒，不管撞的是谁的（自己的、别人的、代记的）
  assert.ok(!canPatch(r, '/players/p_new', { name: 'A', uid: 'x', at: 9 }, 'x'));
  assert.ok(!canPatch(r, '/players/p_new', { name: 'B', uid: 'x', at: 9 }, 'x'));
  assert.ok(!canPatch(r, '/players/p_new', { name: 'C', uid: null, at: 9 }, 'x')); // 代记的名字也占着
  assert.ok(canPatch(r, '/players/p_new', { name: 'D', uid: 'x', at: 9 }, 'x'));
  // 改名：撞别人的拒，改成没人用的放行，改回自己原名（等于没改）也要放行
  assert.ok(!canPatch(r, '/players/p_b/name', 'A', 'x'));
  assert.ok(!canPatch(r, '/players/p_b/name', 'C', 'x'));
  assert.ok(canPatch(r, '/players/p_b/name', 'B', 'x'));   // 自己原名
  assert.ok(canPatch(r, '/players/p_b/name', 'B2', 'x'));
});

test('canWrite：建房时 players 内部重名一律拒（净额不为 0、备份导不回的源头）', () => {
  const base = baseRoom();
  assert.ok(!canWrite(null, { ...base, players: {
    p_a: { name: '华', uid: 'me', at: 1 }, p_b: { name: '华', uid: null, at: 2 } } }, 'me'));
  assert.ok(canWrite(null, { ...base, players: {
    p_a: { name: '华', uid: 'me', at: 1 }, p_b: { name: '华仔', uid: null, at: 2 } } }, 'me'));
});

test('canPatch：left/leftAt 的值也要收窄（否则等于第二个 /finishedAt 放大口）', () => {
  const r = sampleRoom();
  assert.ok(canPatch(r, '/players/p_b/left', true, 'x'));
  assert.ok(canPatch(r, '/players/p_b/left', null, 'x'));
  assert.ok(!canPatch(r, '/players/p_b/left', 'x'.repeat(500000), 'x'));  // 超大字符串
  assert.ok(!canPatch(r, '/players/p_b/left', { a: 1 }, 'x'));
  assert.ok(canPatch(r, '/players/p_b/leftAt', 123, 'x'));
  assert.ok(canPatch(r, '/players/p_b/leftAt', null, 'x'));
  assert.ok(!canPatch(r, '/players/p_b/leftAt', 'x'.repeat(500000), 'x'));
  assert.ok(!canPatch(r, '/players/p_b/leftAt', { a: 1 }, 'x'));
});

test('canPatch：结束本场全开放，其他路径一律拒', () => {
  const r = sampleRoom();
  assert.ok(canPatch(r, '/status', 'finished', 'anyone'));
  assert.ok(canPatch(r, '/finishedAt', '2026-08-03T12:00:00.000Z', 'anyone'));
  // finishedAt 会经各端 snapshot() 进本地历史：只收「一个 ISO 时间串的样子」
  assert.ok(!canPatch(r, '/finishedAt', 'x'.repeat(65), 'anyone'));
  assert.ok(!canPatch(r, '/finishedAt', 'x'.repeat(500000), 'anyone'));
  assert.ok(!canPatch(r, '/finishedAt', { nested: { deep: 1 } }, 'anyone'));
  assert.ok(!canPatch(r, '/finishedAt', 12345, 'anyone'));
  assert.ok(!canPatch(r, '/finishedAt', null, 'anyone'));
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

test('REST PUT：建房时 players 里带恶意 pid/name（XSS payload）应 403，不再原样存盘', async () => {
  const df = tmpData();
  const server = createRunfastServer({ dataFile: df });
  const port = await listen(server);
  try {
    // 评审实测的攻击 payload：pid 里带能跳出内联 onclick 单引号的片段，name 是一段 <img onerror>
    const evilRoom = {
      creatorUid: 'boss', sid: 's1', createdAt: '2026-08-03T10:00:00.000Z',
      pricePerCardFen: 100, status: 'active',
      players: { "p_x'),alert(1),('": { name: '<img src=x onerror=alert(1)>', uid: 'boss', at: 1 } },
      tx: {},
    };
    const r = await req(port, 'PUT', '/rooms/900100', evilRoom, { 'X-Device-Id': 'boss' });
    assert.equal(r.status, 403);
    const check = await req(port, 'GET', '/rooms/900100');
    assert.equal(check.body, 'null'); // 没有原样存盘
  } finally { server.close(); try { fs.unlinkSync(df); } catch (e) {} }
});

test('REST PUT：单价非整数/负数/缺失的建房应 403，不落盘（否则各端显示 NaN 元）', async () => {
  const df = tmpData();
  const server = createRunfastServer({ dataFile: df });
  const port = await listen(server);
  try {
    const bad = [
      ['缺失', (r) => { delete r.pricePerCardFen; return r; }],
      ['负数', (r) => ({ ...r, pricePerCardFen: -100 })],
      ['非整数', (r) => ({ ...r, pricePerCardFen: 1.5 })],
      ['字符串', (r) => ({ ...r, pricePerCardFen: '100' })],
      ['sid 带 JS 片段', (r) => ({ ...r, sid: "'); alert(1);//" })],
    ];
    let code = 910100;
    for (const [label, mutate] of bad) {
      const room = mutate({ ...sampleRoom() });
      const path = '/rooms/' + (code++);
      const r = await req(port, 'PUT', path, room, { 'X-Device-Id': 'boss' });
      assert.equal(r.status, 403, label + ' 应被拒');
      const check = await req(port, 'GET', path);
      assert.equal(check.body, 'null', label + ' 不应落盘');
    }
    // 合法单价照常建房成功
    const ok = await req(port, 'PUT', '/rooms/910200', { ...sampleRoom(), pricePerCardFen: 50 }, { 'X-Device-Id': 'boss' });
    assert.equal(ok.status, 200);
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
    // 之后只推被改的那一格：整房快照打到几百笔就是几十 KB，还要乘以房里的人数
    assert.equal(frames[1].path, '/status');
    assert.equal(frames[1].data, 'finished');
    assert.ok(JSON.stringify(frames[1]).length < 60, '增量帧应该很小：' + JSON.stringify(frames[1]));

    // 真正要保证的是「客户端照着这两帧拼出来的房间是对的」——拿前端那份 applyEvent 走一遍
    const S = require('../src/sync.js');
    let mirror = null;
    for (const f of frames) mirror = S.applyEvent(mirror, f.path, f.data);
    assert.equal(mirror.status, 'finished');
    assert.deepEqual(Object.keys(mirror.players), Object.keys(sampleRoom().players), '补丁不能把别的字段冲掉');
    assert.equal(mirror.pricePerCardFen, sampleRoom().pricePerCardFen);
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

test('REST PATCH：两台设备先后用同一个名字，第二个 403；改名撞名 403，改回原名 200', async () => {
  const df = tmpData();
  const server = createRunfastServer({ dataFile: df });
  const port = await listen(server);
  try {
    await req(port, 'PUT', '/rooms/300900',
      { creatorUid: 'devA', sid: 's1', createdAt: '2026-08-03T10:00:00.000Z', pricePerCardFen: 100,
        status: 'active', players: { p_a: { name: '华', uid: 'devA', at: 1 } }, tx: {} },
      { 'X-Device-Id': 'devA' });

    // devB 想叫同一个「华」：客户端查的是十几秒前的快照可能漏过，服务端必须挡住
    let r = await req(port, 'PATCH', '/rooms/300900',
      { path: '/players/p_b', value: { name: '华', uid: 'devB', at: 2 } }, { 'X-Device-Id': 'devB' });
    assert.equal(r.status, 403);
    // 换个名字就能进
    r = await req(port, 'PATCH', '/rooms/300900',
      { path: '/players/p_b', value: { name: '华仔', uid: 'devB', at: 2 } }, { 'X-Device-Id': 'devB' });
    assert.equal(r.status, 200);
    // 改名撞已有的名字 → 403
    r = await req(port, 'PATCH', '/rooms/300900',
      { path: '/players/p_b/name', value: '华' }, { 'X-Device-Id': 'devB' });
    assert.equal(r.status, 403);
    // 把自己改回自己原名 → 200（不能被自己的名字挡住）
    r = await req(port, 'PATCH', '/rooms/300900',
      { path: '/players/p_b/name', value: '华仔' }, { 'X-Device-Id': 'devB' });
    assert.equal(r.status, 200);

    const room = JSON.parse((await req(port, 'GET', '/rooms/300900')).body);
    const names = Object.keys(room.players).map((k) => room.players[k].name).sort();
    assert.deepEqual(names, ['华', '华仔']);   // 房里绝不会出现两个同名
  } finally { server.close(); try { fs.unlinkSync(df); } catch (e) {} }
});

test('REST PATCH：超大 /finishedAt 应 403 不落库；tx 的杂字段落库前被剥离', async () => {
  const df = tmpData();
  const server = createRunfastServer({ dataFile: df });
  const port = await listen(server);
  try {
    await req(port, 'PUT', '/rooms/301000', sampleRoom(), { 'X-Device-Id': 'boss' });

    // 500KB 的 finishedAt：无条件放行时它会经 snapshot() 进每个牌友的 localStorage
    let r = await req(port, 'PATCH', '/rooms/301000',
      { path: '/finishedAt', value: 'x'.repeat(500000) }, { 'X-Device-Id': 'evil' });
    assert.equal(r.status, 403);
    r = await req(port, 'PATCH', '/rooms/301000',
      { path: '/finishedAt', value: { nested: { deep: 'x'.repeat(1000) } } }, { 'X-Device-Id': 'evil' });
    assert.equal(r.status, 403);
    // 正常的 ISO 串照旧放行
    r = await req(port, 'PATCH', '/rooms/301000',
      { path: '/finishedAt', value: '2026-08-03T12:00:00.000Z' }, { 'X-Device-Id': 'anyone' });
    assert.equal(r.status, 200);

    // tx：夹带的 note/evil 不该落库；at 非数字用服务端时间
    r = await req(port, 'PATCH', '/rooms/301000',
      { path: '/tx/t_9', value: { from: 'p_b', to: 'p_a', points: 3, at: 'NOT-A-NUMBER',
        note: 'x'.repeat(100000), evil: { deep: 1 } } }, { 'X-Device-Id': 'x' });
    assert.equal(r.status, 200);

    const room = JSON.parse((await req(port, 'GET', '/rooms/301000')).body);
    assert.equal(room.finishedAt, '2026-08-03T12:00:00.000Z');
    assert.deepEqual(Object.keys(room.tx.t_9).sort(), ['at', 'byUid', 'from', 'points', 'to']);
    assert.equal(typeof room.tx.t_9.at, 'number');   // 'NOT-A-NUMBER' 被换成了服务端时间
    assert.equal(room.tx.t_9.byUid, 'x');
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

test('PATCH：时间戳一律服务端打，客户端传的不作数（各人手机的钟不一样，用客户端时间会让流水乱序）', async () => {
  const df = tmpData();
  const server = createRunfastServer({ dataFile: df });
  const port = await listen(server);
  try {
    await req(port, 'PUT', '/rooms/300500', sampleRoom(), { 'X-Device-Id': 'boss' });
    const before = Date.now();
    // 一台「钟慢了一小时」的手机记一笔
    await req(port, 'PATCH', '/rooms/300500',
      { path: '/tx/t_slow', value: { from: 'p_b', to: 'p_a', points: 5, at: before - 3600000 } },
      { 'X-Device-Id': 'x' });
    // 一台「钟快了一小时」的手机建个玩家
    await req(port, 'PATCH', '/rooms/300500',
      { path: '/players/p_fast', value: { name: '快表', uid: 'y', at: before + 3600000 } },
      { 'X-Device-Id': 'y' });
    // 自己退出，leftAt 也该被覆写
    await req(port, 'PATCH', '/rooms/300500', { path: '/players/p_b/left', value: true }, { 'X-Device-Id': 'x' });
    await req(port, 'PATCH', '/rooms/300500',
      { path: '/players/p_b/leftAt', value: before - 3600000 }, { 'X-Device-Id': 'x' });
    const room = JSON.parse((await req(port, 'GET', '/rooms/300500')).body);
    const after = Date.now();
    const inWindow = (v, what) => assert.ok(v >= before && v <= after, what + ' 应是服务端时间，实际 ' + v);
    inWindow(room.tx.t_slow.at, '流水的 at');
    inWindow(room.players.p_fast.at, '新玩家的 at');
    inWindow(room.players.p_b.leftAt, '退出时间 leftAt');
    // 回归时清 leftAt 仍然要能置空
    await req(port, 'PATCH', '/rooms/300500', { path: '/players/p_b/leftAt', value: null }, { 'X-Device-Id': 'x' });
    const back = JSON.parse((await req(port, 'GET', '/rooms/300500')).body);
    assert.ok(!('leftAt' in back.players.p_b), '回归时 leftAt 应被删掉');
  } finally { server.close(); fs.rmSync(df, { force: true }); }
});
