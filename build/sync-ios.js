#!/usr/bin/env node
'use strict';
/**
 * 把 dist-web（网页版产物）同步进 iOS 工程：ios/MoRead/web/
 *
 * 三件事：
 *  1. 拷 dist-web/* → ios/MoRead/web/（整个目录作为「蓝色文件夹」进 .app，
 *     LocalServer 用 Bundle.main.url(forResource:"web") 取）
 *  2. bridge-web.js 里的 platform 由 'web' 改成 'ios' —— 关于页/设置页才会显示 iOS，
 *     界面语言也不再自称「网页版」
 *  3. 把版本号写进 project.pbxproj 与 project.yml（MARKETING_VERSION / CURRENT_PROJECT_VERSION）
 *
 * 用法：node build/gen-web.js && node build/sync-ios.js
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'dist-web');
const DST = path.join(ROOT, 'ios', 'MoRead', 'web');

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const ver = pkg.version;
const [maj, min, pat] = ver.split('.').map(n => parseInt(n, 10) || 0);
const code = maj * 10000 + min * 100 + pat;

if (!fs.existsSync(path.join(SRC, 'index.html'))) {
  console.error('找不到 dist-web/index.html，先跑：node build/gen-web.js');
  process.exit(1);
}

/* ---------- 1. 清空并复制 ---------- */
fs.mkdirSync(DST, { recursive: true });
let removed = 0;
for (const name of fs.readdirSync(DST)) {
  const p = path.join(DST, name);
  try { fs.rmSync(p, { recursive: true, force: true }); removed++; } catch (e) { }
}
let copied = 0;
for (const name of fs.readdirSync(SRC)) {
  const from = path.join(SRC, name);
  if (!fs.statSync(from).isFile()) continue;
  fs.copyFileSync(from, path.join(DST, name));
  copied++;
}

/* ---------- 2. platform: 'web' → 'ios' ---------- */
const bridge = path.join(DST, 'bridge-web.js');
let patched = false;
if (fs.existsSync(bridge)) {
  let s = fs.readFileSync(bridge, 'utf8');
  const before = s;
  s = s.replace(/platform:\s*'web'/, "platform: 'ios'");
  if (s !== before) { fs.writeFileSync(bridge, s); patched = true; }
}

/* ---------- 3. 版本号 ---------- */
const pbx = path.join(ROOT, 'ios', 'MoRead.xcodeproj', 'project.pbxproj');
let pbxOk = false;
if (fs.existsSync(pbx)) {
  let s = fs.readFileSync(pbx, 'utf8');
  s = s.replace(/MARKETING_VERSION = [^;]+;/g, `MARKETING_VERSION = ${ver};`);
  s = s.replace(/CURRENT_PROJECT_VERSION = [^;]+;/g, `CURRENT_PROJECT_VERSION = ${code};`);
  fs.writeFileSync(pbx, s);
  pbxOk = true;
}
const yml = path.join(ROOT, 'ios', 'project.yml');
if (fs.existsSync(yml)) {
  let s = fs.readFileSync(yml, 'utf8');
  s = s.replace(/MARKETING_VERSION: "[^"]*"/g, `MARKETING_VERSION: "${ver}"`);
  s = s.replace(/CURRENT_PROJECT_VERSION: "[^"]*"/g, `CURRENT_PROJECT_VERSION: "${code}"`);
  fs.writeFileSync(yml, s);
}

/* ---------- 4. 图标 ---------- */
const iconDst = path.join(ROOT, 'ios', 'MoRead', 'Assets.xcassets', 'AppIcon.appiconset', 'icon-1024.png');
if (!fs.existsSync(iconDst)) {
  const cand = path.join(ROOT, 'web', 'icons', 'icon-512.png');
  if (fs.existsSync(cand)) {
    fs.copyFileSync(cand, iconDst);
    console.log('  ⚠ 图标用了 512 图缩放前的原图，iOS 要求 1024×1024，请用高分辨率重出');
  }
}

console.log(`iOS 同步完成：${copied} 个文件 → ios/MoRead/web（清理 ${removed} 个旧文件）`);
console.log(`  版本 ${ver} / ${code} · platform=ios ${patched ? '已打补丁' : '补丁未命中（检查 bridge-web.js）'} · pbxproj ${pbxOk ? '已更新' : '缺失'}`);
