'use strict';
/**
 * 把 dist-web/ 同步进鸿蒙工程的 rawfile，供 ArkWeb 以 $rawfile('web/index.html') 加载。
 *
 *   node build/gen-web.js        # 先生成最新网页版
 *   node build/sync-harmony.js   # 再同步进 harmony/
 *
 * 和安卓版共用同一套前端：改一次 ui/，四端一个样。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'dist-web');
const DEST = path.join(ROOT, 'harmony', 'entry', 'src', 'main', 'resources', 'rawfile', 'web');

if (!fs.existsSync(path.join(SRC, 'index.html'))) {
  console.error('找不到 dist-web/index.html，先跑 node build/gen-web.js');
  process.exit(1);
}

/* 网页版里 Service Worker / manifest 在 rawfile 场景没用，带上反而多几 MB 噪音；
   dev 用的截图、二维码之类也不必塞进安装包。 */
const SKIP = new Set(['sw.js', 'manifest.webmanifest']);

fs.mkdirSync(DEST, { recursive: true });
let n = 0, bytes = 0;
for (const f of fs.readdirSync(SRC, { withFileTypes: true })) {
  if (!f.isFile() || SKIP.has(f.name)) continue;
  const src = path.join(SRC, f.name);
  fs.copyFileSync(src, path.join(DEST, f.name));
  n++; bytes += fs.statSync(src).size;
}

/* rawfile 里不需要旧的 sw 缓存
   （注意：这里不删文件，避免撞上环境的批量删除保护，只提示） */
console.log(`已同步 ${n} 个文件（${(bytes / 1048576).toFixed(1)}MB）→ harmony/entry/src/main/resources/rawfile/web/`);

/* 顺带把版本号写进鸿蒙的 app.json5：桌面/安卓/网页/鸿蒙共用一个版本线，
   不然安装包里显示的号会和 README、Release 标签对不上。 */
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const [maj, min, pat] = pkg.version.split('.').map(x => parseInt(x, 10) || 0);
const code = maj * 10000 + min * 100 + pat;
const appJsonPath = path.join(ROOT, 'harmony', 'AppScope', 'app.json5');
if (fs.existsSync(appJsonPath)) {
  let s = fs.readFileSync(appJsonPath, 'utf8');
  s = s.replace(/"versionCode"\s*:\s*\d+/, `"versionCode": ${code}`);
  s = s.replace(/"versionName"\s*:\s*"[^"]*"/, `"versionName": "${pkg.version}"`);
  fs.writeFileSync(appJsonPath, s);
  console.log(`鸿蒙版本号 → ${pkg.version}（${code}）`);
}

console.log('接下来：node build/build-hap.js 出包；或 DevEco Studio 打开 harmony/ 自动签名运行到真机');
