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

  // 顶栏。title 一律过 esc()：现有调用点传的都是字面量或数字派生串，但标题是最容易
  // 「顺手把房号/名字拼进去」的位置，这个分支已经为「用户数据进 HTML」栽过两次，不留这个形状。
  // ⚠️ backJs / actionsHtml 是当 JS 源码 / HTML 片段用的，esc() 在这两个位置不起作用：
  //    只能传硬编码字面量，任何外部可控数据（玩家名、pid、房号…）都必须走 data-* + 事件委托。
  const topbar = (title, backJs, actionsHtml) =>
    `<div class="topbar${actionsHtml ? ' has-actions' : ''}">${backJs ? `<button class="back" onclick="${backJs}">‹ 返回</button>` : ''}<div class="title">${esc(title)}</div>${actionsHtml ? `<span class="actions">${actionsHtml}</span>` : ''}</div>`;

  // 底部弹出面板。挂在 body 上而不是 #app 里，这样房间广播频繁重绘 #app 时面板不会被抖掉。
  // ⚠️ items[].onclick 同 topbar 的 backJs：当 JS 源码用，只能传硬编码字面量。
  // items 支持 onclick（静态、不带用户数据的按钮用）或 data（{key: value}，渲染成 data-key="esc(value)"，
  // 配合调用方自己装的事件委托读取——带「玩家」这类外部数据的按钮一律走 data，不拼进内联 onclick 的
  // JS 字符串：那是 esc() 管不到的上下文，属性值上的 esc() 才是真正安全的。
  function closeSheet() { const el = document.getElementById('sheet'); if (el) el.remove(); }
  function openSheet(items, headerHtml) {
    closeSheet();
    const el = document.createElement('div');
    el.id = 'sheet';
    el.className = 'sheet-mask';
    el.innerHTML = `<div class="sheet">
      ${headerHtml || ''}
      ${items.map((it) => `<button class="sheet-item${it.danger ? ' danger' : ''}"${
        it.onclick ? ` onclick="${it.onclick}"` : ''}${
        it.data ? Object.keys(it.data).map((k) => ` data-${k}="${esc(it.data[k])}"`).join('') : ''
      }>${esc(it.label)}</button>`).join('')}
      <button class="sheet-item cancel">取消</button>
    </div>`;
    // 按钮的内联 onclick（或调用方装的 data-* 委托）先在目标上执行，这个委托监听随后关闭面板
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
