/* ===========================================================
   书源规则引擎
   兼容 Legado(阅读) 书源 JSON 的常用字段：
     searchUrl / ruleSearch / ruleBookInfo / ruleToc / ruleContent
   规则写法支持：
     1) CSS 选择器 + @text/@href/@src/@html       例：#list dd a@text
     2) Legado 旧语法                             例：class.book@tag.a@text
     3) JSON 路径                                 例：$.data.list[*].name
     4) {{ JS 表达式 }} / @js:xxx                 例：{{result.split('|')[0]}}
     5) "||" 备选规则，从左到右取第一个非空结果
   =========================================================== */
(function (global) {
  'use strict';

  const ATTRS = new Set(['text', 'owntext', 'href', 'src', 'html', 'content', 'textnodes']);

  function absUrl(base, href) {
    if (!href) return '';
    try { return new URL(href, base).href; } catch (e) { return href; }
  }

  function doc(html) {
    return new DOMParser().parseFromString(html || '', 'text/html');
  }

  /* ---------- 规则 → CSS ---------- */
  /**
   * 旧语法拆成「步」：class.x@tag.a / id.x.1@dd / .css@tag.a.0 / tag.tr!0
   * 步上的 .N 表示取第 N 个（-1 为最后一个），!N（或 !a:b）表示剔除，Legado 规则常见
   */
  function parseSteps(sel) {
    const parts = String(sel).split('@').map(s => s.trim()).filter(Boolean);
    const steps = [];
    for (let p of parts) {
      let skip = null;
      const ex = /^(.*?)!(-?\d+)(?::(-?\d+))?$/.exec(p);
      if (ex && ex[1]) {
        p = ex[1];
        skip = [+ex[2], ex[3] != null ? +ex[3] : +ex[2]];
      }
      let m = /^(class|id|tag)\.(.+)$/.exec(p);
      if (m) {
        let name = m[2], index = null;
        const im = /^(.+)\.(-?\d+)$/.exec(name);
        if (im) { name = im[1]; index = parseInt(im[2], 10); }
        steps.push({ type: m[1], name, index, skip, css: m[1] === 'class' ? '.' + name : m[1] === 'id' ? '#' + name : name });
        continue;
      }
      m = /^([A-Za-z][\w-]*)(?:\.(-?\d+))?$/.exec(p);
      if (m) { steps.push({ type: 'tag', name: m[1], index: m[2] != null ? +m[2] : null, skip, css: m[1] }); continue; }
      steps.push({ type: 'css', css: p, skip });
    }
    return steps;
  }

  /** !N / !a:b 剔除指定位置 */
  function applySkip(arr, skip) {
    if (!skip) return arr;
    const n = arr.length;
    const s = skip[0] < 0 ? n + skip[0] : skip[0];
    const e = skip[1] < 0 ? n + skip[1] : skip[1];
    const drop = new Set();
    for (let i = Math.min(s, e); i <= Math.max(s, e); i++) drop.add(i);
    const out = arr.filter((_, i) => !drop.has(i));
    return out;
  }

  function selectSteps(root, steps) {
    let pool = [root];
    for (const st of steps) {
      const next = [];
      for (const r of pool) {
        let ns = [];
        try { ns = [...r.querySelectorAll(st.css)]; } catch (e) { ns = []; }
        for (const n of ns) next.push(n);
      }
      let list = applySkip(next, st.skip);
      if (!list.length) return [];
      if (st.index == null) { pool = list; continue; }
      const i = st.index < 0 ? list.length + st.index : st.index;
      pool = list[i] ? [list[i]] : [];
      if (!pool.length) return [];
    }
    return pool;
  }

  /** text. 规则：按可见文字找节点（原版 bookSource 里 text.下一页@href 这类极多） */
  function textNodes(root, want) {
    const target = String(want || '').replace(/\s+/g, '').trim();
    if (!target || !root.querySelectorAll) return [];
    const all = root.querySelectorAll('a,button,option,li,span,div,p,td,dd,dt,em,strong,label');
    const exact = [], starts = [], has = [];
    for (const el of all) {
      const t = (el.textContent || '').replace(/\s+/g, '').trim();
      if (!t || t.length > 40) continue;
      if (t === target) exact.push(el);
      else if (t.startsWith(target)) starts.push(el);
      else if (t.includes(target)) has.push(el);
    }
    return [...exact, ...starts, ...has];
  }

  /** 用规则选节点（自动走旧语法步进 / 纯 CSS / text. 文字匹配） */
  function selectNodes(root, rule) {
    if (!root || !root.querySelectorAll) return [];
    const sp = splitRule(rule);
    if (!sp) return [];
    if (sp.text != null) return textNodes(root, sp.text);
    try {
      return sp.steps ? selectSteps(root, sp.steps) : [...root.querySelectorAll(sp.sel)];
    } catch (e) { return []; }
  }

  function splitRule(rule) {
    const raw = String(rule || '').trim();
    if (!raw) return null;
    // text.可见文字[@属性]
    if (/^text\./i.test(raw)) {
      let rest = raw.slice(5);
      let attr = null;
      const m = /@(text|href|src|html|content|owntext)$/i.exec(rest);
      if (m) { attr = m[1].toLowerCase(); rest = rest.slice(0, m.index); }
      return { text: rest.trim(), sel: '', attr, steps: null };
    }
    const parts = raw.split('@');
    let attr = null;
    if (parts.length > 1 && ATTRS.has(parts[parts.length - 1].trim().toLowerCase())) {
      attr = parts.pop().trim().toLowerCase();
    }
    const sel = parts.join('@').trim();
    if (!sel) return null;
    const legacy = raw.includes('@') || /^(class|id|tag)\./.test(sel);
    return { sel, attr, steps: legacy ? parseSteps(sel) : null };
  }

  /* ---------- 规则后处理：##正则##替换 / ###取匹配 ---------- */  function splitPost(rule) {
    const s = String(rule);
    const i = s.indexOf('##');
    if (i < 0) return { core: s.trim(), post: null };
    const core = s.slice(0, i).trim();
    let rest = s.slice(i);
    let matchOnly = false;
    if (rest.startsWith('###')) { matchOnly = true; rest = rest.slice(3); }
    else rest = rest.slice(2);
    let repl = null;
    const j = rest.indexOf('##');
    if (j >= 0) { repl = rest.slice(j + 2); rest = rest.slice(0, j); }
    return { core, post: { regex: rest, repl, matchOnly } };
  }

  function applyPost(v, post) {
    const s = String(v);
    if (!post || !post.regex) return s;
    try {
      if (post.matchOnly) {
        const m = s.match(new RegExp(post.regex));
        return m ? String(m[0]).trim() : '';
      }
      return s.replace(new RegExp(post.regex, 'g'), post.repl == null ? '' : post.repl).trim();
    } catch (e) { return s; }
  }

  /* ---------- JSON 路径（支持 Legado 的 .. 递归下降与 [*] 通配） ---------- */
  function parseJsonPath(p) {
    const s = String(p || '').trim().replace(/^\$/, '');
    const toks = [];
    let i = 0;
    while (i < s.length) {
      const ch = s[i];
      if (ch === ' ') { i++; continue; }
      if (s.startsWith('..', i)) {
        i += 2;
        const m = /^[^.[\]]+/.exec(s.slice(i));
        if (!m) { toks.push({ t: 'desc' }); continue; }
        toks.push({ t: 'desc', key: m[0] });
        i += m[0].length;
        continue;
      }
      if (ch === '.') { i++; continue; }
      if (ch === '[') {
        const j = s.indexOf(']', i);
        if (j < 0) break;
        const inner = s.slice(i + 1, j).trim();
        i = j + 1;
        if (inner === '*') toks.push({ t: 'wild' });
        else if (/^-?\d+$/.test(inner)) toks.push({ t: 'idx', n: +inner });
        else toks.push({ t: 'key', key: inner.replace(/^['"]|['"]$/g, '') });
        continue;
      }
      const m = /^[^.[\]]+/.exec(s.slice(i));
      if (!m) break;
      toks.push({ t: 'key', key: m[0] });
      i += m[0].length;
    }
    return toks;
  }

  /** 递归收集某个 key 的所有值（对应 JSONPath 的 ..key） */
  function collectDesc(v, key, out, depth) {
    if (depth > 14 || v == null) return;
    if (Array.isArray(v)) { for (const x of v) collectDesc(x, key, out, depth + 1); return; }
    if (typeof v === 'object') {
      for (const k of Object.keys(v)) {
        if (!key || k === key) out.push(v[k]);
        collectDesc(v[k], key, out, depth + 1);
      }
    }
  }

  function jsonQuery(data, path) {
    let cur = [data];
    for (const tk of parseJsonPath(path)) {
      const next = [];
      for (const v of cur) {
        if (v == null) continue;
        if (tk.t === 'key') {
          if (Array.isArray(v)) { if (/^\d+$/.test(tk.key)) next.push(v[+tk.key]); }
          else if (typeof v === 'object') next.push(v[tk.key]);
        } else if (tk.t === 'idx') {
          if (Array.isArray(v)) {
            const k = tk.n < 0 ? v.length + tk.n : tk.n;
            if (v[k] !== undefined) next.push(v[k]);
          }
        } else if (tk.t === 'wild') {
          if (Array.isArray(v)) next.push(...v);
          else if (typeof v === 'object') next.push(...Object.values(v));
        } else if (tk.t === 'desc') {
          collectDesc(v, tk.key, next, 0);
        }
      }
      cur = next;
    }
    return cur.filter(v => v !== undefined);
  }

  function jsonPath(data, path) {
    const r = jsonQuery(data, path);
    return r.length ? r[0] : undefined;
  }
  /** 支持 $.list[*].name 这种取全部 */
  function jsonPathAll(data, path) {
    return jsonQuery(data, path).filter(v => v != null);
  }

  /* ---------- 取值 ---------- */
  function extract(node, attr, base) {
    if (node == null) return '';
    if (typeof node === 'string') return node.trim();
    if (node.nodeType === 3) return node.textContent.trim();
    if (attr === 'html' || attr === 'content') return node.innerHTML || '';
    if (attr === 'href' || attr === 'src') {
      let v = node.getAttribute ? node.getAttribute(attr) : '';
      // text. 规则常命中包着 <a> 的容器，往下/往上一层找真正的链接
      if (!v && node.querySelector) {
        const inner = node.querySelector(attr === 'href' ? 'a[href]' : 'img[src]');
        if (inner) v = inner.getAttribute(attr);
      }
      if (!v && node.closest) {
        const up = node.closest(attr === 'href' ? 'a[href]' : 'img[src]');
        if (up) v = up.getAttribute(attr);
      }
      return absUrl(base, v || '');
    }
    if (attr === 'owntext') {
      return [...node.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join(' ').trim();
    }
    return (node.textContent || '').replace(/\u00a0/g, ' ').trim();
  }

  /* ---------- JS 书源支持（jsLib + java API） ----------
   * Legado 的高级书源会把协议写进 jsLib，规则只写一句 @js:xxx(java, source, ...)：
   *   - 规则本身要能调用 jsLib 里声明的函数（以前引擎只 eval 表达式，函数全 undefined）
   *   - 里面还会用 java.ajax / java.connect 发请求、用 AES + MD5 + SHA-256 解密
   *   - 有的直接 new Packages.java.io.ByteArrayOutputStream()，要提供最小 Java 垫片
   * 这些都在主线程同步执行：书源规则本来就是「取到数据马上算」的同步语义，
   * 改成异步会把 search/toc/content 整条链路都要重写。
   */
  const HEX = '0123456789abcdef';
  function toHex(bytes) {
    let s = '';
    for (let i = 0; i < bytes.length; i++) s += HEX[(bytes[i] >> 4) & 15] + HEX[bytes[i] & 15];
    return s;
  }
  function fromHex(s) {
    const t = String(s || '').replace(/[^0-9a-f]/gi, '');
    const out = new Uint8Array(t.length >> 1);
    for (let i = 0; i < out.length; i++) out[i] = parseInt(t.substr(i * 2, 2), 16);
    return out;
  }
  function utf8Bytes(str) {
    if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(String(str));
    const esc = unescape(encodeURIComponent(String(str)));
    const out = new Uint8Array(esc.length);
    for (let i = 0; i < esc.length; i++) out[i] = esc.charCodeAt(i);
    return out;
  }
  function utf8String(bytes) {
    if (typeof TextDecoder !== 'undefined') return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
    let s = '';
    for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    try { return decodeURIComponent(escape(s)); } catch (e) { return s; }
  }
  function bytesToStr(bytes, charset) {
    const cs = String(charset || 'utf-8').toUpperCase();
    if (cs === 'US-ASCII' || cs === 'ASCII' || cs === 'ISO-8859-1' || cs === 'LATIN1') {
      let s = '';
      for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i] & 255);
      return s;
    }
    return utf8String(bytes);
  }
  function strToBytes(str, charset) {
    const cs = String(charset || 'utf-8').toUpperCase();
    if (cs === 'US-ASCII' || cs === 'ASCII' || cs === 'ISO-8859-1' || cs === 'LATIN1') {
      const s = String(str);
      const out = new Uint8Array(s.length);
      for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 255;
      return out;
    }
    return utf8Bytes(str);
  }
  function b64Bytes(s) {
    const t = String(s || '').replace(/[\s\r\n]/g, '').replace(/-/g, '+').replace(/_/g, '/');
    if (typeof atob === 'function') {
      const bin = atob(t + '='.repeat((4 - t.length % 4) % 4));
      const out = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
      return out;
    }
    return new Uint8Array(Buffer.from(t, 'base64'));
  }
  function bytesB64(bytes) {
    let bin = '';
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    if (typeof btoa === 'function') return btoa(bin);
    return Buffer.from(bytes).toString('base64');
  }

  /* --- MD5（书源签名常用） --- */
  function md5Hex(input) {
    const bytes = typeof input === 'string' ? utf8Bytes(input) : input;
    const len = bytes.length;
    const nBlocks = ((len + 8) >> 6) + 1;
    const words = new Int32Array(nBlocks * 16);
    for (let i = 0; i < len; i++) words[i >> 2] |= bytes[i] << ((i % 4) * 8);
    words[len >> 2] |= 0x80 << ((len % 4) * 8);
    words[nBlocks * 16 - 2] = len * 8;
    const S = [7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
      5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
      4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
      6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21];
    const K = new Int32Array(64);
    for (let i = 0; i < 64; i++) K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296) | 0;
    let a0 = 0x67452301, b0 = 0xefcdab89 | 0, c0 = 0x98badcfe | 0, d0 = 0x10325476;
    const rotl = (x, c) => (x << c) | (x >>> (32 - c));
    for (let blk = 0; blk < nBlocks; blk++) {
      let A = a0, B = b0, C = c0, D = d0;
      for (let i = 0; i < 64; i++) {
        let F, g;
        if (i < 16) { F = (B & C) | (~B & D); g = i; }
        else if (i < 32) { F = (D & B) | (~D & C); g = (5 * i + 1) % 16; }
        else if (i < 48) { F = B ^ C ^ D; g = (3 * i + 5) % 16; }
        else { F = C ^ (B | ~D); g = (7 * i) % 16; }
        F = (F + A + K[i] + words[blk * 16 + g]) | 0;
        A = D; D = C; C = B;
        B = (B + rotl(F, S[i])) | 0;
      }
      a0 = (a0 + A) | 0; b0 = (b0 + B) | 0; c0 = (c0 + C) | 0; d0 = (d0 + D) | 0;
    }
    const out = new Uint8Array(16);
    [a0, b0, c0, d0].forEach((v, i) => {
      out[i * 4] = v & 255; out[i * 4 + 1] = (v >> 8) & 255;
      out[i * 4 + 2] = (v >> 16) & 255; out[i * 4 + 3] = (v >>> 24) & 255;
    });
    return toHex(out);
  }

  /* --- SHA-256（动态信封的密钥派生用） --- */
  const SHA_K = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
  ];
  function sha256Hex(input) {
    const bytes = typeof input === 'string' ? utf8Bytes(input) : input;
    const len = bytes.length;
    const nBlocks = ((len + 9 + 63) >> 6);
    const buf = new Uint8Array(nBlocks * 64);
    buf.set(bytes);
    buf[len] = 0x80;
    const bitLen = len * 8;
    buf[buf.length - 4] = (bitLen >>> 24) & 255;
    buf[buf.length - 3] = (bitLen >>> 16) & 255;
    buf[buf.length - 2] = (bitLen >>> 8) & 255;
    buf[buf.length - 1] = bitLen & 255;
    const H = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
    const w = new Int32Array(64);
    const rr = (x, n) => (x >>> n) | (x << (32 - n));
    for (let blk = 0; blk < nBlocks; blk++) {
      for (let i = 0; i < 16; i++) {
        const p = blk * 64 + i * 4;
        w[i] = (buf[p] << 24) | (buf[p + 1] << 16) | (buf[p + 2] << 8) | buf[p + 3];
      }
      for (let i = 16; i < 64; i++) {
        const s0 = rr(w[i - 15], 7) ^ rr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
        const s1 = rr(w[i - 2], 17) ^ rr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
        w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
      }
      let [a, b, c, d, e, f, g, h] = H;
      for (let i = 0; i < 64; i++) {
        const S1 = rr(e, 6) ^ rr(e, 11) ^ rr(e, 25);
        const ch = (e & f) ^ (~e & g);
        const t1 = (h + S1 + ch + SHA_K[i] + w[i]) | 0;
        const S0 = rr(a, 2) ^ rr(a, 13) ^ rr(a, 22);
        const maj = (a & b) ^ (a & c) ^ (b & c);
        const t2 = (S0 + maj) | 0;
        h = g; g = f; f = e; e = (d + t1) | 0;
        d = c; c = b; b = a; a = (t1 + t2) | 0;
      }
      H[0] = (H[0] + a) | 0; H[1] = (H[1] + b) | 0; H[2] = (H[2] + c) | 0; H[3] = (H[3] + d) | 0;
      H[4] = (H[4] + e) | 0; H[5] = (H[5] + f) | 0; H[6] = (H[6] + g) | 0; H[7] = (H[7] + h) | 0;
    }
    const out = new Uint8Array(32);
    H.forEach((v, i) => {
      out[i * 4] = (v >>> 24) & 255; out[i * 4 + 1] = (v >>> 16) & 255;
      out[i * 4 + 2] = (v >>> 8) & 255; out[i * 4 + 3] = v & 255;
    });
    return toHex(out);
  }

  /* --- AES（CBC + PKCS5/7），128/192/256 位密钥 --- */
  const SBOX = new Uint8Array(256), INV_SBOX = new Uint8Array(256);
  (function buildSbox() {
    const mul = (a, b) => {
      let r = 0;
      while (b) { if (b & 1) r ^= a; a = ((a << 1) ^ ((a & 0x80) ? 0x1b : 0)) & 255; b >>= 1; }
      return r & 255;
    };
    const inv = a => {           // GF(2^8) 乘法逆元：a^254
      if (!a) return 0;
      let r = 1, b = a, e = 254;
      while (e) { if (e & 1) r = mul(r, b); b = mul(b, b); e >>= 1; }
      return r;
    };
    const rotl8 = (v, n) => ((v << n) | (v >>> (8 - n))) & 255;
    for (let i = 0; i < 256; i++) {
      const b = inv(i);
      const s = (b ^ rotl8(b, 1) ^ rotl8(b, 2) ^ rotl8(b, 3) ^ rotl8(b, 4) ^ 0x63) & 255;
      SBOX[i] = s;
      INV_SBOX[s] = i;
    }
  })();
  const RCON = [0x00, 0x01, 0x02, 0x04, 0x08, 0x10, 0x20, 0x40, 0x80, 0x1b, 0x36, 0x6c, 0xd8];
  function xtime(a) { return ((a << 1) ^ ((a & 0x80) ? 0x1b : 0)) & 255; }
  function gmul(a, b) {
    let r = 0;
    while (b) { if (b & 1) r ^= a; a = xtime(a); b >>= 1; }
    return r & 255;
  }
  function expandKey(key) {
    const nk = key.length >> 2, nr = nk + 6;
    const w = [];
    for (let i = 0; i < nk; i++) w[i] = [key[i * 4], key[i * 4 + 1], key[i * 4 + 2], key[i * 4 + 3]];
    for (let i = nk; i < 4 * (nr + 1); i++) {
      let t = w[i - 1].slice();
      if (i % nk === 0) {
        t = [SBOX[t[1]] ^ RCON[i / nk], SBOX[t[2]], SBOX[t[3]], SBOX[t[0]]];
      } else if (nk > 6 && i % nk === 4) {
        t = t.map(v => SBOX[v]);
      }
      w[i] = w[i - nk].map((v, j) => (v ^ t[j]) & 255);
    }
    return { w, nr };
  }
  function addKey(state, w, r) {
    for (let c = 0; c < 4; c++) for (let rr = 0; rr < 4; rr++) state[c * 4 + rr] ^= w[r * 4 + c][rr];
  }
  function subBytes(s, box) { for (let i = 0; i < 16; i++) s[i] = box[s[i]]; }
  function shiftRows(s, inv) {
    const t = s.slice();
    for (let r = 0; r < 4; r++) {
      for (let c = 0; c < 4; c++) {
        const nc = inv ? (c - r + 4) % 4 : (c + r) % 4;
        s[c * 4 + r] = t[nc * 4 + r];
      }
    }
  }
  function mixColumns(s) {
    for (let c = 0; c < 4; c++) {
      const a0 = s[c * 4], a1 = s[c * 4 + 1], a2 = s[c * 4 + 2], a3 = s[c * 4 + 3];
      s[c * 4] = gmul(a0, 2) ^ gmul(a1, 3) ^ a2 ^ a3;
      s[c * 4 + 1] = a0 ^ gmul(a1, 2) ^ gmul(a2, 3) ^ a3;
      s[c * 4 + 2] = a0 ^ a1 ^ gmul(a2, 2) ^ gmul(a3, 3);
      s[c * 4 + 3] = gmul(a0, 3) ^ a1 ^ a2 ^ gmul(a3, 2);
    }
  }
  function invMixColumns(s) {
    for (let c = 0; c < 4; c++) {
      const a0 = s[c * 4], a1 = s[c * 4 + 1], a2 = s[c * 4 + 2], a3 = s[c * 4 + 3];
      s[c * 4] = gmul(a0, 14) ^ gmul(a1, 11) ^ gmul(a2, 13) ^ gmul(a3, 9);
      s[c * 4 + 1] = gmul(a0, 9) ^ gmul(a1, 14) ^ gmul(a2, 11) ^ gmul(a3, 13);
      s[c * 4 + 2] = gmul(a0, 13) ^ gmul(a1, 9) ^ gmul(a2, 14) ^ gmul(a3, 11);
      s[c * 4 + 3] = gmul(a0, 11) ^ gmul(a1, 13) ^ gmul(a2, 9) ^ gmul(a3, 14);
    }
  }
  function encBlock(s, w, nr) {
    addKey(s, w, 0);
    /* 最后一轮不做 MixColumns，否则和 InvCipher 对不上（往返会得到乱码） */
    for (let r = 1; r < nr; r++) {
      subBytes(s, SBOX); shiftRows(s, false); mixColumns(s); addKey(s, w, r);
    }
    subBytes(s, SBOX); shiftRows(s, false); addKey(s, w, nr);
  }
  function decBlock(s, w, nr) {
    addKey(s, w, nr);
    for (let r = nr - 1; r >= 1; r--) {
      shiftRows(s, true); subBytes(s, INV_SBOX); addKey(s, w, r); invMixColumns(s);
    }
    shiftRows(s, true); subBytes(s, INV_SBOX); addKey(s, w, 0);
  }
  function aesCbc(key, iv, data, encrypt) {
    const { w, nr } = expandKey(key);
    let input = Uint8Array.from(data);
    if (encrypt) {
      const pad = 16 - (input.length % 16);
      const padded = new Uint8Array(input.length + pad);
      padded.set(input); padded.fill(pad, input.length);
      input = padded;
    } else if (input.length % 16) {
      throw new Error('AES 密文长度必须是 16 的倍数');
    }
    const out = new Uint8Array(input.length);
    let prev = Uint8Array.from(iv).slice(0, 16);
    for (let off = 0; off < input.length; off += 16) {
      const block = Array.from(input.slice(off, off + 16));
      if (encrypt) {
        for (let i = 0; i < 16; i++) block[i] ^= prev[i];
        encBlock(block, w, nr);
        prev = Uint8Array.from(block);
      } else {
        const cipher = input.slice(off, off + 16);
        decBlock(block, w, nr);
        for (let i = 0; i < 16; i++) block[i] ^= prev[i];
        prev = cipher;
      }
      out.set(block, off);
    }
    if (!encrypt) {
      const pad = out[out.length - 1];
      if (pad >= 1 && pad <= 16) return out.slice(0, out.length - pad);
    }
    return out;
  }

  /* --- Java 垫片：jsLib 会直接 new 这两个类 --- */
  class ByteArrayOutputStream {
    constructor() { this.buf = []; }
    write(b) { if (typeof b === 'number') this.buf.push(b & 255); else if (b && b.length) for (const x of b) this.buf.push(x & 255); }
    toByteArray() { return Uint8Array.from(this.buf); }
    size() { return this.buf.length; }
    toString() { return bytesToStr(Uint8Array.from(this.buf)); }
  }
  class ArrayList {
    constructor() { this.items = []; }
    add(v) { this.items.push(v); return true; }
    get(i) { return this.items[i]; }
    size() { return this.items.length; }
    toArray() { return this.items.slice(); }
    isEmpty() { return this.items.length === 0; }
  }
  const Packages = {
    java: {
      io: { ByteArrayOutputStream },
      util: { ArrayList },
      lang: { String: { valueOf: v => String(v) } }
    }
  };

  /* --- 书源变量（jsLib 里 source.get / source.put，用来缓存域名、正则表） --- */
  const srcVarCache = new Map();
  function loadSrcVars() {
    if (srcVarCache.has('__all')) return srcVarCache.get('__all');
    let m = {};
    try {
      const raw = window.localStorage && window.localStorage.getItem('moread.srcvars');
      if (raw) m = JSON.parse(raw) || {};
    } catch (e) { m = {}; }
    srcVarCache.set('__all', m);
    return m;
  }
  let srcVarTimer = null;
  function sourceProxy(src) {
    if (!src) return { get: () => '', put: () => { }, url: '', name: '' };
    if (src.__proxy) return src.__proxy;
    const key = src.id || src.url || 'src';
    const all = loadSrcVars();
    const bag = all[key] || (all[key] = {});
    const proxy = {
      url: src.url || '', name: src.name || '', bookSourceUrl: src.url || '',
      get(k) { return bag[k] == null ? '' : bag[k]; },
      put(k, v) {
        bag[String(k)] = String(v);
        clearTimeout(srcVarTimer);
        srcVarTimer = setTimeout(() => {
          try { window.localStorage && window.localStorage.setItem('moread.srcvars', JSON.stringify(all)); } catch (e) { }
        }, 300);
      }
    };
    try { Object.defineProperty(src, '__proxy', { value: proxy, enumerable: false }); } catch (e) { }
    return proxy;
  }

  /* --- 同步 HTTP：网页走网关 /fetch（同源，不受 CORS 限制），安卓/Electron 走桥 --- */
  function syncHttp(url, opt) {
    const o = opt || {};
    if (typeof window.__moreadHttpSync === 'function') {
      const r = window.__moreadHttpSync(url, { method: o.method || 'GET', headers: o.headers || {}, body: o.body || null, timeout: o.timeout || 20000 });
      if (r && typeof r.text === 'string') return r;
      if (r && r.error) throw new Error(r.error);
    }
    if (typeof XMLHttpRequest === 'undefined') throw new Error('当前环境不支持同步请求');
    const xhr = new XMLHttpRequest();
    xhr.open(o.method || 'GET', url, false);
    for (const k in (o.headers || {})) {
      try { xhr.setRequestHeader(k, o.headers[k]); } catch (e) { }
    }
    try { xhr.send(o.body || null); } catch (e) { throw new Error('网络请求失败：' + (e.message || e)); }
    if (!xhr.status) throw new Error('网络不可达或请求被拦');
    return { status: xhr.status, text: xhr.responseText || '', headers: xhr.getAllResponseHeaders() || '', url };
  }
  function headerArg(h) {
    if (!h) return {};
    if (typeof h === 'string') {
      try { const j = JSON.parse(h); return j && typeof j === 'object' ? j : {}; } catch (e) { return {}; }
    }
    return h;
  }
  function respObj(r) {
    return {
      code: () => r.status,
      body: () => r.text,
      headers: () => r.headers,
      message: () => '',
      toString: () => r.text
    };
  }

  /* --- java 对象：按书源复用 --- */
  const javaCache = new WeakMap();
  function javaFor(src) {
    if (!src) return baseJava();
    if (javaCache.has(src)) return javaCache.get(src);
    const j = baseJava(src);
    javaCache.set(src, j);
    return j;
  }
  function baseJava(src) {
    return {
      ajax(url, headers) {
        const r = syncHttp(url, { headers: headerArg(headers) });
        if (r.status >= 400) return '';
        return r.text;
      },
      connect(url, headers, body) {
        const method = body == null ? 'GET' : 'POST';
        return respObj(syncHttp(url, { method, headers: headerArg(headers), body: typeof body === 'string' ? body : null }));
      },
      get(url, headers) { return respObj(syncHttp(url, { headers: headerArg(headers) })); },
      post(url, body, headers) {
        return respObj(syncHttp(url, { method: 'POST', headers: headerArg(headers), body: typeof body === 'string' ? body : null }));
      },
      md5Encode(s) { return md5Hex(String(s == null ? '' : s)); },
      digestHex(s, alg) {
        const a = String(alg || 'SHA-256').toUpperCase().replace('-', '');
        if (a === 'MD5') return md5Hex(String(s == null ? '' : s));
        return sha256Hex(String(s == null ? '' : s));
      },
      base64DecodeToByteArray(s) { return b64Bytes(s); },
      base64Decode(s) { return bytesToStr(b64Bytes(s)); },
      base64Encode(s) { return bytesB64(typeof s === 'string' ? utf8Bytes(s) : s); },
      hexDecodeToByteArray(s) { return fromHex(s); },
      hexEncodeToString(s) { return toHex(typeof s === 'string' ? utf8Bytes(s) : s); },
      strToBytes(s, cs) { return strToBytes(s, cs); },
      bytesToStr(b, cs) { return bytesToStr(b, cs); },
      createSymmetricCrypto(alg, key, iv) {
        const name = String(alg || 'AES/CBC/PKCS5Padding').toUpperCase();
        const k = Uint8Array.from(key), v = Uint8Array.from(iv || new Uint8Array(16));
        return {
          encrypt(data) { return aesCbc(k, v, Uint8Array.from(data), true); },
          decrypt(data) { return aesCbc(k, v, Uint8Array.from(data), false); }
        };
      },
      encodeURI(s) { return encodeURIComponent(String(s)); },
      log(s) { try { console.log('[书源]', s); } catch (e) { } },
      toast(s) { try { console.log('[书源]', s); } catch (e) { } },
      longToast(s) { try { console.log('[书源]', s); } catch (e) { } }
    };
  }

  /* --- jsLib 编译缓存：一个书源只编译一次 --- */
  const jsLibCache = new Map();
  function jsLibFactory(src) {
    const lib = String(src.jsLib || '');
    const key = (src.id || '') + ':' + lib.length + ':' + (lib.slice(0, 40)) + ':' + (lib.slice(-40));
    if (jsLibCache.has(key)) return jsLibCache.get(key);
    let factory = null;
    try {
      factory = new Function('java', 'source', 'scope', 'Packages',
        lib + '\n;return function(expr){ with(scope){ return eval(expr); } };');
    } catch (e) {
      try { console.warn('[书源] jsLib 编译失败：' + (e.message || e)); } catch (e2) { }
      factory = null;
    }
    jsLibCache.set(key, factory);
    return factory;
  }

  /* ---------- JS 求值 ---------- */
  function runJs(expr, vars) {
    const v = vars || {};
    const src = v.src || null;
    try {
      const scope = {
        encodeURIComponent, decodeURIComponent, encodeURI, JSON, Math, String, Number, Array, Object,
        Date, parseInt, parseFloat, isNaN, Packages, java: javaFor(src), source: sourceProxy(src),
        baseUrl: v.baseUrl || '', result: v.result == null ? (v.html || '') : v.result, html: v.html || '',
        key: v.key == null ? '' : v.key, title: v.title || '', book: v.book || null,
        cookie: '', cache: new Map()
      };
      /* 带 jsLib 的书源：先执行整段库代码，再在同一闭包里 eval 规则 */
      if (src && src.jsLib) {
        const factory = jsLibFactory(src);
        if (factory) return factory(scope.java, scope.source, scope, Packages)(expr);
      }
      const fn = new Function('java', 'source', 'scope', 'baseUrl', 'result', 'html', 'key',
        'with(scope){ return (' + expr + '); }');
      return fn(scope.java, scope.source, scope, scope.baseUrl, scope.result, scope.html, scope.key);
    } catch (e) {
      return undefined;
    }
  }

  /* 对象字段规则：JSON 书源的 name / author / title 这类简单键，
     以前只当 CSS 选择器处理，命不中就空 —— 现在直接读对象字段。 */
  function jsonField(obj, rule) {
    const k = String(rule || '').trim();
    if (!k || /[#@>:\s\[\]]/.test(k)) return undefined;
    if (obj && typeof obj === 'object' && Object.prototype.hasOwnProperty.call(obj, k)) return obj[k];
    if (/^[A-Za-z_$][\w$]*(\.[A-Za-z_$][\w$]*)+$/.test(k)) {
      let cur = obj;
      for (const part of k.split('.')) {
        if (cur == null || typeof cur !== 'object') return undefined;
        cur = cur[part];
      }
      return cur;
    }
    return undefined;
  }

  /* ---------- 主求值 ---------- */
  function evalRule(rule, ctx) {
    if (rule == null) return [];
    const raw = String(rule).trim();
    if (!raw) return [];

    /* JSON 书源：字段直读（放在最前面，优先于 CSS） */
    if (ctx && ctx.json && typeof ctx.json === 'object') {
      const f = jsonField(ctx.json, raw);
      if (f !== undefined && f !== null) {
        return Array.isArray(f) ? f.map(v => String(v)) : [String(f)];
      }
    }

    // 纯 JS 表达式
    if (/^\{\{[\s\S]*\}\}$/.test(raw) || /^@js:/i.test(raw)) {
      const expr = raw.replace(/^\{\{|\}\}$/g, '').replace(/^@js:/i, '');
      const out = runJs(expr, ctx || {});
      if (out == null) return [];
      if (Array.isArray(out)) return out.map(v => (v && typeof v === 'object' ? v : String(v)));
      if (typeof out === 'object') return [out];
      return [String(out)];
    }

    // 规则结果再做 @js 加工：@JSon:$.id@js:"chapter/"+result+"/content"
    const jsAt = raw.toLowerCase().indexOf('@js:');
    if (jsAt > 0) {
      const core = raw.slice(0, jsAt);
      const expr = raw.slice(jsAt + 4);
      const vals = evalRule(core, ctx);
      const out = runJs(expr, Object.assign({}, ctx, {
        baseUrl: ctx.baseUrl, html: ctx.html, result: vals.length ? vals[0] : ''
      }));
      if (out == null) return vals;
      return [String(out)];
    }

    // 后处理 ##正则##替换（## 里可能含 | 和 @，必须先剥离）
    const { core, post } = splitPost(raw);
    if (post) {
      const base = evalRule(core, ctx).map(v => applyPost(v, post));
      return post.matchOnly ? base.filter(v => v !== '') : base;
    }

    // 多备选
    if (core.includes('||')) {
      for (const alt of core.split('||')) {
        const r = evalRule(alt.trim(), ctx);
        if (r.length && String(r[0]).trim()) return r;
      }
      return [];
    }

    // 并列（Legado 的 && 表示同时取，常用来拼标题）
    if (core.includes('&&')) {
      const out = [];
      for (const part of core.split('&&')) {
        for (const v of evalRule(part.trim(), ctx)) out.push(v);
      }
      return out;
    }

    // JSON
    if (/^\$\.?/.test(core) || /^@json:/i.test(core)) {
      const p = core.replace(/^@json:/i, '');
      const arr = jsonPathAll(ctx.json, p);
      return arr.map(v => (typeof v === 'object' ? JSON.stringify(v) : String(v)));
    }

    const sp = splitRule(core);
    if (!sp) return [];
    const nodes = selectNodes(ctx.root || ctx.doc, core);
    if (!nodes.length) return [];
    if (nodes.length === 1 && !sp.attr) return [extract(nodes[0], 'text', ctx.baseUrl)];
    return nodes.map(n => extract(n, sp.attr || 'text', ctx.baseUrl)).filter(v => v !== '');
  }

  function first(rule, ctx) {
    const r = evalRule(rule, ctx);
    return r.length ? String(r[0]).trim() : '';
  }

  /* ---------- HTML → 段落 ---------- */
  function htmlToParas(html) {
    const d = document.createElement('div');
    d.innerHTML = String(html || '')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|h[1-6]|li|tr|blockquote|section)>/gi, '\n')
      .replace(/<(script|style)[\s\S]*?<\/\1>/gi, '');
    return (d.textContent || '')
      .replace(/\u00a0/g, ' ')
      .split(/\n+/)
      .map(s => s.trim())
      .filter(s => s.length > 0);
  }

  /* ---------- 漫画：图片抽取 ----------
   * 段落协议里用 `@img:<绝对地址>` 表示一张图，前端拿到后自己下载成 data URL
   * （很多漫画站校验 Referer，直接 <img src> 会被防盗链挡成白框）。
   * 只认“像正文插图”的图：跳过 1x1 统计图、data: 占位图、广告域名。 */
  const IMG_SKIP = /(?:^|\/)(?:spacer|blank|loading|lazy|pixel|1x1|logo|icon|avatar|qr|banner)[^/]*\.(?:gif|png|jpe?g|webp)$/i;
  const IMG_AD = /(?:ad|ads|adv|gg|guanggao|stat|analytics|beacon)[-_.\/]/i;

  function imgUrlOf(el, baseUrl) {
    if (!el || !el.getAttribute) return '';
    /* 懒加载的花样比站点还多：data-src / data-original / data-echo / srcset …
       以前只认前三个，一堆漫画站就只抽到 loading.gif（被当成占位图丢掉）→ 整章空白 */
    let raw = '';
    for (const k of ['data-src', 'data-original', 'data-lazy-src', 'data-echo',
      'data-url', 'data-original-src', 'data-lazy', 'data-pagespeed-lazy-src', 'srcset', 'src']) {
      const v = el.getAttribute(k);
      if (!v) continue;
      if (/srcset$/i.test(k)) {
        /* srcset="a.jpg 1x, b.jpg 2x"：取最后一个候选（通常是最大图） */
        const parts = String(v).split(',').map(s => s.trim()).filter(Boolean);
        const last = parts.length ? parts[parts.length - 1].split(/\s+/)[0] : '';
        if (last && !/^data:/i.test(last)) raw = last;
        continue;
      }
      if (/^data:/i.test(v) || /^blob:/i.test(v)) continue;
      /* 站点把真图放在后面的属性里、第一个给占位图 */
      if (/(loading|blank|spacer|pixel|lazy|grey|placeholder)/i.test(v) && k !== 'src') continue;
      raw = v;
      break;
    }
    if (!raw) return '';
    const w = +(el.getAttribute('width') || 0), h = +(el.getAttribute('height') || 0);
    if ((w && w < 40) || (h && h < 40)) return '';
    const u = absUrl(baseUrl, raw);
    if (!/^https?:/i.test(u)) return '';
    if (IMG_SKIP.test(u) || IMG_AD.test(u)) return '';
    return u;
  }

  /** 从一段 HTML 里按顺序抽图片地址（去重、保序） */
  function imgList(html, baseUrl) {
    const d = document.createElement('div');
    d.innerHTML = String(html || '').replace(/<(script|style)[\s\S]*?<\/\1>/gi, '');
    const out = [];
    const seen = new Set();
    for (const el of d.querySelectorAll('img')) {
      const u = imgUrlOf(el, baseUrl);
      if (!u || seen.has(u)) continue;
      seen.add(u);
      out.push(u);
      if (out.length >= 80) break;
    }
    return out;
  }

  /** 图文混杂的正文：文字段落和图片按文档顺序排好，供前端渲染 */
  function htmlToParasRich(html, baseUrl) {
    const src = String(html || '')
      .replace(/<(script|style)[\s\S]*?<\/\1>/gi, '')
      .replace(/<img\b[^>]*>/gi, m => {
        const el = document.createElement('div');
        el.innerHTML = m;
        const u = imgUrlOf(el.querySelector('img'), baseUrl);
        return u ? '\n@@IMG@@' + u + '@@IMG@@\n' : '';
      })
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|h[1-6]|li|tr|blockquote|section|figure)>/gi, '\n');
    const d = document.createElement('div');
    d.innerHTML = src;
    return (d.textContent || '')
      .replace(/\u00a0/g, ' ')
      .split(/\n+/)
      .map(s => s.trim())
      .flatMap(s => {
        if (!s) return [];
        /* 一行里可能夹着一张图：拆成「文字 / 图片」多条 */
        const parts = s.split(/@@IMG@@/);
        return parts.map(p => p.trim()).filter(Boolean).map(p =>
          /^https?:\/\//i.test(p) && /@@IMG@@/.test(s) ? '@img:' + p : p);
      })
      .filter(s => s.length > 0);
  }

  /* ---------- 书源归一化（Legado JSON → 内部结构） ---------- */
  function normalizeSource(raw) {
    const s = raw || {};
    const pick = o => (o && typeof o === 'object' ? o : {});
    const rs = pick(s.ruleSearch);
    const rbi = pick(s.ruleBookInfo);
    const rt = pick(s.ruleToc);
    const rc = pick(s.ruleContent);
    const id = 'S' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    return {
      id: s.id || id,
      name: s.bookSourceName || s.name || '未命名书源',
      url: (s.bookSourceUrl || s.url || '').replace(/\/+$/, ''),
      group: s.bookSourceGroup || s.group || '未分组',
      enabled: s.enabled !== false,
      charset: s.charset || 'auto',
      type: 'legado',
      /* 高级书源：协议全部写在 jsLib 里，规则只有一句 @js:xxx(java,...)。
         以前这两个字段在归一化时被丢掉，这类源就彻底哑火（规则函数 undefined）。 */
      jsLib: s.jsLib || '',
      header: s.header || '',
      searchUrl: s.searchUrl || '',
      ruleSearch: {
        bookList: rs.bookList || '',
        name: rs.name || '',
        author: rs.author || '',
        bookUrl: rs.bookUrl || '',
        intro: rs.intro || '',
        coverUrl: rs.coverUrl || '',
        kind: rs.kind || '',
        lastChapter: rs.lastChapter || ''
      },
      ruleBookInfo: {
        /* init：详情页先跑一段 JS（可发请求、解密），产出的 JSON/HTML 再喂给下面的字段规则 */
        init: rbi.init || '',
        tocUrl: rbi.tocUrl || '',
        name: rbi.name || '',
        author: rbi.author || '',
        intro: rbi.intro || '',
        coverUrl: rbi.coverUrl || ''
      },
      ruleToc: {
        chapterList: rt.chapterList || '',
        chapterName: rt.chapterName || '',
        chapterUrl: rt.chapterUrl || '',
        nextTocUrl: rt.nextTocUrl || ''
      },
      ruleContent: {
        content: rc.content || '',
        nextContentUrl: rc.nextContentUrl || ''
      },
      icon: (s.bookSourceName || s.name || '源').slice(0, 1),
      comment: s.bookSourceComment || '',
      /* Legado 备份里的 customOrder 是用户手动排的书源顺序。以前归一化时直接丢掉，
         恢复后书源页和换源列表的顺序就再也回不到备份里的样子。 */
      order: Number.isFinite(+s.customOrder) ? +s.customOrder
        : (Number.isFinite(+s.order) ? +s.order : 0),
      createdAt: Date.now()
    };
  }

  /* ---------- 网络 + 解析 ---------- */
  async function fetchDoc(fetchFn, url, src, extra) {
    const o = Object.assign({ url, charset: src.charset || 'auto', headers: src.headers }, extra || {});
    if (extra && extra.headers) o.headers = Object.assign({}, src.headers || {}, extra.headers);
    const r = await fetchFn(o);
    if (!r || !r.ok) throw new Error((r && r.error) || '请求失败');
    if (r.status >= 400) {
      // 说清楚是“站点没了”还是“被拦了”，比空白页有用
      const why = r.status === 404 || r.status === 410 ? '（地址已失效，书源可能改版或网站已关停）'
        : r.status === 403 || r.status === 401 ? '（站点拒绝访问，可能有反爬验证或需要登录）'
          : r.status === 429 ? '（请求太频繁被限流）'
            : '';
      throw new Error('HTTP ' + r.status + why);
    }
    return { html: r.text, url: r.url || url, status: r.status };
  }

  function fillUrl(tpl, key) {
    if (!tpl) return '';
    return tpl
      .replace(/\{\{\s*key\s*\}\}/g, encodeURIComponent(key))
      .replace(/\{key\}/g, encodeURIComponent(key));
  }

  /* ---------- 搜索结果清洗 ----------
   * 备份里两千多个书源，规则失效的占一大半：bookList 选不中节点时，旧代码把整页
   * 当成一本书 —— 书名取到站点名（「去看小说网」）、地址取到首页，加进书架就是
   * 一本章节乱七八糟的假书；有的书源规则能选中，但选中的是站内「推荐位」，
   * 搜《系统很抽象》却返回《云天行》这种完全无关的书。
   * 所以结果必须过三道关：书名清洗 → 结构兜底 → 关键词相关度过滤。 */

  const NAV_TEXT = /^(首页|登录|注册|退出|书架|我的书架|排行榜?|完本|全部|更多|上一页|下一页|尾页|末页|目录|章节目录|查看目录|全部章节|加入书签|推荐|下载|手机版|电脑版|返回|举报|投票|顶部|底部|网站地图|设为首页|收藏本站|搜索|提交|分类|玄幻|武侠|都市|历史|网游|科幻|言情|其他|修真|校园|穿越|仙侠|女生|男频|最近更新|全部分类|免费阅读|热门小说|最新小说)$/;
  const CHAPTER_ISH = /^(第\s*[0-9一二三四五六七八九十百千零两]+\s*[章节回卷话集]|正文\s*\d*|楔子|序章|尾声|番外)/;
  const SITE_ISH = /(小说网|书库|书院|文学网|中文网|阅读网|书屋|看书|小说吧|文学城)$/;

  /** 归一化：只留文字，用来比较书名与关键词 */
  function normKey(s) {
    return String(s || '')
      .replace(/\s+/g, '')
      .replace(/[·•・,，.。!！?？:：;；"'`“”‘’()（）\[\]【】<>《》_\-—~～|/\\]/g, '')
      .toLowerCase();
  }

  /** 书名 / 作者与关键词的相关度，0 表示根本不像同一本书 */
  function relScore(name, author, key) {
    const k = normKey(key);
    if (!k) return 1;
    const n = normKey(name);
    const a = normKey(author);
    if (n) {
      if (n === k) return 100;
      if (n.includes(k)) return 88;
      /* 关键词带了作者/后缀时，书名往往比关键词短 */
      if (n.length >= 3 && k.includes(n)) return 80;
      /* 书名把关键词每个字都覆盖到（中间夹了符号或少量错字） */
      if (k.length >= 4) {
        let hit = 0, pos = 0;
        for (const ch of k) {
          const i = n.indexOf(ch, pos);
          if (i >= 0) { hit++; pos = i + 1; }
        }
        if (hit / k.length >= 0.85) return 40;
      }
    }
    if (a && a.length >= 2 && (a === k || a.includes(k) || (k.length >= 2 && k.includes(a)))) return 60;
    return 0;
  }

  function cleanAuthor(a) {
    let s = String(a || '').replace(/^作\s*者[：:]?\s*/, '').replace(/[|｜].*$/, '').trim();
    s = s.replace(/^[\[【(（]+/, '').replace(/[\]】)）]+$/, '').trim();
    if (!s || s.length > 16) return '';
    if (/^(佚名|未知|不详|admin|作者|小编)$/i.test(s)) return '';
    return s;
  }

  /** 搜索列表里的原始标题 → { name, author, kind, status }
   *  "[网游]系统很抽象，还好我也是"、"1. 不要怂一起上[电竞]_夏为【完结】" 都要还原成干净书名 */
  /* 网页搜索结果的标题长得最野：「剑来(烽火戏诸侯)最新章节全本在线阅读-纵横中文网官方正版」
     「剑来最新章节列表_剑来全文免费阅读 (烽火戏诸侯)小说 ...」
     必须洗成「剑来 + 烽火戏诸侯」，否则网页搜书只能显示一整串站点标题。 */
  const TITLE_NOISE = /(?:最新章节列表|最新章节|最新章節|章节目录|章节列表|全文免费阅读|全本在线阅读|全文在线阅读|免费在线阅读|在线免费阅读|无弹窗广告|无弹窗|免费阅读|在线阅读|全文阅读|全文免费|免费全文|完整版|精校版|txt下载|小说全集|全集|首发|官方正版|正版|无广告|笔趣阁|顶点小说|看小说网)/g;
  const TITLE_SEP = /\s*(?:[_|｜]\s*|\s+[-–—]\s+|\s*[-–—]\s*)/;

  function parseBookTitle(raw) {
    let s = String(raw || '').replace(/\s+/g, ' ').trim();
    let author = '', kind = '', status = '';
    /* 有的标题结尾直接糊了省略号 */
    s = s.replace(/\s*(?:\.{2,}|…+)$/, '').trim();
    /* 长括号里是简介（「（烽火戏诸侯创作的网络仙侠小说）」），先整段丢掉 */
    s = s.replace(/[（(][^（）()]{9,}[)）]/g, ' ');
    /* 站点名永远在最后一个分隔符后面，先砍掉 */
    const segs = s.split(TITLE_SEP).filter(x => x && x.trim());
    if (segs.length > 1) s = segs[0];
    const km = /^[\[【(（]\s*([^\]】)）]{1,8})\s*[\]】)）]\s*/.exec(s);
    if (km) { kind = km[1].trim(); s = s.slice(km[0].length); }
    s = s.replace(/^\d{1,3}\s*[.、,)，)]\s*/, '');
    const am = /[_\-—|]\s*([^_\-—|\[\]【】]{1,12})\s*[\[【](完结|全本|连载|精校|校对)[\]】]\s*$/.exec(s);
    if (am) { author = am[1].trim(); status = am[2]; s = s.slice(0, am.index); }
    const sm = /[\[【](完结|全本|连载|精校|校对)[\]】]\s*$/.exec(s);
    if (sm) { status = sm[1]; s = s.slice(0, sm.index); }
    /* 作者常写成「书名(作者)」或「书名 作者：xxx」 */
    const pm = /[（(]\s*([^（）()]{1,8})\s*[)）]/.exec(s);
    if (pm && !/著|创作|小说|作品|完结|连载|全本/.test(pm[1])) {
      author = author || pm[1].trim();
      s = s.slice(0, pm.index) + ' ' + s.slice(pm.index + pm[0].length);
    }
    const au = /作\s*者[：:]\s*([^\s|，,。]{1,16})/.exec(s);
    if (au) { author = author || au[1]; s = s.slice(0, au.index); }
    s = s.replace(TITLE_NOISE, ' ');
    s = s.replace(/[《》「」『』]/g, ' ');
    s = s.replace(/[（(]\s*[)）]/g, ' ').replace(/[\s,，、;；:：]+$/, '');
    s = s.replace(/[\s,，、]*(?:小说|漫画|动画|原著)$/, '');
    s = s.replace(/^[《「『"'\s]+|[》」』"'\s]+$/g, '');
    s = s.replace(/\s+/g, ' ').trim().replace(/[\s_\-—|｜:：,，、]+$/, '');
    /* 「剑来-速读谷-烽火戏诸侯小说-…」：作者被塞在站点名后面，用「XX小说」认回来 */
    if (!author && segs.length > 2) {
      for (const g of segs.slice(1, 3)) {
        const m2 = /^([^\s]{2,8})小说$/.exec(g);
        if (m2 && !SITE_ISH.test(g)) { author = m2[1]; break; }
      }
    }
    return { name: s.trim(), author: cleanAuthor(author), kind, status };
  }

  /** 同一本书的章节页 / 详情页归到同一个 key（/106/106584/567274.html → /106/106584/） */
  function bookKeyOf(href, base) {
    try {
      const u = new URL(href, base);
      let p = u.pathname.replace(/\/index\.(?:html?|php|aspx?)$/i, '/');
      const seg = p.split('/').filter(Boolean);
      if (seg.length >= 2 && /^\d+\.(?:html?|php|aspx?)$/i.test(seg[seg.length - 1])
        && /^\d+$/.test(seg[seg.length - 2])) {
        seg.pop();
        p = '/' + seg.join('/') + '/';
      }
      return u.origin + p;
    } catch (e) { return String(href || ''); }
  }

  function guessSearchResults(root, baseUrl, key, src) {
    if (!root || !root.querySelectorAll) return [];
    const seen = new Map();
    let n = 0;
    for (const a of root.querySelectorAll('a[href]')) {
      if (++n > 4000) break;
      const href = a.getAttribute('href') || '';
      if (!href || /^(?:javascript:|mailto:|tel:|#)/i.test(href)) continue;
      const abs = absUrl(baseUrl, href);
      if (!/^https?:/i.test(abs)) continue;
      const text = (a.textContent || '').replace(/\s+/g, ' ').trim();
      const raw = text || (a.getAttribute('title') || '').replace(/\s+/g, ' ').trim();
      if (!raw || raw.length < 2 || raw.length > 48) continue;
      if (NAV_TEXT.test(raw) || CHAPTER_ISH.test(raw) || /^[\d\s.]+$/.test(raw)) continue;
      const pt = parseBookTitle(raw);
      if (!pt.name || pt.name.length < 2) continue;
      const rel = relScore(pt.name, '', key);
      /* 站点名（“去看小说网”“五六中文网”）不是书：只有跟关键词高度吻合时才留下 */
      if (!rel || (rel < 88 && SITE_ISH.test(pt.name) && pt.name.length <= 8)) continue;
      const bk = bookKeyOf(abs, baseUrl);
      let box = a.parentElement, hop = 0;
      while (box && hop < 4 && (box.textContent || '').length < 20) { box = box.parentElement; hop++; }
      if (!box) box = a.parentElement;
      const txt = box ? (box.textContent || '').replace(/\s+/g, ' ').slice(0, 600) : '';
      let author = pt.author;
      if (!author) {
        const am = txt.match(/作\s*者[：:]\s*([^\s|/<>【】]{1,20})/);
        if (am) author = cleanAuthor(am[1]);
      }
      if (!author) author = '佚名';
      let cover = '';
      const img = box && box.querySelector ? box.querySelector('img') : null;
      if (img) cover = imgUrlOf(img, baseUrl);
      let lastChapter = '';
      const lm = txt.match(/(?:最新章节|最新)[：:]?\s*(第?\s*[^\s|<>]{1,30})/);
      if (lm) lastChapter = lm[1].trim();
      const score = rel * 10 + (abs.length < 70 ? 5 : 0);
      const rec = {
        name: pt.name, author, bookUrl: abs, intro: '', coverUrl: cover,
        kind: pt.kind || (pt.status || ''), lastChapter,
        sourceId: src.id, sourceName: src.name, loose: false
      };
      const prev = seen.get(bk);
      if (!prev || score > prev.score) seen.set(bk, { rec, score });
    }
    /* 同一本书的不同地址（/book/12345.html 与 /book/12345/）再合并一次 */
    const byName = new Map();
    for (const v of seen.values()) {
      const k = normKey(v.rec.name) + '|' + normKey(v.rec.author);
      const prev = byName.get(k);
      if (!prev || v.score > prev.score) byName.set(k, v);
    }
    return [...byName.values()]
      .sort((a, b) => b.score - a.score)
      .slice(0, 40)
      .map(v => v.rec);
  }

  /** Legado 的 searchUrl 常把请求参数写在地址后面："/s?q={{key}},{&quot;method&quot;:&quot;POST&quot;}" */
  function splitUrlOptions(raw) {
    const s = String(raw || '');
    const i = s.search(/,\s*\{/);
    if (i < 0) return { tpl: s, opt: null };
    try { return { tpl: s.slice(0, i), opt: JSON.parse(s.slice(i + 1)) }; }
    catch (e) { return { tpl: s.slice(0, i), opt: null }; }
  }

  /** 替换搜索地址里的占位符：{{key}} / {key} / %s / {{page}} */
  function fillVars(tpl, key, page) {
    return String(tpl == null ? '' : tpl)
      .replace(/\{\{\s*key\s*\}\}/g, encodeURIComponent(key))
      .replace(/\{\s*key\s*\}/g, encodeURIComponent(key))
      .replace(/%s/g, encodeURIComponent(key))
      .replace(/\{\{\s*page\s*\}\}/gi, String(page || 1))
      .replace(/\{\s*page\s*\}/gi, String(page || 1));
  }

  async function search(fetchFn, src, key) {
    let raw = String(src.searchUrl || '');
    /* 搜索地址本身可能是 @js:：高级书源用 JS 拼带签名/加密参数的接口地址 */
    if (/^\{\{[\s\S]*\}\}$/.test(raw) || /^@js:/i.test(raw)) {
      const expr = raw.replace(/^\{\{|\}\}$/g, '').replace(/^@js:/i, '');
      const v = runJs(expr, { src, key, baseUrl: src.url || '' });
      raw = v == null ? '' : String(v);
    }
    if (!raw) throw new Error('书源没有配置搜索地址');

    /* 以前这里直接把 searchUrl 当成品地址用，{{key}} / {{page}} 一个都没替换：
       结果是拿「q={{key}}」去搜，站点返回 0 条，页面上只剩站点名和推荐位 ——
       「搜不到书 / 只进网站首页」的根子就在这。 */
    const { tpl, opt } = splitUrlOptions(raw);
    let url = fillVars(tpl, key, 1);
    if (!url) throw new Error('书源搜索地址为空');
    // 相对地址（/so.html?q={{key}}）按书源域名补全
    if (!/^https?:/i.test(url)) url = absUrl(src.url || '', url);
    /* 少数老书源用的是 search.php?keyword= 这种没有占位符的地址：没带关键词就补一个 */
    if (!/\{\{\s*key\s*\}\}|\{\s*key\s*\}|%s/i.test(tpl) && !/[?&](?:key|q|wd|kw|word|query|searchkey|keyword)=/i.test(tpl)) {
      url += (url.includes('?') ? '&' : '?') + 'key=' + encodeURIComponent(key);
    }
    const method = String((opt && opt.method) || 'GET').toUpperCase();
    const extra = { method };
    if (method === 'POST') {
      extra.body = fillVars((opt && opt.body) || '', key, 1);
      const h = Object.assign({}, opt && opt.headers);
      if (!Object.keys(h).some(k => /^content-type$/i.test(k))) {
        h['Content-Type'] = /^\s*\{/.test(extra.body)
          ? 'application/json;charset=UTF-8'
          : 'application/x-www-form-urlencoded';
      }
      extra.headers = h;
    }
    const { html, url: finalUrl } = await fetchDoc(fetchFn, url, src, extra);
    let json = null;
    try { json = JSON.parse(html); } catch (e) { json = null; }
    const root = json ? null : doc(html);
    const ctx = { doc: root, root, json: json || {}, html, baseUrl: finalUrl, src, key };

    const listRule = src.ruleSearch.bookList;
    let cards = [];
    /* loose：列表规则没选中任何节点，退化成「整页当一张卡片」。
       这种结果能凑出一堆链接，但未必真是书，检测/换源都要区别对待。 */
    let loose = false;
    if (listRule) {
      if (/^\{\{[\s\S]*\}\}$/.test(String(listRule)) || /^@js:/i.test(String(listRule))) {
        /* JS 列表规则：直接返回书籍对象数组（或 JSON 字符串） */
        const expr = String(listRule).replace(/^\{\{|\}\}$/g, '').replace(/^@js:/i, '');
        let v = runJs(expr, { src, key, baseUrl: finalUrl, html, result: html });
        if (typeof v === 'string') { try { v = JSON.parse(v); } catch (e) { v = null; } }
        if (Array.isArray(v)) cards = v.filter(x => x && typeof x === 'object');
      } else if (/^\$/.test(listRule) && json) {
        const arr = jsonPathAll(json, listRule) || [];
        cards = arr.filter(x => x && typeof x === 'object');
      } else {
        cards = selectNodes(root, listRule);
      }
    }
    if (!cards.length && root) {
      /* 列表规则没选中节点：以前退化成「整页当一本书」，书名/地址全是站点的。
         现在改为按页面结构猜（锚文本 + 链接归属合并），猜不出来就返回空。 */
      loose = true;
    }

    const out = [];
    const seenUrl = new Set();
    const pushRes = r => {
      if (!r || !r.name || !r.bookUrl || seenUrl.has(r.bookUrl)) return;
      seenUrl.add(r.bookUrl);
      out.push(r);
    };

    if (loose) {
      if (root) for (const r of guessSearchResults(root, finalUrl, key, src)) pushRes(r);
    } else {
      for (const c of cards.slice(0, 40)) {
        const cctx = typeof c === 'object' && c.nodeType
          ? { doc: root, root: c, html, baseUrl: finalUrl, json: json || {}, src }
          : { doc: root, root: root, html, baseUrl: finalUrl, json: c, src };
        const rawName = first(src.ruleSearch.name, cctx)
          || first('h3 a@text', cctx) || first('h2 a@text', cctx) || first('h4 a@text', cctx);
        if (!rawName || rawName.length > 60) continue;
        const pt = parseBookTitle(rawName);
        const name = pt.name;
        if (!name || name.length < 2) continue;
        if (NAV_TEXT.test(name)) continue;
        /* 站点名当书名（“去看小说网”“五六中文网”）是最典型的一类脏数据 */
        if (SITE_ISH.test(name) && name.length <= 8 && relScore(name, '', key) < 88) continue;
        const bookUrl = absUrl(finalUrl, first(src.ruleSearch.bookUrl, cctx) || first('a@href', cctx));
        if (!bookUrl) continue;
        /* 指向搜索页自身 / 站点首页的「结果」不是书 */
        if (bookUrl === finalUrl) continue;
        try {
          const bu = new URL(bookUrl), fu = new URL(finalUrl);
          if (bu.origin === fu.origin && bu.pathname === '/' && !/\/(book|info|read|txt)\//.test(bu.pathname)) continue;
        } catch (e) { }
        pushRes({
          name,
          author: cleanAuthor(first(src.ruleSearch.author, cctx)) || pt.author || '佚名',
          bookUrl,
          intro: first(src.ruleSearch.intro, cctx).slice(0, 120),
          coverUrl: first(src.ruleSearch.coverUrl, cctx),
          kind: first(src.ruleSearch.kind, cctx) || pt.kind || pt.status || '',
          lastChapter: first(src.ruleSearch.lastChapter, cctx),
          sourceId: src.id,
          sourceName: src.name,
          loose: false
        });
      }
    }

    /* 相关度过滤：规则能选中、但选中的是「推荐位」时，搜《系统很抽象》会返回《云天行》。
       书名和作者都跟关键词对不上的，一律不算这个源的搜索结果。 */
    const ranked = out
      .map(r => ({ r, rel: relScore(r.name, r.author, key) }))
      .filter(x => x.rel > 0)
      .sort((a, b) => b.rel - a.rel);
    if (ranked.length) {
      for (const x of ranked) x.r.rel = x.rel;
      return ranked.map(x => x.r);
    }
    /* 规则给出的全是无关书：再按页面结构猜一次，仍不相关就当这个源没结果 */
    if (!loose && root) {
      return guessSearchResults(root, finalUrl, key, src)
        .filter(r => relScore(r.name, r.author, key) > 0);
    }
    return [];
  }

  const TOC_SELECTORS = [
    '#list dd a', '#list li a', '.listmain dd a', '.listmain li a',
    '#chapterlist a', '#chapterlist li a', '#chapterlist dd a',
    '.chapter-list a', '.chapterlist a', 'ul.chapter li a',
    '.section-list li a', '#chapters a', 'dl dd a'
  ];

  function cleanTitle(t) {
    return String(t || '').replace(/\s+/g, ' ').trim().slice(0, 80);
  }

  function pickChapters(root, baseUrl, src, json, html) {
    const rows = [];
    const listRule = String(src.ruleToc.chapterList || '');
    /* JS 目录规则：函数自己发请求、解密，直接返回章节数组（或 JSON 字符串） */
    if (/^\{\{[\s\S]*\}\}$/.test(listRule) || /^@js:/i.test(listRule)) {
      const expr = listRule.replace(/^\{\{|\}\}$/g, '').replace(/^@js:/i, '');
      let v = runJs(expr, { src, baseUrl, html: html || '', result: html || '' });
      if (typeof v === 'string') { try { v = JSON.parse(v); } catch (e) { v = null; } }
      if (Array.isArray(v)) {
        for (const it of v) {
          if (it == null) continue;
          const obj = typeof it === 'object' ? it : { title: String(it), url: '' };
          const cctx = { doc: root, root, html: '', baseUrl, json: obj, src };
          const title = first(src.ruleToc.chapterName, cctx) || String(obj.title || obj.name || '');
          const href = first(src.ruleToc.chapterUrl, cctx) || String(obj.url || obj.href || '');
          if (!title || !href) continue;
          rows.push({ title: cleanTitle(title), url: absUrl(baseUrl, href) });
        }
        return rows;
      }
    }
    // JSON 目录：@JSon:$.data.volumes..chapters[*] 这类接口型书源
    if (json && /^(\$|@json:)/i.test(listRule)) {
      const items = jsonPathAll(json, listRule.replace(/^@json:/i, ''));
      for (const it of items) {
        const cctx = { doc: root, root, html: '', baseUrl, json: it, src };
        const title = first(src.ruleToc.chapterName, cctx);
        const href = first(src.ruleToc.chapterUrl, cctx);
        if (!title || !href) continue;
        rows.push({ title: cleanTitle(title), url: absUrl(baseUrl, href) });
      }
      return rows;
    }
    for (const li of selectNodes(root, src.ruleToc.chapterList)) {
      const cctx = { doc: root, root: li, html: '', baseUrl, json: {}, src };
      const title = first(src.ruleToc.chapterName, cctx) || extract(li, 'text', baseUrl);
      const anchor = (li.querySelector && li.querySelector('a')) || li;
      const href = first(src.ruleToc.chapterUrl, cctx) || extract(anchor, 'href', baseUrl);
      if (!title || !href) continue;
      rows.push({ title: cleanTitle(title), url: absUrl(baseUrl, href) });
    }
    return rows;
  }

  /** 抓 json（目录接口返回 JSON 时用） */
  function parseMaybeJson(html) {
    const s = String(html || '').trim();
    if (!s || (s[0] !== '{' && s[0] !== '[')) return null;
    try { return JSON.parse(s); } catch (e) { return null; }
  }

  /** 分页目录：ruleToc.nextTocUrl，最多翻 20 页 */
  /** 目录页自己的「下一页」按钮（分页目录：/book/1/ 、/book/1_2/ …） */
  function autoNextTocUrl(root, baseUrl) {
    if (!root || !root.querySelectorAll) return '';
    for (const a of root.querySelectorAll('a[href]')) {
      const t = (a.textContent || '').replace(/[\s\u3000>»→]+/g, '');
      if (!/^(下一页|下页|下一頁|后一页|下一章目录|next|下页目录)$/i.test(t)) continue;
      const u = absUrl(baseUrl, a.getAttribute('href') || '');
      if (u && /^https?:/i.test(u)) return u;
    }
    return '';
  }

  async function followTocPages(fetchFn, src, firstPage, rows) {
    const rule = src.ruleToc.nextTocUrl;
    if (!rows.length) return rows;
    let cur = firstPage;
    const seen = new Set([cur.url]);
    const seenChap = new Set(rows.map(r => r.url));
    for (let p = 0; p < 20; p++) {
      const cctx = { doc: cur.root, root: cur.root, html: cur.html || '', baseUrl: cur.url, json: cur.json || {}, src };
      let next = rule ? first(rule, cctx) : '';
      if (!next && rule) {
        const ns = selectNodes(cur.root, rule);
        if (ns.length) next = extract(ns[0], 'href', cur.url) || extract(ns[0], 'value', cur.url);
      }
      /* 规则没写 / 写错时，退到页面上真实的「下一页」按钮：
         手机小说这类站的目录是 /book/1/、/book/1_2/… 分页的，
         不跟的话一本 1032 章的书只能看到第 1 页的 85 章。 */
      if (!next) next = autoNextTocUrl(cur.root, cur.url);
      if (!next) break;
      const nu = absUrl(cur.url, next);
      if (!nu || seen.has(nu)) break;
      seen.add(nu);
      try {
        const t = await fetchDoc(fetchFn, nu, src);
        const r2 = doc(t.html);
        const json2 = parseMaybeJson(t.html);
        let more = pickChapters(r2, t.url, src, json2, t.html);
        /* 规则失效时用通用容器兜底，否则翻页翻了个寂寞 */
        if (more.length < 3) {
          for (const sel of TOC_SELECTORS) {
            const rows2 = simpleChapters(r2, t.url, sel);
            if (rows2.length > more.length) more = rows2;
          }
        }
        const fresh = more.filter(c => c.url && !seenChap.has(c.url));
        if (!fresh.length) break;
        fresh.forEach(c => seenChap.add(c.url));
        rows.push(...fresh);
        cur = { root: r2, url: t.url, html: t.html, json: json2 };
      } catch (e) { break; }
    }
    return rows;
  }

  function simpleChapters(root, baseUrl, sel) {
    let ns = [];
    try { ns = [...root.querySelectorAll(sel)]; } catch (e) { return []; }
    return ns.map(a => ({
      title: (a.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 80),
      url: absUrl(baseUrl, a.getAttribute('href') || '')
    })).filter(c => c.title && c.url && c.title.length <= 60);
  }

  function dedupeChapters(rows) {
    const seen = new Set();
    return rows.filter(c => (seen.has(c.url) ? false : (seen.add(c.url), true)));
  }

  /** 中文数字 → 阿拉伯数字（第一百零五章 / 十二 / 两） */
  function cnNum(s) {
    const d = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
    const u = { 十: 10, 百: 100, 千: 1000 };
    let total = 0, cur = 0;
    for (const ch of String(s || '')) {
      if (d[ch] != null) cur = d[ch];
      else if (u[ch]) { total += (cur || 1) * u[ch]; cur = 0; }
      else if (ch === '万') { total = (total + cur) * 10000; cur = 0; }
      else return NaN;
    }
    return total + cur;
  }

  /** 标题里的章节号：第660章 / 第百零五章 / 066 / 12. …，没有就 NaN */
  function chapNo(t) {
    const s = String(t || '').replace(/[\u3000\s]/g, '');
    let m = /第([0-9]{1,5})[章节回话集篇部幕卷]/.exec(s);
    if (m) return +m[1];
    m = /^([0-9]{1,4})[.、,．:：]/.exec(s);
    if (m) return +m[1];
    m = /第([零〇一二两三四五六七八九十百千万]{1,9})[章节回话集篇部幕卷]/.exec(s);
    if (m) return cnNum(m[1]);
    return NaN;
  }

  /* 番外 / 完本感言 / 请假条这类「不参与排序」的尾巴，永远排在正文之后 */
  const TOC_TAIL = /^(番外|外传|后记|序章之后|完本感言|完本|完结|大结局|终章|尾声|请假|说明|公告|单章|月票|上架|致谢|附录|作者的话|关于)/;

  /**
   * 目录归位：这一步是「显示第59章、点进去是第660章」的根因修复。
   * 不少站点（飞速、顶点系的皮）把「最新章节 12 条（倒序）」直接贴在完整目录前面，
   * 于是 chapters[0] 是第666章、chapters[12] 才是第1章 —— 索引全错位。
   * 规则：
   *   - 按 url / 标题去重（同一章在倒序块和正文块里各出现一次）
   *   - 有序号的按序号稳定排序；没序号的（「第一卷 风起」）跟着它前面那章走；
   *     番外/感言这类尾巴集中放到最后
   *   - 序号不可靠（大半章没有「第N章」）时保持站点原序，绝不乱动
   */
  function normalizeToc(rows) {
    let list = rows.slice();
    const seenU = new Set(), seenT = new Set();
    list = list.filter(c => {
      const u = String(c.url || '');
      const t = String(c.title || '').replace(/[\u3000\s]/g, '');
      if (u && seenU.has(u)) return false;
      if (t && seenT.has(t)) return false;
      if (u) seenU.add(u);
      if (t) seenT.add(t);
      return true;
    });
    if (list.length < 5) return list;

    const nums = list.map(c => chapNo(c.title));
    const known = nums.filter(n => isFinite(n)).length;
    if (known < Math.max(4, list.length * 0.4)) return list;

    /* 已经升序的不动：站点顺序有时比数字更准（插章、分卷） */
    let bad = 0;
    for (let i = 1; i < nums.length; i++) {
      if (isFinite(nums[i]) && isFinite(nums[i - 1]) && nums[i] < nums[i - 1]) bad++;
    }
    if (!bad) return list;

    const keyed = list.map((c, i) => ({ c, i, n: nums[i] }));
    let prev = -1;
    for (const it of keyed) {
      if (isFinite(it.n)) { prev = it.n; it.k = it.n; }
      else if (TOC_TAIL.test(String(it.c.title || '').trim())) it.k = Number.MAX_SAFE_INTEGER;
      /* 没序号的正文行（卷名/插页）挂在它前面那章后面 */
      else it.k = prev < 0 ? -1 : prev + 0.001 * (it.i % 997);
    }
    keyed.sort((a, b) => (a.k - b.k) || (a.i - b.i));
    return keyed.map(x => x.c);
  }

  /** 兜底抓到的目录常常是“最新章节”倒序，按标题数字判断后纠正 */
  function fixOrder(rows) {
    if (rows.length < 8) return rows;
    const num = t => {
      const m = String(t).match(/(\d{1,5})/);
      return m ? +m[1] : NaN;
    };
    const a = num(rows[0].title), b = num(rows[rows.length - 1].title);
    if (isFinite(a) && isFinite(b) && a > b) return rows.slice().reverse();
    return rows;
  }

  /** 详情页上没有章节时，找一个“目录 / 全部章节”的入口 */
  function findTocLink(root, baseUrl) {
    const list = [...root.querySelectorAll('a[href]')].map(a => ({
      t: (a.textContent || '').replace(/\s+/g, '').trim(),
      u: absUrl(baseUrl, a.getAttribute('href') || '')
    })).filter(x => x.u && /^https?:/.test(x.u));
    const hit = list.find(x => /^(目录|章节目录|查看目录|全部章节|完整目录|章节列表|查看全部章节|展开全部|点击查看目录)$/.test(x.t))
      || list.find(x => /目录|章节列表/.test(x.t) && x.t.length <= 8);
    return hit ? hit.u : '';
  }

  /** 跟「目录 / 全部章节」链接抓一次完整目录（步骤 3 与「章节太少」兜底共用） */
  async function tocFromLink(fetchFn, src, root, url) {
    const link = findTocLink(root, url);
    if (!link) return null;
    try {
      const t = await fetchDoc(fetchFn, link, src);
      const r2 = doc(t.html);
      let c = dedupeChapters(pickChapters(r2, t.url, src, null, t.html));
      let loose = false;
      if (c.length < 3) {
        for (const sel of TOC_SELECTORS) {
          const rows = simpleChapters(r2, t.url, sel);
          if (rows.length > c.length) { c = dedupeChapters(rows); loose = true; }
        }
      }
      if (c.length < 3) return null;
      return { chapters: loose ? fixOrder(c) : c, url: t.url, fallback: loose };
    } catch (e) { return null; }
  }

  /** 目录页地址猜法：只在上面的路都失败时才用（很多站的详情页/下载页都带 /index.html 目录） */
  function guessTocUrls(url) {
    const out = [];
    try {
      const u = new URL(url);
      const p = u.pathname;
      if (/\.(html?|php|aspx?)$/i.test(p)) {
        const dir = p.replace(/\/[^/]*$/, '');
        out.push(u.origin + dir + '/');
        out.push(u.origin + dir + '/index.html');
      } else if (!/\/$/.test(p)) {
        out.push(u.origin + p + '/');
        out.push(u.origin + p + '/index.html');
      }
    } catch (e) { /* 地址不合法就算了 */ }
    return out.filter((x, i, a) => a.indexOf(x) === i && x !== url);
  }

  /**
   * @param opts.tocUrl 备份里记的目录页（原「阅读」的 book.tocUrl）——最可信的入口
   * @param opts.expect 备份里记的总章数：抓回来明显少一半，说明抓的是「最新章节」
   * @param opts.reverse 原书的 readConfig.reverseToc
   */
  async function getToc(fetchFn, src, bookUrl, opts = {}) {
    const expect = Number(opts.expect) || 0;
    const got = await fetchDoc(fetchFn, bookUrl, src);
    let html = got.html, url = got.url;
    /* 详情页 init：有些源把详情接口加密了，要先跑一段 JS 拿到明文再取字段 */
    if (src.ruleBookInfo && src.ruleBookInfo.init) {
      const expr = String(src.ruleBookInfo.init).replace(/^\{\{|\}\}$/g, '').replace(/^@js:/i, '');
      const v = runJs(expr, { src, baseUrl: url, html, result: html });
      if (typeof v === 'string' && v.trim()) html = v;
      else if (v && typeof v === 'object') html = JSON.stringify(v);
    }
    const root = doc(html);
    const json0 = parseMaybeJson(html);
    const base = { doc: root, root, html, baseUrl: url, json: json0 || {}, src };

    const info = {
      name: first(src.ruleBookInfo.name, base) || '',
      author: first(src.ruleBookInfo.author, base) || '',
      intro: first(src.ruleBookInfo.intro, base),
      coverUrl: first(src.ruleBookInfo.coverUrl, base)
    };

    const collect = async (r2, pageUrl, pageHtml) => {
      const pj = parseMaybeJson(pageHtml);
      let c = dedupeChapters(pickChapters(r2, pageUrl, src, pj, pageHtml));
      c = dedupeChapters(await followTocPages(fetchFn, src, { root: r2, url: pageUrl, html: pageHtml, json: pj }, c));
      return c;
    };

    /* 每次拿到一份目录都跟已有最好的比一比，最后取最全的那份 */
    let best = null;
    const take = (c, u, fallback) => {
      const n = normalizeToc(c || []);
      if (n.length < 3) return n;
      if (!best || n.length > best.chapters.length) best = { chapters: n, tocUrl: u, fallback: !!fallback };
      return n;
    };
    const enough = () => best && (!expect || best.chapters.length >= expect * 0.8);

    /* 0) 备份里的目录页：原版「阅读」把 tocUrl 单独存了，
          飞速这种站的书架地址是 /txtdown/xxx.html（下载页），
          那页上只有 12 条「最新章节」——直接解析就是章节全错位。 */
    if (opts.tocUrl && opts.tocUrl !== bookUrl) {
      try {
        const t = await fetchDoc(fetchFn, opts.tocUrl, src);
        take(await collect(doc(t.html), t.url, t.html), t.url, false);
      } catch (e) { /* 旧地址失效就继续走规则 */ }
    }

    // 1) 规则里给了独立目录页
    if (!enough()) {
      const tocUrl = first(src.ruleBookInfo.tocUrl, base);
      if (tocUrl) {
        const tu = absUrl(url, tocUrl);
        if (tu && tu !== url && tu !== opts.tocUrl) {
          try {
            const t = await fetchDoc(fetchFn, tu, src);
            take(await collect(doc(t.html), t.url, t.html), t.url, false);
          } catch (e) { /* 继续往下兜底 */ }
        }
      }
    }

    // 2) 当前页直接解析
    if (!enough()) {
      const chapters = await collect(root, url, html);
      take(chapters, url, false);
      /* 详情页常只挂「最新章节」十来条，完整目录在另一个页面。
         章节数明显偏少（或远少于备份记的总数）时再跟一次「目录 / 全部章节」。 */
      if (best && (best.chapters.length < 40 || (expect && best.chapters.length < expect * 0.8))) {
        const full = await tocFromLink(fetchFn, src, root, url);
        if (full) take(full.chapters, full.url, full.fallback);
      }
    }

    // 3) 猜目录页地址（/book/1/ 这类）
    if (!enough() && expect) {
      for (const g of guessTocUrls(url)) {
        try {
          const t = await fetchDoc(fetchFn, g, src);
          const r2 = doc(t.html);
          take(await collect(r2, t.url, t.html), t.url, false);
          if (enough()) break;
        } catch (e) { /* 下一个 */ }
      }
    }

    // 4) 全都不行：按常见容器兜底（站点改版导致规则失效时）
    if (!best) {
      let loose = false, chapters = [];
      for (const sel of TOC_SELECTORS) {
        const rows = simpleChapters(root, url, sel);
        if (rows.length > chapters.length) { chapters = rows; loose = true; }
      }
      if (chapters.length) take(chapters, url, loose);
    }

    if (best) {
      let ch = best.chapters;
      /* 原书开了「目录倒序」时跟着它走，否则用户看到的顺序和原版相反 */
      if (opts.reverse) ch = ch.slice().reverse();
      return { chapters: ch, info, tocUrl: best.tocUrl, fallback: best.fallback };
    }
    return { chapters: [], info, tocUrl: url, fallback: false };
  }

  const CONTENT_SELECTORS = [
    '#content', '#chaptercontent', '#booktext', '#htmlContent', '.content', '.read-content',
    '.showtxt', '#article', 'article', '.txtnav', '#txtContent', '.read-content', '#booktxt',
    '.text', '.chapter-content', '#chapter-content'
  ];

  const JUNK_LINE = /^(上一章|下一章|上一页|下一页|第?\s*[（(]?\d+\s*\/\s*\d+[)）]?\s*页|目录|章节目录|返回列表|返回目录|加入书签|加入书架|投推荐票|投月票|章节报错|手机阅读|手机版|电脑版|举报|最新网址|请记住本站|本站域名|笔趣阁|www\.|https?:\/\/)/i;

  /** 去掉广告/导航行，只留正文段落 */
  function cleanParas(paras) {
    return (paras || [])
      .map(s => String(s).replace(/\u00a0/g, ' ').trim())
      .filter(s => s.length > 1 && !JUNK_LINE.test(s))
      .filter(s => !/(本章未完|请点击下一页继续|请收藏本站|一秒记住|更新最快)/.test(s))
      /* 站点在正文容器顶部塞的「随机推荐：书名 书名 …」，整行都是别的书 */
      .filter(s => !/^(随机推荐|推荐阅读|猜你喜欢|相关推荐|热门推荐|本站推荐|更多推荐|精彩推荐|大家都在看)[：:]/.test(s))
      .filter(s => (s.match(/《/g) || []).length < 3);
  }

  /** 正文质量分：只累计“像正文”的段落（长句多、短行少） */
  function contentScore(paras) {
    if (!paras || !paras.length) return 0;
    let score = 0;
    for (const p of paras) {
      if (p.length >= 30) score += p.length;
      else if (p.length >= 12) score += p.length * 0.6;
      else if (p.length >= 6) score += p.length * 0.2;
    }
    return score;
  }

  function longestParas(nodes) {
    let best = null;
    for (const n of nodes) if (!best || (n.textContent || '').length > (best.textContent || '').length) best = n;
    return best ? htmlToParas(best.innerHTML || best.textContent || '') : [];
  }

  /** 从一页 HTML 里抽正文（规则 → 常见容器 → 最长块，取质量最高的一份） */
  function extractParas(root, url, src) {
    const base = { doc: root, root, html: '', baseUrl: url, json: {}, src };
    const rule = src.ruleContent.content;

    // 收集多路候选，取“正文质量”最高的一份（站点改版/规则失配时不至于抓到导航块）
    const cands = [];
    if (rule) {
      const nodes = selectNodes(root, rule);
      if (nodes.length) cands.push({ p: cleanParas(longestParas(nodes)), bias: 1.2, from: 'rule' });
      else {
        const v = first(rule, base);
        if (v) cands.push({ p: cleanParas(htmlToParas(v)), bias: 1.2, from: 'rule-text' });
      }
    }
    for (const sel of CONTENT_SELECTORS) {
      let ns = [];
      try { ns = [...root.querySelectorAll(sel)]; } catch (e) { ns = []; }
      if (!ns.length) continue;
      cands.push({ p: cleanParas(longestParas(ns)), bias: 1, from: sel });
    }
    // 通用兜底：整页里段落最厚的那块
    {
      const blocks = [...root.querySelectorAll('div,article,section,td')];
      let best = null, len = 0;
      for (const c of blocks) {
        const t = (c.textContent || '').length;
        if (t > len && c.querySelectorAll('p,br').length > 2) { len = t; best = c; }
      }
      if (best) cands.push({ p: cleanParas(htmlToParas(best.innerHTML)), bias: 0.9, from: 'longest-block' });
    }

    let best = null, bestScore = 0;
    for (const c of cands) {
      const sc = contentScore(c.p) * c.bias;
      if (sc > bestScore) { bestScore = sc; best = c; }
    }
    return { paras: best ? best.p : [], from: best && best.from };
  }

  /** 一章拆成 (1/3)(2/3)(3/3) 的站：按「下一页」规则或页标自己翻 */
  function nextPageGuess(root, url) {
    const t = ((root.body && root.body.textContent) || '').replace(/\s+/g, '');
    const pm = /第?[（(]?(\d+)\s*\/\s*(\d+)[)）]?页/.exec(t);
    if (!pm) return '';
    const cur = +pm[1], total = +pm[2];
    if (!cur || total <= cur || total > 8) return '';
    if (/_\d+\.html?$/i.test(url)) return url.replace(/_(\d+)(\.html?)$/i, (m, n, ext) => '_' + (cur + 1) + ext);
    return url.replace(/(\.html?)(\?.*)?$/i, (m, ext, q) => '_' + (cur + 1) + ext + (q || ''));
  }

  function chapterKey(d) {
    const m = String((d && d.title) || '').match(/第\s*[0-9零一二三四五六七八九十百千两]+\s*[章节回]/);
    return m ? m[0].replace(/\s+/g, '') : '';
  }

  /** 正文分页合并：不翻页的话，一章只读到三分之一 */
  async function followContentPages(fetchFn, src, root, url, baseParas) {
    const rule = src.ruleContent.nextContentUrl;
    let paras = baseParas.slice();
    let curRoot = root, curUrl = url;
    const seen = new Set([contentScore(paras)]);
    for (let i = 0; i < 6; i++) {
      let next = '';
      if (rule) next = first(rule, { doc: curRoot, root: curRoot, html: '', baseUrl: curUrl, json: {}, src });
      if (!next) next = nextPageGuess(curRoot, curUrl);
      if (!next) break;
      const nu = absUrl(curUrl, next);
      if (!nu || nu === curUrl) break;
      let page;
      try { page = await fetchDoc(fetchFn, nu, src); } catch (e) { break; }
      const r2 = doc(page.html);
      /* 有的书源把 nextContentUrl 指到「下一章」：章节号变了就别拼，否则一章里混进下一章 */
      const k1 = chapterKey(curRoot), k2 = chapterKey(r2);
      if (k1 && k2 && k1 !== k2) break;
      const got = extractParas(r2, page.url || nu, src);
      if (!got.paras.length) break;
      /* 有的站「下一页」翻出去还是同一页（或者直接翻到下一章），用质量指纹挡一下 */
      const fp = contentScore(got.paras);
      if (seen.has(fp)) break;
      seen.add(fp);
      paras = paras.concat(got.paras);
      curRoot = r2; curUrl = page.url || nu;
    }
    return paras;
  }

  /**
   * 漫画章分页：不少站一话拆成 (1/2)(2/3) 甚至「下一页」按钮，
   * 只抓第一页就只有前几张图。这里按 nextContentUrl / 页码 把后面几页的图接上，
   * 用「图片地址是否新增」判定是否真的翻到了新内容，翻到下一话就停。
   */
  async function followComicPages(fetchFn, src, root, url, baseRich) {
    const rule = src.ruleContent && src.ruleContent.nextContentUrl;
    let rich = baseRich.slice();
    const seen = new Set(rich.filter(p => p.indexOf('@img:') === 0));
    let curRoot = root, curUrl = url;
    for (let i = 0; i < 6; i++) {
      let next = '';
      if (rule) next = first(rule, { doc: curRoot, root: curRoot, html: '', baseUrl: curUrl, json: {}, src });
      if (!next) next = nextPageGuess(curRoot, curUrl);
      if (!next) break;
      const nu = absUrl(curUrl, next);
      if (!nu || nu === curUrl) break;
      let page;
      try { page = await fetchDoc(fetchFn, nu, src); } catch (e) { break; }
      const r2 = doc(page.html);
      /* 翻出去是下一章就别接（否则一章里混进下一话的图） */
      const k1 = chapterKey(curRoot), k2 = chapterKey(r2);
      if (k1 && k2 && k1 !== k2) break;
      const node = comicBestNode(r2, src.ruleContent.content) || r2.body;
      if (!node) break;
      const add = htmlToParasRich(node.innerHTML || '', page.url || nu);
      const fresh = add.filter(p => p.indexOf('@img:') === 0 && !seen.has(p));
      if (!fresh.length) break;
      fresh.forEach(p => seen.add(p));
      rich = rich.concat(add);
      curRoot = r2; curUrl = page.url || nu;
    }
    return rich;
  }

  async function getContent(fetchFn, src, chapterUrl) {
    const { html, url } = await fetchDoc(fetchFn, chapterUrl, src);
    const root = doc(html);
    /* 抓回来是验证码 / Cloudflare 挡板：别把「请完成验证码校验」当正文显示 */
    if (pageBlocked(html, root.title)) {
      return { paras: [], blocked: true, title: (root.title || '').trim(), from: 'blocked' };
    }
    const rule = src.ruleContent.content;
    const got = extractParas(root, url, src);
    let paras = got.paras;

    /* ---------- 漫画章 ----------
     * 判据：这一章里挂着几张「像正文插图」的图，而文字少得可怜。
     * 小说站的广告图通常混在正文里但字数很多，所以字数够就仍然按文字走。 */
    const comicNode = comicBestNode(root, rule);
    if (comicNode) {
      const rich = htmlToParasRich(comicNode.innerHTML || '', url)
        /* 漫画容器里夹着的「上一话 / 下一话 / 本站域名」不是正文 */
        .filter(p => p.indexOf('@img:') === 0 || (p.length > 1 && !JUNK_LINE.test(p) && !/^[上下前后]一[话章页頁集回]$/.test(p)));
      const imgN = rich.filter(p => p.indexOf('@img:') === 0).length;
      /* 单张超长条也算漫画（有的一话就一张图）；文字够多则仍按小说处理 */
      if ((imgN >= 2 && contentScore(paras) < 600) || (imgN >= 1 && contentScore(paras) < 120)) {
        const all = await followComicPages(fetchFn, src, root, url, rich);
        return { paras: all, title: (root.title || '').trim(), from: 'comic', comic: true };
      }
    }

    /* 一章拆成 (1/3)(2/3)(3/3) 的站：把后面几页拼回来 */
    paras = await followContentPages(fetchFn, src, root, url, paras);

    /* 规则什么都没取到（源改版 / 网页书的规则是上一章嗅出来的）时，
       先让「正文识别」自己找一遍，再退回整页文本 —— 直接拿 body 会把导航条当正文。
       注意：规则命中但内容很短（VIP 章节只给开头）时不要覆盖，那 200 字就是站点给的全文。 */
    if (contentScore(paras) < 80 && paras.join('').length < 150) {
      const ac = autoContent(root);
      if (ac && contentScore(ac.paras) > contentScore(paras)) { paras = ac.paras; got.from = 'auto'; }
      if (contentScore(paras) < 80) {
        const body = cleanParas(htmlToParas(root.body ? root.body.innerHTML : ''));
        if (contentScore(body) > contentScore(paras)) { paras = body; got.from = 'body'; }
      }
    }
    return { paras, title: (root.title || '').trim(), from: got.from };
  }

  /** 找「图片最密、文字最少」的那块容器：漫画章节的图都集中在这里 */
  function comicBestNode(root, rule) {
    const nodes = [];
    if (rule) {
      try { nodes.push(...selectNodes(root, rule)); } catch (e) { /* 规则不合法就算了 */ }
    }
    for (const sel of CONTENT_SELECTORS) {
      try { nodes.push(...root.querySelectorAll(sel)); } catch (e) { /* 忽略 */ }
    }
    nodes.push(root.body || root);
    let best = null, bestScore = 0;
    for (const n of nodes) {
      if (!n || !n.querySelectorAll) continue;
      const imgs = n.querySelectorAll('img').length;
      if (imgs < 2) continue;
      const chars = (n.textContent || '').replace(/\s+/g, '').length;
      const score = imgs * 60 - chars / 30;
      if (score > bestScore) { bestScore = score; best = n; }
    }
    return best;
  }

  /* ---------- 任意网页自动识别（网页搜书 / 加书架用） ---------- */
  const NAV_WORDS = /^(首页|书架|书库|排行|分类|登录|注册|退出|上一页|下一页|上一章|下一章|目录|返回|下载|客户端|APP|app|评论|加入书签|投票|推荐|搜索|更多|全部|最新章节|关于我们|联系方式|隐私政策|免责声明|广告服务|帮助中心|意见反馈|版权声明)$/;
  const CHAP_RE = /^(第[0-9０-９零一二三四五六七八九十百千万两]+\s*[章节回卷话集篇部幕]|序章|序言|序[、.\s]|楔子|引子|尾声|终章|后记|番外|正文\s*第)/;
  const NUM_RE = /^\d{1,4}\s*[.、,．]?\s*\S/;

  function isChapterTitle(t) {
    const s = String(t || '').replace(/\s+/g, ' ').trim();
    if (!s || s.length > 42) return false;
    return CHAP_RE.test(s) || NUM_RE.test(s);
  }

  /* 章节链接长什么样：站点里的用户主页 / 评论区 / 书单 / 搜索页也会挂着「01 昵称」这种标题，
     光看锚文本会把「粉丝榜」当成目录（纵横详情页就踩过：目录 10 章全是打赏用户）。 */
  const NOT_CHAPTER = /(^|\/)(userinfo|user|users|comment|comments|pl|bbs|forum|tag|tags|search|login|register|signup|author|writer|space|people|profile|club|account|message|booklist|shudan|top|rank)(\/|$)/i;

  function looksLikeChapterUrl(url) {
    let u;
    try { u = new URL(url); } catch (e) { return false; }
    if (!/^https?:$/.test(u.protocol)) return false;
    if (NOT_CHAPTER.test(u.pathname)) return false;
    const segs = u.pathname.split('/').filter(Boolean);
    if (!segs.length) return false;
    /* 章节地址要么有目录层级（/book/1/2.html），要么路径里带 chapter/read 这类词 */
    return segs.length >= 2 || /(chapter|read|book|txt|novel|content|view|info)/i.test(u.pathname);
  }

  /** 一串链接到底是不是「一本书的章节列表」：标题像章节 + 地址同目录 + 不像榜单 */
  function tocListTrusted(list, baseUrl) {
    const n = list.length;
    if (n < 4) return false;
    let chap = 0, hasChapWord = false;
    const dirs = new Map();
    for (const a of list) {
      const t = (a.textContent || '').replace(/\s+/g, ' ').trim();
      if (CHAP_RE.test(t)) hasChapWord = true;
      if (CHAP_RE.test(t) || NUM_RE.test(t)) chap++;
      const u = absUrl(baseUrl, a.getAttribute('href') || '');
      try {
        const dir = new URL(u).pathname.replace(/[^/]*$/, '');
        dirs.set(dir, (dirs.get(dir) || 0) + 1);
      } catch (e) { /* 忽略坏地址 */ }
    }
    if (chap / n < 0.7) return false;
    const top = dirs.size ? Math.max(...dirs.values()) : 0;
    if (top / n < 0.6) return false;
    /* 整串只有「01 昵称」这种编号、没有一处「第N章」，而且条目很少 —— 那是粉丝榜 / 书单 */
    if (!hasChapWord && n < 20) return false;
    return true;
  }
  function isNoise(t) {
    const s = String(t || '').trim();
    return !s || NAV_WORDS.test(s) || s.length < 2 || s.length > 42 || /^[\d\s.,、]+$/.test(s);
  }

  /** 生成尽量稳定的 CSS 选择器 */
  function cssPath(el, maxDepth) {
    const parts = [];
    let cur = el, depth = 0;
    while (cur && cur.nodeType === 1 && depth < (maxDepth || 6)) {
      const tag = cur.tagName.toLowerCase();
      if (tag === 'body' || tag === 'html') break;
      /* 章节页的 id 常带章节号（#chapter_36898237）：拿它当选择器，换一章就再也匹配不上，
         网页书的正文规则只要一章就废了 —— 这种 id 直接跳过，用 class 定位。 */
      if (cur.id && /^[A-Za-z][\w-]*$/.test(cur.id) && !/\d{4,}/.test(cur.id)) { parts.unshift('#' + cur.id); break; }
      let s = tag;
      const cls = [...(cur.classList || [])].filter(c => /^[A-Za-z_][\w-]*$/.test(c)).slice(0, 2);
      if (cls.length) s += '.' + cls.join('.');
      else if (cur.parentElement) {
        const same = [...cur.parentElement.children].filter(x => x.tagName === cur.tagName);
        if (same.length > 1) s += ':nth-of-type(' + (same.indexOf(cur) + 1) + ')';
      }
      parts.unshift(s);
      cur = cur.parentElement;
      depth++;
    }
    return parts.join(' ');
  }

  /** 找目录：返回 { rule, chapters } */
  function autoToc(root, baseUrl) {
    const anchors = [...root.querySelectorAll('a[href]')].filter(a => {
      const href = a.getAttribute('href') || '';
      if (!href || href === '#' || /^javascript:/i.test(href)) return false;
      if (!isChapterTitle(a.textContent)) return false;
      return looksLikeChapterUrl(absUrl(baseUrl, href));
    });
    if (anchors.length < 3) return null;

    const score = new Map();
    for (const a of anchors) {
      let p = a.parentElement, d = 0;
      while (p && d < 6) {
        if (!score.has(p)) score.set(p, []);
        score.get(p).push(a);
        p = p.parentElement; d++;
      }
    }
    const cands = [];
    for (const [el, list] of score) {
      const total = el.querySelectorAll('a[href]').length;
      const ratio = list.length / Math.max(1, total);
      if (list.length < 4 || ratio < 0.65) continue;
      const s = list.length * ratio * (ratio >= 0.9 ? 1.2 : 1);
      cands.push({ el, list, s, ratio });
    }
    /* 得分最高的容器不一定可信（粉丝榜条目也全是链接），挨个验证到第一个信的过的 */
    cands.sort((a, b) => b.s - a.s);
    let best = null;
    for (const c of cands.slice(0, 8)) {
      if (!tocListTrusted(c.list, baseUrl)) continue;
      best = c; break;
    }
    if (!best) return null;

    const parents = [...new Set(best.list.map(a => a.parentElement))];
    const csel = cssPath(best.el);
    let listSel, nameRule;
    if (parents.length === 1 && parents[0] === best.el) {
      listSel = csel + ' > a';
      nameRule = '@text';
    } else if (parents.length === 1) {
      listSel = csel + ' ' + parents[0].tagName.toLowerCase();
      nameRule = '@text';
    } else {
      const tag = parents.map(p => p.tagName).join(',');
      const allDirect = parents.every(p => p.parentElement === best.el);
      listSel = allDirect && new Set(tag.split(',')).size === 1
        ? csel + ' > ' + tag.split(',')[0].toLowerCase()
        : csel + ' a';
      nameRule = '@text';
    }

    const seen = new Set();
    const chapters = [];
    for (const a of best.list) {
      const title = (a.textContent || '').replace(/\s+/g, ' ').trim();
      const url = absUrl(baseUrl, a.getAttribute('href'));
      if (!url || seen.has(url)) continue;
      seen.add(url);
      chapters.push({ title: title.slice(0, 80), url });
    }
    if (chapters.length < 3) return null;

    return {
      /* 网页嗅探出来的目录同样是「站点顺序」：把倒序的最新章块归位，
         否则网页书也会出现「点第1章跳到第666章」 */
      chapters: normalizeToc(chapters),
      rule: { chapterList: listSel, chapterName: nameRule, chapterUrl: 'a@href' },
      score: best.ratio
    };
  }

  /** 找正文：返回 { selector, paras, chars, weak } */
  function autoContent(root) {
    const cands = [...root.querySelectorAll('div,article,section,td,main,pre')];
    const good = [];
    let maxLen = 0;
    for (const el of cands) {
      /* 导航 / 页脚 / 侧栏里的字再多也不是正文，先排除（详情页的「最新章节」块就在侧栏里） */
      if (el.closest && el.closest('nav,header,footer,aside,form,select,ul.menu,.nav,.nav-bar,.footer')) continue;
      const text = (el.textContent || '').replace(/\s+/g, '');
      if (text.length < 150) continue;
      let linkLen = 0;
      for (const a of el.querySelectorAll('a')) linkLen += (a.textContent || '').replace(/\s+/g, '').length;
      if (linkLen / text.length > 0.25) continue;
      const blocks = el.querySelectorAll('p,br').length;
      let depth = 0;
      for (let p = el; p; p = p.parentElement) depth++;
      good.push({ el, n: text.length, depth, ok: blocks >= 4 });
      if (text.length > maxLen) maxLen = text.length;
    }
    if (!good.length) return null;
    /* 包裹层的字数和正文一样多（外面还套着导航），取「够长且最深」的那层才是正文本身。
       以前按最长字符串取，选中的是整个 #page_reader（含导航条和搜索框）。 */
    const pool = good.filter(g => g.n >= maxLen * 0.7);
    if (!pool.length) return null;
    pool.sort((a, b) => b.depth - a.depth || b.n - a.n);
    const best = pool[0].el;
    const paras = htmlToParas(best.innerHTML);
    const chars = paras.join('').length;
    if (chars < 150) return null;
    /* 173 字这种「正文」其实是站点公告/简介片段：标成 weak，UI 不当成可读的书 */
    return { selector: cssPath(best), paras, chars, weak: chars < 600 };
  }

  /** 从页面猜书名 / 作者 */
  function autoInfo(root) {
    const meta = q => { const el = root.querySelector(q); return el ? (el.getAttribute('content') || '') : ''; };
    let name = '', author = '';
    /* 有些站的 h1 里混着统计脚本输出（速读谷的 h1 是 `towan('31125026')万字剑来`） */
    const sane = s => {
      const t = String(s || '').replace(/\s+/g, ' ').trim();
      if (!t || t.length > 80) return '';
      if (/\(\s*'|'\s*\)|towan\(|document\.|window\.|function\s*\(/i.test(t)) return '';
      return t;
    };
    const take = (raw, allowChapter) => {
      const t = sane(raw);
      if (!t) return false;
      const pt = parseBookTitle(t);
      const nm = String(pt.name || '').replace(/^[《「『"'\s]+|[》」』"'\s]+$/g, '').trim();
      if (!nm || nm.length < 2 || nm.length > 30) return false;
      if (!allowChapter && (CHAP_RE.test(nm) || NUM_RE.test(nm))) return false;
      if (/^[\w.-]+$/.test(nm) && /[a-z]/i.test(nm)) return false;   // 纯域名/英文路径
      name = nm;
      if (pt.author) author = pt.author;
      return true;
    };
    const hs = [...root.querySelectorAll('h1, .bookname h1, .book-name, #info h1, .bookinfo h1, .book-name-text')];
    for (const h of hs) if (take(h.textContent, false)) break;
    if (!name) take(meta('meta[property="og:title"]'), false);
    if (!name) {
      /* 章节页的 <title> 是「第一章 惊蛰_剑来小说最新章节…」，逐段试，跳过章节名的那段 */
      for (const seg of String(root.title || '').split(TITLE_SEP)) {
        if (take(seg, false)) break;
      }
    }
    if (!name) {
      const t = (root.title || '').trim().split(/[_\-|｜–—]/)[0].trim();
      if (t && t.length < 40) name = t;
    }
    if (!author) {
      const bodyText = (root.body ? root.body.textContent : '').replace(/\s+/g, ' ');
      const m = /作\s*者[：:]\s*([^\s|，,。]{1,16})/.exec(bodyText)
        || /([^\s|，,。0-9a-zA-Z]{2,10})\s+作\s*者(?:百科|作品)?/.exec(bodyText);
      if (m) author = cleanAuthor(m[1]);
    }
    if (!author) {
      const el = root.querySelector('.author, .book-author, #info .author');
      const t = el && (el.textContent || '').trim();
      if (t && t.length < 20) author = cleanAuthor(t);
    }
    return { name: name || '', author: author || '' };
  }

  /** 阅读页上的「下一话 / 下一章 / 下一集」地址（漫画单页站顺着它串成目录） */
  function nextChapterLink(html, baseUrl) {
    const root = doc(html);
    const A = [];
    for (const a of root.querySelectorAll('a[href]')) {
      const t = (a.textContent || '').replace(/[\s\u3000>›»→]+/g, '');
      const u = absUrl(baseUrl, a.getAttribute('href') || '');
      if (!u || !/^https?:/i.test(u)) continue;
      A.push({ t, u });
    }
    const hit = A.find(x => /^(下一话|下一話|下一章|下一集|下一回|下一页|下一頁|下一张|下一張)$/.test(x.t));
    return hit ? hit.u : '';
  }

  /** 页面上的书籍候选（用于「本页有哪些书」快速加书架） */
  function sniffLinks(root, baseUrl) {
    const groups = new Map();
    for (const a of root.querySelectorAll('a[href]')) {
      const href = a.getAttribute('href') || '';
      if (!href || href === '#' || /^javascript:/i.test(href)) continue;
      const text = (a.textContent || '').replace(/\s+/g, ' ').trim();
      if (isNoise(text)) continue;
      const url = absUrl(baseUrl, href);
      if (!/^https?:/.test(url)) continue;
      const p = a.parentElement;
      if (!p) continue;
      // 父级只有一个链接时（常见于 <li><a>），用祖父级聚合，避免每组只有一条
      const key = (p.querySelectorAll('a').length === 1 && p.parentElement) ? p.parentElement : p;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push({ title: text, url });
    }
    const out = [];
    const seen = new Set();
    for (const list of groups.values()) {
      if (list.length < 2) continue;
      for (const it of list) {
        if (seen.has(it.url)) continue;
        seen.add(it.url);
        out.push(it);
      }
    }
    // 单本书详情页：整页只有一个候选
    if (!out.length) {
      const h1 = root.querySelector('h1');
      if (h1 && (h1.textContent || '').trim()) out.push({ title: (h1.textContent || '').trim().slice(0, 40), url: baseUrl });
    }
    return out.slice(0, 60);
  }

  /**
   * 搜索引擎结果页专用的链接抽取。
   *
   * 通用 sniffLinks 取的是「整条结果」的锚文本，而必应在同一个 <a> 里既放标题又放 cite
   * （baidu.com + https://baike.baidu.com › item），标题就变成了域名；百度/搜狗/360
   * 又各自用了不同的容器。这里按各家结果条的标题节点取，标题干净、地址也准。
   */
  function autoSerpLinks(root, baseUrl) {
    /* 只在搜索站上动手。小说站的目录页偶尔也会命中 .result h3 a 这种通用选择器，
       一旦误判成「搜索页」，同域链接（也就是章节）会被全部滤掉，反而更糟。 */
    let host = '';
    try { host = new URL(baseUrl).host.replace(/^www\./, ''); } catch (e) { return []; }
    if (!/(^|\.)(bing|baidu|sogou|so|google|zhihu|sm|yandex|duckduckgo)\.(com|cn|net)$/.test(host)) return [];
    const out = [];
    const seen = new Set();
    const push = (title, href) => {
      const t = String(title || '').replace(/\s+/g, ' ').trim();
      if (!t || t.length > 90) return;
      if (!href || href === '#' || /^javascript:/i.test(href)) return;
      const url = absUrl(baseUrl, href);
      if (!/^https?:/.test(url)) return;
      if (seen.has(url)) return;
      seen.add(url);
      out.push({ title: t, url });
    };
    /* 各家的结果标题节点。h2 a 覆盖必应，h3 a 覆盖百度/搜狗/360/谷歌 */
    const sels = [
      '#b_results li.b_algo h2 a',
      '.b_algo h2 a',
      '#content_left .result h3 a',
      '#content_left .c-container h3 a',
      '.result-op h3 a',
      '.vrwrap h3 a',
      '.res-list h3 a',
      '.result h3 a',
      '#rso .g h3 a',
      '[data-testid="result"] h2 a'
    ];
    for (const s of sels) {
      for (const a of root.querySelectorAll(s)) push(a.textContent, a.getAttribute('href'));
      if (out.length >= 5) break;
    }
    return out.slice(0, 40);
  }

  /** 一次性分析页面。opts.light：只抽链接（搜索结果页用，省掉目录/正文那一大圈） */
  function detectPage(html, baseUrl, opts) {
    const o = opts || {};
    const root = doc(html);
    if (o.light) {
      const sl = autoSerpLinks(root, baseUrl);
      return {
        info: { name: '', author: '' }, toc: null, content: null, comic: null,
        links: sl.length >= 3 ? sl : sniffLinks(root, baseUrl),
        serp: sl.length >= 3 || !!o.serp,
        title: (root.title || '').trim()
      };
    }
    const serp = autoSerpLinks(root, baseUrl);
    /* 搜索结果页上没有「目录」也没有「正文」——那 10 条结果摘要全都会被误判，
       直接跳过这两步，既快又不会把搜索页当书。 */
    const info = autoInfo(root);
    const toc = serp.length >= 3 ? null : autoToc(root, baseUrl);
    const content = serp.length >= 3 ? null : autoContent(root);
    /* 漫画：图片成片、文字很少 —— 详情页/阅读页都能识别，交给 UI 决定怎么加书架 */
    let comic = null;
    if (serp.length < 3) {
      const node = comicBestNode(root, '');
      if (node) {
        const urls = imgList(node.innerHTML || '', baseUrl);
        const chars = (node.textContent || '').replace(/\s+/g, '').length;
        if (urls.length >= 2 && chars < 1200) {
          comic = { selector: cssPath(node), images: urls.slice(0, 20), count: urls.length };
        }
      }
    }
    /* 没有目录但整页都是图时，把这一页当成「一章」也能读 */
    const contentOut = content || (comic ? { selector: comic.selector, paras: [], chars: 0, comic: true, weak: false } : null);
    return {
      info, toc, content: contentOut, comic,
      links: serp.length >= 3 ? serp : sniffLinks(root, baseUrl),
      serp: serp.length >= 3,
      title: (root.title || '').trim()
    };
  }

  /* ===========================================================
     网页搜书：把搜索引擎的十条链接变成「一本书 + 几个站」
     =========================================================== */

  /* 百科 / 问答 / 视频 / 电商 这些页面上永远读不到正文，别摆在书架上当书 */
  const SERP_JUNK_SITES = [
    'baike.baidu.com', 'zhidao.baidu.com', 'tieba.baidu.com', 'haokan.baidu.com', 'wenku.baidu.com',
    'zhihu.com', 'douban.com', 'weibo.com', 'bilibili.com', 'douyin.com', 'kuaishou.com',
    'xiaohongshu.com', 'jd.com', 'taobao.com', 'tmall.com', 'csdn.net', 'jianshu.com',
    'iqiyi.com', 'youku.com', 'v.qq.com', 'weixin.qq.com', 'news.163.com', 'sina.com.cn',
    'sohu.com', 'ifeng.com', 'thepaper.cn', 'baijiahao.baidu.com'
  ];
  const SERP_JUNK_TITLE = /百度百科|维基百科|知乎|豆瓣|微博|贴吧|抖音|快手|哔哩哔哩|bilibili|西瓜视频|视频|直播|攻略|问答|新闻|资讯|论坛|贴子|图片|壁纸|表情包|排行榜|排行榜大全/i;

  function siteHost(url) {
    try { return new URL(url).host.replace(/^www\./, '').toLowerCase(); } catch (e) { return ''; }
  }
  function junkHost(host) {
    const h = String(host || '').toLowerCase().replace(/^www\./, '');
    if (!h) return true;
    return SERP_JUNK_SITES.some(s => h === s || h.endsWith('.' + s));
  }

  /* 站点 → 中文名（这些站名出现在结果里比域名好认得多） */
  const SITE_NAMES = {
    'zongheng.com': '纵横中文网', 'qidian.com': '起点中文网', 'yunqi.qq.com': '云起书院',
    'qimao.com': '七猫小说', 'shuqi.com': '书旗小说', 'bilixs.com': '哔哩小说',
    'sudugu.cc': '速读谷', 'qidiy.com': '奇弟文学', 'jjwxc.net': '晋江文学城',
    'hongxiu.com': '红袖添香', 'readnovel.com': '潇湘书院', '17k.com': '17K小说网',
    'fanqienovel.com': '番茄小说', 'kuaikanmanhua.com': '快看漫画', 'baozimh.com': '包子漫画',
    'copymanga.tv': '拷贝漫画', 'manhuagui.com': '漫画柜', 'xmanhua.com': 'x漫画',
    'biquge.com': '笔趣阁', 'bqg128.com': '笔趣阁', 'ibiquges.com': '笔趣阁'
  };
  function siteLabel(host) {
    const h = String(host || '').toLowerCase().replace(/^www\./, '');
    if (SITE_NAMES[h]) return SITE_NAMES[h];
    const parts = h.split('.');
    for (let i = 1; i < parts.length - 1; i++) {
      const tail = parts.slice(i).join('.');
      if (SITE_NAMES[tail]) return SITE_NAMES[tail];
    }
    return h;
  }

  /**
   * 搜索结果 → 书。同一本书在 N 个站上就合成一张卡（跟书源搜索的「N 个源」一个意思），
   * 站点名进标签，按相关度排序，百科/视频/问答直接扔掉。
   */
  function serpBooks(links, key) {
    const k = normKey(key);
    const map = new Map();
    for (const l of links || []) {
      if (!l || !l.url) continue;
      const host = siteHost(l.url);
      if (!host || junkHost(host)) continue;
      const raw = String(l.title || '').replace(/\s+/g, ' ').trim();
      if (!raw || raw.length > 90) continue;
      if (SERP_JUNK_TITLE.test(raw)) continue;
      const pt = parseBookTitle(raw);
      const name = pt.name;
      if (!name || name.length < 2 || name.length > 30) continue;
      if (/^[\w.-]+$/.test(name)) continue;          // 纯域名 / 英文路径不是书名
      const rel = k ? relScore(name, pt.author, key) : 60;
      if (!rel) continue;
      const bk = normKey(name);
      let g = map.get(bk);
      if (!g) { g = { name, author: pt.author || '', score: rel, sites: [] }; map.set(bk, g); }
      if (!g.author && pt.author) g.author = pt.author;
      if (rel > g.score) { g.score = rel; if (name.length <= g.name.length) g.name = name; }
      if (!g.sites.some(s => s.host === host)) {
        g.sites.push({ url: l.url, host, label: siteLabel(host), title: raw });
      }
    }
    const out = [...map.values()].filter(g => g.sites.length);
    out.sort((a, b) => b.score - a.score || b.sites.length - a.sites.length);
    return out.slice(0, 16);
  }

  /* ===========================================================
     网页书嗅探：从一个地址走到「这本书的目录 + 正文规则」
     =========================================================== */

  const CAT_TEXT = /^(目录|章节目录|查看目录|全部章节|完整目录|章节列表|全部章节列表|查看全部章节|回到目录|返回目录|阅读目录|查看全部)$/;
  const READ_TEXT = /^(立即阅读|开始阅读|点击阅读|从头阅读|从头开始|免费阅读|在线阅读|继续阅读|马上阅读)$/;

  /** 页面上的「目录 / 全部章节」候选地址（最多 3 个，按可信度排） */
  function findCatalogLink(root, baseUrl) {
    const A = [];
    for (const a of root.querySelectorAll('a[href]')) {
      const h = a.getAttribute('href') || '';
      if (!h || h === '#' || /^javascript:/i.test(h)) continue;
      const t = (a.textContent || '').replace(/\s+/g, '').trim();
      if (!t || t.length > 12) continue;
      const url = absUrl(baseUrl, h);
      if (!/^https?:/i.test(url)) continue;
      let score = 0;
      if (CAT_TEXT.test(t)) score = 100;
      else if (/目录|章节/.test(t) && t.length <= 8) score = 60;
      else if (/(catalog|chapterlist|chapter-list|showchapter|chapters?|list|index)\.?(html?|php|aspx?)?$/i.test(sitePath(url))) score = 30;
      if (!score) continue;
      A.push({ url, score });
    }
    A.sort((a, b) => b.score - a.score);
    const out = [];
    for (const x of A) if (!out.includes(x.url)) out.push(x.url);
    return out.slice(0, 3);
  }

  function sitePath(u) {
    try { return new URL(u).pathname; } catch (e) { return ''; }
  }

  function findReadLink(root, baseUrl) {
    for (const a of root.querySelectorAll('a[href]')) {
      const t = (a.textContent || '').replace(/\s+/g, '').trim();
      if (!READ_TEXT.test(t)) continue;
      const u = absUrl(baseUrl, a.getAttribute('href') || '');
      if (/^https?:/i.test(u)) return u;
    }
    /* 没有「开始阅读」就用第一个像章节的链接（详情页挂着的最新章，章节页上有目录入口） */
    for (const a of root.querySelectorAll('a[href]')) {
      const t = (a.textContent || '').replace(/\s+/g, ' ').trim();
      const u = absUrl(baseUrl, a.getAttribute('href') || '');
      if (CHAP_RE.test(t) && looksLikeChapterUrl(u)) return u;
    }
    return '';
  }

  /** 页面上写了「共 716 章」就按它判断目录全不全 */
  function expectedTotal(root) {
    const t = (root.body ? root.body.textContent : '').replace(/\s+/g, ' ');
    const m = /(?:共|总计|合计|全本?共)\s*(\d{2,5})\s*章/.exec(t)
      || /(\d{2,5})\s*章\s*(?:全|完本|完结)/.exec(t)
      || /章\s*节?\s*数?\s*[：:]\s*(\d{2,5})/.exec(t);
    return m ? +m[1] : 0;
  }

  /** 站点把目录藏在固定路径上（纵横是 book.zongheng.com/showchapter/<id>.html），猜几个常见模板 */
  function tocGuessUrls(url, readUrl) {
    const ids = [], origins = [];
    const add = (arr, v) => { if (v && !arr.includes(v)) arr.push(v); };
    for (const src of [url, readUrl]) {
      let u;
      try { u = new URL(src || ''); } catch (e) { continue; }
      const m = /\/(\d{3,})\.html?$/.exec(u.pathname)
        || /\/chapter\/(\d+)\//.exec(u.pathname)
        || /\/(\d{3,})\/?$/.exec(u.pathname);
      if (m) add(ids, m[1]);
      /* 同一站点的目录常在另一个子域上（书页在 book. / m.，正文在 read.） */
      const host = u.host.replace(/^www\./, '');
      const parts = host.split('.');
      const base = parts.length > 2 ? parts.slice(-2).join('.') : host;
      add(origins, u.origin);
      add(origins, 'https://book.' + base);
      add(origins, 'https://www.' + base);
    }
    const out = [];
    const id = ids[0];
    if (!id) return out;
    for (const t of ['/showchapter/ID.html', '/book/ID/index.html', '/book/ID/', '/novel/ID/', '/list/ID.html']) {
      for (const o of origins) add(out, o + t.replace('ID', id));
    }
    return out.slice(0, 6);
  }

  /** 反爬 / 验证页：不是站点没内容，是它不让抓 */
  function pageBlocked(html, title) {
    const s = String(title || '') + ' ' + String(html || '').slice(0, 6000);
    if (/Just a moment|cf-browser-verification|Attention Required|Checking your browser|Enable JavaScript and cookies|cloudflare/i.test(s)) return 'cloudflare';
    if (String(html || '').length < 12000 && /安全验证|人机验证|验证码|captcha|访问异常|拒绝访问|滑动验证|反爬|请开启JavaScript/i.test(s)) return 'captcha';
    return '';
  }

  /**
   * 从任意地址嗅探一本书：
   *   fetchFn 就是 mo.net（{url, charset, timeout} → {ok, text, url}）
   * 返回 { d, url, trace, ms }；d 的结构和 detectPage 一致。
   *
   * 关键在于「一轮不够就再走一轮」：详情页常常只挂最新十章（甚至把粉丝榜当目录），
   * 真目录可能在同一页的「目录」链接、在章节页的「返回目录」、或者在站点固定路径上。
   * 这几条路并行抓，谁给的章多用谁 —— 以前是拿第一页的 10 条就当整本书。
   */
  async function sniffBook(fetchFn, url, opts) {
    const o = opts || {};
    const t0 = Date.now();
    const trace = [];
    const cache = new Map();
    const timeout = o.timeout || 12000;
    /* 慢站一页能挂十几秒，三轮下来就是四十多秒。整体给个死线，到点就用手上最好的结果。 */
    const deadline = t0 + (o.deadline || 20000);

    const get = async (u, soft) => {
      if (cache.has(u)) return cache.get(u);
      const left = deadline - Date.now();
      if (left < 800) throw new Error('请求超时');
      const p = (async () => {
        const ts = Date.now();
        const r = await fetchFn({ url: u, charset: 'auto', timeout: Math.min(timeout, left), headers: o.headers });
        if (!r || r.ok === false) throw new Error((r && r.error) || '网络错误');
        trace.push({ u, ms: Date.now() - ts, len: (r.text || '').length });
        return { html: r.text || '', url: r.url || u };
      })();
      cache.set(u, p);
      try { return await p; } catch (e) {
        cache.delete(u);
        if (soft) return null;
        throw e;
      }
    };

    let page = o.page || await get(url);
    let d = o.detected ? Object.assign({}, o.detected) : detectPage(page.html, page.url);
    let cur = page.url;
    if (d.serp) return { serp: true, d, url: cur, trace, ms: Date.now() - t0 };

    const parse = p => { try { return detectPage(p.html, p.url); } catch (e) { return null; } };
    const chapN = dd => (dd && dd.toc ? dd.toc.chapters.length : 0);

    /* 漫画单页（图多字少）本来就没有目录，再去找「目录链接 / 猜站点路径」纯属浪费两个往返 */
    if (!d.toc && d.comic && (d.comic.count || 0) >= 2) {
      return { d, url: cur, trace, ms: Date.now() - t0 };
    }

    const needMore = () => {
      const n = chapN(d);
      if (!n) return true;
      const exp = expectedTotal(doc(page.html));
      if (exp && n < exp * 0.9) return true;
      /* 详情页只挂十来章「最新章节」是常态，少于 15 章就当不全再找一轮 */
      return n < 15;
    };

    for (let round = 0; round < 3 && needMore(); round++) {
      if (Date.now() > deadline - 1200) break;
      const root = doc(page.html);
      const cats = findCatalogLink(root, cur).filter(u => u !== cur);
      const read = findReadLink(root, cur);
      const cands = cats.slice();
      /* 章节页上的「返回目录」、详情页的「立即阅读」都要试：前者直接给目录，后者能带我们找到目录 */
      if (read && read !== cur && !cands.includes(read)) cands.push(read);
      /* 只有详情页（带「立即阅读 / 开始阅读」）才值得去猜站点的固定目录路径 */
      if (!cats.length && read) {
        for (const u of tocGuessUrls(cur, read)) if (u !== cur && !cands.includes(u)) cands.push(u);
      }
      if (!cands.length) break;

      const pages = (await Promise.all(cands.slice(0, 3).map(u => get(u, true)))).filter(Boolean);
      let pick = null;
      let baseN = chapN(d);
      for (const p of pages) {
        const dd = parse(p);
        if (!dd || dd.serp) continue;
        const n = chapN(dd);
        if (n > baseN && (!pick || n > pick.n)) pick = { d: dd, page: p, n };
      }
      if (!pick) {
        /* 没有更全的目录，但可能摸到了正文页，顺手把正文规则带上 */
        for (const p of pages) {
          const dd = parse(p);
          if (dd && dd.content && (!d.content || d.content.weak)) {
            d = Object.assign({}, d, { content: dd.content, comic: dd.comic || d.comic });
            break;
          }
        }
        break;
      }
      page = pick.page;
      cur = pick.page.url;
      d = Object.assign({}, d, {
        toc: pick.d.toc,
        content: (d.content && !d.content.weak) ? d.content : (pick.d.content || d.content),
        comic: d.comic || pick.d.comic,
        info: (pick.d.info && pick.d.info.name) ? pick.d.info : d.info
      });
    }

    /* 目录有了但还没正文规则 → 抓第一章，正文容器靠嗅探（加入书架后要按规则取正文） */
    if (d.toc && chapN(d) && (!d.content || d.content.weak) && d.toc.chapters[0]) {
      const p = await get(d.toc.chapters[0].url, true);
      if (p) {
        const dd = parse(p);
        if (dd && dd.content && (!dd.content.weak || !d.content)) {
          d = Object.assign({}, d, { content: dd.content, comic: dd.comic || d.comic });
        }
      }
    }
    return { d, url: cur, trace, ms: Date.now() - t0 };
  }

  global.Engine = {
    normalizeSource, search, getToc, getContent,
    htmlToParas, htmlToParasRich, imgList, comicBestNode,
    evalRule, first, splitRule, absUrl, selectNodes, applyPost,
    detectPage, autoToc, autoContent, autoInfo, sniffLinks, cssPath, isChapterTitle,
    jsonQuery, jsonPathAll, contentScore, cleanParas,
    /* 搜索结果清洗：单测/探针直接调用 */
    parseBookTitle, relScore, guessSearchResults, bookKeyOf,
    /* 目录归位：章节号解析 + 排序去重（单测/探针直接调用） */
    normalizeToc, chapNo, cnNum,
    /* 漫画连更：顺着「下一话」串联 */
    nextChapterLink,
    /* 网页搜书：搜索结果归并 / 联网嗅探一本书 */
    serpBooks, sniffBook, siteLabel, junkHost, pageBlocked,
    findCatalogLink, findReadLink, expectedTotal, tocListTrusted, looksLikeChapterUrl
  };
})(window);
