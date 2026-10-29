'use strict';
/**
 * 数据层：单文件 JSON 存档（对标 Legado 的「备份/恢复」）
 *  - data.json    书架 / 书源 / 进度 / 书签 / 历史 / 设置 / 统计
 *  - books/       导入的本地书原文件
 *  - cache/       在线章节正文缓存
 */
const fs = require('fs');
const path = require('path');

let root, dataFile, booksDir, cacheDir;
let state;
let dirty = false;
let timer = null;

function defaults() {
  return {
    version: 2,
    books: [],
    sources: [],
    groups: [{ id: 'g_default', name: '默认分组' }],
    progress: {},
    bookmarks: [],
    history: [],
    stats: {},
    settings: {
      fontSize: 19,
      lineHeight: 2.0,
      fontFamily: 'serif',
      theme: 'paper',
      pageMode: 'scroll',
      paraGap: true,
      autoSave: true,
      minimizeToTray: true,
      closeToTray: false,
      maxConcurrent: 3,
      searchLimit: 40,
      autoCacheNext: true,
      tts: { voiceURI: '', rate: 1, pitch: 1, autoNext: true },
      webdav: {
        enabled: false, url: 'https://dav.jianguoyun.com/dav/', user: '', pass: '',
        dir: 'legado', autoBackup: false, intervalHours: 24, keep: 10,
        lastBackupAt: 0, lastBackupName: '', lastSyncAt: 0
      },
      webSearch: { engine: 'bing', keyword: '' }
    }
  };
}

/** 嵌套设置项要深合并，否则旧存档会丢掉新增字段 */
function mergeSettings(base, inc) {
  const out = Object.assign({}, base, inc || {});
  out.tts = Object.assign({}, base.tts, (inc && inc.tts) || {});
  out.webdav = Object.assign({}, base.webdav, (inc && inc.webdav) || {});
  out.webSearch = Object.assign({}, base.webSearch, (inc && inc.webSearch) || {});
  return out;
}

function init(userDataDir) {
  root = userDataDir;
  dataFile = path.join(root, 'data.json');
  booksDir = path.join(root, 'books');
  cacheDir = path.join(root, 'cache');
  fs.mkdirSync(booksDir, { recursive: true });
  fs.mkdirSync(cacheDir, { recursive: true });

  if (fs.existsSync(dataFile)) {
    try {
      const raw = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
      state = Object.assign(defaults(), raw);
      state.settings = mergeSettings(defaults().settings, raw.settings);
      if (!Array.isArray(state.groups) || !state.groups.length) state.groups = defaults().groups;
    } catch (e) {
      const bak = dataFile + '.broken-' + Date.now();
      try { fs.renameSync(dataFile, bak); } catch (_) {}
      state = defaults();
    }
  } else {
    state = defaults();
    seed();
    saveNow();
  }
}

/** 首次启动放两条示例书源，方便用户理解字段结构 */
function seed() {
  state.sources = [
    {
      id: 'src_demo_1',
      name: '示例源 · 结构参考',
      url: 'https://example.com',
      group: '示例',
      enabled: false,
      type: 'legado',
      charset: 'auto',
      searchUrl: 'https://example.com/search?q={{key}}',
      ruleSearch: {
        bookList: '.result .item',
        name: 'h3 a@text',
        author: '.author@text',
        bookUrl: 'h3 a@href',
        intro: '.intro@text',
        coverUrl: 'img@src'
      },
      ruleBookInfo: { tocUrl: '#catalog@href' },
      ruleToc: { chapterList: '#list dd', chapterName: 'a@text', chapterUrl: 'a@href' },
      ruleContent: { content: '#content' },
      icon: '示',
      comment: '把 url / searchUrl / 规则改成目标站点即可。规则支持 CSS 选择器 + @text/@href/@src。'
    },
    {
      id: 'src_demo_2',
      name: '示例源 · JSON 书源',
      url: 'https://example.org',
      group: '示例',
      enabled: false,
      type: 'legado',
      charset: 'auto',
      searchUrl: 'https://example.org/api/search?kw={{key}}',
      ruleSearch: {
        bookList: '$.data.list[*]',
        name: '$.name',
        author: '$.author',
        bookUrl: '$.url',
        intro: '$.intro',
        coverUrl: '$.cover'
      },
      ruleBookInfo: { tocUrl: '$.tocUrl' },
      ruleToc: { chapterList: '$.chapters[*]', chapterName: '$.title', chapterUrl: '$.url' },
      ruleContent: { content: '$.content' },
      icon: 'JS',
      comment: '以 $ 开头的规则按 JSON 路径解析，适合接口型站点。'
    }
  ];
}

function getState() {
  return state;
}

function setState(next) {
  state = Object.assign(defaults(), next);
  state.settings = mergeSettings(defaults().settings, next.settings);
  saveNow();
  return state;
}

function scheduleSave() {
  dirty = true;
  if (timer) return;
  timer = setTimeout(() => { timer = null; if (dirty) saveNow(); }, 800);
}

function saveNow() {
  dirty = false;
  const tmp = dataFile + '.tmp';
  try {
    fs.writeFileSync(tmp, JSON.stringify(state));
    fs.renameSync(tmp, dataFile);
  } catch (e) {
    console.error('保存失败', e);
  }
}

/* ---------------- 本地书文件 ---------------- */
function importBookFile(srcPath, id) {
  const ext = path.extname(srcPath).toLowerCase();
  const dest = path.join(booksDir, id + ext);
  fs.copyFileSync(srcPath, dest);
  return { file: path.join('books', id + ext), ext, size: fs.statSync(dest).size };
}
function bookFilePath(rel) {
  return path.join(root, rel);
}
function removeBookFile(rel) {
  if (!rel) return;
  try { fs.unlinkSync(path.join(root, rel)); } catch (e) {}
}

/* ---------------- 章节缓存 ---------------- */
function cachePath(bookId, idx) {
  return path.join(cacheDir, String(bookId), String(idx) + '.json');
}
function getCache(bookId, idx) {
  const p = cachePath(bookId, idx);
  if (!fs.existsSync(p)) return null;
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return null; }
}
function setCache(bookId, idx, payload) {
  const p = cachePath(bookId, idx);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(Object.assign({ at: Date.now() }, payload)));
}
function clearCache(bookId) {
  const dir = bookId ? path.join(cacheDir, String(bookId)) : cacheDir;
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {}
  fs.mkdirSync(cacheDir, { recursive: true });
}
function cacheSize() {
  let total = 0;
  const walk = d => {
    let list = [];
    try { list = fs.readdirSync(d, { withFileTypes: true }); } catch (e) { return; }
    for (const f of list) {
      const p = path.join(d, f.name);
      if (f.isDirectory()) walk(p);
      else { try { total += fs.statSync(p).size; } catch (e) {} }
    }
  };
  walk(cacheDir);
  return total;
}

/* ---------------- 备份 / 恢复 ---------------- */
/** 读本地书原始字节（导出 zip 用） */
function readLocalFile(rel) {
  try { return fs.readFileSync(path.join(root, rel)); } catch (e) { return null; }
}

/** 把 zip 里取出的本地书写进 books/，返回相对路径 */
function writeLocalBook(id, ext, buffer, relHint) {
  const rel = relHint || path.join('books', id + (ext || '.txt'));
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, buffer);
  return rel;
}

function exportBackup(includeLocalBooks) {
  const payload = {
    app: 'moread',
    schema: 1,
    exportedAt: new Date().toISOString(),
    data: JSON.parse(JSON.stringify(state))
  };
  if (includeLocalBooks) {
    payload.files = {};
    for (const b of state.books) {
      if (b.kind === 'local' && b.localFile) {
        const p = path.join(root, b.localFile);
        if (fs.existsSync(p)) payload.files[b.id] = fs.readFileSync(p).toString('base64');
      }
    }
  }
  return payload;
}

function restoreBackup(payload, mode) {
  if (!payload || payload.app !== 'moread' || !payload.data) {
    throw new Error('这不是墨读的备份文件');
  }
  const inc = payload.data;
  if (mode === 'replace') {
    state = Object.assign(defaults(), inc);
    state.settings = mergeSettings(defaults().settings, inc.settings);
  } else {
    // merge：同 id 覆盖，新 id 追加
    const mergeById = (arr, incArr) => {
      const map = new Map(arr.map(x => [x.id, x]));
      for (const x of incArr || []) map.set(x.id, x);
      return [...map.values()];
    };
    state.books = mergeById(state.books, inc.books);
    state.sources = mergeById(state.sources, inc.sources);
    state.groups = mergeById(state.groups, inc.groups);
    state.bookmarks = mergeById(state.bookmarks, inc.bookmarks);
    state.history = mergeById(state.history, inc.history);
    state.progress = Object.assign({}, state.progress, inc.progress || {});
    state.stats = Object.assign({}, state.stats, inc.stats || {});
    state.settings = Object.assign({}, state.settings, inc.settings || {});
  }
  // 还原本地书文件
  if (payload.files) {
    for (const [id, b64] of Object.entries(payload.files)) {
      const book = state.books.find(b => b.id === id);
      if (!book) continue;
      const ext = path.extname(book.localFile || '.txt') || '.txt';
      const rel = book.localFile || path.join('books', id + ext);
      fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
      fs.writeFileSync(path.join(root, rel), Buffer.from(b64, 'base64'));
      book.localFile = rel;
    }
  }
  saveNow();
  return state;
}

function dirs() { return { root, booksDir, cacheDir, dataFile }; }

module.exports = {
  init, getState, setState, scheduleSave, saveNow,
  importBookFile, bookFilePath, removeBookFile,
  getCache, setCache, clearCache, cacheSize,
  exportBackup, restoreBackup, dirs, mergeSettings,
  readLocalFile, writeLocalBook
};
