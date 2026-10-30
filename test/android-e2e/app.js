'use strict';
/**
 * 安卓端 UI 端到端仿真（不需要 adb / 模拟器）
 *
 * 在真实 Chromium（Electron）里加载**真实的 ui/index.html**，用 Node 实现一份
 * MoNativeBridge（等价于 MainActivity 注入的原生层），然后把窗口开成真机尺寸，
 * 于是可以真查布局、真点按钮、真改窗口尺寸模拟旋转 / 折叠屏开合。
 *
 *   node build/gen-nodebundle.js && electron test/android-e2e
 *
 * 重点覆盖两类线上问题：
 *   1. 界面脚本没加载 → window.mo 不存在 → 所有按钮点不动（无任何报错）
 *   2. 横竖屏 / 折叠屏形态没切换 → 该在底部的功能栏还在左边
 */
const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('fs');
const path = require('path');

// 兜底路径要用同步 XHR 读 ../nodebundle.js，得放开 file:// 的同源限制
app.commandLine.appendSwitch('allow-file-access-from-files');
app.commandLine.appendSwitch('disable-lcd-text');

const ROOT = path.join(__dirname, '..', '..');
const RUN = path.join(__dirname, '..', '.run');
const UI = path.join(ROOT, 'ui');
const BUNDLE = path.join(ROOT, 'android', 'app', 'src', 'main', 'assets', 'nodebundle.js');

const pass = [], fail = [];
const pageErrors = [];
const sleep = ms => new Promise(r => setTimeout(r, ms));

// 每个场景跑完都会关掉自己的窗口；不拦这个事件的话，
// 「最后一个窗口关闭」会被当成退出信号，第二个场景根本没机会跑
app.on('window-all-closed', e => { if (e && e.preventDefault) e.preventDefault(); });

function ok(name, cond, extra) {
  (cond ? pass : fail).push(name);
  process.stdout.write((cond ? '    ✓ ' : '    ✗ ') + name + (extra ? '  → ' + extra : '') + '\n');
}

function bucketOf(sw) { return sw >= 840 ? 'expanded' : sw >= 600 ? 'medium' : 'compact'; }

/* ------------------------------------------------------------------
 * 搭台：把 ui/ 复制一份，bridge.js 按安卓打包的方式写入
 *   stage          —— bridge.js = nodebundle.js 内容（修复后的打包方式）
 *   stage-fallback —— bridge.js = ui/bridge.js 兜底脚本（模拟「替换没生效」）
 * ------------------------------------------------------------------ */
function buildStage(name, bridgeContent) {
  const dir = path.join(RUN, name);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(path.join(dir, 'ui'), { recursive: true });
  for (const f of fs.readdirSync(UI)) {
    if (/\.(html|js|css)$/.test(f) && f !== 'bridge.js') {
      fs.copyFileSync(path.join(UI, f), path.join(dir, 'ui', f));
    }
  }
  fs.writeFileSync(path.join(dir, 'ui', 'bridge.js'), bridgeContent, 'utf8');
  fs.copyFileSync(BUNDLE, path.join(dir, 'nodebundle.js'));
  return dir;
}

/* ------------------------------------------------------------------
 * 页面探针
 * ------------------------------------------------------------------ */
const PROBE = `(() => {
  const de = document.documentElement;
  const rail = document.getElementById('rail');
  const rr = rail ? rail.getBoundingClientRect() : null;
  const btns = [].slice.call(document.querySelectorAll('.rail-btn'));
  const setBtn = document.querySelector('.rail-btn[data-view="settings"]');
  const sr = setBtn ? setBtn.getBoundingClientRect() : null;
  const cs = getComputedStyle(de);
  return {
    mo: !!window.mo,
    moNative: !!window.MoNative,
    layout: de.getAttribute('data-layout'),
    sw: de.getAttribute('data-sw'),
    isAndroid: de.classList.contains('is-android'),
    winbtns: !!document.querySelector('.winbtns'),
    dropzone: !!document.querySelector('.dropzone'),
    vw: innerWidth, vh: innerHeight,
    rail: rr ? { l: Math.round(rr.left), t: Math.round(rr.top), w: Math.round(rr.width), h: Math.round(rr.height) } : null,
    btnCount: btns.length,
    minBtnH: btns.length ? Math.round(Math.min.apply(null, btns.map(b => b.getBoundingClientRect().height))) : 0,
    setBtn: sr ? { l: Math.round(sr.left), t: Math.round(sr.top), w: Math.round(sr.width), h: Math.round(sr.height) } : null,
    corner: (cs.getPropertyValue('--corner') || '').trim(),
    cornerTL: (cs.getPropertyValue('--corner-tl') || '').trim(),
    saTop: (cs.getPropertyValue('--sa-top') || '').trim(),
    appbar: Math.round((document.querySelector('.titlebar') || { getBoundingClientRect: () => ({ height: 0 }) }).getBoundingClientRect().height)
  };
})()`;

// 命中测试：按钮中心那个点上，最顶层元素是不是它 —— 点不动多半是这里被挡了
const HITTEST = `(() => {
  const b = document.querySelector('.rail-btn[data-view="settings"]');
  if (!b) return { ok: false, why: '找不到设置按钮' };
  const r = b.getBoundingClientRect();
  const rail = document.getElementById('rail');
  const el = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
  const cn = el && el.className;
  return {
    ok: !!el && (el === b || b.contains(el)),
    at: el ? ((el.getAttribute && el.getAttribute('data-view')) ||
              (cn && cn.baseVal !== undefined ? cn.baseVal : cn) || el.tagName) : 'null',
    rect: { l: Math.round(r.left), t: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) },
    rail: { sh: rail.scrollHeight, ch: rail.clientHeight },
    vh: innerHeight
  };
})()`;

// 真点：点设置 → 视图切到设置；再点书架 → 回到书架
const CLICK = `(() => {
  const setB = document.querySelector('.rail-btn[data-view="settings"]');
  const shB  = document.querySelector('.rail-btn[data-view="shelf"]');
  if (!setB || !shB) return { ok: false, why: '找不到导航按钮' };
  setB.click();
  const toSettings = !!(document.getElementById('view-settings') || {}).classList &&
                     document.getElementById('view-settings').classList.contains('active');
  const railActive = setB.classList.contains('active');
  shB.click();
  const backShelf = document.getElementById('view-shelf').classList.contains('active');
  return { ok: toSettings && backShelf && railActive, toSettings, railActive, backShelf };
})()`;

async function probe(win) {
  return win.webContents.executeJavaScript(PROBE, true);
}

/* ------------------------------------------------------------------
 * 场景
 * ------------------------------------------------------------------ */
async function openWindow(stage, w, h, sc) {
  const win = new BrowserWindow({
    width: w, height: h, show: false, frame: false, resizable: true,
    backgroundColor: '#ffffff',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: false, sandbox: false, nodeIntegration: false, webSecurity: false
    }
  });
  win.setContentSize(w, h, false);
  await win.loadFile(path.join(stage, 'ui', 'index.html'));
  await sleep(400);
  // 把「设备参数」推给页面（等价于原生 env.layout / env.insets / env.corners）
  win.webContents.send('moread:cfg', {
    sw: sc.sw, bucket: bucketOf(sc.sw),
    insets: sc.insets || { top: 24, bottom: 16, left: 0, right: 0 },
    corners: sc.corners || { tl: 32, tr: 32, bl: 32, br: 32 },
    dataDir: path.join(RUN, 'data')
  });
  await win.webContents.executeJavaScript(
    'try{window.MoApp&&window.MoApp.onLayout&&window.MoApp.onLayout(null,{sw:' + sc.sw + '})}catch(e){}', true);
  await sleep(500);
  return win;
}

async function scenario(sc) {
  console.log('\n  ▸ ' + sc.title + '   ' + sc.w + '×' + sc.h + '  sw=' + sc.sw);
  const stage = path.join(RUN, sc.stage || 'stage');
  const win = await openWindow(stage, sc.w, sc.h, sc);
  const p = await probe(win);

  if (sc.allowNoMo) ok('（本场景故意不加载兼容层）', !p.mo);
  else {
    ok('界面脚本已加载（window.mo 存在）', p.mo);
    ok('原生层标记已生效（window.MoNative）', p.moNative);
  }
  ok('视口尺寸正确', p.vw === sc.w && p.vh === sc.h, p.vw + '×' + p.vh);
  ok('形态 = ' + sc.expectLayout, p.layout === sc.expectLayout, '实际 ' + p.layout);
  ok('宽度档位 = ' + sc.expectSw, p.sw === sc.expectSw, '实际 ' + p.sw);
  ok('桌面端窗口按钮已摘除', p.winbtns === false);
  ok('桌面端拖放区已摘除', p.dropzone === false);
  ok('安卓标记已打上', p.isAndroid === true);
  ok('屏幕圆角 / 安全区有兜底值', sc.allowNoInset || (p.saTop !== '' && p.corner !== ''));

  const rail = p.rail;
  if (sc.expectRail === 'bottom') {
    ok('功能栏在底部（横排铺满）',
      rail.t > p.vh * 0.7 && rail.w > p.vw * 0.7, 'rail t=' + rail.t + ' w=' + rail.w + ' h=' + rail.h);
  } else {
    ok('功能栏在左侧（竖条）',
      rail.l < 4 && rail.w < 160 && rail.h > p.vh * 0.7, 'rail l=' + rail.l + ' w=' + rail.w + ' h=' + rail.h);
  }

  ok('七个入口都在', p.btnCount === 7, '实际 ' + p.btnCount + ' 个');
  ok('触摸目标 ≥ 40px', p.minBtnH >= 40, '最小 ' + p.minBtnH + 'px');

  const hit = await win.webContents.executeJavaScript(HITTEST, true);
  ok('设置按钮命中测试通过（没被遮挡）', hit.ok,
    String(hit.at || '') + ' rect=' + JSON.stringify(hit.rect) + ' rail=' + JSON.stringify(hit.rail) + ' vh=' + hit.vh);

  if (sc.clicks !== false) {
    const click = await win.webContents.executeJavaScript(CLICK, true);
    ok('点击「设置」能切到设置页', click.ok,
      '切过去=' + click.toSettings + ' 高亮=' + click.railActive + ' 回书架=' + click.backShelf);
  }

  ok('屏幕圆角变量已写入', sc.allowNoInset || (p.corner !== '' && p.corner !== '0px'), '--corner=' + p.corner + ' tl=' + p.cornerTL);
  ok('安全区变量已写入', sc.allowNoInset || p.saTop === '24px', '--sa-top=' + p.saTop);
  ok('顶栏高度 52px（桌面是 44px）', p.appbar === 52, '实际 ' + p.appbar + 'px');

  if (sc.rotateTo) {
    const [rw, rh] = sc.rotateTo;
    win.setContentSize(rw, rh, false);
    await sleep(1000);
    const q = await probe(win);
    console.log('    ↻ 旋转到 ' + rw + '×' + rh);
    ok('旋转后形态 = ' + sc.rotateExpect, q.layout === sc.rotateExpect, '实际 ' + q.layout);
    const r2 = q.rail;
    if (sc.rotateRail === 'bottom') {
      ok('旋转后功能栏移到底部', r2.t > q.vh * 0.7 && r2.w > q.vw * 0.7, 'rail t=' + r2.t + ' w=' + r2.w);
    } else {
      ok('旋转后功能栏移到左侧', r2.l < 4 && r2.w < 160 && r2.h > q.vh * 0.7, 'rail l=' + r2.l + ' w=' + r2.w);
    }
    if (sc.clicks !== false) {
      const click2 = await win.webContents.executeJavaScript(CLICK, true);
      ok('旋转后按钮依然可点', click2.ok);
    }
  }

  if (sc.allowNoMo) {
    // 兼容层挂掉时必须自动弹出自检面板，否则用户面对的就是一个「安静的死界面」
    await sleep(3000);
    const panel = await win.webContents.executeJavaScript(
      `!!document.getElementById('mo-diag')`, true).catch(() => false);
    ok('兼容层挂掉时自检面板自动弹出', panel === true);
  }

  await new Promise(r => { win.once('closed', r); win.close(); });
  await sleep(400);
}

/* 顺带把自检面板本身也验一遍：它在正常环境下各项是否真的 OK。
   这同时等于验了文件读写 / zlib / 大文件 XHR / 联网这几条真实数据通路。 */
async function diagScenario() {
  console.log('\n  ▸ 自检面板内容核对（正常环境）');
  const R32 = { tl: 32, tr: 32, bl: 32, br: 32 };
  const win = await openWindow(path.join(RUN, 'stage'), 393, 873, { sw: 393, corners: R32 });
  await win.webContents.executeJavaScript('window.__moreadDiag(null)', true);
  await sleep(3500);
  const txt = await win.webContents.executeJavaScript(
    `(function(){var p=document.getElementById('mo-diag');return p?(p.innerText||p.textContent):''})()`, true);
  const netLine = (txt.match(/联网测试：.*/) || ['（没读到）'])[0];
  ok('自检面板能打开', txt.length > 200);
  ok('bundle 已执行', /bundle 已执行[\s\S]{0,80}是/.test(txt));
  ok('文件读写一致 = OK', /文件读写一致[\s\S]{0,40}OK/.test(txt));
  ok('大文件 XHR 一致 = OK', /大文件 XHR[\s\S]{0,90}OK/.test(txt));
  ok('zlib = OK', /zlib[\s\S]{0,30}OK/.test(txt));
  ok('联网测试 = HTTP 200', /HTTP 200/.test(netLine), netLine);
  ok('无页面错误记录', !/\[error\]/.test(txt));
  await new Promise(r => { win.once('closed', r); win.close(); });
  await sleep(300);
}

async function main() {
  if (!fs.existsSync(BUNDLE)) {
    console.error('缺少 nodebundle.js，请先跑： node build/gen-nodebundle.js');
    app.exit(2); return;
  }
  ipcMain.on('moread:pageerror', (_e, m) => { pageErrors.push(m); process.stdout.write('    ! 页面报错: ' + m + '\n'); });

  const bundle = fs.readFileSync(BUNDLE, 'utf8');
  const guard = fs.readFileSync(path.join(UI, 'bridge.js'), 'utf8');
  buildStage('stage', bundle);
  buildStage('stage-fallback', guard);
  // 模拟最坏情况：兼容层因为打包失败 / 旧 WebView 语法不兼容，脚本一个字都没执行
  buildStage('stage-dead', '/* 模拟 nodebundle.js 完全没跑起来 */\n');
  fs.rmSync(path.join(RUN, 'data'), { recursive: true, force: true });
  fs.mkdirSync(path.join(RUN, 'data'), { recursive: true });

  const R32 = { tl: 32, tr: 32, bl: 32, br: 32 };
  const scenarios = [
    { title: '手机 竖屏', stage: 'stage', w: 393, h: 873, sw: 393, expectLayout: 'portrait', expectSw: 'compact', expectRail: 'bottom',
      rotateTo: [873, 393], rotateExpect: 'landscape', rotateRail: 'left', corners: R32 },
    { title: '手机 横屏', stage: 'stage', w: 873, h: 393, sw: 393, expectLayout: 'landscape', expectSw: 'compact', expectRail: 'left',
      rotateTo: [393, 873], rotateExpect: 'portrait', rotateRail: 'bottom', corners: R32 },
    { title: '折叠屏展开 竖握', stage: 'stage', w: 717, h: 1024, sw: 717, expectLayout: 'portrait', expectSw: 'medium', expectRail: 'bottom', corners: R32 },
    { title: '折叠屏展开 横握', stage: 'stage', w: 1024, h: 717, sw: 717, expectLayout: 'wide', expectSw: 'medium', expectRail: 'left', corners: R32 },
    { title: '平板 竖屏', stage: 'stage', w: 800, h: 1280, sw: 800, expectLayout: 'portrait', expectSw: 'medium', expectRail: 'bottom', corners: { tl: 20, tr: 20, bl: 20, br: 20 } },
    { title: '平板 横屏', stage: 'stage', w: 1280, h: 800, sw: 800, expectLayout: 'wide', expectSw: 'medium', expectRail: 'left', corners: { tl: 20, tr: 20, bl: 20, br: 20 } },
    { title: '小屏手机 竖屏（360dp）', stage: 'stage', w: 360, h: 780, sw: 360, expectLayout: 'portrait', expectSw: 'compact', expectRail: 'bottom', corners: R32 },
    { title: '兜底：bridge.js 未被替换时自救', stage: 'stage-fallback', w: 393, h: 873, sw: 393, expectLayout: 'portrait', expectSw: 'compact', expectRail: 'bottom', corners: R32 },
    { title: '极端：兼容层完全没执行（旧 WebView / 打包失败）', stage: 'stage-dead', w: 393, h: 873, sw: 393,
      expectLayout: 'portrait', expectSw: 'compact', expectRail: 'bottom', corners: R32,
      clicks: false, allowNoMo: true, allowNoInset: true }
  ];

  for (const sc of scenarios) {
    try { await scenario(sc); }
    catch (e) { ok(sc.title + ' 场景执行异常', false, String(e && e.message || e)); }
  }
  try { await diagScenario(); }
  catch (e) { ok('自检面板场景执行异常', false, String(e && e.message || e)); }

  console.log('\n' + '─'.repeat(64));
  console.log('  通过 ' + pass.length + ' 项，失败 ' + fail.length + ' 项');
  if (fail.length) { console.log('\n  失败明细：'); fail.forEach(f => console.log('    ✗ ' + f)); }
  if (pageErrors.length) { console.log('\n  页面报错 ' + pageErrors.length + ' 条'); }
  console.log('─'.repeat(64) + '\n');
  app.exit(fail.length ? 1 : 0);
}

app.whenReady().then(main);
