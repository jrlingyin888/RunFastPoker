const test = require('node:test');
const assert = require('node:assert/strict');
const U = require('../src/ui.js');

test('esc：转义会撑破属性和标签的字符', () => {
  assert.equal(U.esc('<b>&"\'</b>'), '&lt;b&gt;&amp;&quot;&#39;&lt;/b&gt;');
  assert.equal(U.esc(123), '123');
});

test('validName：1~8 字且不含引号尖括号反斜杠', () => {
  assert.ok(U.validName('张三'));
  assert.ok(U.validName('12345678'));
  assert.ok(!U.validName(''));
  assert.ok(!U.validName('123456789'));
  assert.ok(!U.validName('a"b'));
  assert.ok(!U.validName("a'b"));
  assert.ok(!U.validName('a<b'));
  assert.ok(!U.validName('a\\b'));
});

test('topbar：title 过 esc；纯文字标题渲染结果不变', () => {
  // 现有调用点都是字面量或数字派生串：加了 esc 之后渲染结果必须一模一样
  assert.ok(U.topbar('历史记录', 'App.goHome()').includes('<div class="title">历史记录</div>'));
  assert.ok(U.topbar('已记 3 笔 · 0.5分/张').includes('<div class="title">已记 3 笔 · 0.5分/张</div>'));
  assert.ok(U.topbar('加入房间 314159').includes('<div class="title">加入房间 314159</div>'));
  // 万一将来有人把名字/房号拼进标题，撑不破标签
  assert.ok(U.topbar('<img src=x onerror=alert(1)>').includes('&lt;img src=x onerror=alert(1)&gt;'));
  // backJs / actionsHtml 保持原样（当 JS 源码 / HTML 片段用，只能传字面量）
  assert.ok(U.topbar('x', 'App.goHome()').includes('onclick="App.goHome()"'));
  assert.ok(U.topbar('x', '', '<button class="icon-btn">分享</button>').includes('<button class="icon-btn">分享</button>'));
});

test('avatarColor：同名同色、结果是合法十六进制色', () => {
  assert.equal(U.avatarColor('张三'), U.avatarColor('张三'));
  assert.match(U.avatarColor('张三'), /^#[0-9a-f]{6}$/);
  assert.match(U.avatarColor(''), /^#[0-9a-f]{6}$/);
});

test('initial：取第一个字符，emoji 不被劈成半个', () => {
  assert.equal(U.initial('张三'), '张');
  assert.equal(U.initial('Hua'), 'H');
  assert.equal(U.initial('🌹小丽'), '🌹');
  assert.equal(U.initial(''), '?');
});
