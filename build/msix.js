#!/usr/bin/env node
'use strict';
/**
 * 打微软商店用的 MSIX 包（Electron 桌面应用，FullTrust 打包应用）。
 *
 *   node build/msix.js                         用默认 Identity 打本地测试包
 *   node build/msix.js --sign                  顺便用 build/msix-test.pfx 自签
 *   node build/msix.js --identity "12345RoutineMiku.MoRead" \
 *                      --publisher "CN=ABCDEF12-3456-..." --sign
 *
 * 商店提交前要先在 Partner Center「预留应用名称」，把那里给的
 * Package/Identity/Name 与 Publisher 填进来重新打一次。
 *
 * 参数：
 *   --identity <Name>        Package Identity Name（默认 RoutineMiku.MoRead）
 *   --publisher <CN=...>     证书 Subject，必须与签名证书一致
 *   --display <名字>          应用显示名（默认 墨读）
 *   --publisher-name <名字>   发布者显示名（默认 RoutineMiku）
 *   --description <文案>      应用描述
 *   --sign                   用 build/msix-test.pfx 签名
 *   --pfx / --pfx-pass       自签证书路径与密码
 *   --keep                   保留 dist/_msix 暂存目录
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const V = pkg.version;
const VER4 = V.split('.').concat(['0', '0', '0']).slice(0, 4).join('.');
const SRC = path.join(ROOT, 'dist', '墨读-win32-x64');
const STAGE = path.join(ROOT, 'dist', '_msix');
const OUT = path.join(ROOT, 'dist', `MoRead-${V}-x64.msix`);

const TOOL_DIR = path.join(ROOT, '.msix-tools', 'buildtools', 'bin', '10.0.26100.0', 'x64');
const MAKEAPPX = process.env.MAKEAPPX || path.join(TOOL_DIR, 'makeappx.exe');
const SIGNTOOL = process.env.SIGNTOOL || path.join(TOOL_DIR, 'signtool.exe');

const args = process.argv.slice(2);
const arg = (k, d) => { const i = args.indexOf(k); return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : d; };
const has = k => args.includes(k);

const IDENTITY = arg('--identity', 'RoutineMiku.MoRead');
const PUBLISHER = arg('--publisher', 'CN=MoRead');
const DISPLAY = arg('--display', '墨读');
const PUBNAME = arg('--publisher-name', 'RoutineMiku');
const DESC = arg('--description', '本地优先的阅读器：书架、书源、进度都在本机，不上传、不追踪');

if (!fs.existsSync(SRC)) {
  console.error('没有 dist/墨读-win32-x64，先跑 node build/pack.js');
  process.exit(1);
}
if (!fs.existsSync(MAKEAPPX)) {
  console.error('找不到 makeappx：' + MAKEAPPX);
  console.error('可设 MAKEAPPX=<path>，或把 Windows SDK BuildTools 放到 .msix-tools/buildtools');
  process.exit(1);
}

/* 1. 暂存目录：复制应用文件，去掉便携标记与用户数据
 *    这里不用 fs.cpSync —— Windows 上复制 Electron 的 resources 会让 Node 直接崩（退出码 127），
 *    用系统自带的 robocopy 更稳，也快。 */
const reuse = has('--reuse') || (fs.existsSync(STAGE) && fs.existsSync(path.join(STAGE, 'resources')));
if (reuse) {
  console.log('复用现有暂存目录：' + STAGE);
} else {
  console.log('复制应用文件（约 310MB，robocopy）…');
  fs.rmSync(STAGE, { recursive: true, force: true });
  fs.mkdirSync(STAGE, { recursive: true });
  const rr = spawnSync('robocopy', [SRC, STAGE, '/E', '/NFL', '/NDL', '/NJH', '/NJS', '/nc', '/ns', '/np'], { stdio: 'inherit' });
  if (rr.status === null || rr.status > 7) {
    console.error('robocopy 失败（退出码 ' + rr.status + '）');
    process.exit(1);
  }
}
for (const junk of ['data', 'portable.txt']) {
  fs.rmSync(path.join(STAGE, junk), { recursive: true, force: true });
}
const exeOld = path.join(STAGE, '墨读.exe');
const exeNew = path.join(STAGE, 'MoRead.exe');
if (fs.existsSync(exeOld)) fs.renameSync(exeOld, exeNew);

/* 2. 图标 */
const ASSETS = path.join(__dirname, 'msix', 'Assets');
if (!fs.existsSync(ASSETS)) {
  console.error('缺少 build/msix/Assets，先跑 electron build/gen-msix-assets.js');
  process.exit(1);
}
fs.cpSync(ASSETS, path.join(STAGE, 'Assets'), { recursive: true });

/* 3. AppxManifest */
const xmlEsc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
let mf = fs.readFileSync(path.join(__dirname, 'msix', 'AppxManifest.xml'), 'utf8');
mf = mf
  .replace(/{{IDENTITY}}/g, xmlEsc(IDENTITY))
  .replace(/{{PUBLISHER}}/g, xmlEsc(PUBLISHER))
  .replace(/{{VERSION}}/g, VER4)
  .replace(/{{DISPLAY}}/g, xmlEsc(DISPLAY))
  .replace(/{{PUBLISHER_NAME}}/g, xmlEsc(PUBNAME))
  .replace(/{{DESCRIPTION}}/g, xmlEsc(DESC));
fs.writeFileSync(path.join(STAGE, 'AppxManifest.xml'), mf, 'utf8');

/* 4. makeappx pack */
fs.rmSync(OUT, { force: true });
console.log(`打包 MSIX（${IDENTITY} / ${PUBLISHER} / ${VER4}）…`);
const r = spawnSync(MAKEAPPX, ['pack', '/d', STAGE, '/p', OUT, '/o'], { stdio: 'inherit' });
if (r.status !== 0) {
  console.error('makeappx 失败（退出码 ' + r.status + '）');
  process.exit(r.status || 1);
}
const mb = (fs.statSync(OUT).size / 1048576).toFixed(1);
console.log(`完成：${OUT}  ${mb}MB`);

/* 5. 自签（本地安装测试用；商店提交不需要，商店会重签）
 *    两种方式：--sha1 <指纹> 用证书商店里的证书，或 --pfx <文件> 用导出文件 */
if (has('--sign')) {
  if (!fs.existsSync(SIGNTOOL)) {
    console.error('找不到 signtool：' + SIGNTOOL);
    process.exit(1);
  }
  const sha1 = arg('--sha1', process.env.MSIX_CERT_SHA1 || '');
  const pfx = path.resolve(arg('--pfx', ''));
  const pass = arg('--pfx-pass', 'moread');
  let signArgs;
  if (sha1) {
    signArgs = ['sign', '/fd', 'SHA256', '/sha1', sha1, '/a', OUT];
  } else if (pfx && fs.existsSync(pfx)) {
    signArgs = ['sign', '/fd', 'SHA256', '/a', '/f', pfx, '/p', pass, OUT];
  } else {
    console.error('签名需要 --sha1 <证书指纹> 或 --pfx <证书文件>');
    process.exit(1);
  }
  console.log('签名…');
  const sr = spawnSync(SIGNTOOL, signArgs, { stdio: 'inherit' });
  if (sr.status !== 0) {
    console.error('签名失败（退出码 ' + sr.status + '）');
    process.exit(sr.status || 1);
  }
  console.log('已签名：' + path.basename(OUT));
}

if (!has('--keep')) fs.rmSync(STAGE, { recursive: true, force: true });
console.log('\n下一步：把 dist/' + path.basename(OUT) + ' 上传到 Partner Center → 提交');
