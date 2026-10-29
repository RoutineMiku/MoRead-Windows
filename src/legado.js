'use strict';
/**
 * 与原版「阅读 Legado」互通的数据格式
 *  - 导出：备份 zip 内同时写入 Legado 认识的 bookSource.json / bookshelf.json /
 *          bookmark.json / readRecord.json / bookGroup.json，原版 App 可直接从该 zip 恢复
 *  - 导入：能识别 Legado 的备份 zip 与单独的 bookSource.json
 * 字段说明参考 Legado 的 BookSource / Book / Bookmark / ReadRecord 数据结构
 */
const fs = require('fs');
const { readZip, writeZip } = require('./zip');

/* ---------------- 导出：内部结构 → Legado ---------------- */
function toLegadoSources(sources) {
  return (sources || []).map((s, i) => ({
    bookSourceUrl: s.url || '',
    bookSourceName: s.name || '未命名书源',
    bookSourceGroup: s.group || '',
    bookSourceType: 0,
    bookSourceComment: s.comment || '',
    enabled: s.enabled !== false,
    enabledExplore: false,
    customOrder: i,
    searchUrl: s.searchUrl || '',
    charset: s.charset && s.charset !== 'auto' ? s.charset : undefined,
    ruleSearch: {
      bookList: s.ruleSearch?.bookList || '',
      name: s.ruleSearch?.name || '',
      author: s.ruleSearch?.author || '',
      intro: s.ruleSearch?.intro || '',
      kind: s.ruleSearch?.kind || '',
      lastChapter: s.ruleSearch?.lastChapter || '',
      bookUrl: s.ruleSearch?.bookUrl || '',
      coverUrl: s.ruleSearch?.coverUrl || ''
    },
    ruleBookInfo: {
      name: s.ruleBookInfo?.name || '',
      author: s.ruleBookInfo?.author || '',
      intro: s.ruleBookInfo?.intro || '',
      coverUrl: s.ruleBookInfo?.coverUrl || '',
      tocUrl: s.ruleBookInfo?.tocUrl || ''
    },
    ruleToc: {
      chapterList: s.ruleToc?.chapterList || '',
      chapterName: s.ruleToc?.chapterName || '',
      chapterUrl: s.ruleToc?.chapterUrl || '',
      nextTocUrl: s.ruleToc?.nextTocUrl || ''
    },
    ruleContent: {
      content: s.ruleContent?.content || '',
      nextContentUrl: s.ruleContent?.nextContentUrl || ''
    }
  }));
}

function groupIndex(groups, gid) {
  const i = (groups || []).findIndex(g => g.id === (gid || 'g_default'));
  return i < 0 ? 0 : i;
}

function toLegadoBooks(books, progress, groups, sources) {
  return (books || []).map((b, i) => {
    const p = (progress || {})[b.id] || {};
    const local = b.kind === 'local';
    const src = (sources || []).find(s => s.id === b.sourceId) || {};
    return {
      bookUrl: local ? 'file:///' + (b.localFile || b.name) : (b.bookUrl || ''),
      origin: local ? 'local' : (src.url || ''),
      originName: local ? '本地' : (b.sourceName || src.name || ''),
      name: b.name || '',
      author: b.author || '',
      coverUrl: b.cover || '',
      intro: b.intro || '',
      type: local ? 1 : 0,
      group: groupIndex(groups, b.groupId),
      latestChapterTitle: (b.chapters && b.chapters.length) ? String(b.chapters[b.chapters.length - 1].title || '') : '',
      latestChapterTime: b.updatedAt || b.createdAt || 0,
      lastCheckTime: b.updatedAt || 0,
      chapterListSize: b.total || (b.chapters ? b.chapters.length : 0),
      durChapterIndex: p.ci || 0,
      durChapterTitle: p.title || '',
      durChapterPos: 0,
      durChapterTime: p.at || 0,
      canUpdate: !local,
      order: i,
      totalChapterNum: b.total || 0
    };
  });
}

function toLegadoBookmarks(bookmarks) {
  return (bookmarks || []).map(bm => ({
    bookName: bm.name || '',
    bookAuthor: bm.author || '',
    chapterIndex: bm.ci || 0,
    chapterPos: 0,
    chapterTitle: bm.title || '',
    bookText: bm.text || '',
    content: bm.text || '',
    createTime: bm.at || Date.now()
  }));
}

function toLegadoReadRecords(history) {
  return (history || []).map(h => ({
    bookName: h.name || '',
    author: h.author || '',
    readTime: h.at || 0,
    lastRead: h.at || 0,
    chapterIndex: h.ci || 0,
    chapterPos: 0,
    chapterTitle: h.title || ''
  }));
}

/* ---------------- 导入：Legado → 内部结构 ---------------- */
function pickStr(o, ...keys) {
  for (const k of keys) {
    if (o && o[k] != null && o[k] !== '') return o[k];
  }
  return '';
}

/** 把 Legado 的 bookSource 数组收敛成可交给渲染层归一化的裸对象 */
function rawSourcesFromLegado(arr) {
  const list = Array.isArray(arr) ? arr : (arr && arr.bookSources) || [];
  return list.filter(x => x && (x.bookSourceName || x.name));
}

function normalizeUrl(u) {
  return String(u || '').trim().replace(/\/+$/, '').toLowerCase()
    .replace(/^https?:\/\//, '').replace(/^www\./, '');
}

/** Legado 书架项 → 我们的书；返回 { books, skipped } */
function rawBooksFromLegado(arr) {
  const list = Array.isArray(arr) ? arr : (arr && arr.books) || [];
  const out = [], skipped = [];
  for (const b of list) {
    if (!b || (!b.name && !b.bookUrl)) continue;
    const url = String(b.bookUrl || '');
    // 原版本地书带的是手机路径（/storage/... 或 content://），桌面端无法还原
    const isLocal = /^file:\/\//.test(url) || /^content:\/\//.test(url)
      || /^\/storage\//.test(url) || b.origin === 'local' || b.localBook === true;
    if (isLocal) { skipped.push(b.name || b.bookUrl); continue; }
    out.push({
      name: pickStr(b, 'name'),
      author: pickStr(b, 'author') || '佚名',
      bookUrl: pickStr(b, 'bookUrl'),
      origin: normalizeUrl(pickStr(b, 'origin')),
      originName: pickStr(b, 'originName'),
      intro: pickStr(b, 'intro'),
      cover: pickStr(b, 'coverUrl'),
      group: Number(b.group != null ? b.group : 0) || 0,
      total: Number(pickStr(b, 'chapterListSize') || pickStr(b, 'totalChapterNum') || 0) || 0,
      durChapterIndex: Number(pickStr(b, 'durChapterIndex') || 0) || 0,
      durChapterTitle: pickStr(b, 'durChapterTitle'),
      durChapterTime: Number(pickStr(b, 'durChapterTime') || 0) || 0
    });
  }
  return { books: out, skipped };
}

/** Legado 的自定义分组（负数 groupId 是系统分组：全部/本地/音频…） */
function rawGroupsFromLegado(arr) {
  const list = Array.isArray(arr) ? arr : [];
  const map = new Map();
  for (const g of list) {
    if (!g) continue;
    const gid = Number(g.groupId);
    if (!isFinite(gid) || gid < 0) continue;
    map.set(gid, String(g.groupName || ('分组' + gid)));
  }
  return map;
}

function rawBookmarksFromLegado(arr) {
  const list = Array.isArray(arr) ? arr : [];
  return list.filter(b => b && (b.bookName || b.bookUrl)).map(b => ({
    bookName: pickStr(b, 'bookName'),
    bookUrl: pickStr(b, 'bookUrl'),
    ci: Number(pickStr(b, 'chapterIndex') || 0) || 0,
    title: pickStr(b, 'chapterTitle'),
    text: pickStr(b, 'bookText') || pickStr(b, 'content'),
    at: Number(pickStr(b, 'createTime') || 0) || Date.now()
  }));
}

function rawReadRecordsFromLegado(arr) {
  const list = Array.isArray(arr) ? arr : (arr && typeof arr === 'object' ? Object.values(arr) : []);
  return list.filter(r => r && r.bookName).map(r => ({
    bookName: pickStr(r, 'bookName'),
    ci: Number(pickStr(r, 'chapterIndex') || 0) || 0,
    title: pickStr(r, 'chapterTitle'),
    at: Number(pickStr(r, 'lastRead') || pickStr(r, 'readTime') || 0) || Date.now()
  }));
}

/* ---------------- 备份 zip ---------------- */
/**
 * @param state 完整存档
 * @param opts  { includeFiles:boolean, readBookFile:(rel)=>Buffer|null }
 */
function buildBackupZip(state, opts = {}) {
  const files = [];
  const groups = state.groups || [];
  const bookGroups = groups.map((g, i) => ({ groupId: i, groupName: g.name || '分组' + i, order: i }));
  if (!bookGroups.length) bookGroups.push({ groupId: 0, groupName: '默认分组', order: 0 });

  const fileMap = {};
  if (opts.includeFiles) {
    for (const b of state.books || []) {
      if (b.kind !== 'local' || !b.localFile) continue;
      const buf = opts.readBookFile ? opts.readBookFile(b.localFile) : null;
      if (!buf) continue;
      const name = 'files/' + b.id + (b.ext || '.txt');
      files.push({ name, data: buf });
      fileMap[b.id] = { path: name, ext: b.ext || '.txt', localFile: b.localFile };
    }
  }

  // 墨读完整存档（保留全部字段，恢复时无损）
  files.push({
    name: 'moread.json',
    data: JSON.stringify({
      app: 'moread', schema: 2, exportedAt: new Date().toISOString(),
      data: state, fileMap
    })
  });

  // Legado 认识的几份 JSON
  const legado = {
    'bookSource.json': toLegadoSources(state.sources),
    'bookshelf.json': toLegadoBooks(state.books, state.progress, groups, state.sources),
    'bookmark.json': toLegadoBookmarks(state.bookmarks),
    'readRecord.json': toLegadoReadRecords(state.history),
    'bookGroup.json': bookGroups
  };
  for (const [name, arr] of Object.entries(legado)) {
    if (!arr.length && name !== 'bookGroup.json') continue;
    files.push({ name, data: JSON.stringify(arr, null, 2) });
  }

  return writeZip(files);
}

/**
 * 解析备份 zip：优先按墨读完整备份读，否则按 Legado 备份读
 * @returns {{ok:boolean, kind:'moread'|'legado', error?:string, ...}}
 */
function parseBackupZip(buf) {
  let zip;
  try { zip = readZip(buf); } catch (e) {
    return { ok: false, error: '不是有效的 zip 文件：' + e.message };
  }
  const names = zip.names;
  const has = n => names.includes(n);

  // 1) 墨读完整备份
  if (has('moread.json')) {
    try {
      const p = JSON.parse(zip.readText('moread.json'));
      if (p && p.app === 'moread' && p.data) {
        return {
          ok: true, kind: 'moread', payload: p,
          summary: {
            books: (p.data.books || []).length,
            sources: (p.data.sources || []).length,
            bookmarks: (p.data.bookmarks || []).length,
            withFiles: !!(p.fileMap && Object.keys(p.fileMap).length)
          }
        };
      }
    } catch (e) { /* 落到 Legado 分支 */ }
  }

  // 2) Legado 备份
  const readArr = n => {
    if (!has(n)) return [];
    try { return JSON.parse(zip.readText(n)) || []; } catch (e) { return []; }
  };
  const sources = rawSourcesFromLegado(readArr('bookSource.json'));
  const books = rawBooksFromLegado(readArr('bookshelf.json'));
  const bookmarks = rawBookmarksFromLegado(readArr('bookmark.json'));
  const records = rawReadRecordsFromLegado(readArr('readRecord.json'));

  // 书架分组：把 groupId 换成组名交给渲染层建组
  const gmap = rawGroupsFromLegado(readArr('bookGroup.json'));
  for (const b of books.books) b.groupName = gmap.get(b.group) || '';

  if (!sources.length && !books.books.length && !bookmarks.length) {
    return { ok: false, error: 'zip 里没有找到书源或书架数据（需要 bookSource.json 或 bookshelf.json）' };
  }
  return {
    ok: true, kind: 'legado',
    legado: { sources, books: books.books, bookmarks, records },
    summary: {
      books: books.books.length,
      sources: sources.length,
      bookmarks: bookmarks.length,
      skippedLocal: books.skipped.length,
      withFiles: names.some(n => n.startsWith('files/'))
    }
  };
}

/** 读取 zip 内的本地书文件 */
function readZipFiles(buf, fileMap) {
  const zip = readZip(buf);
  const out = {};
  for (const [id, info] of Object.entries(fileMap || {})) {
    const b = zip.read(info.path);
    if (b) out[id] = b;
  }
  return out;
}

/** 单个书源 JSON 文件（兼容数组 / {bookSources:[...]}） */
function parseSourceFile(text) {
  let json;
  try { json = JSON.parse(text); } catch (e) { return { ok: false, error: 'JSON 解析失败：' + e.message }; }
  const list = rawSourcesFromLegado(json);
  return { ok: true, sources: list };
}

module.exports = {
  toLegadoSources, toLegadoBooks, toLegadoBookmarks, toLegadoReadRecords,
  buildBackupZip, parseBackupZip, readZipFiles, parseSourceFile,
  normalizeUrl
};
