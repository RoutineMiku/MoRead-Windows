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
    const raw = el.getAttribute('data-src') || el.getAttribute('data-original')
      || el.getAttribute('data-lazy-src') || el.getAttribute('data-echo')
      || el.getAttribute('src') || '';
    if (!raw || /^data:/i.test(raw) || /^blob:/i.test(raw)) return '';
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
  async function fetchDoc(fetchFn, url, src) {
    const r = await fetchFn({ url, charset: src.charset || 'auto', headers: src.headers });
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

  async function search(fetchFn, src, key) {
    let url = String(src.searchUrl || '');
    /* 搜索地址本身可能是 @js:：高级书源用 JS 拼带签名/加密参数的接口地址 */
    if (/^\{\{[\s\S]*\}\}$/.test(url) || /^@js:/i.test(url)) {
      const expr = url.replace(/^\{\{|\}\}$/g, '').replace(/^@js:/i, '');
      const v = runJs(expr, { src, key, baseUrl: src.url || '' });
      url = v == null ? '' : String(v);
    }
    if (!url) throw new Error('书源没有配置搜索地址');
    // 相对地址（/so.html?q={{key}}）按书源域名补全
    if (!/^https?:/i.test(url)) url = absUrl(src.url || '', url);
    if (!/\{key\}|key=/.test(src.searchUrl) && !/%s/.test(src.searchUrl) && !/\?/.test(src.searchUrl)) {
      url += (url.includes('?') ? '&' : '?') + 'key=' + encodeURIComponent(key);
    }
    const { html, url: finalUrl } = await fetchDoc(fetchFn, url, src);
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
      // 兜底：整页当作一张卡片
      cards = [root.body || root];
      loose = true;
    }

    const out = [];
    for (const c of cards.slice(0, 40)) {
      const cctx = typeof c === 'object' && c.nodeType
        ? { doc: root, root: c, html, baseUrl: finalUrl, json: json || {}, src }
        : { doc: root, root: root, html, baseUrl: finalUrl, json: c, src };
      const name = first(src.ruleSearch.name, cctx) || first('h3 a@text', cctx) || first('a@text', cctx);
      if (!name || name.length > 60) continue;
      const bookUrl = absUrl(finalUrl, first(src.ruleSearch.bookUrl, cctx) || first('a@href', cctx));
      if (!bookUrl) continue;
      out.push({
        name,
        author: first(src.ruleSearch.author, cctx) || '佚名',
        bookUrl,
        intro: first(src.ruleSearch.intro, cctx).slice(0, 120),
        coverUrl: first(src.ruleSearch.coverUrl, cctx),
        kind: first(src.ruleSearch.kind, cctx),
        lastChapter: first(src.ruleSearch.lastChapter, cctx),
        sourceId: src.id,
        sourceName: src.name,
        loose
      });
    }
    return out;
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
  async function followTocPages(fetchFn, src, firstPage, rows) {
    const rule = src.ruleToc.nextTocUrl;
    if (!rule || !rows.length) return rows;
    let cur = firstPage;
    const seen = new Set([cur.url]);
    for (let p = 0; p < 20; p++) {
      const cctx = { doc: cur.root, root: cur.root, html: cur.html || '', baseUrl: cur.url, json: cur.json || {}, src };
      let next = first(rule, cctx);
      if (!next) {
        const ns = selectNodes(cur.root, rule);
        if (ns.length) next = extract(ns[0], 'href', cur.url) || extract(ns[0], 'value', cur.url);
      }
      if (!next) break;
      const nu = absUrl(cur.url, next);
      if (!nu || seen.has(nu)) break;
      seen.add(nu);
      try {
        const t = await fetchDoc(fetchFn, nu, src);
        const r2 = doc(t.html);
        const json2 = parseMaybeJson(t.html);
        const more = pickChapters(r2, t.url, src, json2, t.html);
        if (!more.length) break;
        rows.push(...more);
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

  async function getToc(fetchFn, src, bookUrl) {
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

    // 1) 规则里给了独立目录页
    const tocUrl = first(src.ruleBookInfo.tocUrl, base);
    if (tocUrl && tocUrl !== url) {
      try {
        const t = await fetchDoc(fetchFn, absUrl(url, tocUrl), src);
        const r2 = doc(t.html);
        const c = await collect(r2, t.url, t.html);
        if (c.length >= 3) return { chapters: c, info, tocUrl: t.url };
      } catch (e) { /* 继续往下兜底 */ }
    }

    // 2) 当前页直接解析
    let chapters = dedupeChapters(pickChapters(root, url, src, json0, html));
    if (chapters.length >= 3) {
      chapters = dedupeChapters(await followTocPages(fetchFn, src, { root, url, html, json: json0 }, chapters));
      /* 详情页常只挂「最新章节」十来条，完整目录在另一个页面。
         章节数明显偏少时再跟一次「目录 / 全部章节」，取更大的那份 ——
         否则书架里的书只有最后十几章，读起来「章节不对」。 */
      if (chapters.length < 40) {
        const full = await tocFromLink(fetchFn, src, root, url);
        if (full && full.chapters.length > chapters.length) {
          return { chapters: full.chapters, info, tocUrl: full.url, fallback: full.fallback };
        }
      }
      return { chapters, info, tocUrl: url };
    }

    // 3) 跟随「目录 / 全部章节」链接再试
    const full = await tocFromLink(fetchFn, src, root, url);
    if (full) return { chapters: full.chapters, info, tocUrl: full.url, fallback: full.fallback };

    // 4) 当前页按常见容器兜底（站点改版导致规则失效时）
    let loose = false;
    if (chapters.length < 3) {
      for (const sel of TOC_SELECTORS) {
        const rows = simpleChapters(root, url, sel);
        if (rows.length > chapters.length) { chapters = dedupeChapters(rows); loose = true; }
      }
    }
    return { chapters: loose ? fixOrder(chapters) : dedupeChapters(chapters), info, tocUrl: url, fallback: loose };
  }

  const CONTENT_SELECTORS = [
    '#content', '#chaptercontent', '#booktext', '#htmlContent', '.content', '.read-content',
    '.showtxt', '#article', 'article', '.txtnav', '#txtContent', '.read-content', '#booktxt',
    '.text', '.chapter-content', '#chapter-content'
  ];

  const JUNK_LINE = /^(上一章|下一章|上一页|下一页|目录|章节目录|返回列表|返回目录|加入书签|加入书架|投推荐票|投月票|章节目录|章节报错|手机阅读|手机版|电脑版|举报|最新网址|请记住本站|本站域名|笔趣阁|www\.|https?:\/\/)/i;

  /** 去掉广告/导航行，只留正文段落 */
  function cleanParas(paras) {
    return (paras || [])
      .map(s => String(s).replace(/\u00a0/g, ' ').trim())
      .filter(s => s.length > 1 && !JUNK_LINE.test(s))
      .filter(s => !/(本章未完|请点击下一页继续|请收藏本站|一秒记住|更新最快)/.test(s));
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

  async function getContent(fetchFn, src, chapterUrl) {
    const { html, url } = await fetchDoc(fetchFn, chapterUrl, src);
    const root = doc(html);
    const base = { doc: root, root, html, baseUrl: url, json: {}, src };
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
    let paras = best ? best.p : [];

    /* ---------- 漫画章 ----------
     * 判据：这一章里挂着几张「像正文插图」的图，而文字少得可怜。
     * 小说站的广告图通常混在正文里但字数很多，所以字数够就仍然按文字走。 */
    const comicNode = comicBestNode(root, rule);
    if (comicNode) {
      const rich = htmlToParasRich(comicNode.innerHTML || '', url);
      const imgN = rich.filter(p => p.indexOf('@img:') === 0).length;
      if (imgN >= 2 && contentScore(paras) < 600) {
        return { paras: rich, title: (root.title || '').trim(), from: 'comic', comic: true };
      }
    }

    // 实在太短（可能被反爬/验证页拦了）时，退回整页文本，让上层提示而不是白屏
    if (contentScore(paras) < 80) {
      const body = cleanParas(htmlToParas(root.body ? root.body.innerHTML : ''));
      if (contentScore(body) > contentScore(paras)) { paras = body; best = { from: 'body' }; }
    }
    return { paras, title: (root.title || '').trim(), from: best && best.from };
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
      if (cur.id && /^[A-Za-z][\w-]*$/.test(cur.id)) { parts.unshift('#' + cur.id); break; }
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
      return isChapterTitle(a.textContent);
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
    let best = null;
    for (const [el, list] of score) {
      const total = el.querySelectorAll('a[href]').length;
      const ratio = list.length / Math.max(1, total);
      if (list.length < 4 || ratio < 0.65) continue;
      const s = list.length * ratio * (ratio >= 0.9 ? 1.2 : 1);
      if (!best || s > best.s) best = { el, list, s, ratio };
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
      chapters,
      rule: { chapterList: listSel, chapterName: nameRule, chapterUrl: 'a@href' },
      score: best.ratio
    };
  }

  /** 找正文：返回 { selector, paras, chars } */
  function autoContent(root) {
    const cands = [...root.querySelectorAll('div,article,section,td,main,pre')];
    let best = null, bestScore = 0;
    for (const el of cands) {
      const text = (el.textContent || '').replace(/\s+/g, '');
      if (text.length < 150) continue;
      let linkLen = 0;
      for (const a of el.querySelectorAll('a')) linkLen += (a.textContent || '').replace(/\s+/g, '').length;
      if (linkLen / text.length > 0.25) continue;
      const blocks = el.querySelectorAll('p,br').length;
      const score = text.length * (blocks >= 4 ? 1 : 0.55);
      if (score > bestScore) { bestScore = score; best = el; }
    }
    if (!best) return null;
    const paras = htmlToParas(best.innerHTML);
    if (paras.join('').length < 150) return null;
    return { selector: cssPath(best), paras, chars: paras.join('').length };
  }

  /** 从页面猜书名 / 作者 */
  function autoInfo(root) {
    const pick = (...sels) => {
      for (const s of sels) {
        const el = root.querySelector(s);
        const t = el && (el.textContent || '').trim();
        if (t && t.length < 60) return t;
      }
      return '';
    };
    let name = pick('h1', '.bookname h1', '.book-name', '#info h1', '.bookinfo h1');
    if (!name) {
      const t = (root.title || '').trim().split(/[_\-|｜–—]/)[0].trim();
      if (t && t.length < 40) name = t;
    }
    let author = '';
    const bodyText = (root.body ? root.body.textContent : '').replace(/\s+/g, ' ');
    const m = /作\s*者[：:]\s*([^\s|，,。]{1,16})/.exec(bodyText);
    if (m) author = m[1];
    if (!author) author = pick('.author', '#info p');
    return { name: name || '', author };
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

  /** 一次性分析页面 */
  function detectPage(html, baseUrl) {
    const root = doc(html);
    const info = autoInfo(root);
    const toc = autoToc(root, baseUrl);
    const content = autoContent(root);
    const serp = autoSerpLinks(root, baseUrl);
    /* 漫画：图片成片、文字很少 —— 详情页/阅读页都能识别，交给 UI 决定怎么加书架 */
    let comic = null;
    {
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
    const contentOut = content || (comic ? { selector: comic.selector, paras: [], chars: 0, comic: true } : null);
    return {
      info, toc, content: contentOut, comic,
      /* 搜索页用专用抽取：通用抽取拿到的是「整条结果」的锚文本，
         里面混着 cite 的域名，标题会变成 baidu.com 这种鬼东西 */
      links: serp.length >= 3 ? serp : sniffLinks(root, baseUrl),
      serp: serp.length >= 3,
      title: (root.title || '').trim()
    };
  }

  global.Engine = {
    normalizeSource, search, getToc, getContent,
    htmlToParas, htmlToParasRich, imgList, comicBestNode,
    evalRule, first, splitRule, absUrl, selectNodes, applyPost,
    detectPage, autoToc, autoContent, autoInfo, sniffLinks, cssPath, isChapterTitle,
    jsonQuery, jsonPathAll, contentScore, cleanParas
  };
})(window);
