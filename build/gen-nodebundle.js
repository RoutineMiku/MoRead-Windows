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
fs.mkdirSync(destDir, { recursive: true });
fs.writeFileSync(path.join(destDir, 'nodebundle.js'), out, 'utf8');

console.log('已生成 nodebundle.js  ' + (out.length / 1024).toFixed(1) + ' KB  模块: ' + MODULES.join(', '));
