#!/usr/bin/env node
'use strict';
/**
 * 墨读 · 家庭服务网关（零依赖，Node >= 18）
 *
 * 一台小机器（如 OpenStick 随身 WiFi 棒）上的单进程服务：
 *   1. 托管墨读网页版 PWA 的静态文件（STATIC_DIR）
 *   2. 提供书源抓取代理 /fetch（网页版 PWA 与小程序共用）
 *
 * 接口
 *   GET /                -> 墨读网页版（STATIC_DIR 未设置时显示使用说明）
 *   GET /fetch?url=<encodeURIComponent>&charset=auto|gbk|utf-8&referer=<可选>
 *       默认 200 -> { status, body, finalUrl, charset, bytes, ms }
 *       加 &format=text 直接返回解码后的正文（网页版「书源代理地址」用这个）
 *       4xx -> { error, code } （401 口令不对 / 403 目标被拒绝 / 413 页面过大）
 *   GET /health -> { ok, version, tokenRequired, allowHosts, uptime, now }
 *   GET /usage  -> 纯文本使用说明
 *
 * 设备端存储（网页版存档落到这台机器上，家里任何设备打开都是同一份书架）
 *   GET    /api/fs/ping                     探活
 *   GET    /api/fs/list                     列出已落盘文件
 *   GET    /api/fs?path=/moread/data.json   读文件（响应头 X-Fs-Version）
 *   PUT    /api/fs?path=...&if=<version>    写文件（原子写；版本不符回 409，防别的设备被覆盖）
 *   DELETE /api/fs?path=...&if=<version>    删文件
 *   落盘位置：DATA_DIR（默认 ./data）
 *
 * 环境变量（都可选）
 *   PORT=8080            监听端口
 *   HOST=0.0.0.0         监听地址
 *   STATIC_DIR=./web     网页版静态文件目录；不设则只当代理用
 *   PROXY_TOKEN=xxx      /fetch 访问口令；强烈建议设置，否则局域网里谁都能拿它当免费代理
 *   ALLOW_HOSTS=a.com,b  只允许抓这些域名（含子域）；不设则允许任意公网站点
 *   ALLOW_PRIVATE=0      是否允许抓内网/本机地址，默认 0（防 SSRF）
 *   ALLOW_FAKEIP=0       设备装了 mihomo/Clash 时设 1，只放行 198.18/19 fake-ip 段
 *   TIMEOUT_MS=12000     单次请求超时
 *   MAX_BYTES=6291456    单页最大字节数
 *   RATE_N=180           RATE_WINDOW_MS 窗口内单 IP 最大请求数
 *   RATE_WINDOW_MS=10000 限流窗口
 *   MAX_REDIRECT=5       跳转跟随上限
 *   UA=...               自定义 User-Agent
 *
 * 直接跑：STATIC_DIR=./web node gateway.js
 */
const http = require('http');
const https = require('https');
const zlib = require('zlib');
const dns = require('dns');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const VERSION = '2.0.0';
const PORT = Number(process.env.PORT || 8080);
const HOST = process.env.HOST || '0.0.0.0';
const TOKEN = String(process.env.PROXY_TOKEN || '').trim();
const ALLOW_HOSTS = String(process.env.ALLOW_HOSTS || '')
  .split(',')
  .map(s => s.trim().toLowerCase())
  .filter(Boolean);
const ALLOW_PRIVATE = /^(1|true|yes)$/i.test(String(process.env.ALLOW_PRIVATE || ''));
/* 设备上装了 mihomo / Clash 时，dnsmasq 会把域名解析成 198.18.x.x 的 fake-ip，
   再由透明代理接管出站。这段不是真实内网，但默认会被下面的 SSRF 检查拦掉，
   结果所有在线书源都 403。设 ALLOW_FAKEIP=1 只放行这一段，其余私网照旧拒绝。 */
const ALLOW_FAKEIP = /^(1|true|yes)$/i.test(String(process.env.ALLOW_FAKEIP || ''));
const TIMEOUT = Number(process.env.TIMEOUT_MS || 12000);
const MAX_BYTES = Number(process.env.MAX_BYTES || 6 * 1024 * 1024);
const RATE_N = Number(process.env.RATE_N || 180);
const RATE_WINDOW_MS = Number(process.env.RATE_WINDOW_MS || 10000);
const MAX_REDIRECT = Number(process.env.MAX_REDIRECT || 5);
const QUIET = /^(1|true|yes)$/i.test(String(process.env.QUIET || ''));
const UA = process.env.UA ||
  'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Mobile Safari/537.36';

/* 静态站点根目录（必须存在且是目录才启用） */
const STATIC_DIR = (() => {
  const d = process.env.STATIC_DIR ? path.resolve(process.env.STATIC_DIR) : '';
  if (!d) return '';
  try {
    if (!fs.statSync(d).isDirectory()) { console.error('STATIC_DIR 不是目录：' + d); return ''; }
  } catch (e) { console.error('STATIC_DIR 不存在：' + d); return ''; }
  return d;
})();

const STARTED = Date.now();

/* ------------------------------------------------------------------ 设备端存储
 * 网页版的存档（/moread/data.json、/moread/books/*）默认只存在浏览器 IndexedDB 里，
 * 换设备 / 清缓存就没了。这里给它一个落盘的家：数据存在这台机器上，家里任何设备
 * 打开都读同一份。
 *
 *   GET    /api/fs/ping                    探活，前端据此决定走「设备存储」还是本地 IndexedDB
 *   GET    /api/fs/list                    列出已落盘的文件（只列允许的持久数据）
 *   GET    /api/fs?path=/moread/data.json  取文件，响应头带 X-Fs-Version
 *   PUT    /api/fs?path=...&if=<version>   写文件（原子写），版本不匹配回 409 防覆盖
 *   DELETE /api/fs?path=...&if=<version>   删文件
 *
 * 只允许 /moread/data.json 与 /moread/{books,covers,files}/ 下的文件：
 * 章节缓存（/moread/cache/*）和临时文件（/moread/tmp/*）留在浏览器本地，不占设备空间。
 */
const DATA_DIR = (() => {
  const d = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(__dirname, 'data');
  try { fs.mkdirSync(d, { recursive: true }); } catch (e) { console.error('DATA_DIR 建不了：' + e.message); }
  return d;
})();
const FS_MAX_BYTES = Number(process.env.FS_MAX_BYTES || 64 * 1024 * 1024);
const FS_DURABLE = /^\/moread\/(data\.json|books\/|covers\/|files\/)/;

/** 虚拟路径 → 真实路径；不合法返回 null（挡住 ../ 越权和缓存文件） */
function fsResolve(virtual) {
  const s = String(virtual || '');
  if (!s.startsWith('/moread/') || s.includes('\0') || s.length > 512) return null;
  const norm = path.posix.normalize(s);
  if (norm !== s) return null;                 // ../ 或重复斜杠一律拒绝
  if (!FS_DURABLE.test(norm)) return null;
  const real = path.join(DATA_DIR, norm);
  if (!real.startsWith(DATA_DIR + path.sep)) return null;
  return real;
}

function fsVersion(st) {
  return Math.round(st.mtimeMs).toString(36) + '-' + st.size.toString(36);
}

function fsStat(real) {
  try { const st = fs.statSync(real); return st.isFile() ? st : null; } catch (e) { return null; }
}

/** 递归列出持久文件 */
function fsWalk(dir, base, out) {
  let list;
  try { list = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
  for (const d of list) {
    const full = path.join(dir, d.name);
    const virt = (base + '/' + d.name).replace(/\/+/g, '/');
    if (d.isDirectory()) { if (!d.name.startsWith('.')) fsWalk(full, virt, out); continue; }
    if (!d.isFile() || !FS_DURABLE.test(virt)) continue;
    const st = fsStat(full);
    if (st) out.push({ path: virt, size: st.size, mtime: Math.round(st.mtimeMs), version: fsVersion(st) });
  }
}

function fsList() {
  const out = [];
  fsWalk(path.join(DATA_DIR, 'moread'), '/moread', out);
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', c => {
      size += c.length;
      if (size > limit) {
        reject(Object.assign(new Error('文件太大（上限 ' + Math.round(limit / 1048576) + ' MB）'), { code: 'ETOOBIG' }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function fsWrite(real, buf) {
  fs.mkdirSync(path.dirname(real), { recursive: true });
  const tmp = real + '.gw-tmp';
  fs.writeFileSync(tmp, buf);
  fs.renameSync(tmp, real);
}


/* 没有内置码表时用自带 GBK 表兜底（TextDecoder 在 small-icu 构建里没有 gbk） */
let gbkFallback = null;
try { gbkFallback = require('./gbk'); } catch (e) { gbkFallback = null; }

/* ------------------------------------------------------------------ 工具 */

function json(res, code, obj) {
  const body = Buffer.from(JSON.stringify(obj), 'utf8');
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*'
  });
  res.end(body);
}

function text(res, code, body) {
  const buf = Buffer.from(body, 'utf8');
  res.writeHead(code, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': buf.length,
    'Cache-Control': 'no-store'
  });
  res.end(buf);
}

function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  if (x.length !== y.length) return false;
  return crypto.timingSafeEqual(x, y);
}

/* 内网 / 保留地址判断，挡 SSRF：不能让这台机器被当成打内网的跳板 */
function isPrivateIp(raw) {
  let ip = String(raw || '').trim().toLowerCase();
  if (!ip) return true;
  if (ip.indexOf(':') >= 0) {
    if (ip === '::1' || ip === '::') return true;
    if (/^f[cd][0-9a-f]{2}:/.test(ip)) return true;        // fc00::/7
    if (/^fe[89ab][0-9a-f]:/.test(ip)) return true;        // fe80::/10
    const m = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(ip);
    if (!m) return false;                                   // 其它 IPv6 放行
    ip = m[1];
  }
  const p = ip.split('.').map(Number);
  if (p.length !== 4 || p.some(n => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  if (p[0] === 0 || p[0] === 10 || p[0] === 127) return true;
  if (p[0] === 169 && p[1] === 254) return true;            // 云元数据
  if (p[0] === 172 && p[1] >= 16 && p[1] <= 31) return true;
  if (p[0] === 192 && p[1] === 168) return true;
  if (p[0] === 100 && p[1] >= 64 && p[1] <= 127) return true;
  if (p[0] === 198 && (p[1] === 18 || p[1] === 19)) return !ALLOW_FAKEIP;   // mihomo fake-ip
  if (p[0] >= 224) return true;                             // 组播 / 保留
  return false;
}

/* 域名白名单（含子域） */
function hostAllowed(hostname) {
  if (!ALLOW_HOSTS.length) return true;
  const h = String(hostname || '').toLowerCase().replace(/\.$/, '');
  return ALLOW_HOSTS.some(a => h === a || h.endsWith('.' + a));
}

/* 交给 http.request 的自定义 lookup：解析后先查私网，避免 DNS 重绑定绕过。
   Node 18+ 的 http.request 可能开启 autoSelectFamily（Happy Eyeballs），此时
   options.all 为真、要求回调返回地址数组；普通模式则返回单个 address/family。 */
function guardedLookup(hostname, options, cb) {
  const wantAll = !!(options && options.all);
  dns.lookup(hostname, { all: true, family: options && options.family ? options.family : 0 }, (err, addrs) => {
    if (err) return cb(err);
    const list = Array.isArray(addrs) ? addrs : [];
    if (!list.length) return cb(new Error('域名解析为空'));
    if (!ALLOW_PRIVATE) {
      const bad = list.filter(a => isPrivateIp(a.address))[0];
      if (bad) {
        const e = new Error('目标解析到内网地址（' + bad.address + '），已拒绝');
        e.code = 'EPRIVATE';
        return cb(e);
      }
    }
    if (wantAll) {
      cb(null, list.map(a => ({ address: a.address, family: a.family })));
    } else {
      cb(null, list[0].address, list[0].family);
    }
  });
}

/* charset 归一：声明成 gb2312 的站点实际多半是 GBK，统一按 gb18030 解 */
const CS_ALIAS = {
  gb2312: 'gb18030', gbk: 'gb18030', 'x-gbk': 'gb18030', gb18030: 'gb18030',
  utf8: 'utf-8', 'utf-8': 'utf-8', big5: 'big5', 'big5-hkscs': 'big5',
  'utf-16': 'utf-16le', 'utf-16le': 'utf-16le', 'utf-16be': 'utf-16be',
  'iso-8859-1': 'windows-1252', latin1: 'windows-1252'
};

function normCharset(cs) {
  const k = String(cs || '').toLowerCase().trim();
  return CS_ALIAS[k] || k;
}

function looksUtf8(buf) {
  const n = Math.min(buf.length, 4096);
  let i = 0;
  let multibyte = 0;
  while (i < n) {
    const b = buf[i];
    if (b < 0x80) { i++; continue; }
    let need = 0;
    if (b >= 0xc2 && b <= 0xdf) need = 1;
    else if (b >= 0xe0 && b <= 0xef) need = 2;
    else if (b >= 0xf0 && b <= 0xf4) need = 3;
    else return false;
    if (i + need >= n) break;
    for (let k = 1; k <= need; k++) {
      if ((buf[i + k] & 0xc0) !== 0x80) return false;
    }
    multibyte++;
    i += need + 1;
  }
  return multibyte > 0;
}

function pickCharset(headers, buf, want) {
  const explicit = String(want || '').toLowerCase();
  if (explicit && explicit !== 'auto') return normCharset(explicit);
  const ct = String((headers && headers['content-type']) || '');
  const m = /charset\s*=\s*["']?([\w-]+)/i.exec(ct);
  if (m) return normCharset(m[1]);
  const head = buf.slice(0, 2048).toString('latin1');
  const m2 = /charset\s*=\s*["']?([\w-]+)/i.exec(head);
  if (m2) return normCharset(m2[1]);
  if (looksUtf8(buf)) return 'utf-8';
  return 'gb18030';   // 中文站没有声明时，GBK 比 UTF-8 更可能
}

function decodeBody(buf, charset) {
  const cs = normCharset(charset);
  try {
    return new TextDecoder(cs, { fatal: false }).decode(buf);
  } catch (e) {
    if (/^gb/.test(cs) && gbkFallback && gbkFallback.decodeGbk) {
      return gbkFallback.decodeGbk(buf).text;
    }
    try { return new TextDecoder('utf-8').decode(buf); } catch (e2) { return buf.toString('utf8'); }
  }
}

/* ------------------------------------------------------------------ 抓取 */

/* 书源一次打开要连打 3~5 个请求（详情/目录/正文/预取），
   每次都重新做 TLS 握手会白白多花 100~300ms。复用连接。 */
const httpAgent = new http.Agent({ keepAlive: true, maxSockets: 8, keepAliveMsecs: 30000 });
const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 8, keepAliveMsecs: 30000 });

function requestOnce(target, opts, depth) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(target); } catch (e) { reject(new Error('地址不合法')); return; }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') {
      reject(new Error('只支持 http / https'));
      return;
    }
    if (!hostAllowed(u.hostname)) {
      const e = new Error('域名不在 ALLOW_HOSTS 白名单：' + u.hostname);
      e.code = 'EHOST';
      reject(e);
      return;
    }
    /* 直接写 IP 时 Node 不会走 lookup，得单独拦一次，否则 SSRF 防护形同虚设 */
    if (!ALLOW_PRIVATE) {
      const raw = u.hostname.replace(/^\[|\]$/g, '');
      const isLiteral = /^[\d.]+$/.test(raw) || raw.indexOf(':') >= 0;
      if (isLiteral && isPrivateIp(raw)) {
        const e = new Error('目标解析到内网地址（' + raw + '），已拒绝');
        e.code = 'EPRIVATE';
        reject(e);
        return;
      }
    }

    const mod = u.protocol === 'https:' ? https : http;
    const headers = {
      'User-Agent': UA,
      'Accept': 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8',
      'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.5',
      'Accept-Encoding': 'gzip, deflate, br'
    };
    if (opts.referer) headers.Referer = opts.referer;
    /* 高级书源（jsLib + 签名）要自带请求头：只做透传，仍然受域名/内网校验约束 */
    if (opts.headers && typeof opts.headers === 'object') {
      for (const k of Object.keys(opts.headers)) {
        if (!k || /^(host|content-length|connection)$/i.test(k)) continue;
        const v = opts.headers[k];
        if (v == null) continue;
        headers[k] = String(v);
      }
    }

    const req = mod.request({
      protocol: u.protocol,
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search,
      method: 'GET',
      headers,
      agent: u.protocol === 'https:' ? httpsAgent : httpAgent,
      lookup: ALLOW_PRIVATE ? undefined : guardedLookup,
      timeout: TIMEOUT,
      servername: u.hostname
    }, res => {
      const code = res.statusCode || 0;
      const loc = res.headers.location;
      if (code >= 300 && code < 400 && loc && depth > 0) {
        res.resume();
        let next;
        try { next = new URL(loc, target).href; } catch (e) { reject(new Error('跳转地址不合法')); return; }
        resolve(requestOnce(next, opts, depth - 1));
        return;
      }
      if (code >= 300 && code < 400 && loc) {
        res.resume();
        reject(new Error('跳转次数过多'));
        return;
      }

      let size = 0;
      const chunks = [];
      res.on('data', c => {
        size += c.length;
        if (size > MAX_BYTES) {
          req.destroy();
          const e = new Error('页面超过 ' + Math.round(MAX_BYTES / 1024) + 'KB 上限');
          e.code = 'ETOOBIG';
          reject(e);
          return;
        }
        chunks.push(c);
      });
      res.on('aborted', () => {
        const e = new Error('连接被中断');
        reject(e);
      });
      res.on('end', () => {
        let buf = Buffer.concat(chunks);
        const enc = String(res.headers['content-encoding'] || '').toLowerCase();
        try {
          if (enc === 'gzip') buf = zlib.gunzipSync(buf);
          else if (enc === 'deflate') buf = zlib.inflateSync(buf);
          else if (enc === 'br') buf = zlib.brotliDecompressSync(buf);
        } catch (e) { /* 站点声明和实际编码不一致时按原字节走 */ }
        const charset = pickCharset(res.headers, buf, opts.charset);
        resolve({
          status: code,
          body: decodeBody(buf, charset),
          finalUrl: target,
          charset,
          bytes: buf.length
        });
      });
    });

    req.on('timeout', () => {
      req.destroy();
      const e = new Error('请求超时（' + Math.round(TIMEOUT / 1000) + ' 秒）');
      e.code = 'ETIMEDOUT';
      reject(e);
    });
    req.on('error', e => {
      if (e && e.code === 'EPRIVATE') { reject(e); return; }
      reject(new Error(e && e.message ? e.message : '网络错误'));
    });
    req.end();
  });
}

/* ------------------------------------------------------------------ 限流 */

const hits = new Map();

function rateLimited(ip) {
  const now = Date.now();
  const win = hits.get(ip);
  if (!win || now - win.at > RATE_WINDOW_MS) {
    hits.set(ip, { at: now, n: 1 });
    return false;
  }
  win.n++;
  return win.n > RATE_N;
}

setInterval(() => {
  const now = Date.now();
  for (const [ip, w] of hits) if (now - w.at > RATE_WINDOW_MS * 6) hits.delete(ip);
}, 60000).unref();

/* ------------------------------------------------------------------ 静态站点 */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm'
};

/* 网页脚本/样式没有内容指纹，绝不能长缓存。
   以前 app.js / bridge.js 返回 max-age=604800，服务端换了新的前端文件，
   用户浏览器刷新时仍直接用 7 天前的旧脚本，看起来就是「修了完全没效果」。
   这些文件改成每次回来校验（配 ETag，命中只回 304，几乎不耗流量）；
   图标之类不会随版本改名的资源才保留长缓存。 */
function cacheControl(file) {
  const ext = path.extname(file).toLowerCase();
  if (/\.(html|js|css|json|webmanifest|map)$/.test(ext)) return 'no-cache';
  return 'public, max-age=604800';
}

/* 网关自己托管网页版时，往 index.html 里注入「默认代理 = 本站 /fetch」。
   这样手机第一次打开就能在线搜书，不用再手工填地址；把 dist-web 静态托管到
   GitHub Pages 之类的地方时不会被注入，网页版仍保持「默认不发请求」。
   用 format=text：网页端要的是原始 HTML 字节，不是 JSON 包装。 */
const PROXY_META = '<meta name="moread-proxy" content="/fetch?format=text">';

/* 网页版把「书源要求的请求头」用 base64url(JSON) 放在 h 参数里传进来 */
function decodeHeaderParam(v) {
  if (!v) return {};
  try {
    const b = Buffer.from(String(v).replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
    const j = JSON.parse(b);
    return j && typeof j === 'object' ? j : {};
  } catch (e) { return {}; }
}

/* 内容指纹缓存：同一份文件只算一次 md5，改动（mtime/size 变化）自动重算 */
const ASSET_HASH = new Map();
function assetHash(rel) {
  const clean = String(rel).split(/[?#]/)[0].replace(/^\.?\//, '')
    .split('/').filter(p => p && p !== '.' && p !== '..').join('/');
  if (!clean) return '';
  const file = path.join(STATIC_DIR, clean);
  let st;
  try { st = fs.statSync(file); } catch (e) { return ''; }
  const hit = ASSET_HASH.get(file);
  if (hit && hit.mtime === st.mtimeMs && hit.size === st.size) return hit.hash;
  let hash = '';
  try { hash = crypto.createHash('md5').update(fs.readFileSync(file)).digest('hex').slice(0, 10); }
  catch (e) { return ''; }
  ASSET_HASH.set(file, { mtime: st.mtimeMs, size: st.size, hash });
  return hash;
}
function versionedUrl(url) {
  const raw = String(url || '');
  if (!raw || /^([a-z]+:|\/\/|#|data:)/i.test(raw) || /[?#]/.test(raw)) return raw;
  const clean = raw.replace(/^\.?\//, '');
  if (!/\.(js|css|webmanifest|png|jpe?g|ico|svg|woff2?)$/i.test(clean)) return raw;
  if (/(^|\/)sw\.js$/i.test(clean)) return raw;   // SW 脚本 URL 保持不变
  const h = assetHash(clean);
  return h ? raw + '?v=' + h : raw;
}

/* 注入默认代理 + 给本地脚本/样式加内容版本。
   老浏览器里可能还压着「max-age=604800」的旧 app.js，光改响应头它不会主动来问；
   换成带指纹的新 URL，刷新就必然拉到最新文件，用户不用手动清缓存。 */
function decorateHtml(data) {
  let html = data.toString('utf8');
  if (html.indexOf('name="moread-proxy"') < 0) {
    html = html.replace(/<\/head>/i, '  ' + PROXY_META + '\n</head>');
  }
  html = html.replace(/\b(src|href)\s*=\s*(["'])([^"']+)\2/gi,
    (m, attr, q, url) => attr + '=' + q + versionedUrl(url) + q);
  html = html.replace(/\bload\(\s*(["'])([^"']+\.js)\1/gi,
    (m, q, url) => 'load(' + q + versionedUrl(url) + q);
  return Buffer.from(html, 'utf8');
}

function serveFile(res, file, req) {
  let data;
  try { data = fs.readFileSync(file); } catch (e) { return false; }
  if (path.basename(file).toLowerCase() === 'index.html') data = decorateHtml(data);
  const cc = cacheControl(file);
  // 内容指纹：文件没变就 304，变了立刻回新内容，刷新一定能拿到最新版
  const etag = '"' + crypto.createHash('md5').update(data).digest('hex').slice(0, 16) + '"';
  if (req && req.headers['if-none-match'] === etag) {
    res.writeHead(304, { 'ETag': etag, 'Cache-Control': cc });
    res.end();
    return true;
  }
  res.writeHead(200, {
    'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
    'Content-Length': data.length,
    'Cache-Control': cc,
    'ETag': etag
  });
  res.end(data);
  return true;
}

/* 只允许 STATIC_DIR 内的相对路径，挡目录穿越 */
function resolveStatic(urlPath) {
  const rel = decodeURIComponent(String(urlPath || '/'))
    .split('/')
    .filter(p => p && p !== '.' && p !== '..')
    .join('/');
  return rel ? path.join(STATIC_DIR, rel) : path.join(STATIC_DIR, 'index.html');
}

function serveStatic(req, res, pathname) {
  let file = resolveStatic(pathname);
  let st = null;
  try { st = fs.statSync(file); } catch (e) { st = null; }
  if (st && st.isDirectory()) file = path.join(file, 'index.html');
  if (serveFile(res, file, req)) return true;
  /* SPA 兜底：无扩展名的未知路径回 index.html，前端路由接管 */
  if (!path.extname(pathname)) {
    return serveFile(res, path.join(STATIC_DIR, 'index.html'), req);
  }
  return false;
}

/* ------------------------------------------------------------------ 路由 */

function clientIp(req) {
  const fwd = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  if (fwd && /^[\d.:a-fA-F]+$/.test(fwd)) return fwd;
  return req.socket.remoteAddress || '-';
}

function authOk(req, q) {
  if (!TOKEN) return true;
  const t = q.get('token') || req.headers['x-proxy-token'] || '';
  return safeEqual(t, TOKEN);
}

const USAGE = [
  '墨读家庭服务网关 v' + VERSION,
  '',
  '网页：GET /                （配置 STATIC_DIR 后托管墨读网页版）',
  '取页：GET /fetch?url=<encodeURIComponent(目标地址)>&charset=auto',
  '原文：GET /fetch?format=text&url=...   直接返回解码后的正文',
  '口令：加 &token=你的PROXY_TOKEN，或请求头 x-proxy-token',
  '探活：GET /health',
  '',
  '数据：网页版书架/书源存在这台机器上（' + DATA_DIR + '）',
  '  列出：GET /api/fs/list',
  '  读取：GET /api/fs?path=/moread/data.json',
  '  写入：PUT /api/fs?path=/moread/data.json&if=<版本号>',
  '',
  '墨读网页版「设置 → 书源代理地址」填：',
  '  http://这台机器的地址/fetch?format=text' + (TOKEN ? '&token=你的口令' : ''),
  '小程序「设置 → 网络 → 代理地址」填：',
  '  http://这台机器的地址/fetch' + (TOKEN ? '（口令填同一个）' : '')
].join('\n');

/* 设备端存储接口：处理完返回 true，调用方直接 return */
function fsApi(req, res, url, pathName) {
  if (pathName === '/api/fs/ping') {
    const files = fsList();
    json(res, 200, {
      ok: true, mode: 'device', root: DATA_DIR, maxBytes: FS_MAX_BYTES,
      count: files.length, bytes: files.reduce((n, f) => n + f.size, 0)
    });
    return true;
  }

  if (pathName === '/api/fs/list') {
    const files = fsList();
    json(res, 200, { ok: true, files, total: files.reduce((n, f) => n + f.size, 0) });
    return true;
  }

  const virtual = url.searchParams.get('path') || '';
  const real = fsResolve(virtual);
  if (!real) {
    json(res, 400, { error: '路径不合法：只支持 /moread/data.json 和 /moread/{books,covers,files} 下的文件' });
    return true;
  }

  if (req.method === 'GET') {
    const st = fsStat(real);
    if (!st) { json(res, 404, { error: '文件不存在', path: virtual }); return true; }
    res.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Content-Length': st.size,
      'Cache-Control': 'no-store',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Expose-Headers': 'X-Fs-Version, X-Fs-Mtime',
      'X-Fs-Version': fsVersion(st),
      'X-Fs-Mtime': String(Math.round(st.mtimeMs))
    });
    fs.createReadStream(real).pipe(res);
    return true;
  }

  if (req.method === 'PUT') {
    const expect = url.searchParams.get('if') || req.headers['if-match'] || '';
    readBody(req, FS_MAX_BYTES).then(buf => {
      const st = fsStat(real);
      const cur = st ? fsVersion(st) : '';
      /* 版本对不上说明别的设备刚写过：宁可拒绝，也不静默覆盖别人的书架 */
      if (expect && expect !== cur) {
        json(res, 409, { error: '文件已被其他设备改动过', version: cur, path: virtual });
        return;
      }
      fsWrite(real, buf);
      const after = fsStat(real);
      json(res, 200, { ok: true, version: after ? fsVersion(after) : '', size: buf.length, path: virtual });
      if (!QUIET) console.log('[fs] ' + virtual + ' ← ' + buf.length + ' B');
    }).catch(e => {
      json(res, e.code === 'ETOOBIG' ? 413 : 500, { error: String(e.message || e) });
    });
    return true;
  }

  if (req.method === 'DELETE') {
    const expect = url.searchParams.get('if') || '';
    const st = fsStat(real);
    if (!st) { json(res, 200, { ok: true, deleted: false }); return true; }
    if (expect && expect !== fsVersion(st)) {
      json(res, 409, { error: '文件已被其他设备改动过', version: fsVersion(st), path: virtual });
      return true;
    }
    try { fs.unlinkSync(real); } catch (e) { /* 已经没了也算成功 */ }
    json(res, 200, { ok: true, deleted: true });
    return true;
  }

  json(res, 405, { error: '不支持的方法' });
  return true;
}

const server = http.createServer((req, res) => {
  const started = Date.now();
  let url;
  try { url = new URL(req.url, 'http://localhost'); } catch (e) { text(res, 400, 'bad request'); return; }
  const rawPath = url.pathname;
  const pathName = rawPath.replace(/\/+$/, '') || '/';

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'x-proxy-token, content-type, if-match',
      'Access-Control-Allow-Methods': 'GET, PUT, DELETE, OPTIONS'
    });
    res.end();
    return;
  }

  /* 设备端存储（网页版数据落盘）——放在 GET 校验之前，因为要用 PUT / DELETE */
  if (pathName === '/api/fs' || pathName === '/api/fs/ping' || pathName === '/api/fs/list') {
    if (fsApi(req, res, url, pathName)) return;
  }

  if (req.method !== 'GET') {
    json(res, 405, { error: '只支持 GET' });
    return;
  }

  if (pathName === '/usage') {
    text(res, 200, USAGE);
    return;
  }

  if (pathName === '/health') {
    /* 带了口令就顺手校验，方便「测试连接」一眼看出口令对不对；不带只报状态 */
    const given = url.searchParams.get('token') || req.headers['x-proxy-token'] || '';
    if (TOKEN && given && !authOk(req, url.searchParams)) {
      json(res, 401, { error: '访问口令不正确（检查设置里的「访问口令」）', code: 'EAUTH' });
      return;
    }
    json(res, 200, {
      ok: true,
      version: VERSION,
      tokenRequired: !!TOKEN,
      allowHosts: ALLOW_HOSTS,
      allowPrivate: ALLOW_PRIVATE,
      static: !!STATIC_DIR,
      uptime: Math.round((Date.now() - STARTED) / 1000),
      now: new Date().toISOString()
    });
    return;
  }

  if (pathName === '/fetch') {
    const ip = clientIp(req);
    if (rateLimited(ip)) {
      json(res, 429, { error: '请求太频繁，稍后再试' });
      return;
    }
    if (!authOk(req, url.searchParams)) {
      json(res, 401, { error: '访问口令不正确（检查设置里的「访问口令」）', code: 'EAUTH' });
      return;
    }

    const target = url.searchParams.get('url') || '';
    if (!target) {
      json(res, 400, { error: '缺少 url 参数' });
      return;
    }
    if (target.length > 4096) {
      json(res, 414, { error: 'url 太长' });
      return;
    }

    /* 网页版 PWA 的约定是「?url= 直接给原文」，小程序要的是 JSON 包裹 */
    const raw = /^(text|raw|1|true)$/i.test(String(url.searchParams.get('format') || ''));

    requestOnce(target, {
      charset: url.searchParams.get('charset') || 'auto',
      referer: url.searchParams.get('referer') || '',
      headers: decodeHeaderParam(url.searchParams.get('h') || '')
    }, MAX_REDIRECT).then(r => {
      if (raw) {
        const buf = Buffer.from(r.body, 'utf8');
        res.writeHead(r.status || 200, {
          'Content-Type': 'text/plain; charset=utf-8',
          'Content-Length': buf.length,
          'Cache-Control': 'no-store',
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Expose-Headers': 'X-Final-Url, X-Charset',
          'X-Final-Url': encodeURI(r.finalUrl),
          'X-Charset': r.charset
        });
        res.end(buf);
      } else {
        json(res, 200, Object.assign(r, { ms: Date.now() - started }));
      }
      log(ip, 200, target, started, r.bytes);
    }).catch(e => {
      const code = e.code === 'ETOOBIG' ? 413 : e.code === 'EHOST' || e.code === 'EPRIVATE' ? 403 : 502;
      if (raw) {
        text(res, code, String(e.message || e));
      } else {
        json(res, code, { error: String(e.message || e), code: e.code || 'EFAIL' });
      }
      log(ip, code, target, started, 0);
    });
    return;
  }

  /* 其余路径交给静态站点；没有配置 STATIC_DIR 时给出使用说明 */
  if (STATIC_DIR) {
    if (serveStatic(req, res, rawPath)) {
      log(clientIp(req), 200, 'static:' + rawPath, started, 0);
      return;
    }
    json(res, 404, { error: '文件不存在' });
    return;
  }
  if (pathName === '/' ) {
    text(res, 200, USAGE);
    return;
  }
  json(res, 404, { error: '未知路径，取页请用 /fetch' });
});

function log(ip, code, target, started, bytes) {
  if (QUIET) return;
  let host = target;
  if (!/^static:/.test(target)) {
    try { host = new URL(target).host; } catch (e) { host = '-'; }
  }
  console.log(
    new Date().toISOString().slice(11, 19),
    ip,
    code,
    host,
    (Date.now() - started) + 'ms',
    bytes ? Math.round(bytes / 1024) + 'KB' : ''
  );
}

server.on('clientError', (err, socket) => {
  try { socket.destroy(); } catch (e) { /* ignore */ }
});

if (require.main === module) {
  server.listen(PORT, HOST, () => {
    console.log('墨读网关已启动 http://' + HOST + ':' + PORT);
    console.log('  静态站点：' + (STATIC_DIR || '未配置（仅代理模式）'));
    console.log('  书源代理：/fetch（口令：' + (TOKEN ? '已启用' : '未设置，局域网也建议设 PROXY_TOKEN') + '）');
    console.log('  白名单：' + (ALLOW_HOSTS.length ? ALLOW_HOSTS.join(', ') : '不限（任意公网站点）'));
    console.log('  内网目标：' + (ALLOW_PRIVATE ? '允许' : '拒绝')
      + (ALLOW_FAKEIP ? '（mihomo fake-ip 198.18/19 已放行）' : ''));
  });
  const stop = () => {
    console.log('\n正在停止…');
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

module.exports = { server, requestOnce, isPrivateIp, decodeBody, pickCharset, VERSION };
