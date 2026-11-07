'use strict';
/**
 * 墨读安卓版 —— Node 兼容层 + mo 桥接实现
 *
 * 桌面版的 src/net.js zip.js webdav.js legado.js parse.js store.js 写的是标准 CommonJS，
 * 只用到 fs / path / http / https / url / zlib / Buffer 这一小搓 Node API。
 * 这里提供同名的同步实现（底层走 @JavascriptInterface 调原生），
 * 于是那份已在真实备份上验证过的 700 行逻辑可以一行不改地在安卓上跑。
 *
 * 本文件由 build/gen-nodebundle.js 和 src/*.js 一起打包成 assets/nodebundle.js，
 * 再被 MainActivity 拦截 index.html 里的 <script src="bridge.js"> 请求注入。
 * 桌面 Electron 加载不到这个文件（404），所以两边互不干扰。
 */
(function () {
  if (typeof MoNativeBridge === 'undefined') return;   // 桌面环境：什么都不做
  /* 网页版跑在桌面浏览器里：保留桌面版式与浏览器自带的 speechSynthesis，
   * 不做安卓式的布局接管。手机浏览器 / 主屏幕 PWA 走安卓同款移动形态。 */
  const WEB_DESKTOP = MoNativeBridge.__isWebDesktop === true;

  /* ==================================================================
   * 0. 最先做的事：给页面打上「这是安卓」的标记，并摘掉桌面端窗口按钮
   *
   *    必须放在最前面。这个文件九百多行的初始化里任何一步失败
   *    （原生目录没建好、存档损坏、某个模块抛错……）都不应该让界面
   *    退回成电脑版的样子——小控件 + 右上角最小化/最大化/关闭。
   * ================================================================== */
  function markAndroid() {
    try {
      var de = document.documentElement;
      if (WEB_DESKTOP) {
        de.classList.add('is-web');            // 桌面浏览器：桌面版式，仅摘掉 Electron 窗口按钮
      } else {
        de.classList.add('is-android');
        if (!de.getAttribute('data-layout')) de.setAttribute('data-layout', 'portrait');
      }
      // 桌面 Electron 的自绘窗口按钮，安卓 / 浏览器里都没有窗口系统，直接摘掉
      var wb = document.querySelector('.winbtns');
      if (wb && wb.parentNode) wb.parentNode.removeChild(wb);
      // 拖放导入区：手机上没有拖放，桌面浏览器要留着
      if (!WEB_DESKTOP) {
        var dz = document.querySelector('.dropzone');
        if (dz && dz.parentNode) dz.parentNode.removeChild(dz);
      }
    } catch (e) { /* 界面标记失败也不能影响后续 */ }
  }
  markAndroid();
  // bridge.js 在 body 末尾，此时 .winbtns 已存在；仍兜一层，防止将来挪到 head
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', markAndroid);
  }
  window.__moreadMarkAndroid = markAndroid;

  /* 初始化步骤留痕：真机上若 window.mo 起不来，自检面板能直接指出卡在哪一步 */
  window.__moreadSteps = [];
  function step(name, fn) {
    var t0 = Date.now();
    try {
      var r = fn();
      window.__moreadSteps.push({ n: name, ok: true, ms: Date.now() - t0 });
      return r;
    } catch (e) {
      window.__moreadSteps.push({ n: name, ok: false, ms: Date.now() - t0, e: String((e && (e.message || e)) || '').slice(0, 300) });
      throw e;
    }
  }
  window.__moreadStep = step;

  /* ==================================================================
   * 1. 原生通道
   * ================================================================== */
  const NB = {
    call(name, args) {
      let raw;
      try {
        raw = MoNativeBridge.callSync(name, args == null ? '{}' : JSON.stringify(args));
      } catch (e) {
        throw new Error('原生调用失败 ' + name + '：' + (e.message || e));
      }
      let r;
      try { r = raw == null || raw === '' ? {} : JSON.parse(raw); }
      catch (e) { throw new Error('桥接返回了非 JSON（' + name + '）：' + String(raw).slice(0, 160)); }
      if (r && r.__error) throw new Error(r.error || r.__error);
      return r || {};
    },
    /* 异步通道：http.request 这类慢调用必须走这里。callSync 在请求返回前会冻住整个
     * JS 线程（书源挂起 = 页面卡死几十秒），callAsync 在原生线程池里跑，回来再喂 Promise。 */
    __seq: 0,
    __pending: new Map(),
    callAsync(name, args) {
      return new Promise((resolve, reject) => {
        const id = 'a' + (++NB.__seq);
        NB.__pending.set(id, { resolve, reject, name });
        try {
          MoNativeBridge.callAsync(name, args == null ? '{}' : JSON.stringify(args), id);
        } catch (e) {
          NB.__pending.delete(id);
          reject(new Error('原生调用失败 ' + name + '：' + (e.message || e)));
        }
      });
    },
    /* 自适应通道：桥支持 callAsync 就走异步（网页版文件选择必须异步），否则回退同步。
     * 返回值形状与 NB.call 完全一致，调用点只需要多一个 await。 */
    callA(name, args) {
      if (typeof MoNativeBridge.callAsync === 'function') return NB.callAsync(name, args);
      return new Promise(resolve => { resolve(NB.call(name, args)); });
    },
    fire(name, payload) {   // 单向通知（不需要返回值）
      try { MoNativeBridge.callFire(name, JSON.stringify(payload == null ? {} : payload)); } catch (e) { /* ignore */ }
    }
  };
  /* 原生异步结果回来唯一的落点。找不到 id 就丢（页面已重载等场景） */
  window.__moreadAsync = function (id, raw) {
    const p = NB.__pending.get(id);
    if (!p) return;
    NB.__pending.delete(id);
    let r;
    try { r = raw == null || raw === '' ? {} : JSON.parse(raw); }
    catch (e) { p.reject(new Error('桥接返回了非 JSON（' + p.name + '）')); return; }
    if (r && r.__error) { p.reject(new Error(r.error || r.__error)); return; }
    p.resolve(r || {});
  };

  /* ==================================================================
   * 2. Buffer（只需覆盖 zip/net/legado 用到的那几个方法）
   * ================================================================== */
  function utf8Encode(str) {
    if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(str);
    const out = [];
    for (const ch of unescape(encodeURIComponent(str))) out.push(ch.charCodeAt(0));
    return new Uint8Array(out);
  }
  function utf8Decode(bytes) {
    if (typeof TextDecoder !== 'undefined') return new TextDecoder('utf-8').decode(bytes);
    let s = '';
    for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return decodeURIComponent(escape(s));
  }
  const B64A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  function b64ToBytes(b64) {
    const clean = String(b64).replace(/[^A-Za-z0-9+/=]/g, '');
    const len = Math.floor(clean.length * 3 / 4) - (clean.slice(-2) === '==' ? 2 : clean.slice(-1) === '=' ? 1 : 0);
    const out = new Uint8Array(Math.max(0, len));
    let p = 0, buf = 0, bits = 0;
    for (let i = 0; i < clean.length; i++) {
      const c = clean[i];
      if (c === '=') break;
      buf = (buf << 6) | B64A.indexOf(c);
      bits += 6;
      if (bits >= 8) { bits -= 8; out[p++] = (buf >> bits) & 0xff; }
    }
    return out;
  }
  function bytesToB64(bytes) {
    let out = '', buf = 0, bits = 0;
    for (let i = 0; i < bytes.length; i++) {
      buf = (buf << 8) | (bytes[i] & 0xff);
      bits += 8;
      while (bits >= 6) { bits -= 6; out += B64A[(buf >> bits) & 0x3f]; }
    }
    if (bits > 0) out += B64A[(buf << (6 - bits)) & 0x3f];
    while (out.length % 4) out += '=';
    return out;
  }

  /** 跨 realm 安全的类型判断（沙箱/宿主/不同窗口的 ArrayBuffer 不是同一个类，instanceof 会误判） */
  const tagOf = a => Object.prototype.toString.call(a);
  const isTyped = a => !!a && (a instanceof Uint8Array || tagOf(a) === '[object Uint8Array]' ||
    (typeof a.length === 'number' && a.BYTES_PER_ELEMENT === 1 && !!a.buffer));
  const isArrayBuffer = a => !!a && ((typeof ArrayBuffer !== 'undefined' && a instanceof ArrayBuffer) ||
    tagOf(a) === '[object ArrayBuffer]');
  /** 把任意 buffer-like 变成 Uint8Array 视图 */
  function asBytes(a) {
    if (isTyped(a)) return a;
    if (isArrayBuffer(a)) return new Uint8Array(a);
    if (a && isArrayBuffer(a.buffer)) {
      return new Uint8Array(a.buffer, a.byteOffset || 0,
        a.byteLength != null ? a.byteLength : (a.length || 0));
    }
    return null;
  }

  /** Uint8Array 子类，补上 Node Buffer 的方法。
   *  构造参数可能是 number / Uint8Array / ArrayBuffer（XHR 读大文件时就是它）/ 数组 */
  function toArrayLike(a) {
    if (a == null) return 0;
    if (typeof a === 'number') return a;
    if (typeof a === 'string') return utf8Encode(a);
    const view = asBytes(a);
    if (view) return view;
    if (Array.isArray(a)) return new Uint8Array(a);
    return 0;
  }

  class NodeBuffer extends Uint8Array {
    /**
     * 除了常规构造，还必须支持 TypedArray 的 species 签名 (buffer, byteOffset, length)：
     * subarray() 内部就是用这三个参数 new 出来的，只认第一个参数会让 subarray 返回整块数据。
     */
    constructor(a, byteOffset, length) {
      if (typeof a === 'number') {
        super(a);
      } else if (a && (isArrayBuffer(a) || isArrayBuffer(a.buffer)) && byteOffset != null) {
        super(isArrayBuffer(a) ? a : a.buffer, byteOffset, length);
      } else {
        super(toArrayLike(a));
      }
    }
    readUInt16LE(off) { return this[off] | (this[off + 1] << 8); }
    readUInt32LE(off) {
      return ((this[off] | (this[off + 1] << 8) | (this[off + 2] << 16)) + this[off + 3] * 0x1000000) >>> 0;
    }
    writeUInt16LE(v, off) { this[off] = v & 0xff; this[off + 1] = (v >>> 8) & 0xff; return off + 2; }
    writeUInt32LE(v, off) {
      v = v >>> 0;
      this[off] = v & 0xff; this[off + 1] = (v >>> 8) & 0xff;
      this[off + 2] = (v >>> 16) & 0xff; this[off + 3] = (v >>> 24) & 0xff;
      return off + 4;
    }
    toString(enc, start, end) {
      const slice = (start != null || end != null)
        ? this.subarray(start || 0, end == null ? this.length : end)
        : this;
      switch (String(enc || 'utf8').toLowerCase()) {
        case 'utf8': case 'utf-8': return utf8Decode(slice);
        case 'base64': return bytesToB64(slice);
        case 'latin1': case 'binary': case 'ascii': {
          let s = '';
          for (let i = 0; i < slice.length; i++) s += String.fromCharCode(slice[i]);
          return s;
        }
        case 'hex': {
          let s = '';
          for (let i = 0; i < slice.length; i++) s += ('0' + slice[i].toString(16)).slice(-2);
          return s;
        }
        default: return utf8Decode(slice);
      }
    }
    toJSON() { return { type: 'Buffer', data: Array.from(this) }; }
    slice(a, b) { return this.subarray(a, b); }
  }

  function BufferFrom(src, enc) {
    if (src == null) return new NodeBuffer(0);
    if (typeof src === 'number') { const b = new NodeBuffer(src); b.fill(0); return b; }
    if (typeof src === 'string') {
      const e = String(enc || 'utf8').toLowerCase();
      if (e === 'base64') { const raw = b64ToBytes(src); const b = new NodeBuffer(raw.length); b.set(raw); return b; }
      if (e === 'hex') {
        const clean = src.replace(/[^0-9a-f]/gi, '');
        const b = new NodeBuffer(Math.floor(clean.length / 2));
        for (let i = 0; i < b.length; i++) b[i] = parseInt(clean.substr(i * 2, 2), 16);
        return b;
      }
      // XHR 同步读二进制时拿回来的是 latin1 字符串，必须逐字节还原，不能当 UTF-8 编
      if (e === 'latin1' || e === 'binary' || e === 'ascii' || e === 'utf8-as-bytes') {
        const b = new NodeBuffer(src.length);
        for (let i = 0; i < src.length; i++) b[i] = src.charCodeAt(i) & 0xff;
        return b;
      }
      const raw = utf8Encode(src);
      const b = new NodeBuffer(raw.length);
      b.set(raw);
      return b;
    }
    const view = asBytes(src);
    if (view) { const b = new NodeBuffer(view.length); b.set(view); return b; }
    if (Array.isArray(src)) { const b = new NodeBuffer(src.length); b.set(src); return b; }
    return new NodeBuffer(0);
  }

  const Buf = {
    from: BufferFrom,
    alloc: n => { const b = new NodeBuffer(n); b.fill(0); return b; },
    allocUnsafe: n => new NodeBuffer(n),
    concat(list, total) {
      const parts = list.map(x => (x instanceof Uint8Array ? x : BufferFrom(x)));
      const len = total != null ? total : parts.reduce((s, p) => s + p.length, 0);
      const out = new NodeBuffer(len);
      let off = 0;
      for (const p of parts) { out.set(p.length > len - off ? p.subarray(0, len - off) : p, off); off += p.length; }
      return out;
    },
    isBuffer: b => b instanceof NodeBuffer,
    byteLength: (str, enc) => (String(enc).toLowerCase() === 'base64'
      ? b64ToBytes(str).length
      : utf8Encode(String(str)).length)
  };

  /* ==================================================================
   * 3. EventEmitter（net.js 的流式 http 需要）
   * ================================================================== */
  class EventEmitter {
    constructor() { this._ev = Object.create(null); }
    on(ev, cb) { (this._ev[ev] = this._ev[ev] || []).push(cb); return this; }
    once(ev, cb) { const w = (...a) => { this.off(ev, w); cb(...a); }; return this.on(ev, w); }
    off(ev, cb) {
      const l = this._ev[ev];
      if (!l) return this;
      const i = l.indexOf(cb);
      if (i >= 0) l.splice(i, 1);
      return this;
    }
    emit(ev, ...args) {
      const l = this._ev[ev];
      if (!l || !l.length) return false;
      for (const cb of l.slice()) {
        try { cb(...args); } catch (e) { console.error('[EventEmitter]', ev, e); }
      }
      return true;
    }
    removeAllListeners(ev) { if (ev) delete this._ev[ev]; else this._ev = Object.create(null); return this; }
    listenerCount(ev) { return (this._ev[ev] || []).length; }
  }

  /* ==================================================================
   * 4. CommonJS 运行时
   * ================================================================== */
  const MODSRC = window.__MOREAD_MODULES__ || {};
  const cache = Object.create(null);

  const norm = name => String(name).replace(/^\.\//, '').replace(/\.js$/, '');

  function requireImpl(name) {
    const key = norm(name);
    if (cache[key]) return cache[key].exports;

    // 内置 shim 模块
    if (SHIMS[key]) {
      const m = { exports: {} };
      cache[key] = m;
      SHIMS[key](m, m.exports);
      return m.exports;
    }
    if (MODSRC[key]) {
      const m = { exports: {} };
      cache[key] = m;
      try {
        const fn = new Function('module', 'exports', 'require', 'process', 'Buffer', 'console', '__filename', '__dirname', MODSRC[key]);
        fn(m, m.exports, requireImpl, fakeProcess, Buf, console, '/moread/' + key + '.js', '/moread');
      } catch (e) {
        delete cache[key];
        throw new Error('加载模块 ' + key + ' 失败：' + (e && e.message));
      }
      return m.exports;
    }
    throw new Error('Cannot find module \'' + name + '\'');
  }

  const fakeProcess = {
    env: {}, platform: 'android', arch: 'arm64', version: 'v16-android',
    versions: { node: '16.0.0', moread: 'android' },
    cwd: () => '/', hrtime: () => [0, 0], nextTick: cb => Promise.resolve().then(cb)
  };

  /* ==================================================================
   * 5. Node shim 模块
   * ================================================================== */
  const SHIMS = {};

  /* ---------------- fs ---------------- */
  SHIMS.fs = function (module, exports) {
    const api = {
      existsSync: p => !!NB.call('file.exists', { path: p }).exists,
      statSync: p => {
        const r = NB.call('file.stat', { path: p });
        if (!r.exists) throw new Error('ENOENT: ' + p);
        return { size: r.size || 0, isDirectory: () => !!r.isDir, isFile: () => !r.isDir, mtimeMs: r.mtime || 0 };
      },
      mkdirSync: (p, o) => { NB.call('file.mkdir', { path: p, recursive: !(o && o.recursive === false) }); },
      readdirSync: (p, opts) => {
        const items = NB.call('file.list', { path: p }).items || [];
        if (opts && opts.withFileTypes) {
          return items.map(i => ({
            name: i.name,
            isDirectory: () => !!i.isDir,
            isFile: () => !i.isDir
          }));
        }
        return items.map(i => i.name);
      },
      renameSync: (a, b) => NB.call('file.rename', { from: a, to: b }),
      copyFileSync: (a, b) => { NB.call('file.copy', { from: a, to: b }); },
      unlinkSync: p => NB.call('file.remove', { path: p }),
      rmSync: (p, o) => NB.call('file.remove', { path: p, recursive: !(o && o.recursive === false) }),
      appendFileSync: (p, data) => api.writeFileSync(p, data, { flag: 'a' }),
      writeFileSync: (p, data, opts) => {
        const append = !!(opts && (opts.flag === 'a' || opts.append));
        if (typeof data === 'string') return NB.call('file.write', { path: p, text: data, append });
        // Buffer / Uint8Array
        const b64 = data instanceof Uint8Array ? bytesToB64(data) : Buf.from(data).toString('base64');
        return NB.call('file.write', { path: p, b64, append });
      },
      readFileSync: (p, opts) => {
        const enc = typeof opts === 'string' ? opts : (opts && opts.encoding);
        const r = NB.call('file.read', { path: p, text: !!enc });
        if (r.abs && (r.tooBig || (r.size || 0) > 512 * 1024)) {
          // 大文件：让原生给个可直接读的真实路径，用同步 XHR 取回，绕过桥接的体积限制
          try {
            const xhr = new XMLHttpRequest();
            xhr.open('GET', r.abs, false);
            xhr.overrideMimeType && xhr.overrideMimeType('text/plain; charset=x-user-defined');
            xhr.send();
            const bytes = Buf.from(String(xhr.responseText || '').length ? xhr.responseText : '', 'binary');
            return enc ? bytes.toString('utf8') : bytes;
          } catch (e) { /* 落到下面的常规返回 */ }
        }
        if (enc) return r.text == null ? '' : r.text;
        if (r.b64 != null) return Buf.from(r.b64, 'base64');
        return Buf.from(r.text || '', 'utf8');
      }
    };
    module.exports = api;
    exports.existsSync = api.existsSync;
  };

  /* ---------------- path ---------------- */
  SHIMS.path = function (module) {
    const clean = p => {
      const abs = String(p).startsWith('/');
      const out = [];
      for (const part of String(p).split('/')) {
        if (!part || part === '.') continue;
        if (part === '..') out.pop(); else out.push(part);
      }
      return (abs ? '/' : '') + out.join('/');
    };
    const api = {
      sep: '/', delimiter: ':',
      join: (...parts) => clean(parts.filter(Boolean).join('/')),
      resolve: (...parts) => clean(parts.filter(Boolean).join('/')),
      normalize: clean,
      basename: (p, ext) => {
        const parts = String(p).split('/').filter(Boolean);
        const last = parts[parts.length - 1] || '';
        return ext && last.endsWith(ext) ? last.slice(0, -ext.length) : last;
      },
      dirname: p => {
        const t = String(p).replace(/\/+$/, '').split('/');
        t.pop();
        const s = t.join('/');
        return (s || (String(p).startsWith('/') ? '/' : '.'));
      },
      extname: p => {
        const b = api.basename(p);
        const i = b.lastIndexOf('.');
        return i <= 0 ? '' : b.slice(i);
      },
      isAbsolute: p => String(p).startsWith('/'),
      relative: (from, to) => String(to).replace(String(from), '').replace(/^\//, ''),
      posix: {}
    };
    api.posix = api;
    module.exports = api;
  };

  /* ---------------- zlib ---------------- */
  SHIMS.zlib = function (module) {
    const wrap = (op, input) => {
      const b64 = input instanceof Uint8Array ? bytesToB64(input) : bytesToB64(Buf.from(input));
      const r = NB.call('zlib.' + op, { b64 });
      if (r.error) throw new Error('zlib ' + op + ' 失败：' + r.error);
      return Buf.from(r.b64, 'base64');
    };
    module.exports = {
      inflateRawSync: b => wrap('inflateRaw', b),
      deflateRawSync: b => wrap('deflateRaw', b),
      gunzipSync: b => wrap('gunzip', b),
      gzipSync: b => wrap('gzip', b),
      inflateSync: b => wrap('inflate', b),
      deflateSync: b => wrap('deflate', b),
      brotliDecompressSync: () => { throw new Error('brotli 不支持（安卓运行时没有解码器）'); }
    };
  };

  /* ---------------- http / https（net.js、webdav.js 都用） ---------------- */
  function makeHttp() {
    return function (module) {
      function request(target, opts, cb) {
        // 兼容两种调用：request(options, cb) 和 request(url, options, cb)
        let o = {}, cbFn = null;
        if (typeof opts === 'function') { cbFn = opts; }
        if (typeof target === 'string') {
          let u = null;
          try { u = new URL(target); } catch (e) { u = null; }
          o = Object.assign({}, (typeof opts === 'object' && opts) || {});
          if (u) {
            o.protocol = u.protocol; o.hostname = u.hostname; o.port = u.port;
            o.path = (u.pathname || '/') + (u.search || '');
            o.href = o.href || u.href;
          }
          if (typeof target === 'string' && !o.href) o.href = target;
        } else {
          o = Object.assign({}, target || {});
          if (typeof opts === 'object' && opts) Object.assign(o, opts);
        }
        if (!cbFn && typeof cb === 'function') cbFn = cb;

        const url = buildUrl(o);
        const bytesOf = x => {
          if (x == null) return null;
          if (typeof x === 'string') return utf8Encode(x);
          return asBytes(x);
        };

        const req = new EventEmitter();
        req.__body = o.__body || null;
        req.destroy = () => { req.__destroyed = true; };
        req.write = chunk => { req.__body = chunk; };
        req.end = chunk => {
          if (chunk != null) req.__body = chunk;
          const b = bytesOf(req.__body);
          doRequest(url, o, b ? bytesToB64(b) : null, req, cbFn);
        };
        req.setTimeout = () => req;
        req.setNoDelay = () => req;
        // net.js 立即调用 req.end()，这里 defer 一次保证 cb 已绑定 error 监听
        Promise.resolve().then(() => {
          if (!req.__ended) { req.__ended = true; req.end(); }
        });
        return req;
      }

      function doRequest(url, o, bodyOverride, req, cb) {
        /* 必须走异步桥：以前用同步 callSync，一条挂起的连接能把 JS 线程冻住 20 秒，
         * 网页搜书 / 换源（并发八个 worker 其实被同步桥串成一队）整页无响应。 */
        NB.callAsync('http.request', {
          url,
          method: o.method || 'GET',
          headers: o.headers || {},
          bodyB64: bodyOverride,
          timeout: o.timeout || 18000,
          maxBytes: o.maxBytes || (12 * 1024 * 1024),
          insecure: !!o.insecure,
          followRedirects: true
        }).then(r => {
          if (r.error) { const err = new Error(r.error); err.code = r.code || ''; req.emit('error', err); return; }

          const res = new EventEmitter();
          res.statusCode = r.status;
          res.statusMessage = '';
          res.headers = r.headers || {};
          res.url = r.url || url;
          const data = r.b64 ? Buf.from(r.b64, 'base64') : Buf.alloc(0);
          res.resume = () => res;
          res.setEncoding = () => res;
          // Node 语义：同一 tick 后依次派发 data / end
          Promise.resolve().then(() => {
            if (cb) cb(res);
            req.emit('response', res);
            if (data.length) res.emit('data', data);
            res.emit('end');
          });
        }).catch(e => {
          req.emit('error', e);
        });
      }

      function buildUrl(o) {
        if (o.href) return o.href;
        const proto = (o.protocol || 'https:').replace(/:$/, '');
        let host = o.hostname || o.host || '';
        if (o.port && !host.includes(':')) host += ':' + o.port;
        const p = o.path || o.pathname || '/';
        return proto + '://' + host + p;
      }

      module.exports = { request, get: request, Agent: function () { }, STATUS_CODES: {}, METHODS: ['GET', 'POST', 'PUT', 'DELETE', 'HEAD', 'PROPFIND', 'MKCOL', 'MOVE'] };
    };
  }
  SHIMS.http = makeHttp();
  SHIMS.https = makeHttp();

  /* ---------------- url ---------------- */
  SHIMS.url = function (module) {
    module.exports = {
      URL: URL,
      URLSearchParams: URLSearchParams,
      parse: (u) => {
        try { const x = new URL(u); return { href: x.href, protocol: x.protocol, hostname: x.hostname, port: x.port, pathname: x.pathname, search: x.search, host: x.host, auth: x.username ? decodeURIComponent(x.username) + ':' + decodeURIComponent(x.password) : null }; }
        catch (e) { return { href: u, hostname: '', pathname: '', search: '', auth: null }; }
      },
      fileURLToPath: u => String(u).replace('file://', ''),
      pathToFileURL: p => 'file://' + p
    };
  };

  /* ---------------- os ---------------- */
  SHIMS.os = function (module) {
    module.exports = {
      platform: () => 'android', tmpdir: () => '/tmp', EOL: '\n',
      homedir: () => '/', type: () => 'Linux', release: () => 'android', arch: () => 'arm64'
    };
  };

  /* ---------------- querystring / util（兜底，防止间接依赖） ---------------- */
  SHIMS.util = function (module) {
    module.exports = {
      inherits: (a, b) => { Object.setPrototypeOf(a.prototype, b.prototype); },
      promisify: fn => (...a) => new Promise((res, rej) => fn(...a, (e, v) => e ? rej(e) : res(v))),
      types: {}, inspect: x => JSON.stringify(x)
    };
  };
  SHIMS.querystring = function (module) {
    module.exports = {
      stringify: o => new URLSearchParams(o).toString(),
      parse: s => Object.fromEntries(new URLSearchParams(s))
    };
  };
  SHIMS.constants = function (module) { module.exports = {}; };
  SHIMS.stream = function (module) {
    class Stream extends EventEmitter { pipe(d) { return d; } }
    module.exports = { Stream, Readable: Stream, Writable: Stream, Duplex: Stream, Transform: Stream, PassThrough: Stream };
  };
  SHIMS.events = function (module) { module.exports = { EventEmitter }; };

  /* ==================================================================
   * 6. 载入桌面版的数据/网络/格式模块
   * ================================================================== */
  const env = step('env.info（原生桥）', () => NB.call('env.info'));
  const ROOT = (env.paths && env.paths.root) || '/moread';

  let store, netMod, legado, parseMod, webdavMod, zipMod;
  try {
    zipMod = step('加载 zip', () => requireImpl('./zip'));
    netMod = step('加载 net', () => requireImpl('./net'));
    webdavMod = step('加载 webdav', () => requireImpl('./webdav'));
    legado = step('加载 legado', () => requireImpl('./legado'));
    parseMod = step('加载 parse', () => requireImpl('./parse'));
    store = step('加载 store', () => requireImpl('./store'));
    step('store.init', () => store.init(ROOT));
  } catch (e) {
    NB.fire('app.log', { level: 'error', msg: '模块初始化失败: ' + (e && e.stack || e) });
    throw e;
  }

  /* 本地书：把主进程里的 loadParsed / local:chapter 复刻过来 */
  const parsedCache = new Map();
  /* v2：EPUB 图片支持上线后解析结果含 data URL 图片段，换名让老书重新解析一次 */
  const parsedPath = id => ROOT + '/cache/parsed/' + id + '.v2.json';
  function loadParsed(book) {
    if (parsedCache.has(book.id)) return parsedCache.get(book.id);
    let chapters = null;
    try {
      if (requireImpl('fs').existsSync(parsedPath(book.id))) {
        chapters = JSON.parse(requireImpl('fs').readFileSync(parsedPath(book.id), 'utf8'));
      }
    } catch (e) { chapters = null; }
    if (!chapters && book.localFile) {
      try {
        const abs = store.bookFilePath(book.localFile);
        const r = parseMod.parseLocalFile(abs);
        chapters = r.chapters;
        requireImpl('fs').mkdirSync(ROOT + '/cache/parsed', { recursive: true });
        requireImpl('fs').writeFileSync(parsedPath(book.id), JSON.stringify(chapters));
      } catch (e) { chapters = null; }
    }
    if (chapters) parsedCache.set(book.id, chapters);
    return chapters || [];
  }

  /* ==================================================================
   * 7. window.mo —— 与 preload.js 完全同名的实现
   * ================================================================== */
  let pendingZip = null;
  let lastZipInfo = null;

  function webdavConfig() {
    const s = store.getState().settings.webdav || {};
    const cfg = {
      url: String(s.url || '').trim(),
      user: String(s.user || '').trim(),
      pass: String(s.pass || ''),
      dir: String(s.dir || 'legado').replace(/^\/+|\/+$/g, '')
    };
    if (!cfg.url) throw new Error('还没填 WebDAV 地址（坚果云用 https://dav.jianguoyun.com/dav/）');
    if (!cfg.user || !cfg.pass) throw new Error('还没填账号和应用密码');
    return cfg;
  }
  const davBase = cfg => cfg.url.replace(/\/+$/, '') + '/';
  async function davDir(cfg, create) {
    const base = davBase(cfg);
    if (create) await webdavMod.ensureDir(cfg, base, cfg.dir);
    return webdavMod.joinUrl(base, cfg.dir);
  }
  function stampName() {
    const d = new Date(), p = n => String(n).padStart(2, '0');
    return 'moread-' + d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes()) + '.zip';
  }

  async function uploadBackup(includeFiles, auto) {
    const cfg = webdavConfig();
    const dir = await davDir(cfg, true);
    const name = auto ? 'moread-auto.zip' : stampName();
    const buf = legado.buildBackupZip(store.getState(), {
      includeFiles,
      readBookFile: store.readLocalFile
    });
    await webdavMod.put(cfg, webdavMod.joinUrl(dir, name), buf, 'application/zip');
    const s = store.getState().settings.webdav;
    s.lastBackupAt = Date.now();
    s.lastBackupName = name;
    store.saveNow();

    let pruned = 0;
    try {
      const keep = Math.max(1, Number(s.keep) || 10);
      const items = (await webdavMod.list(cfg, dir)).filter(i => !i.isDir && /\.zip$/i.test(i.name));
      items.sort((a, b) => b.lastmod - a.lastmod);
      for (const old of items.slice(keep)) { await webdavMod.del(cfg, webdavMod.joinUrl(dir, old.name)); pruned++; }
    } catch (e) { /* 清理失败不影响备份 */ }
    return { ok: true, name, size: buf.length, pruned, ms: 0 };
  }

  /** 把选中的文件（可能是外部 Uri）拷到内部目录，返回可用的内部路径 */
  function stage(p) {
    const r = NB.call('file.stage', { path: p });
    if (!r.path) throw new Error(r.error || '无法读取所选文件');
    return r.path;
  }
  /** 书名清洗：parse.js 拿文件名当书名，万一文件名被加上时间戳前缀
   *  （旧版本的暂存策略，或用户自己就是这么命名的），别把它原样显示出来 */
  function cleanBookName(title) {
    let s = String(title == null ? '' : title).trim();
    s = s.replace(/^\d{10,14}[-_]+/, '').trim();
    if (!s || /^\d{6,}$/.test(s)) return '未命名';
    return s.slice(0, 40);
  }

  /** 这个路径是不是已经躺在内部暂存目录里了（picker 选完就已经 stage 过） */
  function isStaged(p) {
    return typeof p === 'string' && p.indexOf(ROOT + '/tmp/') === 0;
  }
  /** 用完就删：暂存的是整本书，不清理会在私有目录里堆一份副本 */
  function cleanupStaged(p) {
    if (!isStaged(p)) return;
    /* 整批目录一起删。兼容层的 fs 没有 rmdirSync（只有 unlinkSync），
       只删文件会留下一堆空目录，所以这里交给原生的 file.remove，
       它对目录是 deleteRecursively。 */
    try {
      NB.call('file.remove', { path: p });
    } catch (e) { /* 清理失败不影响导入结果 */ }
    try {
      const path2 = requireImpl('path');
      const dir = path2.dirname(p);
      if (dir && dir.indexOf(ROOT + '/tmp/') === 0 && dir !== ROOT + '/tmp') {
        NB.call('file.remove', { path: dir });
      }
    } catch (e) { /* ignore */ }
  }
  function readStagedBuffer(p) {
    const abs = NB.call('file.abs', { path: p });
    const fs2 = requireImpl('fs');
    // 先试常规读取（小文件直接走桥接）
    try { return fs2.readFileSync(p); } catch (e) { /* 继续 */ }
    // 大文件走 XHR
    const xhr = new XMLHttpRequest();
    xhr.open('GET', abs.abs, false);
    xhr.overrideMimeType && xhr.overrideMimeType('text/plain; charset=x-user-defined');
    xhr.send();
    return Buf.from(xhr.responseText || '', 'binary');
  }

  const mo = {
    testMode: (function () { try { return /[?&]test=1/.test(location.search); } catch (e) { return false; } })(),

    /* ---- 窗口（安卓上没有概念，只做最小兼容，避免调用处报错） ----
       注意：桌面 preload 的这几个方法走 ipcRenderer.invoke，返回的都是 Promise，
       ui/app.js 里有 `mo.win.isFull().then(...)` 这种写法。这里必须同样返回 Promise，
       否则那一行会抛 "isFull(...).then is not a function"，而它在模块顶层执行，
       一抛整个 app.js 就中断 —— 所有按钮都不会被绑上事件，表现就是「点什么都没反应」。 */
    win: {
      minimize: async () => { NB.call('win.minimize'); },
      maximize: async () => false,
      close: async () => { NB.call('win.minimize'); },
      isMax: async () => false,
      fullscreen: async () => {
        const r = NB.call('win.fullscreen');
        document.body.classList.toggle('is-full', !!r.full);
        return !!r.full;
      },
      isFull: async () => !!NB.call('win.isFull').full,
      onState: cb => window.addEventListener('moread:winstate', e => cb(e.detail || {}))
    },

    info: () => NB.call('env.info'),
    openDir: () => { NB.call('app.toast', { msg: '安卓版没有文件夹可打开' }); },
    quit: () => NB.call('app.quit'),
    hide: () => NB.call('win.minimize'),

    /* ---- 存档 ---- */
    state: {
      get: () => store.getState(),
      set: next => { const s = store.setState(next); store.scheduleSave(); return s; }
    },
    cache: {
      get: (bookId, idx) => store.getCache(bookId, idx),
      set: (bookId, idx, payload) => { store.setCache(bookId, idx, payload); return true; },
      clear: bookId => { store.clearCache(bookId); return true; },
      size: () => store.cacheSize()
    },

    /* ---- 网络（直接复用桌面 net.js） ---- */
    net: async opts => {
      try {
        /* binary：漫画取图，返回 base64；不做字符解码，避免把二进制当文本弄坏 */
        if (opts && opts.binary) {
          const r = await netMod.request(opts.url, {
            headers: opts.headers,
            timeout: opts.timeout || 20000,
            maxBytes: opts.maxBytes || 8 * 1024 * 1024
          });
          if (r.status >= 400) return { ok: false, status: r.status, error: 'HTTP ' + r.status };
          const buf = r.buffer;
          const ct = String((r.headers && r.headers['content-type']) || '').split(';')[0].trim().toLowerCase();
          return {
            ok: true, status: r.status, url: r.url,
            mime: /^image\//.test(ct) ? ct : 'application/octet-stream',
            b64: buf.toString('base64'),
            bytes: buf.length
          };
        }
        const r = await netMod.fetchText(opts.url, {
          charset: opts.charset,
          method: opts.method || 'GET',
          body: opts.body,
          headers: opts.headers,
          timeout: opts.timeout || 18000
        });
        return { ok: true, status: r.status, url: r.url, charset: r.charset, text: r.text, ms: r.ms };
      } catch (e) {
        return { ok: false, error: e.message || String(e) };
      }
    },

    /* ---- 本地书 ---- */
    pickBooks: async () => {
      const r = await NB.callA('dialog.open', { mimes: ['text/plain', 'application/epub+zip', 'application/zip'], multiple: true });
      const items = r.items || [];
      /* 选完却读不了的文件不能安静地少一本：把失败原因直接告诉用户
         （典型场景：网盘/下载器把 .txt 存成没有读取权限的虚拟文档） */
      const bad = items.filter(i => i.error || !i.path);
      if (bad.length) {
        const msg = bad.slice(0, 2).map(i => (i.name || '文件') + '：' + (i.error || '读取失败')).join('；');
        NB.fire('app.toast', { msg: bad.length > 2 ? msg + ' 等 ' + bad.length + ' 个' : msg });
      }
      return items.filter(i => !i.error && i.path).map(i => i.path);
    },
    importLocal: async paths => {
      const fs2 = requireImpl('fs');
      const out = [];
      for (const p of paths) {
        let inner = p;
        try {
          /* pickBooks 已经把文件暂存到私有目录了，这里不能再 stage 一次：
             二次暂存既白复制一遍整本书，也会把落盘文件名换成新的时间戳前缀，
             而 parse.js 正是拿文件名当书名的 —— 书名会变成「1793502303574-t1」。 */
          if (!isStaged(p)) inner = stage(p);
          const r = parseMod.parseLocalFile(inner);
          const id = 'L' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
          const info = store.importBookFile(inner, id);
          const chapterTitles = r.chapters.map(c => c.title);
          fs2.mkdirSync(ROOT + '/cache/parsed', { recursive: true });
          fs2.writeFileSync(parsedPath(id), JSON.stringify(r.chapters));
          parsedCache.set(id, r.chapters);
          out.push({
            id, name: cleanBookName(r.title), author: r.author || '本地导入', kind: 'local',
            total: r.chapters.length, chapters: chapterTitles,
            localFile: info.file, ext: info.ext, size: info.size,
            groupId: 'g_default', intro: '', cover: '', createdAt: Date.now(), updatedAt: Date.now()
          });
        } catch (e) {
          out.push({ error: requireImpl('path').basename(p) + '：' + (e.message || e) });
        } finally {
          cleanupStaged(inner);
        }
      }
      return out;
    },
    /* 同时接受 localChapter(bookId, idx) 与 localChapter({bookId, idx}) 两种写法。
       之前这里只认对象，而 app.js 传的是两个位置参数，bookId 解构出来是 undefined，
       于是所有本地书都提示「书籍不存在」—— 桌面版调的是同一个函数名，所以只有安卓版会坏。 */
    localChapter: async (a, b) => {
      const bookId = (a && typeof a === 'object') ? (a.bookId || a.id) : a;
      const idx = (a && typeof a === 'object') ? a.idx : b;
      const book = store.getState().books.find(x => x.id === bookId);
      if (!book) return { ok: false, error: '书籍不存在' };
      const chapters = loadParsed(book);
      const ch = chapters[idx];
      if (!ch) {
        if (chapters.length) return { ok: false, error: '章节不存在' };
        /* 目录都没有：多半是正文文件不在（比如恢复的是「不含本地书」的备份，
           或者换设备后没把原文件带过来）。直接说清楚，别只回一句「章节不存在」。 */
        let hasFile = false;
        try {
          const raw = book.localFile ? store.readLocalFile(book.localFile) : null;
          hasFile = !!(raw && raw.length);
        } catch (e) { hasFile = false; }
        return {
          ok: false,
          error: hasFile
            ? '这本书解析不出章节，可能文件损坏，建议重新导入原文件'
            : '这本书的正文文件不在了（常见于恢复「不含本地书」的备份）。用「导入」重新选一次原 txt / epub 即可继续读'
        };
      }
      return { ok: true, title: ch.title, text: ch.text, total: chapters.length };
    },
    deleteBookFiles: bookId => {
      const st = store.getState();
      const b = st.books.find(x => x.id === bookId);
      if (b && b.localFile) store.removeBookFile(b.localFile);
      store.clearCache(bookId);
      parsedCache.delete(bookId);
      return true;
    },

    /* ---- 文件导入导出 ----
       注意：网页层（ui/app.js）一律按桌面的位置参数调用，例如
         mo.saveJson('a.json', text) / mo.openJson('标题') / mo.applyZip('merge')
       下面每个入口都同时接受「位置参数」和「对象」两种形式。只认对象的话，
       参数会静默变成 undefined，功能看似点了没反应，且不报错。 */
    saveJson: async (a, b) => await NB.callA('dialog.save', {
      name: (a && typeof a === 'object') ? a.name : a,
      mime: 'application/json',
      text: (a && typeof a === 'object') ? a.content : b
    }),
    openJson: async a => {
      const title = (a && typeof a === 'object') ? a.title : a;
      const r = await NB.callA('dialog.open', { mimes: ['application/json', 'text/plain'], multiple: false, title });
      if (!r.items || !r.items.length) return { ok: false };
      const p = stage(r.items[0].path);
      try {
        return { ok: true, name: r.items[0].name, text: requireImpl('fs').readFileSync(p, 'utf8') };
      } catch (e) { return { ok: false, error: e.message }; }
    },

    /* ---- 备份 ---- */
    exportBackup: async a => {
      const includeFiles = !!(a && typeof a === 'object' ? a.includeFiles : a);
      try {
        const payload = store.exportBackup(!!includeFiles);
        const stamp = new Date().toISOString().slice(0, 10);
        const r = await NB.callA('dialog.save', { name: 'moread-backup-' + stamp + '.json', mime: 'application/json', text: JSON.stringify(payload) });
        return r.ok ? { ok: true, path: r.path, size: r.size } : { ok: false };
      } catch (e) { return { ok: false, error: e.message }; }
    },
    pickBackup: async () => {
      const r = await NB.callA('dialog.open', { mimes: ['application/json'], multiple: false, title: '选择墨读备份' });
      if (!r.items || !r.items.length) return { ok: false };
      const p = stage(r.items[0].path);
      try {
        const payload = JSON.parse(requireImpl('fs').readFileSync(p, 'utf8'));
        if (payload.app !== 'moread' || !payload.data) return { ok: false, error: '不是墨读的备份文件' };
        return {
          ok: true, name: r.items[0].name, exportedAt: payload.exportedAt,
          summary: {
            books: (payload.data.books || []).length,
            sources: (payload.data.sources || []).length,
            bookmarks: (payload.data.bookmarks || []).length,
            withFiles: !!payload.files
          },
          payload
        };
      } catch (e) { return { ok: false, error: '读取失败：' + e.message }; }
    },
    applyBackup: a => {
      const payload = (a && typeof a === 'object') ? a.payload : a;
      const mode = (a && typeof a === 'object') ? a.mode : 'merge';
      try {
        const s = store.restoreBackup(payload, mode);
        parsedCache.clear();
        return { ok: true, state: s };
      } catch (e) { return { ok: false, error: e.message }; }
    },

    exportZip: async a => {
      const includeFiles = !!(a && typeof a === 'object' ? a.includeFiles : a);
      try {
        const buf = legado.buildBackupZip(store.getState(), { includeFiles, readBookFile: store.readLocalFile });
        const d = new Date(), p2 = n => String(n).padStart(2, '0');
        const name = '墨读备份-' + d.getFullYear() + p2(d.getMonth() + 1) + p2(d.getDate()) + '.zip';
        const r = await NB.callA('dialog.save', { name, mime: 'application/zip', b64: bytesToB64(buf) });
        return r.ok ? { ok: true, path: r.path, size: buf.length } : { ok: false };
      } catch (e) { return { ok: false, error: e.message }; }
    },
    pickZip: async () => {
      let r;
      try {
        r = await NB.callA('dialog.open', { mimes: ['application/zip', 'application/json', '*/*'], multiple: false, title: '选择备份文件（zip / json 都行）' });
      } catch (e) { return { ok: false, error: '打开文件失败：' + (e.message || e) }; }
      if (r && r.error) return { ok: false, error: r.error };
      if (!r || !r.items || !r.items.length) return { ok: false, canceled: !!(r && r.canceled) };
      const picked = r.items[0];
      if (picked.error) return { ok: false, error: '读取文件失败：' + picked.error };
      const name = picked.name || '备份文件';
      try {
        const inner = stage(picked.path);
        const buf = await readStagedBufferAsync(inner);
        const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf || []);
        const isZip = u8.length > 4 && u8[0] === 0x50 && u8[1] === 0x4b;   // PK
        /* 不看扩展名：手机导出的备份可能叫 .bak、.txt 甚至没有后缀。
           非 zip 一律按 JSON 备份解析，书架 + 书源 + 书签一起识别。 */
        if (!isZip) {
          const text = new TextDecoder('utf-8').decode(u8).replace(/^\uFEFF/, '');
          const j = legado.parseBackupJson(text);
          if (!j.ok) return { ok: false, error: j.error };
          lastZipInfo = { kind: j.kind, name };
          return {
            ok: true, kind: j.kind, name, summary: j.summary,
            sources: j.sources || null, legado: j.legado || null,
          };
        }
        const parsed = legado.parseBackupZip(buf);
        if (!parsed.ok) return { ok: false, error: parsed.error };
        if (parsed.kind === 'sources') {
          lastZipInfo = { kind: 'sources', name };
          return { ok: true, kind: 'sources', name, sources: parsed.sources, summary: parsed.summary };
        }
        pendingZip = { buffer: buf, parsed };
        lastZipInfo = { kind: parsed.kind, name };
        return { ok: true, kind: parsed.kind, name, summary: parsed.summary, legado: parsed.legado || null };
      } catch (e) { return { ok: false, error: '读取失败：' + e.message }; }
    },
    applyZip: a => {
      const mode = (a && typeof a === 'object') ? a.mode : (a || 'merge');
      if (!pendingZip) return { ok: false, error: '没有待恢复的备份，请重新选择' };
      const parsed = pendingZip.parsed;
      if (parsed.kind !== 'moread') return { ok: false, error: '这不是墨读完整备份' };
      try {
        const s = store.restoreBackup(parsed.payload, mode);
        let restoredLocal = 0;
        if (parsed.payload.fileMap) {
          const files = legado.readZipFiles(pendingZip.buffer, parsed.payload.fileMap);
          for (const id of Object.keys(files)) {
            const book = s.books.find(b => b.id === id);
            if (!book) continue;
            const info = parsed.payload.fileMap[id] || {};
            const raw = files[id];
            if (!raw) continue;
            // 必须把字节交给 writeLocalBook：早先这里转成 base64 字符串再写，
            // fs shim 会把字符串按 utf8 落盘，本地书就变成一堆 base64 文本，打开全是乱码。
            const buf = raw instanceof Uint8Array ? raw : Buf.from(raw);
            book.localFile = store.writeLocalBook(id, info.ext || book.ext || '.txt', buf);
            book.ext = info.ext || book.ext || '.txt';
            restoredLocal++;
          }
          store.saveNow();
        }
        parsedCache.clear();
        pendingZip = null;
        /* 备份里没带本地书文件（导出时没选「完整备份」）时，书架上书名进度都在，
           点开正文却是空的。数一下缺几本，让界面直说。
           注意：手机/网页版的 fs shim 读不到文件时不抛错，而是回一个空 buffer，
           所以这里必须连长度一起判断，不能只判 null。 */
        let missingLocal = 0;
        for (const b of s.books || []) {
          if (b.kind !== 'local') continue;
          const raw = b.localFile ? store.readLocalFile(b.localFile) : null;
          if (!raw || !raw.length) missingLocal++;
        }
        return { ok: true, state: s, restoredLocal, missingLocal };
      } catch (e) { return { ok: false, error: e.message }; }
    },
    testImportZip: async file => {
      try {
        const inner = stage(file);
        const buf = await readStagedBufferAsync(inner);
        const parsed = legado.parseBackupZip(buf);
        if (!parsed.ok) return { ok: false, error: parsed.error };
        pendingZip = { buffer: buf, parsed };
        lastZipInfo = { kind: parsed.kind, name: file };
        return { ok: true, kind: parsed.kind, name: requireImpl('path').basename(file), summary: parsed.summary, legado: parsed.legado || null };
      } catch (e) { return { ok: false, error: e.message }; }
    },

    /* ---- 坚果云 / WebDAV ---- */
    dav: {
      info: () => {
        const s = store.getState().settings.webdav || {};
        return {
          configured: !!(s.url && s.user && s.pass),
          url: s.url, user: s.user, dir: s.dir,
          hasPass: !!s.pass, lastBackupAt: s.lastBackupAt || 0,
          lastBackupName: s.lastBackupName || '', lastSyncAt: s.lastSyncAt || 0
        };
      },
      test: async () => {
        try {
          const cfg = webdavConfig();
          const r = await webdavMod.test(cfg);
          return { ok: true, ms: r.ms, items: r.items.length };
        } catch (e) { return { ok: false, error: e.message }; }
      },
      list: async () => {
        try {
          const cfg = webdavConfig();
          const dir = await davDir(cfg, false);
          const items = await webdavMod.list(cfg, dir);
          return {
            ok: true,
            items: items.filter(i => !i.isDir).map(i => ({ name: i.name, size: i.size, at: i.lastmod })).sort((a, b) => b.at - a.at)
          };
        } catch (e) { return { ok: false, error: e.message }; }
      },
      backup: async a => {
        const includeFiles = !!(a && typeof a === 'object' ? a.includeFiles : a);
        try {
          const t0 = Date.now();
          const r = await uploadBackup(includeFiles, false);
          return { ok: true, name: r.name, size: r.size, ms: Date.now() - t0, pruned: r.pruned };
        } catch (e) { return { ok: false, error: e.message }; }
      },
      download: async a => {
        const name = (a && typeof a === 'object') ? a.name : a;
        try {
          const cfg = webdavConfig();
          const dir = await davDir(cfg, false);
          const buf = await webdavMod.get(cfg, webdavMod.joinUrl(dir, name));
          const parsed = legado.parseBackupZip(buf);
          if (!parsed.ok) return { ok: false, error: parsed.error };
          pendingZip = { buffer: buf, parsed };
          return { ok: true, kind: parsed.kind, name, summary: parsed.summary, legado: parsed.legado || null };
        } catch (e) { return { ok: false, error: e.message }; }
      },
      remove: async a => {
        const name = (a && typeof a === 'object') ? a.name : a;
        try {
          const cfg = webdavConfig();
          const dir = await davDir(cfg, false);
          await webdavMod.del(cfg, webdavMod.joinUrl(dir, name));
          return { ok: true };
        } catch (e) { return { ok: false, error: e.message }; }
      },
      uploadSources: async () => {
        try {
          const cfg = webdavConfig();
          const dir = await davDir(cfg, true);
          const st = store.getState();
          const text = JSON.stringify(legado.toLegadoSources(st.sources));
          await webdavMod.put(cfg, webdavMod.joinUrl(dir, 'bookSource.json'), Buf.from(text, 'utf8'), 'application/json');
          const s = st.settings.webdav;
          s.lastSyncAt = Date.now();
          store.saveNow();
          return { ok: true, count: st.sources.length };
        } catch (e) { return { ok: false, error: e.message }; }
      },
      downloadSources: async () => {
        try {
          const cfg = webdavConfig();
          const dir = await davDir(cfg, false);
          const buf = await webdavMod.get(cfg, webdavMod.joinUrl(dir, 'bookSource.json'));
          const r = legado.parseSourceFile(buf.toString('utf8'));
          if (!r.ok) return r;
          const s = store.getState().settings.webdav;
          s.lastSyncAt = Date.now();
          store.saveNow();
          return { ok: true, sources: r.sources };
        } catch (e) { return { ok: false, error: e.message }; }
      },
      onAuto: cb => window.addEventListener('moread:autoBackup', e => cb(e.detail || {}))
    },

    /* ---- 安卓专有：朗读（WebView 不支持 speechSynthesis） ---- */
    tts: {
      available: () => NB.call('tts.state').ready,
      voices: async () => (NB.call('tts.voices').voices || []).map(v => ({
        name: v.name, lang: v.lang, voiceURI: v.id, default: v.id === (NB.call('tts.state').voice || ''),
        localService: true
      })),
      setVoice: v => NB.call('tts.set', { voice: v }),
      speak: (text, utteranceId) => NB.call('tts.speak', { text, id: utteranceId || String(Date.now()) }),
      stop: () => NB.call('tts.stop'),
      speaking: () => !!NB.call('tts.state').speaking,
      setRate: r => NB.call('tts.set', { rate: r }),
      setPitch: p => NB.call('tts.set', { pitch: p }),
      onEnd: cb => window.addEventListener('moread:tts', e => cb(e.detail || {}))
    },

    /* ---- 安卓专有：界面 ---- */
    ui: {
      toast: msg => NB.call('app.toast', { msg }),
      browse: url => NB.call('app.browse', { url }),
      layout: () => NB.call('env.layout'),
      keepScreenOn: on => NB.call('ui.keepScreenOn', { on }),
      setOrientation: mode => NB.call('ui.orientation', { mode }),
      share: (path, mime) => NB.call('app.share', { path, mime }),
      safeInsets: () => NB.call('env.insets')
    }
  };

  /**
   * 读取暂存的外部文件为 Buffer。
   * 优先走同步 XHR 直接读 file://（不受桥接返回值体积限制），读不到再退回 fs。
   */
  function readStagedBufferAsync(p) {
    const abs = NB.call('file.abs', { path: p });
    if (abs.abs) {
      return new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open('GET', abs.abs);
        xhr.responseType = 'arraybuffer';
        xhr.onload = () => {
          if (xhr.status === 200 && xhr.response) { resolve(new NodeBuffer(xhr.response)); return; }
          try { resolve(requireImpl('fs').readFileSync(p)); } catch (e) { reject(new Error('读取失败')); }
        };
        xhr.onerror = () => {
          try { resolve(requireImpl('fs').readFileSync(p)); } catch (e) { reject(new Error('读取所选文件失败')); }
        };
        xhr.send();
      });
    }
    return Promise.resolve(requireImpl('fs').readFileSync(p));
  }

  /* 调试/扩展入口（安卓模拟器测试会用到） */
  window.__moreadNode = { zip: zipMod, net: netMod, webdav: webdavMod, legado, parse: parseMod, store, Buffer: Buf, native: NB };

  window.mo = mo;
  window.MoNative = NB;
  window.__moreadReady = true;
  NB.fire('app.ready', { root: ROOT });
  window.dispatchEvent(new CustomEvent('moread:ready'));

  /* ==================================================================
   * 8. Web Speech API 补丁（桌面浏览器自带可用实现，跳过）
   * 安卓 WebView 里 speechSynthesis 对象存在但不出声，这里把它接到原生 TextToSpeech 上，
   * 界面里那套朗读代码一行都不用改。
   * ================================================================== */
  if (!WEB_DESKTOP) {   // 手机 / PWA：把 speechSynthesis 接到原生 TextToSpeech 上
  let ttsSeq = 0;
  const ttsPending = new Map();

  function SpeechVoice(v) {
    this.voiceURI = v.id;
    this.name = v.name;
    this.lang = v.lang;
    this.localService = !v.network;
    this.default = false;
  }
  function SpeechUtterance(text) {
    this.text = text == null ? '' : String(text);
    this.lang = 'zh-CN';
    this.voice = null;
    this.volume = 1;
    this.rate = 1;
    this.pitch = 1;
    this.onstart = null;
    this.onend = null;
    this.onerror = null;
    this.onboundary = null;
    this.__id = 'u' + (++ttsSeq);
  }
  function SpeechEvent(type, u, extra) {
    this.type = type;
    this.utterance = u;
    this.charIndex = 0;
    this.elapsedTime = 0;
    this.name = '';
    Object.assign(this, extra || {});
  }

  const speechSynthesis = {
    speaking: false, pending: false, paused: false,
    __l: Object.create(null),
    getVoices() {
      try { return (NB.call('tts.voices').voices || []).map(v => new SpeechVoice(v)); }
      catch (e) { return []; }
    },
    speak(u) {
      if (!u || !u.text) return;
      u.__cancelled = false;
      ttsPending.set(u.__id, u);
      let r = null;
      try {
        r = NB.call('tts.speak', {
          text: u.text, id: u.__id,
          lang: (u.voice && u.voice.lang) || u.lang || 'zh-CN',
          voiceURI: (u.voice && u.voice.voiceURI) || '',
          rate: u.rate || 1, pitch: u.pitch || 1,
          volume: u.volume == null ? 1 : u.volume
        });
      } catch (e) { r = { ok: false, error: e && e.message }; }
      /* 原生没接住（没装引擎 / 还在初始化）时必须回一个 error 事件，
         否则界面会以为朗读正常开始，静悄悄地一句话都不出。 */
      if (!r || r.ok === false) {
        ttsPending.delete(u.__id);
        this.speaking = ttsPending.size > 0;
        const msg = (r && r.error) || '语音引擎不可用';
        setTimeout(() => {
          if (u.onerror) { try { u.onerror(new SpeechEvent('error', u, { error: 'native', message: msg })); } catch (e) { } }
          this.__emit('error', new SpeechEvent('error', u, { error: 'native', message: msg }));
        }, 0);
        return;
      }
      this.speaking = true;
      if (u.onstart) { try { u.onstart(new SpeechEvent('start', u)); } catch (e) { } }
    },
    cancel() {
      try { NB.call('tts.stop'); } catch (e) { /* ignore */ }
      for (const u of Array.from(ttsPending.values())) {
        u.__cancelled = true;
        if (u.onerror) { try { u.onerror(new SpeechEvent('error', u, { error: 'interrupted' })); } catch (e) { } }
      }
      ttsPending.clear();
      this.speaking = false;
    },
    pause() { NB.call('tts.stop'); },
    resume() { },
    addEventListener(t, cb) { (this.__l[t] = this.__l[t] || []).push(cb); },
    removeEventListener(t, cb) {
      const l = this.__l[t];
      if (!l) return;
      const i = l.indexOf(cb);
      if (i >= 0) l.splice(i, 1);
    },
    /** 内部用：把 voiceschanged 派发给开关注过的监听者 */
    __emit(type, ev) {
      const l = this.__l[type];
      if (!l) return;
      for (const cb of l.slice()) { try { cb(ev); } catch (e) { /* 监听者自己出错不连累别人 */ } }
    }
  };

  try {
    Object.defineProperty(window, 'speechSynthesis', { value: speechSynthesis, configurable: true, writable: true });
  } catch (e) { try { window.speechSynthesis = speechSynthesis; } catch (e2) { } }
  window.SpeechSynthesisUtterance = SpeechUtterance;
  window.SpeechSynthesisVoice = SpeechVoice;
  window.SpeechSynthesisEvent = SpeechEvent;

  /* 原生的 TextToSpeech 是异步初始化的（真机上通常 0.3～3 秒），而界面早就渲染完了，
     设置页第一眼看到的必然是空列表。这里盯住音色数量，一有变化就派发 voiceschanged，
     和浏览器里的行为对齐。12 秒还没就绪就停（没装引擎的机器不用一直轮询）。 */
  (function watchVoices() {
    let last = -1;
    let ticks = 0;
    const tick = () => {
      let n = -1;
      try { n = (NB.call('tts.voices').voices || []).length; } catch (e) { n = -1; }
      if (n !== last) {
        last = n;
        speechSynthesis.__emit('voiceschanged', { type: 'voiceschanged' });
      }
      if (n > 0 || ++ticks > 40) return;             // 有音色了就不用再轮询
      setTimeout(tick, 300);
    };
    setTimeout(tick, 300);
  })();
  } /* end speech patch */

  /* ==================================================================
   * 9. 原生 → 页面 的回调入口
   * ================================================================== */
  window.MoApp = {
    /** 朗读事件回传 */
    tts(type, id, extra) {
      const u = ttsPending.get(id);
      speechSynthesis.speaking = ttsPending.size > 0;
      if (!u) return;
      if (type === 'done' || type === 'stopped') {
        ttsPending.delete(id);
        if (!u.__cancelled && u.onend) { try { u.onend(new SpeechEvent('end', u)); } catch (e) { } }
      } else if (type === 'error') {
        ttsPending.delete(id);
        if (!u.__cancelled && u.onerror) {
          try { u.onerror(new SpeechEvent('error', u, Object.assign({ error: 'synthesis-failed' }, extra || {}))); } catch (e) { }
        }
      }
    },
    /** 返回键 / 返回手势：返回 true 表示页面已经消费掉 */
    onBack() {
      const fn = window.__moreadOnBack;
      if (typeof fn === 'function') {
        try { return !!fn(); } catch (e) { return false; }
      }
      return false;
    },
    /** 横竖屏 / 折叠状态变化：原生推来的只是参考，方向最终以视口宽高为准 */
    onLayout(mode, info) {
      absorbNativeLayout(mode, info);
      const m = syncLayout();
      window.dispatchEvent(new CustomEvent('moread:layout', { detail: { mode: m, info: info || null } }));
    },
    /** 系统栏 / 刘海高度变化。
     *  以前只在启动时问一次 env.insets，那时监听器还没回调，拿到的永远是 0 ——
     *  于是 --sa-top 一直是 0px：顶栏钻到状态栏下面，或者反过来顶部留一大块。 */
    onInsets(ins) {
      if (!ins) return;
      nativeInfo.insets = ins;
      applyInsets(ins);
      window.dispatchEvent(new CustomEvent('moread:insets', { detail: ins }));
    },
    /** 外部用其他应用打开 txt / epub / 备份时送进来 */
    onOpenFile(payload) {
      window.dispatchEvent(new CustomEvent('moread:openfile', { detail: payload || {} }));
    },
    onPause() { window.dispatchEvent(new CustomEvent('moread:pause')); },
    onResume() { window.dispatchEvent(new CustomEvent('moread:resume')); }
  };

  /* ==================================================================
   * 10. 横竖屏 / 折叠屏布局
   *
   * 关键：方向以「页面自己看到的视口宽高」为准，原生推送只当参考。
   * 原生那一路可能丢（页面还没就绪时 evaluateJavascript 白送）、可能慢一拍，
   * 也可能与 WebView 实际视口不一致；而 window.innerWidth/innerHeight 不会说谎。
   * 最小宽度（sw）反过来只能信原生——折叠屏折叠/展开会变，页面自己算不出来。
   *
   *   portrait  竖屏：底部导航
   *   landscape 横屏：左侧栏
   *   wide      横屏且最小宽度 ≥600dp（平板 / 折叠屏展开）：左侧宽栏
   * ================================================================== */
  const nativeInfo = { mode: null, sw: 0, bucket: '', insets: null, corners: null };

  function absorbNativeLayout(mode, info) {
    if (mode) nativeInfo.mode = mode;
    if (!info) return;
    if (info.sw) nativeInfo.sw = info.sw;
    if (info.bucket) nativeInfo.bucket = info.bucket;
    if (info.insets) nativeInfo.insets = info.insets;
    if (info.corners) nativeInfo.corners = info.corners;
  }

  function viewportSize() {
    const de = document.documentElement;
    return {
      w: window.innerWidth || (de && de.clientWidth) || 0,
      h: window.innerHeight || (de && de.clientHeight) || 0
    };
  }

  function bucketOf(sw) {
    if (sw >= 840) return 'expanded';
    if (sw >= 600) return 'medium';
    return 'compact';
  }

  function detectMode() {
    const v = viewportSize();
    if (!v.w || !v.h) return nativeInfo.mode || 'portrait';
    const sw = nativeInfo.sw > 0 ? nativeInfo.sw : Math.min(v.w, v.h);
    // 宽 > 高 就是横屏，不再看原生给的 orientation（它跟视口可能不一致）
    if (v.w > v.h) return sw >= 600 ? 'wide' : 'landscape';
    return 'portrait';
  }

  /** 安全区兜底：原生值就算单位搞错（物理 px 当 CSS px）、或者异形屏给出离谱数字，
   *  也不能让顶栏占掉小半个屏幕。上限按视口高度取，最大不超过 64 / 48。 */
  function saneInset(v, cap) {
    v = Math.round(Number(v) || 0);
    if (v < 0) v = 0;
    const h = (typeof innerHeight === 'number' && innerHeight > 0) ? innerHeight : 640;
    return Math.min(v, cap, Math.round(h * 0.12));
  }

  /** 上一次拿到的有效安全区。转屏 / 视口尺寸变化的瞬间，系统会先派发一次全 0 的
   *  insets（窗口还没重新布局），照单全收的话顶栏会「啪」一下贴上状态栏，
   *  紧跟着再弹回来 —— 保留上一个有效值等下一次真值。 */
  let lastGoodInset = { top: 0, bottom: 0 };

  function applyInsets(ins) {
    const de = document.documentElement;
    ins = ins || {};
    const full = document.body && document.body.classList.contains('is-full');
    let top = saneInset(ins.top, 64);
    let bottom = saneInset(ins.bottom, 48);
    /* 只有真全屏（用户主动隐藏系统栏）才接受 0；其余情况当作瞬时无效值 */
    if (top === 0 && !full && lastGoodInset.top > 0) top = lastGoodInset.top;
    if (bottom === 0 && !full && lastGoodInset.bottom > 0) bottom = lastGoodInset.bottom;
    if (top > 0) lastGoodInset.top = top;
    if (bottom > 0) lastGoodInset.bottom = bottom;
    de.style.setProperty('--sa-top', top + 'px');
    de.style.setProperty('--sa-bottom', bottom + 'px');
    de.style.setProperty('--sa-left', saneInset(ins.left, 48) + 'px');
    de.style.setProperty('--sa-right', saneInset(ins.right, 48) + 'px');
  }

  /** 屏幕圆角半径：拿不到当 0（直角屏），拿到就给 CSS 用来避开四角 */
  function applyCorners(c) {
    const de = document.documentElement;
    c = c || {};
    const tl = c.tl || 0, tr = c.tr || 0, bl = c.bl || 0, br = c.br || 0;
    de.style.setProperty('--corner-tl', tl + 'px');
    de.style.setProperty('--corner-tr', tr + 'px');
    de.style.setProperty('--corner-bl', bl + 'px');
    de.style.setProperty('--corner-br', br + 'px');
    de.style.setProperty('--corner', Math.max(tl, tr, bl, br) + 'px');
  }

  function syncLayout() {
    const de = document.documentElement;
    de.classList.add('is-android');
    const mode = detectMode();
    de.setAttribute('data-layout', mode);
    const v = viewportSize();
    const sw = nativeInfo.sw > 0 ? nativeInfo.sw : Math.min(v.w || 360, v.h || 640);
    de.setAttribute('data-sw', nativeInfo.bucket || bucketOf(sw));
    window.__moreadLayout = mode;
    if (!nativeInfo.insets) { try { nativeInfo.insets = NB.call('env.insets'); } catch (e) { } }
    applyInsets(nativeInfo.insets);
    if (!nativeInfo.corners) { try { nativeInfo.corners = NB.call('env.corners'); } catch (e) { } }
    applyCorners(nativeInfo.corners);
    return mode;
  }

  /* 自己盯着视口：旋转、折叠屏开合、分屏、键盘都会让尺寸变 */
  function watchViewport() {
    let t = null;
    const run = () => {
      if (t) { clearTimeout(t); t = null; }
      t = setTimeout(syncLayout, 60);
      // 旋转瞬间视口尺寸可能还没更新，补两枪
      setTimeout(syncLayout, 220);
      setTimeout(syncLayout, 600);
    };
    window.addEventListener('resize', run);
    window.addEventListener('orientationchange', run);
    if (window.visualViewport && window.visualViewport.addEventListener) {
      window.visualViewport.addEventListener('resize', run);
    }
    try {
      const mq = window.matchMedia('(orientation: portrait)');
      if (mq.addEventListener) mq.addEventListener('change', run);
      else if (mq.addListener) mq.addListener(run);
    } catch (e) { /* 老 WebView 没有 */ }
  }

  // 兼容旧名字
  function applyLayout(mode, info) { absorbNativeLayout(mode, info); return syncLayout(); }

  if (!WEB_DESKTOP) {
    try { syncLayout(); } catch (e) { markAndroid(); }
    try { watchViewport(); } catch (e) { }
    // 首屏原生那边的推送可能还没到（或已丢失），主动问一次拿 sw / insets / 圆角
    try {
      const l = NB.call('env.layout');
      absorbNativeLayout(l && l.mode, l);
      syncLayout();
    } catch (e) { /* 保持上面算出来的结果 */ }
  }
})();
