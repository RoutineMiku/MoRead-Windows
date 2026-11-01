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
    if (!dirty.size || !window.indexedDB) return;
    try {
      const db = await idbOpen();
      await new Promise((resolve, reject) => {
        const tx = db.transaction('files', 'readwrite');
        const st = tx.objectStore('files');
        for (const p of dirty) st.put(FS.get(p) || null, p);   // null = 已删除
        tx.oncomplete = resolve;
        tx.onerror = () => reject(tx.error);
      });
      dirty.clear();
    } catch (e) { /* 存储失败不致命：内存里还有 */ }
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
   * ================================================================ */
  const PROXY_KEY = 'moread.proxy';
  function getProxy() { try { return (localStorage.getItem(PROXY_KEY) || '').trim(); } catch (e) { return ''; } }
  function proxied(url) {
    const p = getProxy();
    if (!p) return url;
    return p + (p.indexOf('?') < 0 ? '?' : '&') + 'url=' + encodeURIComponent(url);
  }
  function sameOrigin(url) {
    try { return new URL(url, location.href).origin === location.origin; } catch (e) { return true; }
  }
  function netBlockedError() {
    return new Error('网页版默认不发起任何网络请求（数据不出设备）。要使用在线书源，'
      + '请到「设置 → 书源代理地址」填入你自己的代理服务。本地书导入阅读不受影响。');
  }

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

  function pickFiles(mimes, multiple) {
    return new Promise(resolve => {
      const inp = document.createElement('input');
      inp.type = 'file';
      if (mimes && mimes.length) inp.accept = mimes.join(',');
      inp.multiple = !!multiple;
      inp.style.display = 'none';
      let done = false;
      const finish = async list => {
        if (done) return;
        done = true;
        document.body.removeChild(inp);
        resolve(await stageFiles(list));
      };
      inp.onchange = () => finish(Array.from(inp.files || []));
      // 用户取消：input 不触发 change，用焦点回来 + 超时兜底收口
      document.body.appendChild(inp);
      inp.click();
      setTimeout(() => { const w = () => finish([]); window.addEventListener('focus', w, { once: true }); setTimeout(w, 60 * 1000); }, 800);
    });
  }

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

      const res = await fetch(proxied(url), init);
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
        case 'abs': return { abs: '' };   // 网页版没有真实文件路径，fs shim 会走 readFileSync 兜底
        default: return { error: '未知文件操作: ' + op };
      }
    }
    if (name.indexOf('zlib.') === 0) return zlibOp(name.slice(5), a);
    if (name === 'http.request') return { error: 'http.request 必须走 callAsync' };

    switch (name) {
      case 'env.info': return {
        app: 'moread', platform: 'web', version: '0.4.1', code: 41, sdk: 0,
        device: (navigator.userAgent || '').slice(0, 80),
        paths: { root: '/moread', cache: '/cache', external: '' },
        webview: (navigator.userAgent || '').split(') ')[0] + ')'
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
        const items = await pickFiles(a.mimes || [], a.multiple);
        return { ok: true, items };
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

  /* 虚拟 FS 就绪后放行页面初始化（index.html 依赖 __bridgeReady） */
  window.__bridgeReady = fsLoadAll().then(() => { DIRS.add('/moread'); DIRS.add('/moread/tmp'); });
})();
