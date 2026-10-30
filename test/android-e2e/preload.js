'use strict';
/**
 * 在页面脚本执行之前把 window.MoNativeBridge 装好 —— 等价于 MainActivity 里的
 * webView.addJavascriptInterface(bridge, "MoNativeBridge")。
 * 只有它存在，nodebundle.js 才会真正执行（runtime.js 开头就是
 * `if (typeof MoNativeBridge === 'undefined') return;`）。
 */
const { ipcRenderer } = require('electron');
const path = require('path');
const fs = require('fs');
const createNative = require('./native-stub.js');

const cfg = {
  dataDir: path.join(__dirname, '..', '.run', 'data'),
  sw: 393, bucket: '', mode: 'portrait',
  insets: { top: 24, bottom: 16, left: 0, right: 0 },
  corners: { tl: 32, tr: 32, bl: 32, br: 32 }
};
try { fs.mkdirSync(cfg.dataDir, { recursive: true }); } catch (e) { }

// 折叠屏开合、刘海变化都靠这条通道改 cfg，下次原生调用即生效
ipcRenderer.on('moread:cfg', (_e, patch) => Object.assign(cfg, patch));

const native = createNative(cfg);

window.MoNativeBridge = {
  callSync(name, json) {
    try {
      return native.call(name, json);
    } catch (e) {
      return JSON.stringify({ __error: true, error: String(e && e.message || e) });
    }
  },
  callFire() { /* 单向通知，测试里不需要 */ }
};

// 出错也要留痕，免得「页面白跑」这种事再次悄悄发生
window.addEventListener('error', ev => {
  try { require('electron').ipcRenderer.send('moread:pageerror', String(ev.message)); } catch (e) { }
});
