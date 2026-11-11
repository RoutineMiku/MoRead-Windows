'use strict';
/**
 * 把 ui/ 的前端资源同步到安卓 assets，并补上安卓专属的 bridge.js 引用。
 *
 * 为什么要单独一步：ui/index.html 是桌面/网页共用的，里面没有 <script src="bridge.js">；
 * 安卓版的 bridge.js 由 MainActivity.shouldInterceptRequest 接管（返回 nodebundle.js），
 * 必须有这一行才会加载 Node 兼容层。直接 cp 会把安卓版弄成「window.mo 不存在」——
 * 页面能画出来但所有功能都没反应。所以构建前统一走这里。
 */
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const src = path.join(root, 'ui');
const dst = path.join(root, 'android', 'app', 'src', 'main', 'assets', 'ui');

fs.mkdirSync(dst, { recursive: true });
for (const f of ['app.js', 'style.css', 'detect.js', 'engine.js', 'index.html', 'gzh-qr.jpg', 'douyin-qr.png', 'logo.png']) {
  fs.copyFileSync(path.join(src, f), path.join(dst, f));
}

const p = path.join(dst, 'index.html');
let html = fs.readFileSync(p, 'utf8');
if (!/src="bridge\.js"/.test(html)) {
  if (!html.includes('<script src="engine.js"></script>')) {
    throw new Error('index.html 里找不到 engine.js 的引用，没法自动补 bridge.js');
  }
  html = html.replace('<script src="engine.js"></script>',
    '<script src="bridge.js"></script>\n<script src="engine.js"></script>');
  fs.writeFileSync(p, html, 'utf8');
}

console.log('已同步安卓前端资源 → android/app/src/main/assets/ui/（含 bridge.js 引用）');
