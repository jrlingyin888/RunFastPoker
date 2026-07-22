// 把 src 下的 css/js 内联进单个 dist/index.html（零依赖交付）
const fs = require('fs');
const path = require('path');
const read = (p) => fs.readFileSync(path.join(__dirname, 'src', p), 'utf8');

let html = read('index.html');
html = html.replace('<link rel="stylesheet" href="style.css">',
  () => '<style>\n' + read('style.css') + '\n</style>');
for (const js of ['logic.js', 'sync.js', 'share-card.js', 'app.js']) {
  html = html.replace(`<script src="${js}"></script>`,
    () => '<script>\n' + read(js) + '\n</script>');
}
if (/<link rel="stylesheet"|<script src=/.test(html)) {
  throw new Error('仍有未内联的外部引用，检查 index.html 与 build.js 的文件清单');
}
fs.mkdirSync(path.join(__dirname, 'dist'), { recursive: true });
fs.writeFileSync(path.join(__dirname, 'dist', 'index.html'), html);
console.log('已生成 dist/index.html（' + (html.length / 1024).toFixed(1) + ' KB）');
