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
