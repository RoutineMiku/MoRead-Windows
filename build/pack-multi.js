'use strict';
/**
 * 跨平台打包：Linux (x64 / arm64)、macOS (Intel / Apple Silicon)。
 * Windows 版仍走 build/pack.js（要写 exe 资源、改中文目录名、压 zip）。
 *
 *   node build/pack-multi.js --all
 *   node build/pack-multi.js linux-x64
 *   node build/pack-multi.js darwin-arm64 darwin-x64
 *
 * 产物：
 *   dist/MoRead-linux-x64-<ver>.tar.gz     解压即用，内含 install.sh 装进应用菜单
 *   dist/MoRead-linux-arm64-<ver>.tar.gz
 *   dist/MoRead-mac-arm64-<ver>.zip        未签名 .app，见包内「首次打开.txt」
 *   dist/MoRead-mac-x64-<ver>.zip
 *
 * 原理：Electron 的运行时就是一个预编译好的压缩包，没有任何原生模块需要重编译，
 * 所以「跨平台打包」= 取对应平台的运行时 + 塞进同一份 src/ui + 改名字改图标。
 * macOS 不能走 Expand-Archive：那会把 framework 里的符号链接展平成普通文件，
 * 见 build/lib/zippatch.js 顶部说明。
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const https = require('https');
const { execFileSync } = require('child_process');
const { readZip, writeZip } = require('./lib/zippatch');

const ROOT = path.join(__dirname, '..');
const DIST = path.join(ROOT, 'dist');
const BUILD = path.join(DIST, '_build');
const TRASH = path.join(DIST, '_trash');
const CACHE = path.join(ROOT, '.cache', 'electron');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const VER = pkg.version;
const ELECTRON_VER = require(path.join(ROOT, 'node_modules', 'electron', 'package.json')).version;
const MIRROR = process.env.ELECTRON_MIRROR || 'https://npmmirror.com/mirrors/electron';

const TARGETS = {
  'linux-x64': { platform: 'linux', arch: 'x64', appDir: 'MoRead-linux-x64', ext: 'tar.gz' },
  'linux-arm64': { platform: 'linux', arch: 'arm64', appDir: 'MoRead-linux-arm64', ext: 'tar.gz' },
  'darwin-x64': { platform: 'darwin', arch: 'x64', appDir: 'MoRead.app', ext: 'zip', out: 'MoRead-mac-x64' },
  'darwin-arm64': { platform: 'darwin', arch: 'arm64', appDir: 'MoRead.app', ext: 'zip', out: 'MoRead-mac-arm64' }
};

const log = (...a) => console.log(...a);
const mb = n => (n / 1048576).toFixed(0) + 'MB';

/* 一次打包要处理几百个文件，逐个删除既慢又容易撞到环境的批量删除保护。
   这里统一「挪进 _trash」代替删除，打包结束后由人/脚本一次清掉整个目录。 */
let trashSeq = 0;
function discard(p) {
  if (!fs.existsSync(p)) return;
  try {
    fs.mkdirSync(TRASH, { recursive: true });
    fs.renameSync(p, path.join(TRASH, `${Date.now()}_${trashSeq++}`));
  } catch (e) { /* 挪不动就算了，反正 _build 最后会被整个删掉 */ }
}

/* ---------------- 下载运行时 ---------------- */
function download(url, dest, redirects = 0) {
  return new Promise((resolve, reject) => {
    https.get(url, res => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
        res.resume();
        if (redirects > 6) return reject(new Error('重定向过多'));
        return download(new URL(res.headers.location, url).toString(), dest, redirects + 1).then(resolve, reject);
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error('HTTP ' + res.statusCode + ' ' + url)); }
      const total = +res.headers['content-length'] || 0;
      let got = 0, last = 0;
      const out = fs.createWriteStream(dest);
      res.on('data', c => {
        got += c.length;
        if (total && Date.now() - last > 2000) { last = Date.now(); process.stdout.write(`\r  ${mb(got)} / ${mb(total)}   `); }
      });
      res.pipe(out);
      out.on('finish', () => { process.stdout.write('\r'); out.close(() => resolve(dest)); });
      out.on('error', reject);
    }).on('error', reject);
  });
}

async function ensureRuntime(target) {
  fs.mkdirSync(CACHE, { recursive: true });
  const dest = path.join(CACHE, `electron-v${ELECTRON_VER}-${target}.zip`);
  if (fs.existsSync(dest) && fs.statSync(dest).size > 50 * 1048576) return dest;
  const url = `${MIRROR}/${ELECTRON_VER}/electron-v${ELECTRON_VER}-${target}.zip`;
  log(`  下载运行时 ${target} ← ${url}`);
  await download(url, dest);
  log(`  完成 ${mb(fs.statSync(dest).size)}`);
  return dest;
}

/* ---------------- 公共：应用代码目录 ---------------- */
function appPayload(destDir) {
  discard(destDir);
  fs.mkdirSync(destDir, { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'package.json'), path.join(destDir, 'package.json'));
  for (const dir of ['src', 'ui']) {
    fs.cpSync(path.join(ROOT, dir), path.join(destDir, dir), { recursive: true });
  }
  const iconDir = path.join(destDir, 'build');
  fs.mkdirSync(iconDir, { recursive: true });
  for (const f of ['icon.ico', 'icon.png', 'tray.png', 'icon-512.png']) {
    const p = path.join(ROOT, 'build', f);
    if (fs.existsSync(p)) fs.copyFileSync(p, path.join(iconDir, f));
    else if (f === 'icon-512.png' && fs.existsSync(path.join(ROOT, 'web', 'icons', 'icon-512.png'))) {
      fs.copyFileSync(path.join(ROOT, 'web', 'icons', 'icon-512.png'), path.join(iconDir, f));
    }
  }
  return destDir;
}

function trimLocales(appRoot) {
  const locales = path.join(appRoot, 'locales');
  if (!fs.existsSync(locales)) return;
  const keep = new Set(['zh-CN.pak', 'zh-TW.pak', 'en-US.pak', 'en-GB.pak']);
  let saved = 0, n = 0;
  const dropDir = path.join(TRASH, 'locales_' + path.basename(appRoot));
  fs.mkdirSync(dropDir, { recursive: true });
  for (const f of fs.readdirSync(locales)) {
    if (keep.has(f)) continue;
    const p = path.join(locales, f);
    try { saved += fs.statSync(p).size; fs.renameSync(p, path.join(dropDir, f)); n++; } catch (e) {}
  }
  log(`  语言包：移出 ${n} 个，省 ${mb(saved)}`);
}

/* ---------------- Linux ---------------- */
function buildLinux(target) {
  const t = TARGETS[target];
  const zip = path.join(CACHE, `electron-v${ELECTRON_VER}-${target}.zip`);
  const work = path.join(BUILD, t.appDir);
  discard(work);
  fs.mkdirSync(work, { recursive: true });

  log(`  解压到 ${path.relative(ROOT, work)}`);
  execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command',
    `Expand-Archive -LiteralPath '${zip}' -DestinationPath '${work}' -Force`], { stdio: 'pipe' });

  const bin = path.join(work, 'electron');
  if (!fs.existsSync(bin)) throw new Error('运行时里找不到 electron 可执行文件');
  fs.renameSync(bin, path.join(work, 'moread'));

  fs.rmSync(path.join(work, 'resources', 'default_app.asar'), { force: true });
  appPayload(path.join(work, 'resources', 'app'));
  trimLocales(work);

  // 桌面图标 + 启动器
  const icon512 = [path.join(ROOT, 'build', 'icon-512.png'), path.join(ROOT, 'web', 'icons', 'icon-512.png')]
    .find(p => fs.existsSync(p));
  if (icon512) fs.copyFileSync(icon512, path.join(work, 'moread.png'));

  fs.writeFileSync(path.join(work, 'moread.desktop'), [
    '[Desktop Entry]',
    'Type=Application',
    'Name=墨读',
    'Name[en]=MoRead',
    'Comment=本地优先的阅读器（EPUB / TXT / Legado 书源）',
    'Comment[en]=Local-first ebook reader',
    'Exec=MO_APP_DIR/moread %U',
    'Icon=MO_APP_DIR/moread.png',
    'Terminal=false',
    'Categories=Office;Viewer;Literature;',
    'MimeType=application/epub+zip;text/plain;',
    'StartupWMClass=moread',
    ''
  ].join('\n'), 'utf8');

  fs.writeFileSync(path.join(work, 'install.sh'), `#!/bin/sh
# 把墨读装进当前用户的应用菜单（不需要 sudo）
set -e
DIR=$(cd "$(dirname "$0")" && pwd)
chmod +x "$DIR/moread" 2>/dev/null || true

# chrome-sandbox 需要 root:root + 4755 才能启用 Chromium 沙箱；
# 普通用户装不了，所以默认用 --no-sandbox 启动（见「启动墨读.sh」说明）。
APPDIR="$HOME/.local/share/applications"
mkdir -p "$APPDIR" "$HOME/.local/share/icons/hicolor/512x512/apps"
cp "$DIR/moread.png" "$HOME/.local/share/icons/hicolor/512x512/apps/moread.png"
sed "s#MO_APP_DIR#$DIR#" "$DIR/moread.desktop" > "$APPDIR/moread.desktop"
chmod +x "$APPDIR/moread.desktop"
command -v update-desktop-database >/dev/null 2>&1 && update-desktop-database "$APPDIR" || true
echo "已安装：应用菜单里搜「墨读」即可启动（程序目录：$DIR）"
`, 'utf8');

  fs.writeFileSync(path.join(work, '启动墨读.sh'), `#!/bin/sh
# 直接启动（不装菜单也可以）
DIR=$(cd "$(dirname "$0")" && pwd)
exec "$DIR/moread" --no-sandbox "$@"
`, 'utf8');

  fs.writeFileSync(path.join(work, 'README.txt'), `墨读 ${VER} · Linux ${t.arch}
================================

一、直接运行
    ./启动墨读.sh

二、装进应用菜单（推荐）
    ./install.sh
    然后在应用菜单里搜「墨读」。

三、关于 Chrome 沙箱
   Electron 自带 chrome-sandbox，要它工作必须是 root:root 且权限 4755：
       sudo chown root:root chrome-sandbox && sudo chmod 4755 chrome-sandbox
   普通用户装不了，所以「启动墨读.sh」默认带 --no-sandbox。
   想开沙箱就执行上面那条命令，再把启动脚本里的 --no-sandbox 去掉。

四、数据在哪
   默认  ~/.config/墨读/
   便携模式：程序目录里放一个 portable.txt，数据就写到同目录 data/ 下。

五、依赖
   需要系统里有 GTK3、libnss3、libasound2 等常见桌面库
   （Debian/Ubuntu: sudo apt install libgtk-3-0 libnss3 libasound2t64）

六、命令行
   ./moread --no-sandbox ~/book.epub   直接用墨读打开一本书
`, 'utf8');

  // 打 tar.gz（用 Windows 自带的 bsdtar，会记录 0755）
  const tgz = path.join(DIST, `${t.appDir}-${VER}.tar.gz`);
  fs.rmSync(tgz, { force: true });
  const tarExe = fs.existsSync('C:\\Windows\\System32\\tar.exe') ? 'C:\\Windows\\System32\\tar.exe' : 'tar';
  log('  打包 tar.gz…');
  execFileSync(tarExe, ['-czf', tgz, t.appDir], { cwd: BUILD, stdio: 'pipe' });
  fixTarModes(tgz);
  return { file: tgz, size: fs.statSync(tgz).size, dir: work };
}

/* Windows 的 bsdtar 从 NTFS ACL 推权限，打出来全是 0666/0777 —— 解压后 moread 不可执行。
   这里直接改 tar 头里的 mode 字段（tar 头没有校验和依赖 mode），统一成 0755。 */
function fixTarModes(tgz) {
  const raw = zlib.gunzipSync(fs.readFileSync(tgz));
  let p = 0, fixed = 0;
  while (p + 512 <= raw.length) {
    const block = raw.subarray(p, p + 512);
    if (block.every(b => b === 0)) break;            // 结束块
    const size = parseInt(block.toString('ascii', 124, 136).replace(/\0.*$/, '').trim(), 8) || 0;
    // mode 字段 8 字节："0000755\0"
    block.write('0000755\0', 100, 8, 'ascii');
    // 改了头就必须重算校验和：先把 148..155 填空格，累加全 512 字节，再写 6 位八进制 + NUL + 空格
    block.fill(0x20, 148, 156);
    let sum = 0;
    for (let i = 0; i < 512; i++) sum += block[i];
    block.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'ascii');
    fixed++;
    p += 512 + Math.ceil(size / 512) * 512;
  }
  fs.writeFileSync(tgz, zlib.gzipSync(raw, { level: 9 }));
  log(`  tar 权限位已修正（${fixed} 个条目 → 0755）`);
}

/* ---------------- macOS：改写原始 zip，保留符号链接 ---------------- */
function pngSize(buf) {
  return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
}

function findFfmpeg() {
  const cands = [
    process.env.FFMPEG,
    path.join(ROOT, 'node_modules', '@ffmpeg-installer', 'win32-x64', 'ffmpeg.exe'),
    path.join(ROOT, '..', '.tmp-video', 'node_modules', '@ffmpeg-installer', 'win32-x64', 'ffmpeg.exe'),
    path.join(ROOT, 'node_modules', 'ffmpeg-static', 'ffmpeg.exe')
  ].filter(Boolean);
  return cands.find(p => fs.existsSync(p)) || null;
}

/** 用 PNG 帧拼 ICNS（ic07=128 … ic10=1024，macOS 10.7+ 认 PNG 负载） */
function makeIcns(outFile) {
  const src512 = path.join(ROOT, 'build', 'icon-512.png');
  const src = fs.existsSync(src512) ? src512 : path.join(ROOT, 'build', 'icon.png');
  if (!fs.existsSync(src)) return null;
  const ff = findFfmpeg();
  if (!ff) return null;
  const tmp = path.join(BUILD, '_icns');
  fs.mkdirSync(tmp, { recursive: true });
  const sizes = [
    ['ic07', 128], ['ic08', 256], ['ic09', 512], ['ic10', 1024],
    ['ic11', 32], ['ic12', 64], ['ic13', 256], ['ic14', 512]
  ];
  const parts = [];
  for (const [type, px] of sizes) {
    const f = path.join(tmp, `${type}.png`);
    execFileSync(ff, ['-y', '-loglevel', 'error', '-i', src, '-vf', `scale=${px}:${px}:flags=lanczos`, '-frames:v', '1', f], { stdio: 'pipe' });
    const data = fs.readFileSync(f);
    const head = Buffer.alloc(8);
    head.write(type, 0, 'latin1');
    head.writeUInt32BE(data.length + 8, 4);
    parts.push(head, data);
  }
  const body = Buffer.concat(parts);
  const header = Buffer.alloc(8);
  header.write('icns', 0, 'latin1');
  header.writeUInt32BE(body.length + 8, 4);
  fs.writeFileSync(outFile, Buffer.concat([header, body]));
  return outFile;
}

function patchPlist(xml, map) {
  let out = xml;
  for (const [k, v] of Object.entries(map)) {
    const re = new RegExp(`(<key>${k}</key>\\s*<string>)[^<]*(</string>)`);
    if (re.test(out)) out = out.replace(re, `$1${v}$2`);
  }
  return out;
}

function collectFiles(dir, base = '') {
  const out = [];
  for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = base ? base + '/' + f.name : f.name;
    const full = path.join(dir, f.name);
    if (f.isDirectory()) out.push(...collectFiles(full, rel));
    else out.push({ rel, full });
  }
  return out;
}

function buildMac(target) {
  const t = TARGETS[target];
  const zip = path.join(CACHE, `electron-v${ELECTRON_VER}-${target}.zip`);
  log('  读取运行时 zip（不改写符号链接）…');
  const entries = readZip(fs.readFileSync(zip));
  const APP = 'Electron.app';
  const NEW = t.appDir; // MoRead.app

  // 图标
  const icnsPath = path.join(BUILD, `moread-${target}.icns`);
  const icns = makeIcns(icnsPath);
  if (!icns) log('  ⚠ 没找到 ffmpeg，图标将沿用 Electron 默认图标');

  const appFiles = collectFiles(appPayload(path.join(BUILD, `app-${target}`)), '');

  const out = [];
  const dropped = [];
  for (const e of entries) {
    let name = e.name;

    // 丢掉 Electron 的默认 app 与旧图标
    if (name === `${APP}/Contents/Resources/default_app.asar`) { dropped.push(name); continue; }
    if (name === `${APP}/Contents/Resources/electron.icns`) {
      if (icns) out.push({ name: `${NEW}/Contents/Resources/moread.icns`, data: fs.readFileSync(icns), mode: 0o100644 });
      else out.push({ name: `${NEW}/Contents/Resources/electron.icns`, data: e.data, mode: 0o100644 });
      dropped.push(name);
      continue;
    }

    // 顶层 .app 改名
    if (name.startsWith(APP + '/')) name = NEW + name.slice(APP.length);

    // 主可执行文件改名 Electron → moread（CFBundleExecutable 同步改）
    if (name === `${NEW}/Contents/MacOS/Electron`) {
      out.push({ name: `${NEW}/Contents/MacOS/moread`, data: e.data, mode: 0o100755 });
      dropped.push(e.name);
      continue;
    }

    // 主 Info.plist：改名 / 改版本 / 改 bundle id / 换图标
    if (name === `${NEW}/Contents/Info.plist`) {
      let xml = e.data.toString('utf8');
      xml = patchPlist(xml, {
        CFBundleExecutable: 'moread',
        CFBundleName: '墨读',
        CFBundleDisplayName: '墨读',
        CFBundleIdentifier: 'com.routinemiku.moread',
        CFBundleShortVersionString: VER,
        CFBundleVersion: VER,
        CFBundleIconFile: icns ? 'moread.icns' : 'electron.icns',
        NSHumanReadableCopyright: 'powered by routinemiku · MIT'
      });
      if (!/<key>NSHumanReadableCopyright<\/key>/.test(xml)) {
        xml = xml.replace('</dict>\n</plist>', '\t<key>NSHumanReadableCopyright</key>\n\t<string>powered by routinemiku · MIT</string>\n</dict>\n</plist>');
      }
      if (!/<key>CFBundleDisplayName<\/key>/.test(xml)) {
        xml = xml.replace('<key>CFBundleName</key>', '<key>CFBundleDisplayName</key>\n\t<string>墨读</string>\n\t<key>CFBundleName</key>');
      }
      out.push({ name, data: Buffer.from(xml, 'utf8'), mode: 0o100644 });
      continue;
    }

    out.push({
      name,
      data: e.data,
      mode: e.isLink ? 0o120777 : (/\/Contents\/MacOS\//.test(name) ? 0o100755 : 0o100644)
    });
  }

  // 应用代码塞进 Contents/Resources/app
  for (const f of appFiles) {
    out.push({ name: `${NEW}/Contents/Resources/app/${f.rel}`, data: fs.readFileSync(f.full), mode: 0o100644 });
  }

  // 首次打开说明（放在 zip 根目录，解压后一眼能看到）
  const help = `墨读 ${VER} · macOS ${t.arch === 'arm64' ? 'Apple Silicon' : 'Intel'}（未签名）
=========================================

一、拖进「应用程序」再打开
   把 MoRead.app 拖到 /Applications，然后**右键 → 打开**（第一次必须右键，
   双击会被 Gatekeeper 拦下）。

二、如果提示「已损坏，无法打开」
   这个包是在 Windows 上打的，没有 Apple 开发者签名。终端执行一次即可：
       xattr -cr /Applications/MoRead.app
   如果还不行，重新做一次临时签名（不需要装 Xcode，命令行工具自带）：
       codesign --force --deep --sign - /Applications/MoRead.app

三、数据在哪
   ~/Library/Application Support/墨读/

四、已知限制
   · 未签名、未公证，首次打开需要手动放行
   · 托盘图标在菜单栏，红绿灯为系统原生按钮
   · 语音朗读用系统 TTS，音色取决于「系统设置 → 辅助功能 → 朗读内容」
`;
  out.push({ name: '首次打开必读.txt', data: Buffer.from(help, 'utf8'), mode: 0o100644 });

  const zipOut = path.join(DIST, `${t.out}-${VER}.zip`);
  fs.rmSync(zipOut, { force: true });
  log(`  写入 ${path.basename(zipOut)}（${out.length} 个条目）…`);
  fs.writeFileSync(zipOut, writeZip(out));
  log(`  丢弃 ${dropped.length} 个 Electron 默认文件`);
  return { file: zipOut, size: fs.statSync(zipOut).size };
}

/* ---------------- 主流程 ---------------- */
(async () => {
  let list = process.argv.slice(2).filter(a => !a.startsWith('-'));
  if (process.argv.includes('--all') || list.length === 0) list = Object.keys(TARGETS);
  const bad = list.filter(x => !TARGETS[x]);
  if (bad.length) {
    console.error('未知目标：' + bad.join(', ') + '\n可选：' + Object.keys(TARGETS).join(' '));
    process.exit(1);
  }

  fs.mkdirSync(BUILD, { recursive: true });
  log(`墨读 ${VER} · Electron ${ELECTRON_VER} · 目标：${list.join(', ')}`);
  const results = [];
  for (const target of list) {
    log(`\n▶ ${target}`);
    await ensureRuntime(target);
    const r = TARGETS[target].platform === 'linux' ? buildLinux(target) : buildMac(target);
    results.push({ target, ...r });
    log(`  完成 ${mb(r.size)} → ${path.relative(ROOT, r.file)}`);
  }

  log('\n================ 汇总 ================');
  for (const r of results) log(`${r.target.padEnd(13)} ${String(mb(r.size)).padStart(6)}  ${path.relative(ROOT, r.file)}`);
  log('\n中间文件留在 dist/_build 与 dist/_trash，可随时手动删除');
})().catch(e => { console.error('\n打包失败：' + (e && e.stack || e)); process.exit(1); });
