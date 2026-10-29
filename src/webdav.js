'use strict';
/**
 * 极简 WebDAV 客户端（坚果云 / Nextcloud / 群晖 等通用）
 * 支持：PROPFIND 列目录、MKCOL 建目录、PUT 上传、GET 下载、DELETE 删除、HEAD 探测
 * 认证：HTTP Basic（坚果云用「邮箱 + 应用密码」）
 */
const http = require('http');
const https = require('https');
const { URL } = require('url');
const zlib = require('zlib');

const TIMEOUT = 25000;

function basicAuth(user, pass) {
  return 'Basic ' + Buffer.from(String(user || '') + ':' + String(pass || ''), 'utf8').toString('base64');
}

/** 逐段编码路径，保留已有的百分号编码 */
function encodePath(p) {
  return String(p).split('/').map(seg => {
    if (!seg) return seg;
    if (/%[0-9A-Fa-f]{2}/.test(seg)) return seg;
    return encodeURIComponent(seg).replace(/'/g, '%27');
  }).join('/');
}

function joinUrl(base, name) {
  return String(base).replace(/\/+$/, '') + '/' + encodePath(name);
}

function request(cfg, method, url, opts = {}) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(url); } catch (e) { return reject(new Error('地址不合法：' + url)); }
    if (!/^https?:$/.test(u.protocol)) return reject(new Error('仅支持 http/https'));

    const mod = u.protocol === 'https:' ? https : http;
    const headers = Object.assign({
      'Authorization': basicAuth(cfg.user, cfg.pass),
      'User-Agent': 'MoRead/2.0 (WebDAV)',
      'Accept': '*/*',
      'Accept-Encoding': 'gzip, deflate'
    }, opts.headers || {});
    if (opts.body) headers['Content-Length'] = Buffer.byteLength(opts.body);

    const req = mod.request({
      protocol: u.protocol, hostname: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search, method, headers, timeout: opts.timeout || TIMEOUT,
      rejectUnauthorized: true
    }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && (opts.redirects || 0) < 5) {
        const next = new URL(res.headers.location, u).href;
        res.resume();
        return resolve(request(cfg, method, next, Object.assign({}, opts, { redirects: (opts.redirects || 0) + 1 })));
      }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        let buf = Buffer.concat(chunks);
        const enc = (res.headers['content-encoding'] || '').toLowerCase();
        try {
          if (enc === 'gzip') buf = zlib.gunzipSync(buf);
          else if (enc === 'deflate') buf = zlib.inflateSync(buf);
        } catch (e) { /* 保留原样 */ }
        resolve({ status: res.statusCode, headers: res.headers, buffer: buf, url: u.href });
      });
    });
    req.on('timeout', () => req.destroy(new Error('连接超时，检查网络或服务器地址')));
    req.on('error', e => reject(new Error(friendlyNetError(e))));
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

function friendlyNetError(e) {
  const m = String((e && e.message) || e);
  if (/ENOTFOUND|EAI_AGAIN/.test(m)) return '找不到服务器，检查地址是否写对（如 https://dav.jianguoyun.com/dav/）';
  if (/ECONNREFUSED/.test(m)) return '服务器拒绝连接';
  if (/CERT|certificate|self.signed/i.test(m)) return '证书校验失败，确认地址是 https 且证书有效';
  return m;
}

function statusError(status) {
  const map = {
    401: '账号或密码不对（坚果云要用「应用密码」，不是登录密码）',
    403: '没有权限，或路径不允许该操作',
    404: '路径不存在，检查远程目录',
    405: '服务器不支持该操作',
    409: '目标目录不存在（有些服务器要求先建目录）',
    423: '文件被锁定',
    507: '云端空间不足'
  };
  return new Error(map[status] || ('服务器返回 ' + status));
}

function unescapeXml(s) {
  return String(s).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, d) => String.fromCharCode(+d))
    .replace(/&amp;/g, '&');
}

function decodeHref(href) {
  try { return decodeURIComponent(href); } catch (e) { return href; }
}

/** 解析 207 Multi-Status */
function parseMultiStatus(xml, baseUrl) {
  const out = [];
  const blocks = String(xml || '').match(/<(?:[\w-]+:)?response\b[\s\S]*?<\/(?:[\w-]+:)?response>/gi) || [];
  for (const b of blocks) {
    const hrefM = /<(?:[\w-]+:)?href[^>]*>([\s\S]*?)<\/(?:[\w-]+:)?href>/i.exec(b);
    if (!hrefM) continue;
    const href = unescapeXml(hrefM[1].trim());
    const isDir = /<(?:[\w-]+:)?collection\s*\/?>/i.test(b);
    const size = /<(?:[\w-]+:)?getcontentlength[^>]*>(\d+)/i.exec(b);
    const mod = /<(?:[\w-]+:)?getlastmodified[^>]*>([^<]+)/i.exec(b);
    const base = new URL(baseUrl);
    let path = href;
    try { path = new URL(href, base).pathname; } catch (e) { /* keep */ }
    const name = decodeHref(path.replace(/\/+$/, '').split('/').pop() || '');
    out.push({
      href, name, isDir,
      size: size ? +size[1] : 0,
      lastmod: mod ? new Date(unescapeXml(mod[1])).getTime() || 0 : 0,
      mtime: mod ? unescapeXml(mod[1]) : ''
    });
  }
  return out;
}

const PROPFIND_BODY =
  '<?xml version="1.0" encoding="utf-8"?>' +
  '<d:propfind xmlns:d="DAV:"><d:prop>' +
  '<d:displayname/><d:getcontentlength/><d:getlastmodified/><d:resourcetype/>' +
  '</d:prop></d:propfind>';

/** 列目录（Depth:1），返回不含自身的条目 */
async function list(cfg, dirUrl) {
  const url = String(dirUrl).replace(/\/+$/, '') + '/';
  const r = await request(cfg, 'PROPFIND', url, {
    headers: { Depth: '1', 'Content-Type': 'application/xml; charset=utf-8' },
    body: PROPFIND_BODY
  });
  if (r.status === 401) throw statusError(401);
  if (r.status === 404) throw statusError(404);
  if (r.status !== 207 && r.status !== 200) throw statusError(r.status);
  const all = parseMultiStatus(r.buffer.toString('utf8'), url);
  const selfPath = new URL(url).pathname.replace(/\/+$/, '');
  return all.filter(e => {
    let p = e.href;
    try { p = new URL(e.href, url).pathname; } catch (err) { /* keep */ }
    return p.replace(/\/+$/, '') !== selfPath;
  });
}

async function mkcol(cfg, dirUrl) {
  const url = String(dirUrl).replace(/\/+$/, '') + '/';
  const r = await request(cfg, 'MKCOL', url, { headers: { 'Content-Type': 'application/xml; charset=utf-8' } });
  if (r.status === 201 || r.status === 200) return true;
  if (r.status === 405 || r.status === 301 || r.status === 302) return true; // 已存在
  if (r.status === 401) throw statusError(401);
  if (r.status === 409) throw statusError(409);
  throw statusError(r.status);
}

/** 递归创建目录（相对 base） */
async function ensureDir(cfg, baseUrl, rel) {
  const segs = String(rel || '').split('/').filter(Boolean);
  let cur = String(baseUrl).replace(/\/+$/, '');
  for (const s of segs) {
    cur = joinUrl(cur, s);
    await mkcol(cfg, cur);
  }
  return cur;
}

async function put(cfg, fileUrl, buffer, contentType) {
  const r = await request(cfg, 'PUT', fileUrl, {
    headers: { 'Content-Type': contentType || 'application/octet-stream' },
    body: buffer,
    timeout: 120000
  });
  if ([200, 201, 204, 207, 302].includes(r.status)) return true;
  if (r.status === 401 || r.status === 403 || r.status === 409 || r.status === 507) throw statusError(r.status);
  throw statusError(r.status);
}

async function get(cfg, fileUrl) {
  const r = await request(cfg, 'GET', fileUrl, { timeout: 120000 });
  if (r.status === 200) return r.buffer;
  if (r.status === 401 || r.status === 404 || r.status === 403) throw statusError(r.status);
  throw statusError(r.status);
}

async function del(cfg, fileUrl) {
  const r = await request(cfg, 'DELETE', fileUrl);
  if ([200, 204, 404].includes(r.status)) return true;
  if (r.status === 401 || r.status === 403) throw statusError(r.status);
  throw statusError(r.status);
}

async function stat(cfg, url) {
  const r = await request(cfg, 'PROPFIND', url, {
    headers: { Depth: '0', 'Content-Type': 'application/xml; charset=utf-8' },
    body: PROPFIND_BODY
  });
  if (r.status === 401) throw statusError(401);
  if (r.status !== 207 && r.status !== 200) return null;
  const list0 = parseMultiStatus(r.buffer.toString('utf8'), url);
  return list0[0] || null;
}

/** 连接测试：先探测根目录，再列配置目录 */
async function test(cfg) {
  const t0 = Date.now();
  const base = String(cfg.url || '').replace(/\/+$/, '') + '/';
  const r = await request(cfg, 'PROPFIND', base, {
    headers: { Depth: '0', 'Content-Type': 'application/xml; charset=utf-8' },
    body: PROPFIND_BODY
  });
  if (r.status === 401) throw statusError(401);
  if (r.status !== 207 && r.status !== 200 && r.status !== 301 && r.status !== 302) throw statusError(r.status);
  let items = [];
  if (cfg.dir) {
    try { items = await list(cfg, joinUrl(base, cfg.dir)); } catch (e) { items = []; }
  }
  return { ok: true, ms: Date.now() - t0, items };
}

module.exports = { test, list, mkcol, ensureDir, put, get, del, stat, joinUrl, encodePath };
