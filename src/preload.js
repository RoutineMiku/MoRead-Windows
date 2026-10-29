'use strict';
const { contextBridge, ipcRenderer } = require('electron');

const invoke = (ch, arg) => ipcRenderer.invoke(ch, arg);

window.addEventListener('error', e => {
  try { ipcRenderer.send('log:error', e.message + ' @ ' + e.filename + ':' + e.lineno); } catch (_) {}
});
window.addEventListener('unhandledrejection', e => {
  try {
    const r = e.reason;
    ipcRenderer.send('log:error', 'unhandled: ' + ((r && (r.stack || r.message)) || r));
  } catch (_) {}
});

contextBridge.exposeInMainWorld('mo', {
  /* 自动化验证时（MOREAD_SHOT 设置）暴露内部钩子，正常运行不暴露 */
  testMode: !!process.env.MOREAD_SHOT,
  /* 窗口 */
  win: {
    minimize: () => invoke('win:minimize'),
    maximize: () => invoke('win:maximize'),
    close: () => invoke('win:close'),
    isMax: () => invoke('win:isMax'),
    onState: cb => ipcRenderer.on('win:state', (_e, s) => cb(s))
  },
  info: () => invoke('app:info'),
  openDir: which => invoke('app:openDir', which),
  quit: () => invoke('app:quit'),
  hide: () => invoke('app:hide'),

  /* 存档 */
  state: {
    get: () => invoke('state:get'),
    set: s => invoke('state:set', s)
  },
  cache: {
    get: (bookId, idx) => invoke('cache:get', { bookId, idx }),
    set: (bookId, idx, payload) => invoke('cache:set', { bookId, idx, payload }),
    clear: bookId => invoke('cache:clear', { bookId }),
    size: () => invoke('cache:size')
  },
  net: opts => invoke('net:fetch', opts),

  /* 本地书 */
  pickBooks: () => invoke('dialog:pickBook'),
  importLocal: paths => invoke('local:import', paths),
  localChapter: (bookId, idx) => invoke('local:chapter', { bookId, idx }),
  deleteBookFiles: bookId => invoke('book:delete', { bookId }),

  /* 文件 */
  saveJson: (name, content) => invoke('dialog:saveJson', { name, content }),
  openJson: (title, filters) => invoke('dialog:openJson', { title, filters }),

  /* 备份 */
  exportBackup: includeFiles => invoke('backup:export', { includeFiles }),
  pickBackup: () => invoke('backup:pick'),
  applyBackup: (payload, mode) => invoke('backup:apply', { payload, mode }),

  /* 备份 zip（含 Legado 格式，可与原版阅读互通） */
  exportZip: includeFiles => invoke('backup:exportZip', { includeFiles }),
  pickZip: () => invoke('backup:pickZip'),
  applyZip: mode => invoke('backup:applyZip', { mode }),
  /* 自动化验证专用：无对话框直接解析备份文件 */
  testImportZip: file => invoke('test:importZip', file),

  /* 坚果云 / WebDAV */
  dav: {
    info: () => invoke('webdav:info'),
    test: () => invoke('webdav:test'),
    list: () => invoke('webdav:list'),
    backup: includeFiles => invoke('webdav:backup', { includeFiles }),
    download: name => invoke('webdav:download', { name }),
    remove: name => invoke('webdav:delete', { name }),
    uploadSources: () => invoke('webdav:uploadSources'),
    downloadSources: () => invoke('webdav:downloadSources'),
    onAuto: cb => ipcRenderer.on('backup:auto', (_e, r) => cb(r))
  }
});
