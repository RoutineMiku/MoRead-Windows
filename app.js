/* ===========================================================
   墨读 · 主逻辑
   =========================================================== */
(function () {
  'use strict';
  const mo = window.mo;
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  /* 安卓版：bridge.js 会把 Node 兼容层挂到 window.MoNative 上 */
  /* 网页版桌面浏览器（MoNativeBridge.__isWebDesktop）跑桌面版式，不算安卓形态 */
  const IS_ANDROID = !!window.MoNative && !(window.MoNativeBridge && window.MoNativeBridge.__isWebDesktop);
  /* 浏览器里跑的版本（手机/电脑都算）：没有"文件路径"、没有拖放，交互要更明确一些 */
  const IS_WEB = !!(window.MoNativeBridge && window.MoNativeBridge.__isWeb);
  const layoutMode = () => document.documentElement.getAttribute('data-layout') || '';

  const S = {
    state: null,
    view: 'shelf',
    filter: 'all',
    group: 'all',
    info: null,
    srcQ: '',
    srcG: 'all',
    srcE: 'all',
    srcPage: 0
  };

  const PALETTE = [
    ['#274a86', '#5b83c9'], ['#3d6b53', '#7fae8c'], ['#7a4335', '#c08265'],
    ['#3a3f52', '#6d7492'], ['#8a6a24', '#d0ab5c'], ['#2c5566', '#6b9aab'],
    ['#5b3663', '#9b6ca6'], ['#4a5b34', '#8fa06b']
  ];

  /* ---------------- 工具 ---------------- */
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const uid = p => (p || 'X') + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  /* 网络请求取消不了，但不必一直等：超时就放弃这个源，继续下一个 */
  const withTimeout = (p, ms) => Promise.race([
    Promise.resolve(p),
    new Promise((_, rej) => setTimeout(() => rej(new Error('超时')), ms))
  ]);

  function gradOf(name) {
    let h = 0;
    for (const ch of String(name)) h = (h * 31 + ch.codePointAt(0)) >>> 0;
    return PALETTE[h % PALETTE.length];
  }
  function dayKey(d) {
    const t = d || new Date();
    return t.getFullYear() + '-' + String(t.getMonth() + 1).padStart(2, '0') + '-' + String(t.getDate()).padStart(2, '0');
  }
  function fmtDur(sec) {
    sec = Math.round(sec || 0);
    if (sec < 60) return sec + ' 秒';
    const m = Math.floor(sec / 60);
    if (m < 60) return m + ' 分钟';
    return Math.floor(m / 60) + ' 小时 ' + (m % 60) + ' 分';
  }
  function fmtWhen(ts) {
    if (!ts) return '—';
    const d = new Date(ts), now = Date.now();
    const diff = now - ts;
    if (diff < 60e3) return '刚刚';
    if (diff < 3600e3) return Math.floor(diff / 60e3) + ' 分钟前';
    if (diff < 86400e3) return Math.floor(diff / 3600e3) + ' 小时前';
    if (diff < 7 * 86400e3) return Math.floor(diff / 86400e3) + ' 天前';
    return (d.getMonth() + 1) + ' 月 ' + d.getDate() + ' 日';
  }

  let toastTimer = null;
  function toast(msg, ms) {
    const t = $('#toast');
    t.textContent = msg;
    t.classList.add('on');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('on'), ms || 2400);
  }

  function openModal(html, wide) {
    const box = $('#modal-box');
    box.className = 'modal' + (wide ? ' wide' : '');
    box.innerHTML = html;
    $('#modal').classList.add('open');
  }
  function closeModal() { $('#modal').classList.remove('open'); }
  $('#modal').addEventListener('mousedown', e => { if (e.target.id === 'modal') closeModal(); });

  /* ---------------- 存档 ---------------- */
  let saveTimer = null;
  function save(now) {
    clearTimeout(saveTimer);
    /* mo.state.set 在桌面端是 IPC（返回 Promise），安卓端是同步写盘（返回值不是 Promise）。
       直接 .catch() 在手机上会抛 "catch is not a function"，把调用它的整段逻辑带走——
       导入后书架不刷新、设置改完不生效，都是被这里炸掉的。 */
    const run = () => {
      try {
        const r = mo.state.set(S.state);
        if (r && typeof r.catch === 'function') r.catch(e => console.error(e));
      } catch (e) { console.error(e); }
    };
    if (now) run(); else saveTimer = setTimeout(run, 700);
  }

  async function boot() {
    S.info = await mo.info();
    S.state = await mo.state.get();
    applySettings();
    // 同样逐个隔离：绑定阶段任何一步挂掉都只丢它自己，不影响导航和其它功能
    try { bindChrome(); } catch (e) { console.error('bindChrome 失败：', e); }
    try { bindNav(); } catch (e) { console.error('bindNav 失败：', e); }
    try { renderShelf(); } catch (e) { console.error('renderShelf 失败：', e); }
    try { setView('shelf'); } catch (e) { console.error('setView 失败：', e); }
    /* 手机上「把文件拖进窗口」这句话没有意义，换成手指能照做的说明 */
    try {
      const dh = $('.drop-hint');
      if (dh && isAndroidApp()) {
        dh.innerHTML = '点右上角 <b>导入</b> 选择 txt / epub 文件；在线书在「书源」里搜索后加入书架';
      }
    } catch (e) { /* 文案改不了不影响功能 */ }

    // 系统语音是异步加载的，加载完刷新一下设置页上的音色名
    try {
      window.speechSynthesis.getVoices();
      window.speechSynthesis.addEventListener('voiceschanged', () => {
        const el = $('#tts-cur');
        if (el) el.textContent = ttsCurrentLabel();
      });
    } catch (e) { /* 无语音环境 */ }

    mo.dav.onAuto(r => {
      if (r.ok) toast('自动备份完成：' + r.name);
      else toast('自动备份失败：' + r.error);
    });
  }

  const books = () => S.state.books;
  const getBook = id => S.state.books.find(b => b.id === id);
  const progressOf = id => S.state.progress[id] || null;
  const sourceById = id => S.state.sources.find(s => s.id === id);

  function upsertBook(book) {
    const i = S.state.books.findIndex(b => b.id === book.id);
    if (i >= 0) S.state.books[i] = Object.assign(S.state.books[i], book);
    else S.state.books.unshift(book);
    save(true);
  }

  function setProgress(bookId, ci, title, pct) {
    const p = S.state.progress[bookId] || {};
    S.state.progress[bookId] = Object.assign(p, { ci, title, pct: pct || 0, at: Date.now() });
    const b = getBook(bookId);
    if (b) b.readAt = Date.now();
    save();
    addHistory(bookId, ci, title);
  }

  function addHistory(bookId, ci, title) {
    const b = getBook(bookId);
    if (!b) return;
    const h = S.state.history;
    const last = h[0];
    if (last && last.bookId === bookId && last.ci === ci) { last.at = Date.now(); return; }
    h.unshift({ id: uid('H'), bookId, name: b.name, ci, title, at: Date.now() });
    if (h.length > 300) h.length = 300;
  }

  function addStats(chars, seconds) {
    const k = dayKey();
    const d = S.state.stats[k] || { sec: 0, chars: 0 };
    d.sec += seconds || 0;
    d.chars += chars || 0;
    S.state.stats[k] = d;
    save();
  }

  /* ---------------- 窗口 ---------------- */
  function bindChrome() {
    /* 安卓上 .winbtns 会被整块摘掉，这三个按钮根本不存在。
       早年这里直接 `$('#btn-min').onclick = ...` —— null 上赋值会抛 TypeError，
       而 bindChrome() 在 boot() 里排在 bindNav() 前面，一抛导航按钮就全都没绑上事件，
       表现正是「界面好好的，但点什么都没反应」。所以这里必须判空。 */
    const on = (sel, fn) => { const el = $(sel); if (el) el.onclick = fn; };
    on('#btn-min', () => mo.win.minimize());
    on('#btn-max', () => mo.win.maximize());
    on('#btn-close', () => mo.win.close());
    const tbar = $('#titlebar');
    if (tbar) tbar.addEventListener('dblclick', e => {
      if (e.target.closest('button')) return;
      mo.win.maximize();
    });
    $('#btn-search').onclick = () => { setView('search'); setTimeout(() => $('#search-input')?.focus(), 60); };
    $('#btn-import').onclick = importBooks;
    $('#btn-import2').onclick = importBooks;

    const q = $('#quick-search');
    q.addEventListener('keydown', e => {
      if (e.key !== 'Enter') return;
      const kw = q.value.trim();
      if (!kw) return;
      setView('search');
      setTimeout(() => { const i = $('#search-input'); if (i) i.value = kw; runSearch(kw); }, 30);
    });

    $$('#shelf-filter button').forEach(b => b.addEventListener('click', () => {
      $$('#shelf-filter button').forEach(x => x.classList.remove('on'));
      b.classList.add('on');
      S.filter = b.dataset.f;
      renderShelf();
    }));

    bindDropZone();
    bindKeys();
  }

  function bindNav() {
    $$('.rail-btn').forEach(b => b.addEventListener('click', () => setView(b.dataset.view)));
  }

  function setView(v) {
    S.view = v;
    $$('.rail-btn').forEach(b => b.classList.toggle('active', b.dataset.view === v));
    $$('.view').forEach(el => el.classList.toggle('active', el.id === 'view-' + v));
    const names = { shelf: '书架', search: '搜索', sources: '书源', web: '网页搜书', bookmarks: '书签', history: '历史', stats: '统计', settings: '设置' };
    $('#tb-title').textContent = names[v] || '';
    if (v === 'shelf') renderShelf();
    if (v === 'search') renderSearch();
    if (v === 'sources') renderSources();
    if (v === 'web') renderWeb();
    if (v === 'bookmarks') renderBookmarks();
    if (v === 'history') renderHistory();
    if (v === 'stats') renderStats();
    if (v === 'settings') renderSettings();
  }

  /* ---------------- 导入本地书 ---------------- */
  async function importBooks() {
    const paths = await mo.pickBooks();
    if (!paths || !paths.length) return;
    await doImport(paths);
  }

  async function doImport(paths) {
    toast('正在解析 ' + paths.length + ' 个文件…');
    let results;
    try {
      results = (await mo.importLocal(paths)) || [];
    } catch (e) {
      toast('导入失败：' + (e.message || e), 4200);
      return;
    }
    const errs = [], names = [];
    let ok = 0;
    for (const r of results) {
      if (r.error) { errs.push(r.error); continue; }
      const exists = S.state.books.find(b => b.name === r.name && b.kind === 'local');
      if (exists) {
        // 同名的直接覆盖内容
        Object.assign(exists, { total: r.total, localFile: r.localFile, ext: r.ext, chapters: r.chapters, updatedAt: Date.now() });
        S.state.progress[exists.id] = { ci: 0, title: exists.chapters[0] || '第 1 章', pct: 0, at: Date.now() };
      } else {
        upsertBook({
          id: r.id, name: r.name, author: r.author, kind: 'local', total: r.total,
          chapters: r.chapters, localFile: r.localFile, ext: r.ext,
          groupId: 'g_default', intro: '', cover: '',
          createdAt: Date.now(), updatedAt: Date.now()
        });
      }
      ok++; names.push(r.name);
    }
    save(true);
    renderShelf();
    /* 失败原因必须留在屏幕上：以前这里只报「没有可导入的文件」，
       真实的解析错误被后一条 toast 盖掉，看起来像是点了没反应。 */
    if (errs.length) {
      const head = ok > 0 ? `已导入 ${ok} 本，${errs.length} 个失败` : '导入失败';
      toast(head + '：' + errs[0] + (errs.length > 1 ? `（共 ${errs.length} 个）` : ''), 5200);
    } else if (ok === 1) {
      toast(`已导入《${names[0]}》`);
    } else if (ok > 1) {
      toast(`已导入 ${ok} 本`);
    } else {
      toast('没有可导入的文件');
    }
  }

  function bindDropZone() {
    const dz = $('#dropzone');
    if (!dz) return;                 // 安卓版摘掉了拖放区
    let depth = 0;
    window.addEventListener('dragenter', e => { e.preventDefault(); depth++; dz.classList.add('on'); });
    window.addEventListener('dragover', e => e.preventDefault());
    window.addEventListener('dragleave', () => { if (--depth <= 0) { depth = 0; dz.classList.remove('on'); } });
    window.addEventListener('drop', async e => {
      e.preventDefault(); depth = 0; dz.classList.remove('on');
      const list = [...(e.dataTransfer.files || [])];
      const files = list.map(f => f.path).filter(Boolean);   // Electron：File 带真实路径
      if (files.length) { doImport(files); return; }
      /* 浏览器里 File 没有 path：交给网页桥读进虚拟文件系统再导入 */
      const wb = window.MoNativeBridge;
      if (list.length && wb && wb.__stageFiles) {
        const items = await wb.__stageFiles(list);
        const paths = (items || []).filter(i => !i.error && i.path).map(i => i.path);
        if (paths.length) doImport(paths);
      }
    });
  }

  /* ---------------- 书架 ---------------- */
  function coverHTML(b) {
    const g = gradOf(b.name || '');
    const tag = b.kind === 'local' ? (b.ext === '.epub' ? 'EPUB' : 'TXT') : (b.kind === 'web' ? '网页' : '在线');
    const img = b.cover ? `<img src="${esc(b.cover)}" onerror="this.style.display='none'">` : '';
    const len = (b.name || '').length;
    const cls = len > 12 ? 'ct xlong' : len > 8 ? 'ct long' : 'ct';
    return `<div class="cover" style="background:linear-gradient(150deg,${g[0]},${g[1]})">
      ${img}
      <div class="${cls}">${esc(b.name || '')}</div>
      <div class="ca">${esc(b.author || '')}</div>
      <div class="tagline">${tag}</div>
    </div>`;
  }

  function pctOf(b) {
    const p = progressOf(b.id);
    if (!p || !b.total) return 0;
    return clamp(Math.round((p.ci / b.total) * 100), 0, 100);
  }

  function renderShelf() {
    const st = S.state;
    const reading = st.books.filter(b => progressOf(b.id) && (progressOf(b.id).ci || 0) < (b.total || 1)).length;
    $('#shelf-sub').textContent = `${st.books.length} 本 · ${reading} 本在读`;

    // 分组 tabs
    const counts = {};
    st.books.forEach(b => { const g = b.groupId || 'g_default'; counts[g] = (counts[g] || 0) + 1; });
    $('#group-tabs').innerHTML = [
      `<button class="${S.group === 'all' ? 'on' : ''}" data-g="all">全部<span class="cnt">${st.books.length}</span></button>`,
      `<button class="${S.group === 'none' ? 'on' : ''}" data-g="none">默认分组<span class="cnt">${counts['g_default'] || 0}</span></button>`,
      ...st.groups.filter(g => g.id !== 'g_default').map(g =>
        `<button class="${S.group === g.id ? 'on' : ''}" data-g="${g.id}">${esc(g.name)}<span class="cnt">${counts[g.id] || 0}</span></button>`),
      `<button data-g="__new">＋ 新分组</button>`
    ].join('');
    $$('#group-tabs button').forEach(b => b.onclick = () => {
      if (b.dataset.g === '__new') return newGroup();
      S.group = b.dataset.g; renderShelf();
    });

    // Hero
    const recent = st.history[0];
    const heroBook = recent ? getBook(recent.bookId) : st.books[0];
    const heroEl = $('#shelf-hero');
    if (!heroBook) {
      heroEl.innerHTML = '';
    } else {
      const p = progressOf(heroBook.id);
      const pct = pctOf(heroBook);
      heroEl.innerHTML = `<div class="hero">
        ${coverHTML(heroBook)}
        <div class="hero-body">
          <div class="kicker">继 续 阅 读</div>
          <h2>${esc(heroBook.name)}</h2>
          <div class="meta">${esc(heroBook.author || '佚名')} · ${heroBook.kind === 'local' ? '本地书' : esc(heroBook.sourceName || '在线')} · 共 ${heroBook.total || '?'} 章</div>
          <div class="prog"><i style="width:${pct}%"></i></div>
          <div class="prog-txt">${p ? '读到 ' + esc(p.title || '') + ' · ' + pct + '%' : '尚未开始'}</div>
          <div class="hero-actions">
            <button class="btn primary" data-open="${heroBook.id}">${p ? '继续阅读' : '开始阅读'}</button>
            <button class="btn" data-restart="${heroBook.id}">从头开始</button>
          </div>
        </div>
      </div>`;
      $('[data-open]', heroEl).onclick = () => openReader(heroBook.id);
      $('[data-restart]', heroEl).onclick = () => openReader(heroBook.id, 0);
    }

    // 列表
    let list = st.books;
    if (S.filter === 'local') list = list.filter(b => b.kind === 'local');
    else if (S.filter === 'online') list = list.filter(b => b.kind !== 'local');
    if (S.group === 'none') list = list.filter(b => !b.groupId || b.groupId === 'g_default');
    else if (S.group !== 'all') list = list.filter(b => b.groupId === S.group);

    $('#books').innerHTML = list.map(b => {
      const p = progressOf(b.id);
      return `<div class="book" data-id="${b.id}">
        ${coverHTML(b)}
        <div class="bt">${esc(b.name)}</div>
        <div class="bm">${esc(b.author || '佚名')}${p ? ' · ' + esc(p.title || '') : ''}</div>
        <div class="bar"><i style="width:${pctOf(b)}%"></i></div>
        <button class="del" data-del="${b.id}" title="移出书架">×</button>
        <button class="more" data-menu="${b.id}" title="更多（分组 / 更新目录）">⋯</button>
      </div>`;
    }).join('') || (IS_WEB
      ? `<div class="empty web-start" style="grid-column:1/-1">
          <b>书架还是空的</b>
          <p>书、书源、阅读进度都存在你这台设备的浏览器里，不会上传到任何服务器。</p>
          <div class="web-start-btns">
            <button class="btn primary" data-start="import">导入本地书（TXT / EPUB）</button>
            <button class="btn" data-start="restore">从备份文件恢复</button>
            <button class="btn" data-start="source">去书源找网络小说</button>
          </div>
          <p class="web-start-tip">换设备、或清理过浏览器数据后，用「从备份文件恢复」把书架和进度找回来。</p>
        </div>`
      : `<div class="empty" style="grid-column:1/-1">书架还是空的。<br>${isAndroidApp()
        ? '点右上角 <b>导入</b> 选手机里的 txt / epub，或去「书源」搜网络小说。'
        : '拖入 TXT / EPUB，或去「书源」搜索网络小说。'}</div>`);

    /* 网页版空书架已经有引导卡，底部那条「拖进窗口」的提示是重复的，先收起来 */
    const dh = $('.drop-hint');
    if (dh) dh.style.display = (IS_WEB && !st.books.length) ? 'none' : '';

    /* 网页版空书架的三个入口 */
    $$('#books [data-start]').forEach(btn => {
      btn.onclick = () => {
        const k = btn.dataset.start;
        if (k === 'import') importBooks();
        else if (k === 'restore') restoreFromZip();
        else if (k === 'source') setView('web');
      };
    });

    $$('#books .book').forEach(el => {
      el.onclick = e => {
        if (e.target.dataset.del || e.target.dataset.menu) return;
        const b = getBook(el.dataset.id);
        const p = progressOf(b.id);
        openReader(b.id, p ? p.ci : 0);
      };
      el.oncontextmenu = e => {
        e.preventDefault();
        bookMenu(el.dataset.id);
      };
      /* 手机上既没有 hover 也没有右键：长按 500ms 弹菜单，
         手指一挪动就取消，免得滑动列表时误触。 */
      if (isAndroidApp()) {
        let timer = null, sx = 0, sy = 0;
        el.addEventListener('pointerdown', e => {
          if (e.pointerType === 'mouse') return;
          sx = e.clientX; sy = e.clientY;
          clearTimeout(timer);
          timer = setTimeout(() => { timer = null; bookMenu(el.dataset.id); }, 500);
        });
        const cancel = e => {
          if (e && (Math.abs(e.clientX - sx) > 8 || Math.abs(e.clientY - sy) > 8)) clearTimeout(timer);
          clearTimeout(timer); timer = null;
        };
        el.addEventListener('pointerup', cancel);
        el.addEventListener('pointercancel', cancel);
        el.addEventListener('pointermove', cancel);
      }
    });
    $$('#books [data-del]').forEach(btn => btn.onclick = async e => {
      e.stopPropagation();
      const b = getBook(btn.dataset.del);
      if (!confirm(`把《${b.name}》移出书架？`)) return;
      S.state.books = S.state.books.filter(x => x.id !== b.id);
      delete S.state.progress[b.id];
      S.state.bookmarks = S.state.bookmarks.filter(x => x.bookId !== b.id);
      S.state.history = S.state.history.filter(x => x.bookId !== b.id);
      await mo.deleteBookFiles(b.id);
      save(true);
      renderShelf();
      toast('已移除');
    });
    $$('#books [data-menu]').forEach(btn => btn.onclick = e => {
      e.stopPropagation();
      bookMenu(btn.dataset.menu);
    });
  }

  function bookMenu(id) {
    const b = getBook(id);
    if (!b) return;
    const groups = S.state.groups;
    const cur = b.groupId || 'g_default';
    openModal(`<h3>${esc(b.name)}</h3>
      <p class="desc">${esc(b.author || '佚名')} · ${b.kind === 'local' ? '本地书' : '在线书 · ' + esc(b.sourceName || '')} · ${b.total || 0} 章
      ${b.intro ? '<br>' + esc(b.intro.slice(0, 120)) : ''}</p>
      <div class="form-grid">
        <div class="field"><label>归入分组</label>
          <select id="m-group">${groups.map(g => `<option value="${g.id}" ${g.id === cur ? 'selected' : ''}>${esc(g.name)}</option>`).join('')}</select>
        </div>
        <div class="field"><label>操作</label>
          <div style="display:flex;gap:8px;flex-wrap:wrap">
            <button class="btn" id="m-open" style="flex:1">打开</button>
            ${b.kind !== 'local' ? '<button class="btn" id="m-refresh" style="flex:1">更新目录</button>' : ''}
            ${b.kind !== 'local' ? '<button class="btn" id="m-switch" style="flex:1">换源</button>' : ''}
          </div>
        </div>
      </div>
      <div class="modal-actions">
        <button class="btn danger left" id="m-del">移出书架</button>
        <button class="btn" onclick="window.__closeModal()">取消</button>
        <button class="btn primary" id="m-save">保存</button>
      </div>`);
    $('#m-open').onclick = () => { closeModal(); const p = progressOf(b.id); openReader(b.id, p ? p.ci : 0); };
    const rf = $('#m-refresh');
    if (rf) rf.onclick = async () => {
      rf.disabled = true; rf.textContent = '更新中…';
      try {
        const src = srcForBook(b);
        if (!src) throw new Error('书源不存在');
        const { chapters, info } = await Engine.getToc(mo.net, src, b.bookUrl);
        b.chapters = chapters; b.total = chapters.length; b.updatedAt = Date.now();
        if (info.coverUrl) b.cover = info.coverUrl;
        save(true);
        toast(`目录已更新：${chapters.length} 章`);
      } catch (e) { toast('更新失败：' + (e.message || e)); }
      rf.disabled = false; rf.textContent = '更新目录';
    };
    const sw = $('#m-switch');
    if (sw) sw.onclick = () => { closeModal(); openReader(b.id).then(() => switchSource()); };
    $('#m-del').onclick = async () => {
      if (!confirm(`把《${b.name}》移出书架？`)) return;
      S.state.books = S.state.books.filter(x => x.id !== b.id);
      delete S.state.progress[b.id];
      S.state.bookmarks = S.state.bookmarks.filter(x => x.bookId !== b.id);
      S.state.history = S.state.history.filter(x => x.bookId !== b.id);
      await mo.deleteBookFiles(b.id);
      save(true); closeModal(); renderShelf(); toast('已移除');
    };
    $('#m-save').onclick = () => {
      b.groupId = $('#m-group').value;
      save(true); closeModal(); renderShelf(); toast('已保存');
    };
  }

  function newGroup() {
    openModal(`<h3>新建分组</h3>
      <p class="desc">分组可以用来整理书架，比如「在追」「已完结」「技术书」。</p>
      <div class="field"><label>分组名称</label><input id="g-name" placeholder="例如：在追" /></div>
      <div class="modal-actions"><button class="btn" onclick="window.__closeModal()">取消</button>
      <button class="btn primary" id="g-save">创建</button></div>`);
    $('#g-name').focus();
    $('#g-name').onkeydown = e => { if (e.key === 'Enter') $('#g-save').click(); };
    $('#g-save').onclick = () => {
      const name = $('#g-name').value.trim();
      if (!name) return;
      S.state.groups.push({ id: uid('G'), name });
      save(true); closeModal(); renderShelf(); toast('已创建分组');
    };
  }
  window.__closeModal = closeModal;

  /* ---------------- 搜索 ---------------- */
  function renderSearch() {
    const v = $('#view-search');
    if (v.dataset.ready) return;
    v.dataset.ready = '1';
    v.innerHTML = `
      <div class="page-head">
        <h1>搜索</h1>
        <span class="sub" id="search-sub"></span>
        <div class="head-tools">
          <div class="searchbox" style="width:320px">
            <svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.6-3.6"/></svg>
            <input id="search-input" placeholder="输入书名或作者，回车搜索" />
          </div>
          <button class="btn primary" id="btn-do-search">搜索</button>
        </div>
      </div>
      <div class="list" id="search-results"><div class="empty">启用书源后，可以在线搜索小说。<br>没有书源？去「书源」导入 Legado 书源 JSON。</div></div>`;
    $('#search-input').addEventListener('keydown', e => { if (e.key === 'Enter') runSearch(e.target.value.trim()); });
    $('#btn-do-search').onclick = () => runSearch($('#search-input').value.trim());
  }

  /** 书源太多时不能全量去搜：优先书架上用得到的、搜成功过的 */
  function pickSearchSources(all, n) {
    if (all.length <= n) return all;
    const used = new Set(S.state.books.map(b => b.sourceId).filter(Boolean));
    /* 检测结果优先：优质 > 有效 > 书架用过 > 未检测 > 较差 > 无用 */
    const tier = s => {
      if (s.quality === 'great') return 0;
      if (s.quality === 'ok') return 1;
      if (used.has(s.id)) return 2;
      if (s.quality === 'poor') return 4;
      if (s.quality === 'dead') return 5;
      return 3;
    };
    const idx = new Map(all.map((s, i) => [s, i]));
    return all.slice()
      .sort((a, b) => (tier(a) - tier(b)) || (idx.get(a) - idx.get(b)))
      .slice(0, n)
      .sort((a, b) => idx.get(a) - idx.get(b));
  }

  let searchSeq = 0;
  async function runSearch(kw) {
    if (!kw) return;
    renderSearch();
    const seq = ++searchSeq;
    const all = S.state.sources.filter(s => s.enabled && s.searchUrl);
    const cap = clamp(S.state.settings.searchLimit || 40, 1, 500);
    const srcs = pickSearchSources(all, cap);
    const local = S.state.books.filter(b => (b.name + (b.author || '')).toLowerCase().includes(kw.toLowerCase()));
    const box = $('#search-results');
    $('#search-sub').textContent = `${all.length} 个可用书源`;

    box.innerHTML = `
      ${local.length ? `<div class="src-label">本地书架 · ${local.length}</div>` + local.map(b => `
        <div class="row-card"><div class="ico">${esc((b.name || '?')[0])}</div>
          <div class="body"><div class="t">${esc(b.name)}</div><div class="s">${esc(b.author)} · 本地</div></div>
          <div class="act"><button class="btn sm" data-open-local="${b.id}">打开</button></div>
        </div>`).join('') : ''}
      <div class="src-label" id="search-progress">正在搜索网络书源…</div>
      ${all.length > srcs.length ? `<div class="search-note">书源较多，本次只搜 ${srcs.length} 个（优先书架用到的和搜成功过的）。可在设置里调整「每次搜索的书源数」。</div>` : ''}
      <div id="search-online"></div>`;

    $$('[data-open-local]').forEach(b => b.onclick = () => {
      const bk = getBook(b.dataset.openLocal);
      const p = progressOf(bk.id);
      openReader(bk.id, p ? p.ci : 0);
    });

    if (!srcs.length) {
      $('#search-progress').innerHTML = '没有启用的书源 —— <a class="link" id="go-src">去书源页</a>';
      $('#go-src').onclick = () => setView('sources');
      return;
    }

    const online = $('#search-online');
    const results = [];
    let done = 0, hitSrc = 0, failed = 0;
    const paintStat = () => {
      const p = $('#search-progress');
      if (!p) return;
      p.textContent = `已搜索 ${done}/${srcs.length} 个源 · 命中 ${hitSrc} 个 · 失败 ${failed} · 共 ${results.length} 条`;
    };
    paintStat();

    const limit = clamp(S.state.settings.maxConcurrent || 3, 1, 6);
    let cursor = 0;
    async function worker() {
      while (cursor < srcs.length) {
        const i = cursor++;
        const s = srcs[i];
        if (seq !== searchSeq) return;
        try {
          const t0 = performance.now();
          const r = await withTimeout(Engine.search(mo.net, s, kw), 9000);
          const ms = Math.round(performance.now() - t0);
          s.lastTest = Date.now(); s.lastLatency = ms; s.lastCount = r.length; s.lastError = '';
          if (r.length) hitSrc++;
          results.push(...r);
          if (seq === searchSeq) paintOnline(results);
        } catch (e) {
          failed++;
          s.lastError = e.message || String(e);
        }
        done++;
        if (seq === searchSeq) paintStat();
      }
    }
    await Promise.all(Array.from({ length: limit }, worker));
    if (seq === searchSeq) {
      const p = $('#search-progress');
      if (p) p.textContent = `搜索完成 · ${srcs.length} 个源 · 命中 ${hitSrc} 个 · 共 ${results.length} 条`;
      save();
    }
  }

  function paintOnline(list) {
    const box = $('#search-online');
    if (!box) return;
    if (!list.length) { box.innerHTML = `<div class="empty">没有找到结果，换个关键词，或检查书源规则。</div>`; return; }
    box.innerHTML = `<div class="src-label">网络 · ${list.length}</div>` + list.slice(0, 80).map((r, i) => `
      <div class="row-card">
        ${r.coverUrl ? `<img src="${esc(r.coverUrl)}" style="width:34px;height:46px;object-fit:cover;border-radius:4px" onerror="this.style.visibility='hidden'">`
          : `<div class="ico">${esc((r.name || '?')[0])}</div>`}
        <div class="body">
          <div class="t">${esc(r.name)}</div>
          <div class="s">${esc(r.author)} · ${esc(r.sourceName)}${r.lastChapter ? ' · ' + esc(r.lastChapter) : ''}</div>
        </div>
        <div class="act"><button class="btn sm primary" data-add="${i}">加入书架</button></div>
      </div>`).join('');
    $$('[data-add]').forEach(b => b.onclick = async () => {
      b.disabled = true; b.textContent = '添加中…';
      await addOnlineBook(list[+b.dataset.add]);
      b.textContent = '已加入';
    });
  }

  async function addOnlineBook(r) {
    const src = sourceById(r.sourceId);
    const exists = S.state.books.find(b => b.bookUrl === r.bookUrl);
    if (exists) { toast('这本书已经在书架里了'); return exists; }
    const book = {
      id: uid('O'), name: r.name, author: r.author, kind: 'online',
      sourceId: r.sourceId, sourceName: src ? src.name : r.sourceName,
      bookUrl: r.bookUrl, intro: r.intro || '', cover: r.coverUrl || '',
      total: 0, chapters: [], groupId: 'g_default',
      createdAt: Date.now(), updatedAt: Date.now()
    };
    upsertBook(book);
    renderShelf();
    toast(`已加入《${r.name}》，正在获取目录…`);
    try {
      const { chapters, info } = await Engine.getToc(mo.net, src, r.bookUrl);
      book.chapters = chapters;
      book.total = chapters.length;
      if (info.intro) book.intro = info.intro;
      if (info.coverUrl) book.cover = info.coverUrl;
      if (info.author) book.author = info.author;
      save(true);
      renderShelf();
      toast(`《${book.name}》目录 ${chapters.length} 章`);
    } catch (e) {
      toast('目录获取失败：' + (e.message || e));
    }
    return book;
  }

  /* ===========================================================
     网页搜书（内置浏览器 + 自动嗅探加书架）
     =========================================================== */
  const WEB = { built: false, view: null, lastUrl: '' };

  const ENGINES = {
    bing: k => 'https://www.bing.com/search?q=' + encodeURIComponent(k),
    baidu: k => 'https://www.baidu.com/s?wd=' + encodeURIComponent(k),
    sogou: k => 'https://www.sogou.com/web?query=' + encodeURIComponent(k),
    so360: k => 'https://www.so.com/s?q=' + encodeURIComponent(k)
  };

  function isUrlLike(s) {
    return /^(https?:\/\/|www\.)\S+$/i.test(s.trim());
  }

  function renderWeb() {
    if (isAndroidApp()) return renderWebMobile();
    const v = $('#view-web');
    if (WEB.built) { updateWebNav(); return; }

    v.innerHTML = `
      <div class="web-bar">
        <div class="wb-nav">
          <button class="wbtn" id="w-back" title="后退"><svg viewBox="0 0 24 24"><path d="M15 5l-7 7 7 7"/></svg></button>
          <button class="wbtn" id="w-fwd" title="前进"><svg viewBox="0 0 24 24"><path d="M9 5l7 7-7 7"/></svg></button>
          <button class="wbtn" id="w-reload" title="刷新"><svg viewBox="0 0 24 24"><path d="M20 11a8 8 0 1 0-2.3 5.7"/><path d="M20 4v7h-7"/></svg></button>
        </div>
        <input id="w-url" class="w-url" spellcheck="false" placeholder="输入网址，或直接输入书名搜索（回车）" />
        <button class="btn sm" id="w-go">打开</button>
        <button class="btn sm" id="w-sniff">
          <svg viewBox="0 0 24 24" style="width:14px;height:14px"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.6-3.6"/></svg>
          嗅探本页
        </button>
        <select id="w-engine" class="w-engine" title="搜索引擎">
          ${[['bing', '必应'], ['baidu', '百度'], ['sogou', '搜狗'], ['so360', '360']].map(([k, n]) =>
            `<option value="${k}" ${(S.state.settings.webSearch.engine || 'bing') === k ? 'selected' : ''}>${n}</option>`).join('')}
        </select>
      </div>
      <div class="web-body">
        <div class="web-host" id="w-host"></div>
        <div class="web-empty" id="w-empty">
          <div class="we-box">
            <div class="we-t">网页搜书</div>
            <div class="we-s">在上面输入网址，或直接输入书名回车；也可以用搜索引擎找到小说站，再点「嗅探本页」把书加进书架。</div>
            <div class="we-acts">
              <button class="btn sm" data-we="https://www.bing.com">打开必应</button>
              <button class="btn sm" data-we="https://www.baidu.com">打开百度</button>
              <button class="btn sm" data-we="paste">粘贴地址</button>
            </div>
            <ul class="we-tips">
              <li>「嗅探本页」会自动找目录和正文，为这本书生成抓取规则</li>
              <li>加进书架后按章节读，和书源的书一样能记进度、换源、朗读</li>
              <li>部分站点会拦截抓取，换个页面或稍后再试</li>
            </ul>
          </div>
        </div>
        <div class="web-loading" id="w-loading"><i></i></div>
        <div class="web-panel" id="w-panel"></div>
      </div>`;

    const wv = document.createElement('webview');
    wv.id = 'w-view';
    wv.setAttribute('partition', 'persist:moread-web');
    wv.setAttribute('allowpopups', 'false');
    wv.setAttribute('src', S.state.settings.webSearch.url || 'about:blank');
    $('#w-host').appendChild(wv);
    WEB.view = wv;
    WEB.built = true;

    wv.addEventListener('did-start-loading', () => $('#w-loading').classList.add('on'));
    wv.addEventListener('did-stop-loading', () => {
      $('#w-loading').classList.remove('on');
      updateWebNav();
    });
    const onNav = e => {
      WEB.lastUrl = e.url || wv.getURL();
      $('#w-url').value = /^about:blank/i.test(WEB.lastUrl) ? '' : WEB.lastUrl;
      $('#w-empty').style.display = /^https?:/i.test(WEB.lastUrl) ? 'none' : '';
      S.state.settings.webSearch.url = WEB.lastUrl;
      save();
    };
    wv.addEventListener('did-navigate', onNav);
    wv.addEventListener('did-navigate-in-page', onNav);
    wv.addEventListener('new-window', e => { if (e.url) wv.loadURL(e.url); });
    wv.addEventListener('page-title-updated', e => { $('#tb-title').textContent = '网页 · ' + (e.title || '').slice(0, 26); });

    $('#w-back').onclick = () => { try { if (wv.canGoBack()) wv.goBack(); } catch (e) {} };
    $('#w-fwd').onclick = () => { try { if (wv.canGoForward()) wv.goForward(); } catch (e) {} };
    $('#w-reload').onclick = () => { try { wv.reload(); } catch (e) {} };
    $('#w-go').onclick = () => webGo($('#w-url').value.trim());
    $('#w-url').addEventListener('keydown', e => { if (e.key === 'Enter') webGo(e.target.value.trim()); });
    $('#w-engine').onchange = e => { S.state.settings.webSearch.engine = e.target.value; save(true); };
    $('#w-sniff').onclick = () => sniffCurrentPage();
    $$('#w-empty [data-we]').forEach(b => b.onclick = async () => {
      const t = b.dataset.we;
      if (t === 'paste') {
        try {
          const txt = await navigator.clipboard.readText();
          if (txt && txt.trim()) webGo(txt.trim());
          else toast('剪贴板是空的');
        } catch (e) { toast('读不到剪贴板，手动粘贴到地址栏吧'); }
        return;
      }
      webGo(t);
    });
    $('#w-empty').style.display = /^https?:/i.test(WEB.lastUrl || S.state.settings.webSearch.url || '') ? 'none' : '';
    updateWebNav();
  }

  /* ================= 手机端网页搜书（抓取式） =================
   * 安卓 WebView 没有 Electron 的 <webview> 标签：document.createElement('webview')
   * 只是个未知元素 —— 不渲染、没有 loadURL/getURL，原来那版在手机上点「打开」毫无反应。
   * 手机屏也塞不下一个迷你浏览器，所以这里换成「抓回来自己看」：
   *   抓 HTML → Engine 本地嗅探 → 只给「这页能不能读 / 有哪些书」的结论，一键入书架。
   * 桌面端仍走 <webview>，两边互不影响。 */
  function isAndroidApp() {
    if (typeof window.MoNativeBridge !== 'undefined') {
      return !window.MoNativeBridge.__isWebDesktop;   // 网页版桌面浏览器按桌面处理
    }
    return document.documentElement.classList.contains('is-android');
  }

  const WA = { built: false, stack: [], busy: false, lastUrl: '' };

  function hostOf(u) {
    try { return new URL(u).host.replace(/^www\./, ''); } catch (e) { return ''; }
  }

  /** 搜索引擎结果页：这种页面本身不该被当成「一本书」，只该当成导航 */
  function isSerpUrl(u) {
    try {
      const x = new URL(u);
      /* cn.bing.com / m.baidu.com 这种带子域的也算，之前写成 ^bing\. 只认裸域名，
         结果必应搜索页被当成了「正文」，一路走到「加入书架」。 */
      const host = x.host.replace(/^www\./, '').replace(/^m\./, '');
      if (!/(^|\.)(bing|baidu|sogou|so|google|zhihu|sm|yandex)\.(com|cn|net)$/.test(host)) return false;
      return /\/(search|s|web|so)\/?$/i.test(x.pathname.replace(/\/$/, '')) ||
        /[?&](q|wd|query|word)=/i.test(x.search);
    } catch (e) { return false; }
  }

  /** 搜索结果的导航项（网页 / 图片 / 视频 …）不是书，直接扔掉 */
  const WA_NAV = /^(网页|图片|视频|地图|词典|学术|航班|搜索|更多|全部|资讯|知道|文库|经验|音乐|翻译|购物|新闻|贴吧|百科)$/;
  /** 搜索结果页脚那些备案 / 条款 / 时间筛选链接 */
  const WA_JUNK = /备案|ICP备|公网安备|增值电信|许可证|隐私|条款|举报|营业执照|关于我们|联系我们|帮助中心|广告合作|小时内|一周内|一个月内|去年|时间不限/i;

  function resolveWebUrl(raw) {
    const s = String(raw || '').trim();
    if (/^https?:\/\//i.test(s)) return s;
    if (/^www\./i.test(s)) return 'https://' + s;
    // 形如 xxx.com/path 也当网址，其余一律交给搜索引擎
    if (/^[\w.-]+\.[a-z]{2,}(\/\S*)?$/i.test(s)) return 'https://' + s;
    const eng = S.state.settings.webSearch.engine || 'bing';
    return (ENGINES[eng] || ENGINES.bing)(s);
  }

  function renderWebMobile() {
    if (WA.built) return;
    WA.built = true;
    WEB.built = true;
    const eng = S.state.settings.webSearch.engine || 'bing';
    const v = $('#view-web');
    v.innerHTML = `
      <div class="wa-bar">
        <input id="wa-input" class="wa-input" spellcheck="false" enterkeyhint="search"
               placeholder="输入书名，或粘贴小说站网址">
        <button class="btn sm primary" id="wa-go">搜索</button>
      </div>
      <div class="wa-tools">
        <select id="wa-engine" class="wa-engine" title="搜索引擎">
          ${[['bing', '必应'], ['baidu', '百度'], ['sogou', '搜狗'], ['so360', '360']]
            .map(([k, n]) => `<option value="${k}" ${eng === k ? 'selected' : ''}>${n}</option>`).join('')}
        </select>
        <button class="btn xs" id="wa-paste">粘贴网址</button>
        <button class="btn xs" id="wa-back" disabled>← 返回</button>
      </div>
      <div class="wa-list" id="wa-list"></div>`;
    $('#wa-go').onclick = () => waFetch($('#wa-input').value);
    $('#wa-input').addEventListener('keydown', e => { if (e.key === 'Enter') waFetch(e.target.value); });
    $('#wa-engine').onchange = e => { S.state.settings.webSearch.engine = e.target.value; save(true); };
    $('#wa-paste').onclick = async () => {
      try {
        const t = ((await navigator.clipboard.readText()) || '').trim();
        if (!t) return toast('剪贴板是空的');
        $('#wa-input').value = t;
        waFetch(t);
      } catch (e) { toast('读不到剪贴板，长按输入框粘贴吧'); }
    };
    $('#wa-back').onclick = () => {
      const prev = WA.stack.pop();
      $('#wa-back').disabled = !WA.stack.length;
      if (prev) waFetch(prev, true);
      else waHome();
    };
    waHome();
  }

  function waHome() {
    WA.lastUrl = '';
    $('#wa-list').innerHTML = `
      <div class="wa-home">
        <div class="wa-home-t">网页搜书</div>
        <div class="wa-home-s">输入书名用搜索引擎找站，或把小说站的目录页地址直接粘进来。
          抓到页面后会在本机识别目录和正文，认出来就能一键加进书架。</div>
        <div class="wa-home-li">· 加进书架后按章节读，和书源的书一样能记进度、换源、朗读</div>
        <div class="wa-home-li">· 站点有反爬或整页 JS 渲染时可能抓不到，换个站再试</div>
      </div>`;
  }

  async function waFetch(input, isBack) {
    const raw = String(input || '').trim();
    if (!raw || WA.busy) return;
    const url = resolveWebUrl(raw);
    const list = $('#wa-list');
    if (!isBack && WA.lastUrl && WA.lastUrl !== url) {
      WA.stack.push(WA.lastUrl);
      if (WA.stack.length > 12) WA.stack.shift();
    }
    $('#wa-back').disabled = !WA.stack.length;
    $('#wa-input').value = raw;
    WA.busy = true;
    list.innerHTML = `<div class="wa-loading"><i></i><span>正在抓取 ${esc(hostOf(url) || '页面')} …</span></div>`;
    let r;
    try {
      r = await mo.net({ url, charset: 'auto' });
    } catch (e) {
      r = { ok: false, error: e.message || String(e) };
    }
    WA.busy = false;
    if (!r || !r.ok) {
      list.innerHTML = `
        <div class="wa-card bad">
          <div class="wa-card-t">打不开这个地址</div>
          <div class="wa-card-s">${esc((r && r.error) || '网络错误')}</div>
          <div class="wa-card-a"><button class="btn sm" id="wa-retry">重试</button></div>
        </div>
        <div class="wa-src">${esc(url)}</div>`;
      $('#wa-retry').onclick = () => waFetch(raw, true);
      return;
    }
    const finalUrl = r.url || url;
    WA.lastUrl = finalUrl;
    const txt = r.text || '';
    /* 被反爬拦下来的页面通常很短且带验证字样，直接说清楚，别让用户以为是站点没内容。
       阈值放宽到 9000：搜狗的拦截页有 5KB 多，只是正文较长的正常页面不会有这些字样。 */
    if (txt.length < 9000 && /安全验证|人机验证|验证码|captcha|访问异常|拒绝访问|滑动验证|反爬/i.test(txt)) {
      list.innerHTML = `
        <div class="wa-card bad">
          <div class="wa-card-t">这个站拦了自动抓取</div>
          <div class="wa-card-s">${esc(hostOf(finalUrl))} 要求人机验证，换个搜索引擎或换一家站点试试。</div>
        </div>
        <div class="wa-src">${esc(hostOf(finalUrl))}</div>`;
      return;
    }
    let d;
    try {
      d = Engine.detectPage(txt, finalUrl);
    } catch (e) {
      d = { info: {}, toc: null, content: null, links: [], title: '' };
    }
    renderWaResult(d, finalUrl, isSerpUrl(finalUrl));
  }

  function renderWaResult(d, url, serp) {
    const list = $('#wa-list');
    const host = hostOf(url);
    /* 引擎自己认出这是搜索结果页时也算数（各家域名太多，光靠 URL 判断会漏） */
    serp = serp || !!d.serp;
    /* 搜索页上「正文 1337 字」把结果摘要当成了正文，加书架会存一本假书；
       同域链接也要滤掉（那是导航栏），目录页里恰恰相反 —— 同域才是章节 */
    const links = (d.links || []).filter(l => {
      if (!l || !l.url) return false;
      const t = (l.title || '').trim();
      if (!t || WA_NAV.test(t)) return false;
      if (serp && (hostOf(l.url) === host || WA_JUNK.test(t))) return false;
      return true;
    }).map(l => ({
      url: l.url,
      /* 搜索结果的锚文本常把整段 URL 也带进来（「三体 https://... › item」），切掉 */
      title: String(l.title || '').replace(/\s*https?:\/\/.*$/i, '').replace(/\s+/g, ' ').trim().slice(0, 80) || hostOf(l.url)
    }))
      /* 只剩一个域名（baidu.com）的条目对用户没有意义，宁可不显示 */
      .filter(l => l.title && !WA_NAV.test(l.title) && !/^[\w-]+(\.[\w-]+)+$/.test(l.title))
      .slice(0, 40);
    const readable = !serp && !!(d.toc || d.content);
    const tocN = d.toc ? d.toc.chapters.length : 0;
    const chars = d.content ? d.content.chars : 0;
    const name = (d.info && d.info.name) || d.title || host || '未识别书名';
    const card = readable
      ? `<div class="wa-card ok">
           <div class="wa-card-t">${esc(String(name).slice(0, 40))}</div>
           <div class="wa-card-s">${tocN ? `目录 ${tocN} 章` : '未识别到目录'}${chars ? ` · 正文 ${chars} 字` : ''}</div>
           <div class="wa-card-a">
             <button class="btn sm primary" id="wa-add">加入书架</button>
             ${d.toc ? `<button class="btn sm" id="wa-add-toc">只导入目录</button>` : ''}
           </div>
         </div>`
      : `<div class="wa-card bad">
           <div class="wa-card-t">${serp ? (links.length ? `搜索到 ${links.length} 个结果` : '这一页没读出结果') : '这一页没有直接的目录或正文'}</div>
           <div class="wa-card-s">${serp
             ? (links.length ? '点下面的条目进站，能读的话会自动认出来' : '搜索引擎的页面版式经常变，也可能是被限流了。换「必应」再搜一次，或把小说站的目录页地址直接粘进来')
             : (links.length ? '多半是详情页：点下面「查看目录」再嗅探一次，或者直接试着加入书架' : '换个链接，或把目录页地址直接粘进来')}</div>
           ${!serp && links.length ? `<div class="wa-card-a"><button class="btn sm" id="wa-add">试着加入书架</button></div>` : ''}
         </div>`;
    list.innerHTML = `
      <div class="wa-src">${esc(hostOf(url))}</div>
      ${card}
      ${links.length ? `<div class="wa-label">页面里的链接 · ${links.length}</div>
        <div class="wa-items">
          ${links.map((l, i) => `<button class="wa-item" data-wa-open="${i}">
            <span class="wa-item-t">${esc(l.title)}</span>
            <span class="wa-item-u">${esc(hostOf(l.url) || '')}</span>
          </button>`).join('')}
        </div>` : ''}`;
    const addBtn = $('#wa-add');
    if (addBtn) {
      addBtn.onclick = async () => {
        addBtn.disabled = true; addBtn.textContent = '分析中…';
        try { await addWebBook(url, readable ? d : null); addBtn.textContent = '已加入'; }
        catch (e) { addBtn.disabled = false; addBtn.textContent = '加入书架'; toast('加入失败：' + (e.message || e)); }
      };
    }
    const at = $('#wa-add-toc');
    if (at) at.onclick = () => addWebBook(url, d, true);
    $$('[data-wa-open]').forEach(el => {
      el.onclick = () => waFetch(links[+el.dataset.waOpen].url);
    });
  }

  function updateWebNav() {
    const wv = WEB.view;
    if (!wv) return;
    try {
      $('#w-back').disabled = !wv.canGoBack();
      $('#w-fwd').disabled = !wv.canGoForward();
    } catch (e) { /* 未就绪 */ }
  }

  function webGo(input) {
    if (!input) return;
    const wv = WEB.view;
    if (!wv) return;
    let url;
    if (isUrlLike(input)) {
      url = input.startsWith('http') ? input : 'https://' + input;
    } else {
      const eng = S.state.settings.webSearch.engine || 'bing';
      url = (ENGINES[eng] || ENGINES.bing)(input);
    }
    wv.loadURL(url);
    $('#w-url').value = url;
    $('#w-panel').classList.remove('open');
  }

  async function webviewHtml() {
    const wv = WEB.view;
    if (!wv) return '';
    try {
      return await wv.executeJavaScript('document.documentElement.outerHTML', true);
    } catch (e) {
      return '';
    }
  }

  async function sniffCurrentPage() {
    const wv = WEB.view;
    if (!wv) return;
    const panel = $('#w-panel');
    panel.classList.add('open');
    panel.innerHTML = `<div class="wp-head">正在分析页面…</div>`;
    let url = '';
    try { url = wv.getURL(); } catch (e) { url = WEB.lastUrl; }
    const html = await webviewHtml();
    if (!html) {
      panel.innerHTML = `<div class="wp-head">读不到页面内容</div><div class="wp-body"><p class="hint">页面还没加载完，或该站点禁止读取。稍等一下再试。</p></div>`;
      return;
    }
    const d = Engine.detectPage(html, url);
    paintSniff(d, url);
  }

  function paintSniff(d, url) {
    const panel = $('#w-panel');
    const tocInfo = d.toc ? `识别到目录 ${d.toc.chapters.length} 章` : '未识别到目录';
    const contentInfo = d.content ? `正文 ${d.content.chars} 字` : '未识别到正文';
    const readable = !!(d.toc || d.content);
    const author = (d.links.length > 1 ? '' : d.info.author); // 列表页上的「作者：X」往往是某一本书的，不显示
    panel.innerHTML = `
      <div class="wp-head">本页分析 <button class="wbtn" id="wp-close" title="关闭">×</button></div>
      <div class="wp-body">
        <div class="wp-card">
          <div class="wp-title">${esc(d.info.name || d.title || '未识别书名')}</div>
          <div class="wp-sub">${author ? esc(author) + ' · ' : ''}${tocInfo} · ${contentInfo}</div>
          <div class="wp-act">
            <button class="btn sm primary" id="wp-add-page" ${readable ? '' : 'disabled'}>把本页加为书</button>
            ${d.toc ? `<button class="btn sm" id="wp-add-toc">只导入目录（${d.toc.chapters.length} 章）</button>` : ''}
          </div>
          ${readable ? '' : '<div class="hint" style="margin-top:8px">这一页没有目录也没有正文，可以点下面的书籍链接进去再嗅探。</div>'}
        </div>
        <div class="wp-label">本页的书籍链接 · ${d.links.length}</div>
        <div class="wp-list">
          ${d.links.length ? d.links.map((l, i) => `
            <div class="wp-item">
              <div class="wp-item-t" title="${esc(l.title)}">${esc(l.title)}</div>
              <div class="wp-item-a">
                <button class="btn xs" data-wp-open="${i}">打开</button>
                <button class="btn xs primary" data-wp-add="${i}">加书架</button>
              </div>
            </div>`).join('') : '<div class="hint">这一页没找到像书籍的链接。试试打开书的详情页，或直接粘贴目录页地址。</div>'}
        </div>
      </div>`;
    $('#wp-close').onclick = () => panel.classList.remove('open');
    $('#wp-add-page').onclick = () => addWebBook(url, d);
    const at = $('#wp-add-toc');
    if (at) at.onclick = () => addWebBook(url, d, true);
    $$('[data-wp-open]').forEach(b => b.onclick = () => {
      WEB.view.loadURL(d.links[+b.dataset.wpOpen].url);
      panel.classList.remove('open');
    });
    $$('[data-wp-add]').forEach(b => b.onclick = async () => {
      b.disabled = true; b.textContent = '分析中…';
      await addWebBook(d.links[+b.dataset.wpAdd].url);
      b.textContent = '已加入';
    });
  }

  /** 把一个网页地址变成书架里的书：抓页面 → 找目录/正文 → 生成规则 */
  async function addWebBook(url, detected, forceToc) {
    if (!url) return;
    const exists = S.state.books.find(b => b.bookUrl === url);
    if (exists) { toast('这本已经在书架里了'); return exists; }

    let d = detected;
    if (!d) {
      const r = await mo.net({ url, charset: 'auto' });
      if (!r.ok) return toast('打不开这个地址：' + r.error);
      d = Engine.detectPage(r.text, r.url || url);
    }

    // 详情页找不到目录 → 找「目录/章节」链接再抓一次
    if (!d.toc) {
      const r = await mo.net({ url, charset: 'auto' });
      if (r.ok) {
        const doc = new DOMParser().parseFromString(r.text, 'text/html');
        const link = [...doc.querySelectorAll('a[href]')].find(a => /^(目录|章节列表|查看目录|全部章节|章节目录)$/.test((a.textContent || '').trim()));
        if (link) {
          const tocUrl = Engine.absUrl(r.url || url, link.getAttribute('href'));
          const r2 = await mo.net({ url: tocUrl, charset: 'auto' });
          if (r2.ok) {
            const d2 = Engine.detectPage(r2.text, r2.url || tocUrl);
            if (d2.toc) d = Object.assign({}, d, { toc: d2.toc, content: d.content || d2.content });
          }
        }
      }
    }

    if (!d.toc && !d.content) return toast('这个页面里没找到可读的目录或正文');

    // 目录页/详情页里没有正文 → 抓第一章，把正文容器规则也嗅出来
    if (!d.content && d.toc && d.toc.chapters.length) {
      try {
        const rc = await mo.net({ url: d.toc.chapters[0].url, charset: 'auto' });
        if (rc.ok) {
          const dc = Engine.detectPage(rc.text, rc.url || d.toc.chapters[0].url);
          if (dc.content) d = Object.assign({}, d, { content: dc.content });
        }
      } catch (e) { /* 抓不到就靠引擎的兜底抽取 */ }
    }

    const name = (d.info.name || d.title || '未命名').replace(/[_-].*$/, '').trim().slice(0, 40) || '未命名';
    const chapters = d.toc ? d.toc.chapters : (d.content ? [{ title: name, url }] : []);
    const book = {
      id: uid('W'), name, author: d.info.author || '佚名', kind: 'web',
      bookUrl: url, sourceName: '网页抓取', intro: '',
      cover: '', total: chapters.length,
      chapters,
      webRule: {
        toc: d.toc ? d.toc.rule : null,
        content: d.content ? { content: d.content.selector } : null,
        siteUrl: (() => { try { return new URL(url).origin; } catch (e) { return ''; } })()
      },
      groupId: 'g_default', createdAt: Date.now(), updatedAt: Date.now()
    };

    if (!book.chapters.length && forceToc) return toast('这一页没有目录');

    upsertBook(book);
    renderShelf();
    toast(`已加入《${book.name}》${book.total ? '· ' + book.total + ' 章' : '（无目录，将按单页阅读）'}`);
    return book;
  }

  /** 书的取源对象：网页书用自己嗅探出来的规则 */
  function srcForBook(b) {
    if (b.kind === 'web') {
      return {
        id: '__web', name: b.sourceName || '网页抓取', charset: 'auto', url: b.webRule?.siteUrl || '',
        ruleSearch: {}, ruleBookInfo: {}, ruleToc: b.webRule?.toc || {}, ruleContent: b.webRule?.content || {}
      };
    }
    return sourceById(b.sourceId);
  }

  /* ---------------- 书源 ---------------- */

  const SRC_PAGE_SIZE = 50;

  const Q_NAME = { great: '优质', ok: '有效', poor: '较差', dead: '无用' };

  function srcFiltered() {
    const q = (S.srcQ || '').trim().toLowerCase();
    return S.state.sources.filter(s => {
      if (S.srcG && S.srcG !== 'all' && (s.group || '未分组') !== S.srcG) return false;
      if (S.srcE === 'on' && !s.enabled) return false;
      if (S.srcE === 'off' && s.enabled) return false;
      if (S.srcE === 'err' && !s.lastError) return false;
      if (S.srcQL && S.srcQL !== 'all') {
        const q = s.quality || 'none';
        if (S.srcQL === 'none' ? !!s.quality : q !== S.srcQL) return false;
      }
      if (q) {
        const hay = (s.name + ' ' + (s.url || '') + ' ' + (s.group || '')).toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }

  function renderSources() {
    const v = $('#view-sources');
    const st = S.state;
    const onCount = st.sources.filter(s => s.enabled).length;
    const groups = [...new Set(st.sources.map(s => s.group || '未分组'))].sort();
    const list = srcFiltered();
    const qc = { done: 0, great: 0, ok: 0, poor: 0, dead: 0 };
    for (const s of st.sources) if (s.quality) { qc.done++; if (qc[s.quality] != null) qc[s.quality]++; }
    const pages = Math.max(1, Math.ceil(list.length / SRC_PAGE_SIZE));
    S.srcPage = clamp(S.srcPage || 0, 0, pages - 1);
    const view = list.slice(S.srcPage * SRC_PAGE_SIZE, (S.srcPage + 1) * SRC_PAGE_SIZE);

    v.innerHTML = `
      <div class="page-head">
        <h1>书源</h1>
        <span class="sub">${st.sources.length} 个 · ${onCount} 个已启用${qc.done ? ` · 已检测 ${qc.done}：优质 ${qc.great} / 有效 ${qc.ok} / 较差 ${qc.poor} / 无用 ${qc.dead}` : ' · 未检测'}</span>
        <div class="head-tools">
          <button class="btn" id="src-import">导入 JSON</button>
          <button class="btn" id="src-paste">粘贴导入</button>
          <button class="btn" id="src-export">导出全部</button>
          <button class="btn primary" id="src-new">新建书源</button>
        </div>
      </div>
      ${st.sources.length ? `
      <div class="src-toolbar">
        <div class="searchbox src-q">
          <svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.6-3.6"/></svg>
          <input id="src-q" placeholder="搜索名称 / 网址 / 分组" value="${esc(S.srcQ || '')}" />
        </div>
        <select class="tb-select" id="src-group">
          <option value="all">全部分组（${groups.length}）</option>
          ${groups.map(g => `<option value="${esc(g)}" ${S.srcG === g ? 'selected' : ''}>${esc(g)}</option>`).join('')}
        </select>
        <select class="tb-select" id="src-enabled">
          <option value="all">全部状态</option>
          <option value="on" ${S.srcE === 'on' ? 'selected' : ''}>已启用</option>
          <option value="off" ${S.srcE === 'off' ? 'selected' : ''}>已停用</option>
          <option value="err" ${S.srcE === 'err' ? 'selected' : ''}>上次失败</option>
        </select>
        <select class="tb-select" id="src-quality">
          <option value="all">全部质量</option>
          <option value="great" ${S.srcQL === 'great' ? 'selected' : ''}>优质</option>
          <option value="ok" ${S.srcQL === 'ok' ? 'selected' : ''}>有效</option>
          <option value="poor" ${S.srcQL === 'poor' ? 'selected' : ''}>较差</option>
          <option value="dead" ${S.srcQL === 'dead' ? 'selected' : ''}>无用</option>
          <option value="none" ${S.srcQL === 'none' ? 'selected' : ''}>未检测</option>
        </select>
        <div class="tb-spacer"></div>
        <span class="tb-count">筛选出 ${list.length} 个</span>
        <button class="btn sm" id="src-detect">自动检测</button>
        <button class="btn sm" id="src-bulk-on">启用这些</button>
        <button class="btn sm" id="src-bulk-off">停用这些</button>
      </div>
      <div class="list">
        ${view.length ? view.map(s => `
          <div class="row-card">
            <div class="ico">${esc(s.icon || '源')}</div>
            <div class="body">
              <div class="t">${esc(s.name)}
                <span class="dot ${s.lastError ? 'err' : (s.lastLatency ? 'ok' : '')}"></span>
                ${s.quality ? `<span class="chip q-${s.quality}" title="${esc(s.qNote || '')}">${esc(Q_NAME[s.quality] || s.quality)}</span>` : ''}
                <span class="chip">${esc(s.group || '未分组')}</span>
                ${s.lastLatency ? `<span class="chip">${s.lastLatency}ms</span>` : ''}
                ${s.lastError ? `<span class="chip warn" title="${esc(s.lastError)}">失败</span>` : ''}
              </div>
              <div class="src-url">${esc(s.url || '（未填站点地址）')}</div>
              <div class="src-rules">
                ${s.searchUrl ? `<span class="chip">搜索 ${esc(s.searchUrl.slice(0, 46))}</span>` : '<span class="chip">无搜索地址</span>'}
                ${s.ruleToc?.chapterList ? `<span class="chip">目录 ${esc(s.ruleToc.chapterList)}</span>` : ''}
                ${s.ruleContent?.content ? `<span class="chip">正文 ${esc(s.ruleContent.content)}</span>` : ''}
              </div>
            </div>
            <div class="act">
              <div class="switch ${s.enabled ? 'on' : ''}" data-toggle="${s.id}"><i></i></div>
              <button class="btn sm" data-test="${s.id}">测试</button>
              <button class="btn sm" data-edit="${s.id}">编辑</button>
              <button class="btn sm danger" data-rm="${s.id}">删除</button>
            </div>
          </div>`).join('') : `<div class="empty">没有匹配的书源，换个关键词或分组试试。</div>`}
      </div>
      ${pages > 1 ? `<div class="pager">
        <button class="btn sm" id="src-prev" ${S.srcPage === 0 ? 'disabled' : ''}>上一页</button>
        <span>${S.srcPage + 1} / ${pages}</span>
        <button class="btn sm" id="src-next" ${S.srcPage >= pages - 1 ? 'disabled' : ''}>下一页</button>
      </div>` : ''}
      ` : `<div class="empty">还没有书源。<br>点右上角「导入 JSON」导入 Legado 书源文件，或「粘贴导入」。</div>`}`;

    $('#src-import').onclick = importSourcesFromFile;
    $('#src-paste').onclick = pasteSources;
    $('#src-export').onclick = exportSources;
    $('#src-new').onclick = () => editSource(null);

    const q = $('#src-q');
    if (q) {
      let t = null;
      q.oninput = () => {
        clearTimeout(t);
        const val = q.value;
        t = setTimeout(() => { S.srcQ = val; S.srcPage = 0; renderSources(); const el = $('#src-q'); if (el) { el.focus(); el.setSelectionRange(val.length, val.length); } }, 220);
      };
    }
    const gsel = $('#src-group');
    if (gsel) gsel.onchange = () => { S.srcG = gsel.value; S.srcPage = 0; renderSources(); };
    const esel = $('#src-enabled');
    if (esel) esel.onchange = () => { S.srcE = esel.value; S.srcPage = 0; renderSources(); };
    const qsel = $('#src-quality');
    if (qsel) qsel.onchange = () => { S.srcQL = qsel.value; S.srcPage = 0; renderSources(); };
    const dbtn = $('#src-detect');
    if (dbtn) dbtn.onclick = () => openDetectDialog();
    const prev = $('#src-prev'), next = $('#src-next');
    if (prev) prev.onclick = () => { S.srcPage--; renderSources(); };
    if (next) next.onclick = () => { S.srcPage++; renderSources(); };

    const bulk = (on) => {
      const target = srcFiltered();
      if (!target.length) return toast('当前筛选没有书源');
      if (target.length > 30 && !confirm(`将${on ? '启用' : '停用'} ${target.length} 个书源，确定？`)) return;
      for (const s of target) s.enabled = on;
      save(true);
      renderSources();
      toast(`已${on ? '启用' : '停用'} ${target.length} 个书源`);
    };
    const bon = $('#src-bulk-on'), boff = $('#src-bulk-off');
    if (bon) bon.onclick = () => bulk(true);
    if (boff) boff.onclick = () => bulk(false);

    $$('[data-toggle]').forEach(el => el.onclick = () => {
      const s = sourceById(el.dataset.toggle);
      s.enabled = !s.enabled; save(true); renderSources();
    });
    $$('[data-edit]').forEach(el => el.onclick = () => editSource(el.dataset.edit));
    $$('[data-rm]').forEach(el => el.onclick = () => {
      const s = sourceById(el.dataset.rm);
      if (!confirm(`删除书源「${s.name}」？`)) return;
      S.state.sources = S.state.sources.filter(x => x.id !== s.id);
      save(true); renderSources(); toast('已删除');
    });
    $$('[data-test]').forEach(el => el.onclick = async () => {
      const s = sourceById(el.dataset.test);
      el.disabled = true; el.textContent = '测试中';
      try {
        const t0 = performance.now();
        const r = await withTimeout(Engine.search(mo.net, s, '我的'), 10000);
        s.lastTest = Date.now(); s.lastLatency = Math.round(performance.now() - t0); s.lastCount = r.length; s.lastError = '';
        toast(r.length ? `「${s.name}」可用 · 搜到 ${r.length} 条` : `「${s.name}」能连通，但没搜到结果（检查搜索规则）`);
      } catch (e) {
        s.lastError = e.message || String(e);
        toast(`「${s.name}」失败：${s.lastError}`);
      }
      el.disabled = false; el.textContent = '测试';
      save(true); renderSources();
    });
  }

  /* ---------------- 书源自动检测 ---------------- */
  let detectAbort = false;

  function openDetectDialog() {
    const st = S.state;
    const nFiltered = srcFiltered().length;
    const nEnabled = st.sources.filter(s => s.enabled).length;
    /* 关键词要短：用整本书名会让很多源搜不到，被误判成「较差」 */
    const defKw = '剑';
    const done = st.sources.filter(s => s.quality).length;

    openModal(`
      <h3>书源自动检测</h3>
      <p class="desc">对每个书源跑一次真实搜索${''}，再抽样抓目录和正文，按结果分成 <b>优质 / 有效 / 较差 / 无用</b>。
        检测完可以直接按质量分组，之后搜索和换源会优先用优质源。</p>
      <div class="form-grid">
        <div class="field full">
          <label>检测范围</label>
          <select id="dt-scope">
            <option value="filtered">当前筛选（${nFiltered} 个）</option>
            <option value="enabled">已启用（${nEnabled} 个）</option>
            <option value="all">全部（${st.sources.length} 个）</option>
          </select>
        </div>
        <div class="field">
          <label>搜索关键词 <span>越短越通用：剑 / 斗罗 / 我的</span></label>
          <input id="dt-kw" value="${esc(defKw)}" placeholder="常见字或书名" />
        </div>
        <div class="field">
          <label>并发数 <span id="dt-conc-n">8</span></label>
          <input type="range" id="dt-conc" min="4" max="16" value="8" />
        </div>
        <div class="field full">
          <label class="cb"><input type="checkbox" id="dt-deep" checked /> 深度检测：抓目录和正文（更准，每个源多花几秒）</label>
        </div>
      </div>
      ${done ? `<p class="desc" style="margin-top:12px">已检测过 ${done} 个，再次检测会覆盖旧结果。</p>` : ''}
      <div class="modal-actions">
        <button class="btn" id="dt-cancel">取消</button>
        <button class="btn primary" id="dt-start">开始检测</button>
      </div>
      <div id="dt-live"></div>`, true);

    $('#dt-cancel').onclick = closeModal;
    const conc = $('#dt-conc');
    conc.oninput = () => { $('#dt-conc-n').textContent = conc.value; };
    $('#dt-start').onclick = () => startDetect();
  }

  async function startDetect() {
    const st = S.state;
    const scope = $('#dt-scope').value;
    const kw = ($('#dt-kw').value || '').trim() || '剑';
    const deep = $('#dt-deep').checked;
    const conc = +$('#dt-conc').value || 8;

    let targets = scope === 'filtered' ? srcFiltered() : scope === 'enabled' ? st.sources.filter(s => s.enabled) : st.sources.slice();
    targets = targets.filter(s => s.url || s.searchUrl);
    if (!targets.length) { toast('没有可检测的书源'); return; }

    /* 书架里用过的源，直接拿那本书的地址深检，比搜索关键词更靠谱 */
    const probe = new Map();
    for (const b of st.books) if (b.sourceId && b.bookUrl) probe.set(b.sourceId, b.bookUrl);

    detectAbort = false;
    const live = $('#dt-live');
    $('#dt-start').disabled = true;
    $('#dt-scope').disabled = true;
    live.innerHTML = `
      <div class="dt-bar"><i id="dt-bar-i"></i></div>
      <div class="dt-line"><span id="dt-cur">准备中…</span><span id="dt-count">0 / ${targets.length}</span></div>
      <div class="dt-tags">
        ${['great', 'ok', 'poor', 'dead'].map(k => `<span class="chip q-${k}" id="dt-n-${k}">${Q_NAME[k]} 0</span>`).join('')}
      </div>
      <div class="modal-actions"><button class="btn danger" id="dt-stop">中断</button></div>`;
    $('#dt-stop').onclick = () => { detectAbort = true; $('#dt-cur').textContent = '正在中断…'; };

    const t0 = Date.now();
    let lastSave = 0;
    const res = await Detect.run({
      sources: targets,
      fetch: mo.net,
      keyword: kw,
      deep,
      concurrency: conc,
      timeout: 9000,
      probeUrlOf: s => probe.get(s.id) || '',
      shouldStop: () => detectAbort,
      onProgress: (done, total, sum, r) => {
        const pct = Math.round(done / total * 100);
        const bar = $('#dt-bar-i');
        if (bar) bar.style.width = pct + '%';
        const cur = $('#dt-cur');
        if (cur) cur.textContent = `${done}/${total} · ${r.name.slice(0, 18)} → ${Q_NAME[r.quality] || ''}${r.note ? '（' + r.note + '）' : ''}`;
        const c = $('#dt-count');
        if (c) c.textContent = `${done} / ${total}`;
        for (const k of ['great', 'ok', 'poor', 'dead']) {
          const el = $('#dt-n-' + k);
          if (el) el.textContent = `${Q_NAME[k]} ${sum[k] || 0}`;
        }
        /* 增量落盘，避免中断后白测 */
        if (done - lastSave >= 15) { lastSave = done; save(true); }
      },
      onResult: r => {
        const s = sourceById(r.id);
        if (!s) return;
        s.quality = r.quality;
        s.qScore = r.score;
        s.qNote = r.note || '';
        s.qAt = Date.now();
        s.qMs = r.ms;
        s.qChapters = r.chapters;
        s.qChars = r.chars;
        s.lastError = r.quality === 'dead' ? (r.note || '') : '';
        if (r.ms) s.lastLatency = r.ms;
      }
    });

    save(true);
    renderSources();
    const sec = Math.round((Date.now() - t0) / 1000);
    live.innerHTML = `
      <div class="dt-done">
        <div class="dt-sum">
          <span class="chip q-great">优质 ${res.summary.great || 0}</span>
          <span class="chip q-ok">有效 ${res.summary.ok || 0}</span>
          <span class="chip q-poor">较差 ${res.summary.poor || 0}</span>
          <span class="chip q-dead">无用 ${res.summary.dead || 0}</span>
        </div>
        <p class="desc">共测 ${res.total} 个${res.stopped ? '（已中断）' : ''}，用时 ${sec} 秒${deep ? '' : '（未深检，只测了搜索）'}。</p>
      </div>
      <div class="modal-actions">
        <button class="btn" id="dt-group">按质量分组</button>
        <button class="btn" id="dt-restore">还原原分组</button>
        <button class="btn danger" id="dt-off">停用无用源</button>
        <button class="btn primary" id="dt-ok">完成</button>
      </div>`;
    $('#dt-ok').onclick = () => { closeModal(); renderSources(); };
    $('#dt-group').onclick = () => { groupByQuality(); };
    $('#dt-restore').onclick = () => { restoreQualityGroups(); };
    $('#dt-off').onclick = () => {
      const dead = st.sources.filter(s => s.quality === 'dead' && s.enabled);
      if (!dead.length) return toast('没有需要停用的源');
      if (!confirm(`停用 ${dead.length} 个「无用」书源？`)) return;
      for (const s of dead) s.enabled = false;
      save(true); renderSources(); toast(`已停用 ${dead.length} 个无用源`);
    };
    toast(`检测完成：优质 ${res.summary.great || 0} / 有效 ${res.summary.ok || 0} / 较差 ${res.summary.poor || 0} / 无用 ${res.summary.dead || 0}`);
  }

  const Q_GROUP = { great: '优质源', ok: '可用源', poor: '较差源', dead: '失效源' };
  function groupByQuality() {
    const st = S.state;
    let n = 0;
    for (const s of st.sources) {
      if (!s.quality || !Q_GROUP[s.quality]) continue;
      if (s.group0 === undefined) s.group0 = s.group || '未分组';
      s.group = Q_GROUP[s.quality];
      n++;
    }
    if (!n) return toast('还没有检测结果，先跑一次检测');
    save(true);
    renderSources();
    toast(`已把 ${n} 个书源归入「优质源 / 可用源 / 较差源 / 失效源」四个分组`);
  }
  function restoreQualityGroups() {
    const st = S.state;
    let n = 0;
    for (const s of st.sources) {
      if (s.group0 === undefined) continue;
      s.group = s.group0;
      delete s.group0;
      n++;
    }
    if (!n) return toast('没有可还原的分组');
    save(true);
    renderSources();
    toast(`已还原 ${n} 个书源的原始分组`);
  }

  function normalizeMany(json) {
    const arr = Array.isArray(json) ? json : (json && json.bookSources) ? json.bookSources : [json];
    return arr.filter(x => x && (x.bookSourceName || x.name)).map(Engine.normalizeSource);
  }

  function mergeSources(list) {
    let added = 0, updated = 0;
    for (const s of list) {
      const old = S.state.sources.find(x => x.url && x.url === s.url && x.name === s.name);
      if (old) { Object.assign(old, s, { id: old.id, enabled: old.enabled }); updated++; }
      else { S.state.sources.push(s); added++; }
    }
    save(true);
    renderSources();
    return { added, updated };
  }

  async function importSourcesFromFile() {
    const r = await mo.openJson('导入书源 JSON');
    if (!r.ok) { if (r.error) toast(r.error); return; }
    try {
      const list = normalizeMany(JSON.parse(r.text));
      if (!list.length) return toast('文件里没有识别到书源');
      const { added, updated } = mergeSources(list);
      toast(`导入完成：新增 ${added}，更新 ${updated}`);
    } catch (e) {
      toast('解析失败：' + e.message);
    }
  }

  function pasteSources() {
    openModal(`<h3>粘贴导入书源</h3>
      <p class="desc">把 Legado 书源的 JSON 数组粘贴进来（一个或多个都可以），支持 Legado 的 bookSourceName / searchUrl / ruleSearch 等字段。</p>
      <div class="field full"><textarea id="paste-json" class="mono" placeholder='[{"bookSourceName":"...","bookSourceUrl":"...","searchUrl":"...","ruleSearch":{...}}]'></textarea></div>
      <div class="modal-actions">
        <button class="btn" onclick="window.__closeModal()">取消</button>
        <button class="btn primary" id="paste-ok">导入</button>
      </div>`, true);
    $('#paste-json').focus();
    $('#paste-ok').onclick = () => {
      try {
        const list = normalizeMany(JSON.parse($('#paste-json').value));
        if (!list.length) return toast('没有识别到书源');
        const { added, updated } = mergeSources(list);
        closeModal();
        toast(`导入完成：新增 ${added}，更新 ${updated}`);
      } catch (e) { toast('JSON 解析失败：' + e.message); }
    };
  }

  async function exportSources() {
    const r = await mo.saveJson('moread-sources.json', JSON.stringify(S.state.sources, null, 2));
    if (r.ok) toast('已导出书源');
  }

  function editSource(id) {
    const s = id ? sourceById(id) : {
      id: null, name: '', url: '', group: '未分组', enabled: true, charset: 'auto', searchUrl: '',
      ruleSearch: { bookList: '', name: '', author: '', bookUrl: '', intro: '', coverUrl: '' },
      ruleBookInfo: { tocUrl: '' },
      ruleToc: { chapterList: '', chapterName: '', chapterUrl: '' },
      ruleContent: { content: '' }
    };
    const groups = [...new Set(['未分组', ...S.state.groups.map(g => g.name), ...S.state.sources.map(x => x.group || '未分组')])];

    openModal(`<h3>${id ? '编辑书源' : '新建书源'}</h3>
      <p class="desc">规则支持：CSS 选择器 + <code>@text/@href/@src</code>；Legado 旧语法 <code>class.x@tag.a@text</code>；JSON 路径 <code>$.data[*].name</code>。</p>
      <div class="form-grid">
        <div class="field"><label>书源名称</label><input id="e-name" value="${esc(s.name)}" placeholder="我的书源" /></div>
        <div class="field"><label>分组</label><input id="e-group" value="${esc(s.group || '未分组')}" list="group-list" />
          <datalist id="group-list">${groups.map(g => `<option value="${esc(g)}">`).join('')}</datalist></div>
        <div class="field full"><label>站点地址</label><input id="e-url" class="mono" value="${esc(s.url)}" placeholder="https://example.com" /></div>
        <div class="field full"><label>搜索地址 <span>{key} 或 {{key}} 会被替换为关键词</span></label>
          <input id="e-search" class="mono" value="${esc(s.searchUrl)}" placeholder="https://example.com/search?q={key}" /></div>
        <div class="field"><label>搜索结果容器 <span>CSS</span></label><input id="e-list" class="mono" value="${esc(s.ruleSearch.bookList)}" placeholder=".result .item" /></div>
        <div class="field"><label>书名</label><input id="e-name-r" class="mono" value="${esc(s.ruleSearch.name)}" placeholder="h3 a@text" /></div>
        <div class="field"><label>作者</label><input id="e-author-r" class="mono" value="${esc(s.ruleSearch.author)}" placeholder=".author@text" /></div>
        <div class="field"><label>详情链接</label><input id="e-bookurl-r" class="mono" value="${esc(s.ruleSearch.bookUrl)}" placeholder="h3 a@href" /></div>
        <div class="field"><label>目录容器</label><input id="e-toclist" class="mono" value="${esc(s.ruleToc.chapterList)}" placeholder="#list dd" /></div>
        <div class="field"><label>章节链接</label><input id="e-tocurl" class="mono" value="${esc(s.ruleToc.chapterUrl)}" placeholder="a@href" /></div>
        <div class="field"><label>章节名</label><input id="e-tocname" class="mono" value="${esc(s.ruleToc.chapterName)}" placeholder="a@text" /></div>
        <div class="field"><label>正文容器</label><input id="e-content" class="mono" value="${esc(s.ruleContent.content)}" placeholder="#content" /></div>
        <div class="field"><label>编码</label><select id="e-charset">
          ${['auto', 'utf-8', 'gbk'].map(c => `<option ${s.charset === c ? 'selected' : ''}>${c}</option>`).join('')}
        </select></div>
        <div class="field"><label>启用</label><select id="e-enabled">
          <option value="1" ${s.enabled ? 'selected' : ''}>启用</option><option value="0" ${!s.enabled ? 'selected' : ''}>停用</option>
        </select></div>
      </div>
      <div class="modal-actions">
        <button class="btn left" onclick="window.__closeModal()">取消</button>
        <button class="btn" id="e-save">保存</button>
      </div>`, true);

    $('#e-save').onclick = () => {
      const patch = {
        name: $('#e-name').value.trim() || '未命名书源',
        group: $('#e-group').value.trim() || '未分组',
        url: $('#e-url').value.trim(),
        searchUrl: $('#e-search').value.trim(),
        charset: $('#e-charset').value,
        enabled: $('#e-enabled').value === '1',
        ruleSearch: {
          bookList: $('#e-list').value.trim(),
          name: $('#e-name-r').value.trim(),
          author: $('#e-author-r').value.trim(),
          bookUrl: $('#e-bookurl-r').value.trim(),
          intro: s.ruleSearch.intro || '', coverUrl: s.ruleSearch.coverUrl || ''
        },
        ruleToc: { chapterList: $('#e-toclist').value.trim(), chapterName: $('#e-tocname').value.trim(), chapterUrl: $('#e-tocurl').value.trim() },
        ruleContent: { content: $('#e-content').value.trim() },
        icon: ($('#e-name').value.trim() || '源').slice(0, 1)
      };
      if (id) Object.assign(s, patch);
      else S.state.sources.unshift(Object.assign({ id: uid('S'), ruleBookInfo: { tocUrl: '' }, createdAt: Date.now() }, patch));
      save(true); closeModal(); renderSources(); toast('已保存');
    };
  }

  /* ---------------- 书签 ---------------- */
  function renderBookmarks() {
    const v = $('#view-bookmarks');
    const list = [...S.state.bookmarks].sort((a, b) => b.at - a.at);
    v.innerHTML = `<div class="page-head"><h1>书签</h1><span class="sub">${list.length} 条</span></div>
      <div class="list">${list.length ? list.map(b => `
        <div class="row-card">
          <div class="ico">书</div>
          <div class="body">
            <div class="t">${esc(b.name)} <span class="chip">${esc(b.title || '')}</span></div>
            <div class="s">${esc(b.text || '')}</div>
            <div class="s">${fmtWhen(b.at)}</div>
          </div>
          <div class="act">
            <button class="btn sm" data-jump="${b.id}">跳转</button>
            <button class="btn sm danger" data-rmbm="${b.id}">删除</button>
          </div>
        </div>`).join('') : `<div class="empty">阅读时点顶栏的书签图标即可添加。<br>书签会记下章节和当时看到的位置。</div>`}</div>`;
    $$('[data-jump]').forEach(el => el.onclick = () => {
      const bm = S.state.bookmarks.find(x => x.id === el.dataset.jump);
      openReader(bm.bookId, bm.ci, bm.pct);
    });
    $$('[data-rmbm]').forEach(el => el.onclick = () => {
      S.state.bookmarks = S.state.bookmarks.filter(x => x.id !== el.dataset.rmbm);
      save(true); renderBookmarks(); toast('已删除书签');
    });
  }

  /* ---------------- 历史 ---------------- */
  function renderHistory() {
    const v = $('#view-history');
    const list = S.state.history;
    const groups = {};
    list.forEach(h => { const k = dayKey(new Date(h.at)); (groups[k] = groups[k] || []).push(h); });
    v.innerHTML = `<div class="page-head"><h1>阅读历史</h1><span class="sub">${list.length} 条</span>
        <div class="head-tools"><button class="btn danger" id="clear-hist">清空历史</button></div></div>
      <div class="list">
      ${list.length ? Object.entries(groups).map(([k, items]) => `
        <div class="src-label">${k === dayKey() ? '今天' : k}</div>
        ${items.map(h => `<div class="row-card">
          <div class="ico">${esc((h.name || '?')[0])}</div>
          <div class="body"><div class="t">${esc(h.name)}</div>
            <div class="s">${esc(h.title || '')} · ${fmtWhen(h.at)}</div></div>
          <div class="act"><button class="btn sm" data-hjump="${h.id}">继续</button></div>
        </div>`).join('')}`).join('') : `<div class="empty">还没有阅读记录。</div>`}
      </div>`;
    $$('[data-hjump]').forEach(el => el.onclick = () => {
      const h = S.state.history.find(x => x.id === el.dataset.hjump);
      openReader(h.bookId, h.ci);
    });
    const c = $('#clear-hist');
    if (c) c.onclick = () => {
      if (!confirm('清空全部阅读历史？')) return;
      S.state.history = []; save(true); renderHistory();
    };
  }

  /* ---------------- 统计 ---------------- */
  function renderStats() {
    const v = $('#view-stats');
    const stats = S.state.stats || {};
    const today = stats[dayKey()] || { sec: 0, chars: 0 };
    const week = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date(Date.now() - i * 86400e3);
      const k = dayKey(d);
      week.push({ k, label: (d.getMonth() + 1) + '/' + d.getDate(), ...(stats[k] || { sec: 0, chars: 0 }) });
    }
    const weekSec = week.reduce((a, b) => a + b.sec, 0);
    const totalSec = Object.values(stats).reduce((a, b) => a + (b.sec || 0), 0);
    const totalChars = Object.values(stats).reduce((a, b) => a + (b.chars || 0), 0);
    // 连续阅读天数
    let streak = 0;
    for (let i = 0; i < 365; i++) {
      const k = dayKey(new Date(Date.now() - i * 86400e3));
      if ((stats[k] || {}).sec > 60) streak++;
      else if (i > 0) break;
    }
    const max = Math.max(1, ...week.map(w => w.sec));

    v.innerHTML = `<div class="page-head"><h1>阅读统计</h1><span class="sub">只在本地记录，不上传</span></div>
      <div class="stat-grid">
        <div class="stat-card"><div class="k">今日阅读</div><div class="v">${fmtDur(today.sec)}</div></div>
        <div class="stat-card"><div class="k">今日字数</div><div class="v">${(today.chars || 0).toLocaleString()}<small>字</small></div></div>
        <div class="stat-card"><div class="k">近 7 天</div><div class="v">${Math.round(weekSec / 60)}<small>分钟</small></div></div>
        <div class="stat-card"><div class="k">连续阅读</div><div class="v">${streak}<small>天</small></div></div>
      </div>
      <div class="chart-card">
        <div class="row" style="border:none;padding:0 0 6px"><div class="rl" style="font-size:13px;font-weight:600">最近 7 天阅读时长</div>
          <span class="rv">累计 ${fmtDur(totalSec)} · ${totalChars.toLocaleString()} 字</span></div>
        <div class="bars">
          ${week.map(w => `<div class="b" title="${w.k}">
            <b>${w.sec ? Math.round(w.sec / 60) + 'm' : ''}</b>
            <i style="height:${Math.max(2, Math.round(w.sec / max * 110))}px;opacity:${w.sec ? 1 : .35}"></i>
            <span>${w.label}</span></div>`).join('')}
        </div>
      </div>`;
  }

  /* ---------------- 设置 ---------------- */
  function renderSettings() {
    const v = $('#view-settings');
    const s = S.state.settings;
    v.innerHTML = `<div class="page-head"><h1>设置</h1><span class="sub">改动即时生效</span></div>
      <div class="set-wrap">
        <div class="card">
          <h3>阅读</h3>
          <div class="row"><div class="rl">默认字号</div>
            <input type="range" id="s-fs" min="15" max="30" value="${s.fontSize}" /><span class="rv" id="s-fs-v">${s.fontSize}px</span></div>
          <div class="row"><div class="rl">行距</div>
            <input type="range" id="s-lh" min="14" max="26" value="${Math.round(s.lineHeight * 10)}" /><span class="rv" id="s-lh-v">${s.lineHeight.toFixed(1)}</span></div>
          <div class="row"><div class="rl">字体</div>
            <div class="seg" id="s-font"><button data-v="serif" class="${s.fontFamily === 'serif' ? 'on' : ''}">宋体</button>
            <button data-v="sans" class="${s.fontFamily === 'sans' ? 'on' : ''}">黑体</button></div></div>
          <div class="row"><div class="rl">翻页方式</div>
            <div class="seg" id="s-mode"><button data-v="scroll" class="${s.pageMode === 'scroll' ? 'on' : ''}">滚动</button>
            <button data-v="paged" class="${s.pageMode === 'paged' ? 'on' : ''}">翻页</button></div></div>
        </div>

        <div class="card">
          <h3>朗读 <span class="chip">${IS_ANDROID ? '系统语音' : 'Windows 系统语音'}</span></h3>
          <div class="row"><div class="rl">音色 / 语速 / 音调<small id="tts-cur">${esc(ttsCurrentLabel())}</small></div>
            <button class="btn sm" id="s-tts">设置</button></div>
          <div class="row"><div class="rl">读完自动下一章</div>
            <div class="switch ${s.tts.autoNext ? 'on' : ''}" id="s-tts-next"><i></i></div></div>
          <div class="row"><div class="rl">试听<small>读一小段，确认音色和语速</small></div>
            <button class="btn sm" id="s-tts-test">播放</button></div>
        </div>

        <div class="card">
          <h3>系统</h3>
          ${IS_ANDROID ? '' : `<div class="row"><div class="rl">关闭窗口时最小化到托盘<small>开启后点 × 不会退出程序</small></div>
            <div class="switch ${s.closeToTray ? 'on' : ''}" data-set="closeToTray"><i></i></div></div>`}
          <div class="row"><div class="rl">搜索并发数<small>同时请求的书源数量，过大容易被限流</small></div>
            <div class="seg" id="s-conc">${[1, 2, 3, 4, 6].map(n => `<button data-v="${n}" class="${s.maxConcurrent === n ? 'on' : ''}">${n}</button>`).join('')}</div></div>
          <div class="row"><div class="rl">每次搜索的书源数<small>书源太多（比如几千个）时只搜一部分，优先书架用到的</small></div>
            <div class="seg" id="s-slimit">${[20, 40, 80, 200].map(n => `<button data-v="${n}" class="${(s.searchLimit || 40) === n ? 'on' : ''}">${n}</button>`).join('')}</div></div>
          <div class="row"><div class="rl">阅读时自动预取下一章</div>
            <div class="switch ${s.autoCacheNext ? 'on' : ''}" data-set="autoCacheNext"><i></i></div></div>
          <div class="row"><div class="rl">数据目录<small>${esc(S.info.paths.root)}</small></div>
            ${IS_ANDROID ? '' : '<button class="link" id="open-dir">打开</button>'}</div>
          ${S.info.platform === 'web' ? `<div class="row"><div class="rl">书源代理地址<small>网页版默认不发起任何网络请求（数据不出设备）。填入你自部署的代理服务后可用在线书源与搜书；留空只能读本地书</small></div>
            <input class="inp" id="web-proxy" value="${esc((() => { try { return localStorage.getItem('moread.proxy') || ''; } catch (e) { return ''; } })())}" placeholder="https://你的代理地址/?url=" spellcheck="false" /></div>` : ''}
        </div>

        <div class="card">
          <h3>备份与恢复 <span class="chip">含 Legado 格式</span></h3>
          ${S.info.platform === 'web' ? `<div class="web-note">
            数据只存在这台设备的浏览器里。清理浏览器数据、换手机、或用无痕模式打开都会丢，
            建议每隔一阵点一次「完整导出」，把 zip 存到手机文件或网盘里。</div>` : ''}
          <div class="row"><div class="rl">导出备份 zip<small>内含 bookSource.json / bookshelf.json / bookmark.json，原版「阅读」可直接导入这个 zip</small></div>
            <button class="btn sm" id="bk-zip">导出</button></div>
          <div class="row"><div class="rl">完整备份（含本地书文件）<small>换设备能完整还原，本地书的正文也在里面${S.info.platform === 'web' ? '——网页版推荐用这个' : ''}</small></div>
            <button class="btn sm" id="bk-zip-full">完整导出</button></div>
          <div class="row"><div class="rl">从备份恢复<small>支持墨读 zip、原版阅读备份 zip、单个书源 JSON</small></div>
            <button class="btn sm" id="bk-restore">选择文件</button></div>
          <div class="row"><div class="rl">缓存占用<small id="cache-size">计算中…</small></div>
            <button class="btn sm" id="clear-cache">清理</button></div>
        </div>

        <div class="card span2">
          <h3>坚果云同步 <span class="chip ${(s.webdav.url && s.webdav.user && s.webdav.pass) ? 'ok' : ''}" id="dav-state">${(s.webdav.url && s.webdav.user && s.webdav.pass) ? '已配置' : '未配置'}</span></h3>
          <div class="row"><div class="rl">启用 WebDAV 同步<small>坚果云 / Nextcloud / 群晖 等标准 WebDAV 都能用</small></div>
            <div class="switch ${s.webdav.enabled ? 'on' : ''}" id="dav-enabled"><i></i></div></div>
          <div class="row"><div class="rl">服务器地址<small>坚果云固定为 https://dav.jianguoyun.com/dav/</small></div>
            <input class="inp" id="dav-url" value="${esc(s.webdav.url)}" spellcheck="false" /></div>
          <div class="row"><div class="rl">账号<small>坚果云填登录邮箱</small></div>
            <input class="inp" id="dav-user" value="${esc(s.webdav.user)}" spellcheck="false" /></div>
          <div class="row"><div class="rl">应用密码<small>不是登录密码。在坚果云「安全选项 → 添加应用」里生成</small></div>
            <input class="inp" id="dav-pass" type="password" value="${esc(s.webdav.pass)}" spellcheck="false" /></div>
          <div class="row"><div class="rl">远程目录<small>不存在会自动创建。要和手机上的原版「阅读」共用，就填手机端用的目录名（默认 legado）</small></div>
            <input class="inp" id="dav-dir" value="${esc(s.webdav.dir)}" spellcheck="false" /></div>
          <div class="row"><div class="rl">自动备份<small>按间隔把整份存档传到云端，只保留最近 ${s.webdav.keep} 份</small></div>
            <div class="dav-auto">
              <div class="switch ${s.webdav.autoBackup ? 'on' : ''}" id="dav-auto"><i></i></div>
              <select id="dav-interval" class="w-engine">
                ${[6, 12, 24, 72].map(h => `<option value="${h}" ${Number(s.webdav.intervalHours) === h ? 'selected' : ''}>每 ${h} 小时</option>`).join('')}
              </select>
            </div></div>
          <div class="row"><div class="rl">操作<small id="dav-last">${s.webdav.lastBackupAt ? '上次备份 ' + fmtWhen(s.webdav.lastBackupAt) : '还没有备份过'}</small></div>
            <div class="dav-btns">
              <button class="btn sm" id="dav-save">保存并测试</button>
              <button class="btn sm primary" id="dav-backup">立即备份</button>
            </div></div>
          <div class="row"><div class="rl">书源云同步<small>和原版阅读共用一份 bookSource.json，手机上导入的书源电脑能直接用</small></div>
            <div class="dav-btns">
              <button class="btn sm" id="dav-up-src">上传书源</button>
              <button class="btn sm" id="dav-down-src">下载书源</button>
            </div></div>
          <div class="dav-list-head"><span>云端备份</span><button class="link" id="dav-refresh">刷新</button></div>
          <div class="dav-list" id="dav-list"><div class="hint">点「刷新」读取云端列表</div></div>
        </div>

        <div class="card">
          ${IS_ANDROID ? `<h3>触屏操作</h3>
          <div class="row"><div class="rl">进入书籍<small>全屏沉浸：顶栏底栏自动藏起，点屏幕中间唤出，几秒不碰自动再收</small></div></div>
          <div class="row"><div class="rl">轻点屏幕左右两侧<small>上一页 / 下一页，只在「翻页」模式下生效</small></div></div>
          <div class="row"><div class="rl">左右滑动<small>翻页；「滚动」模式下滑动即正常滚动正文</small></div></div>
          <div class="row"><div class="rl">长按书架封面<small>弹出「换源 / 删除」菜单</small></div></div>
          <div class="row"><div class="rl">长按顶栏 1.2 秒<small>打开自检：桥、存储、联网、WebView 版本逐项列出</small></div></div>` : `<h3>快捷键</h3>
          <div class="row"><div class="rl">打开搜索</div><span><span class="kbd">Ctrl</span> + <span class="kbd">F</span></span></div>
          <div class="row"><div class="rl">导入本地书</div><span><span class="kbd">Ctrl</span> + <span class="kbd">O</span></span></div>
          <div class="row"><div class="rl">上一章 / 下一章</div><span><span class="kbd">←</span> <span class="kbd">→</span></span></div>
          <div class="row"><div class="rl">翻页（分页模式）</div><span><span class="kbd">PgUp</span> <span class="kbd">PgDn</span></span></div>
          <div class="row"><div class="rl">字号 / 主题 / 目录 / 书签</div><span><span class="kbd">+</span><span class="kbd">-</span><span class="kbd">T</span><span class="kbd">C</span><span class="kbd">B</span></span></div>
          <div class="row"><div class="rl">全屏 / 退出全屏</div><span><span class="kbd">F11</span> 或 <span class="kbd">F</span></span></div>
          <div class="row"><div class="rl">退出阅读</div><span class="kbd">Esc</span></div>`}
        </div>

        <div class="card" style="grid-column:1/-1">
          <h3>关于</h3>
          <div class="row"><div class="rl">版本<small>${IS_ANDROID ? `墨读 ${esc(S.info.version)} · Android` : (S.info.platform === 'web' ? `墨读 ${esc(S.info.version)} · 网页版` : `墨读 ${esc(S.info.version)} · Electron ${esc(S.info.electron)} · Node ${esc(S.info.node)}`)}</small></div>
            <span class="rv">${IS_ANDROID ? '数据只存本机' : (S.info.portable ? '便携模式 · 数据在程序目录' : '数据只存本地')}</span></div>
          <div class="row"><div class="rl">数据位置<small>${esc(S.info.paths.root)}</small></div>
            ${IS_ANDROID ? '' : '<button class="link" id="open-dir2">打开</button>'}</div>
          <div class="row"><div class="rl">书源格式<small>兼容 Legado(阅读) bookSource JSON 的常用字段；xpath/复杂 JS 规则可能不生效</small></div></div>
          <div class="row"><div class="rl">备份格式<small>导出的 zip 内同时含 bookSource.json / bookshelf.json 等原版字段，原版「阅读」可直接导入</small></div></div>
        </div>
      </div>`;

    $('#s-fs').oninput = e => {
      s.fontSize = +e.target.value; $('#s-fs-v').textContent = s.fontSize + 'px'; applyReaderStyle(); save();
    };
    $('#s-lh').oninput = e => {
      s.lineHeight = +e.target.value / 10; $('#s-lh-v').textContent = s.lineHeight.toFixed(1); applyReaderStyle(); save();
    };
    $$('#s-font button').forEach(b => b.onclick = () => {
      $$('#s-font button').forEach(x => x.classList.remove('on'));
      b.classList.add('on'); s.fontFamily = b.dataset.v; applyReaderStyle(); save();
    });
    $$('#s-mode button').forEach(b => b.onclick = () => {
      $$('#s-mode button').forEach(x => x.classList.remove('on'));
      b.classList.add('on'); s.pageMode = b.dataset.v; save();
      if (R.book) { $('#r-mode').textContent = s.pageMode === 'paged' ? '翻页' : '滚动'; renderChapter(); }
    });
    $$('#s-conc button').forEach(b => b.onclick = () => {
      $$('#s-conc button').forEach(x => x.classList.remove('on'));
      b.classList.add('on'); s.maxConcurrent = +b.dataset.v; save();
    });
    $$('#s-slimit button').forEach(b => b.onclick = () => {
      $$('#s-slimit button').forEach(x => x.classList.remove('on'));
      b.classList.add('on'); s.searchLimit = +b.dataset.v; save();
    });
    $$('[data-set]').forEach(el => el.onclick = () => {
      const k = el.dataset.set;
      s[k] = !s[k]; el.classList.toggle('on', s[k]); save(true);
    });
    /* 安卓没有「文件管理器」可跳转，这两个按钮根本不会渲染出来，要判空 */
    if ($('#open-dir')) $('#open-dir').onclick = () => mo.openDir && mo.openDir();
    if ($('#open-dir2')) $('#open-dir2').onclick = () => mo.openDir && mo.openDir();
    /* 网页版：书源代理地址（存 localStorage，由浏览器桥的 http 层读取） */
    if ($('#web-proxy')) $('#web-proxy').onchange = () => {
      try { localStorage.setItem('moread.proxy', $('#web-proxy').value.trim()); } catch (e) { }
      toast($('#web-proxy').value.trim() ? '代理已保存，下个请求开始生效' : '已清空代理：回到纯本地模式');
    };
    $('#s-tts').onclick = () => ttsPanel();
    $('#s-tts-test').onclick = () => {
      const v = ttsOrderedVoices().find(x => x.voiceURI === ttsCfg().voiceURI) || ttsOrderedVoices()[0];
      const u = new SpeechSynthesisUtterance('这是墨读的朗读试听，语速和音色可以随时调整。');
      if (v) u.voice = v;
      u.lang = (v && v.lang) || 'zh-CN';
      u.rate = clamp(Number(ttsCfg().rate) || 1, .5, 2);
      window.speechSynthesis.cancel();
      window.speechSynthesis.speak(u);
    };
    $('#s-tts-next').onclick = e => {
      const el = e.currentTarget;
      ttsCfg().autoNext = !ttsCfg().autoNext;
      el.classList.toggle('on', ttsCfg().autoNext);
      save(true);
    };

    $('#bk-zip').onclick = () => exportZip(false);
    $('#bk-zip-full').onclick = () => exportZip(true);
    $('#bk-restore').onclick = () => restoreFromZip();
    $('#clear-cache').onclick = async () => {
      await mo.cache.clear();
      toast('缓存已清理');
      updateCacheSize();
    };

    /* ---- 坚果云 ---- */
    const dav = S.state.settings.webdav;
    $('#dav-enabled').onclick = e => { dav.enabled = !dav.enabled; e.currentTarget.classList.toggle('on', dav.enabled); save(true); };
    $('#dav-auto').onclick = e => { dav.autoBackup = !dav.autoBackup; e.currentTarget.classList.toggle('on', dav.autoBackup); save(true); };
    $('#dav-interval').onchange = e => { dav.intervalHours = +e.target.value; save(true); };
    $('#dav-save').onclick = davSaveTest;
    $('#dav-backup').onclick = () => davBackup();
    $('#dav-refresh').onclick = () => davLoadList();
    $('#dav-up-src').onclick = davUploadSources;
    $('#dav-down-src').onclick = davDownloadSources;
    if (dav.enabled && dav.user && dav.pass) davLoadList();

    updateCacheSize();
  }

  /* ---------------- 备份 zip / Legado 恢复 ---------------- */
  async function exportZip(full) {
    toast(full ? '正在打包（含本地书）…' : '正在打包…');
    await mo.state.set(S.state); // 先把最新改动落盘，避免备份到旧数据
    const r = await mo.exportZip(full);
    if (!r.ok) { if (r.error) toast('导出失败：' + r.error); return; }
    toast(`已导出 ${(r.size / 1024).toFixed(0)} KB · ${r.path.split(/[\\/]/).pop()}`);
  }

  const normUrl = u => String(u || '').trim().replace(/\/+$/, '').toLowerCase()
    .replace(/^https?:\/\//, '').replace(/^www\./, '');

  /** 把 Legado 备份内容并进书架 */
  function applyLegado(parts, mode) {
    const st = S.state;
    const ensureGroup = (name) => {
      const g = st.groups.find(x => x.name === name);
      if (g) return g.id;
      const id = uid('G');
      st.groups.push({ id, name });
      return id;
    };
    if (mode === 'replace') {
      st.sources = []; st.books = []; st.bookmarks = []; st.progress = {}; st.history = [];
    }
    // 1) 书源
    let srcAdded = 0, srcUpdated = 0;
    for (const raw of parts.sources || []) {
      const s = Engine.normalizeSource(raw);
      const old = st.sources.find(x => x.url && normUrl(x.url) === normUrl(s.url));
      if (old) { Object.assign(old, s, { id: old.id, enabled: old.enabled }); srcUpdated++; }
      else { st.sources.push(s); srcAdded++; }
    }
    // 2) 书架
    let added = 0, updated = 0, noSource = 0;
    for (const raw of parts.books || []) {
      const src = st.sources.find(s => normUrl(s.url) === normUrl(raw.origin))
        || st.sources.find(s => s.name && s.name === raw.originName)
        || null;
      if (!src) noSource++;
      const exist = st.books.find(b => b.bookUrl === raw.bookUrl) || st.books.find(b => b.name === raw.name && b.author === raw.author);
      if (exist) {
        if (!exist.chapters || !exist.chapters.length) exist.total = raw.total || exist.total;
        exist.updatedAt = Date.now();
        updated++;
        const p = st.progress[exist.id] || {};
        if ((raw.durChapterIndex || 0) >= (p.ci || 0)) {
          st.progress[exist.id] = { ci: raw.durChapterIndex || 0, title: raw.durChapterTitle || p.title || '', pct: 0, at: raw.durChapterTime || Date.now() };
        }
        continue;
      }
      const id = uid('L');
      st.books.push({
        id, name: raw.name, author: raw.author || '佚名', kind: 'online',
        sourceId: src ? src.id : '', sourceName: src ? src.name : (raw.originName || '（缺书源）'),
        bookUrl: raw.bookUrl, intro: raw.intro || '', cover: raw.cover || '',
        total: raw.total || 0, chapters: [], groupId: raw.groupName ? ensureGroup(raw.groupName) : 'g_default',
        createdAt: Date.now(), updatedAt: Date.now()
      });
      if (raw.durChapterIndex) {
        st.progress[id] = { ci: raw.durChapterIndex, title: raw.durChapterTitle || '', pct: 0, at: raw.durChapterTime || Date.now() };
      }
      added++;
    }
    // 3) 书签
    let bmAdded = 0;
    for (const bm of parts.bookmarks || []) {
      const book = st.books.find(b => b.name === bm.bookName);
      if (!book) continue;
      if (st.bookmarks.some(x => x.bookId === book.id && x.ci === bm.ci)) continue;
      st.bookmarks.push({
        id: uid('B'), bookId: book.id, name: book.name, author: book.author,
        ci: bm.ci, title: bm.title, pct: 0, text: bm.text || '', at: bm.at
      });
      bmAdded++;
    }
    // 4) 阅读记录
    for (const r of parts.records || []) {
      const book = st.books.find(b => b.name === r.bookName);
      if (!book) continue;
      st.history.unshift({ id: uid('H'), bookId: book.id, name: book.name, ci: r.ci, title: r.title, at: r.at });
    }
    st.history = st.history.slice(0, 300);
    save(true);
    return { added, updated, srcAdded, srcUpdated, bmAdded, noSource };
  }

  async function restoreFromZip() {
    const r = await mo.pickZip();
    if (!r.ok) {
      if (r.error) {
        const more = /不是有效的 ZIP|没有识别到书源|读取失败|无法读取/.test(r.error)
          ? '（支持：墨读备份 .zip、原版「阅读」的备份 .zip、书源 .json）' : '';
        toast(r.error + more);
      }
      return;
    }
    showRestoreConfirm(r);
  }

  /** 弹出恢复确认框——安卓「用墨读打开备份」也复用这里 */
  function showRestoreConfirm(r) {
    if (!r || !r.ok) { if (r && r.error) toast(r.error); return; }
    if (r.kind === 'sources') {
      const { added, updated } = mergeSources((r.sources || []).map(Engine.normalizeSource));
      return toast(`书源导入完成：新增 ${added}，更新 ${updated}`);
    }
    const s = r.summary || {};
    const isLegado = r.kind === 'legado';
    openModal(`<h3>恢复备份</h3>
      <p class="desc">文件：${esc(r.name)}<br>
      格式：${isLegado ? '<b>原版「阅读」备份</b>（会自动转成墨读的书架与书源）' : '墨读完整备份'}<br>
      包含 ${s.books || 0} 本书、${s.sources || 0} 个书源、${s.bookmarks || 0} 条书签${s.withFiles ? '、以及本地书文件' : ''}
      ${s.skippedLocal ? `<br><span style="color:#a33">另有 ${s.skippedLocal} 本原版本地书（手机上的文件路径），无法还原，已跳过</span>` : ''}</p>
      <div class="modal-actions">
        <button class="btn left" onclick="window.__closeModal()">取消</button>
        <button class="btn" id="rs-merge">合并进现有书架</button>
        <button class="btn danger" id="rs-replace">覆盖现有数据</button>
      </div>`);
    $('#rs-merge').onclick = () => doApplyRestore(r, 'merge');
    $('#rs-replace').onclick = () => {
      if (!confirm('覆盖会清掉当前书架、书源和进度，确定？')) return;
      doApplyRestore(r, 'replace');
    };
  }

  async function doApplyRestore(r, mode) {
    if (r.kind === 'moread') {
      const res = await mo.applyZip(mode);
      if (!res.ok) return toast('恢复失败：' + res.error);
      S.state = res.state;
      applySettings();
      closeModal(); renderShelf(); setView('shelf');
      const n = (res.state.books || []).length;
      const miss = Number(res.missingLocal) || 0;
      if (miss > 0) {
        /* 这份备份没带本地书正文：书名和进度回来了，但点开是空的。
           不说清楚的话，用户只会觉得"恢复了但读不了"。 */
        openModal(`<h3>恢复了 ${n} 本书</h3>
          <p class="desc">书架和阅读进度都在。不过有 <b>${miss} 本本地书</b>没带上原文件——
          这份备份是「不含本地书」的版本，正文需要重新导入原 txt / epub 才能读。</p>
          <p class="desc">下次导出时选 <b>「完整备份（含本地书文件）」</b>，就能连正文一起带走。</p>
          <div class="modal-actions">
            <button class="btn left" id="rs-reimport">去导入原文件</button>
            <button class="btn primary" onclick="window.__closeModal()">知道了</button>
          </div>`);
        const btn = $('#rs-reimport');
        if (btn) btn.onclick = () => { closeModal(); setView('shelf'); importBooks(); };
        return;
      }
      return toast(`已恢复 ${n} 本书、${(res.state.sources || []).length} 个书源`);
    }
    // Legado 备份
    const counts = applyLegado(r.legado || {}, mode);
    closeModal();
    applySettings();
    renderShelf(); setView('shelf');
    toast(`恢复完成：书 ${counts.added} 本、书源 ${counts.srcAdded} 个、书签 ${counts.bmAdded} 条`
      + (counts.noSource ? `（${counts.noSource} 本没匹配到书源，阅读时可手动换源）` : ''));
  }

  /* ---------------- 坚果云操作 ---------------- */
  function readDavForm() {
    const d = S.state.settings.webdav;
    d.url = $('#dav-url').value.trim();
    d.user = $('#dav-user').value.trim();
    d.pass = $('#dav-pass').value;
    d.dir = $('#dav-dir').value.trim() || 'MoRead';
    save(true);
    return d;
  }

  async function davSaveTest() {
    readDavForm();
    const btn = $('#dav-save');
    btn.disabled = true; btn.textContent = '连接中…';
    const r = await mo.dav.test();
    btn.disabled = false; btn.textContent = '保存并测试';
    const st = $('#dav-state');
    if (r.ok) {
      st.textContent = '已连接';
      st.classList.add('ok');
      toast(`连接成功 · ${r.ms}ms · 目录里 ${r.items} 个文件`);
      $('#dav-last').textContent = '连接正常';
      davLoadList();
    } else {
      st.textContent = '连接失败';
      st.classList.remove('ok');
      toast('连接失败：' + r.error);
    }
  }

  async function davLoadList() {
    const box = $('#dav-list');
    if (!box) return;
    box.innerHTML = '<div class="hint">读取中…</div>';
    const r = await mo.dav.list();
    if (!r.ok) { box.innerHTML = `<div class="hint">读取失败：${esc(r.error)}</div>`; return; }
    const zips = (r.items || []).filter(i => /\.zip$/i.test(i.name));
    if (!zips.length) { box.innerHTML = '<div class="hint">云端还没有备份，点「立即备份」上传一份。</div>'; return; }
    box.innerHTML = zips.map(i => `
      <div class="dav-item">
        <div class="dav-ico">zip</div>
        <div class="dav-body">
          <div class="dav-t">${esc(i.name)}</div>
          <div class="dav-s">${(i.size / 1024).toFixed(0)} KB · ${fmtWhen(i.at)}</div>
        </div>
        <button class="btn xs primary" data-dav-get="${esc(i.name)}">恢复</button>
        <button class="btn xs danger" data-dav-del="${esc(i.name)}">删除</button>
      </div>`).join('');
    $$('[data-dav-get]').forEach(b => b.onclick = () => davRestore(b.dataset.davGet));
    $$('[data-dav-del]').forEach(b => b.onclick = async () => {
      if (!confirm(`删除云端备份 ${b.dataset.davDel}？`)) return;
      const r2 = await mo.dav.remove(b.dataset.davDel);
      if (!r2.ok) return toast('删除失败：' + r2.error);
      toast('已删除'); davLoadList();
    });
  }

  async function davBackup() {
    readDavForm();
    await mo.state.set(S.state); // 保证云端拿到的是最新书架与进度
    const btn = $('#dav-backup');
    btn.disabled = true; btn.textContent = '上传中…';
    const r = await mo.dav.backup(false);
    btn.disabled = false; btn.textContent = '立即备份';
    if (!r.ok) return toast('备份失败：' + r.error);
    const d = S.state.settings.webdav;
    d.lastBackupAt = Date.now(); d.lastBackupName = r.name;
    save(true);
    $('#dav-state').textContent = '已连接';
    $('#dav-state').classList.add('ok');
    $('#dav-last').textContent = '上次备份 ' + fmtWhen(Date.now());
    toast(`已上传 ${r.name} · ${(r.size / 1024).toFixed(0)} KB · ${r.ms}ms`);
    davLoadList();
  }

  async function davRestore(name) {
    openModal(`<h3>从云端恢复</h3><p class="desc">正在下载 ${esc(name)}…</p>`);
    const r = await mo.dav.download(name);
    if (!r.ok) { closeModal(); return toast('下载失败：' + r.error); }
    const s = r.summary || {};
    openModal(`<h3>从云端恢复</h3>
      <p class="desc">文件：${esc(name)}<br>格式：${r.kind === 'legado' ? '原版「阅读」备份' : '墨读完整备份'}<br>
      包含 ${s.books || 0} 本书、${s.sources || 0} 个书源、${s.bookmarks || 0} 条书签
      ${s.skippedLocal ? `<br><span style="color:#a33">${s.skippedLocal} 本原版本地书已跳过</span>` : ''}</p>
      <div class="modal-actions">
        <button class="btn left" onclick="window.__closeModal()">取消</button>
        <button class="btn" id="dr-merge">合并</button>
        <button class="btn danger" id="dr-replace">覆盖</button>
      </div>`);
    $('#dr-merge').onclick = () => doApplyRestore(Object.assign({}, r), 'merge');
    $('#dr-replace').onclick = () => {
      if (!confirm('覆盖会清掉当前数据，确定？')) return;
      doApplyRestore(Object.assign({}, r), 'replace');
    };
  }

  async function davUploadSources() {
    readDavForm();
    const r = await mo.dav.uploadSources();
    if (!r.ok) return toast('上传失败：' + r.error);
    S.state.settings.webdav.lastSyncAt = Date.now();
    save(true);
    $('#dav-last').textContent = '书源已同步 ' + fmtWhen(Date.now());
    toast(`已上传 ${r.count} 个书源（${(r.size / 1024).toFixed(1)} KB）`);
  }

  async function davDownloadSources() {
    readDavForm();
    const r = await mo.dav.downloadSources();
    if (!r.ok) return toast('下载失败：' + r.error);
    const list = (r.sources || []).map(Engine.normalizeSource);
    if (!list.length) return toast('云端没有书源');
    const { added, updated } = mergeSources(list);
    S.state.settings.webdav.lastSyncAt = Date.now();
    save(true);
    $('#dav-last').textContent = '书源已同步 ' + fmtWhen(Date.now());
    toast(`云端书源：新增 ${added}，更新 ${updated}`);
  }

  async function updateCacheSize() {
    const size = await mo.cache.size();
    const el = $('#cache-size');
    if (el) el.textContent = (size / 1024 / 1024).toFixed(1) + ' MB';
  }

  /* ===========================================================
     阅读器
     =========================================================== */
  const R = {
    book: null, ci: 0, chapters: [], paras: [], title: '',
    pages: [[]], page: 0, tts: false, ttsIdx: 0, timer: null, saveT: null, chars: 0,
    /* 连续滚动缓冲区（滚动模式）：buf=已接上的章节号，bufTail=最后一章，
       bufLock=正在取下一章，bufFail=取失败的章节与时间；lastWithin=本章内进度 */
    buf: null, bufTail: -1, bufLock: false, bufFail: {}, lastWithin: null, loadSeq: 0
  };

  function applySettings() {
    const s = S.state.settings;
    $('#reader').dataset.theme = s.theme;
    $$('#r-swatches .sw').forEach(el => el.classList.toggle('on', el.dataset.t === s.theme));
    $('#r-mode').textContent = s.pageMode === 'paged' ? '翻页' : '滚动';
    $('#r-font').textContent = s.fontFamily === 'serif' ? '宋体' : '黑体';
    $('#r-fs-num').textContent = s.fontSize;
  }

  function applyReaderStyle() {
    const s = S.state.settings;
    const page = $('#r-page');
    if (!page) return;
    page.style.setProperty('--r-fs', s.fontSize + 'px');
    page.style.setProperty('--r-lh', s.lineHeight);
    page.style.setProperty('--para-gap', (s.paraGap ? (s.lineHeight > 1.9 ? 1.05 : .8) : .2) + 'em');
    /* 分页模式一行最多约 58 字：字号变大时书页跟着变宽，超宽屏也不会拉成一条长行 */
    page.style.setProperty('--page-max', Math.round(s.fontSize * 58) + 'px');
    page.classList.toggle('nofamily', s.fontFamily !== 'serif');
    $('#reader').classList.toggle('mode-paged', s.pageMode === 'paged');
    $('#r-fs-num').textContent = s.fontSize;
    $('#r-font').textContent = s.fontFamily === 'serif' ? '宋体' : '黑体';
    $('#r-mode').textContent = s.pageMode === 'paged' ? '翻页' : '滚动';
    /* 分页时底栏翻的是页，不是章 —— 文案跟着模式走，免得以为一下跳一章 */
    const prev = $('#r-prev'), next = $('#r-next');
    if (prev) prev.textContent = s.pageMode === 'paged' ? '上一页' : '上一章';
    if (next) next.textContent = s.pageMode === 'paged' ? '下一页' : '下一章';
    if (prev) prev.title = s.pageMode === 'paged' ? '上一页（← / PageUp）' : '上一章';
    if (next) next.title = s.pageMode === 'paged' ? '下一页（→ / PageDown / 空格）' : '下一章';
  }

  async function openReader(bookId, ci, pct) {
    const b = getBook(bookId);
    if (!b) return;
    R.book = b;
    R.chapters = b.chapters || [];
    R.ci = clamp(ci || 0, 0, Math.max(0, (b.total || 1) - 1));
    R.page = 0;
    $('#reader').classList.add('open');
    /* 手机进书即沉浸：顶/底栏滑出屏幕，点中间唤出（几秒不用自动再藏） */
    if (isAndroidApp()) $('#reader').classList.add('bars-off');
    $('#r-switch').style.display = b.kind === 'local' ? 'none' : '';
    applySettings();
    $('#r-toc-panel').classList.remove('open');
    $('#toc-mask').classList.remove('on');
    startReadingTimer();
    await loadChapter(R.ci, 0, pct);
  }

  function closeReader() {
    const b = R.book;
    if (b) {
      /* 连续滚动时缓冲区里有多章，整页 scrollTop 不再等于本章进度，
         用 updateProgress 算好的「本章内进度」落盘 */
      const stage = $('#r-stage');
      const max = stage.scrollHeight - stage.clientHeight;
      const pct = R.lastWithin != null ? R.lastWithin : (max > 10 ? stage.scrollTop / max : 1);
      setProgress(b.id, R.ci, R.title, pct);
    }
    stopTTS();
    clearInterval(R.timer);
    R.timer = null;
    clearTimeout(R.barsT); R.barsT = null;
    $('#reader').classList.remove('open', 'bars-off');
    $('#r-toc-panel').classList.remove('open');
    $('#toc-mask').classList.remove('on');
    R.book = null;
    if (mo.win.isFull) mo.win.fullscreen();
    save(true);
    /* 无论从哪个视图（搜索/书签/历史）进的阅读器，返回都回到书架 */
    if (S.view !== 'shelf') setView('shelf'); else renderShelf();
  }

  function startReadingTimer() {
    clearInterval(R.timer);
    R.timer = setInterval(() => {
      if (!R.book) return;
      if (document.hidden) return;
      addStats(0, 15);
    }, 15000);
  }

  async function loadChapter(ci, dir, pct) {
    const b = R.book;
    if (!b) return;
    /* 并发导航互斥：快速连按「上一章」时，慢的那次可能后完成，把旧章节的标题/
       内容配新章节的 ci 渲染出来（章节和 data-ci 就错位了）。后启动的调用递增
       代数，先启动的完成后发现代数对不上就整个丢弃。 */
    const seq = ++R.loadSeq;
    if (R.tts) stopTTS();
    R.ci = clamp(ci, 0, Math.max(0, (b.total || 1) - 1));
    const loading = $('#r-loading');
    loading.textContent = '加载中…';
    $('#r-pagenum').textContent = '';
    R.paras = [];
    R.lastWithin = null;

    try {
      let title = '', paras = [];
      if (b.kind === 'local') {
        const r = await mo.localChapter(b.id, R.ci);
        if (!r.ok) throw new Error(r.error || '读取失败');
        title = r.title; paras = r.text;
      } else {
        const src = srcForBook(b);
        if (!src) throw new Error('这个书源已被删除，可以点右上角「换源」换一个源继续读');
        if (!b.chapters || !b.chapters.length) {
          loading.textContent = '获取目录…';
          /* 30s 双保险：底层网络有自己的超时，但失效书源常走多级重定向/慢站，
             不兜一层的话「加载中…」能挂到天荒地老，看起来就像卡死 */
          const toc = await withTimeout(Engine.getToc(mo.net, src, b.bookUrl), 30000);
          b.chapters = toc.chapters; b.total = toc.chapters.length;
          if (toc.info.name) b.name = toc.info.name;
          if (toc.info.author) b.author = toc.info.author;
          if (toc.info.coverUrl) b.cover = toc.info.coverUrl;
          upsertBook(b);
          R.chapters = b.chapters;
          buildToc();
          if (!b.chapters.length) throw new Error('目录为空，检查书源的目录规则');
        }
        const ch = b.chapters[R.ci];
        if (!ch) throw new Error('章节不存在');
        title = ch.title;
        const cached = await mo.cache.get(b.id, R.ci);
        if (cached && cached.text && cached.text.length) {
          paras = cached.text;
        } else {
          loading.textContent = '加载正文…';
          const r = await withTimeout(Engine.getContent(mo.net, src, ch.url), 30000);
          paras = r.paras;
          if (!paras.length) throw new Error('正文为空，检查正文规则');
          await mo.cache.set(b.id, R.ci, { title, text: paras });
        }
        if (S.state.settings.autoCacheNext && R.ci + 1 < b.chapters.length) {
          prefetch(b, src, R.ci + 1);
        }
      }

      /* 等待期间用户可能又点了别的章节：过期的这次直接丢弃，不渲染不写状态 */
      if (seq !== R.loadSeq) return;
      R.title = title;
      R.paras = paras;
      R.chars = paras.join('').length;
      addStats(R.chars, 0);
      renderChapter(dir);
      if (pct) {
        const stage = $('#r-stage');
        if (S.state.settings.pageMode === 'paged') {
          R.page = clamp(Math.round(pct * (R.pages.length - 1)), 0, R.pages.length - 1);
          renderChapter(0);
        } else {
          stage.scrollTop = pct * (stage.scrollHeight - stage.clientHeight);
        }
      }
      updateProgress(true);
      setProgress(b.id, R.ci, title, 0);
      $('#r-title').innerHTML = `${esc(b.name)}<em>${esc(title)}</em>`;
      $('#r-info').textContent = `本章 ${R.chars.toLocaleString()} 字`;
      loading.textContent = '';
      /* 章节很短不满一屏时永远不产生 scroll 事件，加载完主动续一次 */
      if (seq === R.loadSeq) maybeContinueScroll();
    } catch (e) {
      if (seq !== R.loadSeq) return;      // 过期的失败也别把新章节的页面糊成错误页
      const msg = e.message || String(e);
      const canSwitch = b.kind !== 'local';
      $('#r-page').innerHTML = `<div class="err">加载失败：${esc(msg)}<br>
        <span style="font-size:12px;opacity:.7">${canSwitch ? '这个书源可能已失效，先点「重试」再抓一次；还不行就换一个源继续读' : '检查「书源」里的规则，或重新导入这本书'}</span>
        <div class="err-act">
          <button class="btn" id="err-retry">重试</button>
          ${canSwitch ? '<button class="btn primary" id="err-switch">换源继续读</button>' : ''}
        </div></div>`;
      const sw = $('#err-switch');
      if (sw) sw.onclick = () => $('#r-switch').click();
      const rt = $('#err-retry');
      if (rt) rt.onclick = () => { rt.disabled = true; loadChapter(R.ci, 0, 0); };
      loading.textContent = '';
      R.paras = [];
      R.buf = null; R.bufTail = -1;   // 出错时清掉缓冲区，别往错误页后面续章节
    }
  }

  async function prefetch(b, src, idx) {
    try {
      const hit = await mo.cache.get(b.id, idx);
      if (hit) return;
      const ch = b.chapters[idx];
      if (!ch) return;
      const r = await Engine.getContent(mo.net, src, ch.url);
      if (r.paras.length) await mo.cache.set(b.id, idx, { title: ch.title, text: r.paras });
    } catch (e) { /* 预取失败无所谓 */ }
  }

  /* ---------------- 滚动模式连续阅读：滚到底自动续下一章 ---------------- */

  /** 取某章正文（连续滚动用）：本地直接读，网络书先查缓存再抓，超时兜底与 loadChapter 一致 */
  async function chapterParas(b, idx) {
    if (b.kind === 'local') {
      const r = await mo.localChapter(b.id, idx);
      if (!r.ok) throw new Error(r.error || '读取失败');
      return { title: r.title, paras: r.text };
    }
    const ch = b.chapters && b.chapters[idx];
    if (!ch) throw new Error('章节不存在');
    const cached = await mo.cache.get(b.id, idx);
    if (cached && cached.text && cached.text.length) return { title: ch.title, paras: cached.text };
    const src = srcForBook(b);
    if (!src) throw new Error('书源已被删除，无法继续加载');
    const r = await withTimeout(Engine.getContent(mo.net, src, ch.url), 30000);
    if (!r.paras.length) throw new Error('正文为空，检查正文规则');
    await mo.cache.set(b.id, idx, { title: ch.title, text: r.paras });
    if (S.state.settings.autoCacheNext && idx + 1 < (b.chapters || []).length) prefetch(b, src, idx + 1);
    return { title: ch.title, paras: r.paras };
  }

  /** 滚动模式：视口逼近缓冲区底部时，把下一章接到后面。不动当前滚动位置，
   *  章节归属由 updateProgress 按各段 offsetTop 判定（见「判定线」）。
   *  失败不自动重试刷屏，在文末挂一条「重试」，30 秒内也不再自动碰同一章。 */
  async function maybeContinueScroll() {
    const s = S.state.settings;
    if (s.pageMode !== 'scroll' || !R.book || !R.buf || R.bufLock) return;
    const b = R.book;
    const total = b.total || 1;
    const idx = R.bufTail + 1;
    if (idx >= total) return;
    if (R.bufFail && R.bufFail[idx] && Date.now() - R.bufFail[idx] < 30000) return;
    const stage = $('#r-stage');
    if (!stage) return;
    /* 距底部不足约 1.2 屏时开始续——网络慢也来得及在用户滚到之前接上 */
    if (stage.scrollTop + stage.clientHeight < stage.scrollHeight - stage.clientHeight * 1.2) return;
    const seq = R.loadSeq;
    R.bufLock = true;
    try {
      const { title, paras } = await chapterParas(b, idx);
      /* 等待期间可能切了模式 / 换了书 / 缓冲区被 renderChapter 重置过 */
      if (seq !== R.loadSeq || S.state.settings.pageMode !== 'scroll' || !R.book || R.book.id !== b.id || !R.buf) return;
      const page = $('#r-page');
      if (!page) return;
      /* 只允许按序追加：目标章已在 DOM 里、或 DOM 里已有更靠后的章（旧缓冲区残留 /
         并发追加乱序），都不再插，避免章节段乱序害边界判定失灵 */
      if ($$('#r-page .ch-sec').some(el => +el.dataset.ci >= idx)) return;
      if (idx !== R.bufTail + 1) return;
      const last = idx + 1 >= total;
      const sec = document.createElement('section');
      sec.className = 'ch-sec';
      sec.dataset.ci = idx;
      sec.dataset.title = title;
      sec.dataset.chars = paras.join('').length;
      sec.innerHTML = `<div class="ch-no">${esc(b.name)} · 共 ${total} 章</div><h2>${esc(title)}</h2>` +
        `<div class="body">${paras.map(p => `<p>${esc(p)}</p>`).join('')}</div>` + (last ? pageTailHtml() : '');
      page.appendChild(sec);
      R.buf.push(idx);
      R.bufTail = idx;
      addStats(paras.join('').length, 0);
      page.querySelectorAll('.buf-err').forEach(el => el.remove());
    } catch (e) {
      if (R.bufFail) R.bufFail[idx] = Date.now();
      const page = $('#r-page');
      if (page && S.state.settings.pageMode === 'scroll' && R.book && R.book.id === (b && b.id)) {
        page.querySelectorAll('.buf-err').forEach(el => el.remove());
        const div = document.createElement('div');
        div.className = 'buf-err';
        div.innerHTML = `下一章没接上：${esc(e.message || e)} <button class="btn" type="button">重试</button>`;
        div.querySelector('button').onclick = () => {
          if (R.bufFail) delete R.bufFail[idx];
          div.remove();
          maybeContinueScroll();
        };
        page.appendChild(div);
      }
    } finally {
      R.bufLock = false;
      updateProgress(true);
      /* 刚接上的一章可能仍然很短，续完再检查一次，直到离底部超过 1.2 屏 */
      maybeContinueScroll();
    }
  }

  /** 翻页动效：走 Web Animations，不再「删类 → 读 offsetWidth → 加类」逼一次同步重排。
   *  dir>0 右→左滑入，dir<0 反向，0 表示淡入（换设置/重排）。R.noAnim 时跳过。 */
  function pageAnim(el, dir) {
    if (!el || R.noAnim || dir == null || !el.animate) return;
    const kf = dir > 0
      ? [{ opacity: .2, transform: 'translateX(26px)' }, { opacity: 1, transform: 'none' }]
      : dir < 0
        ? [{ opacity: .2, transform: 'translateX(-26px)' }, { opacity: 1, transform: 'none' }]
        : [{ opacity: 0, transform: 'translateY(6px)' }, { opacity: 1, transform: 'none' }];
    try {
      /* 整屏正文做透明度动画在手机上会整页重绘；提前提层交给合成器，动画期间不再掉帧 */
      el.style.willChange = 'transform, opacity';
      const a = el.animate(kf, { duration: 260, easing: 'ease' });
      const done = () => { el.style.willChange = ''; };
      if (a) { a.onfinish = done; a.oncancel = done; } else done();
    } catch (e) { el.style.willChange = ''; /* 老 WebView 不支持就算了 */ }
  }

  function renderChapter(dir) {
    const b = R.book;
    const s = S.state.settings;
    const page = $('#r-page');

    if (s.pageMode === 'paged') {
      layoutPages();
      const ps = R.pages[R.page] || [];
      /* 首页显示书名 + 章节名，之后的书页只留一行轻页眉 —— 与 layoutPages 里的
         测量模板保持一致，否则每页可用高度算多了，正文会溢出到页外 */
      page.innerHTML = pageHeadHtml(R.page === 0) +
        `<div class="body">${ps.map(p => `<p>${esc(p)}</p>`).join('')}</div>`;
      if (R.page === R.pages.length - 1) {
        page.insertAdjacentHTML('beforeend', pageTailHtml());
        const st = $('#r-stage');
        /* 「本章完」是装饰，放不下就省掉：宁可少一句提示，也不能让它把正文顶出屏幕 */
        if (st && page.getBoundingClientRect().height > st.clientHeight + 2 && page.lastElementChild) {
          page.removeChild(page.lastElementChild);
        }
      }
      pageAnim(page, dir);
      $('#r-stage').scrollTop = 0;
      $('#r-pagenum').textContent = `${R.page + 1}/${R.pages.length} 页`;
    } else {
      /* 连续滚动：本章是缓冲区第一段，滚近底部时 maybeContinueScroll 会把下一章接在
         后面（见 prefetch 之后）。缓冲区结构：#r-page > section.ch-sec[data-ci] */
      R.buf = [R.ci]; R.bufTail = R.ci; R.bufLock = false; R.bufFail = {};
      const last = R.ci + 1 >= (b.total || 1);
      const head = `<div class="ch-no">${esc(b.name)} · 共 ${b.total || '?'} 章</div><h2>${esc(R.title)}</h2>`;
      page.innerHTML = `<section class="ch-sec" data-ci="${R.ci}" data-title="${esc(R.title)}" data-chars="${R.chars}">` +
        head + `<div class="body">${R.paras.map(p => `<p>${esc(p)}</p>`).join('')}</div>` +
        (last ? pageTailHtml() : '') + `</section>`;
      pageAnim(page, dir === undefined ? null : dir);
      if (dir) $('#r-stage').scrollTop = 0;
      $('#r-pagenum').textContent = '';
    }
    applyReaderStyle();
  }

  /** 按当前阅读区尺寸把章节切成一页页。
   *   1) 宽 / 高 / 边距全部实测，不写死 730px —— 翻页时正文会铺满整个阅读区
   *   2) 超长段落用 Range 二分按可视高度从中间截断，不会整段溢出到页外
   *   3) 结果按「影响排版的因子」缓存，翻页本身不再重复排版 */
  let pagedKey = '', pagedPages = null;

  function pageHeadHtml(first) {
    const b = R.book || {};
    return first
      ? `<div class="ch-no">${esc(b.name || '')} · 共 ${b.total || '?'} 章</div><h2>${esc(R.title || '')}</h2>`
      : `<div class="ch-no">${esc(b.name || '')} · ${esc(R.title || '')}</div>`;
  }
  function pageTailHtml() { return `<div class="end">本章完</div>`; }

  function measPadV(s) {
    return (s.paraGap ? (s.lineHeight > 1.9 ? 1.05 : .8) : .2) + 'em';
  }
  function layoutPages(force) {
    const stage = $('#r-stage'), page = $('#r-page');
    const s = S.state.settings;
    if (!stage || !page) return;
    /* 先确保 mode-paged 已生效，否则量到的是滚动模式的宽度 */
    $('#reader').classList.toggle('mode-paged', true);

    const cs = getComputedStyle(page);
    const padTop = parseFloat(cs.paddingTop) || 0;
    const padBottom = parseFloat(cs.paddingBottom) || 0;
    const padX = (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.paddingRight) || 0);
    const availW = Math.max(240, Math.round((page.clientWidth || stage.clientWidth) - padX));

    const boxStyle = `position:absolute;left:-9999px;top:0;visibility:hidden;pointer-events:none;` +
      `width:${availW + padX}px;padding:${padTop}px ${parseFloat(cs.paddingRight) || 0}px ${padBottom}px ${parseFloat(cs.paddingLeft) || 0}px;` +
      `max-width:none;margin:0;`;
    const mk = inner => {
      const d = document.createElement('div');
      d.className = 'page' + (s.fontFamily !== 'serif' ? ' nofamily' : '');
      d.style.cssText = boxStyle;
      d.style.setProperty('--r-fs', s.fontSize + 'px');
      d.style.setProperty('--r-lh', s.lineHeight);
      d.style.setProperty('--para-gap', measPadV(s));
      d.innerHTML = inner;
      document.body.appendChild(d);
      return d;
    };

    /* ---- 第一步：量出「一页能装多少正文」 ----
     * 不再用「页眉高 + 页脚高」逐项相减：末页「本章完」的 margin、段落 margin 是否
     * collapse 出去都算不准，窄高屏上会差出十几二十像素。直接把一页只放页眉的空壳
     * 渲染出来量 offsetHeight，误差为零。首页有书名和章节标题，单独量一份。
     *
     * 这里刻意**不**为「本章完」预留高度：它只出现在末页，每页都留一块等于白扔两三行，
     * 横屏下肉眼可见一大片空白。末页放不下时由渲染层决定省略它（见 renderChapter）。 */
    const baseOf = first => {
      const d = mk(pageHeadHtml(first) + '<div class="body"></div>');
      const h = d.offsetHeight;
      document.body.removeChild(d);
      return h;
    };
    const baseNext = baseOf(false);
    const baseFirst = baseOf(true);

    const availH = Math.max(80, Math.round(stage.clientHeight - baseNext));
    /* 首页要多扣「书名 + 章节标题」比一行页眉多出来的高度 */
    const firstPenalty = Math.max(0, Math.round(baseFirst - baseNext));
    const key = [availW, availH, firstPenalty, s.fontSize, s.lineHeight, s.fontFamily, s.paraGap ? 1 : 0,
      R.paras.length, R.ci, (R.book || {}).id, R.title].join('|');
    if (!force && key === pagedKey && pagedPages) {
      R.pages = pagedPages;
      R.page = clamp(R.page, 0, R.pages.length - 1);
      return;
    }

    /* ---- 第二步：逐段排版分页 ----
     * 所有段落一次性放进测量盒、统一读高度：第一次读取触发排版，后面全是缓存读数。
     * 旧实现每段都「清空 → 重建 <p> → 读 offsetHeight」，n 段就是 n 次强制回流，
     * 手机 WebView 上一章几百段要卡一两秒，翻页像 PPT。
     * 行中截断（整段超过一页）仍然逐块实测，但只有这种段落才付这个钱。 */
    const box = mk('');
    const bEl = document.createElement('div');
    bEl.className = 'body';
    box.appendChild(bEl);
    const mb = el => parseFloat(getComputedStyle(el).marginBottom) || 0;
    const els = R.paras.map(t => {
      const p = document.createElement('p');
      p.textContent = t;
      bEl.appendChild(p);
      return p;
    });
    /* 段落只有下外边距、无上外边距，相邻段高度可直接相加 */
    const MB = els.length ? mb(els[0]) : 0;
    const heights = els.map(el => el.offsetHeight);
    /** 二分找「前 n 个字」正好还在 maxH 高度内的最大 n */
    const fitOffset = (node, maxH, len) => {
      const rg = document.createRange();
      rg.setStart(node, 0);
      const fits = i => { rg.setEnd(node, i); return rg.getBoundingClientRect().height <= maxH; };
      if (fits(len)) return len;
      let lo = 1, hi = len, best = 0;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (fits(mid)) { best = mid; lo = mid + 1; } else hi = mid - 1;
      }
      return best;
    };

    const pages = [[]];
    /* 首页先扣掉标题占的高度，后续页从 0 开始 */
    let cur = 0, used = firstPenalty;
    let sp = null;                       // 行中截断的测量元素（复用同一个，避免反复插拔）
    for (let i = 0; i < R.paras.length; i++) {
      const whole = heights[i] + MB;
      if (used + whole <= availH + 0.5) {          // 整段放得下
        pages[cur].push(R.paras[i]);
        used += whole;
        continue;
      }
      if (pages[cur].length) {                     // 本页已有内容 → 先翻页再试
        pages.push([]); cur = pages.length - 1; used = 0;
      }
      if (whole <= availH + 0.5) {                 // 空页整段放得下
        pages[cur].push(R.paras[i]);
        used = whole;
        continue;
      }
      /* 空页也放不下：按剩余高度从行中间截断 */
      if (!sp) { sp = document.createElement('p'); bEl.appendChild(sp); }
      let rest = R.paras[i], guard = 0;
      while (rest && guard++ < 400) {
        sp.textContent = rest;
        const full = sp.offsetHeight + MB;
        if (full <= availH + 0.5) { pages[cur].push(rest); used = full; rest = ''; break; }
        const node = sp.firstChild;
        let off = node ? fitOffset(node, availH, rest.length) : 0;
        if (off <= 0) { pages[cur].push(rest); used = availH; break; }  // 高度不足一行，硬放避免死循环
        /* 落点在标点上时顺延一个字，免得下一页首行以标点开头 */
        if (off < rest.length && /[，。！？；：、）】》」』…—]/.test(rest[off])) off += 1;
        pages[cur].push(rest.slice(0, off));
        rest = rest.slice(off);
        pages.push([]); cur = pages.length - 1; used = 0;
      }
    }
    if (sp) sp.remove();
    if (pages.length > 1 && !pages[pages.length - 1].length) pages.pop();
    document.body.removeChild(box);

    /* ---- 第三步：逐页实测兜底 ----
     * 上面靠「页眉/页脚高度估算」算可用高度，窄高屏上仍可能差几十像素（末页的
     * 「本章完」还带一段上外边距），内容会顶出屏幕底部。这里用「高度锁死为阅读区高度」
     * 的探针真实排版每一页，超出就把末尾段落挪到下一页。
     *
     * 两道保险，缺一不可（踩过：没有上限时页面只有一段却永远装不下，会不停新建空白页，
     * 直接把 WebView 卡死）：单页只剩一段就认输；总移动次数给个预算。 */
    if (pages.length) {
      const probe = mk('');
      try {
        probe.style.height = stage.clientHeight + 'px';
        probe.style.overflow = 'hidden';
        const overOf = (arr, first, last) => {
          probe.innerHTML = pageHeadHtml(first) + '<div class="body"></div>' + (last ? pageTailHtml() : '');
          const b = probe.querySelector('.body');
          b.innerHTML = arr.map(t => `<p>${esc(t)}</p>`).join('');
          return probe.scrollHeight - probe.clientHeight;
        };
        let budget = Math.max(30, pages.length * 6);
        const maxPages = pages.length * 2 + 3;
        for (let i = 0; i < pages.length && budget > 0; i++) {
          while (budget-- > 0) {
            const isLast = i === pages.length - 1;
            if (overOf(pages[i], i === 0, isLast) <= 0) break;
            if (pages[i].length <= 1) break;      // 只剩一段还装不下：宁可它满页，也不再推
            if (pages.length >= maxPages) break;
            const t = pages[i].pop();
            if (!pages[i + 1]) pages.push([]);
            pages[i + 1].unshift(t);
          }
        }
      } catch (e) {
        console.error('分页兜底失败：', e);
      } finally {
        if (probe.parentNode) probe.parentNode.removeChild(probe);
      }
      if (pages.length > 1 && !pages[pages.length - 1].length) pages.pop();
    }

    pagedPages = pages.length ? pages : [[]];
    pagedKey = key;
    R.pages = pagedPages;
    R.page = clamp(R.page, 0, R.pages.length - 1);
  }

  function updateProgress(reset) {
    const b = R.book;
    if (!b) return;
    const s = S.state.settings;
    let within, overall;
    if (s.pageMode === 'paged') {
      within = R.pages.length > 1 ? R.page / (R.pages.length - 1) : 1;
      overall = ((R.ci + within) / Math.max(1, b.total)) * 100;
    } else {
      const stage = $('#r-stage');
      const max = stage.scrollHeight - stage.clientHeight;
      within = max > 10 ? stage.scrollTop / max : 1;
      /* 连续滚动：缓冲区里不止一章时，用「判定线（视口上沿往下 40%）落在哪个
         章节段里」更新当前章。offscreen 段落有 content-visibility 会让 offsetTop
         略有浮动，但各段先后顺序不变，判定不受影响。 */
      if (R.buf && R.buf.length > 1) {
        const secs = $$('#r-page .ch-sec');
        const line = stage.scrollTop + stage.clientHeight * 0.4;
        let cur = +secs[0].dataset.ci, curEl = secs[0];
        for (const sec of secs) {
          if (sec.offsetTop <= line) { cur = +sec.dataset.ci; curEl = sec; } else break;
        }
        if (cur !== R.ci) {
          R.ci = cur;
          R.title = curEl.dataset.title || R.title;
          R.chars = +curEl.dataset.chars || R.chars;
          $('#r-title').innerHTML = `${esc(b.name)}<em>${esc(R.title)}</em>`;
          $('#r-info').textContent = `本章 ${R.chars.toLocaleString()} 字`;
          updateTocActive();
        }
        within = clamp((line - curEl.offsetTop) / Math.max(1, curEl.offsetHeight), 0, 1);
      }
      overall = ((R.ci + within) / Math.max(1, b.total)) * 100;
    }
    R.lastWithin = within;
    $('#r-bar').style.width = clamp(overall, 0, 100) + '%';
    $('#r-pct').textContent = Math.round(clamp(overall, 0, 100)) + '%';
    if (!reset) {
      clearTimeout(R.saveT);
      R.saveT = setTimeout(() => {
        if (R.book) setProgress(R.book.id, R.ci, R.title, within);
      }, 1200);
    }
  }

  /* ---------------- 沉浸阅读（手机）：顶/底栏滑出，点中间唤出 ---------------- */

  /** 阅读区高度变了（顶/底栏滑入滑出、转屏）后，按原比例落回对应页重新排版 */
  function relayoutPagedKeepPage() {
    if (!R.book || S.state.settings.pageMode !== 'paged') return;
    const before = R.pages.length;
    const ratio = before > 1 ? R.page / (before - 1) : 0;
    R.noAnim = true;                     // 重排不是翻页，别连播两次翻页动画
    try {
      pagedKey = '';                     // 强制按新尺寸重排
      renderChapter(0);
      if (before > 1 && R.pages.length > 1) {
        R.page = clamp(Math.round(ratio * (R.pages.length - 1)), 0, R.pages.length - 1);
        renderChapter(0);
      }
    } finally { R.noAnim = false; }
    updateProgress(true);
  }

  function toggleReaderBars() {
    const off = $('#reader').classList.toggle('bars-off');
    if (off) { clearTimeout(R.barsT); R.barsT = null; }
    else startBarsAutoHide();
    /* 顶/底栏从文档流里拿掉后阅读区高度会变，正文得跟着重排 */
    relayoutPagedKeepPage();
  }

  /** 唤出的工具栏几秒不碰就自动再藏回去，别让手机屏幕上常驻两块铁 */
  function startBarsAutoHide() {
    clearTimeout(R.barsT);
    if (!isAndroidApp()) return;
    R.barsT = setTimeout(() => {
      R.barsT = null;
      if (!$('#reader').classList.contains('open')) return;
      if ($('#r-toc-panel').classList.contains('open')) return;
      $('#reader').classList.add('bars-off');
      relayoutPagedKeepPage();
    }, 4500);
  }

  function turnPageOrChapter(d) {
    const s = S.state.settings;
    if (s.pageMode === 'paged') {
      const np = R.page + d;
      if (np >= 0 && np < R.pages.length) {
        R.page = np;
        renderChapter(d);
        updateProgress();
        updateTocActive();
        return;
      }
      if (np < 0) {
        if (R.ci > 0) { R.page = 99999; loadChapter(R.ci - 1, -1); }
        else toast('已经是第一章');
        return;
      }
      if (np >= R.pages.length) { if (R.ci < R.book.total - 1) { R.page = 0; loadChapter(R.ci + 1, 1); } else toast('已经是最后一章'); return; }
    } else {
      if (d > 0) {
        if (R.ci < (R.book.total || 1) - 1) loadChapter(R.ci + 1, 1);
        else toast('已经是最后一章');
      } else {
        if (R.ci > 0) loadChapter(R.ci - 1, -1);
        else toast('已经是第一章');
      }
    }
  }

  function buildToc() {
    const b = R.book;
    const list = b.chapters || [];
    $('#toc-count').textContent = `共 ${list.length} 章`;
    $('#toc-list').innerHTML = list.map((c, i) => {
      const title = typeof c === 'string' ? c : c.title;
      return `<div class="toc-item ${i === R.ci ? 'on' : ''}" data-ci="${i}"><span>${i + 1}</span>${esc(title)}</div>`;
    }).join('');
    R.tocOn = null;                       // 列表重建了，旧的「当前项」引用作废
    $$('#toc-list .toc-item').forEach(el => el.onclick = () => {
      R.page = 0;
      loadChapter(+el.dataset.ci, 0);
      $('#r-toc-panel').classList.remove('open');
      $('#toc-mask').classList.remove('on');
    });
    updateTocActive();
  }
  function updateTocActive() {
    /* 每次翻页都会调这里。目录没开时整章几百个条目挨个 toggle 纯属白烧 CPU
       （老实现还会对当前项 scrollIntoView，等于每翻一页逼一次排版），
       目录打开时 buildToc 会重新标一次，所以这里直接返回。 */
    if (!$('#r-toc-panel').classList.contains('open')) return;
    if (R.tocOn && R.tocOn.isConnected) R.tocOn.classList.remove('on');
    const on = document.querySelector(`#toc-list .toc-item[data-ci="${R.ci}"]`);
    if (!on) { R.tocOn = null; return; }
    on.classList.add('on');
    R.tocOn = on;
    on.scrollIntoView({ block: 'center' });
  }

  function setTheme(t) {
    S.state.settings.theme = t;
    $('#reader').dataset.theme = t;
    $$('#r-swatches .sw').forEach(el => el.classList.toggle('on', el.dataset.t === t));
    save();
  }

  /* ---------------- 书签 ---------------- */
  function addBookmark() {
    const b = R.book;
    if (!b) return;
    const s = S.state.settings;
    let pct = 0, text = '';
    if (s.pageMode === 'paged') {
      pct = R.pages.length > 1 ? R.page / (R.pages.length - 1) : 0;
      text = (R.pages[R.page] || [''])[0].slice(0, 60);
    } else {
      const stage = $('#r-stage');
      const max = stage.scrollHeight - stage.clientHeight;
      pct = max > 10 ? stage.scrollTop / max : 0;
      text = (R.paras[0] || '').slice(0, 60);
    }
    const exist = S.state.bookmarks.find(x => x.bookId === b.id && x.ci === R.ci);
    if (exist) { toast('这一章已经加过书签了'); return; }
    S.state.bookmarks.unshift({
      id: uid('B'), bookId: b.id, name: b.name, ci: R.ci, title: R.title, pct, text, at: Date.now()
    });
    save(true);
    toast('已添加书签');
    $('#r-bookmark').classList.add('on');
    setTimeout(() => $('#r-bookmark').classList.remove('on'), 800);
  }

  /* ---------------- 朗读（TTS） ---------------- */
  let ttsQueue = null;
  function ttsCfg() {
    const s = S.state.settings;
    if (!s.tts) s.tts = { voiceURI: '', rate: 1, pitch: 1, autoNext: true };
    return s.tts;
  }
  function ttsVoices() {
    try { return window.speechSynthesis ? window.speechSynthesis.getVoices() : []; } catch (e) { return []; }
  }
  function ttsOrderedVoices() {
    const all = ttsVoices();
    const zh = all.filter(v => /^zh|Chinese|Xiaoxiao|Yunxi|Yunyang|Huihui|Kangkang|Yaoyao|Tingting/i.test((v.lang || '') + ' ' + (v.name || '')));
    const rest = all.filter(v => !zh.includes(v));
    return zh.concat(rest);
  }

  function stopTTS() {
    R.tts = false;
    if (window.speechSynthesis) window.speechSynthesis.cancel();
    $$('.page .body p').forEach(p => { p.style.background = ''; p.style.borderRadius = ''; });
    const btn = $('#r-tts');
    if (btn) {
      btn.classList.remove('on');
      btn.innerHTML = `<svg viewBox="0 0 24 24"><path d="M11 5L6 9H3v6h3l5 4z"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/></svg>朗读`;
    }
    if (ttsQueue) { clearTimeout(ttsQueue); ttsQueue = null; }
  }

  /** 把一个段落切成不超长的语音片段（有些引擎对超长文本会静音） */
  function splitSpeech(text) {
    const s = String(text || '').replace(/\s+/g, ' ').trim();
    if (!s) return [];
    if (s.length <= 150) return [s];
    const out = [];
    let buf = '';
    for (const part of s.split(/(?<=[。！？!?；;])/)) {
      if ((buf + part).length > 150 && buf) { out.push(buf); buf = part; }
      else buf += part;
    }
    if (buf) out.push(buf);
    return out;
  }

  function startTTS(fromPara) {
    if (!window.speechSynthesis) return toast('当前环境不支持语音朗读');
    const synth = window.speechSynthesis;
    const cfg = ttsCfg();
    /* 连续滚动时缓冲区里可能已接上后面几章：朗读只圈定当前章的段落，
       不然会把下一章一起读进队列；同时记下「朗读所属章」，章末按它推进，
       用户手动滚走导致 R.ci 提前变化也不会跳章 */
    const scope = $(`.page .ch-sec[data-ci="${R.ci}"]`) || document;
    const ps = $$('.page .body p', scope);
    if (!ps.length) return;

    const voices = ttsOrderedVoices();
    const voice = voices.find(v => v.voiceURI === cfg.voiceURI) || voices[0] || null;
    if (!voices.length) toast('没检测到系统语音，会使用默认发音（可在「设置 → 朗读」查看）');

    const parts = [];
    ps.forEach((p, i) => splitSpeech(p.textContent).forEach(t => parts.push({ pi: i, text: t })));
    if (!parts.length) return;

    const startIdx = parts.findIndex(x => x.pi === (fromPara || 0));
    R.tts = true;
    R.ttsCi = R.ci;
    R.ttsIdx = startIdx < 0 ? 0 : startIdx;
    R.ttsParts = parts;
    R.ttsPs = ps;
    const btn = $('#r-tts');
    btn.classList.add('on');
    btn.innerHTML = '停止';

    const speakNext = () => {
      if (!R.tts) return;
      if (R.ttsIdx >= parts.length) {
        const nx = (R.ttsCi != null ? R.ttsCi : R.ci) + 1;
        if (cfg.autoNext && nx < (R.book.total || 1)) {
          R.page = 0;
          loadChapter(nx, 1).then(() => { R.tts = false; startTTS(0); });
        } else { stopTTS(); toast('本章读完'); }
        return;
      }
      const item = parts[R.ttsIdx];
      const p = ps[item.pi];
      ps.forEach(x => { x.style.background = ''; });
      if (p) {
        p.style.background = 'rgba(43,108,224,.10)';
        p.style.borderRadius = '4px';
        p.scrollIntoView({ block: 'center', behavior: 'smooth' });
      }
      const u = new SpeechSynthesisUtterance(item.text);
      u.lang = (voice && voice.lang) || 'zh-CN';
      if (voice) u.voice = voice;
      u.rate = clamp(Number(cfg.rate) || 1, 0.5, 2);
      u.pitch = clamp(Number(cfg.pitch) || 1, 0.5, 1.5);
      u.volume = 1;
      u.onend = () => { R.ttsIdx++; speakNext(); };
      u.onerror = e => {
        if (e && e.error === 'interrupted') return; // 用户手动停止
        /* 引擎根本没有可用音色（没装 TTS / 还在初始化）：不要再往下轮，
           否则每一段都立刻报错，几百毫秒就把整章「读完」了，看着像朗读自己跑飞了。 */
        if (e && (e.error === 'native' || e.message)) {
          R.tts = false; clearTimeout(ttsQueue);
          stopTTS();
          return toast(e.message ? '朗读失败：' + e.message : '朗读失败：语音引擎不可用', 5200);
        }
        R.ttsIdx++;
        ttsQueue = setTimeout(speakNext, 120);
      };
      synth.speak(u);
    };
    synth.cancel();
    setTimeout(speakNext, 60);
  }

  function ttsPanel() {
    const cfg = ttsCfg();
    const voices = ttsOrderedVoices();
    openModal(`<h3>朗读设置</h3>
      <p class="desc">${IS_ANDROID
        ? '音色来自手机自带的语音引擎，中文语音一般在「设置 → 系统 → 语言和输入法 → 文字转语音」里管理。'
        : '音色来自 Windows 自带的语音引擎。系统里装过其他语言包的语音也会出现在列表里。'}</p>
      <div class="form-grid">
        <div class="field full"><label>音色 <span>共 ${voices.length} 个</span></label>
          <select id="tts-voice">
            ${voices.length
              ? `<option value="">跟随系统默认</option>` + voices.map(v => `<option value="${esc(v.voiceURI)}" ${cfg.voiceURI === v.voiceURI ? 'selected' : ''}>${esc(v.name)} · ${esc(v.lang)}${v.localService ? '' : ' · 在线'}</option>`).join('')
              : `<option value="">${IS_ANDROID
                ? '（没检测到语音引擎，可在系统设置里装一个文字转语音引擎）'
                : '（没有检测到语音，可用系统「设置 → 时间和语言 → 语音」添加）'}</option>`}
          </select></div>
        <div class="field"><label>语速 <span id="tts-rate-v">${(cfg.rate || 1).toFixed(1)}x</span></label>
          <input type="range" id="tts-rate" min="50" max="200" step="5" value="${Math.round((cfg.rate || 1) * 100)}" /></div>
        <div class="field"><label>音调 <span id="tts-pitch-v">${(cfg.pitch || 1).toFixed(1)}</span></label>
          <input type="range" id="tts-pitch" min="50" max="150" step="5" value="${Math.round((cfg.pitch || 1) * 100)}" /></div>
        <div class="field"><label>读完自动下一章</label>
          <select id="tts-next"><option value="1" ${cfg.autoNext ? 'selected' : ''}>开启</option><option value="0" ${!cfg.autoNext ? 'selected' : ''}>关闭</option></select></div>
      </div>
      <div class="modal-actions">
        <button class="btn left" id="tts-test">试听</button>
        <button class="btn" onclick="window.__closeModal()">取消</button>
        <button class="btn primary" id="tts-save">保存</button>
      </div>`);
    $('#tts-rate').oninput = e => { $('#tts-rate-v').textContent = (e.target.value / 100).toFixed(1) + 'x'; };
    $('#tts-pitch').oninput = e => { $('#tts-pitch-v').textContent = (e.target.value / 100).toFixed(1); };
    $('#tts-test').onclick = () => {
      const v = ttsOrderedVoices().find(x => x.voiceURI === ($('#tts-voice').value)) || ttsOrderedVoices()[0];
      const u = new SpeechSynthesisUtterance('山间的雾还没散，他把书翻到下一页，听见远处有人唤他的名。');
      if (v) u.voice = v;
      u.lang = (v && v.lang) || 'zh-CN';
      u.rate = clamp($('#tts-rate').value / 100, .5, 2);
      u.pitch = clamp($('#tts-pitch').value / 100, .5, 1.5);
      window.speechSynthesis.cancel();
      window.speechSynthesis.speak(u);
    };
    $('#tts-save').onclick = () => {
      cfg.voiceURI = $('#tts-voice').value;
      cfg.rate = $('#tts-rate').value / 100;
      cfg.pitch = $('#tts-pitch').value / 100;
      cfg.autoNext = $('#tts-next').value === '1';
      save(true); closeModal(); toast('朗读设置已保存');
    };
  }

  function ttsCurrentLabel() {
    const cfg = ttsCfg();
    const v = ttsOrderedVoices().find(x => x.voiceURI === cfg.voiceURI);
    const name = v ? v.name + ' · ' + v.lang : (ttsVoices().length ? '跟随系统默认' : '系统未检测到语音');
    return `${name} · ${(cfg.rate || 1).toFixed(1)}x`;
  }

  /* ---------------- 换源 ---------------- */
  function normChapTitle(t) {
    return String(t || '').replace(/^\s*(第\s*[0-9一二三四五六七八九十百千零两]+\s*[章节回卷话集篇部]\s*)/, '')
      .replace(/[\s·、,，.。:：\-—_()（）\[\]【】]/g, '').toLowerCase();
  }

  async function switchSource() {
    const b = R.book || (S.state.books.find(x => x.id === S.switchBookId));
    if (!b) return;
    /* 检测为「无用」的源直接跳过：换源本来就慢，不要把时间浪费在打不开的站上 */
    const enabled = S.state.sources.filter(s => s.enabled && s.searchUrl);
    const alive = enabled.length > 8 ? enabled.filter(s => s.quality !== 'dead') : enabled;
    const all = alive.length ? alive : enabled;
    if (!all.length) { toast('没有启用的网络书源，先去「书源」里启用'); return; }
    // 书源可能有几千个，全量搜太慢：按「优质 > 有效 > 书架在用」优先取一批
    const cap = clamp(S.state.settings.searchLimit || 40, 1, 500);
    const srcs = pickSearchSources(all, cap);
    const skipped = enabled.length - all.length;

    openModal(`<h3>换源 · ${esc(b.name)}</h3>
      <p class="desc">在 ${srcs.length} 个书源里找同名书（共启用 ${enabled.length} 个${skipped > 0 ? `，已跳过 ${skipped} 个检测为「无用」的源` : ''}）${srcs.length < all.length ? '，可在设置里调整上限' : ''}。<br>当前读到：${esc(R.title || '未开始')}（第 ${(R.ci || 0) + 1} 章）</p>
      <div class="sw-list" id="sw-list"><div class="hint">搜索中…</div></div>
      <div class="modal-actions"><button class="btn" onclick="window.__closeModal()">关闭</button></div>`, true);

    const hits = [];
    const kw = b.name;
    const limit = clamp(Math.max(S.state.settings.maxConcurrent || 3, 4), 1, 8);
    let cursor = 0;
    const worker = async () => {
      while (cursor < srcs.length) {
        if (hits.length >= 12) return; // 够用了就别再扫，省时间
        const s = srcs[cursor++];
        try {
          const r = await withTimeout(Engine.search(mo.net, s, kw), 8000);
          for (const x of r) {
            const a = normChapTitle(x.name), t = normChapTitle(kw);
            if (a === t || a.includes(t) || t.includes(a)) hits.push(x);
          }
        } catch (e) { /* 单个源失败不影响其他 */ }
        paintSwitch(hits, b);
      }
    };
    await Promise.all(Array.from({ length: limit }, worker));
    paintSwitch(hits, b, true);
  }

  function paintSwitch(hits, b, done) {
    const box = $('#sw-list');
    if (!box) return;
    if (!hits.length) {
      box.innerHTML = done ? `<div class="hint">没有找到同名书。换个关键词，或去「网页」里手动找。</div>` : `<div class="hint">搜索中…</div>`;
      return;
    }
    box.innerHTML = hits.slice(0, 40).map((r, i) => `
      <div class="sw-item ${r.sourceId === b.sourceId ? 'cur' : ''}">
        <div class="sw-ico">${esc((r.sourceName || '源')[0])}</div>
        <div class="sw-body">
          <div class="sw-t">${esc(r.name)}<span class="chip">${esc(r.sourceName || '')}</span>${r.sourceId === b.sourceId ? '<span class="chip on">当前源</span>' : ''}</div>
          <div class="sw-s">${esc(r.author || '佚名')}${r.lastChapter ? ' · ' + esc(r.lastChapter) : ''}</div>
        </div>
        <button class="btn sm ${r.sourceId === b.sourceId ? '' : 'primary'}" data-sw="${i}" ${r.sourceId === b.sourceId ? 'disabled' : ''}>切到这本</button>
      </div>`).join('') + (done ? '' : `<div class="hint">继续搜索中…</div>`);
    $$('[data-sw]').forEach(el => el.onclick = () => applySwitch(hits[+el.dataset.sw], el));
  }

  async function applySwitch(r, btn) {
    const b = R.book;
    if (!b) return;
    const src = sourceById(r.sourceId);
    if (!src) return toast('书源不存在');
    /* 只锁被点的那一个：以前用 $('[data-sw]') 取到的是列表首个按钮，
       点第 3 本失败时变灰的是第 1 本，看着像「点了没反应」 */
    const label = btn ? btn.textContent : '';
    const busy = on => { if (!btn) return; btn.disabled = on; btn.textContent = on ? '切换中…' : label; };
    busy(true);
    toast('正在获取新源目录…');
    let toc;
    try {
      toc = await withTimeout(Engine.getToc(mo.net, src, r.bookUrl), 30000);
    } catch (e) {
      busy(false);
      return toast('换源失败：' + (e.message || e));
    }
    if (!toc.chapters.length) { busy(false); return toast('这个源没有目录，换一个试试'); }

    const curTitle = R.title || '';
    const curNorm = normChapTitle(curTitle);
    let idx = toc.chapters.findIndex(c => normChapTitle(c.title) === curNorm);
    if (idx < 0) idx = toc.chapters.findIndex(c => normChapTitle(c.title).includes(curNorm) && curNorm.length > 1);
    if (idx < 0) idx = clamp(R.ci, 0, toc.chapters.length - 1);

    b.sourceId = r.sourceId;
    b.sourceName = src.name;
    b.bookUrl = r.bookUrl;
    b.chapters = toc.chapters;
    b.total = toc.chapters.length;
    b.updatedAt = Date.now();
    if (r.coverUrl) b.cover = r.coverUrl;
    if (toc.info.intro && !b.intro) b.intro = toc.info.intro;
    await mo.cache.clear(b.id);
    save(true);
    closeModal();
    renderShelf();          // 书架卡片上的来源名 / 进度跟着换，不然回到书架像没换成
    R.chapters = b.chapters;
    R.ci = idx;
    buildToc();
    if (R.book) await loadChapter(idx, 0);
    toast(`已换到「${src.name}」，定位到 ${toc.chapters[idx].title.slice(0, 20)}`);
  }


  /* ---------------- 绑定阅读器 ---------------- */
  /* ---------------- 全屏 ---------------- */
  async function toggleFullscreen() {
    const on = await mo.win.fullscreen();
    syncFullscreen(!!on);
  }
  function syncFullscreen(on) {
    document.body.classList.toggle('is-full', !!on);
    const btn = $('#r-full');
    if (btn) {
      btn.classList.toggle('on', !!on);
      btn.title = on ? '退出全屏 (F11)' : '全屏 (F11)';
    }
    if (R.book && S.state.settings.pageMode === 'paged') { R.page = 0; renderChapter(0); }
  }

  function bindReader() {
    $('#r-back').onclick = closeReader;
    $('#r-close').onclick = closeReader;
    $('#r-full').onclick = toggleFullscreen;
    if (mo.win.onState) mo.win.onState(s => { if (s && typeof s.fullscreen === 'boolean') syncFullscreen(s.fullscreen); });
    // 包一层 Promise.resolve：就算哪天 isFull 返回的不是 Promise，也只丢一个全屏状态，
    // 不会在模块顶层抛异常把后面所有绑定（含 bindAndroid / boot）全部带走
    Promise.resolve(mo.win.isFull()).then(v => syncFullscreen(!!v)).catch(() => {});
    $('#r-prev').onclick = () => turnPageOrChapter(-1);
    $('#r-next').onclick = () => turnPageOrChapter(1);

    $('#r-fs-up').onclick = () => {
      S.state.settings.fontSize = clamp(S.state.settings.fontSize + 1, 15, 30);
      applyReaderStyle(); if (R.paras.length) renderChapter(0); save();
    };
    $('#r-fs-down').onclick = () => {
      S.state.settings.fontSize = clamp(S.state.settings.fontSize - 1, 15, 30);
      applyReaderStyle(); if (R.paras.length) renderChapter(0); save();
    };
    $('#r-mode').onclick = () => {
      const s = S.state.settings;
      s.pageMode = s.pageMode === 'paged' ? 'scroll' : 'paged';
      R.page = 0; renderChapter(0); save();
    };
    $('#r-font').onclick = () => {
      const s = S.state.settings;
      s.fontFamily = s.fontFamily === 'serif' ? 'sans' : 'serif';
      renderChapter(0); save();
    };
    $('#r-toc').onclick = () => {
      const open = $('#r-toc-panel').classList.toggle('open');
      $('#toc-mask').classList.toggle('on', open);
      if (open) buildToc();
    };
    $('#toc-mask').onclick = () => {
      $('#r-toc-panel').classList.remove('open');
      $('#toc-mask').classList.remove('on');
    };
    $$('#r-swatches .sw').forEach(el => el.onclick = () => setTheme(el.dataset.t));
    $('#r-bookmark').onclick = addBookmark;
    $('#r-tts').onclick = () => { if (R.tts) stopTTS(); else startTTS(0); };
    $('#r-tts-set').onclick = ttsPanel;
    $('#r-switch').onclick = () => switchSource();
    const stageEl = $('#r-stage');
    const isPaged = () => S.state.settings.pageMode === 'paged';
    /* 触摸滑动翻页后浏览器还会补一个 click，别让它再翻一页 */
    let swipedAt = 0;

    let updQ = false;
    stageEl.addEventListener('scroll', () => {
      /* 滚动模式一甩就是几十个 scroll 事件，逐个读 scrollHeight 很伤：
         收拢到每一帧只更新一次进度 */
      if (updQ) return;
      updQ = true;
      requestAnimationFrame(() => { updQ = false; updateProgress(); maybeContinueScroll(); });
    });
    stageEl.addEventListener('click', e => {
      /* 只在「点到正文」时才算翻页手势。这里绝不能写成 closest('p') —— 正文铺满了整个屏幕，
         那样等于把左右两侧的翻页热区全废掉，手指怎么点都没反应（桌面合成事件 target 是容器，
         所以自动化测试反而看不出来）。按钮/目录/底栏这些可交互元素仍然排除。 */
      if (e.target.closest('a,button,input,textarea,select,.toc,.rb-btn')) return;
      /* 有选中的文字（长按选词 / 拖动选择）时不翻页。这里直接看当前选区，
         不要用「touchstart 时记一个标记」那种写法：鼠标点击、脚本点击不会触发
         touchstart，标记会一直残留，把下一次点击吃掉。 */
      const sel = window.getSelection();
      if (sel && !sel.isCollapsed && String(sel).trim().length > 0) return;
      if (Date.now() - swipedAt < 450) return;
      const r = stageEl.getBoundingClientRect();
      const x = e.clientX - r.left;
      /* 手机沉浸阅读：点中间唤出/收起工具栏（滚动模式没有页，整个区域都算中间）；
         左右热区仍翻页。桌面行为不变。 */
      if (isAndroidApp()) {
        if (!isPaged()) { toggleReaderBars(); return; }
        if (x >= zoneOf(r) && x <= r.width - zoneOf(r)) { toggleReaderBars(); return; }
      }
      if (!isPaged()) return;
      // 点击左右两侧翻页：热区随阅读区宽度自适应，手机上约占 2/9 屏宽
      if (x < zoneOf(r)) turnPageOrChapter(-1);
      else if (x > r.width - zoneOf(r)) turnPageOrChapter(1);
      function zoneOf(rect) { return Math.max(56, Math.min(130, rect.width * 0.22)); }
    });

    /* 桌面：滚轮（含触控板）翻页，带节流免得惯性一下翻好几页 */
    let wheelAt = 0;
    stageEl.addEventListener('wheel', e => {
      if (!isPaged()) return;                       // 滚动模式交回浏览器原生滚动
      e.preventDefault();
      const d = Math.abs(e.deltaY) >= Math.abs(e.deltaX) ? e.deltaY : e.deltaX;
      if (!d) return;
      if (Date.now() - wheelAt < 170) return;
      wheelAt = Date.now();
      turnPageOrChapter(d > 0 ? 1 : -1);
    }, { passive: false });

    /* 触摸：横向轻扫翻页。竖向滑动不拦，留给手指做别的（如滚动目录） */
    let tX = 0, tY = 0, tT = 0, tracking = false;
    stageEl.addEventListener('touchstart', e => {
      if (!isPaged() || e.touches.length !== 1) { tracking = false; return; }
      tracking = true;
      tX = e.touches[0].clientX; tY = e.touches[0].clientY; tT = Date.now();
    }, { passive: true });
    stageEl.addEventListener('touchend', e => {
      if (!tracking) return;
      tracking = false;
      if (!isPaged() || !e.changedTouches.length) return;
      const t = e.changedTouches[0];
      const dx = t.clientX - tX, dy = t.clientY - tY;
      if (Date.now() - tT > 900) return;                              // 长按不算滑动
      if (Math.abs(dx) < 42 || Math.abs(dx) < Math.abs(dy) * 1.4) return; // 竖直滑动忽略
      swipedAt = Date.now();
      turnPageOrChapter(dx < 0 ? 1 : -1);                             // 左滑看下一页
    }, { passive: true });

    /* 窗口尺寸 / 横竖屏变化：重排后按原进度比例落到对应页，而不是跳回本章第 1 页 */
    let rzT = 0;
    window.addEventListener('resize', () => {
      if (!R.book) return;
      clearTimeout(rzT);
      rzT = setTimeout(() => relayoutPagedKeepPage(), 120);
    });

    /* 碰了顶/底栏就重置自动隐藏计时，别看着看着字被收走 */
    ['.reader-top', '.reader-bot'].forEach(sel => {
      const el = document.querySelector('#reader ' + sel);
      if (el) el.addEventListener('pointerdown', () => {
        if (!$('#reader').classList.contains('bars-off')) startBarsAutoHide();
      });
    });
  }

  /* ---------------- 全局快捷键 ---------------- */
  function bindKeys() {
    document.addEventListener('keydown', e => {
      const reading = $('#reader').classList.contains('open');
      const typing = /INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName);

      if (!reading) {
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') { e.preventDefault(); setView('search'); setTimeout(() => $('#search-input')?.focus(), 50); }
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'o') { e.preventDefault(); importBooks(); }
        if (e.key === 'Escape' && $('#modal').classList.contains('open')) closeModal();
        return;
      }
      if (typing) return;
      switch (e.key) {
        case 'F11': e.preventDefault(); toggleFullscreen(); break;
        case 'f': case 'F': e.preventDefault(); toggleFullscreen(); break;
        case 'ArrowLeft': case 'PageUp': e.preventDefault(); turnPageOrChapter(-1); break;
        case 'ArrowRight': case 'PageDown': e.preventDefault(); turnPageOrChapter(1); break;
        case 'ArrowUp': if (S.state.settings.pageMode === 'scroll') { $('#r-stage').scrollBy({ top: -260, behavior: 'smooth' }); e.preventDefault(); } break;
        case 'ArrowDown': if (S.state.settings.pageMode === 'scroll') { $('#r-stage').scrollBy({ top: 260, behavior: 'smooth' }); e.preventDefault(); } break;
        case ' ':                                    // 空格：分页模式下翻页，滚动模式翻屏
          if (typing) break;
          e.preventDefault();
          if (S.state.settings.pageMode === 'paged') turnPageOrChapter(e.shiftKey ? -1 : 1);
          else $('#r-stage').scrollBy({ top: e.shiftKey ? -window.innerHeight * 0.85 : window.innerHeight * 0.85, behavior: 'smooth' });
          break;
        case '+': case '=': $('#r-fs-up').click(); break;
        case '-': $('#r-fs-down').click(); break;
        case 't': case 'T': {
          const order = ['paper', 'sepia', 'green', 'night'];
          setTheme(order[(order.indexOf(S.state.settings.theme) + 1) % order.length]);
          break;
        }
        case 'c': case 'C': $('#r-toc').click(); break;
        case 'b': case 'B': addBookmark(); break;
        case 'Escape':
          if ($('#r-toc-panel').classList.contains('open')) { $('#toc-mask').click(); }
          else if (document.body.classList.contains('is-full')) { toggleFullscreen(); }
          else closeReader();
          break;
      }
    });
  }

  /* ===========================================================
     安卓适配：返回键层级 / 横竖屏切换 / 外部打开文件
     =========================================================== */

  /** 摘掉桌面端专属的界面元素，并保证「这是移动布局」的标记一定在。
   *  多处调用（nodebundle 早期、这里、以及布局回调），任何一处生效即可。 */
  function stripDesktopChrome() {
    try {
      const de = document.documentElement;
      de.classList.add('is-android');
      if (!de.getAttribute('data-layout')) de.setAttribute('data-layout', 'portrait');
      document.querySelectorAll('.winbtns, .dropzone').forEach(el => {
        if (el && el.parentNode) el.parentNode.removeChild(el);
      });
      // 兜底：就算 DOM 摘不掉，也用行内样式压住，绝不让关闭按钮露出来
      document.querySelectorAll('.winbtns').forEach(el => { el.style.setProperty('display', 'none', 'important'); });
      /* 安卓本来就是全屏应用，阅读器里的「全屏(F11)」按钮毫无意义——藏掉。
         用户反馈：界面上还残留着电脑才有的「关闭全屏」这类功能。 */
      document.querySelectorAll('#r-full').forEach(el => {
        el.style.setProperty('display', 'none', 'important');
      });
      /* 「书架」和「✕」在手机上是一回事（都是退出阅读器），留文字更明确的那个 */
      document.querySelectorAll('#r-close').forEach(el => {
        el.style.setProperty('display', 'none', 'important');
      });
    } catch (e) { /* ignore */ }
  }

  function bindAndroid() {
    if (!IS_ANDROID) return;

    /* 桌面 Electron 的自绘窗口按钮（最小化/最大化/关闭）在安卓上没有任何意义，
       直接从 DOM 摘掉；同时确保布局标记在——后面任何一步出问题也不会退回电脑版界面 */
    stripDesktopChrome();

    /* 返回键：弹窗 → 目录抽屉 → 阅读器 → 网页后退 → 回书架 → 系统（再按一次退出）
       网页搜书里直接跳书架曾让人很懵：用户在小说站里一层层点进去，
       按返回自然期望「退回上一页」，而不是整个视图被抽掉 */
    window.__moreadOnBack = () => {
      if ($('#modal').classList.contains('open')) { closeModal(); return true; }
      if ($('#reader').classList.contains('open')) {
        if ($('#r-toc-panel').classList.contains('open')) { $('#toc-mask').click(); return true; }
        closeReader();
        return true;
      }
      if (S.view === 'web' && isAndroidApp()) {
        /* 有浏览历史就退一步，没有历史但在看某个页面就先回到搜书首页 */
        if (WA.stack.length || WA.lastUrl) {
          const wb = $('#wa-back');
          if (wb) { wb.click(); return true; }
        }
        setView('shelf');
        return true;
      }
      if (S.view !== 'shelf') { setView('shelf'); return true; }
      return false;
    };

    /* 阅读时保持屏幕常亮，退出阅读自动恢复 */
    const readerEl = $('#reader');
    const keepLite = on => { try { window.MoNative.call('ui.keepScreenOn', { on: !!on }); } catch (e) { /* ignore */ } };
    new MutationObserver(() => keepLite(readerEl.classList.contains('open')))
      .observe(readerEl, { attributes: true, attributeFilter: ['class'] });

    /* 在别的应用里用「墨读」打开 txt / epub / 备份 zip */
    window.addEventListener('moread:openfile', async e => {
      const p = (e && e.detail) || {};
      if (!p.path) return;
      try {
        if (/\.zip$/i.test(p.name || '')) {
          const r = await mo.testImportZip(p.path);
          if (!r.ok) return toast(r.error || '无法识别这个备份');
          setView('settings');
          showRestoreConfirm(r);
        } else if (/\.json$/i.test(p.name || '')) {
          const r = await mo.pickZip ? null : null;
          void r;
          toast('书源 JSON 请在「书源 → 导入」里选择');
        } else {
          const out = await mo.importLocal([p.path]);
          const okCount = (out || []).filter(x => x && !x.error).length;
          const err = (out || []).find(x => x && x.error);
          await boot();
          renderShelf();
          setView('shelf');
          toast(okCount ? `已导入 ${okCount} 本` : ('导入失败：' + (err && err.error || '不支持的文件')));
        }
      } catch (err) {
        toast('打开失败：' + (err.message || err));
      }
    });
  }

  /* ---------------- 启动 ---------------- */
  if (mo.testMode) {
    window.__t = {
      addWebBook, srcForBook, switchSource, applyLegado, addOnlineBook,
      setView, renderShelf, get state() { return S.state; },
      get reader() { return R; },
      openReader, loadChapter, runSearch, ttsVoices, ttsOrderedVoices, pickSearchSources
    };
  }
  // 逐个隔离：任何一步出错只丢它自己的功能，绝不能把整个 app.js 的初始化带走。
  // （踩过：bindReader 里一行抛异常 → 后面的 bindAndroid / boot 全没跑 →
  //   界面画出来了但所有按钮都是死的，而且没有任何可见报错）
  try { bindReader(); } catch (e) { console.error('bindReader 失败：', e); }
  try { bindAndroid(); } catch (e) { console.error('bindAndroid 失败：', e); }
  boot().catch(e => {
    console.error(e);
    // 用浮层而不是清空 body：界面还在，用户至少能看清出了什么事
    try {
      const d = document.createElement('div');
      d.style.cssText = 'position:fixed;z-index:99999;left:0;right:0;top:0;padding:14px 16px;' +
        'background:#b3261e;color:#fff;font:14px/1.6 system-ui;';
      d.textContent = '启动失败：' + esc(e.message || e);
      document.body.appendChild(d);
    } catch (_) { }
  });
})();
