'use strict';
/**
 * 本地书解析：TXT（编码探测 + 中文章节）与 EPUB（OPF/spine/NCX/nav）
 */
const path = require('path');
const { readZip } = require('./zip');

const CH_RE = /^[ \t　]*(第[零一二三四五六七八九十百千万两0-9]{1,9}[章节回卷篇集][^\n]{0,30}|Chapter\s+\d+[^\n]{0,30}|正文[ \t]*第?[0-9零一二三四五六七八九十百千]{1,9}[章节回][^\n]{0,30})[ \t　]*$/;

function decodeBuffer(buf) {
  if (buf.length > 3 && buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF) {
    return new TextDecoder('utf-8').decode(buf.subarray(3));
  }
  if (buf.length > 1 && buf[0] === 0xFF && buf[1] === 0xFE) {
    return new TextDecoder('utf-16le').decode(buf.subarray(2));
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch (e) {
    return new TextDecoder('gb18030').decode(buf);
  }
}

/* ---------------- TXT ---------------- */
function splitTxt(text) {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const marks = [];
  lines.forEach((ln, i) => { if (CH_RE.test(ln) && ln.trim().length <= 40) marks.push({ i, title: ln.trim() }); });

  const out = [];
  if (marks.length >= 2) {
    // 卷首内容（第一个章节标记之前）
    const pre = lines.slice(0, marks[0].i).join('\n').trim();
    if (pre) out.push({ title: '前言', text: toParas(pre) });
    marks.forEach((m, k) => {
      const end = k + 1 < marks.length ? marks[k + 1].i : lines.length;
      const body = lines.slice(m.i + 1, end).join('\n');
      const paras = toParas(body);
      if (paras.length) out.push({ title: m.title, text: paras });
    });
  } else {
    // 无章节标记：按 2000 字切块，尽量在句号处断开
    const paras = toParas(text);
    let buf = [], len = 0, idx = 1;
    for (const p of paras) {
      buf.push(p); len += p.length;
      if (len >= 2000) { out.push({ title: '第 ' + idx + ' 节', text: buf }); idx++; buf = []; len = 0; }
    }
    if (buf.length) out.push({ title: '第 ' + idx + ' 节', text: buf });
  }
  return out;
}

function toParas(text) {
  return text.split(/\n+/)
    .map(s => s.replace(/^[ \t　]+|[ \t　]+$/g, ''))
    .filter(s => s.length > 0);
}

/* ---------------- EPUB ---------------- */
const ENT = { nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", ldquo: '“', rdquo: '”', mdash: '—', hellip: '…', middot: '·' };
function decodeEntities(s) {
  return s.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (m, e) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return ENT[e.toLowerCase()] !== undefined ? ENT[e.toLowerCase()] : m;
  });
}

/* 图片段落约定：正文段落数组里的字符串若以 data:image/ 开头，就是一个内嵌图片
 * （完整 data URL）。渲染层按它画 <img>，分页/朗读/字数统计都要跟着处理。
 * 放 data URL 而不是文件路径，是因为解析结果只落在 cache/parsed/<id>.json，
 * 不进 data.json，也不依赖各端如何寻址本地文件。 */
const IMG_SENTINEL = '\u0001';
const IMG_MIME = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif',
  '.webp': 'image/webp', '.svg': 'image/svg+xml', '.bmp': 'image/bmp'
};
const IMG_MAX_BYTES = 12 * 1024 * 1024;
/* 整本预算：章节正文（含图片）会整本驻留内存（parsedCache + cache/parsed/<id>.json）。
   图多的书（漫画 epub 常见上百 MB）不设上限会把 WebView / Electron 撑爆，
   超预算的图不内嵌，正文照常可读。40MB 够放两三百张普通插图。 */
const IMG_BUDGET_BYTES = 40 * 1024 * 1024;

function bytesToBase64(bytes) {
  if (typeof Buffer !== 'undefined' && Buffer.from) return Buffer.from(bytes).toString('base64');
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(s);
}

function htmlToParas(html, imgResolver) {
  let s = html
    .replace(/<\?xml[\s\S]*?\?>/gi, '')
    .replace(/<(script|style|head)[\s\S]*?<\/\1>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '');
  /* <img> 先换成「整行独占的占位符」再剥标签，之后把占位行还原成 data URL 段落。
     内联在文字中间的小图也接受换行拆段：电子书里图片几乎总是独立成段。 */
  if (imgResolver) {
    s = s.replace(/<img\b[^>]*\/?>/gi, tag => {
      const url = imgResolver(tag);
      return url ? '\n' + IMG_SENTINEL + url + IMG_SENTINEL + '\n' : '\n';
    });
  }
  s = s.replace(/<br\s*\/?>/gi, '\n');
  s = s.replace(/<\/(p|div|h[1-6]|li|tr|blockquote|section)>/gi, '\n');
  s = s.replace(/<[^>]+>/g, '');
  s = decodeEntities(s);
  return toParas(s)
    .map(p => {
      if (p.charCodeAt(0) !== 1) return p;
      const url = p.slice(1, -1);
      return url && /^data:image\//.test(url) ? url : null;
    })
    .filter(p => p !== null && p.length > 0);
}

function attr(tag, name) {
  const m = new RegExp(name + '\\s*=\\s*("([^"]*)"|\'([^\']*)\')', 'i').exec(tag);
  return m ? (m[2] !== undefined ? m[2] : m[3]) : null;
}

function resolveHref(base, href) {
  if (!href) return null;
  if (/^[a-z]+:/i.test(href)) return href;
  const clean = href.split('#')[0];
  return path.posix.normalize(path.posix.join(path.posix.dirname(base), decodeURIComponent(clean))).replace(/^\.\//, '');
}

function parseEpub(buf) {
  const zip = readZip(buf);
  const container = zip.readText('META-INF/container.xml');
  if (!container) throw new Error('EPUB 缺少 container.xml');
  const rootMatch = /<rootfile[^>]*full-path\s*=\s*"([^"]+)"/i.exec(container);
  const opfPath = rootMatch ? rootMatch[1] : null;
  if (!opfPath || !zip.has(opfPath)) throw new Error('EPUB 缺少 OPF 文件');
  const opf = zip.readText(opfPath);

  const title = decodeEntities((/<dc:title[^>]*>([\s\S]*?)<\/dc:title>/i.exec(opf) || [, ''])[1]).trim() || '未命名';
  const author = decodeEntities((/<dc:creator[^>]*>([\s\S]*?)<\/dc:creator>/i.exec(opf) || [, ''])[1]).trim();

  const manifest = {};
  for (const m of opf.matchAll(/<item\b[^>]*\/?>/gi)) {
    const id = attr(m[0], 'id');
    const href = attr(m[0], 'href');
    if (id && href) manifest[id] = {
      href: resolveHref(opfPath, href),
      type: attr(m[0], 'media-type') || '',
      props: attr(m[0], 'properties') || ''
    };
  }

  const spine = [];
  for (const m of opf.matchAll(/<itemref\b[^>]*\/?>/gi)) {
    const idref = attr(m[0], 'idref');
    if (idref && manifest[idref]) spine.push(manifest[idref]);
  }

  // 目录：优先 nav，其次 ncx
  const tocTitles = new Map();
  const navItem = Object.values(manifest).find(it => /nav/.test(it.props));
  const ncxId = (/<spine[^>]*toc\s*=\s*"([^"]+)"/i.exec(opf) || [])[1];
  const ncxItem = ncxId && manifest[ncxId] ? manifest[ncxId] : Object.values(manifest).find(it => /ncx/.test(it.type));

  if (navItem && zip.has(navItem.href)) {
    const nav = zip.readText(navItem.href);
    for (const m of nav.matchAll(/<a\b[^>]*href\s*=\s*"([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi)) {
      const href = resolveHref(navItem.href, m[1]);
      const t = htmlToParas(m[2]).join(' ');
      if (href && t) tocTitles.set(href, t);
    }
  }
  if (!tocTitles.size && ncxItem && zip.has(ncxItem.href)) {
    const ncx = zip.readText(ncxItem.href);
    for (const m of ncx.matchAll(/<navLabel[^>]*>([\s\S]*?)<\/navLabel>\s*<content[^>]*src\s*=\s*"([^"]+)"/gi)) {
      const href = resolveHref(ncxItem.href, m[2]);
      const t = htmlToParas(m[1]).join(' ');
      if (href && t) tocTitles.set(href, t);
    }
  }

  const chapters = [];
  /* 图片提取：按 manifest 的 media-type 认类型，manifest 里没有就按扩展名猜。
     同一本书图片往往被多个章节引用（页眉 logo 等），按 href 去重免得重复转 base64。 */
  const byHref = {};
  for (const it of Object.values(manifest)) if (it.type) byHref[it.href] = it.type;
  const imgCache = new Map();
  let imgBudget = IMG_BUDGET_BYTES;
  const makeResolver = base => tag => {
    const src = attr(tag, 'src');
    if (!src || /^[a-z]+:/i.test(src)) return null;   // 外链图片离线本来也读不到
    const clean = src.split('#')[0];
    if (!clean) return null;
    const dir = path.posix.dirname(base);
    const cands = [...new Set([
      path.posix.normalize(path.posix.join(dir, decodeURIComponent(clean))).replace(/^\.\//, ''),
      path.posix.normalize(path.posix.join(dir, clean)).replace(/^\.\//, '')
    ])];
    const href = cands.find(c => zip.has(c));
    if (!href) return null;
    if (imgCache.has(href)) return imgCache.get(href);
    if (imgBudget <= 0) return null;
    const data = zip.read(href);
    if (!data || !data.length || data.length > IMG_MAX_BYTES || data.length > imgBudget) return null;
    const ext = path.posix.extname(href).toLowerCase();
    const mime = (byHref[href] && /^image\//.test(byHref[href]) ? byHref[href] : null) || IMG_MIME[ext];
    if (!mime) return null;
    const url = 'data:' + mime + ';base64,' + bytesToBase64(data);
    imgBudget -= Math.round(data.length * 4 / 3);   // base64 约膨胀 4/3，按实际占用扣
    imgCache.set(href, url);
    return url;
  };

  spine.forEach(item => {
    if (!zip.has(item.href)) return;
    const html = zip.readText(item.href);
    if (!html) return;
    let t = tocTitles.get(item.href);
    if (!t) {
      const h = /<h[1-3][^>]*>([\s\S]*?)<\/h[1-3]>/i.exec(html);
      t = h ? htmlToParas(h[1]).join(' ') : null;
    }
    if (!t) {
      const tm = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
      t = tm ? decodeEntities(tm[1]).trim() : null;
    }
    const paras = htmlToParas(html, makeResolver(item.href));
    if (!paras.length) return;
    chapters.push({ title: (t || '第 ' + (chapters.length + 1) + ' 节').slice(0, 60), text: paras });
  });

  if (!chapters.length) throw new Error('EPUB 里没有解析出正文');
  return { title, author, chapters };
}

function parseLocalFile(filePath) {
  const fs = require('fs');
  const buf = fs.readFileSync(filePath);
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.epub') {
    const r = parseEpub(buf);
    return { kind: 'epub', title: r.title, author: r.author, chapters: r.chapters };
  }
  const text = decodeBuffer(buf);
  const chapters = splitTxt(text);
  if (!chapters.length) throw new Error('文件里没有可读文本');
  return { kind: 'txt', title: path.basename(filePath, ext), author: '', chapters };
}

module.exports = { parseLocalFile, parseEpub, splitTxt, decodeBuffer };
