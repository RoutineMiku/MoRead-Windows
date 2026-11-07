#!/usr/bin/env node
/* 版本号统一入口
 * ---------------------------------------------------------------
 * 之前版本号散在四个地方，各写各的：
 *   package.json            → Electron 的 app.getVersion()（Windows 端界面显示）
 *   android/.../build.gradle.kts → BuildConfig.VERSION_NAME（安卓界面显示 + 安装包覆盖升级）
 *   web/bridge-web.js       → 网页版 env.info.version
 *   README.md               → 下载区的发布标签
 * 于是出现了 2.0.0 / 2.2.2 / 0.4.1 / v0.4.6 四个不同的号。
 *
 * 这里以 package.json 为唯一来源，一条命令同步全部产物。
 *
 * 用法：
 *   node build/version.js                 # 只看当前版本
 *   node build/version.js 0.5.0           # 设成指定版本
 *   node build/version.js --bump patch    # 0.5.0 → 0.5.1
 *   node build/version.js --bump minor    # 0.5.0 → 0.6.0
 *   node build/version.js --bump major    # 0.5.0 → 1.0.0
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const PKG = path.join(ROOT, 'package.json');
const GRADLE = path.join(ROOT, 'android', 'app', 'build.gradle.kts');
const BRIDGE_WEB = path.join(ROOT, 'web', 'bridge-web.js');
const README = path.join(ROOT, 'README.md');

const read = p => fs.readFileSync(p, 'utf8');
const write = (p, s) => fs.writeFileSync(p, s);

function parse(v) {
  const m = String(v).trim().replace(/^v/, '').match(/^(\d+)\.(\d+)\.(\d+)$/);
  if (!m) throw new Error('版本号要写成 主.次.修订，例如 0.5.0，收到：' + v);
  return { major: +m[1], minor: +m[2], patch: +m[3] };
}

/* versionCode 要单调递增，安卓才允许覆盖安装：
   0.5.0 → 500，0.5.1 → 501，0.6.0 → 600 */
const codeOf = v => parse(v).major * 10000 + parse(v).minor * 100 + parse(v).patch;

function bump(cur, kind) {
  const p = parse(cur);
  if (kind === 'major') return `${p.major + 1}.0.0`;
  if (kind === 'minor') return `${p.major}.${p.minor + 1}.0`;
  return `${p.major}.${p.minor}.${p.patch + 1}`;
}

const pkg = JSON.parse(read(PKG));
const arg = process.argv[2];
const bumpKind = arg === '--bump' ? (process.argv[3] || 'patch') : null;

if (!arg) {
  console.log('当前版本 ' + pkg.version + '（versionCode ' + codeOf(pkg.version) + '）');
  process.exit(0);
}

const next = bumpKind ? bump(pkg.version, bumpKind) : String(arg).replace(/^v/, '');
parse(next);
const code = codeOf(next);
const changed = [];

/* 1. package.json —— Electron 与网页构建的缓存版本都读这里 */
if (pkg.version !== next) {
  const raw = read(PKG);
  write(PKG, raw.replace(/("version"\s*:\s*")[^"]*(")/, `$1${next}$2`));
  changed.push('package.json');
}

/* 2. 安卓：versionName + versionCode（versionCode 只能加不能减） */
let gradle = read(GRADLE);
const oldName = (gradle.match(/versionName\s*=\s*"([^"]*)"/) || [])[1];
const oldCode = Number((gradle.match(/versionCode\s*=\s*(\d+)/) || [])[1] || 0);
const newCode = Math.max(code, oldCode + 1);
if (oldName !== next || oldCode !== newCode) {
  gradle = gradle
    .replace(/(versionCode\s*=\s*)\d+/, `$1${newCode}`)
    .replace(/(versionName\s*=\s*")[^"]*(")/, `$1${next}$2`);
  write(GRADLE, gradle);
  changed.push(`android build.gradle.kts（${oldName}/${oldCode} → ${next}/${newCode}）`);
}

/* 3. 网页版 env.info */
let bridge = read(BRIDGE_WEB);
const oldWeb = (bridge.match(/platform:\s*'web',\s*version:\s*'([^']*)'/) || [])[1];
if (oldWeb !== next) {
  bridge = bridge
    .replace(/(platform:\s*'web',\s*version:\s*')[^']*(')/, `$1${next}$2`)
    .replace(/(platform:\s*'web',\s*version:\s*'[^']*',\s*code:\s*)\d+/, `$1${newCode}`);
  write(BRIDGE_WEB, bridge);
  changed.push(`web/bridge-web.js（${oldWeb} → ${next}）`);
}

/* 4. README 下载区：发布标签跟着版本走 */
let readme = read(README);
const before = readme;
readme = readme
  .replace(/(releases\/download\/v)[\d.]+(-android\/)/, `$1${next}$2`)
  .replace(/(\)（v)[\d.]+(），直接安装)/, `$1${next}$2`);
if (readme !== before) { write(README, readme); changed.push('README.md 下载区'); }

console.log('版本 ' + pkg.version + ' → ' + next + '（versionCode ' + newCode + '）');
console.log(changed.length ? '已更新：\n  - ' + changed.join('\n  - ') : '所有位置已是该版本，无需改动');
console.log('\n别忘了重新出包：npm run web / node build/android-build.js / npm run pack');
