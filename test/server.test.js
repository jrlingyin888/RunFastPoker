const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createRunfastServer, canWrite, injectHostFlag, setPath, canPatch } = require('../server.js');

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
const sampleRoom = () => ({ creatorUid: 'boss', allowEdit: false, updatedAt: 1,
  session: { id: 's1', players: ['A'], activePlayers: ['A'], rounds: [] } });

test('injectHostFlag：有占位注释则替换为主机标志脚本，无则原样', () => {
  const withPlaceholder = '<div id="app"></div><!--RUNFAST_HOST--><script src="app.js"></script>';
  assert.ok(injectHostFlag(withPlaceholder).includes('window.__RUNFAST_HOST__=true'));
  assert.ok(!injectHostFlag(withPlaceholder).includes('<!--RUNFAST_HOST-->'));
  const noPlaceholder = '<div id="app"></div>';
  assert.equal(injectHostFlag(noPlaceholder), noPlaceholder);
});

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
          const isPut = chunk.split('\n').some((l) => l.startsWith('event: put'));
          const line = chunk.split('\n').find((l) => l.startsWith('data: '));
          if (!isPut || !line) continue;
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

test('setPath：按路径深设，支持数组下标与删除', () => {
  const r = { seats: [{ name: 'A', claimedBy: null }], draft: { winner: 1, entries: {} } };
  assert.equal(setPath(r, '/seats/0/claimedBy', 'd1').seats[0].claimedBy, 'd1');
  assert.deepEqual(setPath(r, '/draft/entries/1', { cardsLeft: 3 }).draft.entries[1], { cardsLeft: 3 });
  assert.ok(!('winner' in setPath(r, '/draft/winner', null).draft));
  assert.equal(setPath(r, '/', null), null);
  assert.equal(r.seats[0].claimedBy, null); // 不改原对象
});

test('canPatch：抢空座CAS / 填自己格 / 定赢家 / 房主专属', () => {
  const lobby = { creatorUid: 'boss', phase: 'lobby',
    seats: [{ name: 'A', claimedBy: 'boss' }, { name: 'B', claimedBy: null }], draft: null };
  assert.ok(canPatch(lobby, '/seats/1/claimedBy', 'x', 'x'));      // 抢空座
  assert.ok(!canPatch(lobby, '/seats/0/claimedBy', 'x', 'x'));     // 占用的座抢不到
  assert.ok(canPatch(lobby, '/seats/0/claimedBy', null, 'boss'));  // 房主可释放任意座
  assert.ok(!canPatch(lobby, '/seats/0/claimedBy', null, 'x'));    // 他人不能释放别人的座
  const playing = { creatorUid: 'boss', phase: 'playing',
    seats: [{ name: 'A', claimedBy: 'boss' }, { name: 'B', claimedBy: 'x' }], draft: { winner: null, entries: {} } };
  assert.ok(canPatch(playing, '/draft/entries/1', { cardsLeft: 3 }, 'x'));    // 填自己格
  assert.ok(!canPatch(playing, '/draft/entries/1', { cardsLeft: 3 }, 'y'));   // 非本座非房主
  assert.ok(canPatch(playing, '/draft/entries/1', { cardsLeft: 3 }, 'boss')); // 房主代填
  assert.ok(canPatch(playing, '/draft/winner', 0, 'x'));           // 持座者可定赢家
  assert.ok(!canPatch(playing, '/draft/winner', 0, 'z'));          // 观战者不行
  assert.ok(canPatch(playing, '/phase', 'finished', 'boss'));      // 房主
  assert.ok(!canPatch(playing, '/phase', 'finished', 'x'));        // 非房主
});

test('PATCH 集成：抢座成功、后到者越权被拒', async () => {
  const df = tmpData(); const server = createRunfastServer({ dataFile: df }); const port = await listen(server);
  try {
    const room = { creatorUid: 'boss', phase: 'lobby',
      seats: [{ name: 'A', claimedBy: null }, { name: 'B', claimedBy: null }], draft: null,
      session: { id: 's1', players: ['A', 'B'], activePlayers: ['A', 'B'], rounds: [] } };
    await req(port, 'PUT', '/rooms/300400', room, { 'X-Device-Id': 'boss' });
    let r = await req(port, 'PATCH', '/rooms/300400', { path: '/seats/0/claimedBy', value: 'x' }, { 'X-Device-Id': 'x' });
    assert.equal(r.status, 200);
    r = await req(port, 'GET', '/rooms/300400');
    assert.equal(JSON.parse(r.body).seats[0].claimedBy, 'x');
    r = await req(port, 'PATCH', '/rooms/300400', { path: '/seats/0/claimedBy', value: 'y' }, { 'X-Device-Id': 'y' });
    assert.equal(r.status, 403);
  } finally { server.close(); try { fs.unlinkSync(df); } catch (e) {} }
});

test('presence：带 dev 的连接会进在线名单并广播；第二人上线后名单含两人', async () => {
  const df = tmpData(); const server = createRunfastServer({ dataFile: df }); const port = await listen(server);
  const frames = [];
  let r2;
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { r1.destroy(); reject(new Error('presence 超时')); }, 4000);
      const r1 = http.request({ host: '127.0.0.1', port, method: 'GET', path: '/rooms/500600/events?dev=alice' }, (res) => {
        let buf = '';
        res.on('data', (c) => {
          buf += c; let idx;
          while ((idx = buf.indexOf('\n\n')) >= 0) {
            const chunk = buf.slice(0, idx); buf = buf.slice(idx + 2);
            const isPresence = chunk.split('\n').some((l) => l.startsWith('event: presence'));
            const dl = chunk.split('\n').find((l) => l.startsWith('data: '));
            if (!isPresence || !dl) continue;
            frames.push(JSON.parse(dl.slice(6)));
            if (frames.length === 1) {
              r2 = http.request({ host: '127.0.0.1', port, method: 'GET', path: '/rooms/500600/events?dev=bob' }, () => {});
              r2.end();
            } else if (frames.length >= 2) { clearTimeout(timer); r1.destroy(); resolve(); }
          }
        });
      });
      r1.on('error', reject); r1.end();
    });
    assert.deepEqual(frames[0].devices, ['alice']);
    const last = frames[frames.length - 1].devices;
    assert.ok(last.includes('alice') && last.includes('bob'));
  } finally { if (r2) r2.destroy(); server.close(); try { fs.unlinkSync(df); } catch (e) {} }
});
