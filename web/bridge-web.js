'use strict';
/**
 * 墨读网页版 —— 浏览器「原生桥」
 *
 * 把安卓版 MoBridge.kt 的九大类操作（file / http / dialog / tts / env / app / win / ui / zlib）
 * 用纯浏览器 API 复刻一遍，于是 android/nodepoly/runtime.js 那份 Node 兼容层、以及桌面版
 * src/*.js 的全部业务逻辑（书架 / 书源引擎 / 备份 / 解析）一行不改地在网页里跑。
 *
 * 数据承诺：全部落在本机——
 *   状态与章节缓存 → IndexedDB（moread-fs 库，虚拟文件系统）
 *   设置           → localStorage
 *   网络请求       → 只在用户自填了「书源代理」时才经第三方转发；不填则只有本地书可用
 *
 * 加载顺序：本文件必须先于 bridge.js（Node 兼容层）执行——
 *   1) runtime.js 会检测 window.MoNativeBridge 是否存在；
 *   2) runtime.js 会用原生 TTS 顶掉 window.speechSynthesis，本文件要先存下浏览器原生引用。
 */
(function () {
  if (typeof window.MoNativeBridge !== 'undefined') return;   // 安卓 WebView / 已注入：不覆盖

  /* ---- 浏览器原生 speechSynthesis：runtime.js 的语音补丁会覆盖 window 上的同名对象，
          这里先抓一份真引用，tts.* 操作全部走它。 ---- */
  const nativeSpeech = window.speechSynthesis || null;
  const NativeUtterance = window.SpeechSynthesisUtterance || null;

  /* 手机浏览器 / 主屏幕 PWA → 安卓同款移动形态；键鼠宽屏 → 桌面版式 */
  const isPhone = (window.matchMedia && window.matchMedia('(pointer: coarse)').matches) || window.innerWidth < 760;

  /* ================================================================
   * 0. 持久化存储（IndexedDB 虚拟文件系统）
   *    路径即主键：/moread/data.json、/moread/books/x.txt、/moread/cache/parsed/x.json …
   * ================================================================ */
  const FS = new Map();          // path -> Uint8Array
  const DIRS = new Set();        // 显式 mkdir 过的目录
  const encoder = new TextEncoder();
  const decoder = new TextDecoder('utf-8');

  let idb = null;
  function idbOpen() {
    if (idb) return Promise.resolve(idb);
    return new Promise((resolve, reject) => {
      if (!window.indexedDB) { reject(new Error('浏览器不支持 IndexedDB')); return; }
      const req = indexedDB.open('moread-fs', 1);
      req.onupgradeneeded = () => { req.result.createObjectStore('files'); };
      req.onsuccess = () => { idb = req.result; resolve(idb); };
      req.onerror = () => reject(req.error || new Error('IndexedDB 打不开'));
    });
  }

  let saveT = null;
  const dirty = new Set();
  function markDirty(path) {
    dirty.add(path);
    if (saveT) return;
    saveT = setTimeout(flushDirty, 400);
  }
  async function flushDirty() {
    if (saveT) { clearTimeout(saveT); saveT = null; }
    if (!dirty.size) return;
    const paths = Array.from(dirty);
    dirty.clear();
    if (window.indexedDB) {
      try {
        const db = await idbOpen();
        await new Promise((resolve, reject) => {
          const tx = db.transaction('files', 'readwrite');
          const st = tx.objectStore('files');
          for (const p of paths) st.put(FS.get(p) || null, p);   // null = 已删除
          tx.oncomplete = resolve;
          tx.onerror = () => reject(tx.error);
        });
      } catch (e) { /* 本地缓存写失败不致命：内存里还有 */ }
    }
    /* 自建网关托管时，再把持久数据推到设备上 */
    if (remote) remotePush(paths).catch(() => { /* 网络断了就先留本地，下次改动再推 */ });
  }

  /* ================================================================
   * 0b. 设备端存储
   *   同源有 /api/fs（自建网关）时，存档写到这台机器上而不是只写浏览器：
   *   换设备 / 换浏览器 / 清缓存都不会丢，家里几台设备读的是同一份书架。
   *   只同步「持久数据」——data.json 与 books/covers/files/，
   *   章节缓存（cache/）与临时文件（tmp/）留在浏览器本地，不占设备空间。
   * ================================================================ */
  const REMOTE = '/api/fs';
  const isDurable = p => p === '/moread/data.json' || /^\/moread\/(books|covers|files)\//.test(String(p));
  let remote = false;
  let remoteRoot = '';              // 设备上真实的存档目录，仅用于界面展示
  const verCache = new Map();       // path -> 服务端版本号
  let conflictAt = 0;

  async function remoteProbe() {
    try {
      const r = await fetch(REMOTE + '/ping', { cache: 'no-store' });
      if (!r.ok) return false;
      const j = await r.json();
      if (j && j.ok === true && j.mode === 'device') { remoteRoot = String(j.root || ''); return true; }
      return false;
    } catch (e) { return false; }
  }

  async function remoteGet(path) {
    try {
      const r = await fetch(REMOTE + '?path=' + encodeURIComponent(path), { cache: 'no-store' });
      if (!r.ok) return null;
      const buf = new Uint8Array(await r.arrayBuffer());
      const ver = r.headers.get('X-Fs-Version') || '';
      if (ver) verCache.set(path, ver);
      return buf;
    } catch (e) { return null; }
  }

  /** 启动时把设备上的文件拉进来；onlyState=true 只拉 data.json（先把书架显示出来） */
  async function remotePull(onlyState) {
    let files = [];
    try {
      const r = await fetch(REMOTE + '/list', { cache: 'no-store' });
      const j = await r.json();
      files = (j && j.files) || [];
    } catch (e) { return 0; }
    if (onlyState) files = files.filter(f => f.path === '/moread/data.json').slice(0, 1);
    else files = files.filter(f => f.path !== '/moread/data.json');
    let n = 0;
    for (const f of files) {
      const buf = await remoteGet(f.path);
      if (!buf) continue;
      FS.set(f.path, buf);
      ensureDir(dirname(f.path));
      if (!f.version) verCache.set(f.path, '');
      n++;
    }
    return n;
  }

  async function remotePush(paths) {
    for (const p of paths) {
      if (!isDurable(p)) continue;
      const data = FS.get(p);
      const ver = verCache.get(p) || '';
      const q = REMOTE + '?path=' + encodeURIComponent(p) + (ver ? '&if=' + encodeURIComponent(ver) : '');
      try {
        if (data == null) {
          const r = await fetch(q, { method: 'DELETE' });
          if (r.ok) verCache.delete(p);
          continue;
        }
        const r = await fetch(q, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/octet-stream' },
          body: data
        });
        if (r.status === 409) {
          /* 别的设备刚写过这份数据：宁可停下来说清楚，也不静默把人家覆盖掉 */
          const j = await r.json().catch(() => ({}));
          if (j && j.version) verCache.set(p, j.version);
          remoteConflict();
          return;
        }
        if (r.ok) {
          const j = await r.json().catch(() => ({}));
          if (j && j.version) verCache.set(p, j.version);
        }
      } catch (e) { /* 断网：留在本地缓存，下次改动再推 */ }
    }
  }

  function remoteConflict() {
    const now = Date.now();
    if (now - conflictAt < 8000) return;
    conflictAt = now;
    toast('另一台设备刚更新了书架，正在同步最新数据…');
    /* 直接用服务端版本覆盖内存态再刷新，避免两边数据混着写 */
    remotePull(true).then(() => {
      DIRS.add('/moread');
      setTimeout(() => { try { location.reload(); } catch (e) { } }, 1200);
    }).catch(() => { });
  }

  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flushDirty(); });
  window.addEventListener('beforeunload', () => flushDirty());

  async function fsLoadAll() {
    if (!window.indexedDB) return;
    try {
      const db = await idbOpen();
      await new Promise((resolve, reject) => {
        const tx = db.transaction('files', 'readonly');
        const st = tx.objectStore('files');
        const cur = st.openCursor();
        cur.onsuccess = () => {
          const c = cur.result;
          if (c) { if (c.value) FS.set(c.key, c.value); DIRS.add(dirname(String(c.key))); c.continue(); }
          else resolve();
        };
        cur.onerror = () => reject(cur.error);
      });
    } catch (e) { /* 空库 / 私密模式：从零开始 */ }
  }

  /* ================================================================
   * 1. 路径工具（只支持 posix 风格绝对路径）
   * ================================================================ */
  function normalize(p) {
    const abs = String(p).startsWith('/');
    const out = [];
    for (const part of String(p).split('/')) {
      if (!part || part === '.') continue;
      if (part === '..') out.pop(); else out.push(part);
    }
    return (abs ? '/' : '') + out.join('/');
  }
  function dirname(p) { const t = normalize(p).split('/'); t.pop(); return t.join('/') || '/'; }
  function ensureDir(p) { DIRS.add(normalize(p)); }
  function isDir(p) { return DIRS.has(normalize(p)); }

  /* ================================================================
   * 2. 书源代理（用户自填，默认空 = 不发任何网络请求）
   *    约定：<代理地址>?url=<encodeURIComponent(原始地址)>
   *    自建网关托管时会注入 <meta name="moread-proxy" content="/fetch?format=text">，
   *    此时默认就用同源 /fetch，手机第一次打开即可搜书，不必手工填地址。
   * ================================================================ */
  const PROXY_KEY = 'moread.proxy';
  function metaProxy() {
    try {
      const m = document.querySelector('meta[name="moread-proxy"]');
      return m && m.content ? new URL(m.content, location.href).href : '';
    } catch (e) { return ''; }
  }
  function getProxy() {
    try {
      const v = (localStorage.getItem(PROXY_KEY) || '').trim();
      return v || metaProxy();
    } catch (e) { return metaProxy(); }
  }
  function proxied(url, wantBin) {
    const p = getProxy();
    if (!p) return url;
    const extra = wantBin ? '&b64=1' : '';
    return p + (p.indexOf('?') < 0 ? '?' : '&') + 'url=' + encodeURIComponent(url) + extra;
  }
  /* 取图请求：iOS 的本地服务把图片内容转成 JSON(base64) 回传，
     否则代理会按文本解码，图片字节全毁（白框）。 */
  const IMG_URL = /\.(?:jpe?g|png|gif|webp|bmp|avif)(?:[?#]|$)/i;
  function sameOrigin(url) {
    try { return new URL(url, location.href).origin === location.origin; } catch (e) { return true; }
  }
  function netBlockedError() {
    return new Error('网页版默认不发起任何网络请求（数据不出设备）。要使用在线书源，'
      + '请到「设置 → 书源代理地址」填入你自己的代理服务。本地书导入阅读不受影响。');
  }

  /* 同步请求：高级书源（jsLib + java.ajax）的规则是同步语义，必须阻塞着拿结果。
     网页只能走同源的网关 /fetch（跨域同步 XHR 会被浏览器直接拒），
     书源自带的请求头用 base64url(JSON) 放到 h 参数，由网关透传。 */
  function b64url(str) {
    const bin = unescape(encodeURIComponent(String(str)));
    let b = '';
    if (typeof btoa === 'function') b = btoa(bin);
    else b = Buffer.from(bin, 'binary').toString('base64');
    return b.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  window.__moreadHttpSync = function (url, opt) {
    const o = opt || {};
    const headers = o.headers || {};
    const proxy = getProxy();
    try {
      if (!proxy) {
        if (!sameOrigin(url)) return { error: netBlockedError().message };
        const x = new XMLHttpRequest();
        x.open(o.method || 'GET', url, false);
        for (const k in headers) { try { x.setRequestHeader(k, headers[k]); } catch (e) { } }
        x.send(o.body || null);
        return { status: x.status || 0, text: x.responseText || '', headers: x.getAllResponseHeaders() || '', url };
      }
      let target = proxy + (proxy.indexOf('?') < 0 ? '?' : '&') + 'url=' + encodeURIComponent(url);
      if (Object.keys(headers).length) target += '&h=' + b64url(JSON.stringify(headers));
      const x = new XMLHttpRequest();
      x.open('GET', target, false);
      x.send(null);
      if (!x.status) return { error: '连不上书源代理服务' };
      return { status: x.status, text: x.responseText || '', headers: x.getAllResponseHeaders() || '', url };
    } catch (e) {
      return { error: '网络请求失败：' + (e.message || e) };
    }
  };

  /* ================================================================
   * 3. 朗读（真实 speechSynthesis，事件回传对齐 MoApp.tts 契约）
   * ================================================================ */
  const tts = { voice: '', rate: 1, pitch: 1 };
  function ttsVoices() {
    if (!nativeSpeech) return [];
    try { return nativeSpeech.getVoices().map(v => ({ id: v.voiceURI, name: v.name, lang: v.lang })); }
    catch (e) { return []; }
  }
  function ttsSpeak(a) {
    if (!nativeSpeech || !NativeUtterance) return { ok: false, error: '此浏览器不支持语音朗读' };
    try {
      const u = new NativeUtterance(String(a.text || ''));
      u.lang = a.lang || 'zh-CN';
      u.rate = Math.min(4, Math.max(0.1, Number(a.rate) || tts.rate || 1));
      u.pitch = Math.min(2, Math.max(0, Number(a.pitch) || tts.pitch || 1));
      u.volume = Math.min(1, Math.max(0, Number(a.volume) == null || isNaN(Number(a.volume)) ? 1 : Number(a.volume)));
      const want = a.voiceURI || tts.voice;
      if (want) {
        const v = nativeSpeech.getVoices().find(x => x.voiceURI === want || x.name === want);
        if (v) u.voice = v;
      }
      const id = a.id || '';
      u.onend = () => { if (window.MoApp && MoApp.tts) MoApp.tts('done', id); };
      u.onerror = () => { if (window.MoApp && MoApp.tts) MoApp.tts('error', id, { message: 'synthesis' }); };
      nativeSpeech.speak(u);
      return { ok: true };
    } catch (e) { return { ok: false, error: e.message }; }
  }
  if (nativeSpeech) {   // 音色异步就绪：与浏览器行为对齐地补一次 voiceschanged
    nativeSpeech.onvoiceschanged = () => { if (window.MoApp) window.dispatchEvent(new Event('moread:voices-changed')); };
  }

  /* ================================================================
   * 4. 安全区（iOS 主屏幕 PWA 的刘海 / Home 横条）：
   *    viewport-fit=cover 时用 env(safe-area-inset-*) 探针测量
   * ================================================================ */
  let insetCache = null;
  function measureInsets() {
    if (insetCache) return insetCache;
    try {
      const probe = document.createElement('div');
      probe.style.cssText = 'position:fixed;top:0;left:0;width:0;height:0;visibility:hidden;'
        + 'padding-top:env(safe-area-inset-top);padding-bottom:env(safe-area-inset-bottom);'
        + 'padding-left:env(safe-area-inset-left);padding-right:env(safe-area-inset-right);';
      document.documentElement.appendChild(probe);
      const cs = getComputedStyle(probe);
      const px = v => Math.round(parseFloat(v) || 0);
      insetCache = { top: px(cs.paddingTop), bottom: px(cs.paddingBottom), left: px(cs.paddingLeft), right: px(cs.paddingRight) };
      document.documentElement.removeChild(probe);
    } catch (e) { insetCache = { top: 0, bottom: 0, left: 0, right: 0 }; }
    return insetCache;
  }

  /* ================================================================
   * 5. 其余小工具
   * ================================================================ */
  function b64ToU8(b64) {
    const bin = atob(String(b64 || ''));
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  function u8ToB64(u8) {
    let s = '';
    const CH = 0x8000;
    for (let i = 0; i < u8.length; i += CH) s += String.fromCharCode.apply(null, u8.subarray(i, i + CH));
    return btoa(s);
  }
  function toast(msg) {
    try {
      let el = document.getElementById('__web-toast');
      if (!el) {
        el = document.createElement('div');
        el.id = '__web-toast';
        el.style.cssText = 'position:fixed;left:50%;bottom:96px;transform:translateX(-50%);z-index:99999;'
          + 'background:#333;color:#fff;padding:10px 18px;border-radius:10px;font-size:14px;'
          + 'max-width:80%;text-align:center;pointer-events:none;opacity:0;transition:opacity .2s;';
        document.body.appendChild(el);
      }
      el.textContent = String(msg || '');
      el.style.opacity = '1';
      clearTimeout(toast.t);
      toast.t = setTimeout(() => { el.style.opacity = '0'; }, 2200);
    } catch (e) { /* ignore */ }
  }
  function download(name, blob) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 4000);
  }
  /* 把浏览器的 File 列表读进虚拟文件系统（文件选择与拖放共用） */
  async function stageFiles(list) {
    const items = [];
    for (const f of list || []) {
      try {
        const buf = new Uint8Array(await f.arrayBuffer());
        // 纯数字时间戳前缀：runtime.js 的 cleanBookName 会把 ^\\d{10,14}- 剥掉，书名才干净
        const path = '/moread/tmp/' + Date.now() + '-' + f.name.replace(/[\\/:*?"<>|]/g, '_');
        FS.set(path, buf); ensureDir('/moread/tmp'); markDirty(path);
        items.push({ name: f.name, path, size: f.size, error: '' });
      } catch (e) {
        items.push({ name: f.name, path: '', size: 0, error: e.message || '读取失败' });
      }
    }
    return items;
  }

  /* 文件选择器：常驻一个真实 input（手机浏览器对临时创建 + 立即 click 很敏感）。
   * 判定取消只靠 cancel 事件和很长时间没动静的兜底，绝不用 window.focus——
   * 系统文件框关掉时窗口回焦常常早于 change 事件，旧写法会把「已经选好文件」
   * 抢先收口成空数组，上层又把这个结果当成静默取消，用户就看到「点了没反应」。 */
  let fileInput = null, pickSeq = 0;
  function getFileInput() {
    if (fileInput && fileInput.isConnected) return fileInput;
    fileInput = document.createElement('input');
    fileInput.type = 'file';
    fileInput.setAttribute('aria-hidden', 'true');
    fileInput.style.cssText = 'position:fixed;left:-9999px;top:0;width:1px;height:1px;opacity:0';
    (document.body || document.documentElement).appendChild(fileInput);
    return fileInput;
  }
  function pickFiles(mimes, multiple) {
    return new Promise(resolve => {
      const inp = getFileInput();
      const seq = ++pickSeq;
      let done = false, timer = 0;
      function cleanup() {
        clearTimeout(timer);
        inp.removeEventListener('change', onChange);
        inp.removeEventListener('cancel', onCancel);
        try { inp.value = ''; } catch (e) { /* 某些内核不允许清空 */ }
      }
      async function finish(list) {
        if (done) return;
        // 用户又点了一次按钮：把上一次收口，顺手摘掉它的事件监听
        if (seq !== pickSeq) { done = true; cleanup(); resolve([]); return; }
        done = true; cleanup();
        try { resolve(await stageFiles(list)); }
        catch (e) { resolve([{ name: '', path: '', size: 0, error: '读取失败：' + (e.message || e) }]); }
      }
      function onChange() { finish(Array.from(inp.files || [])); }
      function onCancel() { finish([]); }
      try {
        inp.value = '';
        inp.accept = (mimes && mimes.length) ? mimes.join(',') : '';
        inp.multiple = !!multiple;
      } catch (e) { /* 忽略个别内核对 value 的限制 */ }
      inp.addEventListener('change', onChange);
      inp.addEventListener('cancel', onCancel);
      timer = setTimeout(() => finish([]), 5 * 60 * 1000);
      try { inp.click(); }
      catch (e) {
        finish([{ name: '', path: '', size: 0, error: '浏览器没有打开文件选择器：' + (e.message || e) }]);
      }
    });
  }

  /* 网页版专用：在按钮点击的同步调用栈里就把文件框打开。
     部分手机浏览器只在「真实用户手势」里允许 input.click()，中间只要隔一层
     await 就会静默拒绝；这里先开好，后面 dialog.open 直接复用这一次的结果。
     桌面 / 安卓没有这个全局函数，仍走原来的 dialog.open 路径。 */
  let primedPick = null;
  window.__moreadPrimeFilePicker = function (mimes, multiple) {
    // 结果保留到 dialog.open 来取（文件可能比桥接调用更早选完）；
    // 再次点击会直接覆盖，pickFiles 内部也会让上一次自动收口。
    const p = pickFiles(mimes || [], !!multiple);
    primedPick = { promise: p, at: Date.now() };
  };

  /* ================================================================
   * 6. zlib（pako 同步实现，epub / 备份 zip 解压用）
   * ================================================================ */
  function zlibOp(op, a) {
    if (typeof pako === 'undefined') return { error: '缺少 pako（zip 解压组件）' };
    const data = b64ToU8(a.b64);
    const F = {
      inflateRaw: pako.inflateRaw, deflateRaw: pako.deflateRaw,
      gunzip: pako.ungzip, gzip: pako.gzip,
      inflate: pako.inflate, deflate: pako.deflate
    }[op];
    if (!F) return { error: '未知 zlib 操作: ' + op };
    try { return { b64: u8ToB64(F(data)) }; }
    catch (e) { return { error: e.message }; }
  }

  /* ================================================================
   * 7. http.request（异步）：同源直连，跨域一律走用户代理
   * ================================================================ */
  async function httpRequest(a) {
    const url = String(a.url || '');
    if (!url) return { error: '空地址' };
    if (!sameOrigin(url) && !getProxy()) throw netBlockedError();

    const ctrl = (typeof AbortController !== 'undefined') ? new AbortController() : null;
    const timer = setTimeout(() => { if (ctrl) ctrl.abort(); }, Math.min(60000, Number(a.timeout) || 18000));
    const maxBytes = Number(a.maxBytes) || (12 * 1024 * 1024);
    try {
      const headers = {};
      const FORBIDDEN = ['user-agent', 'referer', 'cookie', 'host', 'origin', 'content-length', 'accept-encoding'];
      for (const k of Object.keys(a.headers || {})) {
        if (FORBIDDEN.indexOf(k.toLowerCase()) < 0) headers[k] = String(a.headers[k]);
      }
      const init = {
        method: a.method || 'GET',
        headers,
        redirect: 'follow',
        signal: ctrl ? ctrl.signal : undefined
      };
      if (a.bodyB64) init.body = b64ToU8(a.bodyB64);

      const wantBin = !!(a.binary || IMG_URL.test(url));
      const res = await fetch(proxied(url, wantBin && !!getProxy()), init);
      /* 代理在 b64 模式下回一段 JSON：{status, mime, b64}，这里还原成字节 */
      if (wantBin && getProxy()) {
        let pack = null;
        try { pack = await res.json(); } catch (e) { pack = null; }
        if (pack && pack.b64 != null) {
          const outHeaders = { 'content-type': pack.mime || 'application/octet-stream' };
          return { status: pack.status || 200, headers: outHeaders, b64: pack.b64, url: pack.url || url };
        }
      }
      let bytes;
      if (res.body && res.body.getReader) {
        const reader = res.body.getReader();
        const chunks = []; let total = 0;
        for (; ;) {
          const { done, value } = await reader.read();
          if (done) break;
          chunks.push(value); total += value.length;
          if (total > maxBytes) { try { reader.cancel(); } catch (e) { } throw new Error('响应超过 ' + Math.round(maxBytes / 1048576) + 'MB 上限'); }
        }
        bytes = new Uint8Array(total);
        let off = 0;
        for (const c of chunks) { bytes.set(c, off); off += c.length; }
      } else {
        bytes = new Uint8Array(await res.arrayBuffer());
      }
      const outHeaders = {};
      try { res.headers.forEach((v, k) => { outHeaders[k] = v; }); } catch (e) { }
      return { status: res.status, headers: outHeaders, b64: u8ToB64(bytes), url: res.url || url };
    } catch (e) {
      if (e && /Failed to fetch|NetworkError|load failed/i.test(e.message) && !getProxy()) throw netBlockedError();
      if (e && e.name === 'AbortError') throw new Error('请求超时');
      throw e;
    } finally { clearTimeout(timer); }
  }

  /* ================================================================
   * 8. 桥本体
   * ================================================================ */
  function dispatchSync(name, a) {
    if (name.indexOf('file.') === 0) {
      const op = name.slice(5), p = normalize(a.path || '');
      switch (op) {
        case 'exists': return { exists: FS.has(p) || isDir(p) };
        case 'stat': {
          if (isDir(p)) return { exists: true, isDir: true, size: 0, mtime: 0 };
          const d = FS.get(p);
          if (!d) return { exists: false };
          return { exists: true, isDir: false, size: d.length, mtime: 0 };
        }
        case 'mkdir': ensureDir(p); markDirty('__dirs__'); return { ok: true };
        case 'list': {
          const prefix = (p === '/' ? '' : p) + '/';
          const seen = new Map();
          for (const path of FS.keys()) {
            if (path.indexOf(prefix) !== 0) continue;
            const rest = path.slice(prefix.length);
            const seg = rest.split('/')[0];
            seen.set(seg, rest.indexOf('/') >= 0);
          }
          for (const d of DIRS) {
            if (d.indexOf(prefix) === 0 && d.length > prefix.length) {
              const seg = d.slice(prefix.length).split('/')[0];
              seen.set(seg, true);
            }
          }
          return { items: Array.from(seen).map(([n, isD]) => ({ name: n, isDir: isD })) };
        }
        case 'read': {
          const d = FS.get(p);
          if (!d) return { error: 'ENOENT: ' + p };
          return a.text ? { text: decoder.decode(d) } : { b64: u8ToB64(d) };
        }
        case 'write': {
          const prev = a.append ? (FS.get(p) || new Uint8Array(0)) : null;
          const add = a.b64 != null ? b64ToU8(a.b64) : encoder.encode(String(a.text || ''));
          let out;
          if (prev) { out = new Uint8Array(prev.length + add.length); out.set(prev); out.set(add, prev.length); }
          else out = add;
          FS.set(p, out); ensureDir(dirname(p)); markDirty(p);
          return { ok: true };
        }
        case 'copy': { const d = FS.get(normalize(a.from)); if (!d) return { error: 'ENOENT: ' + a.from }; FS.set(normalize(a.to), d.slice()); markDirty(normalize(a.to)); return { ok: true }; }
        case 'rename': { const d = FS.get(normalize(a.from)); if (!d) return { error: 'ENOENT: ' + a.from }; FS.set(normalize(a.to), d); FS.delete(normalize(a.from)); markDirty(normalize(a.to)); markDirty(normalize(a.from)); return { ok: true }; }
        case 'remove': {
          if (isDir(p) && !FS.has(p)) {
            for (const path of Array.from(FS.keys())) if (path.indexOf(p + '/') === 0) { FS.delete(path); markDirty(path); }
            DIRS.delete(p); markDirty('__dirs__');
            return { ok: true };
          }
          if (FS.delete(p)) { markDirty(p); return { ok: true }; }
          return { error: 'ENOENT: ' + p };
        }
        /* 网页版没有"外部路径"这个概念：用户选的文件在 pickFiles 里就已经读进虚拟 FS 了，
           所以 stage 直接确认存在并原样返回。缺这一条时，恢复备份 / 导入书源 JSON
           都会在第一步就抛「无法读取所选文件」。 */
        case 'stage': {
          if (FS.has(p) || isDir(p)) return { path: p };
          return { error: 'ENOENT: ' + p };
        }
        case 'abs': return { abs: '' };   // 网页版没有真实文件路径，fs shim 会走 readFileSync 兜底
        default: return { error: '未知文件操作: ' + op };
      }
    }
    if (name.indexOf('zlib.') === 0) return zlibOp(name.slice(5), a);
    if (name === 'http.request') return { error: 'http.request 必须走 callAsync' };

    switch (name) {
      case 'env.info': return {
        app: 'moread', platform: 'web', version: '0.6.10', code: 610, sdk: 0,
        device: (navigator.userAgent || '').slice(0, 80),
        paths: { root: '/moread', cache: '/cache', external: '' },
        webview: (navigator.userAgent || '').split(') ')[0] + ')',
        /* 存档位置：device = 家里这台服务器；browser = 只有本浏览器 IndexedDB */
        dataStore: remote ? 'device' : 'browser',
        dataRoot: remote ? remoteRoot : ''
      };
      case 'env.layout': {
        const w = window.innerWidth, h = window.innerHeight;
        const sw = Math.min(w, h);
        return {
          mode: sw >= 600 && w > h ? 'wide' : (w > h ? 'landscape' : 'portrait'),
          sw, bucket: sw >= 720 ? 'expanded' : (sw >= 600 ? 'medium' : 'compact')
        };
      }
      case 'env.insets': return measureInsets();
      case 'env.corners': return { tl: 0, tr: 0, bl: 0, br: 0 };
      case 'env.webview': return { pkg: 'browser' };

      case 'tts.voices': return { voices: ttsVoices() };
      case 'tts.state': {
        const voices = ttsVoices();
        return {
          ready: !!(nativeSpeech && voices.length),
          speaking: !!(nativeSpeech && nativeSpeech.speaking),
          voice: tts.voice
        };
      }
      case 'tts.speak': return ttsSpeak(a);
      case 'tts.stop': if (nativeSpeech) try { nativeSpeech.cancel(); } catch (e) { } return { ok: true };
      case 'tts.set':
        if (a.voice != null) tts.voice = a.voice;
        if (a.rate != null) tts.rate = Number(a.rate) || 1;
        if (a.pitch != null) tts.pitch = Number(a.pitch) || 1;
        try { localStorage.setItem('moread.tts', JSON.stringify(tts)); } catch (e) { }
        return { ok: true };

      case 'app.toast': toast(a.msg); return { ok: true };
      case 'app.quit': return { ok: true };
      case 'app.browse': try { window.open(a.url, '_blank', 'noopener'); } catch (e) { } return { ok: true };
      case 'app.log': try { console.log('[moread]', a.msg); } catch (e) { } return { ok: true };
      case 'app.ready': return { ok: true };
      case 'app.share': {
        // 同步契约，但 Web Share 是异步的：这里只报告接受，实际分享在后台进行
        return { ok: true, async: true, __sharePath: a.path, __shareMime: a.mime };
      }

      case 'win.minimize': return { ok: true };
      case 'win.maximize': case 'win.close': return { ok: true };   // 浏览器里没有窗口系统，点了就当没有
      case 'win.fullscreen': return { full: false };
      case 'win.isFull': return { full: false };

      case 'ui.keepScreenOn': {
        try {
          if (a.on && navigator.wakeLock && navigator.wakeLock.request) navigator.wakeLock.request('screen').catch(() => { });
          else if (!a.on && navigator.wakeLock) { /* 释放由页面生命周期管理 */ }
        } catch (e) { }
        return { ok: true };
      }
      case 'ui.orientation': return { ok: true };

      case 'dialog.open': return { error: 'dialog.open 必须走 callAsync（网页版文件选择是异步的）' };
      case 'dialog.save': return { error: 'dialog.save 必须走 callAsync' };

      default: return { error: '未知的原生方法: ' + name };
    }
  }

  async function dispatchAsync(name, a) {
    switch (name) {
      case 'http.request': return await httpRequest(a);
      case 'dialog.open': {
        const primed = primedPick;
        primedPick = null;
        // 只有「恢复备份」这次预先打开的选择框能被复用，别的入口（导入书源等）
        // 绝不能误拿这个文件
        const fresh = primed && /备份/.test(a.title || '') && (Date.now() - primed.at) < 10 * 60 * 1000;
        const items = fresh ? await primed.promise : await pickFiles(a.mimes || [], a.multiple);
        return { ok: true, items, canceled: !items.length };
      }
      case 'dialog.save': {
        const name2 = a.name || 'export.bin';
        const mime = a.mime || 'application/octet-stream';
        try {
          const blob = a.b64 != null ? new Blob([b64ToU8(a.b64)], { type: mime }) : new Blob([String(a.text || '')], { type: mime });
          download(name2, blob);
          return { ok: true, path: name2, name: name2, size: blob.size };
        } catch (e) { return { ok: false, error: e.message }; }
      }
      case 'app.share': {
        const path = a.__sharePath || a.path;
        try {
          const data = FS.get(normalize(path));
          if (!data) return { ok: false, error: '文件不存在' };
          const file = new File([data], path.split('/').pop() || 'file', { type: a.__shareMime || a.mime || 'application/octet-stream' });
          if (navigator.share && navigator.canShare && navigator.canShare({ files: [file] })) {
            await navigator.share({ files: [file] });
            return { ok: true };
          }
          download(file.name, file);
          return { ok: true, fallback: 'download' };
        } catch (e) {
          if (e && e.name === 'AbortError') return { ok: false, error: '已取消' };
          return { ok: false, error: e.message };
        }
      }
      default:
        // 其余操作都是快的，直接同步执行包一层
        return dispatchSync(name, a);
    }
  }

  window.MoNativeBridge = {
    __isWeb: true,
    __isWebDesktop: !isPhone,
    /** 拖放导入：File[] → 暂存条目（与 dialog.open 返回的 items 同形） */
    __stageFiles: list => stageFiles(list),
    callSync(name, argsJson) {
      let a = {};
      try { a = argsJson ? JSON.parse(argsJson) : {}; } catch (e) { a = {}; }
      try { return JSON.stringify(dispatchSync(name, a)); }
      catch (e) { return JSON.stringify({ __error: e.message || String(e) }); }
    },
    callFire(name, argsJson) {
      let a = {};
      try { a = argsJson ? JSON.parse(argsJson) : {}; } catch (e) { a = {}; }
      if (name === 'app.share') {   // fire 通道来的分享也照常执行
        dispatchAsync('app.share', a).then(r => {
          if (r && r.ok === false && r.error && r.error !== '已取消') toast('分享失败：' + r.error);
        });
        return;
      }
      try { dispatchSync(name, a); } catch (e) { /* ignore */ }
    },
    callAsync(name, argsJson, id) {
      let a = {};
      try { a = argsJson ? JSON.parse(argsJson) : {}; } catch (e) { a = {}; }
      dispatchAsync(name, a).then(r => {
        if (window.__moreadAsync) window.__moreadAsync(id, JSON.stringify(r || {}));
      }).catch(e => {
        if (window.__moreadAsync) window.__moreadAsync(id, JSON.stringify({ __error: e.message || String(e) }));
      });
    }
  };

  /* 恢复朗读设置；申请持久存储（尽量让 iOS 别清我们的数据） */
  try {
    const saved = JSON.parse(localStorage.getItem('moread.tts') || '{}');
    if (saved.voice != null) tts.voice = saved.voice;
    if (saved.rate) tts.rate = saved.rate;
    if (saved.pitch) tts.pitch = saved.pitch;
  } catch (e) { }
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => { });

  /* 虚拟 FS 就绪后放行页面初始化（index.html 依赖 __bridgeReady）
     顺序：先读本地 IndexedDB 缓存（快），再问网关有没有设备端存档——
     有就用设备上的覆盖本地（data.json 必须先到位，页面才能渲染出正确书架），
     其余本地书文件在后台慢慢拉，不挡启动。 */
  window.__bridgeReady = fsLoadAll()
    .then(() => remoteProbe())
    .then(async ok => {
      remote = !!ok;
      if (remote) {
        await remotePull(true);
        remotePull(false).catch(() => { });
      }
      DIRS.add('/moread'); DIRS.add('/moread/tmp');
      if (remote) {
        try { document.documentElement.setAttribute('data-moread-store', 'device'); } catch (e) { }
      }
    })
    .catch(() => { DIRS.add('/moread'); DIRS.add('/moread/tmp'); });
})();
