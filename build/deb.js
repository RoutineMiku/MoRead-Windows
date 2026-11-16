#!/usr/bin/env node
/* build/deb.js —— 把 dist 里的 Linux tar.gz 打成 UOS/deepin 商店规范的 .deb
 *
 * 为什么自己写：本机是 Windows，没有 dpkg-deb。deb 其实就是 ar 归档包着
 * debian-binary + control.tar.gz + data.tar.gz 三个文件，ar 头和 tar 都能
 * 用 Node / Git-Bash tar 实现，不依赖任何 Linux 工具。
 *
 * 目录规范（统信 UOS / deepin 应用商店强制）：
 *   /opt/apps/${APPID}/entries/applications/${APPID}.desktop
 *   /opt/apps/${APPID}/entries/icons/hicolor/${size}x${size}/apps/${APPID}.png
 *   /opt/apps/${APPID}/files/...            应用本体
 *   /opt/apps/${APPID}/info                 JSON：appid/name/version/arch/permissions
 *
 * 用法：node build/deb.js [--arch x64|arm64|both]  （默认 both，读 dist 里现成的 tar.gz）
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const DIST = path.join(ROOT, 'dist');
const APPID = 'cn.moread.app';            // 与安卓 applicationId 一致，全平台唯一标识
const APP_NAME_CN = '墨读';
const APP_NAME_EN = 'MoRead';
const SUMMARY = '本地优先的开源阅读器（EPUB / TXT / Legado 书源）';

const pkg = require(path.join(ROOT, 'package.json'));
const VERSION = pkg.version;               // 0.6.13
const DEB_VER = VERSION.replace(/-/g, '');

/* Electron 运行时依赖（Ubuntu/UOS 通用）；chrome-sandbox 被排除，用 --no-sandbox 启动 */
const DEPENDS = 'libgtk-3-0, libnotify4, libnss3, libxss1, libxtst6, xdg-utils, libatspi2.0-0, libuuid1, libsecret-1-0';

/* GNU tar 会把 "C:" 当成远程主机，且反斜杠会被当转义符——
 * Windows 路径必须 --force-local 且统一转成正斜杠 */
const P = p => String(p).replace(/\\/g, '/');
function tar() { return process.env.TAR || 'tar'; }
function tarRun(args, opts) {
  return execFileSync(tar(), ['--force-local', ...args.map(P)], { stdio: 'inherit', ...opts });
}

function archOf(name) { return name === 'arm64' ? 'arm64' : 'amd64'; }

/* ---------- ar 归档（deb 外壳） ---------- */
function arAdd(parts, name, data) {
  // ar 头：name(16) date(12) uid(6) gid(6) mode(8) size(10) 魔数(2)
  const header = Buffer.from(
    name.padEnd(16) + '0'.padEnd(12) + '0'.padEnd(6) + '0'.padEnd(6) +
    '100644'.padEnd(8) + String(data.length).padEnd(10) + '\x60\x0a', 'binary');
  parts.push(header, data);
  if (data.length % 2) parts.push(Buffer.from('\n', 'binary')); // 偶数对齐
}

function buildAr(files /* [{name, data}] */) {
  const parts = [Buffer.from('!<arch>\n', 'binary')];
  for (const f of files) arAdd(parts, f.name, f.data);
  return Buffer.concat(parts);
}

/* ---------- tar.gz 成员 ---------- */
function tarGz(members, cwd, name) {
  /* 输出必须放在被归档目录之外，否则 tar 报 "file changed as we read it"；
   * members 是相对 cwd 的成员列表（data 只归档 opt，别把 _control 打进去） */
  const out = path.join(os.tmpdir(), `deb-part-${name}-${process.pid}.tar.gz`);
  tarRun(['-czf', out, '-C', cwd, ...members]);
  const buf = fs.readFileSync(out);
  fs.rmSync(out, { force: true });
  return buf;
}

/* ---------- 主流程 ---------- */
function buildOne(archName) {
  const debArch = archOf(archName);
  const srcTgz = path.join(DIST, `MoRead-linux-${archName}-${VERSION}.tar.gz`);
  if (!fs.existsSync(srcTgz)) {
    console.error(`跳过 ${archName}：找不到 ${path.basename(srcTgz)}`);
    return null;
  }
  const stage = path.join(DIST, `_deb-${archName}-${Date.now()}`);
  const appRoot = path.join(stage, 'opt', 'apps', APPID);
  const filesDir = path.join(appRoot, 'files');
  fs.mkdirSync(filesDir, { recursive: true });

  console.log(`[${archName}] 解包 ${path.basename(srcTgz)} …`);
  tarRun(['-xzf', srcTgz, '-C', filesDir, '--strip-components=1']);

  /* entries：desktop + 图标（UOS 规范要求 appid 命名） */
  const entriesApp = path.join(appRoot, 'entries', 'applications');
  const entriesIcon = path.join(appRoot, 'entries', 'icons', 'hicolor', '512x512', 'apps');
  fs.mkdirSync(entriesApp, { recursive: true });
  fs.mkdirSync(entriesIcon, { recursive: true });
  fs.copyFileSync(path.join(filesDir, 'moread.png'), path.join(entriesIcon, `${APPID}.png`));
  fs.writeFileSync(path.join(entriesApp, `${APPID}.desktop`),
`[Desktop Entry]
Type=Application
Name=${APP_NAME_CN}
Name[en]=${APP_NAME_EN}
Comment=${SUMMARY}
Comment[en]=Local-first ebook reader
Exec=/opt/apps/${APPID}/files/moread --no-sandbox %U
Icon=${APPID}
Terminal=false
Categories=Office;Viewer;Literature;
MimeType=application/epub+zip;text/plain;
StartupWMClass=moread
`);
  /* info：UOS/deepin 商店读取的应用元数据 */
  fs.writeFileSync(path.join(appRoot, 'info'), JSON.stringify({
    appid: APPID,
    name: APP_NAME_CN,
    version: VERSION,
    arch: [debArch],
    permissions: {
      autostart: false, notification: false,
      tray: false, clipboard: false,
      account: false, bluetooth: false,
      camera: false, audio_record: false,
      installed_apps: false,
    },
  }, null, 1) + '\n');

  /* 清掉装 deb 时没用的安装脚本 */
  for (const junk of ['install.sh', '启动墨读.sh', 'README.txt']) {
    fs.rmSync(path.join(filesDir, junk), { force: true });
  }

  /* control */
  const controlDir = path.join(stage, '_control');
  fs.mkdirSync(controlDir, { recursive: true });
  fs.writeFileSync(path.join(controlDir, 'control'),
`Package: moread
Version: ${DEB_VER}
Architecture: ${debArch}
Maintainer: RoutineMiku <https://github.com/RoutineMiku>
Section: text
Priority: optional
Installed-Size: ${Math.round(dirSize(filesDir) / 1024)}
Depends: ${DEPENDS}
Homepage: https://routinemiku.github.io/MoRead-Windows/
Description: ${APP_NAME_EN} - local-first ebook reader
 ${SUMMARY}
 EPUB/TXT import, Legado-compatible book sources, TTS reading,
 bookmarks, themes. All data stays on device. MIT licensed.
`);

  /* md5sums（data 树内所有文件相对路径） */
  const md5 = require('crypto');
  const lines = [];
  (function walk(dir, rel) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name), r = rel ? rel + '/' + e.name : e.name;
      if (e.isDirectory()) walk(p, r);
      else lines.push(md5.createHash('md5').update(fs.readFileSync(p)).digest('hex') + '  ' + r);
    }
  })(path.join(stage, 'opt'), '');
  fs.writeFileSync(path.join(controlDir, 'md5sums'), lines.join('\n') + '\n');

  console.log(`[${archName}] 打包 control.tar.gz / data.tar.gz …`);
  const controlTar = tarGz(['.'], controlDir, 'control');
  const dataTar = tarGz(['opt'], stage, 'data');

  const debName = `MoRead-linux-${archName}-${VERSION}.deb`;
  const deb = buildAr([
    { name: 'debian-binary', data: Buffer.from('2.0\n') },
    { name: 'control.tar.gz', data: controlTar },
    { name: 'data.tar.gz', data: dataTar },
  ]);
  const outPath = path.join(DIST, debName);
  fs.writeFileSync(outPath, deb);
  fs.rmSync(stage, { recursive: true, force: true });
  console.log(`[${archName}] 完成：${debName}（${(deb.length / 1048576).toFixed(1)} MB）`);
  return outPath;
}

function dirSize(p) {
  let s = 0;
  for (const e of fs.readdirSync(p, { withFileTypes: true })) {
    const q = path.join(p, e.name);
    s += e.isDirectory() ? dirSize(q) : fs.statSync(q).size;
  }
  return s;
}

const arg = a => process.argv.includes(a);
const idx = process.argv.indexOf('--arch');
const which = idx > -1 ? process.argv[idx + 1] : 'both';
const arches = which === 'both' ? ['x64', 'arm64'] : [which];
let ok = 0;
for (const a of arches) if (buildOne(a)) ok++;
console.log(ok ? `\ndeb 打包完成（${ok} 个）` : '没有产出');
process.exit(ok ? 0 : 1);
