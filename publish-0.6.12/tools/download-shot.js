const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');
app.whenReady().then(async () => {
  const w = new BrowserWindow({ width: 390, height: 1500, show: false, webPreferences: { offscreen: true } });
  await w.loadFile(path.resolve('dist-web/download.html'));
  await new Promise(r => setTimeout(r, 900));
  const size = await w.webContents.executeJavaScript('JSON.stringify({w:innerWidth,scroll:document.body.scrollWidth,btn:Math.round(document.querySelector(".item a").getBoundingClientRect().right)})');
  const img = await w.webContents.capturePage();
  fs.writeFileSync('.tmp-pub/out/download-phone-real.png', img.toPNG());
  console.log('MEASURE ' + size);
  app.quit();
});
