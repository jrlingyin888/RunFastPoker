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
