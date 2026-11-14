'use strict';
/**
 * 生成网页版发行目录 dist-web/（可直接丢到 GitHub Pages / 任意静态托管）。
 *
 * 与安卓版共用同一份业务代码：
 *   ui/style.css + ui/app.js + ui/engine.js + ui/detect.js
 *   android/nodepoly/runtime.js（Node 兼容层）+ src/*.js（书源引擎 / 解析 / 备份 / WebDAV）
 * 差别只在「原生桥」：
 *   安卓 → MoBridge.kt（Kotlin）
 *   网页 → web/bridge-web.js（IndexedDB 虚拟文件系统 + fetch + speechSynthesis）
 *
 * 用法：node build/gen-web.js
 */
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const out = path.join(root, 'dist-web');
const MODULES = ['zip', 'net', 'webdav', 'legado', 'parse', 'store'];

function read(p) { return fs.readFileSync(path.join(root, p), 'utf8'); }
function copy(src, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(path.join(root, src), dest);
}

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });

/* ---- 1. 业务代码 ---- */
for (const f of ['style.css', 'app.js', 'engine.js', 'detect.js']) copy('ui/' + f, path.join(out, f));
copy('vendor/pako.min.js', path.join(out, 'pako.min.js'));
copy('web/bridge-web.js', path.join(out, 'bridge-web.js'));
copy('web/manifest.webmanifest', path.join(out, 'manifest.webmanifest'));
copy('web/icons/icon-192.png', path.join(out, 'icon-192.png'));
copy('web/icons/icon-512.png', path.join(out, 'icon-512.png'));
copy('web/icons/icon-180.png', path.join(out, 'icon-180.png'));
copy('ui/gzh-qr.jpg', path.join(out, 'gzh-qr.jpg'));
copy('ui/douyin-qr.png', path.join(out, 'douyin-qr.png'));
copy('ui/logo.png', path.join(out, 'logo.png'));
/* 下载落地页：公众号 / 抖音图文里的二维码扫到这里，按设备选安装包 */
copy('web/download.html', path.join(out, 'download.html'));
copy('web/privacy.html', path.join(out, 'privacy.html'));

/* ---- 2. bridge.js：Node 兼容层 + src 模块（与安卓同一份 runtime） ---- */
const mods = {};
for (const m of MODULES) mods[m] = read('src/' + m + '.js');
const runtime = read('android/nodepoly/runtime.js');
const payload = JSON.stringify(mods).replace(/<\/(script)/gi, '<\\/$1');
const bundle = '// 墨读网页版 Node 兼容层（由 build/gen-web.js 生成，勿手改）\n'
  + '// 内联模块：' + Object.keys(mods).join(' ') + '\n'
  + '(function(){window.__MOREAD_MODULES__ = ' + payload + ';})();\n'
  + runtime + '\n';
fs.writeFileSync(path.join(out, 'bridge.js'), bundle, 'utf8');

/* ---- 3. sw.js：注入缓存版本（每次构建自动作废旧缓存） ---- */
const pkg = JSON.parse(read('package.json'));
const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '');
const cacheVer = 'moread-web-' + (pkg.version || '1') + '-' + stamp;
fs.writeFileSync(
  path.join(out, 'sw.js'),
  read('web/sw.js').replace('__CACHE_VERSION__', cacheVer),
  'utf8'
);

/* ---- 4. index.html：在桌面版页面上加 PWA 头与脚本装载顺序 ---- */
let html = read('ui/index.html');

const headExtra = `
<meta name="theme-color" content="#eef0f4" />
<meta name="apple-mobile-web-app-capable" content="yes" />
<meta name="mobile-web-app-capable" content="yes" />
<meta name="apple-mobile-web-app-status-bar-style" content="default" />
<meta name="apple-mobile-web-app-title" content="墨读" />
<meta name="format-detection" content="telephone=no" />
<link rel="manifest" href="manifest.webmanifest" />
<link rel="apple-touch-icon" href="icon-180.png" />
<link rel="icon" type="image/png" href="icon-192.png" />`;
html = html.replace('<link rel="stylesheet" href="style.css" />', '<link rel="stylesheet" href="style.css" />' + headExtra);

const loader = `
<script src="pako.min.js"></script>
<script src="bridge-web.js"></script>
<script>
/* 装载顺序（关键）：浏览器桥 → 等 IndexedDB 里的虚拟文件系统就绪 →
   Node 兼容层 bridge.js（它一执行就 store.init 读 data.json）→ 最后界面。
   顺序反了的话存档还没载入，store 会当成全新安装，书架永远是空的。 */
(function () {
  function load(src, next) {
    var s = document.createElement('script');
    s.src = src;
    if (next) s.onload = next;
    document.body.appendChild(s);
  }
  function start() {
    load('bridge.js', function () {
      load('engine.js', function () {
        load('detect.js', function () { load('app.js'); });
      });
    });
  }
  if (window.__bridgeReady && window.__bridgeReady.then) {
    window.__bridgeReady.then(start).catch(function (e) {
      console.error('存储初始化失败：', e);
      start();
    });
  } else start();

  if ('serviceWorker' in navigator && location.protocol.indexOf('http') === 0) {
    window.addEventListener('load', function () {
      navigator.serviceWorker.register('sw.js').catch(function (e) { console.warn('SW 注册失败', e); });
    });
  }
})();
</script>`;

html = html.replace(
  /<script src="engine\.js"><\/script>\s*<script src="detect\.js"><\/script>\s*<script src="app\.js"><\/script>/,
  loader.trim()
);
fs.writeFileSync(path.join(out, 'index.html'), html, 'utf8');

/* ---- 5. 自检 ---- */
const required = ['index.html', 'app.js', 'engine.js', 'detect.js', 'style.css', 'bridge.js', 'bridge-web.js',
  'pako.min.js', 'sw.js', 'manifest.webmanifest', 'icon-192.png', 'icon-512.png', 'icon-180.png'];
const missing = required.filter(f => !fs.existsSync(path.join(out, f)));
if (missing.length) throw new Error('缺少产物: ' + missing.join(', '));
const bridgeKb = (fs.statSync(path.join(out, 'bridge.js')).size / 1024).toFixed(0);
if (fs.statSync(path.join(out, 'bridge.js')).size < 20 * 1024) throw new Error('bridge.js 太小，兼容层没打进去');
if (html.indexOf('bridge-web.js') < 0) throw new Error('index.html 没有装载 bridge-web.js');
if (html.indexOf("load('bridge.js'") < 0) throw new Error('index.html 没有按顺序装载 bridge.js');

console.log('dist-web/ 就绪：' + required.length + ' 个文件，bridge.js ' + bridgeKb + 'KB，缓存版本 ' + cacheVer);
console.log('本地预览：node build/serve-web.js');
