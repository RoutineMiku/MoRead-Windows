// 墨读网页版 Node 兼容层（由 build/gen-web.js 生成，勿手改）
// 内联模块：zip net webdav legado parse store
(function(){window.__MOREAD_MODULES__ = {"zip":"'use strict';\n/**\n * 极简 zip 读取器（仅解压，够解析 EPUB 用）\n * 支持 method 0(store) / 8(deflate)\n */\nconst zlib = require('zlib');\n\nfunction readZip(buf) {\n  let eocd = -1;\n  const min = Math.max(0, buf.length - 65558);\n  for (let i = buf.length - 22; i >= min; i--) {\n    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }\n  }\n  if (eocd < 0) throw new Error('不是有效的 ZIP/EPUB 文件');\n\n  const count = buf.readUInt16LE(eocd + 10);\n  let off = buf.readUInt32LE(eocd + 16);\n  const entries = [];\n\n  for (let i = 0; i < count; i++) {\n    if (off + 46 > buf.length || buf.readUInt32LE(off) !== 0x02014b50) break;\n    const method = buf.readUInt16LE(off + 10);\n    const csize = buf.readUInt32LE(off + 20);\n    const usize = buf.readUInt32LE(off + 24);\n    const nameLen = buf.readUInt16LE(off + 28);\n    const extraLen = buf.readUInt16LE(off + 30);\n    const commentLen = buf.readUInt16LE(off + 32);\n    const localOff = buf.readUInt32LE(off + 42);\n    const name = buf.toString('utf8', off + 46, off + 46 + nameLen);\n    entries.push({ name, method, csize, usize, localOff });\n    off += 46 + nameLen + extraLen + commentLen;\n  }\n\n  const map = new Map(entries.map(e => [e.name, e]));\n\n  return {\n    names: entries.map(e => e.name),\n    has: n => map.has(n),\n    /** 返回 Buffer 或 null */\n    read(name) {\n      const e = map.get(name);\n      if (!e) return null;\n      const lh = e.localOff;\n      if (buf.readUInt32LE(lh) !== 0x04034b50) return null;\n      const nameLen = buf.readUInt16LE(lh + 26);\n      const extraLen = buf.readUInt16LE(lh + 28);\n      const start = lh + 30 + nameLen + extraLen;\n      const raw = buf.subarray(start, start + e.csize);\n      if (e.method === 0) return Buffer.from(raw);\n      if (e.method === 8) {\n        try { return zlib.inflateRawSync(raw); } catch (err) { return null; }\n      }\n      return null;\n    },\n    readText(name) {\n      const b = this.read(name);\n      return b ? b.toString('utf8') : null;\n    }\n  };\n}\n\n/* ---------------- 写入（用于导出备份 zip） ---------------- */\nconst CRC_TABLE = (() => {\n  const t = new Int32Array(256);\n  for (let n = 0; n < 256; n++) {\n    let c = n;\n    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;\n    t[n] = c;\n  }\n  return t;\n})();\n\nfunction crc32(buf) {\n  let c = -1;\n  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);\n  return (c ^ -1) >>> 0;\n}\n\nfunction dosTime(d) {\n  const time = ((d.getHours() & 31) << 11) | ((d.getMinutes() & 63) << 5) | ((d.getSeconds() / 2) & 31);\n  const date = (((d.getFullYear() - 1980) & 127) << 9) | (((d.getMonth() + 1) & 15) << 5) | (d.getDate() & 31);\n  return { time, date };\n}\n\n/**\n * files: [{ name, data: Buffer|string, store?: boolean }]\n * 返回完整 zip Buffer（UTF-8 文件名，deflate 压缩）\n */\nfunction writeZip(files) {\n  const now = new Date();\n  const { time, date } = dosTime(now);\n  const locals = [];\n  const centrals = [];\n  let offset = 0;\n\n  for (const f of files) {\n    const nameBuf = Buffer.from(String(f.name).replace(/\\\\/g, '/'), 'utf8');\n    const raw = Buffer.isBuffer(f.data) ? f.data : Buffer.from(String(f.data == null ? '' : f.data), 'utf8');\n    const crc = crc32(raw);\n    let body = raw, method = 0;\n    if (!f.store && raw.length > 64) {\n      const def = zlib.deflateRawSync(raw, { level: 6 });\n      if (def.length < raw.length) { body = def; method = 8; }\n    }\n\n    const lh = Buffer.alloc(30);\n    lh.writeUInt32LE(0x04034b50, 0);\n    lh.writeUInt16LE(20, 4);\n    lh.writeUInt16LE(0x0800, 6);       // UTF-8 flag\n    lh.writeUInt16LE(method, 8);\n    lh.writeUInt16LE(time, 10);\n    lh.writeUInt16LE(date, 12);\n    lh.writeUInt32LE(crc, 14);\n    lh.writeUInt32LE(body.length, 18);\n    lh.writeUInt32LE(raw.length, 22);\n    lh.writeUInt16LE(nameBuf.length, 26);\n    lh.writeUInt16LE(0, 28);\n\n    locals.push(lh, nameBuf, body);\n\n    const ch = Buffer.alloc(46);\n    ch.writeUInt32LE(0x02014b50, 0);\n    ch.writeUInt16LE(20, 4);\n    ch.writeUInt16LE(20, 6);\n    ch.writeUInt16LE(0x0800, 8);\n    ch.writeUInt16LE(method, 10);\n    ch.writeUInt16LE(time, 12);\n    ch.writeUInt16LE(date, 14);\n    ch.writeUInt32LE(crc, 16);\n    ch.writeUInt32LE(body.length, 20);\n    ch.writeUInt32LE(raw.length, 24);\n    ch.writeUInt16LE(nameBuf.length, 28);\n    ch.writeUInt16LE(0, 30);\n    ch.writeUInt16LE(0, 32);\n    ch.writeUInt16LE(0, 34);\n    ch.writeUInt16LE(0, 36);\n    ch.writeUInt32LE(0, 38);\n    ch.writeUInt32LE(offset, 42);\n    centrals.push(ch, nameBuf);\n\n    offset += lh.length + nameBuf.length + body.length;\n  }\n\n  const centralBuf = Buffer.concat(centrals);\n  const eocd = Buffer.alloc(22);\n  eocd.writeUInt32LE(0x06054b50, 0);\n  eocd.writeUInt16LE(0, 4);\n  eocd.writeUInt16LE(0, 6);\n  eocd.writeUInt16LE(files.length, 8);\n  eocd.writeUInt16LE(files.length, 10);\n  eocd.writeUInt32LE(centralBuf.length, 12);\n  eocd.writeUInt32LE(offset, 16);\n  eocd.writeUInt16LE(0, 20);\n\n  return Buffer.concat([...locals, centralBuf, eocd]);\n}\n\nmodule.exports = { readZip, writeZip };\n","net":"'use strict';\n/**\n * 网络层：绕过浏览器 CORS 抓取书源页面，处理重定向 / gzip / 字符编码\n */\nconst http = require('http');\nconst https = require('https');\nconst zlib = require('zlib');\nconst { URL } = require('url');\n\nconst UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';\n\nfunction decompress(buf, encoding) {\n  try {\n    if (encoding === 'gzip') return zlib.gunzipSync(buf);\n    if (encoding === 'deflate') return zlib.inflateSync(buf);\n    if (encoding === 'br') return zlib.brotliDecompressSync(buf);\n  } catch (e) { /* 交给上层按原文处理 */ }\n  return buf;\n}\n\nfunction sniffCharset(buf, contentType) {\n  if (contentType) {\n    const m = /charset=[\"']?([\\w-]+)/i.exec(contentType);\n    if (m) return m[1].toLowerCase();\n  }\n  const head = buf.subarray(0, 4096).toString('latin1');\n  let m = /<meta[^>]+charset=[\"']?([\\w-]+)/i.exec(head);\n  if (m) return m[1].toLowerCase();\n  m = /content=[\"'][^\"']*charset=([\\w-]+)/i.exec(head);\n  if (m) return m[1].toLowerCase();\n  return null;\n}\n\nfunction decode(buf, charset) {\n  const cs = (charset || '').toLowerCase();\n  const alias = { gb2312: 'gb18030', gbk: 'gb18030', 'utf8': 'utf-8', big5: 'big5' };\n  const enc = alias[cs] || cs || 'utf-8';\n  try {\n    return new TextDecoder(enc, { fatal: false }).decode(buf);\n  } catch (e) {\n    return new TextDecoder('utf-8', { fatal: false }).decode(buf);\n  }\n}\n\nfunction isValidUtf8(buf) {\n  try {\n    new TextDecoder('utf-8', { fatal: true }).decode(buf);\n    return true;\n  } catch (e) { return false; }\n}\n\nfunction request(url, opts, redirects = 0) {\n  return new Promise((resolve, reject) => {\n    let u;\n    try { u = new URL(url); } catch (e) { return reject(new Error('地址不合法: ' + url)); }\n    if (!/^https?:$/.test(u.protocol)) return reject(new Error('仅支持 http/https'));\n\n    const mod = u.protocol === 'https:' ? https : http;\n    const headers = Object.assign({\n      'User-Agent': UA,\n      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',\n      'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',\n      'Accept-Encoding': 'gzip, deflate'\n    }, opts.headers || {});\n\n    const req = mod.request({\n      protocol: u.protocol, hostname: u.hostname, port: u.port,\n      path: u.pathname + u.search, method: opts.method || 'GET', headers,\n      timeout: opts.timeout || 18000,\n      // 小说站证书过期/自签名极常见，允许降级（见 fetchText 的重试）\n      rejectUnauthorized: opts.insecure ? false : undefined\n    }, res => {\n      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects < 6) {\n        const next = new URL(res.headers.location, u).href;\n        res.resume();\n        return resolve(request(next, opts, redirects + 1));\n      }\n      const chunks = [];\n      let size = 0;\n      const limit = opts.maxBytes || 12 * 1024 * 1024;\n      res.on('data', c => {\n        size += c.length;\n        if (size > limit) { req.destroy(); return; }\n        chunks.push(c);\n      });\n      res.on('end', () => {\n        let buf = Buffer.concat(chunks);\n        buf = decompress(buf, (res.headers['content-encoding'] || '').toLowerCase());\n        resolve({ status: res.statusCode, headers: res.headers, buffer: buf, url: u.href });\n      });\n    });\n\n    req.on('timeout', () => { req.destroy(new Error('请求超时')); });\n    req.on('error', reject);\n    if (opts.body) req.write(opts.body);\n    req.end();\n  });\n}\n\n/** 证书类错误：很多小说站证书过期/域名不匹配，重试时放宽校验 */\nconst CERT_ERR = /CERT_HAS_EXPIRED|CERT_NOT_YET_VALID|DEPTH_ZERO_SELF_SIGNED|SELF_SIGNED_CERT|UNABLE_TO_VERIFY_LEAF|UNABLE_TO_GET_ISSUER|ERR_TLS_CERT_ALTNAME|EPROTO|ERR_SSL/i;\n\nasync function fetchText(url, opts = {}) {\n  const t0 = Date.now();\n  let res;\n  try {\n    res = await request(url, opts);\n  } catch (e) {\n    if (!opts.insecure && CERT_ERR.test(String(e && (e.code || e.message)))) {\n      res = await request(url, Object.assign({}, opts, { insecure: true }));\n    } else {\n      throw e;\n    }\n  }\n  const ct = res.headers['content-type'] || '';\n  let charset = opts.charset && opts.charset !== 'auto' ? opts.charset : sniffCharset(res.buffer, ct);\n  if (!charset && !isValidUtf8(res.buffer)) charset = 'gb18030';\n  const text = decode(res.buffer, charset || 'utf-8');\n  return {\n    status: res.status,\n    url: res.url,\n    charset: charset || 'utf-8',\n    text,\n    ms: Date.now() - t0\n  };\n}\n\n/**\n * 取二进制（漫画页的图片）。\n * 为什么不直接让 <img src> 指远程地址：漫画站几乎都校验 Referer，\n * WebView/渲染进程直连会拿到 403 的占位图，白框一片；这里带着书源 headers 下回来，\n * 再以 data URL 交给阅读器，既不受防盗链也不受页面 CSP 限制。\n */\nasync function fetchBinary(url, opts = {}) {\n  const t0 = Date.now();\n  let res;\n  try {\n    res = await request(url, Object.assign({}, opts, { maxBytes: opts.maxBytes || 8 * 1024 * 1024 }));\n  } catch (e) {\n    if (!opts.insecure && CERT_ERR.test(String(e && (e.code || e.message)))) {\n      res = await request(url, Object.assign({}, opts, { insecure: true, maxBytes: opts.maxBytes || 8 * 1024 * 1024 }));\n    } else {\n      throw e;\n    }\n  }\n  const ct = String(res.headers['content-type'] || '').split(';')[0].trim().toLowerCase();\n  /* 有些站把图片当 octet-stream 发，只能靠文件头猜 */\n  const mime = /^image\\//.test(ct) ? ct : sniffImageMime(res.buffer) || ct || 'application/octet-stream';\n  return {\n    status: res.status,\n    url: res.url,\n    mime,\n    bytes: res.buffer.length,\n    b64: res.buffer.toString('base64'),\n    ms: Date.now() - t0\n  };\n}\n\n/** 图片文件头识别（Content-Type 不靠谱时兜底） */\nfunction sniffImageMime(buf) {\n  if (!buf || buf.length < 12) return '';\n  const b = buf;\n  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';\n  if (b[0] === 0xff && b[1] === 0xd8) return 'image/jpeg';\n  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return 'image/gif';\n  if (b.slice(0, 4).toString('ascii') === 'RIFF' && b.slice(8, 12).toString('ascii') === 'WEBP') return 'image/webp';\n  if (b[0] === 0x42 && b[1] === 0x4d) return 'image/bmp';\n  return '';\n}\n\nmodule.exports = { fetchText, fetchBinary, request, decode };\n","webdav":"'use strict';\n/**\n * 极简 WebDAV 客户端（坚果云 / Nextcloud / 群晖 等通用）\n * 支持：PROPFIND 列目录、MKCOL 建目录、PUT 上传、GET 下载、DELETE 删除、HEAD 探测\n * 认证：HTTP Basic（坚果云用「邮箱 + 应用密码」）\n */\nconst http = require('http');\nconst https = require('https');\nconst { URL } = require('url');\nconst zlib = require('zlib');\n\nconst TIMEOUT = 25000;\n\nfunction basicAuth(user, pass) {\n  return 'Basic ' + Buffer.from(String(user || '') + ':' + String(pass || ''), 'utf8').toString('base64');\n}\n\n/** 逐段编码路径，保留已有的百分号编码 */\nfunction encodePath(p) {\n  return String(p).split('/').map(seg => {\n    if (!seg) return seg;\n    if (/%[0-9A-Fa-f]{2}/.test(seg)) return seg;\n    return encodeURIComponent(seg).replace(/'/g, '%27');\n  }).join('/');\n}\n\nfunction joinUrl(base, name) {\n  return String(base).replace(/\\/+$/, '') + '/' + encodePath(name);\n}\n\nfunction request(cfg, method, url, opts = {}) {\n  return new Promise((resolve, reject) => {\n    let u;\n    try { u = new URL(url); } catch (e) { return reject(new Error('地址不合法：' + url)); }\n    if (!/^https?:$/.test(u.protocol)) return reject(new Error('仅支持 http/https'));\n\n    const mod = u.protocol === 'https:' ? https : http;\n    const headers = Object.assign({\n      'Authorization': basicAuth(cfg.user, cfg.pass),\n      'User-Agent': 'MoRead/2.0 (WebDAV)',\n      'Accept': '*/*',\n      'Accept-Encoding': 'gzip, deflate'\n    }, opts.headers || {});\n    if (opts.body) headers['Content-Length'] = Buffer.byteLength(opts.body);\n\n    const req = mod.request({\n      protocol: u.protocol, hostname: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80),\n      path: u.pathname + u.search, method, headers, timeout: opts.timeout || TIMEOUT,\n      rejectUnauthorized: true\n    }, res => {\n      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && (opts.redirects || 0) < 5) {\n        const next = new URL(res.headers.location, u).href;\n        res.resume();\n        return resolve(request(cfg, method, next, Object.assign({}, opts, { redirects: (opts.redirects || 0) + 1 })));\n      }\n      const chunks = [];\n      res.on('data', c => chunks.push(c));\n      res.on('end', () => {\n        let buf = Buffer.concat(chunks);\n        const enc = (res.headers['content-encoding'] || '').toLowerCase();\n        try {\n          if (enc === 'gzip') buf = zlib.gunzipSync(buf);\n          else if (enc === 'deflate') buf = zlib.inflateSync(buf);\n        } catch (e) { /* 保留原样 */ }\n        resolve({ status: res.statusCode, headers: res.headers, buffer: buf, url: u.href });\n      });\n    });\n    req.on('timeout', () => req.destroy(new Error('连接超时，检查网络或服务器地址')));\n    req.on('error', e => reject(new Error(friendlyNetError(e))));\n    if (opts.body) req.write(opts.body);\n    req.end();\n  });\n}\n\nfunction friendlyNetError(e) {\n  const m = String((e && e.message) || e);\n  if (/ENOTFOUND|EAI_AGAIN/.test(m)) return '找不到服务器，检查地址是否写对（如 https://dav.jianguoyun.com/dav/）';\n  if (/ECONNREFUSED/.test(m)) return '服务器拒绝连接';\n  if (/CERT|certificate|self.signed/i.test(m)) return '证书校验失败，确认地址是 https 且证书有效';\n  return m;\n}\n\nfunction statusError(status) {\n  const map = {\n    401: '账号或密码不对（坚果云要用「应用密码」，不是登录密码）',\n    403: '没有权限，或路径不允许该操作',\n    404: '路径不存在，检查远程目录',\n    405: '服务器不支持该操作',\n    409: '目标目录不存在（有些服务器要求先建目录）',\n    423: '文件被锁定',\n    507: '云端空间不足'\n  };\n  return new Error(map[status] || ('服务器返回 ' + status));\n}\n\nfunction unescapeXml(s) {\n  return String(s).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '\"')\n    .replace(/&apos;/g, \"'\").replace(/&#(\\d+);/g, (_, d) => String.fromCharCode(+d))\n    .replace(/&amp;/g, '&');\n}\n\nfunction decodeHref(href) {\n  try { return decodeURIComponent(href); } catch (e) { return href; }\n}\n\n/** 解析 207 Multi-Status */\nfunction parseMultiStatus(xml, baseUrl) {\n  const out = [];\n  const blocks = String(xml || '').match(/<(?:[\\w-]+:)?response\\b[\\s\\S]*?<\\/(?:[\\w-]+:)?response>/gi) || [];\n  for (const b of blocks) {\n    const hrefM = /<(?:[\\w-]+:)?href[^>]*>([\\s\\S]*?)<\\/(?:[\\w-]+:)?href>/i.exec(b);\n    if (!hrefM) continue;\n    const href = unescapeXml(hrefM[1].trim());\n    const isDir = /<(?:[\\w-]+:)?collection\\s*\\/?>/i.test(b);\n    const size = /<(?:[\\w-]+:)?getcontentlength[^>]*>(\\d+)/i.exec(b);\n    const mod = /<(?:[\\w-]+:)?getlastmodified[^>]*>([^<]+)/i.exec(b);\n    const base = new URL(baseUrl);\n    let path = href;\n    try { path = new URL(href, base).pathname; } catch (e) { /* keep */ }\n    const name = decodeHref(path.replace(/\\/+$/, '').split('/').pop() || '');\n    out.push({\n      href, name, isDir,\n      size: size ? +size[1] : 0,\n      lastmod: mod ? new Date(unescapeXml(mod[1])).getTime() || 0 : 0,\n      mtime: mod ? unescapeXml(mod[1]) : ''\n    });\n  }\n  return out;\n}\n\nconst PROPFIND_BODY =\n  '<?xml version=\"1.0\" encoding=\"utf-8\"?>' +\n  '<d:propfind xmlns:d=\"DAV:\"><d:prop>' +\n  '<d:displayname/><d:getcontentlength/><d:getlastmodified/><d:resourcetype/>' +\n  '</d:prop></d:propfind>';\n\n/** 列目录（Depth:1），返回不含自身的条目 */\nasync function list(cfg, dirUrl) {\n  const url = String(dirUrl).replace(/\\/+$/, '') + '/';\n  const r = await request(cfg, 'PROPFIND', url, {\n    headers: { Depth: '1', 'Content-Type': 'application/xml; charset=utf-8' },\n    body: PROPFIND_BODY\n  });\n  if (r.status === 401) throw statusError(401);\n  if (r.status === 404) throw statusError(404);\n  if (r.status !== 207 && r.status !== 200) throw statusError(r.status);\n  const all = parseMultiStatus(r.buffer.toString('utf8'), url);\n  const selfPath = new URL(url).pathname.replace(/\\/+$/, '');\n  return all.filter(e => {\n    let p = e.href;\n    try { p = new URL(e.href, url).pathname; } catch (err) { /* keep */ }\n    return p.replace(/\\/+$/, '') !== selfPath;\n  });\n}\n\nasync function mkcol(cfg, dirUrl) {\n  const url = String(dirUrl).replace(/\\/+$/, '') + '/';\n  const r = await request(cfg, 'MKCOL', url, { headers: { 'Content-Type': 'application/xml; charset=utf-8' } });\n  if (r.status === 201 || r.status === 200) return true;\n  if (r.status === 405 || r.status === 301 || r.status === 302) return true; // 已存在\n  if (r.status === 401) throw statusError(401);\n  if (r.status === 409) throw statusError(409);\n  throw statusError(r.status);\n}\n\n/** 递归创建目录（相对 base） */\nasync function ensureDir(cfg, baseUrl, rel) {\n  const segs = String(rel || '').split('/').filter(Boolean);\n  let cur = String(baseUrl).replace(/\\/+$/, '');\n  for (const s of segs) {\n    cur = joinUrl(cur, s);\n    await mkcol(cfg, cur);\n  }\n  return cur;\n}\n\nasync function put(cfg, fileUrl, buffer, contentType) {\n  const r = await request(cfg, 'PUT', fileUrl, {\n    headers: { 'Content-Type': contentType || 'application/octet-stream' },\n    body: buffer,\n    timeout: 120000\n  });\n  if ([200, 201, 204, 207, 302].includes(r.status)) return true;\n  if (r.status === 401 || r.status === 403 || r.status === 409 || r.status === 507) throw statusError(r.status);\n  throw statusError(r.status);\n}\n\nasync function get(cfg, fileUrl) {\n  const r = await request(cfg, 'GET', fileUrl, { timeout: 120000 });\n  if (r.status === 200) return r.buffer;\n  if (r.status === 401 || r.status === 404 || r.status === 403) throw statusError(r.status);\n  throw statusError(r.status);\n}\n\nasync function del(cfg, fileUrl) {\n  const r = await request(cfg, 'DELETE', fileUrl);\n  if ([200, 204, 404].includes(r.status)) return true;\n  if (r.status === 401 || r.status === 403) throw statusError(r.status);\n  throw statusError(r.status);\n}\n\nasync function stat(cfg, url) {\n  const r = await request(cfg, 'PROPFIND', url, {\n    headers: { Depth: '0', 'Content-Type': 'application/xml; charset=utf-8' },\n    body: PROPFIND_BODY\n  });\n  if (r.status === 401) throw statusError(401);\n  if (r.status !== 207 && r.status !== 200) return null;\n  const list0 = parseMultiStatus(r.buffer.toString('utf8'), url);\n  return list0[0] || null;\n}\n\n/** 连接测试：先探测根目录，再列配置目录 */\nasync function test(cfg) {\n  const t0 = Date.now();\n  const base = String(cfg.url || '').replace(/\\/+$/, '') + '/';\n  const r = await request(cfg, 'PROPFIND', base, {\n    headers: { Depth: '0', 'Content-Type': 'application/xml; charset=utf-8' },\n    body: PROPFIND_BODY\n  });\n  if (r.status === 401) throw statusError(401);\n  if (r.status !== 207 && r.status !== 200 && r.status !== 301 && r.status !== 302) throw statusError(r.status);\n  let items = [];\n  if (cfg.dir) {\n    try { items = await list(cfg, joinUrl(base, cfg.dir)); } catch (e) { items = []; }\n  }\n  return { ok: true, ms: Date.now() - t0, items };\n}\n\nmodule.exports = { test, list, mkcol, ensureDir, put, get, del, stat, joinUrl, encodePath };\n","legado":"'use strict';\n/**\n * 与原版「阅读 Legado」互通的数据格式\n *  - 导出：备份 zip 内同时写入 Legado 认识的 bookSource.json / bookshelf.json /\n *          bookmark.json / readRecord.json / bookGroup.json，原版 App 可直接从该 zip 恢复\n *  - 导入：能识别 Legado 的备份 zip 与单独的 bookSource.json\n * 字段说明参考 Legado 的 BookSource / Book / Bookmark / ReadRecord 数据结构\n */\nconst fs = require('fs');\nconst { readZip, writeZip } = require('./zip');\n\n/* ---------------- 导出：内部结构 → Legado ---------------- */\nfunction toLegadoSources(sources) {\n  return (sources || []).map((s, i) => ({\n    bookSourceUrl: s.url || '',\n    bookSourceName: s.name || '未命名书源',\n    bookSourceGroup: s.group || '',\n    bookSourceType: 0,\n    bookSourceComment: s.comment || '',\n    enabled: s.enabled !== false,\n    enabledExplore: false,\n    customOrder: i,\n    searchUrl: s.searchUrl || '',\n    charset: s.charset && s.charset !== 'auto' ? s.charset : undefined,\n    ruleSearch: {\n      bookList: s.ruleSearch?.bookList || '',\n      name: s.ruleSearch?.name || '',\n      author: s.ruleSearch?.author || '',\n      intro: s.ruleSearch?.intro || '',\n      kind: s.ruleSearch?.kind || '',\n      lastChapter: s.ruleSearch?.lastChapter || '',\n      bookUrl: s.ruleSearch?.bookUrl || '',\n      coverUrl: s.ruleSearch?.coverUrl || ''\n    },\n    ruleBookInfo: {\n      name: s.ruleBookInfo?.name || '',\n      author: s.ruleBookInfo?.author || '',\n      intro: s.ruleBookInfo?.intro || '',\n      coverUrl: s.ruleBookInfo?.coverUrl || '',\n      tocUrl: s.ruleBookInfo?.tocUrl || ''\n    },\n    ruleToc: {\n      chapterList: s.ruleToc?.chapterList || '',\n      chapterName: s.ruleToc?.chapterName || '',\n      chapterUrl: s.ruleToc?.chapterUrl || '',\n      nextTocUrl: s.ruleToc?.nextTocUrl || ''\n    },\n    ruleContent: {\n      content: s.ruleContent?.content || '',\n      nextContentUrl: s.ruleContent?.nextContentUrl || ''\n    }\n  }));\n}\n\nfunction groupIndex(groups, gid) {\n  const i = (groups || []).findIndex(g => g.id === (gid || 'g_default'));\n  return i < 0 ? 0 : i;\n}\n\nfunction toLegadoBooks(books, progress, groups, sources) {\n  return (books || []).map((b, i) => {\n    const p = (progress || {})[b.id] || {};\n    const local = b.kind === 'local';\n    const src = (sources || []).find(s => s.id === b.sourceId) || {};\n    return {\n      bookUrl: local ? 'file:///' + (b.localFile || b.name) : (b.bookUrl || ''),\n      origin: local ? 'local' : (src.url || ''),\n      originName: local ? '本地' : (b.sourceName || src.name || ''),\n      name: b.name || '',\n      author: b.author || '',\n      coverUrl: b.cover || '',\n      intro: b.intro || '',\n      type: local ? 1 : 0,\n      group: groupIndex(groups, b.groupId),\n      latestChapterTitle: (b.chapters && b.chapters.length) ? String(b.chapters[b.chapters.length - 1].title || '') : '',\n      latestChapterTime: b.updatedAt || b.createdAt || 0,\n      lastCheckTime: b.updatedAt || 0,\n      chapterListSize: b.total || (b.chapters ? b.chapters.length : 0),\n      durChapterIndex: p.ci || 0,\n      durChapterTitle: p.title || '',\n      durChapterPos: 0,\n      durChapterTime: p.at || 0,\n      canUpdate: !local,\n      order: i,\n      totalChapterNum: b.total || 0\n    };\n  });\n}\n\nfunction toLegadoBookmarks(bookmarks) {\n  return (bookmarks || []).map(bm => ({\n    bookName: bm.name || '',\n    bookAuthor: bm.author || '',\n    chapterIndex: bm.ci || 0,\n    chapterPos: 0,\n    chapterTitle: bm.title || '',\n    bookText: bm.text || '',\n    content: bm.text || '',\n    createTime: bm.at || Date.now()\n  }));\n}\n\nfunction toLegadoReadRecords(history) {\n  return (history || []).map(h => ({\n    bookName: h.name || '',\n    author: h.author || '',\n    readTime: h.at || 0,\n    lastRead: h.at || 0,\n    chapterIndex: h.ci || 0,\n    chapterPos: 0,\n    chapterTitle: h.title || ''\n  }));\n}\n\n/* ---------------- 导入：Legado → 内部结构 ---------------- */\nfunction pickStr(o, ...keys) {\n  for (const k of keys) {\n    if (o && o[k] != null && o[k] !== '') return o[k];\n  }\n  return '';\n}\n\n/** 把 Legado 的 bookSource 数组收敛成可交给渲染层归一化的裸对象 */\n/* 原版「阅读」的书源有多种包裹形态：\n   裸数组 / {bookSource:[...]} / {bookSources:[...]} / {sources:[...]} / {data:[...]}。\n   以前只认前两种，手机里导出的「bookSource」单键 JSON 会被判成 0 个书源。 */\nfunction rawSourcesFromLegado(arr) {\n  let list = [];\n  if (Array.isArray(arr)) list = arr;\n  else if (arr && typeof arr === 'object') {\n    for (const k of ['bookSource', 'bookSources', 'sources', 'data', 'bookSourceList']) {\n      if (Array.isArray(arr[k])) { list = arr[k]; break; }\n    }\n  }\n  return list.filter(x => x && (x.bookSourceName || x.name));\n}\n\nfunction normalizeUrl(u) {\n  return String(u || '').trim().replace(/\\/+$/, '').toLowerCase()\n    .replace(/^https?:\\/\\//, '').replace(/^www\\./, '');\n}\n\n/** Legado 书架项 → 我们的书；返回 { books, skipped } */\nfunction rawBooksFromLegado(arr) {\n  const list = Array.isArray(arr) ? arr : (arr && arr.books) || [];\n  const out = [], skipped = [];\n  for (const b of list) {\n    if (!b || (!b.name && !b.bookName && !b.bookUrl)) continue;\n    const url = String(b.bookUrl || '');\n    // 原版本地书带的是手机路径（/storage/... 或 content://），桌面端无法还原\n    const isLocal = /^file:\\/\\//.test(url) || /^content:\\/\\//.test(url)\n      || /^\\/storage\\//.test(url) || b.origin === 'local' || b.localBook === true;\n    if (isLocal) { skipped.push(b.name || b.bookName || b.bookUrl); continue; }\n    /* 原版字段是 name；有些第三方导出的备份写 bookName，两种都认 */\n    const name = String(pickStr(b, 'name', 'bookName') || '').trim();\n    if (!name) { skipped.push(url || '（无书名）'); continue; }\n    out.push({\n      name,\n      author: pickStr(b, 'author') || '佚名',\n      bookUrl: pickStr(b, 'bookUrl'),\n      /* originRaw 保留备份里的原始书源地址；origin 是归一化后用来匹配的键。\n         书要记下「原本用的哪个源」，换源时才排得出备份里的顺序。 */\n      origin: normalizeUrl(pickStr(b, 'origin')),\n      originRaw: pickStr(b, 'origin'),\n      originName: pickStr(b, 'originName'),\n      intro: pickStr(b, 'intro'),\n      cover: pickStr(b, 'coverUrl'),\n      group: Number(b.group != null ? b.group : 0) || 0,\n      total: Number(pickStr(b, 'chapterListSize') || pickStr(b, 'totalChapterNum') || 0) || 0,\n      durChapterIndex: Number(pickStr(b, 'durChapterIndex') || 0) || 0,\n      durChapterTitle: pickStr(b, 'durChapterTitle'),\n      durChapterTime: Number(pickStr(b, 'durChapterTime') || 0) || 0\n    });\n  }\n  return { books: out, skipped };\n}\n\n/** Legado 的自定义分组（负数 groupId 是系统分组：全部/本地/音频…） */\nfunction rawGroupsFromLegado(arr) {\n  const list = Array.isArray(arr) ? arr : [];\n  const map = new Map();\n  for (const g of list) {\n    if (!g) continue;\n    const gid = Number(g.groupId);\n    if (!isFinite(gid) || gid < 0) continue;\n    map.set(gid, String(g.groupName || ('分组' + gid)));\n  }\n  return map;\n}\n\nfunction rawBookmarksFromLegado(arr) {\n  const list = Array.isArray(arr) ? arr : [];\n  return list.filter(b => b && (b.bookName || b.bookUrl)).map(b => ({\n    bookName: pickStr(b, 'bookName'),\n    bookUrl: pickStr(b, 'bookUrl'),\n    ci: Number(pickStr(b, 'chapterIndex') || 0) || 0,\n    title: pickStr(b, 'chapterTitle'),\n    text: pickStr(b, 'bookText') || pickStr(b, 'content'),\n    at: Number(pickStr(b, 'createTime') || 0) || Date.now()\n  }));\n}\n\nfunction rawReadRecordsFromLegado(arr) {\n  const list = Array.isArray(arr) ? arr : (arr && typeof arr === 'object' ? Object.values(arr) : []);\n  return list.filter(r => r && r.bookName).map(r => ({\n    bookName: pickStr(r, 'bookName'),\n    ci: Number(pickStr(r, 'chapterIndex') || 0) || 0,\n    title: pickStr(r, 'chapterTitle'),\n    at: Number(pickStr(r, 'lastRead') || pickStr(r, 'readTime') || 0) || Date.now()\n  }));\n}\n\n/* ---------------- 备份 zip ---------------- */\n/**\n * @param state 完整存档\n * @param opts  { includeFiles:boolean, readBookFile:(rel)=>Buffer|null }\n */\nfunction buildBackupZip(state, opts = {}) {\n  const files = [];\n  const groups = state.groups || [];\n  const bookGroups = groups.map((g, i) => ({ groupId: i, groupName: g.name || '分组' + i, order: i }));\n  if (!bookGroups.length) bookGroups.push({ groupId: 0, groupName: '默认分组', order: 0 });\n\n  const fileMap = {};\n  if (opts.includeFiles) {\n    for (const b of state.books || []) {\n      if (b.kind !== 'local' || !b.localFile) continue;\n      const buf = opts.readBookFile ? opts.readBookFile(b.localFile) : null;\n      if (!buf) continue;\n      const name = 'files/' + b.id + (b.ext || '.txt');\n      files.push({ name, data: buf });\n      fileMap[b.id] = { path: name, ext: b.ext || '.txt', localFile: b.localFile };\n    }\n  }\n\n  // 墨读完整存档（保留全部字段，恢复时无损）\n  files.push({\n    name: 'moread.json',\n    data: JSON.stringify({\n      app: 'moread', schema: 2, exportedAt: new Date().toISOString(),\n      data: state, fileMap\n    })\n  });\n\n  // Legado 认识的几份 JSON\n  const legado = {\n    'bookSource.json': toLegadoSources(state.sources),\n    'bookshelf.json': toLegadoBooks(state.books, state.progress, groups, state.sources),\n    'bookmark.json': toLegadoBookmarks(state.bookmarks),\n    'readRecord.json': toLegadoReadRecords(state.history),\n    'bookGroup.json': bookGroups\n  };\n  for (const [name, arr] of Object.entries(legado)) {\n    if (!arr.length && name !== 'bookGroup.json') continue;\n    files.push({ name, data: JSON.stringify(arr, null, 2) });\n  }\n\n  return writeZip(files);\n}\n\n/**\n * 解析备份 zip：优先按墨读完整备份读，否则按 Legado 备份读\n * @returns {{ok:boolean, kind:'moread'|'legado', error?:string, ...}}\n */\nfunction parseBackupZip(buf) {\n  let zip;\n  try { zip = readZip(buf); } catch (e) {\n    // 不是 zip 就再当单 JSON 备份试一次，别直接甩「不是有效的 zip」\n    const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf || []);\n    const head = new TextDecoder('utf-8').decode(u8.slice(0, 64)).replace(/^\\uFEFF/, '').trimStart();\n    if (head.startsWith('{') || head.startsWith('[')) {\n      return parseBackupJson(new TextDecoder('utf-8').decode(u8));\n    }\n    return { ok: false, error: '不是有效的 zip 或 JSON 备份：' + e.message };\n  }\n  const names = zip.names;\n  const has = n => names.includes(n);\n\n  // 1) 墨读完整备份\n  if (has('moread.json')) {\n    try {\n      const p = JSON.parse(zip.readText('moread.json'));\n      if (p && p.app === 'moread' && p.data) {\n        return {\n          ok: true, kind: 'moread', payload: p,\n          summary: {\n            books: (p.data.books || []).length,\n            sources: (p.data.sources || []).length,\n            bookmarks: (p.data.bookmarks || []).length,\n            withFiles: !!(p.fileMap && Object.keys(p.fileMap).length)\n          }\n        };\n      }\n    } catch (e) { /* 落到 Legado 分支 */ }\n  }\n\n  // 2) Legado 备份。zip 里每个 json 也可能是 {bookSource:[...]} 这种包裹，统一取数组。\n  const readArr = (n, keys) => {\n    if (!has(n)) return [];\n    let v;\n    try { v = JSON.parse(zip.readText(n)); } catch (e) { return []; }\n    if (Array.isArray(v)) return v;\n    if (v && typeof v === 'object') return keys ? pickArrayField(v, keys) : [];\n    return [];\n  };\n  const sources = rawSourcesFromLegado(readArr('bookSource.json', ['bookSource', 'bookSources', 'sources']));\n  const books = rawBooksFromLegado(readArr('bookshelf.json', ['bookshelf', 'books']));\n  const bookmarks = rawBookmarksFromLegado(readArr('bookmark.json', ['bookmark', 'bookmarks']));\n  const records = rawReadRecordsFromLegado(readArr('readRecord.json', ['readRecord', 'readRecords']));\n\n  // 书架分组：把 groupId 换成组名交给渲染层建组\n  const gmap = rawGroupsFromLegado(readArr('bookGroup.json', ['bookGroup', 'groups']));\n  for (const b of books.books) b.groupName = gmap.get(b.group) || '';\n\n  // 有些备份把全部数据塞在一个总 JSON 里（backup.json / 备份.json …），逐个试一遍\n  if (!sources.length && !books.books.length && !bookmarks.length) {\n    for (const n of names) {\n      if (!/\\.json$/i.test(n)) continue;\n      const one = parseBackupJson(zip.readText(n));\n      if (one.ok && one.kind === 'legado') return one;\n    }\n    return { ok: false, error: 'zip 里没有找到书源或书架数据（需要 bookSource.json 或 bookshelf.json）' };\n  }\n  return {\n    ok: true, kind: 'legado',\n    legado: { sources, books: books.books, bookmarks, records },\n    summary: {\n      books: books.books.length,\n      sources: sources.length,\n      bookmarks: bookmarks.length,\n      skippedLocal: books.skipped.length,\n      withFiles: names.some(n => n.startsWith('files/'))\n    }\n  };\n}\n\n/** 读取 zip 内的本地书文件 */\nfunction readZipFiles(buf, fileMap) {\n  const zip = readZip(buf);\n  const out = {};\n  for (const [id, info] of Object.entries(fileMap || {})) {\n    const b = zip.read(info.path);\n    if (b) out[id] = b;\n  }\n  return out;\n}\n\n/** 单个书源 JSON 文件（兼容数组 / {bookSource:[...]} 等各种包裹） */\nfunction parseSourceFile(text) {\n  let json;\n  try { json = JSON.parse(text); } catch (e) { return { ok: false, error: 'JSON 解析失败：' + e.message }; }\n  const list = rawSourcesFromLegado(json);\n  return { ok: true, sources: list };\n}\n\n/* 从备份 JSON 对象里取一个数组字段；有些导出会再套一层 {data:[...]} */\nfunction pickArrayField(json, keys) {\n  for (const k of keys) {\n    const v = json[k];\n    if (Array.isArray(v)) return v;\n    if (v && typeof v === 'object' && Array.isArray(v.data)) return v.data;\n  }\n  return [];\n}\n\n/**\n * 解析「单个 JSON 文件」形式的备份。\n * 手机里除了 zip，还常见把 bookSource / bookshelf / bookmark 打在一个 JSON 里导出，\n * 甚至直接是纯书源数组。以前 pickZip 只按 parseSourceFile 取书源，书架和书签全被丢掉，\n * 而且 bookSource 单键还取不到 → 表现为「点了没反应」。\n * 返回结构与 parseBackupZip 对齐，恢复界面可以直接复用。\n */\nfunction parseBackupJson(text) {\n  let json;\n  try { json = JSON.parse(String(text).replace(/^\\uFEFF/, '').trim()); }\n  catch (e) { return { ok: false, error: 'JSON 解析失败：' + e.message }; }\n\n  const isArray = Array.isArray(json);\n  const sources = rawSourcesFromLegado(json);\n  const books = isArray ? { books: [], skipped: [] }\n    : rawBooksFromLegado(pickArrayField(json, ['bookshelf', 'books', 'bookShelf']));\n  const bookmarks = isArray ? []\n    : rawBookmarksFromLegado(pickArrayField(json, ['bookmark', 'bookmarks']));\n  const records = isArray ? []\n    : rawReadRecordsFromLegado(pickArrayField(json, ['readRecord', 'readRecords']));\n\n  if (!sources.length && !books.books.length && !bookmarks.length) {\n    return { ok: false, error: '这个 JSON 里没有识别到书源或书架数据（需要 bookSource / bookshelf 数组）' };\n  }\n  if (!books.books.length && !bookmarks.length) {\n    return { ok: true, kind: 'sources', sources,\n      summary: { sources: sources.length, books: 0, bookmarks: 0 } };\n  }\n  return {\n    ok: true, kind: 'legado',\n    legado: { sources, books: books.books, bookmarks, records },\n    summary: {\n      books: books.books.length, sources: sources.length, bookmarks: bookmarks.length,\n      skippedLocal: books.skipped.length, withFiles: false\n    }\n  };\n}\n\nmodule.exports = {\n  toLegadoSources, toLegadoBooks, toLegadoBookmarks, toLegadoReadRecords,\n  buildBackupZip, parseBackupZip, readZipFiles, parseSourceFile, parseBackupJson,\n  normalizeUrl\n};\n","parse":"'use strict';\n/**\n * 本地书解析：TXT（编码探测 + 中文章节）与 EPUB（OPF/spine/NCX/nav）\n */\nconst path = require('path');\nconst { readZip } = require('./zip');\n\nconst CH_RE = /^[ \\t　]*(第[零一二三四五六七八九十百千万两0-9]{1,9}[章节回卷篇集][^\\n]{0,30}|Chapter\\s+\\d+[^\\n]{0,30}|正文[ \\t]*第?[0-9零一二三四五六七八九十百千]{1,9}[章节回][^\\n]{0,30})[ \\t　]*$/;\n\nfunction decodeBuffer(buf) {\n  if (buf.length > 3 && buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF) {\n    return new TextDecoder('utf-8').decode(buf.subarray(3));\n  }\n  if (buf.length > 1 && buf[0] === 0xFF && buf[1] === 0xFE) {\n    return new TextDecoder('utf-16le').decode(buf.subarray(2));\n  }\n  try {\n    return new TextDecoder('utf-8', { fatal: true }).decode(buf);\n  } catch (e) {\n    return new TextDecoder('gb18030').decode(buf);\n  }\n}\n\n/* ---------------- TXT ---------------- */\nfunction splitTxt(text) {\n  const lines = text.replace(/\\r\\n?/g, '\\n').split('\\n');\n  const marks = [];\n  lines.forEach((ln, i) => { if (CH_RE.test(ln) && ln.trim().length <= 40) marks.push({ i, title: ln.trim() }); });\n\n  const out = [];\n  if (marks.length >= 2) {\n    // 卷首内容（第一个章节标记之前）\n    const pre = lines.slice(0, marks[0].i).join('\\n').trim();\n    if (pre) out.push({ title: '前言', text: toParas(pre) });\n    marks.forEach((m, k) => {\n      const end = k + 1 < marks.length ? marks[k + 1].i : lines.length;\n      const body = lines.slice(m.i + 1, end).join('\\n');\n      const paras = toParas(body);\n      if (paras.length) out.push({ title: m.title, text: paras });\n    });\n  } else {\n    // 无章节标记：按 2000 字切块，尽量在句号处断开\n    const paras = toParas(text);\n    let buf = [], len = 0, idx = 1;\n    for (const p of paras) {\n      buf.push(p); len += p.length;\n      if (len >= 2000) { out.push({ title: '第 ' + idx + ' 节', text: buf }); idx++; buf = []; len = 0; }\n    }\n    if (buf.length) out.push({ title: '第 ' + idx + ' 节', text: buf });\n  }\n  return out;\n}\n\nfunction toParas(text) {\n  return text.split(/\\n+/)\n    .map(s => s.replace(/^[ \\t　]+|[ \\t　]+$/g, ''))\n    .filter(s => s.length > 0);\n}\n\n/* ---------------- EPUB ---------------- */\nconst ENT = { nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '\"', apos: \"'\", ldquo: '“', rdquo: '”', mdash: '—', hellip: '…', middot: '·' };\nfunction decodeEntities(s) {\n  return s.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (m, e) => {\n    if (e[0] === '#') {\n      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);\n      return Number.isFinite(code) ? String.fromCodePoint(code) : m;\n    }\n    return ENT[e.toLowerCase()] !== undefined ? ENT[e.toLowerCase()] : m;\n  });\n}\n\n/* 图片段落约定：正文段落数组里的字符串若以 data:image/ 开头，就是一个内嵌图片\n * （完整 data URL）。渲染层按它画 <img>，分页/朗读/字数统计都要跟着处理。\n * 放 data URL 而不是文件路径，是因为解析结果只落在 cache/parsed/<id>.json，\n * 不进 data.json，也不依赖各端如何寻址本地文件。 */\nconst IMG_SENTINEL = '\\u0001';\nconst IMG_MIME = {\n  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif',\n  '.webp': 'image/webp', '.svg': 'image/svg+xml', '.bmp': 'image/bmp'\n};\nconst IMG_MAX_BYTES = 12 * 1024 * 1024;\n/* 整本预算：章节正文（含图片）会整本驻留内存（parsedCache + cache/parsed/<id>.json）。\n   图多的书（漫画 epub 常见上百 MB）不设上限会把 WebView / Electron 撑爆，\n   超预算的图不内嵌，正文照常可读。40MB 够放两三百张普通插图。 */\nconst IMG_BUDGET_BYTES = 40 * 1024 * 1024;\n\nfunction bytesToBase64(bytes) {\n  if (typeof Buffer !== 'undefined' && Buffer.from) return Buffer.from(bytes).toString('base64');\n  let s = '';\n  for (let i = 0; i < bytes.length; i += 0x8000) {\n    s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));\n  }\n  return btoa(s);\n}\n\nfunction htmlToParas(html, imgResolver) {\n  let s = html\n    .replace(/<\\?xml[\\s\\S]*?\\?>/gi, '')\n    .replace(/<(script|style|head)[\\s\\S]*?<\\/\\1>/gi, '')\n    .replace(/<!--[\\s\\S]*?-->/g, '');\n  /* <img> 先换成「整行独占的占位符」再剥标签，之后把占位行还原成 data URL 段落。\n     内联在文字中间的小图也接受换行拆段：电子书里图片几乎总是独立成段。 */\n  if (imgResolver) {\n    s = s.replace(/<img\\b[^>]*\\/?>/gi, tag => {\n      const url = imgResolver(tag);\n      return url ? '\\n' + IMG_SENTINEL + url + IMG_SENTINEL + '\\n' : '\\n';\n    });\n  }\n  s = s.replace(/<br\\s*\\/?>/gi, '\\n');\n  s = s.replace(/<\\/(p|div|h[1-6]|li|tr|blockquote|section)>/gi, '\\n');\n  s = s.replace(/<[^>]+>/g, '');\n  s = decodeEntities(s);\n  return toParas(s)\n    .map(p => {\n      if (p.charCodeAt(0) !== 1) return p;\n      const url = p.slice(1, -1);\n      return url && /^data:image\\//.test(url) ? url : null;\n    })\n    .filter(p => p !== null && p.length > 0);\n}\n\nfunction attr(tag, name) {\n  const m = new RegExp(name + '\\\\s*=\\\\s*(\"([^\"]*)\"|\\'([^\\']*)\\')', 'i').exec(tag);\n  return m ? (m[2] !== undefined ? m[2] : m[3]) : null;\n}\n\nfunction resolveHref(base, href) {\n  if (!href) return null;\n  if (/^[a-z]+:/i.test(href)) return href;\n  const clean = href.split('#')[0];\n  return path.posix.normalize(path.posix.join(path.posix.dirname(base), decodeURIComponent(clean))).replace(/^\\.\\//, '');\n}\n\nfunction parseEpub(buf) {\n  const zip = readZip(buf);\n  const container = zip.readText('META-INF/container.xml');\n  if (!container) throw new Error('EPUB 缺少 container.xml');\n  const rootMatch = /<rootfile[^>]*full-path\\s*=\\s*\"([^\"]+)\"/i.exec(container);\n  const opfPath = rootMatch ? rootMatch[1] : null;\n  if (!opfPath || !zip.has(opfPath)) throw new Error('EPUB 缺少 OPF 文件');\n  const opf = zip.readText(opfPath);\n\n  const title = decodeEntities((/<dc:title[^>]*>([\\s\\S]*?)<\\/dc:title>/i.exec(opf) || [, ''])[1]).trim() || '未命名';\n  const author = decodeEntities((/<dc:creator[^>]*>([\\s\\S]*?)<\\/dc:creator>/i.exec(opf) || [, ''])[1]).trim();\n\n  const manifest = {};\n  for (const m of opf.matchAll(/<item\\b[^>]*\\/?>/gi)) {\n    const id = attr(m[0], 'id');\n    const href = attr(m[0], 'href');\n    if (id && href) manifest[id] = {\n      href: resolveHref(opfPath, href),\n      type: attr(m[0], 'media-type') || '',\n      props: attr(m[0], 'properties') || ''\n    };\n  }\n\n  const spine = [];\n  for (const m of opf.matchAll(/<itemref\\b[^>]*\\/?>/gi)) {\n    const idref = attr(m[0], 'idref');\n    if (idref && manifest[idref]) spine.push(manifest[idref]);\n  }\n\n  // 目录：优先 nav，其次 ncx\n  const tocTitles = new Map();\n  const navItem = Object.values(manifest).find(it => /nav/.test(it.props));\n  const ncxId = (/<spine[^>]*toc\\s*=\\s*\"([^\"]+)\"/i.exec(opf) || [])[1];\n  const ncxItem = ncxId && manifest[ncxId] ? manifest[ncxId] : Object.values(manifest).find(it => /ncx/.test(it.type));\n\n  if (navItem && zip.has(navItem.href)) {\n    const nav = zip.readText(navItem.href);\n    for (const m of nav.matchAll(/<a\\b[^>]*href\\s*=\\s*\"([^\"]+)\"[^>]*>([\\s\\S]*?)<\\/a>/gi)) {\n      const href = resolveHref(navItem.href, m[1]);\n      const t = htmlToParas(m[2]).join(' ');\n      if (href && t) tocTitles.set(href, t);\n    }\n  }\n  if (!tocTitles.size && ncxItem && zip.has(ncxItem.href)) {\n    const ncx = zip.readText(ncxItem.href);\n    for (const m of ncx.matchAll(/<navLabel[^>]*>([\\s\\S]*?)<\\/navLabel>\\s*<content[^>]*src\\s*=\\s*\"([^\"]+)\"/gi)) {\n      const href = resolveHref(ncxItem.href, m[2]);\n      const t = htmlToParas(m[1]).join(' ');\n      if (href && t) tocTitles.set(href, t);\n    }\n  }\n\n  const chapters = [];\n  /* 图片提取：按 manifest 的 media-type 认类型，manifest 里没有就按扩展名猜。\n     同一本书图片往往被多个章节引用（页眉 logo 等），按 href 去重免得重复转 base64。 */\n  const byHref = {};\n  for (const it of Object.values(manifest)) if (it.type) byHref[it.href] = it.type;\n  const imgCache = new Map();\n  let imgBudget = IMG_BUDGET_BYTES;\n  const makeResolver = base => tag => {\n    const src = attr(tag, 'src');\n    if (!src || /^[a-z]+:/i.test(src)) return null;   // 外链图片离线本来也读不到\n    const clean = src.split('#')[0];\n    if (!clean) return null;\n    const dir = path.posix.dirname(base);\n    const cands = [...new Set([\n      path.posix.normalize(path.posix.join(dir, decodeURIComponent(clean))).replace(/^\\.\\//, ''),\n      path.posix.normalize(path.posix.join(dir, clean)).replace(/^\\.\\//, '')\n    ])];\n    const href = cands.find(c => zip.has(c));\n    if (!href) return null;\n    if (imgCache.has(href)) return imgCache.get(href);\n    if (imgBudget <= 0) return null;\n    const data = zip.read(href);\n    if (!data || !data.length || data.length > IMG_MAX_BYTES || data.length > imgBudget) return null;\n    const ext = path.posix.extname(href).toLowerCase();\n    const mime = (byHref[href] && /^image\\//.test(byHref[href]) ? byHref[href] : null) || IMG_MIME[ext];\n    if (!mime) return null;\n    const url = 'data:' + mime + ';base64,' + bytesToBase64(data);\n    imgBudget -= Math.round(data.length * 4 / 3);   // base64 约膨胀 4/3，按实际占用扣\n    imgCache.set(href, url);\n    return url;\n  };\n\n  spine.forEach(item => {\n    if (!zip.has(item.href)) return;\n    const html = zip.readText(item.href);\n    if (!html) return;\n    let t = tocTitles.get(item.href);\n    if (!t) {\n      const h = /<h[1-3][^>]*>([\\s\\S]*?)<\\/h[1-3]>/i.exec(html);\n      t = h ? htmlToParas(h[1]).join(' ') : null;\n    }\n    if (!t) {\n      const tm = /<title[^>]*>([\\s\\S]*?)<\\/title>/i.exec(html);\n      t = tm ? decodeEntities(tm[1]).trim() : null;\n    }\n    const paras = htmlToParas(html, makeResolver(item.href));\n    if (!paras.length) return;\n    chapters.push({ title: (t || '第 ' + (chapters.length + 1) + ' 节').slice(0, 60), text: paras });\n  });\n\n  if (!chapters.length) throw new Error('EPUB 里没有解析出正文');\n  return { title, author, chapters };\n}\n\nfunction parseLocalFile(filePath) {\n  const fs = require('fs');\n  const buf = fs.readFileSync(filePath);\n  const ext = path.extname(filePath).toLowerCase();\n  if (ext === '.epub') {\n    const r = parseEpub(buf);\n    return { kind: 'epub', title: r.title, author: r.author, chapters: r.chapters };\n  }\n  const text = decodeBuffer(buf);\n  const chapters = splitTxt(text);\n  if (!chapters.length) throw new Error('文件里没有可读文本');\n  return { kind: 'txt', title: path.basename(filePath, ext), author: '', chapters };\n}\n\nmodule.exports = { parseLocalFile, parseEpub, splitTxt, decodeBuffer };\n","store":"'use strict';\n/**\n * 数据层：单文件 JSON 存档（对标 Legado 的「备份/恢复」）\n *  - data.json    书架 / 书源 / 进度 / 书签 / 历史 / 设置 / 统计\n *  - books/       导入的本地书原文件\n *  - cache/       在线章节正文缓存\n */\nconst fs = require('fs');\nconst path = require('path');\n\nlet root, dataFile, booksDir, cacheDir;\nlet state;\nlet dirty = false;\nlet timer = null;\n\nfunction defaults() {\n  return {\n    version: 2,\n    books: [],\n    sources: [],\n    groups: [{ id: 'g_default', name: '默认分组' }],\n    progress: {},\n    bookmarks: [],\n    history: [],\n    stats: {},\n    settings: {\n      fontSize: 19,\n      /* 1.7 接近纸书；旧版默认 2.0 太散，一屏少看四五列字（typoV2 迁移见 ui/app.js） */\n      lineHeight: 1.7,\n      fontFamily: 'serif',\n      theme: 'paper',\n      pageMode: 'scroll',\n      /* 段距独立成 em 值：以前由行距推导（行距 2.0 时段距跟着 1.05em），\n         行距一调段距就跟着跳，用户没法单独把段落压紧 */\n      paraGapEm: 0.5,\n      paraGap: true,\n      /* 排版迁移版本：0 = 还没按新默认值校正过 */\n      typoV: 0,\n      autoSave: true,\n      minimizeToTray: true,\n      closeToTray: false,\n      maxConcurrent: 3,\n      searchLimit: 40,\n      /* 书架：排序方式与封面大小（都是纯展示偏好，换设备/恢复备份时一起带走） */\n      shelfSort: 'recent',\n      shelfSize: 'md',\n      /* 换源：一次最多搜多少个源 */\n      switchLimit: 24,\n      /* 书源检测并发数：0 = 按设备自动（手机 5 / 电脑 8） */\n      detectConc: 0,\n      autoCacheNext: true,\n      tts: { voiceURI: '', rate: 1, pitch: 1, autoNext: true },\n      webdav: {\n        enabled: false, url: 'https://dav.jianguoyun.com/dav/', user: '', pass: '',\n        dir: 'legado', autoBackup: false, intervalHours: 24, keep: 10,\n        lastBackupAt: 0, lastBackupName: '', lastSyncAt: 0\n      },\n      webSearch: { engine: 'bing', keyword: '' }\n    }\n  };\n}\n\n/** 嵌套设置项要深合并，否则旧存档会丢掉新增字段 */\nfunction mergeSettings(base, inc) {\n  const out = Object.assign({}, base, inc || {});\n  out.tts = Object.assign({}, base.tts, (inc && inc.tts) || {});\n  out.webdav = Object.assign({}, base.webdav, (inc && inc.webdav) || {});\n  out.webSearch = Object.assign({}, base.webSearch, (inc && inc.webSearch) || {});\n  return out;\n}\n\nfunction init(userDataDir) {\n  root = userDataDir;\n  dataFile = path.join(root, 'data.json');\n  booksDir = path.join(root, 'books');\n  cacheDir = path.join(root, 'cache');\n  fs.mkdirSync(booksDir, { recursive: true });\n  fs.mkdirSync(cacheDir, { recursive: true });\n\n  if (fs.existsSync(dataFile)) {\n    try {\n      const raw = JSON.parse(fs.readFileSync(dataFile, 'utf8'));\n      state = Object.assign(defaults(), raw);\n      state.settings = mergeSettings(defaults().settings, raw.settings);\n      if (!Array.isArray(state.groups) || !state.groups.length) state.groups = defaults().groups;\n    } catch (e) {\n      const bak = dataFile + '.broken-' + Date.now();\n      try { fs.renameSync(dataFile, bak); } catch (_) {}\n      state = defaults();\n    }\n  } else {\n    state = defaults();\n    seed();\n    saveNow();\n  }\n}\n\n/** 首次启动放两条示例书源，方便用户理解字段结构 */\nfunction seed() {\n  state.sources = [\n    {\n      id: 'src_demo_1',\n      name: '示例源 · 结构参考',\n      url: 'https://example.com',\n      group: '示例',\n      enabled: false,\n      type: 'legado',\n      charset: 'auto',\n      searchUrl: 'https://example.com/search?q={{key}}',\n      ruleSearch: {\n        bookList: '.result .item',\n        name: 'h3 a@text',\n        author: '.author@text',\n        bookUrl: 'h3 a@href',\n        intro: '.intro@text',\n        coverUrl: 'img@src'\n      },\n      ruleBookInfo: { tocUrl: '#catalog@href' },\n      ruleToc: { chapterList: '#list dd', chapterName: 'a@text', chapterUrl: 'a@href' },\n      ruleContent: { content: '#content' },\n      icon: '示',\n      comment: '把 url / searchUrl / 规则改成目标站点即可。规则支持 CSS 选择器 + @text/@href/@src。'\n    },\n    {\n      id: 'src_demo_2',\n      name: '示例源 · JSON 书源',\n      url: 'https://example.org',\n      group: '示例',\n      enabled: false,\n      type: 'legado',\n      charset: 'auto',\n      searchUrl: 'https://example.org/api/search?kw={{key}}',\n      ruleSearch: {\n        bookList: '$.data.list[*]',\n        name: '$.name',\n        author: '$.author',\n        bookUrl: '$.url',\n        intro: '$.intro',\n        coverUrl: '$.cover'\n      },\n      ruleBookInfo: { tocUrl: '$.tocUrl' },\n      ruleToc: { chapterList: '$.chapters[*]', chapterName: '$.title', chapterUrl: '$.url' },\n      ruleContent: { content: '$.content' },\n      icon: 'JS',\n      comment: '以 $ 开头的规则按 JSON 路径解析，适合接口型站点。'\n    }\n  ];\n}\n\nfunction getState() {\n  return state;\n}\n\nfunction setState(next) {\n  state = Object.assign(defaults(), next);\n  state.settings = mergeSettings(defaults().settings, next.settings);\n  saveNow();\n  return state;\n}\n\nfunction scheduleSave() {\n  dirty = true;\n  if (timer) return;\n  timer = setTimeout(() => { timer = null; if (dirty) saveNow(); }, 800);\n}\n\nfunction saveNow() {\n  dirty = false;\n  const tmp = dataFile + '.tmp';\n  try {\n    fs.writeFileSync(tmp, JSON.stringify(state));\n    fs.renameSync(tmp, dataFile);\n  } catch (e) {\n    console.error('保存失败', e);\n  }\n}\n\n/* ---------------- 本地书文件 ---------------- */\nfunction importBookFile(srcPath, id) {\n  const ext = path.extname(srcPath).toLowerCase();\n  const dest = path.join(booksDir, id + ext);\n  fs.copyFileSync(srcPath, dest);\n  return { file: path.join('books', id + ext), ext, size: fs.statSync(dest).size };\n}\nfunction bookFilePath(rel) {\n  return path.join(root, rel);\n}\nfunction removeBookFile(rel) {\n  if (!rel) return;\n  try { fs.unlinkSync(path.join(root, rel)); } catch (e) {}\n}\n\n/* ---------------- 章节缓存 ---------------- */\nfunction cachePath(bookId, idx) {\n  return path.join(cacheDir, String(bookId), String(idx) + '.json');\n}\nfunction getCache(bookId, idx) {\n  const p = cachePath(bookId, idx);\n  if (!fs.existsSync(p)) return null;\n  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return null; }\n}\nfunction setCache(bookId, idx, payload) {\n  const p = cachePath(bookId, idx);\n  fs.mkdirSync(path.dirname(p), { recursive: true });\n  fs.writeFileSync(p, JSON.stringify(Object.assign({ at: Date.now() }, payload)));\n}\nfunction clearCache(bookId) {\n  const dir = bookId ? path.join(cacheDir, String(bookId)) : cacheDir;\n  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {}\n  fs.mkdirSync(cacheDir, { recursive: true });\n}\nfunction cacheSize() {\n  let total = 0;\n  const walk = d => {\n    let list = [];\n    try { list = fs.readdirSync(d, { withFileTypes: true }); } catch (e) { return; }\n    for (const f of list) {\n      const p = path.join(d, f.name);\n      if (f.isDirectory()) walk(p);\n      else { try { total += fs.statSync(p).size; } catch (e) {} }\n    }\n  };\n  walk(cacheDir);\n  return total;\n}\n\n/* ---------------- 备份 / 恢复 ---------------- */\n/** 读本地书原始字节（导出 zip 用） */\nfunction readLocalFile(rel) {\n  try { return fs.readFileSync(path.join(root, rel)); } catch (e) { return null; }\n}\n\n/** 把 zip 里取出的本地书写进 books/，返回相对路径 */\nfunction writeLocalBook(id, ext, buffer, relHint) {\n  const rel = relHint || path.join('books', id + (ext || '.txt'));\n  const abs = path.join(root, rel);\n  fs.mkdirSync(path.dirname(abs), { recursive: true });\n  fs.writeFileSync(abs, buffer);\n  return rel;\n}\n\nfunction exportBackup(includeLocalBooks) {\n  const payload = {\n    app: 'moread',\n    schema: 1,\n    exportedAt: new Date().toISOString(),\n    data: JSON.parse(JSON.stringify(state))\n  };\n  if (includeLocalBooks) {\n    payload.files = {};\n    for (const b of state.books) {\n      if (b.kind === 'local' && b.localFile) {\n        const p = path.join(root, b.localFile);\n        if (fs.existsSync(p)) payload.files[b.id] = fs.readFileSync(p).toString('base64');\n      }\n    }\n  }\n  return payload;\n}\n\nfunction restoreBackup(payload, mode) {\n  if (!payload || payload.app !== 'moread' || !payload.data) {\n    throw new Error('这不是墨读的备份文件');\n  }\n  const inc = payload.data;\n  if (mode === 'replace') {\n    state = Object.assign(defaults(), inc);\n    state.settings = mergeSettings(defaults().settings, inc.settings);\n  } else {\n    // merge：同 id 覆盖，新 id 追加\n    const mergeById = (arr, incArr) => {\n      const map = new Map(arr.map(x => [x.id, x]));\n      for (const x of incArr || []) map.set(x.id, x);\n      return [...map.values()];\n    };\n    state.books = mergeById(state.books, inc.books);\n    state.sources = mergeById(state.sources, inc.sources);\n    state.groups = mergeById(state.groups, inc.groups);\n    state.bookmarks = mergeById(state.bookmarks, inc.bookmarks);\n    state.history = mergeById(state.history, inc.history);\n    state.progress = Object.assign({}, state.progress, inc.progress || {});\n    state.stats = Object.assign({}, state.stats, inc.stats || {});\n    state.settings = Object.assign({}, state.settings, inc.settings || {});\n  }\n  // 还原本地书文件\n  if (payload.files) {\n    for (const [id, b64] of Object.entries(payload.files)) {\n      const book = state.books.find(b => b.id === id);\n      if (!book) continue;\n      const ext = path.extname(book.localFile || '.txt') || '.txt';\n      const rel = book.localFile || path.join('books', id + ext);\n      fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });\n      fs.writeFileSync(path.join(root, rel), Buffer.from(b64, 'base64'));\n      book.localFile = rel;\n    }\n  }\n  saveNow();\n  return state;\n}\n\nfunction dirs() { return { root, booksDir, cacheDir, dataFile }; }\n\nmodule.exports = {\n  init, getState, setState, scheduleSave, saveNow,\n  importBookFile, bookFilePath, removeBookFile,\n  getCache, setCache, clearCache, cacheSize,\n  exportBackup, restoreBackup, dirs, mergeSettings,\n  readLocalFile, writeLocalBook\n};\n"};})();
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

