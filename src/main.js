'use strict';
const { app, BrowserWindow, ipcMain, dialog, shell, Tray, Menu, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');

/* 便携模式：exe 同目录若有 portable.txt，则数据写在 exe 旁边的 data/ 里，
   换电脑整个文件夹拷走即可，不写注册表、不污染 %APPDATA% */
(() => {
  try {
    const exeDir = path.dirname(app.getPath('exe'));
    const portable = fs.existsSync(path.join(exeDir, 'portable.txt')) || process.env.MOREAD_PORTABLE === '1';
    if (portable) {
      const dataDir = path.join(exeDir, 'data');
      fs.mkdirSync(dataDir, { recursive: true });
      app.setPath('userData', dataDir);
      app.setPath('sessionData', path.join(dataDir, 'session'));
    }
  } catch (e) { /* 便携模式失败就退回默认目录 */ }
})();

const store = require('./store');
const net = require('./net');
const parse = require('./parse');
const legado = require('./legado');
const webdav = require('./webdav');

let win = null;
let tray = null;
let quitting = false;
let pendingZip = null; // { buffer, parsed } 等待用户确认恢复的备份
const parsedCache = new Map(); // bookId -> chapters[]
const ROOT = path.join(__dirname, '..');

/* 渲染进程错误日志（排查问题用） */
function rlog(...args) {
  try {
    const p = path.join(app.getPath('userData'), 'renderer.log');
    fs.appendFileSync(p, new Date().toISOString() + ' ' + args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ') + '\n');
  } catch (e) { /* ignore */ }
}

/* ---------------- 窗口 ---------------- */
function createWindow() {
  win = new BrowserWindow({
    width: 1200, height: 800, minWidth: 980, minHeight: 640,
    frame: false, backgroundColor: '#eef0f4', show: false,
    icon: fs.existsSync(path.join(ROOT, 'build', 'icon.ico')) ? path.join(ROOT, 'build', 'icon.ico') : undefined,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: true,
      spellcheck: false
    }
  });
  win.loadFile(path.join(ROOT, 'ui', 'index.html'));

  /* 内嵌网页只允许 http/https，且不给网页任何 Node 能力 */
  win.webContents.on('will-attach-webview', (_e, webPreferences, params) => {
    delete webPreferences.preload;
    webPreferences.nodeIntegration = false;
    webPreferences.contextIsolation = true;
    if (!/^https?:/.test(params.src || '')) params.src = 'about:blank';
  });

  /* 开发用：MOREAD_SHOT=<png路径> 时自动截图并退出，便于验证界面 */
  if (process.env.MOREAD_SHOT) {
    win.webContents.once('did-finish-load', () => {
      setTimeout(async () => {
        try {
          if (process.env.MOREAD_SHOT_JS) {
            const ret = await win.webContents.executeJavaScript(process.env.MOREAD_SHOT_JS, true).catch(e => rlog('[shot-js]', e.message));
            if (ret !== undefined) rlog('[shot-js-result]', typeof ret === 'string' ? ret : JSON.stringify(ret));
            await new Promise(r => setTimeout(r, 1200));
          }
          const img = await win.webContents.capturePage();
          fs.writeFileSync(process.env.MOREAD_SHOT, img.toPNG());
          console.log('SHOT_OK');
        } catch (e) { rlog('[shot]', e.message); }
        quitting = true;
        app.exit(0);
      }, 2000);
    });
  }
  win.once('ready-to-show', () => win.show());
  win.on('close', e => {
    const s = store.getState().settings;
    if (!quitting && s.closeToTray && tray) {
      e.preventDefault();
      win.hide();
    }
  });
  win.on('maximize', () => win.webContents.send('win:state', { maximized: true }));
  win.on('unmaximize', () => win.webContents.send('win:state', { maximized: false }));
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('console-message', (...args) => {
    const ev = args[0];
    if (ev && typeof ev === 'object' && typeof ev.message === 'string') {
      if (ev.level === 'error' || ev.level === 'warning') rlog('[console]', ev.level, ev.message, ev.sourceId + ':' + ev.lineNumber);
    } else if (args[1] >= 2) {
      rlog('[console]', args[1], args[2], args[4] + ':' + args[3]);
    }
  });
  win.webContents.on('did-fail-load', (e, code, desc, url) => rlog('[fail-load]', code, desc, url));
  win.webContents.on('render-process-gone', (e, d) => rlog('[render-gone]', d));
}

function createTray() {
  const p = path.join(ROOT, 'build', 'tray.png');
  if (!fs.existsSync(p)) return;
  try {
    tray = new Tray(nativeImage.createFromPath(p));
    tray.setToolTip('墨读');
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: '显示主窗口', click: () => { if (win) { win.show(); win.focus(); } } },
      { type: 'separator' },
      { label: '退出墨读', click: () => { quitting = true; app.quit(); } }
    ]));
    tray.on('click', () => { if (win) { win.isVisible() ? win.hide() : win.show(); } });
  } catch (e) { /* 托盘失败不影响主流程 */ }
}

/* ---------------- 本地书 ---------------- */
function bookCacheDir(id) {
  return path.join(store.dirs().cacheDir, String(id));
}
function parsedPath(id) { return path.join(bookCacheDir(id), 'parsed.json'); }

function loadParsed(book) {
  if (parsedCache.has(book.id)) return parsedCache.get(book.id);
  let chapters = null;
  try {
    if (fs.existsSync(parsedPath(book.id))) {
      chapters = JSON.parse(fs.readFileSync(parsedPath(book.id), 'utf8'));
    }
  } catch (e) { chapters = null; }
  if (!chapters && book.localFile) {
    const abs = store.bookFilePath(book.localFile);
    if (fs.existsSync(abs)) {
      const r = parse.parseLocalFile(abs);
      chapters = r.chapters;
      fs.mkdirSync(bookCacheDir(book.id), { recursive: true });
      fs.writeFileSync(parsedPath(book.id), JSON.stringify(chapters));
    }
  }
  if (chapters) parsedCache.set(book.id, chapters);
  return chapters || [];
}

/* ---------------- WebDAV / 备份 ---------------- */
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
  if (create) await webdav.ensureDir(cfg, base, cfg.dir);
  return webdav.joinUrl(base, cfg.dir);
}

function stampName() {
  const d = new Date(), p = n => String(n).padStart(2, '0');
  return `moread-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}.zip`;
}

async function uploadBackup(includeFiles, auto) {
  const cfg = webdavConfig();
  const dir = await davDir(cfg, true);
  const name = auto ? 'moread-auto.zip' : stampName();
  const buf = legado.buildBackupZip(store.getState(), {
    includeFiles,
    readBookFile: store.readLocalFile
  });
  await webdav.put(cfg, webdav.joinUrl(dir, name), buf, 'application/zip');

  const s = store.getState().settings.webdav;
  s.lastBackupAt = Date.now();
  s.lastBackupName = name;
  store.saveNow();

  // 只保留最近 keep 份自动/手动备份
  let pruned = 0;
  try {
    const keep = Math.max(1, Number(s.keep) || 10);
    const items = (await webdav.list(cfg, dir)).filter(i => !i.isDir && /\.zip$/i.test(i.name));
    items.sort((a, b) => b.lastmod - a.lastmod);
    for (const old of items.slice(keep)) { await webdav.del(cfg, webdav.joinUrl(dir, old.name)); pruned++; }
  } catch (e) { /* 清理失败不影响备份结果 */ }

  return { ok: true, name, size: buf.length, pruned, ms: 0 };
}

async function uploadSources() {
  const cfg = webdavConfig();
  const dir = await davDir(cfg, true);
  const buf = Buffer.from(JSON.stringify(legado.toLegadoSources(store.getState().sources), null, 2), 'utf8');
  await webdav.put(cfg, webdav.joinUrl(dir, 'bookSource.json'), buf, 'application/json; charset=utf-8');
  const s = store.getState().settings.webdav;
  s.lastSyncAt = Date.now();
  store.saveNow();
  return { ok: true, size: buf.length, count: store.getState().sources.length };
}

/** 后台自动备份：每 10 分钟检查一次是否到点 */
function startAutoBackup() {
  const tick = async () => {
    const s = store.getState().settings.webdav || {};
    if (!s.autoBackup || !s.url || !s.user || !s.pass) return;
    const due = Date.now() - (Number(s.lastBackupAt) || 0) >= Math.max(1, Number(s.intervalHours) || 24) * 3600e3;
    if (!due) return;
    try {
      const r = await uploadBackup(false, true);
      rlog('[autobackup] ok', r.name, r.size);
      if (win && win.webContents) win.webContents.send('backup:auto', { ok: true, name: r.name, at: Date.now() });
    } catch (e) {
      rlog('[autobackup] fail', e.message);
      if (win && win.webContents) win.webContents.send('backup:auto', { ok: false, error: e.message });
    }
  };
  setTimeout(tick, Number(process.env.MOREAD_AUTOBACKUP_FIRST) || 60e3);
  setInterval(tick, 10 * 60e3);
}

/* ---------------- IPC ---------------- */
function registerIpc() {
  ipcMain.on('log:error', (_e, msg) => rlog('[error]', msg));
  ipcMain.handle('win:minimize', () => win && win.minimize());
  ipcMain.handle('win:maximize', () => {
    if (!win) return false;
    if (win.isMaximized()) win.unmaximize(); else win.maximize();
    return win.isMaximized();
  });
  ipcMain.handle('win:close', () => win && win.close());
  ipcMain.handle('win:isMax', () => !!(win && win.isMaximized()));

  ipcMain.handle('app:info', () => ({
    version: app.getVersion(),
    electron: process.versions.electron,
    node: process.versions.node,
    paths: store.dirs(),
    portable: app.getPath('userData') !== path.join(app.getPath('appData'), '墨读'),
    exeDir: path.dirname(app.getPath('exe'))
  }));
  ipcMain.handle('app:openDir', (_e, which) => {
    const d = store.dirs();
    shell.openPath(which === 'books' ? d.booksDir : which === 'cache' ? d.cacheDir : d.root);
  });
  ipcMain.handle('app:quit', () => { quitting = true; app.quit(); });
  ipcMain.handle('app:hide', () => win && win.hide());

  ipcMain.handle('state:get', () => store.getState());
  ipcMain.handle('state:set', (_e, next) => {
    const s = store.setState(next);
    store.scheduleSave();
    return s;
  });

  ipcMain.handle('cache:get', (_e, { bookId, idx }) => store.getCache(bookId, idx));
  ipcMain.handle('cache:set', (_e, { bookId, idx, payload }) => { store.setCache(bookId, idx, payload); return true; });
  ipcMain.handle('cache:clear', (_e, { bookId } = {}) => { store.clearCache(bookId); return true; });
  ipcMain.handle('cache:size', () => store.cacheSize());

  ipcMain.handle('net:fetch', async (_e, opts) => {
    try {
      const r = await net.fetchText(opts.url, {
        charset: opts.charset,
        method: opts.method || 'GET',
        body: opts.body,
        headers: opts.headers
      });
      // 正文页通常不需要完整 HTML 之外的资源，直接回文本
      return { ok: true, status: r.status, url: r.url, charset: r.charset, text: r.text, ms: r.ms };
    } catch (e) {
      return { ok: false, error: e.message || String(e) };
    }
  });

  ipcMain.handle('dialog:pickBook', async () => {
    const r = await dialog.showOpenDialog(win, {
      title: '导入本地书籍',
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: '电子书', extensions: ['txt', 'epub'] }, { name: '全部文件', extensions: ['*'] }]
    });
    return r.canceled ? [] : r.filePaths;
  });

  ipcMain.handle('local:import', async (_e, paths) => {
    const out = [];
    for (const p of paths) {
      try {
        const r = parse.parseLocalFile(p);
        const id = 'L' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
        const info = store.importBookFile(p, id);
        fs.mkdirSync(bookCacheDir(id), { recursive: true });
        fs.writeFileSync(parsedPath(id), JSON.stringify(r.chapters));
        parsedCache.set(id, r.chapters);
        out.push({
          id, name: r.title, author: r.author || '本地导入', kind: 'local',
          total: r.chapters.length, chapters: r.chapters.map(c => c.title),
          localFile: info.file, ext: info.ext, size: info.size,
          groupId: 'g_default', intro: '', cover: '', createdAt: Date.now(), updatedAt: Date.now()
        });
      } catch (e) {
        out.push({ error: (path.basename(p)) + '：' + (e.message || e) });
      }
    }
    return out;
  });

  ipcMain.handle('local:chapter', (_e, { bookId, idx }) => {
    const book = store.getState().books.find(b => b.id === bookId);
    if (!book) return { ok: false, error: '书籍不存在' };
    const chapters = loadParsed(book);
    const ch = chapters[idx];
    if (!ch) return { ok: false, error: '章节不存在' };
    return { ok: true, title: ch.title, text: ch.text, total: chapters.length };
  });

  ipcMain.handle('dialog:saveJson', async (_e, { name, content }) => {
    const r = await dialog.showSaveDialog(win, {
      title: '保存', defaultPath: name,
      filters: [{ name: 'JSON 文件', extensions: ['json'] }]
    });
    if (r.canceled || !r.filePath) return { ok: false };
    fs.writeFileSync(r.filePath, content, 'utf8');
    return { ok: true, path: r.filePath };
  });

  ipcMain.handle('dialog:openJson', async (_e, { title, filters }) => {
    const r = await dialog.showOpenDialog(win, {
      title, properties: ['openFile'],
      filters: filters || [{ name: 'JSON', extensions: ['json'] }]
    });
    if (r.canceled || !r.filePaths.length) return { ok: false };
    try {
      return { ok: true, name: path.basename(r.filePaths[0]), text: fs.readFileSync(r.filePaths[0], 'utf8') };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('backup:export', async (_e, { includeFiles }) => {
    const stamp = new Date().toISOString().slice(0, 10);
    const r = await dialog.showSaveDialog(win, {
      title: '导出备份',
      defaultPath: `moread-backup-${stamp}.json`,
      filters: [{ name: '墨读备份', extensions: ['json'] }]
    });
    if (r.canceled || !r.filePath) return { ok: false };
    const payload = store.exportBackup(!!includeFiles);
    fs.writeFileSync(r.filePath, JSON.stringify(payload), 'utf8');
    return { ok: true, path: r.filePath, size: fs.statSync(r.filePath).size };
  });

  ipcMain.handle('backup:pick', async () => {
    const r = await dialog.showOpenDialog(win, {
      title: '选择备份文件', properties: ['openFile'],
      filters: [{ name: '墨读备份', extensions: ['json'] }]
    });
    if (r.canceled || !r.filePaths.length) return { ok: false };
    try {
      const payload = JSON.parse(fs.readFileSync(r.filePaths[0], 'utf8'));
      if (payload.app !== 'moread' || !payload.data) return { ok: false, error: '不是墨读的备份文件' };
      return {
        ok: true, name: path.basename(r.filePaths[0]), exportedAt: payload.exportedAt,
        summary: {
          books: (payload.data.books || []).length,
          sources: (payload.data.sources || []).length,
          bookmarks: (payload.data.bookmarks || []).length,
          withFiles: !!payload.files
        },
        payload
      };
    } catch (e) {
      return { ok: false, error: '读取失败：' + e.message };
    }
  });

  ipcMain.handle('backup:apply', (_e, { payload, mode }) => {
    try {
      const s = store.restoreBackup(payload, mode);
      parsedCache.clear();
      return { ok: true, state: s };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('book:delete', (_e, { bookId }) => {
    const st = store.getState();
    const b = st.books.find(x => x.id === bookId);
    if (b && b.localFile) store.removeBookFile(b.localFile);
    store.clearCache(bookId);
    parsedCache.delete(bookId);
    return true;
  });

  /* -------- 备份 zip（含 Legado 兼容格式） -------- */
  ipcMain.handle('backup:exportZip', async (_e, { includeFiles }) => {
    const d = new Date(), p = n => String(n).padStart(2, '0');
    const r = await dialog.showSaveDialog(win, {
      title: '导出备份（兼容原版阅读）',
      defaultPath: `墨读备份-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}.zip`,
      filters: [{ name: '备份 zip（含 Legado 格式）', extensions: ['zip'] }]
    });
    if (r.canceled || !r.filePath) return { ok: false };
    try {
      const buf = legado.buildBackupZip(store.getState(), { includeFiles, readBookFile: store.readLocalFile });
      fs.writeFileSync(r.filePath, buf);
      return { ok: true, path: r.filePath, size: buf.length };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('backup:pickZip', async () => {
    const r = await dialog.showOpenDialog(win, {
      title: '选择备份（墨读 zip 或原版阅读的备份）',
      properties: ['openFile'],
      filters: [{ name: '备份文件', extensions: ['zip', 'json'] }, { name: '全部文件', extensions: ['*'] }]
    });
    if (r.canceled || !r.filePaths.length) return { ok: false };
    try {
      const buf = fs.readFileSync(r.filePaths[0]);
      const name = path.basename(r.filePaths[0]);
      // 直接给的是 json（书源/书架）时按文本解析
      if (/\.json$/i.test(name)) {
        const text = buf.toString('utf8');
        const src = legado.parseSourceFile(text);
        if (src.ok && src.sources.length) {
          return { ok: true, kind: 'sources', name, sources: src.sources, summary: { sources: src.sources.length, books: 0, bookmarks: 0 } };
        }
        return { ok: false, error: '这个 JSON 里没有识别到书源' };
      }
      const parsed = legado.parseBackupZip(buf);
      if (!parsed.ok) return { ok: false, error: parsed.error };
      pendingZip = { buffer: buf, parsed };
      return { ok: true, kind: parsed.kind, name, summary: parsed.summary, legado: parsed.legado || null };
    } catch (e) {
      return { ok: false, error: '读取失败：' + e.message };
    }
  });

  ipcMain.handle('backup:applyZip', (_e, { mode }) => {
    if (!pendingZip) return { ok: false, error: '没有待恢复的备份，请重新选择' };
    const parsed = pendingZip.parsed;
    if (parsed.kind !== 'moread') return { ok: false, error: '这不是墨读完整备份' };
    try {
      const s = store.restoreBackup(parsed.payload, mode);
      if (parsed.payload.fileMap) {
        const files = legado.readZipFiles(pendingZip.buffer, parsed.payload.fileMap);
        for (const [id, buf] of Object.entries(files)) {
          const book = s.books.find(b => b.id === id);
          if (!book) continue;
          const info = parsed.payload.fileMap[id] || {};
          book.localFile = store.writeLocalBook(id, info.ext || book.ext || '.txt', buf);
          book.ext = info.ext || book.ext || '.txt';
        }
        store.saveNow();
      }
      parsedCache.clear();
      pendingZip = null;
      return { ok: true, state: s };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  /* -------- WebDAV（坚果云） -------- */
  ipcMain.handle('webdav:info', () => {
    const s = store.getState().settings.webdav || {};
    return {
      configured: !!(s.url && s.user && s.pass),
      url: s.url, user: s.user, dir: s.dir,
      hasPass: !!s.pass, lastBackupAt: s.lastBackupAt || 0,
      lastBackupName: s.lastBackupName || '', lastSyncAt: s.lastSyncAt || 0
    };
  });

  ipcMain.handle('webdav:test', async () => {
    try {
      const cfg = webdavConfig();
      const r = await webdav.test(cfg);
      return { ok: true, ms: r.ms, items: r.items.length };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('webdav:list', async () => {
    try {
      const cfg = webdavConfig();
      const dir = await davDir(cfg, false);
      const items = await webdav.list(cfg, dir);
      return {
        ok: true,
        items: items.filter(i => !i.isDir).map(i => ({ name: i.name, size: i.size, at: i.lastmod }))
          .sort((a, b) => b.at - a.at)
      };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('webdav:backup', async (_e, { includeFiles }) => {
    try {
      const t0 = Date.now();
      const r = await uploadBackup(!!includeFiles, false);
      return { ok: true, name: r.name, size: r.size, ms: Date.now() - t0, pruned: r.pruned };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('webdav:download', async (_e, { name }) => {
    try {
      const cfg = webdavConfig();
      const dir = await davDir(cfg, false);
      const buf = await webdav.get(cfg, webdav.joinUrl(dir, name));
      const parsed = legado.parseBackupZip(buf);
      if (!parsed.ok) return { ok: false, error: parsed.error };
      pendingZip = { buffer: buf, parsed };
      return { ok: true, kind: parsed.kind, name, summary: parsed.summary, legado: parsed.legado || null };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('webdav:delete', async (_e, { name }) => {
    try {
      const cfg = webdavConfig();
      const dir = await davDir(cfg, false);
      await webdav.del(cfg, webdav.joinUrl(dir, name));
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('webdav:uploadSources', async () => {
    try { return await uploadSources(); } catch (e) { return { ok: false, error: e.message }; }
  });

  /* -------- 自动化验证用：直接按路径解析备份（仅 MOREAD_SHOT 时注册） -------- */
  if (process.env.MOREAD_SHOT) {
    ipcMain.handle('test:importZip', (_e, file) => {
      try {
        const buf = fs.readFileSync(file);
        const parsed = legado.parseBackupZip(buf);
        if (!parsed.ok) return { ok: false, error: parsed.error };
        pendingZip = { buffer: buf, parsed };
        return {
          ok: true, kind: parsed.kind, name: path.basename(file),
          summary: parsed.summary, legado: parsed.legado || null
        };
      } catch (e) { return { ok: false, error: e.message }; }
    });
  }

  ipcMain.handle('webdav:downloadSources', async () => {
    try {
      const cfg = webdavConfig();
      const dir = await davDir(cfg, false);
      const buf = await webdav.get(cfg, webdav.joinUrl(dir, 'bookSource.json'));
      const r = legado.parseSourceFile(buf.toString('utf8'));
      if (!r.ok) return r;
      const s = store.getState().settings.webdav;
      s.lastSyncAt = Date.now();
      store.saveNow();
      return { ok: true, sources: r.sources };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });
}

/* ---------------- 启动 ---------------- */
store.init(app.getPath('userData'));

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) { if (win.isMinimized()) win.restore(); win.show(); win.focus(); }
  });
  app.whenReady().then(() => {
    Menu.setApplicationMenu(null);
    registerIpc();
    createWindow();
    createTray();
    startAutoBackup();
    app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
  });
  app.on('before-quit', () => { quitting = true; store.saveNow(); });
  app.on('window-all-closed', () => { if (!tray) app.quit(); });
}
