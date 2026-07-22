# 跑得快记分结算 H5 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 做一个零服务器的单手机记分 H5：录入每局各玩家剩余牌数，自动结算、累计积分、生成最简转账方案与可分享的战绩图。

**Architecture:** 原生 HTML/CSS/JS，无框架无依赖。结算逻辑是纯函数（`src/logic.js`，Node/浏览器双兼容，`node --test` 测试）；UI 与状态管理在 `src/app.js`（innerHTML 模板 + 全局 `App` 对象处理交互）；战绩图用 Canvas 手绘（`src/share-card.js`）。开发期直接用浏览器打开 `src/index.html`（无需构建）；交付时 `build.js` 把所有 css/js 内联成单个 `dist/index.html`。

**Tech Stack:** 原生 ES6+ JavaScript、localStorage、Canvas 2D、Web Share API、Node.js 内置 test runner（仅测试与构建用，运行时零依赖）。

**设计文档:** `docs/superpowers/specs/2026-07-22-paodekuai-scorer-design.md`

## Global Constraints

- 运行时零依赖：不引入任何框架或第三方库；不创建 package.json。
- 交付物为单个 `dist/index.html`，由 `build.js` 生成。
- 金额一律以**分**（整数）运算，展示时格式化为元；存储字段 `pricePerCardFen`。
- 规则：每人 10 张牌；牌数输入 0～10；剩满 10 张自动标全关（×2，可手动取消）；人数 2～8。
- localStorage key 固定为 `runfast.v1`；所有累计值从 rounds 实时重算，不落库。
- 玩家名字 1～8 个字符，且不得包含 `' " < > \` 字符（防止 onclick 属性注入）。
- UI 为中文、移动端优先（目标 iOS Safari 15+ / Android Chrome）。
- 每个任务结束时 `node --test test/` 必须全绿（UI 任务同样要跑，防回归）。
- 提交信息用中文，格式如 `feat: 记一局流程`。

## 文件结构

```
src/index.html    页面骨架（开发期直接浏览器打开）
src/style.css     全部样式
src/logic.js      结算纯函数（IIFE 全局 RunfastLogic + module.exports）
src/share-card.js 战绩图绘制与分享降级（IIFE 全局 RunfastShare）
src/app.js        存储、导航、各视图渲染、App 交互对象
build.js          内联合并脚本 → dist/index.html
test/logic.test.js 结算逻辑测试（node:test）
```

---

### Task 1: 结算纯函数——金额换算与单局结算（TDD）

**Files:**
- Create: `test/logic.test.js`
- Create: `src/logic.js`

**Interfaces:**
- Produces（后续所有任务依赖）：全局 `RunfastLogic`，本任务提供
  `yuanToFen(str)->fen|NaN`、`fenToYuan(fen)->string`、
  `countedCards(loser)->number`、`roundTransfers(round, priceFen)->[{from,to,cards,fen}]`。
  loser 形如 `{name, cardsLeft, shutout}`；round 形如 `{winner, losers:[loser]}`。

- [ ] **Step 1: 写失败的测试**

创建 `test/logic.test.js`：

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const L = require('../src/logic.js');

test('yuanToFen：合法输入', () => {
  assert.equal(L.yuanToFen('1'), 100);
  assert.equal(L.yuanToFen('0.5'), 50);
  assert.equal(L.yuanToFen('2.50'), 250);
  assert.equal(L.yuanToFen('12.05'), 1205);
});

test('yuanToFen：非法输入返回 NaN', () => {
  assert.ok(Number.isNaN(L.yuanToFen('0')));      // 单价必须 > 0
  assert.ok(Number.isNaN(L.yuanToFen('-1')));
  assert.ok(Number.isNaN(L.yuanToFen('abc')));
  assert.ok(Number.isNaN(L.yuanToFen('1.234'))); // 最多两位小数
  assert.ok(Number.isNaN(L.yuanToFen('')));
});

test('fenToYuan：格式化去零', () => {
  assert.equal(L.fenToYuan(100), '1');
  assert.equal(L.fenToYuan(50), '0.5');
  assert.equal(L.fenToYuan(105), '1.05');
  assert.equal(L.fenToYuan(2600), '26');
  assert.equal(L.fenToYuan(-450), '-4.5');
  assert.equal(L.fenToYuan(0), '0');
});

test('countedCards：普通与全关', () => {
  assert.equal(L.countedCards({ name: '李四', cardsLeft: 4, shutout: false }), 4);
  assert.equal(L.countedCards({ name: '戴六', cardsLeft: 10, shutout: true }), 20);
  assert.equal(L.countedCards({ name: '戴六', cardsLeft: 10, shutout: false }), 10); // 手动取消全关
});

test('roundTransfers：设计文档示例', () => {
  const round = {
    winner: '张三',
    losers: [
      { name: '李四', cardsLeft: 4, shutout: false },
      { name: '王五', cardsLeft: 2, shutout: false },
      { name: '戴六', cardsLeft: 10, shutout: true },
    ],
  };
  const ts = L.roundTransfers(round, 100);
  assert.deepEqual(ts, [
    { from: '李四', to: '张三', cards: 4, fen: 400 },
    { from: '王五', to: '张三', cards: 2, fen: 200 },
    { from: '戴六', to: '张三', cards: 20, fen: 2000 },
  ]);
  // 不变量：本局转账总额 = 赢家所得
  const total = ts.reduce((s, t) => s + t.fen, 0);
  assert.equal(total, 2600);
});

test('roundTransfers：剩 0 张的玩家不产生转账', () => {
  const round = {
    winner: '张三',
    losers: [
      { name: '李四', cardsLeft: 0, shutout: false },
      { name: '王五', cardsLeft: 3, shutout: false },
    ],
  };
  const ts = L.roundTransfers(round, 100);
  assert.deepEqual(ts, [{ from: '王五', to: '张三', cards: 3, fen: 300 }]);
});
```

- [ ] **Step 2: 运行确认失败**

Run: `node --test test/`
Expected: FAIL，报错 `Cannot find module '../src/logic.js'`

- [ ] **Step 3: 最小实现**

创建 `src/logic.js`：

```js
// 跑得快结算纯函数。金额一律以“分”（整数）计算。
// 浏览器：全局 RunfastLogic；Node：module.exports（供测试）。
var RunfastLogic = (function () {
  'use strict';

  const HAND_SIZE = 10;
  const SHUTOUT_MULTIPLIER = 2;

  // 元字符串 -> 分。非法（非数字/超两位小数/<=0）返回 NaN。
  function yuanToFen(str) {
    if (typeof str !== 'string' || !/^\d+(\.\d{1,2})?$/.test(str.trim())) return NaN;
    const fen = Math.round(parseFloat(str) * 100);
    return fen > 0 ? fen : NaN;
  }

  // 分 -> 元字符串，去多余的零：100->'1'，50->'0.5'，105->'1.05'
  function fenToYuan(fen) {
    const sign = fen < 0 ? '-' : '';
    const abs = Math.abs(fen);
    const yuan = Math.floor(abs / 100);
    const rest = abs % 100;
    if (rest === 0) return sign + yuan;
    let dec = (rest < 10 ? '0' : '') + rest;
    if (dec[1] === '0') dec = dec[0];
    return sign + yuan + '.' + dec;
  }

  // 输家本局实际计的牌数（全关双倍）
  function countedCards(loser) {
    return loser.shutout ? loser.cardsLeft * SHUTOUT_MULTIPLIER : loser.cardsLeft;
  }

  // 一局的转账明细（剩 0 张不计）
  function roundTransfers(round, priceFen) {
    return round.losers
      .filter((l) => l.cardsLeft > 0)
      .map((l) => {
        const cards = countedCards(l);
        return { from: l.name, to: round.winner, cards, fen: cards * priceFen };
      });
  }

  const api = { HAND_SIZE, yuanToFen, fenToYuan, countedCards, roundTransfers };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  return api;
})();
```

- [ ] **Step 4: 运行确认通过**

Run: `node --test test/`
Expected: 全部 PASS

- [ ] **Step 5: 提交**

```bash
git add src/logic.js test/logic.test.js
git commit -m "feat: 结算纯函数——金额换算与单局结算"
```

---

### Task 2: 结算纯函数——整场净额、最简转账、战绩文本（TDD）

**Files:**
- Modify: `src/logic.js`（在 api 声明前追加函数，并把新函数加进 api）
- Modify: `test/logic.test.js`（末尾追加）

**Interfaces:**
- Consumes: Task 1 的 `roundTransfers`、`fenToYuan`。
- Produces: `sessionNet(session)->[{name,cards,fen}]`（含 session.players 全部人，顺序同 players）、
  `settleUp(net)->[{from,to,fen}]`、`summaryText(session)->string`。
  session 形如 `{createdAt, pricePerCardFen, players:[name], rounds:[round]}`。

- [ ] **Step 1: 追加失败的测试**

在 `test/logic.test.js` 末尾追加：

```js
function demoSession() {
  return {
    createdAt: '2026-07-22T20:00:00+08:00',
    pricePerCardFen: 100,
    players: ['张三', '李四', '王五', '戴六'],
    rounds: [
      {
        id: 'r1', winner: '张三',
        losers: [
          { name: '李四', cardsLeft: 4, shutout: false },
          { name: '王五', cardsLeft: 2, shutout: false },
          { name: '戴六', cardsLeft: 10, shutout: true },
        ],
      },
      {
        id: 'r2', winner: '李四',
        losers: [
          { name: '张三', cardsLeft: 1, shutout: false },
          { name: '王五', cardsLeft: 3, shutout: false },
          { name: '戴六', cardsLeft: 5, shutout: false },
        ],
      },
    ],
  };
}

test('sessionNet：两局累计，净额和为 0', () => {
  const net = L.sessionNet(demoSession());
  assert.deepEqual(net, [
    { name: '张三', cards: 25, fen: 2500 },
    { name: '李四', cards: 5, fen: 500 },
    { name: '王五', cards: -5, fen: -500 },
    { name: '戴六', cards: -25, fen: -2500 },
  ]);
  assert.equal(net.reduce((s, p) => s + p.fen, 0), 0);
});

test('sessionNet：中途加入未参与任何局的人净额为 0', () => {
  const s = demoSession();
  s.players.push('钱七');
  const net = L.sessionNet(s);
  assert.deepEqual(net[4], { name: '钱七', cards: 0, fen: 0 });
});

test('settleUp：最简转账，按人汇总与净额一致', () => {
  const net = L.sessionNet(demoSession());
  const pays = L.settleUp(net);
  assert.deepEqual(pays, [
    { from: '戴六', to: '张三', fen: 2500 },
    { from: '王五', to: '李四', fen: 500 },
  ]);
  assert.ok(pays.length <= net.length - 1);
});

test('settleUp：一个债务人还多个债权人', () => {
  const pays = L.settleUp([
    { name: 'A', fen: 300 },
    { name: 'B', fen: 200 },
    { name: 'C', fen: -500 },
  ]);
  assert.deepEqual(pays, [
    { from: 'C', to: 'A', fen: 300 },
    { from: 'C', to: 'B', fen: 200 },
  ]);
});

test('settleUp：全部打平返回空数组', () => {
  assert.deepEqual(L.settleUp([{ name: 'A', fen: 0 }, { name: 'B', fen: 0 }]), []);
});

test('summaryText：包含标题、盈亏与转账行', () => {
  const text = L.summaryText(demoSession());
  assert.ok(text.includes('跑得快战绩'));
  assert.ok(text.includes('共 2 局'));
  assert.ok(text.includes('1元/张'));
  assert.ok(text.includes('张三：+25 元'));
  assert.ok(text.includes('戴六：-25 元'));
  assert.ok(text.includes('戴六 → 张三：25 元'));
});
```

- [ ] **Step 2: 运行确认失败**

Run: `node --test test/`
Expected: 新增用例 FAIL（`L.sessionNet is not a function`），Task 1 用例仍 PASS

- [ ] **Step 3: 实现**

在 `src/logic.js` 的 `const api = ...` 之前追加：

```js
  // 整场累计净额。包含 session.players 中所有人（未参局者为 0），顺序同 players。
  function sessionNet(session) {
    const net = {};
    const entry = (n) => (net[n] ||= { name: n, cards: 0, fen: 0 });
    session.players.forEach(entry);
    session.rounds.forEach((round) => {
      roundTransfers(round, session.pricePerCardFen).forEach((t) => {
        entry(t.from).cards -= t.cards; entry(t.from).fen -= t.fen;
        entry(t.to).cards += t.cards;   entry(t.to).fen += t.fen;
      });
    });
    return session.players.map((n) => net[n]);
  }

  // 最简转账：欠最多的与赢最多的贪心配对，笔数 <= 人数-1
  function settleUp(net) {
    const debtors = [], creditors = [];
    net.forEach((p) => {
      if (p.fen < 0) debtors.push({ name: p.name, fen: -p.fen });
      else if (p.fen > 0) creditors.push({ name: p.name, fen: p.fen });
    });
    debtors.sort((a, b) => b.fen - a.fen);
    creditors.sort((a, b) => b.fen - a.fen);
    const out = [];
    let i = 0, j = 0;
    while (i < debtors.length && j < creditors.length) {
      const pay = Math.min(debtors[i].fen, creditors[j].fen);
      out.push({ from: debtors[i].name, to: creditors[j].name, fen: pay });
      debtors[i].fen -= pay; creditors[j].fen -= pay;
      if (debtors[i].fen === 0) i++;
      if (creditors[j].fen === 0) j++;
    }
    return out;
  }

  const pad2 = (n) => String(n).padStart(2, '0');

  // 战绩纯文本（复制到聊天工具）
  function summaryText(session) {
    const d = new Date(session.createdAt);
    const lines = [];
    lines.push('【跑得快战绩】' + d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()));
    lines.push('共 ' + session.rounds.length + ' 局 · ' + fenToYuan(session.pricePerCardFen) + '元/张');
    lines.push('— 盈亏 —');
    sessionNet(session)
      .slice().sort((a, b) => b.fen - a.fen)
      .forEach((p) => lines.push(p.name + '：' + (p.fen > 0 ? '+' : '') + fenToYuan(p.fen) + ' 元'));
    const pays = settleUp(sessionNet(session));
    if (pays.length) {
      lines.push('— 转账 —');
      pays.forEach((t) => lines.push(t.from + ' → ' + t.to + '：' + fenToYuan(t.fen) + ' 元'));
    }
    return lines.join('\n');
  }
```

并把 api 行改为：

```js
  const api = { HAND_SIZE, yuanToFen, fenToYuan, countedCards, roundTransfers, sessionNet, settleUp, summaryText };
```

- [ ] **Step 4: 运行确认通过**

Run: `node --test test/`
Expected: 全部 PASS

- [ ] **Step 5: 提交**

```bash
git add src/logic.js test/logic.test.js
git commit -m "feat: 整场净额、最简转账与战绩文本"
```

---

### Task 3: 页面骨架、样式与构建脚本

**Files:**
- Create: `src/index.html`
- Create: `src/style.css`
- Create: `src/share-card.js`（占位实现，Task 9 替换）
- Create: `src/app.js`（最小可运行占位，Task 4 起填充）
- Create: `build.js`

**Interfaces:**
- Produces: 页面骨架 `<div id="app">` + 三个 script 的加载顺序 logic → share-card → app；
  样式类名（后续任务的模板都用它们）：`card btn btn-primary btn-danger btn-sm row pos neg chips chip on numgrid overlay muted badge topbar back`；
  `node build.js` 生成 `dist/index.html`。

- [ ] **Step 1: 创建 `src/index.html`**

```html
<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>跑得快记分</title>
<link rel="stylesheet" href="style.css">
</head>
<body>
<div id="app"></div>
<script src="logic.js"></script>
<script src="share-card.js"></script>
<script src="app.js"></script>
</body>
</html>
```

- [ ] **Step 2: 创建 `src/style.css`**

```css
* { margin: 0; padding: 0; box-sizing: border-box; -webkit-tap-highlight-color: transparent; }
body { font-family: -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif; background: #f3f4f6; color: #111827; }
#app { max-width: 520px; margin: 0 auto; min-height: 100vh; padding: 14px 16px calc(24px + env(safe-area-inset-bottom)); }
h1 { font-size: 22px; }
.card { background: #fff; border-radius: 14px; padding: 16px; margin-bottom: 12px; box-shadow: 0 1px 3px rgba(0,0,0,.06); }
.btn { display: block; width: 100%; border: 0; border-radius: 12px; padding: 15px; font-size: 17px; font-weight: 600; background: #e5e7eb; color: #111827; cursor: pointer; }
.btn-primary { background: #2563eb; color: #fff; }
.btn-danger { background: #fee2e2; color: #b91c1c; }
.btn-sm { display: inline-block; width: auto; padding: 9px 14px; font-size: 14px; }
.row { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 11px 0; border-bottom: 1px solid #f3f4f6; font-size: 16px; }
.row:last-child { border-bottom: 0; }
.pos { color: #dc2626; font-weight: 700; }
.neg { color: #059669; font-weight: 700; }
.chips { display: flex; flex-wrap: wrap; gap: 8px; }
.chip { padding: 10px 16px; border-radius: 999px; background: #f3f4f6; border: 1.5px solid #e5e7eb; font-size: 16px; cursor: pointer; }
.chip.on { background: #dbeafe; border-color: #2563eb; color: #1d4ed8; font-weight: 600; }
.numgrid { display: grid; grid-template-columns: repeat(6, 1fr); gap: 6px; }
.numgrid button { padding: 11px 0; border-radius: 8px; border: 1.5px solid #e5e7eb; background: #fff; font-size: 16px; cursor: pointer; }
.numgrid button.on { background: #2563eb; color: #fff; border-color: #2563eb; }
.overlay { position: fixed; inset: 0; background: rgba(0,0,0,.55); display: flex; align-items: center; justify-content: center; z-index: 50; padding: 20px; }
input[type=text] { width: 100%; padding: 12px; border: 1.5px solid #e5e7eb; border-radius: 10px; font-size: 16px; }
.muted { color: #6b7280; font-size: 13px; }
.badge { display: inline-block; padding: 3px 10px; border-radius: 6px; background: #fef3c7; color: #92400e; font-size: 12px; font-weight: 600; border: 0; cursor: pointer; }
.topbar { display: flex; align-items: center; gap: 10px; margin-bottom: 12px; }
.topbar .title { font-weight: 700; font-size: 18px; }
.back { border: 0; background: none; font-size: 16px; color: #2563eb; padding: 4px; cursor: pointer; }
.section-title { font-weight: 600; margin-bottom: 10px; }
.gap { height: 10px; }
```

- [ ] **Step 3: 创建占位 `src/share-card.js` 与最小 `src/app.js`**

`src/share-card.js`：

```js
// 战绩图绘制与分享（Task 9 实现）。占位保证页面可运行。
var RunfastShare = (function () {
  'use strict';
  async function share() { alert('分享功能即将上线'); }
  const api = { share };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  return api;
})();
```

`src/app.js`：

```js
(() => {
  'use strict';
  document.getElementById('app').innerHTML =
    '<h1 style="text-align:center;margin-top:40vh">🃏 跑得快记分（建设中）</h1>';
})();
```

- [ ] **Step 4: 创建 `build.js`**

```js
// 把 src 下的 css/js 内联进单个 dist/index.html（零依赖交付）
const fs = require('fs');
const path = require('path');
const read = (p) => fs.readFileSync(path.join(__dirname, 'src', p), 'utf8');

let html = read('index.html');
html = html.replace('<link rel="stylesheet" href="style.css">',
  () => '<style>\n' + read('style.css') + '\n</style>');
for (const js of ['logic.js', 'share-card.js', 'app.js']) {
  html = html.replace(`<script src="${js}"></script>`,
    () => '<script>\n' + read(js) + '\n</script>');
}
if (/<link rel="stylesheet"|<script src=/.test(html)) {
  throw new Error('仍有未内联的外部引用，检查 index.html 与 build.js 的文件清单');
}
fs.mkdirSync(path.join(__dirname, 'dist'), { recursive: true });
fs.writeFileSync(path.join(__dirname, 'dist', 'index.html'), html);
console.log('已生成 dist/index.html（' + (html.length / 1024).toFixed(1) + ' KB）');
```

- [ ] **Step 5: 验证**

Run: `node build.js && node --test test/`
Expected: 输出"已生成 dist/index.html"，测试全绿。
再用浏览器分别打开 `src/index.html` 和 `dist/index.html`，两者都显示"🃏 跑得快记分（建设中）"，控制台无报错。

- [ ] **Step 6: 提交**

```bash
git add src build.js dist
git commit -m "feat: 页面骨架、样式与单文件构建脚本"
```

---

### Task 4: 存储层、首页与开新一场

**Files:**
- Modify: `src/app.js`（整体替换为以下内容；后续任务在此文件内追加）

**Interfaces:**
- Consumes: `RunfastLogic`（Task 1/2）、Task 3 的样式类。
- Produces（后续任务在同文件内使用）：
  `db`（内存数据库）、`saveDB()`、`activeSession()`、`go(view)`、`render()`、
  `esc(s)`、`yuan(fen)`、`signYuan(fen)`、`cls(fen)`、`fmtDate(iso)`、`topbar(title, backJs)`、
  `validName(s)->bool`、视图分发表 `VIEWS`（后续任务往里加渲染函数）、全局 `window.App`。
  session 对象结构见设计文档 §5：`{id, createdAt, pricePerCardFen, players, activePlayers, status, rounds}`。

- [ ] **Step 1: 整体替换 `src/app.js`**

```js
(() => {
  'use strict';
  const L = RunfastLogic;
  const STORE_KEY = 'runfast.v1';

  // ---------- 存储 ----------
  function loadDB() {
    try {
      const raw = localStorage.getItem(STORE_KEY);
      if (raw) {
        const data = JSON.parse(raw);
        if (data.version === 1 && Array.isArray(data.sessions)) return data;
      }
    } catch (e) { /* 损坏数据按空库处理 */ }
    return { version: 1, playerDirectory: [], sessions: [] };
  }
  function saveDB() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(db)); }
    catch (e) { alert('保存失败：浏览器本地存储不可用（可能是无痕模式）。请尽快导出备份！'); }
  }
  let db = loadDB();

  // ---------- 工具 ----------
  const $app = document.getElementById('app');
  const esc = (s) => String(s).replace(/[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const validName = (s) => /^[^'"<>\\]{1,8}$/.test(s);
  const yuan = (fen) => L.fenToYuan(fen);
  const signYuan = (fen) => (fen > 0 ? '+' : '') + L.fenToYuan(fen);
  const cls = (fen) => (fen > 0 ? 'pos' : fen < 0 ? 'neg' : '');
  const fmtDate = (iso) => {
    const d = new Date(iso);
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  };
  const activeSession = () => db.sessions.find((s) => s.status === 'active') || null;
  const topbar = (title, backJs) =>
    `<div class="topbar">${backJs ? `<button class="back" onclick="${backJs}">‹ 返回</button>` : ''}<div class="title">${title}</div></div>`;

  // ---------- 导航与渲染 ----------
  let view = { name: 'home' };
  function go(v) { view = v; render(); window.scrollTo(0, 0); }
  const VIEWS = {};
  function render() { $app.innerHTML = VIEWS[view.name](); }

  // ---------- 首页 ----------
  VIEWS.home = () => {
    const act = activeSession();
    return `
      <h1 style="text-align:center;margin:20px 0 18px">🃏 跑得快记分</h1>
      ${act
        ? `<button class="btn btn-primary" onclick="App.goSession()">继续本场（${act.players.map(esc).join('、')}）</button>`
        : `<button class="btn btn-primary" onclick="App.goSetup()">开新一场</button>`}
      <div class="gap"></div>
      <button class="btn" onclick="App.goHistory()">历史记录</button>
      <div class="gap"></div>
      <div class="card">
        <div class="muted" style="margin-bottom:10px">数据保存在本手机浏览器里，换手机或清缓存前请先导出</div>
        <button class="btn btn-sm" onclick="App.exportData()">导出备份</button>
        <button class="btn btn-sm" onclick="App.importData()">导入备份</button>
      </div>`;
  };

  // ---------- 开新一场 ----------
  VIEWS.setup = () => {
    const sel = view.sel;
    return `
      ${topbar('开新一场', 'App.goHome()')}
      <div class="card">
        <div class="section-title">选择玩家（2～8 人）</div>
        <div class="chips">
          ${db.playerDirectory.map((n) =>
            `<button class="chip ${sel.includes(n) ? 'on' : ''}" onclick="App.togglePlayer('${esc(n)}')">${esc(n)}</button>`).join('')
          || '<span class="muted">还没有玩家，先在下面添加</span>'}
        </div>
        <div style="display:flex;gap:8px;margin-top:12px">
          <input type="text" id="newName" placeholder="新玩家名字（8 字以内）" maxlength="8">
          <button class="btn btn-sm" onclick="App.addPlayer()">添加</button>
        </div>
        ${sel.length ? `<div class="muted" style="margin-top:10px">已选 ${sel.length} 人：${sel.map(esc).join('、')}</div>` : ''}
      </div>
      <div class="card">
        <div class="section-title">每张牌单价（元）</div>
        <input type="text" id="price" inputmode="decimal" value="${esc(view.price)}" placeholder="如 1 或 0.5">
      </div>
      <button class="btn btn-primary" onclick="App.startSession()">开始记分</button>`;
  };

  // 其余视图占位（后续任务实现）
  VIEWS.session = () => topbar('记分主页', 'App.goHome()') + '<div class="card muted">建设中</div>';
  VIEWS.history = () => topbar('历史记录', 'App.goHome()') + '<div class="card muted">建设中</div>';

  // ---------- 交互 ----------
  const App = {
    goHome: () => go({ name: 'home' }),
    goSetup: () => go({ name: 'setup', sel: [], price: '1' }),
    goSession: () => go({ name: 'session' }),
    goHistory: () => go({ name: 'history' }),

    togglePlayer(name) {
      view.price = document.getElementById('price').value; // 保留已输入的单价
      const i = view.sel.indexOf(name);
      if (i >= 0) view.sel.splice(i, 1); else view.sel.push(name);
      render();
    },

    addPlayer() {
      const inp = document.getElementById('newName');
      const name = inp.value.trim();
      if (!validName(name)) { alert('名字需 1～8 个字，且不能含引号等特殊符号'); return; }
      if (db.playerDirectory.includes(name)) { alert('已有同名玩家，直接点选即可'); return; }
      view.price = document.getElementById('price').value;
      db.playerDirectory.push(name);
      view.sel.push(name);
      saveDB();
      render();
    },

    startSession() {
      const priceFen = L.yuanToFen(document.getElementById('price').value.trim());
      if (view.sel.length < 2 || view.sel.length > 8) { alert('请选择 2～8 名玩家'); return; }
      if (Number.isNaN(priceFen)) { alert('单价格式不对，例：1 或 0.5'); return; }
      db.sessions.push({
        id: 's' + Date.now(),
        createdAt: new Date().toISOString(),
        pricePerCardFen: priceFen,
        players: view.sel.slice(),
        activePlayers: view.sel.slice(),
        status: 'active',
        rounds: [],
      });
      saveDB();
      App.goSession();
    },

    exportData() { alert('导出功能即将上线'); },  // Task 8 实现
    importData() { alert('导入功能即将上线'); },  // Task 8 实现
  };
  window.App = App;

  render();
})();
```

- [ ] **Step 2: 浏览器验证**

打开 `src/index.html`，依次确认：
1. 首页显示"开新一场 / 历史记录 / 导出导入"。
2. 进入开新一场，添加"张三、李四、王五、戴六"四人（自动选中，chips 高亮）。
3. 单价改成 `0.5` 再点选/取消某个玩家，单价输入不丢失。
4. 添加名字含引号（如 `a"b`）被拒绝；不选人直接开始被拒绝；单价 `abc` 被拒绝。
5. 点"开始记分"跳到记分主页占位；刷新页面后首页出现"继续本场（张三、李四、王五、戴六）"（localStorage 生效）。

- [ ] **Step 3: 回归测试并提交**

Run: `node --test test/`
Expected: 全绿

```bash
git add src/app.js
git commit -m "feat: 存储层、首页与开新一场流程"
```

---

### Task 5: 记分主页与记一局

**Files:**
- Modify: `src/app.js`

**Interfaces:**
- Consumes: Task 4 的 `VIEWS`、`App`、工具函数；`L.sessionNet/roundTransfers`。
- Produces: `VIEWS.session`（完整版）、`VIEWS.record`、`App.goRecord/pickWinner/pickCards/toggleShutout/saveRound`、
  `roundRow(s, r, i, readonly)`（Task 7 历史明细复用）。
  record 视图状态：`{name:'record', participants:[名字], winner:名字|null, cards:{名字:数}, shutoutOff:{名字:true}, editId:局id|null, editIndex:序号|null}`。

- [ ] **Step 1: 替换 `VIEWS.session` 占位并新增 `VIEWS.record`**

删除 Task 4 的 `VIEWS.session = ...` 占位行，加入：

```js
  // ---------- 记分主页 ----------
  function roundRow(s, r, i, readonly) {
    const detail = L.roundTransfers(r, s.pricePerCardFen)
      .map((t) => `${esc(t.from)} ${t.cards}张`).join('，');
    return `<div class="row">
      <div><b>第${i + 1}局</b> ${esc(r.winner)} 赢
        <div class="muted">${detail || '其他人也都出完了'}</div></div>
      ${readonly ? '' : `<div style="flex-shrink:0">
        <button class="btn btn-sm" onclick="App.editRound('${r.id}')">改</button>
        <button class="btn btn-sm" onclick="App.deleteRound('${r.id}')">删</button></div>`}
    </div>`;
  }

  VIEWS.session = () => {
    const s = activeSession();
    if (!s) return VIEWS.home();
    const net = L.sessionNet(s).slice().sort((a, b) => b.fen - a.fen);
    return `
      ${topbar(`已记 ${s.rounds.length} 局 · ${yuan(s.pricePerCardFen)}元/张`, 'App.goHome()')}
      <div class="card">
        ${net.map((p) => `<div class="row">
          <span>${esc(p.name)}${s.activePlayers.includes(p.name) ? '' : ' <span class="muted">（已离场）</span>'}</span>
          <span class="${cls(p.fen)}">${p.cards > 0 ? '+' : ''}${p.cards} 张 · ${signYuan(p.fen)} 元</span>
        </div>`).join('')}
      </div>
      <button class="btn btn-primary" style="font-size:20px;padding:18px" onclick="App.goRecord()">📝 记一局</button>
      <div style="display:flex;gap:10px;margin-top:10px">
        <button class="btn" onclick="App.goPlayers()">玩家管理</button>
        <button class="btn btn-danger" onclick="App.finishSession()">结束本场</button>
      </div>
      <div class="card" style="margin-top:12px">
        ${s.rounds.map((r, i) => roundRow(s, r, i, false)).join('')
          || '<div class="muted">还没有记录，点上面「记一局」开始</div>'}
      </div>`;
  };

  // ---------- 记一局 ----------
  function currentLosers() {
    return view.participants
      .filter((n) => n !== view.winner)
      .map((n) => ({
        name: n,
        cardsLeft: view.cards[n],
        shutout: view.cards[n] === 10 && !view.shutoutOff[n],
      }));
  }

  VIEWS.record = () => {
    const s = activeSession();
    const ps = view.participants;
    const w = view.winner;
    const losers = ps.filter((n) => n !== w);
    const ready = w && losers.every((n) => view.cards[n] !== undefined);
    let previewHtml = '';
    if (ready) {
      const ts = L.roundTransfers({ winner: w, losers: currentLosers() }, s.pricePerCardFen);
      previewHtml = `<div class="card"><div class="section-title">本局结算预览</div>
        ${ts.map((t) => `<div class="row"><span>${esc(t.from)} → ${esc(t.to)}</span><span>${t.cards} 张 · ${yuan(t.fen)} 元</span></div>`).join('')
          || '<div class="muted">其他人都 0 张，本局无转账</div>'}</div>`;
    }
    return `
      ${topbar(view.editId ? `修改第 ${view.editIndex} 局` : `记第 ${s.rounds.length + 1} 局`, 'App.goSession()')}
      <div class="card">
        <div class="section-title">1️⃣ 谁赢了？</div>
        <div class="chips">${ps.map((n) =>
          `<button class="chip ${w === n ? 'on' : ''}" onclick="App.pickWinner('${esc(n)}')">${esc(n)}</button>`).join('')}</div>
      </div>
      ${w ? losers.map((n) => {
        const v = view.cards[n];
        const shutBadge =
          v === 10 && !view.shutoutOff[n]
            ? `<button class="badge" onclick="App.toggleShutout('${esc(n)}')">全关 ×2（点此取消）</button>`
            : v === 10
              ? `<button class="badge" style="background:#e5e7eb;color:#374151" onclick="App.toggleShutout('${esc(n)}')">全关已取消（点此恢复）</button>`
              : '';
        return `<div class="card">
          <div class="section-title">${esc(n)} 剩几张？ ${shutBadge}</div>
          <div class="numgrid">${[0,1,2,3,4,5,6,7,8,9,10].map((k) =>
            `<button class="${v === k ? 'on' : ''}" onclick="App.pickCards('${esc(n)}',${k})">${k}</button>`).join('')}</div>
        </div>`;
      }).join('') : ''}
      ${previewHtml}
      <button class="btn btn-primary" ${ready ? '' : 'disabled style="opacity:.4"'} onclick="App.saveRound()">
        ${view.editId ? '保存修改' : '✅ 确认保存'}</button>`;
  };
```

- [ ] **Step 2: 在 `App` 对象中新增方法**

在 `App` 对象里（`exportData` 之前）加入：

```js
    goRecord() {
      const s = activeSession();
      if (s.activePlayers.length < 2) { alert('在场玩家不足 2 人，请先到「玩家管理」加人'); return; }
      go({ name: 'record', participants: s.activePlayers.slice(), winner: null, cards: {}, shutoutOff: {}, editId: null, editIndex: null });
    },

    pickWinner(name) {
      view.winner = name;
      delete view.cards[name]; // 赢家固定 0 张
      render();
    },

    pickCards(name, k) {
      view.cards[name] = k;
      delete view.shutoutOff[name]; // 改牌数后全关标记回到自动状态
      render();
    },

    toggleShutout(name) {
      if (view.shutoutOff[name]) delete view.shutoutOff[name];
      else view.shutoutOff[name] = true;
      render();
    },

    saveRound() {
      const s = activeSession();
      const losers = currentLosers();
      if (!view.winner || losers.some((l) => typeof l.cardsLeft !== 'number')) return;
      if (view.editId) {
        const r = s.rounds.find((x) => x.id === view.editId);
        r.winner = view.winner;
        r.losers = losers;
      } else {
        s.rounds.push({
          id: 'r' + Date.now(),
          at: new Date().toISOString(),
          winner: view.winner,
          losers,
        });
      }
      saveDB();
      App.goSession();
    },

    editRound() { alert('修改功能即将上线'); },   // Task 6 实现
    deleteRound() { alert('删除功能即将上线'); }, // Task 6 实现
    goPlayers() { alert('玩家管理即将上线'); },   // Task 6 实现
    finishSession() { alert('结束本场即将上线'); }, // Task 7 实现
```

- [ ] **Step 3: 浏览器验证**

打开 `src/index.html`（沿用上一任务建的场，或新开一场四人、单价 1 元）：
1. 记分主页显示 4 人积分榜均为 0。
2. 点"记一局"→ 点张三为赢家 → 李四选 4、王五选 2、戴六选 10。
3. 戴六选 10 后自动出现"全关 ×2"徽标；预览显示 李四→张三 4张4元、王五→张三 2张2元、戴六→张三 20张20元。
4. 点徽标取消全关，预览变 10张10元；再点恢复为 20张20元。
5. 确认保存后回到主页：张三 +26 张 +26 元（红色），戴六 -20 张 -20 元（绿色）；局列表出现"第1局 张三 赢"。
6. 刷新页面数据仍在。

- [ ] **Step 4: 回归测试并提交**

Run: `node --test test/`
Expected: 全绿

```bash
git add src/app.js
git commit -m "feat: 记分主页与记一局流程（含全关自动标记与预览）"
```

---

### Task 6: 修改/删除局与玩家管理

**Files:**
- Modify: `src/app.js`

**Interfaces:**
- Consumes: Task 5 的 record 视图（编辑模式靠 `editId/editIndex` 已支持）。
- Produces: `VIEWS.players`、`App.editRound/deleteRound/goPlayers/leave/comeBack/joinPlayer` 的完整实现。

- [ ] **Step 1: 新增 `VIEWS.players`**

```js
  // ---------- 玩家管理 ----------
  VIEWS.players = () => {
    const s = activeSession();
    return `
      ${topbar('玩家管理', 'App.goSession()')}
      <div class="card">
        ${s.players.map((n) => `<div class="row"><span>${esc(n)}</span>
          ${s.activePlayers.includes(n)
            ? `<button class="btn btn-sm" onclick="App.leave('${esc(n)}')">标记离场</button>`
            : `<button class="btn btn-sm" onclick="App.comeBack('${esc(n)}')">回归</button>`}
        </div>`).join('')}
        <div style="display:flex;gap:8px;margin-top:12px">
          <input type="text" id="joinName" placeholder="中途加入的玩家名字" maxlength="8">
          <button class="btn btn-sm" onclick="App.joinPlayer()">加入</button>
        </div>
        <div class="muted" style="margin-top:10px">离场玩家不再出现在新局录入中；历史成绩保留，仍参与最终结算。</div>
      </div>`;
  };
```

- [ ] **Step 2: 替换 Task 5 的四个占位方法**

删除 `editRound/deleteRound/goPlayers` 的占位实现，替换为：

```js
    editRound(rid) {
      const s = activeSession();
      const i = s.rounds.findIndex((x) => x.id === rid);
      const r = s.rounds[i];
      const cards = {}, shutoutOff = {};
      r.losers.forEach((l) => {
        cards[l.name] = l.cardsLeft;
        if (l.cardsLeft === 10 && !l.shutout) shutoutOff[l.name] = true;
      });
      go({
        name: 'record',
        participants: [r.winner, ...r.losers.map((l) => l.name)],
        winner: r.winner, cards, shutoutOff,
        editId: rid, editIndex: i + 1,
      });
    },

    deleteRound(rid) {
      if (!confirm('删除后总分将重算，确定删除这一局？')) return;
      const s = activeSession();
      s.rounds = s.rounds.filter((x) => x.id !== rid);
      saveDB();
      render();
    },

    goPlayers: () => go({ name: 'players' }),

    leave(name) {
      const s = activeSession();
      s.activePlayers = s.activePlayers.filter((n) => n !== name);
      saveDB();
      render();
    },

    comeBack(name) {
      const s = activeSession();
      s.activePlayers.push(name);
      saveDB();
      render();
    },

    joinPlayer() {
      const s = activeSession();
      const name = document.getElementById('joinName').value.trim();
      if (!validName(name)) { alert('名字需 1～8 个字，且不能含引号等特殊符号'); return; }
      if (s.players.includes(name)) { alert('这个名字本场已存在'); return; }
      if (s.activePlayers.length >= 8) { alert('在场玩家已达 8 人上限'); return; }
      s.players.push(name);
      s.activePlayers.push(name);
      if (!db.playerDirectory.includes(name)) db.playerDirectory.push(name);
      saveDB();
      render();
    },
```

- [ ] **Step 3: 浏览器验证**

1. 主页点第 1 局的"改"：预填 张三赢、李四 4、王五 2、戴六 10 全关。把戴六改成 7 张，保存后总分变为张三 +13。
2. 再点"改"把戴六改回 10（自动全关），保存，总分回到 +26。
3. 玩家管理：加入"钱七"→ 记一局时出现钱七；标记钱七离场 → 记一局不再出现，但积分榜仍显示（已离场）。
4. 删除第 1 局（弹确认框）→ 积分榜全部归零。
5. 重新按第 1 局数据记一局备用（张三赢、李四 4、王五 2、戴六 10 全关）。

- [ ] **Step 4: 回归测试并提交**

Run: `node --test test/`
Expected: 全绿

```bash
git add src/app.js
git commit -m "feat: 局的修改删除与玩家管理（中途加人/离场）"
```

---

### Task 7: 结束本场、结算页、历史记录与复制战绩

**Files:**
- Modify: `src/app.js`

**Interfaces:**
- Consumes: `L.sessionNet/settleUp/summaryText`；Task 5 的 `roundRow`。
- Produces: `VIEWS.settle`（结束页与历史详情共用，`view={name:'settle', sid, from:'home'|'history'}`）、
  `VIEWS.rounds`（只读局明细，`view={name:'rounds', sid, from}`）、`VIEWS.history`（完整版）、
  `App.finishSession/goSettle/goRounds/copyText`、`copyToClipboard(text)`。
  `App.shareImage(sid)` 本任务先占位，Task 9 接线。

- [ ] **Step 1: 替换 `VIEWS.history` 占位并新增结算相关视图**

```js
  // ---------- 结算页（结束本场后 & 历史详情共用） ----------
  VIEWS.settle = () => {
    const s = db.sessions.find((x) => x.id === view.sid);
    const backJs = view.from === 'history' ? 'App.goHistory()' : 'App.goHome()';
    const net = L.sessionNet(s).slice().sort((a, b) => b.fen - a.fen);
    const pays = L.settleUp(L.sessionNet(s));
    return `
      ${topbar(fmtDate(s.createdAt) + ' 战绩', backJs)}
      <div class="card">
        <div class="section-title">最终盈亏（${s.rounds.length} 局 · ${yuan(s.pricePerCardFen)}元/张）</div>
        ${net.map((p) => `<div class="row"><span>${esc(p.name)}</span>
          <span class="${cls(p.fen)}">${p.cards > 0 ? '+' : ''}${p.cards} 张 · ${signYuan(p.fen)} 元</span></div>`).join('')}
      </div>
      <div class="card">
        <div class="section-title">💸 转账方案（最少笔数）</div>
        ${pays.map((t) => `<div class="row"><span>${esc(t.from)} 转给 ${esc(t.to)}</span><span class="pos">${yuan(t.fen)} 元</span></div>`).join('')
          || '<div class="muted">全部打平，无需转账</div>'}
      </div>
      <button class="btn btn-primary" onclick="App.shareImage('${s.id}')">📤 分享战绩图</button>
      <div class="gap"></div>
      <button class="btn" onclick="App.copyText('${s.id}')">📋 复制战绩文字</button>
      <div class="gap"></div>
      <button class="btn" onclick="App.goRounds('${s.id}','${view.from}')">查看每局明细</button>`;
  };

  // ---------- 只读局明细 ----------
  VIEWS.rounds = () => {
    const s = db.sessions.find((x) => x.id === view.sid);
    return `
      ${topbar('每局明细', `App.goSettle('${view.sid}','${view.from}')`)}
      <div class="card">${s.rounds.map((r, i) => roundRow(s, r, i, true)).join('')
        || '<div class="muted">本场没有记录任何一局</div>'}</div>`;
  };

  // ---------- 历史记录 ----------
  VIEWS.history = () => {
    const list = db.sessions.filter((s) => s.status === 'finished')
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
    return `
      ${topbar('历史记录', 'App.goHome()')}
      <div class="card">
        ${list.map((s) => `<div class="row" onclick="App.goSettle('${s.id}','history')" style="cursor:pointer">
          <div><b>${fmtDate(s.createdAt)}</b><div class="muted">${s.players.map(esc).join('、')}</div></div>
          <span class="muted">${s.rounds.length} 局 ›</span>
        </div>`).join('') || '<div class="muted">还没有打完的场</div>'}
      </div>`;
  };
```

- [ ] **Step 2: 新增 `copyToClipboard` 帮助函数（放在 `topbar` 定义之后）**

```js
  async function copyToClipboard(text) {
    try { await navigator.clipboard.writeText(text); return true; }
    catch (e) {
      const ta = document.createElement('textarea');
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      return ok;
    }
  }
```

- [ ] **Step 3: 替换 `finishSession` 占位并新增 App 方法**

```js
    finishSession() {
      const s = activeSession();
      if (!s.rounds.length) { alert('还没记过任何一局，不能结束'); return; }
      if (!confirm('结束后不能再记新局，确定结束本场吗？')) return;
      s.status = 'finished';
      s.finishedAt = new Date().toISOString();
      saveDB();
      App.goSettle(s.id, 'home');
    },

    goSettle: (sid, from) => go({ name: 'settle', sid, from: from || 'home' }),
    goRounds: (sid, from) => go({ name: 'rounds', sid, from: from || 'home' }),

    async copyText(sid) {
      const s = db.sessions.find((x) => x.id === sid);
      const ok = await copyToClipboard(L.summaryText(s));
      alert(ok ? '已复制，去粘贴发给牌友吧' : '复制失败，请改用「分享战绩图」或截图');
    },

    shareImage() { alert('分享战绩图即将上线'); }, // Task 9 接线
```

- [ ] **Step 4: 浏览器验证**

1. 在有 1 局记录的场里点"结束本场"→ 确认 → 进入战绩页：张三 +26 元，转账方案 3 笔（李四 4、王五 2、戴六 20，钱七不出现）。
2. "复制战绩文字"提示已复制，粘贴出的文本含标题、盈亏、转账三段。
3. "查看每局明细"能看到只读的局列表（无改/删按钮），返回回到战绩页。
4. 回首页 →"历史记录"里出现这场，点进去还是同样的战绩页（返回键回到历史列表）。
5. 首页重新变为"开新一场"（active 场已清）。

- [ ] **Step 5: 回归测试并提交**

Run: `node --test test/`
Expected: 全绿

```bash
git add src/app.js
git commit -m "feat: 结束本场、结算页、历史记录与复制战绩"
```

---

### Task 8: 导出/导入 JSON 备份

**Files:**
- Modify: `src/app.js`

**Interfaces:**
- Consumes: `db`、`saveDB`、`go`、`fmtDate`。
- Produces: `App.exportData/importData` 完整实现（替换 Task 4 占位）。

- [ ] **Step 1: 替换两个占位方法**

```js
    exportData() {
      const blob = new Blob([JSON.stringify(db, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'runfast-backup-' + fmtDate(new Date().toISOString()) + '.json';
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    },

    importData() {
      const inp = document.createElement('input');
      inp.type = 'file';
      inp.accept = '.json,application/json';
      inp.onchange = () => {
        const f = inp.files[0];
        if (!f) return;
        const r = new FileReader();
        r.onload = () => {
          try {
            const data = JSON.parse(r.result);
            if (data.version !== 1 || !Array.isArray(data.sessions) || !Array.isArray(data.playerDirectory)) {
              throw new Error('bad format');
            }
            if (!confirm('导入将覆盖本手机上现有的全部记分数据，确定？')) return;
            db = data;
            saveDB();
            go({ name: 'home' });
            alert('导入成功');
          } catch (e) { alert('文件格式不对，导入失败'); }
        };
        r.readAsText(f);
      };
      inp.click();
    },
```

注意：`db` 在 Task 4 中必须是 `let` 声明（已是），否则这里无法重新赋值。

- [ ] **Step 2: 浏览器验证**

1. 首页点"导出备份"，下载得到 `runfast-backup-<日期>.json`，内容为完整 db。
2. 打开浏览器控制台执行 `localStorage.removeItem('runfast.v1')` 后刷新——数据清空。
3. 点"导入备份"选刚才的文件 → 确认 → 历史记录恢复。
4. 导入一个随意的文本文件 → 提示"文件格式不对"。

- [ ] **Step 3: 回归测试并提交**

Run: `node --test test/`
Expected: 全绿

```bash
git add src/app.js
git commit -m "feat: 数据导出导入备份"
```

---

### Task 9: 战绩图绘制与系统分享（Web Share API + 降级）

**Files:**
- Modify: `src/share-card.js`（整体替换占位）
- Modify: `src/app.js`（`App.shareImage` 接线）

**Interfaces:**
- Consumes: `L.sessionNet/settleUp/fenToYuan`、样式类 `overlay btn btn-sm`。
- Produces: `RunfastShare.share(session, L)`（async）、`RunfastShare.drawCard(session, L)->canvas`。

- [ ] **Step 1: 整体替换 `src/share-card.js`**

```js
// 战绩图 Canvas 绘制 + 分享：navigator.share(files) -> 长按保存降级 -> 桌面下载
var RunfastShare = (function () {
  'use strict';

  const W = 640, PAD = 40, LINE_H = 58;

  function drawCard(session, L) {
    const net = L.sessionNet(session).slice().sort((a, b) => b.fen - a.fen);
    const pays = L.settleUp(L.sessionNet(session));
    const d = new Date(session.createdAt);
    const dateStr = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');

    const headH = 170;
    const netH = 54 + net.length * LINE_H;
    const payH = pays.length ? 54 + pays.length * LINE_H : 0;
    const footH = 80;
    const H = headH + netH + payH + footH;

    const scale = Math.min(3, Math.max(2, window.devicePixelRatio || 2));
    const cv = document.createElement('canvas');
    cv.width = W * scale;
    cv.height = H * scale;
    const ctx = cv.getContext('2d');
    ctx.scale(scale, scale);

    const font = (w, s) => { ctx.font = w + ' ' + s + 'px -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif'; };

    // 牌桌绿背景
    const bg = ctx.createLinearGradient(0, 0, 0, H);
    bg.addColorStop(0, '#14532d');
    bg.addColorStop(1, '#0c3b20');
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, W, H);

    // 标题区
    ctx.textAlign = 'center';
    ctx.fillStyle = '#ffffff';
    font(700, 36);
    ctx.fillText('🃏 跑得快战绩', W / 2, 72);
    ctx.fillStyle = 'rgba(255,255,255,.65)';
    font(400, 24);
    ctx.fillText(dateStr + ' · 共 ' + session.rounds.length + ' 局 · ' + L.fenToYuan(session.pricePerCardFen) + '元/张', W / 2, 116);
    ctx.strokeStyle = 'rgba(255,255,255,.25)';
    ctx.beginPath(); ctx.moveTo(PAD, 150); ctx.lineTo(W - PAD, 150); ctx.stroke();

    // 盈亏区
    let y = headH + 30;
    ctx.textAlign = 'left';
    ctx.fillStyle = 'rgba(255,255,255,.55)';
    font(600, 22);
    ctx.fillText('盈 亏', PAD, y);
    y += 16;
    net.forEach((p) => {
      y += LINE_H;
      ctx.fillStyle = '#ffffff';
      font(600, 28);
      ctx.textAlign = 'left';
      ctx.fillText(p.name, PAD, y);
      ctx.textAlign = 'right';
      ctx.fillStyle = p.fen > 0 ? '#fbbf24' : p.fen < 0 ? '#86efac' : 'rgba(255,255,255,.6)';
      font(700, 28);
      ctx.fillText((p.fen > 0 ? '+' : '') + L.fenToYuan(p.fen) + ' 元', W - PAD, y);
    });

    // 转账区
    if (pays.length) {
      y += 60;
      ctx.textAlign = 'left';
      ctx.fillStyle = 'rgba(255,255,255,.55)';
      font(600, 22);
      ctx.fillText('转 账', PAD, y);
      y += 16;
      pays.forEach((t) => {
        y += LINE_H;
        ctx.fillStyle = '#ffffff';
        font(400, 26);
        ctx.textAlign = 'left';
        ctx.fillText(t.from + ' → ' + t.to, PAD, y);
        ctx.textAlign = 'right';
        ctx.fillStyle = '#fbbf24';
        font(700, 26);
        ctx.fillText(L.fenToYuan(t.fen) + ' 元', W - PAD, y);
      });
    }

    // 页脚
    ctx.textAlign = 'center';
    ctx.fillStyle = 'rgba(255,255,255,.35)';
    font(400, 20);
    ctx.fillText('跑得快记分器', W / 2, H - 34);

    return cv;
  }

  const toBlob = (cv) => new Promise((res) => cv.toBlob(res, 'image/png'));

  async function share(session, L) {
    const cv = drawCard(session, L);
    const blob = await toBlob(cv);
    if (!blob) { alert('生成图片失败，请截图代替'); return; }
    const file = new File([blob], '跑得快战绩.png', { type: 'image/png' });
    // 1) 系统分享面板（iOS Safari 15+ / Android Chrome）
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      try { await navigator.share({ files: [file], title: '跑得快战绩' }); return; }
      catch (e) { if (e.name === 'AbortError') return; /* 其余错误走降级 */ }
    }
    fallback(blob);
  }

  // 2) 手机降级：预览 + 长按保存；3) 桌面降级：直接下载
  function fallback(blob) {
    const url = URL.createObjectURL(blob);
    if (!('ontouchstart' in window)) {
      const a = document.createElement('a');
      a.href = url;
      a.download = '跑得快战绩.png';
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 60000);
      return;
    }
    const ov = document.createElement('div');
    ov.className = 'overlay';
    ov.innerHTML =
      '<div style="text-align:center;max-width:100%">' +
      '<img src="' + url + '" style="max-width:100%;max-height:70vh;border-radius:12px" alt="战绩图">' +
      '<div style="color:#fff;margin-top:12px;font-size:15px">长按图片即可保存或转发</div>' +
      '<button class="btn btn-sm" style="margin-top:12px">关闭</button></div>';
    ov.addEventListener('click', (ev) => {
      if (ev.target === ov || ev.target.tagName === 'BUTTON') {
        ov.remove();
        URL.revokeObjectURL(url);
      }
    });
    document.body.appendChild(ov);
  }

  const api = { share, drawCard };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  return api;
})();
```

- [ ] **Step 2: 接线 `App.shareImage`**

把 Task 7 的 `shareImage` 占位替换为：

```js
    shareImage(sid) {
      const s = db.sessions.find((x) => x.id === sid);
      RunfastShare.share(s, L);
    },
```

- [ ] **Step 3: 浏览器验证**

1. 桌面浏览器打开历史战绩页，点"分享战绩图"→ 直接下载 `跑得快战绩.png`；打开图片确认：绿色牌桌底、标题、日期局数单价、盈亏（赢家金色/输家浅绿）、转账、页脚，文字清晰不糊。
2. 用浏览器开发者工具切到移动端触屏模拟（或真机）再点 → 出现图片预览遮罩与"长按图片即可保存或转发"提示，点关闭可退出。
3. （真机 iOS/Android 若在手边）点分享 → 弹系统分享面板，取消不报错。

- [ ] **Step 4: 回归测试并提交**

Run: `node --test test/`
Expected: 全绿

```bash
git add src/share-card.js src/app.js
git commit -m "feat: Canvas 战绩图与系统分享（含长按/下载降级）"
```

---

### Task 10: 构建产物与端到端验证

**Files:**
- Modify: `dist/index.html`（由 build.js 重新生成）

**Interfaces:**
- Consumes: 全部前序任务。
- Produces: 可交付的最终 `dist/index.html`。

- [ ] **Step 1: 重新构建**

Run: `node build.js && node --test test/`
Expected: 生成 dist/index.html，测试全绿

- [ ] **Step 2: 用 dist/index.html 完整走一遍端到端**

打开 `dist/index.html`（注意是 dist 版，验证内联合并没破坏任何功能），移动端视口（375×812）依次执行：
1. 开新一场：添加并选中 张三/李四/王五/戴六，单价 1 元。
2. 记 2 局：第 1 局张三赢（李四 4、王五 2、戴六 10 全关）；第 2 局李四赢（张三 1、王五 3、戴六 5）。
3. 验证积分榜：张三 +25 元、李四 +5 元、王五 -5 元、戴六 -25 元。
4. 修改第 2 局王五为 2 张再改回 3 张，总分不变。
5. 结束本场 → 转账方案恰为两笔：戴六→张三 25 元、王五→李四 5 元。
6. 复制战绩文字、分享战绩图（下载/长按降级）各试一次。
7. 历史记录可查、导出导入可用。
8. 检查浏览器控制台全程无报错。

- [ ] **Step 3: 提交**

```bash
git add dist
git commit -m "build: 生成端到端验证过的单文件交付版"
```

---

### Task 11: 部署妙搭公网链接并交付

**Files:** 无新增（使用 `dist/index.html`）

**Interfaces:**
- Consumes: Task 10 的 `dist/index.html`。
- Produces: 公网可访问的 URL + 单文件交付说明。

- [ ] **Step 1: 部署**

调用 `lark-apps` 技能（Skill 工具），把 `dist/index.html` 部署到飞书妙搭，生成公网链接。按该技能内部流程操作。

- [ ] **Step 2: 线上验证**

用浏览器打开生成的公网 URL：首页正常渲染、开一场记一局无报错（线上环境为 HTTPS，`navigator.share` 系统分享面板在真机上可用）。

- [ ] **Step 3: 交付说明**

向用户汇报：
1. 公网链接（发给牌友，浏览器打开即用，建议"添加到主屏幕"）。
2. 单文件路径 `dist/index.html`（可直接发文件给不方便开链接的朋友）。
3. 提醒：数据存在各自手机浏览器里，换手机前先用"导出备份"。

---

## Self-Review 结论

- **Spec 覆盖**：规则结算（Task 1/2）、首页/开场（4）、记分主页与记一局含全关（5）、改删局与玩家管理（6）、结束/结算/历史/复制（7）、备份（8）、战绩图分享（9）、单文件构建（3/10）、双交付（10/11）——设计文档 §2～§9 全部有对应任务。
- **占位符扫描**：Task 4/5/7 中的"即将上线"占位均在后续任务（6/7/8/9）中被明确替换，非计划漏洞。
- **类型一致性**：`round.losers[].{name,cardsLeft,shutout}`、`pricePerCardFen`、`sessionNet` 返回 `{name,cards,fen}`、`settleUp` 返回 `{from,to,fen}` 在各任务间一致；`RunfastShare.share(session, L)` 与 `App.shareImage` 接线签名一致。
