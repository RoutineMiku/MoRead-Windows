'use strict';
/**
 * 打包：直接用 node_modules 里的 Electron 运行时组装，不走 electron-packager 的下载/解压。
 *
 *   dist/墨读-win32-x64/
 *     墨读.exe              ← electron.exe 改名
 *     resources/app/        ← 本工程的 src / ui / package.json
 *     portable.txt / 使用说明.txt
 *   dist/墨读-win32-x64.zip
 *
 * 注意：先建英文目录再改中文名。某些环境下 Node 直接创建中文名目录会被写坏
 * （变成乱码目录），中文名统一交给 PowerShell 做 rename。
 *
 * 用法：node build/pack.js
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'dist');
const ASCII = 'moread-win32-x64';
const CN = '墨读-win32-x64';
const WORK = path.join(OUT, ASCII);
const FINAL = path.join(OUT, CN);
const RUNTIME = path.join(ROOT, 'node_modules', 'electron', 'dist');

const ps = script => execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], { stdio: 'pipe' })
  .toString().trim();

if (!fs.existsSync(RUNTIME)) {
  console.error('找不到 Electron 运行时：' + RUNTIME + '\n先执行 npm install');
  process.exit(1);
}
fs.mkdirSync(OUT, { recursive: true });

/* 0. 清掉旧产物（Node 原生，前提是无 NODE_OPTIONS 中文路径 shim，干净环境下 rename/rm 中文可靠） */
for (const p of [FINAL, FINAL + '.zip', WORK, WORK + '.zip']) {
  try { fs.rmSync(p, { recursive: true, force: true }); } catch (e) {}
}

/* 1. 复制运行时（英文目标路径，逐项复制更稳） */
console.log('运行时：' + RUNTIME);
fs.mkdirSync(WORK, { recursive: true });
for (const name of fs.readdirSync(RUNTIME)) {
  fs.cpSync(path.join(RUNTIME, name), path.join(WORK, name), { recursive: true });
}
const missing = fs.readdirSync(RUNTIME).filter(n => !fs.existsSync(path.join(WORK, n)));
if (missing.length) throw new Error('运行时复制不完整：' + missing.join(', '));

/* 2. exe 改名（先英文名，最后在中文目录里改成「墨读.exe」） */
const srcExe = path.join(WORK, 'electron.exe');
if (fs.existsSync(srcExe)) fs.renameSync(srcExe, path.join(WORK, 'moread.exe'));

/* 3. 应用代码 → resources/app */
const appDir = path.join(WORK, 'resources', 'app');
fs.rmSync(path.join(WORK, 'resources', 'default_app.asar'), { force: true });
fs.mkdirSync(appDir, { recursive: true });
fs.copyFileSync(path.join(ROOT, 'package.json'), path.join(appDir, 'package.json'));
for (const dir of ['src', 'ui']) {
  fs.cpSync(path.join(ROOT, dir), path.join(appDir, dir), { recursive: true });
  if (!fs.existsSync(path.join(appDir, dir))) throw new Error('复制失败：' + dir);
}
const iconDir = path.join(appDir, 'build');
fs.mkdirSync(iconDir, { recursive: true });
for (const f of ['icon.ico', 'tray.png']) {
  const p = path.join(ROOT, 'build', f);
  if (fs.existsSync(p)) fs.copyFileSync(p, path.join(iconDir, f));
}

/* 4. 收尾：语言包瘦身 / 便携标记 / 使用说明 / zip */
console.log('收尾…');
execFileSync(process.execPath, [path.join(__dirname, 'finish.js'), ASCII], { stdio: 'inherit' });

/* 5. 英文目录 → 中文名，exe 也改成中文名（Node 原生 rename，别走 PowerShell 命令行传中文） */
fs.renameSync(WORK, FINAL);
const exeA = path.join(FINAL, 'moread.exe');
if (fs.existsSync(exeA)) fs.renameSync(exeA, path.join(FINAL, '墨读.exe'));
if (!fs.existsSync(path.join(FINAL, '墨读.exe'))) throw new Error('exe 改名失败');

/* 6. 用中文目录名压 zip。中文路径不进命令行，写带 BOM 的 ps1 让 PowerShell 按文件读取 */
for (const f of [ASCII + '.zip', CN + '.zip']) {
  const p = path.join(OUT, f);
  try { fs.rmSync(p, { force: true }); } catch (e) {}
}
console.log('压缩 zip…');
const zipScript = path.join(OUT, '_pack-zip.ps1');
fs.writeFileSync(zipScript, '﻿' + [
  "$ErrorActionPreference = 'Stop'",
  `Compress-Archive -LiteralPath '${FINAL}' -DestinationPath '${path.join(OUT, CN + '.zip')}' -CompressionLevel Optimal`
].join('\r\n'), 'utf8');
try {
  execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', zipScript], { stdio: 'inherit' });
} finally {
  try { fs.rmSync(zipScript, { force: true }); } catch (e) {}
}

/* 目录体积（Node 递归，不走 PowerShell） */
let size = 0;
(function walk(p) {
  for (const f of fs.readdirSync(p, { withFileTypes: true })) {
    const q = path.join(p, f.name);
    if (f.isDirectory()) walk(q); else size += fs.statSync(q).size;
  }
})(FINAL);
size /= 1048576;
const zipSize = fs.existsSync(path.join(OUT, CN + '.zip')) ? fs.statSync(path.join(OUT, CN + '.zip')).size / 1048576 : 0;
console.log(`完成：dist/${CN}（${size.toFixed(0)}MB）、dist/${CN}.zip（${zipSize.toFixed(0)}MB）`);
