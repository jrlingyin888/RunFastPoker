// 跑得快结算纯函数。金额一律以"分"（整数）计算。
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

  // 整场累计净额。包含 session.players 中所有人（未参局者为 0），顺序同 players。
  function sessionNet(session) {
    const net = Object.create(null);
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

  const api = { HAND_SIZE, yuanToFen, fenToYuan, countedCards, roundTransfers, sessionNet, settleUp, summaryText };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  return api;
})();
