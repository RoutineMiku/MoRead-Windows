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
      de.classList.add('is-android');
      if (!de.getAttribute('data-layout')) de.setAttribute('data-layout', 'portrait');
      // 桌面 Electron 的自绘窗口按钮，安卓上直接摘掉（比 display:none 更彻底）
      var wb = document.querySelector('.winbtns');
      if (wb && wb.parentNode) wb.parentNode.removeChild(wb);
      var dz = document.querySelector('.dropzone');
      if (dz && dz.parentNode) dz.parentNode.removeChild(dz);
    } catch (e) { /* 界面标记失败也不能影响后续 */ }
  }
  markAndroid();
  // bridge.js 在 body 末尾，此时 .winbtns 已存在；仍兜一层，防止将来挪到 head
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', markAndroid);
  }
  window.__moreadMarkAndroid = markAndroid;

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
    fire(name, payload) {   // 单向通知（不需要返回值）
      try { MoNativeBridge.callFire(name, JSON.stringify(payload == null ? {} : payload)); } catch (e) { /* ignore */ }
    }
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
        let r;
        try {
          r = NB.call('http.request', {
            url,
            method: o.method || 'GET',
            headers: o.headers || {},
            bodyB64: bodyOverride,
            timeout: o.timeout || 18000,
            maxBytes: o.maxBytes || (12 * 1024 * 1024),
            insecure: !!o.insecure,
            followRedirects: true
          });
        } catch (e) {
          req.emit('error', e);
          return;
        }
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
  const env = NB.call('env.info');
  const ROOT = (env.paths && env.paths.root) || '/moread';

  let store, netMod, legado, parseMod, webdavMod, zipMod;
  try {
    zipMod = requireImpl('./zip');
    netMod = requireImpl('./net');
    webdavMod = requireImpl('./webdav');
    legado = requireImpl('./legado');
    parseMod = requireImpl('./parse');
    store = requireImpl('./store');
    store.init(ROOT);
  } catch (e) {
    NB.fire('app.log', { level: 'error', msg: '模块初始化失败: ' + (e && e.stack || e) });
    throw e;
  }

  /* 本地书：把主进程里的 loadParsed / local:chapter 复刻过来 */
  const parsedCache = new Map();
  const parsedPath = id => ROOT + '/cache/parsed/' + id + '.json';
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
    testMode: false,

    /* ---- 窗口（安卓上没有概念，只做最小兼容，避免调用处报错） ---- */
    win: {
      minimize: () => NB.call('win.minimize'),
      maximize: () => false,
      close: () => NB.call('win.minimize'),
      isMax: () => false,
      fullscreen: async () => {
        const r = NB.call('win.fullscreen');
        document.body.classList.toggle('is-full', !!r.full);
        return !!r.full;
      },
      isFull: () => !!NB.call('win.isFull').full,
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
      const r = NB.call('dialog.open', { mimes: ['text/plain', 'application/epub+zip', 'application/zip'], multiple: true });
      return r.items ? r.items.map(i => i.path) : [];
    },
    importLocal: async paths => {
      const fs2 = requireImpl('fs');
      const out = [];
      for (const p of paths) {
        try {
          const inner = stage(p);
          const r = parseMod.parseLocalFile(inner);
          const id = 'L' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
          const info = store.importBookFile(inner, id);
          const chapterTitles = r.chapters.map(c => c.title);
          fs2.mkdirSync(ROOT + '/cache/parsed', { recursive: true });
          fs2.writeFileSync(parsedPath(id), JSON.stringify(r.chapters));
          parsedCache.set(id, r.chapters);
          out.push({
            id, name: r.title, author: r.author || '本地导入', kind: 'local',
            total: r.chapters.length, chapters: chapterTitles,
            localFile: info.file, ext: info.ext, size: info.size,
            groupId: 'g_default', intro: '', cover: '', createdAt: Date.now(), updatedAt: Date.now()
          });
        } catch (e) {
          out.push({ error: requireImpl('path').basename(p) + '：' + (e.message || e) });
        }
      }
      return out;
    },
    localChapter: async ({ bookId, idx }) => {
      const book = store.getState().books.find(b => b.id === bookId);
      if (!book) return { ok: false, error: '书籍不存在' };
      const chapters = loadParsed(book);
      const ch = chapters[idx];
      if (!ch) return { ok: false, error: '章节不存在' };
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

    /* ---- 文件导入导出 ---- */
    saveJson: ({ name, content }) => NB.call('dialog.save', { name, mime: 'application/json', text: content }),
    openJson: ({ title }) => {
      const r = NB.call('dialog.open', { mimes: ['application/json', 'text/plain'], multiple: false, title });
      if (!r.items || !r.items.length) return { ok: false };
      const p = stage(r.items[0].path);
      try {
        return { ok: true, name: r.items[0].name, text: requireImpl('fs').readFileSync(p, 'utf8') };
      } catch (e) { return { ok: false, error: e.message }; }
    },

    /* ---- 备份 ---- */
    exportBackup: async ({ includeFiles }) => {
      try {
        const payload = store.exportBackup(!!includeFiles);
        const stamp = new Date().toISOString().slice(0, 10);
        const r = NB.call('dialog.save', { name: 'moread-backup-' + stamp + '.json', mime: 'application/json', text: JSON.stringify(payload) });
        return r.ok ? { ok: true, path: r.path, size: r.size } : { ok: false };
      } catch (e) { return { ok: false, error: e.message }; }
    },
    pickBackup: async () => {
      const r = NB.call('dialog.open', { mimes: ['application/json'], multiple: false, title: '选择墨读备份' });
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
    applyBackup: ({ payload, mode }) => {
      try {
        const s = store.restoreBackup(payload, mode);
        parsedCache.clear();
        return { ok: true, state: s };
      } catch (e) { return { ok: false, error: e.message }; }
    },

    exportZip: async ({ includeFiles }) => {
      try {
        const buf = legado.buildBackupZip(store.getState(), { includeFiles, readBookFile: store.readLocalFile });
        const d = new Date(), p2 = n => String(n).padStart(2, '0');
        const name = '墨读备份-' + d.getFullYear() + p2(d.getMonth() + 1) + p2(d.getDate()) + '.zip';
        const r = NB.call('dialog.save', { name, mime: 'application/zip', b64: bytesToB64(buf) });
        return r.ok ? { ok: true, path: r.path, size: buf.length } : { ok: false };
      } catch (e) { return { ok: false, error: e.message }; }
    },
    pickZip: async () => {
      const r = NB.call('dialog.open', { mimes: ['application/zip', 'application/json', '*/*'], multiple: false, title: '选择备份（墨读 zip 或原版阅读备份）' });
      if (!r.items || !r.items.length) return { ok: false };
      const inner = stage(r.items[0].path);
      const name = r.items[0].name;
      try {
        if (/\.json$/i.test(name)) {
          const text = requireImpl('fs').readFileSync(inner, 'utf8');
          const src = legado.parseSourceFile(text);
          if (src.ok && src.sources.length) {
            lastZipInfo = { kind: 'sources', name };
            return { ok: true, kind: 'sources', name, sources: src.sources, summary: { sources: src.sources.length, books: 0, bookmarks: 0 } };
          }
          return { ok: false, error: '这个 JSON 里没有识别到书源' };
        }
        const buf = await readStagedBufferAsync(inner);
        const parsed = legado.parseBackupZip(buf);
        if (!parsed.ok) return { ok: false, error: parsed.error };
        pendingZip = { buffer: buf, parsed };
        lastZipInfo = { kind: parsed.kind, name };
        return { ok: true, kind: parsed.kind, name, summary: parsed.summary, legado: parsed.legado || null };
      } catch (e) { return { ok: false, error: '读取失败：' + e.message }; }
    },
    applyZip: ({ mode }) => {
      if (!pendingZip) return { ok: false, error: '没有待恢复的备份，请重新选择' };
      const parsed = pendingZip.parsed;
      if (parsed.kind !== 'moread') return { ok: false, error: '这不是墨读完整备份' };
      try {
        const s = store.restoreBackup(parsed.payload, mode);
        if (parsed.payload.fileMap) {
          const files = legado.readZipFiles(pendingZip.buffer, parsed.payload.fileMap);
          for (const id of Object.keys(files)) {
            const book = s.books.find(b => b.id === id);
            if (!book) continue;
            const info = parsed.payload.fileMap[id] || {};
            const b64 = files[id] instanceof Uint8Array ? bytesToB64(files[id]) : null;
            if (!b64) continue;
            book.localFile = store.writeLocalBook(id, info.ext || book.ext || '.txt', b64);
            book.ext = info.ext || book.ext || '.txt';
          }
          store.saveNow();
        }
        parsedCache.clear();
        pendingZip = null;
        return { ok: true, state: s };
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
      backup: async ({ includeFiles }) => {
        try {
          const t0 = Date.now();
          const r = await uploadBackup(!!includeFiles, false);
          return { ok: true, name: r.name, size: r.size, ms: Date.now() - t0, pruned: r.pruned };
        } catch (e) { return { ok: false, error: e.message }; }
      },
      download: async ({ name }) => {
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
      remove: async ({ name }) => {
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
   * 8. Web Speech API 补丁
   * 安卓 WebView 里 speechSynthesis 对象存在但不出声，这里把它接到原生 TextToSpeech 上，
   * 界面里那套朗读代码一行都不用改。
   * ================================================================== */
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
      NB.call('tts.speak', {
        text: u.text, id: u.__id,
        lang: (u.voice && u.voice.lang) || u.lang || 'zh-CN',
        voiceURI: (u.voice && u.voice.voiceURI) || '',
        rate: u.rate || 1, pitch: u.pitch || 1,
        volume: u.volume == null ? 1 : u.volume
      });
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
    }
  };

  try {
    Object.defineProperty(window, 'speechSynthesis', { value: speechSynthesis, configurable: true, writable: true });
  } catch (e) { try { window.speechSynthesis = speechSynthesis; } catch (e2) { } }
  window.SpeechSynthesisUtterance = SpeechUtterance;
  window.SpeechSynthesisVoice = SpeechVoice;
  window.SpeechSynthesisEvent = SpeechEvent;

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
    /** 横竖屏 / 折叠状态变化 */
    onLayout(mode, info) {
      window.__moreadLayout = mode;
      if (info) window.__moreadInsets = info;
      applyLayout(mode, info);
      window.dispatchEvent(new CustomEvent('moread:layout', { detail: { mode, info } }));
    },
    /** 外部用其他应用打开 txt / epub / 备份时送进来 */
    onOpenFile(payload) {
      window.dispatchEvent(new CustomEvent('moread:openfile', { detail: payload || {} }));
    },
    onPause() { window.dispatchEvent(new CustomEvent('moread:pause')); },
    onResume() { window.dispatchEvent(new CustomEvent('moread:resume')); }
  };

  /* ==================================================================
   * 10. 横竖屏 / 折叠屏布局：给 body 打标记，剩下的交给 CSS
   *     portrait 竖屏（底部导航）｜ landscape 横屏（左侧栏）｜ wide 展开态（左侧宽栏）
   * ================================================================== */
  function applyLayout(mode, info) {
    // 先保证形态标记一定在（安全区取不到也不能把布局搞没）
    document.documentElement.setAttribute('data-layout', mode || 'portrait');
    document.documentElement.classList.add('is-android');
    let ins = (info && info.insets) || null;
    if (!ins) {
      try { ins = NB.call('env.insets'); } catch (e) { ins = null; }
    }
    ins = ins || {};
    document.documentElement.style.setProperty('--sa-top', (ins.top || 0) + 'px');
    document.documentElement.style.setProperty('--sa-bottom', (ins.bottom || 0) + 'px');
    document.documentElement.style.setProperty('--sa-left', (ins.left || 0) + 'px');
    document.documentElement.style.setProperty('--sa-right', (ins.right || 0) + 'px');
    // 首次进来也主动问一次形态，避免只按竖屏渲染
    try {
      const l = NB.call('env.layout');
      if (l && l.mode) document.documentElement.setAttribute('data-layout', l.mode);
    } catch (e) { /* keep */ }
  }
  try { applyLayout('portrait', null); } catch (e) { markAndroid(); }
})();
