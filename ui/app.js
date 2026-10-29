/* ===========================================================
   墨读 · 主逻辑
   =========================================================== */
(function () {
  'use strict';
  const mo = window.mo;
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];

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
  function toast(msg) {
    const t = $('#toast');
    t.textContent = msg;
    t.classList.add('on');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('on'), 2400);
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
    const run = () => mo.state.set(S.state).catch(e => console.error(e));
    if (now) run(); else saveTimer = setTimeout(run, 700);
  }

  async function boot() {
    S.info = await mo.info();
    S.state = await mo.state.get();
    applySettings();
    bindChrome();
    bindNav();
    renderShelf();
    setView('shelf');

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
    $('#btn-min').onclick = () => mo.win.minimize();
    $('#btn-max').onclick = () => mo.win.maximize();
    $('#btn-close').onclick = () => mo.win.close();
    $('#titlebar').addEventListener('dblclick', e => {
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
    const results = await mo.importLocal(paths);
    let ok = 0;
    for (const r of results) {
      if (r.error) { toast(r.error); continue; }
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
      ok++;
    }
    save(true);
    renderShelf();
    toast(ok ? `已导入 ${ok} 本` : '没有可导入的文件');
  }

  function bindDropZone() {
    const dz = $('#dropzone');
    let depth = 0;
    window.addEventListener('dragenter', e => { e.preventDefault(); depth++; dz.classList.add('on'); });
    window.addEventListener('dragover', e => e.preventDefault());
    window.addEventListener('dragleave', () => { if (--depth <= 0) { depth = 0; dz.classList.remove('on'); } });
    window.addEventListener('drop', async e => {
      e.preventDefault(); depth = 0; dz.classList.remove('on');
      const files = [...(e.dataTransfer.files || [])].map(f => f.path).filter(Boolean);
      if (files.length) doImport(files);
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
    }).join('') || `<div class="empty" style="grid-column:1/-1">书架还是空的。<br>拖入 TXT / EPUB，或去「书源」搜索网络小说。</div>`;

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
    const tier = s => (used.has(s.id) ? 0 : (s.lastCount > 0 ? 1 : (s.lastError ? 3 : 2)));
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
          const r = await Engine.search(mo.net, s, kw);
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

  function srcFiltered() {
    const q = (S.srcQ || '').trim().toLowerCase();
    return S.state.sources.filter(s => {
      if (S.srcG && S.srcG !== 'all' && (s.group || '未分组') !== S.srcG) return false;
      if (S.srcE === 'on' && !s.enabled) return false;
      if (S.srcE === 'off' && s.enabled) return false;
      if (S.srcE === 'err' && !s.lastError) return false;
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
    const pages = Math.max(1, Math.ceil(list.length / SRC_PAGE_SIZE));
    S.srcPage = clamp(S.srcPage || 0, 0, pages - 1);
    const view = list.slice(S.srcPage * SRC_PAGE_SIZE, (S.srcPage + 1) * SRC_PAGE_SIZE);

    v.innerHTML = `
      <div class="page-head">
        <h1>书源</h1>
        <span class="sub">${st.sources.length} 个 · ${onCount} 个已启用</span>
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
        <div class="tb-spacer"></div>
        <span class="tb-count">筛选出 ${list.length} 个</span>
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
        const r = await Engine.search(mo.net, s, '我的');
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
            <button data-v="paged" class="${s.pageMode === 'paged' ? 'on' : ''}">分页</button></div></div>
        </div>

        <div class="card">
          <h3>朗读 <span class="chip">Windows 系统语音</span></h3>
          <div class="row"><div class="rl">音色 / 语速 / 音调<small id="tts-cur">${esc(ttsCurrentLabel())}</small></div>
            <button class="btn sm" id="s-tts">设置</button></div>
          <div class="row"><div class="rl">读完自动下一章</div>
            <div class="switch ${s.tts.autoNext ? 'on' : ''}" id="s-tts-next"><i></i></div></div>
          <div class="row"><div class="rl">试听<small>读一小段，确认音色和语速</small></div>
            <button class="btn sm" id="s-tts-test">播放</button></div>
        </div>

        <div class="card">
          <h3>系统</h3>
          <div class="row"><div class="rl">关闭窗口时最小化到托盘<small>开启后点 × 不会退出程序</small></div>
            <div class="switch ${s.closeToTray ? 'on' : ''}" data-set="closeToTray"><i></i></div></div>
          <div class="row"><div class="rl">搜索并发数<small>同时请求的书源数量，过大容易被限流</small></div>
            <div class="seg" id="s-conc">${[1, 2, 3, 4, 6].map(n => `<button data-v="${n}" class="${s.maxConcurrent === n ? 'on' : ''}">${n}</button>`).join('')}</div></div>
          <div class="row"><div class="rl">每次搜索的书源数<small>书源太多（比如几千个）时只搜一部分，优先书架用到的</small></div>
            <div class="seg" id="s-slimit">${[20, 40, 80, 200].map(n => `<button data-v="${n}" class="${(s.searchLimit || 40) === n ? 'on' : ''}">${n}</button>`).join('')}</div></div>
          <div class="row"><div class="rl">阅读时自动预取下一章</div>
            <div class="switch ${s.autoCacheNext ? 'on' : ''}" data-set="autoCacheNext"><i></i></div></div>
          <div class="row"><div class="rl">数据目录<small>${esc(S.info.paths.root)}</small></div>
            <button class="link" id="open-dir">打开</button></div>
        </div>

        <div class="card">
          <h3>备份与恢复 <span class="chip">含 Legado 格式</span></h3>
          <div class="row"><div class="rl">导出备份 zip<small>内含 bookSource.json / bookshelf.json / bookmark.json，原版「阅读」可直接导入这个 zip</small></div>
            <button class="btn sm" id="bk-zip">导出</button></div>
          <div class="row"><div class="rl">完整备份（含本地书文件）<small>换电脑能完整还原，体积更大</small></div>
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
          <h3>快捷键</h3>
          <div class="row"><div class="rl">打开搜索</div><span><span class="kbd">Ctrl</span> + <span class="kbd">F</span></span></div>
          <div class="row"><div class="rl">导入本地书</div><span><span class="kbd">Ctrl</span> + <span class="kbd">O</span></span></div>
          <div class="row"><div class="rl">上一章 / 下一章</div><span><span class="kbd">←</span> <span class="kbd">→</span></span></div>
          <div class="row"><div class="rl">翻页（分页模式）</div><span><span class="kbd">PgUp</span> <span class="kbd">PgDn</span></span></div>
          <div class="row"><div class="rl">字号 / 主题 / 目录 / 书签</div><span><span class="kbd">+</span><span class="kbd">-</span><span class="kbd">T</span><span class="kbd">C</span><span class="kbd">B</span></span></div>
          <div class="row"><div class="rl">退出阅读</div><span class="kbd">Esc</span></div>
        </div>

        <div class="card" style="grid-column:1/-1">
          <h3>关于</h3>
          <div class="row"><div class="rl">版本<small>墨读 ${esc(S.info.version)} · Electron ${esc(S.info.electron)} · Node ${esc(S.info.node)}</small></div>
            <span class="rv">${S.info.portable ? '便携模式 · 数据在程序目录' : '数据只存本地'}</span></div>
          <div class="row"><div class="rl">数据位置<small>${esc(S.info.paths.root)}</small></div>
            <button class="link" id="open-dir2">打开</button></div>
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
      if (R.book) { $('#r-mode').textContent = s.pageMode === 'paged' ? '分页' : '滚动'; renderChapter(); }
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
    $('#open-dir').onclick = () => mo.openDir();
    $('#open-dir2').onclick = () => mo.openDir();
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
    if (!r.ok) { if (r.error) toast(r.error); return; }
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
      ${s.skippedLocal ? `<br><span style="color:#a33">另有 ${s.skippedLocal} 本原版本地书（手机上的文件路径），桌面端无法还原，已跳过</span>` : ''}</p>
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
      return toast('恢复完成');
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
    pages: [[]], page: 0, tts: false, ttsIdx: 0, timer: null, saveT: null, chars: 0
  };

  function applySettings() {
    const s = S.state.settings;
    $('#reader').dataset.theme = s.theme;
    $$('#r-swatches .sw').forEach(el => el.classList.toggle('on', el.dataset.t === s.theme));
    $('#r-mode').textContent = s.pageMode === 'paged' ? '分页' : '滚动';
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
    page.classList.toggle('nofamily', s.fontFamily !== 'serif');
    $('#reader').classList.toggle('mode-paged', s.pageMode === 'paged');
    $('#r-fs-num').textContent = s.fontSize;
    $('#r-font').textContent = s.fontFamily === 'serif' ? '宋体' : '黑体';
    $('#r-mode').textContent = s.pageMode === 'paged' ? '分页' : '滚动';
  }

  async function openReader(bookId, ci, pct) {
    const b = getBook(bookId);
    if (!b) return;
    R.book = b;
    R.chapters = b.chapters || [];
    R.ci = clamp(ci || 0, 0, Math.max(0, (b.total || 1) - 1));
    R.page = 0;
    $('#reader').classList.add('open');
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
      const stage = $('#r-stage');
      const max = stage.scrollHeight - stage.clientHeight;
      const pct = max > 10 ? stage.scrollTop / max : 1;
      setProgress(b.id, R.ci, R.title, pct);
    }
    stopTTS();
    clearInterval(R.timer);
    R.timer = null;
    $('#reader').classList.remove('open');
    R.book = null;
    save(true);
    renderShelf();
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
    if (R.tts) stopTTS();
    R.ci = clamp(ci, 0, Math.max(0, (b.total || 1) - 1));
    const loading = $('#r-loading');
    loading.textContent = '加载中…';
    $('#r-pagenum').textContent = '';
    R.paras = [];

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
          const toc = await Engine.getToc(mo.net, src, b.bookUrl);
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
          const r = await Engine.getContent(mo.net, src, ch.url);
          paras = r.paras;
          if (!paras.length) throw new Error('正文为空，检查正文规则');
          await mo.cache.set(b.id, R.ci, { title, text: paras });
        }
        if (S.state.settings.autoCacheNext && R.ci + 1 < b.chapters.length) {
          prefetch(b, src, R.ci + 1);
        }
      }

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
    } catch (e) {
      const msg = e.message || String(e);
      const canSwitch = b.kind !== 'local';
      $('#r-page').innerHTML = `<div class="err">加载失败：${esc(msg)}<br>
        <span style="font-size:12px;opacity:.7">${canSwitch ? '这个书源可能已失效，可以点下面按钮换一个源继续读' : '检查「书源」里的规则，或重新导入这本书'}</span>
        ${canSwitch ? '<div style="margin-top:16px"><button class="btn primary" id="err-switch">换源继续读</button></div>' : ''}</div>`;
      const sw = $('#err-switch');
      if (sw) sw.onclick = () => $('#r-switch').click();
      loading.textContent = '';
      R.paras = [];
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

  function renderChapter(dir) {
    const b = R.book;
    const s = S.state.settings;
    const page = $('#r-page');
    const head = `<div class="ch-no">${esc(b.name)} · 共 ${b.total || '?'} 章</div><h2>${esc(R.title)}</h2>`;
    const tail = `<div class="end">本章完</div>`;

    if (s.pageMode === 'paged') {
      layoutPages();
      const ps = R.pages[R.page] || [];
      page.innerHTML = head + `<div class="body">${ps.map(p => `<p>${esc(p)}</p>`).join('')}</div>` +
        (R.page === R.pages.length - 1 ? tail : '');
      page.classList.remove('slide-l', 'slide-r');
      void page.offsetWidth;
      page.classList.add(dir > 0 ? 'slide-l' : dir < 0 ? 'slide-r' : 'pageturn');
      $('#r-stage').scrollTop = 0;
      $('#r-pagenum').textContent = `${R.page + 1}/${R.pages.length} 页`;
    } else {
      page.innerHTML = head + `<div class="body">${R.paras.map(p => `<p>${esc(p)}</p>`).join('')}</div>` + tail;
      page.classList.remove('pageturn');
      void page.offsetWidth;
      page.classList.add('pageturn');
      if (dir) $('#r-stage').scrollTop = 0;
      $('#r-pagenum').textContent = '';
    }
    applyReaderStyle();
  }

  /** 按当前可视高度把段落切成一页页 */
  function layoutPages() {
    const stage = $('#r-stage');
    const s = S.state.settings;
    const availH = stage.clientHeight - 96; // 上下内边距（分页模式 page padding 40+40）+ 余量
    const width = Math.min(730, stage.clientWidth) - 80;

    const meas = document.createElement('div');
    meas.className = 'page';
    meas.style.cssText = `position:absolute;left:-9999px;top:0;width:${width}px;padding:0;margin:0;max-width:none;visibility:hidden;`;
    meas.style.setProperty('--r-fs', s.fontSize + 'px');
    meas.style.setProperty('--r-lh', s.lineHeight);
    meas.style.setProperty('--para-gap', (s.paraGap ? (s.lineHeight > 1.9 ? 1.05 : .8) : .2) + 'em');
    meas.classList.toggle('nofamily', s.fontFamily !== 'serif');
    const bodyEl = document.createElement('div');
    bodyEl.className = 'body';
    meas.appendChild(bodyEl);
    document.body.appendChild(meas);

    const pages = [[]];
    let used = 0;
    for (const p of R.paras) {
      const el = document.createElement('p');
      el.textContent = p;
      bodyEl.appendChild(el);
      const h = el.offsetHeight + parseFloat(getComputedStyle(el).marginBottom || 0);
      if (used + h > availH && pages[pages.length - 1].length) {
        pages.push([p]);
        used = h;
        bodyEl.innerHTML = '';
        bodyEl.appendChild(el);
      } else {
        pages[pages.length - 1].push(p);
        used += h;
      }
    }
    if (!pages[pages.length - 1].length && pages.length > 1) pages.pop();
    document.body.removeChild(meas);
    R.pages = pages.length ? pages : [[]];
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
      overall = ((R.ci + within) / Math.max(1, b.total)) * 100;
    }
    $('#r-bar').style.width = clamp(overall, 0, 100) + '%';
    $('#r-pct').textContent = Math.round(clamp(overall, 0, 100)) + '%';
    if (!reset) {
      clearTimeout(R.saveT);
      R.saveT = setTimeout(() => {
        if (R.book) setProgress(R.book.id, R.ci, R.title, within);
      }, 1200);
    }
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
    $$('#toc-list .toc-item').forEach(el => el.onclick = () => {
      R.page = 0;
      loadChapter(+el.dataset.ci, 0);
      $('#r-toc-panel').classList.remove('open');
      $('#toc-mask').classList.remove('on');
    });
    updateTocActive();
  }
  function updateTocActive() {
    $$('#toc-list .toc-item').forEach(el => el.classList.toggle('on', +el.dataset.ci === R.ci));
    const on = $('#toc-list .toc-item.on');
    if (on) on.scrollIntoView({ block: 'center' });
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
    const ps = $$('.page .body p');
    if (!ps.length) return;

    const voices = ttsOrderedVoices();
    const voice = voices.find(v => v.voiceURI === cfg.voiceURI) || voices[0] || null;
    if (!voices.length) toast('没检测到系统语音，会使用默认发音（可在「设置 → 朗读」查看）');

    const parts = [];
    ps.forEach((p, i) => splitSpeech(p.textContent).forEach(t => parts.push({ pi: i, text: t })));
    if (!parts.length) return;

    const startIdx = parts.findIndex(x => x.pi === (fromPara || 0));
    R.tts = true;
    R.ttsIdx = startIdx < 0 ? 0 : startIdx;
    R.ttsParts = parts;
    R.ttsPs = ps;
    const btn = $('#r-tts');
    btn.classList.add('on');
    btn.innerHTML = '停止';

    const speakNext = () => {
      if (!R.tts) return;
      if (R.ttsIdx >= parts.length) {
        if (cfg.autoNext && R.ci < (R.book.total || 1) - 1) {
          R.page = 0;
          loadChapter(R.ci + 1, 1).then(() => { R.tts = false; startTTS(0); });
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
      <p class="desc">音色来自 Windows 自带的语音引擎。系统里装过其他语言包的语音也会出现在列表里。</p>
      <div class="form-grid">
        <div class="field full"><label>音色 <span>共 ${voices.length} 个</span></label>
          <select id="tts-voice">
            ${voices.length
              ? `<option value="">跟随系统默认</option>` + voices.map(v => `<option value="${esc(v.voiceURI)}" ${cfg.voiceURI === v.voiceURI ? 'selected' : ''}>${esc(v.name)} · ${esc(v.lang)}${v.localService ? '' : ' · 在线'}</option>`).join('')
              : '<option value="">（没有检测到语音，可用系统「设置 → 时间和语言 → 语音」添加）</option>'}
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
    const all = S.state.sources.filter(s => s.enabled && s.searchUrl);
    if (!all.length) { toast('没有启用的网络书源，先去「书源」里启用'); return; }
    // 书源可能有几千个，全量搜太慢：按「书架在用 / 搜成功过」优先取一批
    const cap = clamp(S.state.settings.searchLimit || 40, 1, 500);
    const srcs = pickSearchSources(all, cap);

    openModal(`<h3>换源 · ${esc(b.name)}</h3>
      <p class="desc">在 ${srcs.length} 个书源里找同名书（共启用 ${all.length} 个）${srcs.length < all.length ? '，可在设置里调整上限' : ''}。<br>当前读到：${esc(R.title || '未开始')}（第 ${(R.ci || 0) + 1} 章）</p>
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
          const r = await Engine.search(mo.net, s, kw);
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
    $$('[data-sw]').forEach(el => el.onclick = () => applySwitch(hits[+el.dataset.sw]));
  }

  async function applySwitch(r) {
    const b = R.book;
    if (!b) return;
    const src = sourceById(r.sourceId);
    if (!src) return toast('书源不存在');
    const btn = $(`[data-sw]`);
    if (btn) btn.disabled = true;
    toast('正在获取新源目录…');
    let toc;
    try {
      toc = await Engine.getToc(mo.net, src, r.bookUrl);
    } catch (e) {
      return toast('换源失败：' + (e.message || e));
    }
    if (!toc.chapters.length) return toast('这个源没有目录，换一个试试');

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
    R.chapters = b.chapters;
    R.ci = idx;
    buildToc();
    await loadChapter(idx, 0);
    toast(`已换到「${src.name}」，定位到 ${toc.chapters[idx].title.slice(0, 20)}`);
  }


  /* ---------------- 绑定阅读器 ---------------- */
  function bindReader() {
    $('#r-back').onclick = closeReader;
    $('#r-close').onclick = closeReader;
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
    $('#r-stage').addEventListener('scroll', () => updateProgress());
    $('#r-stage').addEventListener('click', e => {
      if (e.target.closest('p')) return;
      // 点击两侧翻页
      const x = e.clientX - $('#r-stage').getBoundingClientRect().left;
      if (x < 80) turnPageOrChapter(-1);
      else if (x > $('#r-stage').clientWidth - 80) turnPageOrChapter(1);
    });
    window.addEventListener('resize', () => {
      if (R.book && S.state.settings.pageMode === 'paged') { R.page = 0; renderChapter(0); }
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
        case 'ArrowLeft': case 'PageUp': e.preventDefault(); turnPageOrChapter(-1); break;
        case 'ArrowRight': case 'PageDown': e.preventDefault(); turnPageOrChapter(1); break;
        case 'ArrowUp': if (S.state.settings.pageMode === 'scroll') { $('#r-stage').scrollBy({ top: -260, behavior: 'smooth' }); e.preventDefault(); } break;
        case 'ArrowDown': if (S.state.settings.pageMode === 'scroll') { $('#r-stage').scrollBy({ top: 260, behavior: 'smooth' }); e.preventDefault(); } break;
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
          else closeReader();
          break;
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
  bindReader();
  boot().catch(e => {
    document.body.innerHTML = '<div style="padding:40px;font-family:sans-serif;color:#a33">启动失败：' + esc(e.message) + '</div>';
    console.error(e);
  });
})();
