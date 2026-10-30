'use strict';
/**
 * 把 runtime.js（Node 兼容层 + mo 桥接）和桌面版 src/*.js 打成一个 bundle，
 * 输出到 android/app/src/main/assets/nodebundle.js，供 WebView 里 <script src="bridge.js"> 拦截加载。
 *
 * 这样 src/ 下那份已在真实备份上验证过的数据/网络/格式逻辑，桌面版和安卓版共用同一份源码。
 */
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const MODULES = ['zip', 'net', 'webdav', 'legado', 'parse', 'store'];

const mods = {};
for (const m of MODULES) {
  const f = path.join(root, 'src', m + '.js');
  if (!fs.existsSync(f)) throw new Error('缺少模块源文件: ' + f);
  mods[m] = fs.readFileSync(f, 'utf8');
}

const runtime = fs.readFileSync(path.join(root, 'android', 'nodepoly', 'runtime.js'), 'utf8');

// 序列化后如果含有 </script 会截断 <script> 标签内容，做一次无害转义
const payload = JSON.stringify(mods).replace(/<\/(script)/gi, '<\\/$1');
const modeps = Object.keys(mods).join(' ');

const out =
  '// 墨读安卓版 Node 兼容层（由 build/gen-nodebundle.js 自动生成，勿手改）\n' +
  '// 内联模块：' + modeps + '\n' +
  '(function(){window.__MOREAD_MODULES__ = ' + payload + ';})();\n' +
  runtime + '\n';

const destDir = path.join(root, 'android', 'app', 'src', 'main', 'assets');
const uiDir = path.join(destDir, 'ui');
fs.mkdirSync(uiDir, { recursive: true });
fs.writeFileSync(path.join(destDir, 'nodebundle.js'), out, 'utf8');

// 关键：把 bundle 直接写成 assets/ui/bridge.js，而不是依赖 WebView 的请求拦截。
// 拦截（shouldInterceptRequest 把 bridge.js 换成 nodebundle.js）在部分 WebView 版本上对
// file:///android_asset/ 不触发，一旦不触发页面加载到的就是空脚本，整个 app.js 起不来。
// 现在它是个普通静态文件，加载路径和普通资源完全一致。
fs.writeFileSync(path.join(uiDir, 'bridge.js'), out, 'utf8');

console.log('已生成 nodebundle.js  ' + (out.length / 1024).toFixed(1) + ' KB  模块: ' + MODULES.join(', '));
console.log('已写入 assets/ui/bridge.js（同内容，作为 <script> 的直连入口）');
