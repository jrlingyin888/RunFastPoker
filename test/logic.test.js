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

test('sessionNet：玩家名与原型属性同名也能正确结算', () => {
  const s = {
    createdAt: '2026-07-22T20:00:00+08:00',
    pricePerCardFen: 100,
    players: ['toString', 'valueOf'],
    rounds: [
      { id: 'r1', winner: 'toString', losers: [{ name: 'valueOf', cardsLeft: 3, shutout: false }] },
    ],
  };
  assert.deepEqual(L.sessionNet(s), [
    { name: 'toString', cards: 3, fen: 300 },
    { name: 'valueOf', cards: -3, fen: -300 },
  ]);
});
