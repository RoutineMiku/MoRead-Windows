'use strict';
/* 生成 MSIX 图标资源：先渲染方形/宽版母版，再缩放成各尺寸。
 * 小图标（44/50/71）用「书页特写」版，大图标用完整 logo。
 * 用法：electron build/gen-msix-assets.js
 */
const { app, BrowserWindow, nativeImage } = require('electron');
const fs = require('fs');
const path = require('path');

const LOGO = path.join(__dirname, '..', 'ui', 'logo.png');
const OUT = path.join(__dirname, 'msix', 'Assets');
const BG = '#1b3a63';
const sleep = ms => new Promise(r => setTimeout(r, ms));

const SRC = 'file:///' + LOGO.replace(/\\/g, '/');

/* mode: full = 完整 logo；crop = 放大裁掉底部文字，只留书页 */
function html(w, h, mode) {
  const img = mode === 'crop'
    ? `width:${Math.round(w * 1.45)}px;height:${Math.round(h * 1.45)}px;object-fit:cover;object-position:center 20%;`
    : `width:${Math.round(w * 0.96)}px;height:${Math.round(h * 0.96)}px;object-fit:contain;`;
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
  html,body{margin:0;width:${w}px;height:${h}px;overflow:hidden;background:${BG};}
  body{display:flex;align-items:center;justify-content:center;}
  img{${img}display:block;}
  </style></head><body><img src="${SRC}" /></body></html>`;
}

async function shoot(win, w, h, mode) {
  win.setContentSize(w, h);
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html(w, h, mode)));
  await sleep(260);
  return win.webContents.capturePage();
}

app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const win = new BrowserWindow({
    width: 640, height: 640, show: false, backgroundColor: BG,
    webPreferences: { nodeIntegration: false, contextIsolation: true, webSecurity: false }
  });

  /* 方形母版 512（完整 logo） */
  const fullMaster = await shoot(win, 512, 512, 'full');
  fs.writeFileSync(path.join(OUT, '_master-square.png'), fullMaster.toPNG());

  /* 小图标母版 512（书页特写） */
  const cropMaster = await shoot(win, 512, 512, 'crop');
  fs.writeFileSync(path.join(OUT, '_master-crop.png'), cropMaster.toPNG());

  /* 宽版母版 620x300（完整 logo，等比缩到 310x150 不裁切） */
  const wideMaster = await shoot(win, 620, 300, 'full');
  fs.writeFileSync(path.join(OUT, '_master-wide.png'), wideMaster.toPNG());

  const square = nativeImage.createFromPath(path.join(OUT, '_master-square.png'));
  const crop = nativeImage.createFromPath(path.join(OUT, '_master-crop.png'));
  const wide = nativeImage.createFromPath(path.join(OUT, '_master-wide.png'));

  const plan = [
    ['StoreLogo.png', crop, 50, 50],
    ['Square44x44Logo.png', crop, 44, 44],
    ['Square71x71Logo.png', crop, 71, 71],
    ['Square150x150Logo.png', square, 150, 150],
    ['Square310x310Logo.png', square, 310, 310],
    ['Wide310x150Logo.png', wide, 310, 150],
  ];
  for (const [name, img, w, h] of plan) {
    const out = img.resize({ width: w, height: h, quality: 'best' });
    const file = path.join(OUT, name);
    fs.writeFileSync(file, out.toPNG());
    console.log(`${name.padEnd(24)} ${w}x${h}  ${fs.statSync(file).size}B`);
  }

  for (const tmp of ['_master-square.png', '_master-crop.png', '_master-wide.png']) {
    fs.unlinkSync(path.join(OUT, tmp));
  }
  app.exit(0);
});
