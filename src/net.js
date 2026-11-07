'use strict';
/**
 * 网络层：绕过浏览器 CORS 抓取书源页面，处理重定向 / gzip / 字符编码
 */
const http = require('http');
const https = require('https');
const zlib = require('zlib');
const { URL } = require('url');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

function decompress(buf, encoding) {
  try {
    if (encoding === 'gzip') return zlib.gunzipSync(buf);
    if (encoding === 'deflate') return zlib.inflateSync(buf);
    if (encoding === 'br') return zlib.brotliDecompressSync(buf);
  } catch (e) { /* 交给上层按原文处理 */ }
  return buf;
}

function sniffCharset(buf, contentType) {
  if (contentType) {
    const m = /charset=["']?([\w-]+)/i.exec(contentType);
    if (m) return m[1].toLowerCase();
  }
  const head = buf.subarray(0, 4096).toString('latin1');
  let m = /<meta[^>]+charset=["']?([\w-]+)/i.exec(head);
  if (m) return m[1].toLowerCase();
  m = /content=["'][^"']*charset=([\w-]+)/i.exec(head);
  if (m) return m[1].toLowerCase();
  return null;
}

function decode(buf, charset) {
  const cs = (charset || '').toLowerCase();
  const alias = { gb2312: 'gb18030', gbk: 'gb18030', 'utf8': 'utf-8', big5: 'big5' };
  const enc = alias[cs] || cs || 'utf-8';
  try {
    return new TextDecoder(enc, { fatal: false }).decode(buf);
  } catch (e) {
    return new TextDecoder('utf-8', { fatal: false }).decode(buf);
  }
}

function isValidUtf8(buf) {
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(buf);
    return true;
  } catch (e) { return false; }
}

function request(url, opts, redirects = 0) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(url); } catch (e) { return reject(new Error('地址不合法: ' + url)); }
    if (!/^https?:$/.test(u.protocol)) return reject(new Error('仅支持 http/https'));

    const mod = u.protocol === 'https:' ? https : http;
    const headers = Object.assign({
      'User-Agent': UA,
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
      'Accept-Encoding': 'gzip, deflate'
    }, opts.headers || {});

    const req = mod.request({
      protocol: u.protocol, hostname: u.hostname, port: u.port,
      path: u.pathname + u.search, method: opts.method || 'GET', headers,
      timeout: opts.timeout || 18000,
      // 小说站证书过期/自签名极常见，允许降级（见 fetchText 的重试）
      rejectUnauthorized: opts.insecure ? false : undefined
    }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects < 6) {
        const next = new URL(res.headers.location, u).href;
        res.resume();
        return resolve(request(next, opts, redirects + 1));
      }
      const chunks = [];
      let size = 0;
      const limit = opts.maxBytes || 12 * 1024 * 1024;
      res.on('data', c => {
        size += c.length;
        if (size > limit) { req.destroy(); return; }
        chunks.push(c);
      });
      res.on('end', () => {
        let buf = Buffer.concat(chunks);
        buf = decompress(buf, (res.headers['content-encoding'] || '').toLowerCase());
        resolve({ status: res.statusCode, headers: res.headers, buffer: buf, url: u.href });
      });
    });

    req.on('timeout', () => { req.destroy(new Error('请求超时')); });
    req.on('error', reject);
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

/** 证书类错误：很多小说站证书过期/域名不匹配，重试时放宽校验 */
const CERT_ERR = /CERT_HAS_EXPIRED|CERT_NOT_YET_VALID|DEPTH_ZERO_SELF_SIGNED|SELF_SIGNED_CERT|UNABLE_TO_VERIFY_LEAF|UNABLE_TO_GET_ISSUER|ERR_TLS_CERT_ALTNAME|EPROTO|ERR_SSL/i;

async function fetchText(url, opts = {}) {
  const t0 = Date.now();
  let res;
  try {
    res = await request(url, opts);
  } catch (e) {
    if (!opts.insecure && CERT_ERR.test(String(e && (e.code || e.message)))) {
      res = await request(url, Object.assign({}, opts, { insecure: true }));
    } else {
      throw e;
    }
  }
  const ct = res.headers['content-type'] || '';
  let charset = opts.charset && opts.charset !== 'auto' ? opts.charset : sniffCharset(res.buffer, ct);
  if (!charset && !isValidUtf8(res.buffer)) charset = 'gb18030';
  const text = decode(res.buffer, charset || 'utf-8');
  return {
    status: res.status,
    url: res.url,
    charset: charset || 'utf-8',
    text,
    ms: Date.now() - t0
  };
}

/**
 * 取二进制（漫画页的图片）。
 * 为什么不直接让 <img src> 指远程地址：漫画站几乎都校验 Referer，
 * WebView/渲染进程直连会拿到 403 的占位图，白框一片；这里带着书源 headers 下回来，
 * 再以 data URL 交给阅读器，既不受防盗链也不受页面 CSP 限制。
 */
async function fetchBinary(url, opts = {}) {
  const t0 = Date.now();
  let res;
  try {
    res = await request(url, Object.assign({}, opts, { maxBytes: opts.maxBytes || 8 * 1024 * 1024 }));
  } catch (e) {
    if (!opts.insecure && CERT_ERR.test(String(e && (e.code || e.message)))) {
      res = await request(url, Object.assign({}, opts, { insecure: true, maxBytes: opts.maxBytes || 8 * 1024 * 1024 }));
    } else {
      throw e;
    }
  }
  const ct = String(res.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  /* 有些站把图片当 octet-stream 发，只能靠文件头猜 */
  const mime = /^image\//.test(ct) ? ct : sniffImageMime(res.buffer) || ct || 'application/octet-stream';
  return {
    status: res.status,
    url: res.url,
    mime,
    bytes: res.buffer.length,
    b64: res.buffer.toString('base64'),
    ms: Date.now() - t0
  };
}

/** 图片文件头识别（Content-Type 不靠谱时兜底） */
function sniffImageMime(buf) {
  if (!buf || buf.length < 12) return '';
  const b = buf;
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
  if (b[0] === 0xff && b[1] === 0xd8) return 'image/jpeg';
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return 'image/gif';
  if (b.slice(0, 4).toString('ascii') === 'RIFF' && b.slice(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  if (b[0] === 0x42 && b[1] === 0x4d) return 'image/bmp';
  return '';
}

module.exports = { fetchText, fetchBinary, request, decode };
