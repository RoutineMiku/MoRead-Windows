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
  '.webp': 'image/webp', '.svg': 'image/svg+xml', '.bmp': 'image/bmp', '.avif': 'image/avif'
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

function utf8Bytes(str) {
  if (typeof Buffer !== 'undefined' && Buffer.from) return Buffer.from(str, 'utf8');
  if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(str);
  const bin = unescape(encodeURIComponent(str));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function htmlToParas(html, imgResolver) {
  let s = html
    .replace(/<\?xml[\s\S]*?\?>/gi, '')
    .replace(/<(script|style|head)[\s\S]*?<\/\1>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '');
  /* <img> 先换成「整行独占的占位符」再剥标签，之后把占位行还原成 data URL 段落。
     内联在文字中间的小图也接受换行拆段：电子书里图片几乎总是独立成段。 */
  if (imgResolver) {
    /* <svg> 块要先于 <img> 处理：calibre 转出来的封面 / 插图页经常是
       「<svg viewBox=…><image xlink:href="cover.jpeg"/></svg>」这种外壳，
       只认 <img> 的话整段会被剥标签剥成空白页 —— 用户看到的就是「图不显示」。 */
    s = s.replace(/<svg\b[\s\S]*?<\/svg>/gi, block => {
      const urls = [];
      block.replace(/<image\b[^>]*>/gi, tag => {
        const u = imgResolver(tag);
        if (u) urls.push(u);
        return '';
      });
      if (urls.length) return '\n' + urls.map(u => IMG_SENTINEL + u + IMG_SENTINEL).join('\n') + '\n';
      /* 没有 <image> 的，是真矢量图（地图、装饰线、公式），整段内嵌成 svg */
      const u = imgResolver(block);
      return u ? '\n' + IMG_SENTINEL + u + IMG_SENTINEL + '\n' : '\n';
    });
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

  /** 书内相对路径 → zip 里的实际条目名（找不到返回 null） */
  const findHref = (src, base) => {
    const clean = String(src || '').split('#')[0];
    if (!clean) return null;
    let dec = clean;
    try { dec = decodeURIComponent(clean); } catch (e) { dec = clean; }
    const dir = path.posix.dirname(base);
    const cands = [...new Set([
      path.posix.normalize(path.posix.join(dir, dec)).replace(/^\.\//, ''),
      path.posix.normalize(path.posix.join(dir, clean)).replace(/^\.\//, '')
    ])];
    return cands.find(c => zip.has(c)) || null;
  };

  /* EPUB 里的 svg 有两种：
     1. calibre 生成的「一页一张图」外壳：<svg viewBox=…><image xlink:href="cover.jpeg"/></svg>
        —— <img src="data:image/svg+xml…"> 在浏览器里不允许再去读外部文件，原样塞进去
        就是一片空白，所以必须把它包的那张位图挖出来。
     2. 真矢量（地图、装饰线）：没有外链，整段内嵌即可。
     svgHref 是这个 svg 自己的路径，用来把它内部的相对引用换算成 zip 条目。 */
  const svgDataUrl = (data, svgHref) => {
    let text = '';
    try { text = typeof data === 'string' ? data : data.toString('utf8'); } catch (e) { return null; }
    if (!/<svg/i.test(text)) return null;
    let broken = false;
    const inner = text.replace(/<image\b[^>]*>/gi, tag => {
      const ref = attr(tag, 'xlink:href') || attr(tag, 'href');
      if (!ref || /^data:/i.test(ref)) return tag;
      const url = /^[a-z][a-z0-9+.-]*:/i.test(ref) ? null : resolveImgRef(ref, svgHref);
      if (!url) { broken = true; return tag; }
      return tag.replace(/(xlink:href|href)\s*=\s*(["'])[^"']*\2/i, (m, k, q) => k + '=' + q + url + q);
    });
    if (broken) return null;                                  // 图的实体不在包里，别塞个空壳
    /* 还有别的外链（<use href> 之类）也放弃，免得渲染成空白图占一屏 */
    if (/(?:xlink:href|href)\s*=\s*["'](?!data:)[^"']*\.(?:png|jpe?g|gif|webp|svg|bmp)/i.test(inner)) return null;
    return 'data:image/svg+xml;base64,' + bytesToBase64(utf8Bytes(inner));
  };

  /** 单个图片引用 → data URL（位图按字节直传，svg 走 svgDataUrl 处理） */
  const resolveImgRef = (src, base) => {
    const href = findHref(src, base);
    if (!href) return null;
    if (imgCache.has(href)) return imgCache.get(href);
    if (imgBudget <= 0) return null;
    const data = zip.read(href);
    if (!data || !data.length) return null;
    const ext = path.posix.extname(href).toLowerCase();
    const mime = (byHref[href] && /^image\//.test(byHref[href]) ? byHref[href] : null) || IMG_MIME[ext];
    if (!mime) return null;
    if (mime === 'image/svg+xml') {
      const url = svgDataUrl(data, href);
      if (!url || url.length > imgBudget) return null;
      imgBudget -= url.length;
      imgCache.set(href, url);
      return url;
    }
    if (data.length > IMG_MAX_BYTES || data.length > imgBudget) return null;
    const url = 'data:' + mime + ';base64,' + bytesToBase64(data);
    imgBudget -= Math.round(data.length * 4 / 3);   // base64 约膨胀 4/3，按实际占用扣
    imgCache.set(href, url);
    return url;
  };

  /* 解析器既吃 <img>/<image> 标签，也吃一整段内联 <svg>（纯矢量） */
  const makeResolver = base => tag => {
    if (/^<svg/i.test(tag)) {
      const url = svgDataUrl(tag, base);
      if (!url || url.length > imgBudget) return null;
      imgBudget -= url.length;
      return url;
    }
    const src = attr(tag, 'src') || attr(tag, 'xlink:href') || attr(tag, 'href');
    if (!src || /^[a-z]+:/i.test(src)) return null;   // 外链图片离线本来也读不到
    return resolveImgRef(src, base);
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
