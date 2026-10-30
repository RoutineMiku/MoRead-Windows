'use strict';
/**
 * 安卓端 Node 兼容层的离线验证。
 *
 * 没有 adb / 模拟器也能验证：用 Node 自带能力把 bridge 依赖的原生方法（file / zlib / dialog）
 * 就地实现一遍，再把 MainActivity 注入给 WebView 的 nodebundle.js 原样跑起来，
 * 于是 src/store.js src/zip.js src/legado.js 会在「安卓路径」上被真实执行（走的是 polyfill 的 Buffer）。
 *
 * 跑法： node test/android-sim.js [备份zip路径]
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const zlib = require('zlib');

const ROOT = path.join(__dirname, '..');
const BUNDLE = path.join(ROOT, 'android', 'app', 'src', 'main', 'assets', 'nodebundle.js');
const { readZip } = require(path.join(ROOT, 'src', 'zip.js'));

process.on('unhandledRejection', e => {
  console.error('未处理的 Promise 拒绝：', e && (e.stack || e.message || e));
  process.exit(1);
});

const pass = [], fail = [];
const ok = (name, cond, extra) => {
  ((cond ? pass : fail).push(name + (extra ? ' → ' + extra : '')));
  process.stdout.write((cond ? '  ✓ ' : '  ✗ ') + name + (extra ? ' → ' + extra : '') + '\n');
};
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'mo-sim-'));

/* ==================================================================
 * 模拟 MainActivity 通过 addJavascriptInterface 暴露的原生方法
 * ================================================================== */
function callSync(name, json) {
  const a = JSON.parse(json || '{}');
  const R = obj => JSON.stringify(obj);
  const abs = p => (path.isAbsolute(p) ? p : path.join(DATA, p));

  if (name === 'env.info') return R({ app: 'moread', platform: 'android', version: '2.1.0', paths: { root: DATA } });
  if (name === 'env.webview') return R({ pkg: 'com.android.webview（测试桩）' });
  if (name === 'env.layout') return R({ mode: 'portrait', sw: 360, bucket: 'compact' });
  if (name === 'env.insets') return R({ top: 24, bottom: 16, left: 0, right: 0 });
  // 屏幕圆角（模拟一台四角 32px 圆角的手机）
  if (name === 'env.corners') return R({ tl: 32, tr: 32, bl: 32, br: 32 });

  if (name.startsWith('file.')) {
    switch (name.slice(5)) {
      case 'exists': return R({ exists: fs.existsSync(abs(a.path)) });
      case 'stat': {
        const p = abs(a.path);
        if (!fs.existsSync(p)) return R({ exists: false, size: 0, isDir: false, mtime: 0 });
        const st = fs.statSync(p);
        return R({ exists: true, size: st.size, isDir: st.isDirectory(), mtime: st.mtimeMs });
      }
      case 'mkdir': return R({ ok: (fs.mkdirSync(abs(a.path), { recursive: true }), true) });
      case 'list': {
        const p = abs(a.path);
        if (!fs.existsSync(p)) return R({ items: [] });
        return R({
          items: fs.readdirSync(p).map(n => {
            const st = fs.statSync(path.join(p, n));
            return { name: n, isDir: st.isDirectory(), size: st.size };
          })
        });
      }
      case 'read': {
        const p = abs(a.path);
        if (!fs.existsSync(p)) throw new Error('文件不存在: ' + p);
        const buf = fs.readFileSync(p);
        const out = { size: buf.length, abs: 'file://' + p };
        if (out.size > 512 * 1024) { out.tooBig = true; return R(out); }
        if (a.text) {
          const s = buf.toString('utf8');
          if ((s.match(/\uFFFD/g) || []).length * 3 > out.size / 4) { out.tooBig = true; return R(out); }
          out.text = s;
        } else out.b64 = buf.toString('base64');
        return R(out);
      }
      case 'write': {
        const p = abs(a.path);
        fs.mkdirSync(path.dirname(p), { recursive: true });
        const buf = a.b64 != null ? Buffer.from(a.b64, 'base64') : Buffer.from(a.text || '', 'utf8');
        if (a.append) fs.appendFileSync(p, buf); else fs.writeFileSync(p, buf);
        return R({ ok: true, size: fs.statSync(p).size });
      }
      case 'copy': return R({ ok: (fs.mkdirSync(path.dirname(abs(a.to)), { recursive: true }), fs.copyFileSync(abs(a.from), abs(a.to)), true) });
      case 'rename': fs.renameSync(abs(a.from), abs(a.to)); return R({ ok: true });
      case 'remove': fs.rmSync(abs(a.path), { recursive: true, force: true }); return R({ ok: true });
      case 'abs': return R({ abs: 'file://' + abs(a.path) });
      case 'stage': {
        const dst = path.join(DATA, 'tmp', Date.now() + '-' + path.basename(a.path));
        fs.mkdirSync(path.dirname(dst), { recursive: true });
        fs.copyFileSync(a.path, dst);
        return R({ path: dst });
      }
    }
  }

  if (name.startsWith('zlib.')) {
    const buf = Buffer.from(a.b64, 'base64');
    const ops = {
      inflateRaw: () => zlib.inflateRawSync(buf), inflate: () => zlib.inflateSync(buf),
      gunzip: () => zlib.gunzipSync(buf), deflateRaw: () => zlib.deflateRawSync(buf),
      deflate: () => zlib.deflateSync(buf), gzip: () => zlib.gzipSync(buf)
    };
    const op = ops[name.slice(5)];
    if (!op) throw new Error('未知压缩操作 ' + name);
    try { return R({ b64: op().toString('base64') }); }
    catch (e) { return R({ error: e.message }); }
  }

  /* ---- 网络（对应 MoNet.kt）：桥接是同步的，这里用子进程同步等结果 ---- */
  if (name === 'http.request') return R(httpRequestSync(a));

  /* 模拟用系统文件管理器保存（走完整 buildBackupZip → writeZip → deflateRaw 链路） */
  if (name === 'dialog.save') {
    const dir = path.join(DATA, 'export');
    fs.mkdirSync(dir, { recursive: true });
    const dest = path.join(dir, a.name || 'out.bin');
    fs.writeFileSync(dest, a.b64 ? Buffer.from(a.b64, 'base64') : Buffer.from(a.text || '', 'utf8'));
    return R({ ok: true, path: dest, size: fs.statSync(dest).size });
  }
  if (name === 'dialog.open') return R({ ok: true, items: [] });

  if (name === 'tts.voices') return R({ voices: [{ id: 'default', name: '系统默认', lang: 'zh-CN', network: false }], ready: true });
  if (name === 'tts.state') return R({ speaking: false, ready: true, voice: 'default' });
  if (name.startsWith('tts.')) return R({ ok: true });
  if (name.startsWith('win.')) return R({ ok: true, full: false });
  if (name.startsWith('app.') || name.startsWith('ui.')) return R({ ok: true });

  throw new Error('模拟器还没实现: ' + name);
}

function httpRequestSync(a) {
  const script = `
    const http=require('http'),https=require('https'),{URL}=require('url');
    const a=JSON.parse(process.argv[1]);
    const out=s=>process.stdout.write(typeof s==='string'?s:JSON.stringify(s));
    try{
      const u=new URL(a.url);
      const mod=u.protocol==='https:'?https:http;
      const req=mod.request({
        hostname:u.hostname,port:u.port,path:u.pathname+u.search,
        method:a.method||'GET',headers:a.headers||{},timeout:a.timeout||18000,
        rejectUnauthorized:!a.insecure
      },r=>{
        const c=[];let n=0;const cap=(a.maxBytes)||12e6;
        r.on('data',d=>{n+=d.length;if(n<=cap)c.push(d);});
        r.on('end',()=>{
          const h={};for(const k of Object.keys(r.headers))h[k.toLowerCase()]=r.headers[k];
          out({status:r.statusCode,headers:h,url:a.url,b64:Buffer.concat(c).toString('base64')});
        });
      });
      req.on('timeout',()=>{req.destroy();out({error:'请求超时'})});
      req.on('error',e=>out({error:e.message,code:e.code||''}));
      if(a.bodyB64)req.write(Buffer.from(a.bodyB64,'base64'));
      req.end();
    }catch(e){out({error:e.message})}
  `;
  try {
    const r = require('child_process').spawnSync(process.execPath, ['--no-warnings', '-e', script, JSON.stringify(a)], {
      encoding: 'utf8', timeout: (a.timeout || 18000) + 8000
    });
    const s = String(r.stdout || '').trim();
    const i = s.indexOf('{'), j = s.lastIndexOf('}');
    if (i < 0 || j < 0) return { error: '子进程没有返回结果' };
    return JSON.parse(s.slice(i, j + 1));
  } catch (e) {
    return { error: e.message };
  }
}

/* ==================================================================
 * 最小浏览器环境
 * ================================================================== */
function makeSandbox() {
  const win = {
    addEventListener() { }, removeEventListener() { }, dispatchEvent() { },
    // 视口尺寸：形态判定以它为准（原生推送只当参考），测试里会改这两个值模拟旋转 / 折叠屏开合
    innerWidth: 393, innerHeight: 873,
    setTimeout, clearTimeout, setInterval, clearInterval, queueMicrotask,
    TextEncoder, TextDecoder, URL, URLSearchParams, CustomEvent, console, Promise,
    navigator: { userAgent: 'Mozilla/5.0 Chrome/126 MoReadAndroid/2.1.0' },
    performance: { now: () => Date.now() },
    // 安卓上大文件是走 XHR 读 file:// 的，这里真实读盘，好验证那条兜底路径
    XMLHttpRequest: function () {
      this.readyState = 0; this.status = 0; this.responseText = ''; this.response = null;
      this.open = (m, u) => { this.__url = u; };
      this.overrideMimeType = () => { };
      this.setRequestHeader = () => { };
      this.send = () => {
        let buf = null;
        try {
          buf = fs.readFileSync(String(this.__url || '').replace(/^file:\/\//, ''));
        } catch (e) { /* 读不到就走 onerror */ }
        if (buf) {
          this.status = 200;
          this.responseText = buf.toString('latin1');
          this.response = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length);
          setTimeout(() => { if (typeof this.onload === 'function') this.onload(); }, 0);
        } else {
          this.status = 0;
          setTimeout(() => { if (typeof this.onerror === 'function') this.onerror(new Error('读取失败')); }, 0);
        }
      };
    }
  };
  /* 真实记录状态的 DOM 桩：用来验证「布局标记一定打得上、桌面窗口按钮一定被摘掉」 */
  const domAttrs = {};
  const domClasses = new Set();
  const domVars = {};
  const removed = [];
  const mkEl = name => ({
    __el: name,
    style: { setProperty() { } },
    parentNode: {
      removeChild(el) {
        removed.push(el.__el);
        if (el.__el === '.winbtns') winbtns = null;
        else if (el.__el === '.dropzone') dropzone = null;
      }
    }
  });
  let winbtns = mkEl('.winbtns');
  let dropzone = mkEl('.dropzone');
  const doc = {
    __attrs: domAttrs, __classes: domClasses, __removed: removed, __vars: domVars,
    readyState: 'complete',
    body: { classList: { add() { }, remove() { }, toggle() { }, contains: () => false } },
    documentElement: {
      setAttribute(k, v) { domAttrs[k] = String(v); },
      getAttribute(k) { return k in domAttrs ? domAttrs[k] : null; },
      classList: { add(c) { domClasses.add(c); }, remove(c) { domClasses.delete(c); }, contains: c => domClasses.has(c) },
      style: { setProperty(k, v) { domVars[k] = String(v); } },
      addEventListener() { }, dispatchEvent() { }
    },
    addEventListener() { }, dispatchEvent() { },
    querySelector(sel) {
      if (sel === '.winbtns') return winbtns;
      if (sel === '.dropzone') return dropzone;
      return null;
    },
    querySelectorAll(sel) {
      const out = [];
      if (sel.includes('.winbtns') && winbtns) out.push(winbtns);
      if (sel.includes('.dropzone') && dropzone) out.push(dropzone);
      return out;
    }
  };
  const sb = {
    window: win, document: doc, self: win,
    console, setTimeout, clearTimeout, setInterval, clearInterval, queueMicrotask,
    TextEncoder, TextDecoder, URL, URLSearchParams, CustomEvent, Promise, JSON, Date, Math,
    XMLHttpRequest: win.XMLHttpRequest, navigator: win.navigator
  };
  sb.globalThis = sb;
  sb.MoNativeBridge = { callSync, callFire: () => { } };
  return { sb, win };
}

(async () => {
  try { await run(); } catch (e) {
    console.error('测试中断：', e && (e.stack || e.message || e));
    fs.rmSync(DATA, { recursive: true, force: true });
    process.exit(1);
  }
})();

async function run() {
  const { sb, win } = makeSandbox();
  try {
    vm.runInNewContext(fs.readFileSync(BUNDLE, 'utf8'), sb, { filename: 'nodebundle.js' });
  } catch (e) {
    console.error('bundle 执行失败：', e);
    process.exit(1);
  }

  ok('bridge 加载后 window.mo 就绪', !!win.mo);
  ok('Web Speech API 已被原生接管', typeof win.SpeechSynthesisUtterance === 'function');

  /* ---- 0. 界面形态：这两个没生效，界面就会退回电脑版（小控件 + 右上角关闭按钮） ---- */
  const D = sb.document;
  ok('布局标记已打上 data-layout', !!D.__attrs['data-layout'], D.__attrs['data-layout']);
  ok('已标记 is-android', D.__classes.has('is-android'));
  ok('桌面窗口按钮已摘除', D.__removed.includes('.winbtns'), D.__removed.join(',') || '(无)');
  ok('桌面拖放区已摘除', D.__removed.includes('.dropzone'));
  ok('安全区已写入 CSS 变量', !!D.__vars['--sa-top'], D.__vars['--sa-top']);
  ok('屏幕圆角已写入 CSS 变量', D.__vars['--corner'] === '32px', D.__vars['--corner']);

  /* ---- 0b. 横竖屏 / 折叠屏形态判定 ----
     方向必须以视口宽高为准：原生推送可能丢、可能慢、也可能和视口不一致 */
  const mode = () => D.__attrs['data-layout'];
  const sw = () => D.__attrs['data-sw'];
  const rotate = (w, h, info) => { win.innerWidth = w; win.innerHeight = h; win.MoApp.onLayout(info.mode, info); };

  rotate(393, 873, { mode: 'portrait', sw: 393, bucket: 'compact' });
  ok('手机竖屏 → portrait（底部导航）', mode() === 'portrait', mode());
  ok('手机竖屏 → 档位 compact', sw() === 'compact', sw());

  rotate(393, 873, { mode: 'landscape', sw: 393, bucket: 'compact' });
  ok('原生误报横屏时仍按视口判竖屏', mode() === 'portrait', mode());

  rotate(873, 393, { mode: 'landscape', sw: 393, bucket: 'compact' });
  ok('手机横屏 → landscape（左侧栏）', mode() === 'landscape', mode());

  rotate(673, 841, { mode: 'portrait', sw: 673, bucket: 'medium' });
  ok('折叠屏展开竖握 → portrait + medium', mode() === 'portrait' && sw() === 'medium', mode() + '/' + sw());

  rotate(841, 673, { mode: 'landscape', sw: 673, bucket: 'medium' });
  ok('折叠屏展开横屏 → wide（左侧宽栏）', mode() === 'wide', mode());

  rotate(1280, 800, { mode: 'landscape', sw: 1280, bucket: 'expanded' });
  ok('平板横屏 → wide + expanded', mode() === 'wide' && sw() === 'expanded', mode() + '/' + sw());

  rotate(800, 1280, { mode: 'portrait', sw: 800, bucket: 'expanded' });
  ok('平板竖屏 → portrait（底部导航）+ expanded', mode() === 'portrait' && sw() === 'expanded', mode() + '/' + sw());

  const mo = win.mo;

  /* ---- 1. 存档读写：store.js + fs shim ---- */
  const st = mo.state.get();
  ok('默认存档可读', st && Array.isArray(st.books));
  ok('数据目录已建立', fs.existsSync(path.join(DATA, 'books')) && fs.existsSync(path.join(DATA, 'cache')));

  mo.state.set({
    books: [{ id: 'T1', name: '测试书', author: '甲', kind: 'online', total: 9, chapters: ['第一章'], sourceId: 'x' }],
    sources: [{ id: 's1', name: '测试源', searchUrl: 'https://a.com/s?q={{key}}', enabled: true }]
  });
  await new Promise(r => setTimeout(r, 400));
  const raw = fs.existsSync(path.join(DATA, 'data.json')) ? fs.readFileSync(path.join(DATA, 'data.json'), 'utf8') : '';
  ok('state.set 落盘', raw.includes('测试书'), (raw.length / 1024).toFixed(1) + 'KB');
  ok('重新读取一致', (mo.state.get().books || []).some(b => b.name === '测试书'));

  /* ---- 2. 缓存读写 ---- */
  mo.cache.set('T1', 0, { paras: ['段落一', '段落二'] });
  const ch = mo.cache.get('T1', 0);
  ok('章节缓存读写正常', ch && (ch.paras || []).length === 2);
  ok('缓存大小可统计', mo.cache.size() > 0, mo.cache.size() + 'B');

  /* ---- 3. 导出 Legado 兼容备份 zip：legado.js + zip.js + deflateRaw shim ---- */
  const exp = await mo.exportZip({ includeFiles: false });
  ok('导出备份 zip', exp.ok, exp.path ? path.basename(exp.path) : '');
  if (exp.ok) {
    const z = readZip(fs.readFileSync(exp.path));
    ok('zip 内含 Legado 格式条目', z.names.includes('bookSource.json') && z.names.includes('bookshelf.json'), z.names.join(','));
    const src = JSON.parse(z.readText('bookSource.json'));
    const books = JSON.parse(z.readText('bookshelf.json'));
    ok('书源/书架内容正确', src.length === 1 && books.length === 1, `源${src.length} 书${books.length}`);
    ok('导出含墨读完整数据', z.names.includes('moread.json'));
  }

  /* ---- 4. 真实 Legado 备份解析 ---- */
  const zipArg = process.argv[2];
  if (zipArg && fs.existsSync(zipArg)) {
    if (process.env.MO_DBG) {
      const stg = win.MoNative.call('file.stage', { path: zipArg });
      const ab = win.MoNative.call('file.abs', { path: stg.path });
      const rd = win.MoNative.call('file.read', { path: stg.path, text: false });
      console.log('[dbg] size=', rd.size, 'tooBig=', rd.tooBig, 'abs=', ab.abs.slice(0, 60));
    }
    const r = await mo.testImportZip(zipArg);
    ok('识别出 Legado 备份', r.ok && r.kind === 'legado', 'kind=' + r.kind + (r.error ? ' err=' + r.error : ''));
    const s = r.summary || {};
    ok('备份条目数解析正确', s.books > 0, `${s.books} 本 / ${s.sources} 源 / ${s.bookmarks} 书签`);
    const src = (r.legado && r.legado.sources) || [];
    ok('书源已转成墨读格式', src.length > 0, src[0] ? src[0].name + ' | ' + (src[0].bookUrlPattern || src[0].searchUrl || '') : '');
  } else {
    ok('（未提供备份文件，跳过解析用例）', true);
  }

  /* ---- 5. 朗读 ---- */
  const vs = await mo.tts.voices();
  ok('原生音色列表可读', vs.length > 0, vs[0] && vs[0].name);

  /* ---- 6. 本地书 TXT 解析 ---- */
  const txt = path.join(DATA, 'tmp', 'book.txt');
  fs.mkdirSync(path.dirname(txt), { recursive: true });
  fs.writeFileSync(txt, '测试小说\n第一章 起始\n这里是第一段内容。\n这里是第二段内容。\n第二章 继续\n后来发生了很多事。\n', 'utf8');
  const imported = await mo.importLocal([txt]);
  const okImport = (imported || []).filter(x => x && !x.error);
  ok('本地 TXT 导入并分章', okImport.length === 1 && okImport[0].chapters.length >= 2,
    okImport[0] ? `${okImport[0].name} ${okImport[0].chapters.length} 章` : (imported[0] && imported[0].error));
  if (okImport.length) {
    // 桌面/安卓都是「导入只返回书籍描述，由界面负责入架」，这里补上入架这一步
    mo.state.set({ books: [okImport[0]] });
    const c = await mo.localChapter({ bookId: okImport[0].id, idx: 0 });
    ok('本地章节可读取', c.ok && String(c.text || '').length > 0, String(c.title || '') + (c.error ? ' err=' + c.error : ''));
  }

  fs.rmSync(DATA, { recursive: true, force: true });

  /* ---- 7. 网络：net.js + http shim 真实发一次请求 ---- */
  const netR = await mo.net({ url: 'https://www.baidu.com/', charset: 'auto', timeout: 12000 });
  ok('网络请求走通（net.js + http shim）', netR.ok && String(netR.text || '').length > 500,
    netR.ok ? `${netR.status} ${netR.charset} ${String(netR.text).length}字 ${netR.ms}ms` : netR.error);

  console.log('\n通过 ' + pass.length + ' 项：');
  for (const p of pass) console.log('  ✓ ' + p);
  if (fail.length) {
    console.log('\n失败 ' + fail.length + ' 项：');
    for (const f of fail) console.log('  ✗ ' + f);
    process.exit(1);
  }
  console.log('\n安卓 Node 兼容层离线验证全部通过');
}
