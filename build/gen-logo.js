'use strict';
/**
 * 生成全平台图标：一枚「书本 + 墨读」的矢量标识，按目标尺寸逐个栅格化。
 *
 * 为什么不用图片缩放：图标要在 1024(商店)、512(PWA)、192/180(主屏)、
 * 48/32/16(任务栏、托盘) 上都清楚。位图缩到 32px 一定糊，所以这里把
 * SVG 在每个尺寸下**原生渲染**一次（窗口尺寸 = 目标尺寸），边缘永远锐利。
 *
 * 用法：
 *   node build/gen-logo.js            生成全部尺寸并写入各端目录
 *   node build/gen-logo.js --preview  只出 build/_logo-preview.png（512）看效果
 */
const { app, BrowserWindow, nativeImage } = require('electron');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PREVIEW = process.argv.includes('--preview');

/* ---------------- 图形 ----------------
 * 1024 画布，圆角方（superellipse 近似半径 232）。
 * 元素：深墨底 + 暖色微光 + 摊开的书 + 三个「墨点」+ 底部「墨读」字标。
 * 字标只在 96px 以上出现，小尺寸自动换成纯图形，避免缩成一团黑。
 */
function svg(size, withWordmark) {
  const wordmark = withWordmark !== false;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 1024 1024">
  ${svgBody(wordmark, true)}
</svg>`;
}

/* 只有图形本身（含渐变定义），不含外层 svg 标签与背景 */
function svgBody(wordmark, withBg) {
  if (withBg === undefined) withBg = true;
  return `<defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#16233c"/>
      <stop offset=".55" stop-color="#1d3357"/>
      <stop offset="1" stop-color="#2b4d80"/>
    </linearGradient>
    <radialGradient id="glow" cx=".28" cy=".18" r=".78">
      <stop offset="0" stop-color="#8fb6ff" stop-opacity=".34"/>
      <stop offset="1" stop-color="#8fb6ff" stop-opacity="0"/>
    </radialGradient>
    <linearGradient id="paper" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#fdfaf2"/>
      <stop offset="1" stop-color="#ece2cd"/>
    </linearGradient>
    <linearGradient id="paperR" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#f6f1e4"/>
      <stop offset="1" stop-color="#e0d5bd"/>
    </linearGradient>
    <filter id="soft" x="-30%" y="-30%" width="160%" height="160%">
      <feDropShadow dx="0" dy="18" stdDeviation="24" flood-color="#060c18" flood-opacity=".45"/>
    </filter>
  </defs>

  ${withBg ? `<rect width="1024" height="1024" rx="232" fill="url(#bg)"/>
  <rect width="1024" height="1024" rx="232" fill="url(#glow)"/>
  <rect x="6" y="6" width="1012" height="1012" rx="228" fill="none" stroke="#ffffff" stroke-opacity=".07" stroke-width="3"/>` : ''}

  <!-- 摊开的书：外缘略翘、书脊处轻微下沉，比直线更像真书 -->
  <g filter="url(#soft)" transform="${wordmark ? 'translate(0,-70)' : 'translate(512,512) scale(1.14) translate(-512,-512)'}">
    <path d="M506 318 C 448 278 352 258 282 270 C 266 273 254 286 254 303 L254 596
             C 254 614 268 627 286 624 C 362 613 456 632 506 658 Z" fill="url(#paper)"/>
    <path d="M518 318 C 576 278 672 258 742 270 C 758 273 770 286 770 303 L770 596
             C 770 614 756 627 738 624 C 662 613 568 632 518 658 Z" fill="url(#paperR)"/>
    <path d="M506 318 L518 318 L518 658 L506 658 Z" fill="#c9bda4" opacity=".8"/>
    <g fill="#b9ad93" opacity=".48">
      <rect x="296" y="366" width="168" height="12" rx="6"/>
      <rect x="296" y="410" width="168" height="12" rx="6"/>
      <rect x="296" y="454" width="136" height="12" rx="6"/>
      <rect x="296" y="498" width="168" height="12" rx="6"/>
      <rect x="296" y="542" width="112" height="12" rx="6"/>
      <rect x="560" y="366" width="168" height="12" rx="6"/>
      <rect x="560" y="410" width="168" height="12" rx="6"/>
      <rect x="560" y="454" width="136" height="12" rx="6"/>
      <rect x="560" y="498" width="168" height="12" rx="6"/>
      <rect x="560" y="542" width="96" height="12" rx="6"/>
    </g>
    <path d="M254 596 C 254 614 268 627 286 624 C 362 613 456 632 506 658" fill="none"
          stroke="#b3a68c" stroke-opacity=".5" stroke-width="4"/>
    <path d="M770 596 C 770 614 756 627 738 624 C 662 613 568 632 518 658" fill="none"
          stroke="#a99b80" stroke-opacity=".5" stroke-width="4"/>
  </g>

  ${wordmark ? `<!-- 字标 + 朱红笔锋下划线 -->
  <text x="512" y="872" text-anchor="middle" fill="#f8f4e9"
        font-family="'Source Han Serif SC','Noto Serif SC','STZhongsong','SimSun',serif"
        font-size="184" font-weight="600" letter-spacing="28">墨读</text>
  <rect x="404" y="902" width="216" height="9" rx="4.5" fill="#d8543c" opacity=".9"/>`
    : ''}`;
}

function html(size, withWordmark) {
  return `<!doctype html><meta charset="utf-8">
<style>html,body{margin:0;padding:0;background:transparent;overflow:hidden}svg{display:block}</style>
${svg(size, withWordmark)}`;
}

/* 只开一个 1024 窗口连续截两次图。
   小窗口（<100px）capturePage 会报 UnknownVizError，而且失败后同进程再开窗
   会连带 ERR_FAILED —— 所以固定主尺寸渲染、其余靠高质量缩放。 */
async function shootHtml(win, key, htmlStr, rect) {
  const tmp = path.join(ROOT, 'build', `_logo-${key}.html`);
  fs.writeFileSync(tmp, htmlStr, 'utf8');
  await win.loadFile(tmp);
  await new Promise(r => setTimeout(r, 260));
  const png = (await win.webContents.capturePage(rect)).toPNG();
  try { fs.unlinkSync(tmp); } catch (e) { /* 删不掉就留着 */ }
  return png;
}
const shoot = (win, size, withWordmark) => shootHtml(win, withWordmark ? 'w' : 'm', html(size, withWordmark));

/* 安卓自适应图标前景层：108dp 里只有中间 72dp 是安全区，
   所以给一个「裁剪过」的画布 —— 只画书，四周留足余量，别被系统裁掉。 */
function fgHtml(px) {
  return `<!doctype html><meta charset="utf-8">
<style>html,body{margin:0;padding:0;background:transparent;overflow:hidden}svg{display:block}</style>
<svg xmlns="http://www.w3.org/2000/svg" width="${px}" height="${px}" viewBox="112 53 800 800">
  ${svgBody(false, false)}
</svg>`;
}

function resized(png, size) {
  return nativeImage.createFromBuffer(png)
    .resize({ width: size, height: size, quality: 'best' }).toPNG();
}

/* ICO 容器：每帧直接塞 PNG（Vista 起支持），免去 BMP 编码 */
function ico(frames) {
  const n = frames.length;
  const head = Buffer.alloc(6);
  head.writeUInt16LE(0, 0); head.writeUInt16LE(1, 2); head.writeUInt16LE(n, 4);
  const dir = Buffer.alloc(16 * n);
  let off = 6 + 16 * n;
  frames.forEach((f, i) => {
    const v = f.size >= 256 ? 0 : f.size;
    dir.writeUInt8(v, i * 16); dir.writeUInt8(v, i * 16 + 1);
    dir.writeUInt16LE(1, i * 16 + 4); dir.writeUInt16LE(32, i * 16 + 6);
    dir.writeUInt32LE(f.buf.length, i * 16 + 8); dir.writeUInt32LE(off, i * 16 + 12);
    off += f.buf.length;
  });
  return Buffer.concat([head, dir, ...frames.map(f => f.buf)]);
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1024, height: 1024, show: false, frame: false, transparent: true,
    useContentSize: true, webPreferences: { backgroundThrottling: false }
  });
  const big = await shoot(win, 1024, true);    // 带字标主稿
  const mark = await shoot(win, 1024, false);  // 纯图形主稿（小尺寸用）
  const fg = await shootHtml(win, 'fg', fgHtml(432), { x: 0, y: 0, width: 432, height: 432 }); // 安卓自适应图标前景（108dp@4x）
  win.destroy();

  if (PREVIEW) {
    fs.writeFileSync(path.join(ROOT, 'build', '_logo-preview.png'), resized(big, 512));
    fs.writeFileSync(path.join(ROOT, 'build', '_logo-small.png'), resized(mark, 64));
    console.log('预览：build/_logo-preview.png / _logo-small.png');
    app.quit(); return;
  }

  const at = (size, buf) => resized(buf, size);
  const out = {
    'build/icon.png': [256, big],
    'ui/logo.png': [512, big],
    'web/icons/icon-512.png': [512, big],
    'web/icons/icon-192.png': [192, big],
    'web/icons/icon-180.png': [180, big],
    'build/tray.png': [32, mark]
  };
  for (const [p, [size, src]] of Object.entries(out)) {
    fs.writeFileSync(path.join(ROOT, p), at(size, src));
    console.log('写入', p, size + 'x' + size);
  }

  const frames = [16, 24, 32, 48, 64, 128, 256].map(size =>
    ({ size, buf: at(size, size >= 96 ? big : mark) }));
  fs.writeFileSync(path.join(ROOT, 'build/icon.ico'), ico(frames));
  console.log('写入 build/icon.ico（7 帧）');

  const fgPath = path.join(ROOT, 'android/app/src/main/res/drawable/ic_launcher_foreground.png');
  if (fs.existsSync(path.dirname(fgPath))) {
    fs.writeFileSync(fgPath, fg);
    const xml = path.join(ROOT, 'android/app/src/main/res/drawable/ic_launcher_foreground.xml');
    if (fs.existsSync(xml)) fs.unlinkSync(xml);   // 同名资源只能留一个
    console.log('写入 android drawable/ic_launcher_foreground.png 432x432');
  }

  app.quit();
}).catch(e => { console.error('生成失败：' + e.message); app.exit(1); });
