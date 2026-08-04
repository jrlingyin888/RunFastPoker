// 与业务无关的展示工具：转义、顶栏、底部弹出面板、剪贴板、头像取色。
// 浏览器：全局 RunfastUI；Node：module.exports（供测试）。
var RunfastUI = (function () {
  'use strict';

  const esc = (s) => String(s).replace(/[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const validName = (s) => /^[^'"<>\\]{1,8}$/.test(s);

  // 没有真实头像，用名字首字 + 一个稳定色块代替。
  // 同一个名字在每台设备上算出同一个颜色，牌友之间看到的头像才是一致的。
  const AVATAR_BG = ['#1b6b3a', '#b45309', '#1d4ed8', '#7c3aed', '#be123c', '#0f766e', '#a16207', '#4338ca'];
  function avatarColor(name) {
    let h = 0;
    const s = String(name);
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
    return AVATAR_BG[h % AVATAR_BG.length];
  }
  // 按码点取首字，否则 emoji 名字会被劈成半个字符渲染成乱码
  const initial = (name) => Array.from(String(name))[0] || '?';

  const topbar = (title, backJs, actionsHtml) =>
    `<div class="topbar${actionsHtml ? ' has-actions' : ''}">${backJs ? `<button class="back" onclick="${backJs}">‹ 返回</button>` : ''}<div class="title">${title}</div>${actionsHtml ? `<span class="actions">${actionsHtml}</span>` : ''}</div>`;

  // 底部弹出面板。挂在 body 上而不是 #app 里，这样房间广播频繁重绘 #app 时面板不会被抖掉。
  function closeSheet() { const el = document.getElementById('sheet'); if (el) el.remove(); }
  function openSheet(items, headerHtml) {
    closeSheet();
    const el = document.createElement('div');
    el.id = 'sheet';
    el.className = 'sheet-mask';
    el.innerHTML = `<div class="sheet">
      ${headerHtml || ''}
      ${items.map((it) => `<button class="sheet-item${it.danger ? ' danger' : ''}" onclick="${it.onclick}">${esc(it.label)}</button>`).join('')}
      <button class="sheet-item cancel">取消</button>
    </div>`;
    // 按钮的内联 onclick 先在目标上执行，这个委托监听随后关闭面板
    el.addEventListener('click', (ev) => {
      if (ev.target === el || ev.target.classList.contains('sheet-item')) closeSheet();
    });
    document.body.appendChild(el);
  }

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

  const api = { esc, validName, avatarColor, initial, topbar, openSheet, closeSheet, copyToClipboard };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  return api;
})();
