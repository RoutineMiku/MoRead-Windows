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
  /* 网页版跑在自建网关上时，存档落在服务器（dataStore='device'），而不是只在本浏览器 */
  const onDeviceStore = () => !!(S.info && S.info.platform === 'web' && S.info.dataStore === 'device');
  /* 浏览器里跑的版本（手机/电脑都算）：没有"文件路径"、没有拖放，交互要更明确一些 */
  const IS_WEB = !!(window.MoNativeBridge && window.MoNativeBridge.__isWeb);
  /* 当前系统名（关于页 / 设置页展示用）：S.info.platform 由各端桥接层给 */
  const OS_NAME = () => {
    const p = (S.info && S.info.platform) || '';
    if (IS_ANDROID) return 'Android';
    return p === 'web' ? '网页版'
      : p === 'darwin' ? 'macOS'
      : p === 'linux' ? 'Linux'
      : p === 'harmony' ? '鸿蒙'
      : p === 'ios' ? 'iOS'
      : 'Windows';
  };
  const layoutMode = () => document.documentElement.getAttribute('data-layout') || '';

  /* ---------------- 网络：带短缓存的 GET ----------------
   * 网页书「预览 → 试读 → 加入书架」会把同一页反复抓三遍，每遍都是几百毫秒的往返；
   * 换章来回翻也是。这里按地址缓存 90 秒（只缓存成功的 GET，24MB 上限，LRU 淘汰），
   * 同一页只走一次网络。binary / POST 一律不缓存。 */
  const NET_CACHE = { map: new Map(), bytes: 0, ttl: 90 * 1000, max: 24 * 1024 * 1024 };
  function netGet(opts) {
    const o = opts || {};
    const cacheable = !o.binary && !o.method && !o.noCache && /^https?:/i.test(o.url || '');
    if (!cacheable) return mo.net(o);
    const key = o.url;
    const hit = NET_CACHE.map.get(key);
    if (hit && Date.now() - hit.at < NET_CACHE.ttl) {
      NET_CACHE.map.delete(key);
      NET_CACHE.map.set(key, hit);
      return Promise.resolve(Object.assign({}, hit.res, { cached: true }));
    }
    return mo.net(o).then(res => {
      if (res && res.ok !== false && typeof res.text === 'string') {
        const size = (res.text.length + 64) * 2;
        if (size < 4 * 1024 * 1024) {
          if (NET_CACHE.map.has(key)) {
            const old = NET_CACHE.map.get(key);
            NET_CACHE.bytes -= (old.res.text.length + 64) * 2;
            NET_CACHE.map.delete(key);
          }
          NET_CACHE.map.set(key, { at: Date.now(), res });
          NET_CACHE.bytes += size;
          while (NET_CACHE.bytes > NET_CACHE.max && NET_CACHE.map.size > 1) {
            const k = NET_CACHE.map.keys().next().value;
            const v = NET_CACHE.map.get(k);
            NET_CACHE.map.delete(k);
            NET_CACHE.bytes -= (v.res.text.length + 64) * 2;
          }
        }
      }
      return res;
    });
  }
  const netClear = () => { NET_CACHE.map.clear(); NET_CACHE.bytes = 0; };

  const S = {
    state: null,
    view: 'shelf',
    filter: 'all',
    group: 'all',
    info: null,
    ext: null,          /* 扩展页里当前打开的子页：sources / history / stats / null（菜单） */
    set: null,          /* 设置页里当前打开的模块：read / tts / shelf / search / data / dav / system / about / null（菜单） */
    searchMode: 'src',  /* 搜索方式：src=书源，web=网页搜书 */
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
  /* EPUB 图片段：解析层把 <img> 转成 data URL 整段占位（见 src/parse.js）。
     这里负责识别与渲染；data URL 校验过结构才进 DOM，防止构造的书往里塞别的东西。 */
  const IMG_RE = /^data:image\/(?:png|jpe?g|gif|webp|bmp|svg\+xml|avif);base64,[A-Za-z0-9+/=]+$/;
  /* 远程图（漫画）：引擎先给出 @img:<地址>，下载成 data URL 后再按普通图片段落渲染。
     为什么不直接 <img src="远程">：漫画站普遍校验 Referer，直连会被换成防盗链占位图。 */
  const REMOTE_IMG = '@img:';
  const isRemoteImg = p => typeof p === 'string' && p.indexOf(REMOTE_IMG) === 0;
  const isImgPara = p => typeof p === 'string'
    && ((p.length > 32 && p.charCodeAt(4) === 58 /* 'data:' */ && IMG_RE.test(p)) || isRemoteImg(p));
  /* 图片限高：单图最高占阅读区 62%，保证「空页也放得下」，分页器就不会卡在
     「一段永远装不下」的死局里。具体数值在分页/渲染时算好传进来。 */
  const imgMaxH = () => {
    const st = $('#r-stage');
    const h = st ? st.clientHeight : 600;
    /* 漫画：一屏一张，别留半页空白；正文插图仍然只占 62% */
    return Math.max(120, Math.round(h * (R && R.comic ? 0.96 : 0.62)));
  };
  const imgHtml = (p, maxH) => `<img class="r-img" style="max-height:${maxH}px" src="${p}" alt="">`;
  const parasMap = (paras, maxH) => paras.map(p => isImgPara(p) ? imgHtml(p, maxH) : `<p>${esc(p)}</p>`).join('');
  /* 分页前必须把本章图片预加载完：data URL 的 <img> 解码是异步的，测量盒里读
     offsetHeight 时图还没解开，高度按 0 算，分页会把一页塞爆。加载过的图片进
     内存缓存，测量盒里再建 <img> 就能同步量出真实尺寸。 */
  const imgLoaded = new Map();
  function preloadImgs(paras) {
    const jobs = [];
    for (const p of paras) {
      if (!isImgPara(p) || imgLoaded.has(p)) continue;
      imgLoaded.set(p, new Promise(res => {
        const im = new Image();
        im.onload = im.onerror = res;
        im.src = p;
        setTimeout(res, 5000);   // 坏图也不能卡住打开书
      }));
      jobs.push(imgLoaded.get(p));
    }
    return Promise.all(jobs);
  }

  /* ---------------- 漫画：远程图 → data URL ----------------
   * 并发 4 张、单张 8MB 上限，整章最多 60 张。抓不到的图直接去掉，
   * 不能让一张 404 把整章卡住（漫画站换域名很频繁）。 */
  async function resolveImgs(paras, src) {
    if (!paras || !paras.length) return paras;
    const targets = [];
    for (let i = 0; i < paras.length; i++) if (isRemoteImg(paras[i])) targets.push(i);
    if (!targets.length) return paras;
    const out = paras.slice();
    const max = Math.min(targets.length, 60);
    let cursor = 0;
    const worker = async () => {
      while (cursor < max) {
        const idx = targets[cursor++];
        const url = out[idx].slice(REMOTE_IMG.length);
        try {
          const r = await netGet({ url, binary: true, headers: (src && src.headers) || undefined, timeout: 15000 });
          if (!r || !r.ok || !r.b64) throw new Error((r && r.error) || 'no data');
          const mime = /^image\//.test(r.mime || '') ? r.mime : 'image/jpeg';
          out[idx] = `data:${mime};base64,${r.b64}`;
        } catch (e) {
          out[idx] = '';   /* 标记为空，下面统一过滤 */
        }
      }
    };
    /* 漫画一话几十张图：并发 6 比 4 快三成，再高容易被图片站限流 */
    await Promise.all(Array.from({ length: Math.min(6, max) }, worker));
    return out.filter(p => p !== '');
  }
  const uid = p => (p || 'X') + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  /* 网络请求取消不了，但不必一直等：超时就放弃这个源，继续下一个 */
  const withTimeout = (p, ms) => Promise.race([
    Promise.resolve(p),
    new Promise((_, rej) => setTimeout(() => rej(new Error('超时')), ms))
  ]);

  /** 换源要用的干净关键词：书名号、后缀（全本 / 完本 / 精校）会让站点搜不到 */
  const cleanSearchKw = name => {
    const raw = String(name || '').replace(/\s+/g, ' ').trim();
    const s = raw
      .replace(/[《》「」『』【】\[\]（）()]/g, ' ')
      .replace(/[（(][^)）]{0,8}(全本|完本|连载|免费|精校|校对|TXT|txt)[^)）]{0,8}[)）]/g, ' ')
      .replace(/\s*[-_|｜]\s*(全本|完本|连载|免费|精校|校对).*$/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    return s || raw;
  };

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

  /* 复制到剪贴板：file:// 下的 Electron / 老 WebView 没有 navigator.clipboard，
     退回「选中 + execCommand」这条老路，两条都失败就返回 false 让调用方改提示。 */
  async function copyText(text) {
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch (e) { /* 继续走兜底 */ }
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', 'readonly');
      ta.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0';
      document.body.appendChild(ta);
      ta.select();
      ta.setSelectionRange(0, ta.value.length);
      const ok = document.execCommand('copy');
      document.body.removeChild(ta);
      return !!ok;
    } catch (e) { return false; }
  }

  function openModal(html, wide) {
    const box = $('#modal-box');
    box.className = 'modal' + (wide ? ' wide' : '');
    box.innerHTML = html;
    $('#modal').classList.add('open');
  }
  function closeModal() { $('#modal').classList.remove('open'); }
  /* 二次确认：手机上一排按钮挨得近，「从头开始」点错就把阅读位置带走了。
     返回 Promise<boolean>，调用处 await 即可。 */
  function confirmAsk(opt) {
    return new Promise(resolve => {
      openModal(`<h3>${esc(opt.title || '确认')}</h3>
        <p class="desc">${opt.text || ''}</p>
        <div class="modal-actions">
          <button class="btn" id="cf-no">取消</button>
          <button class="btn ${opt.danger ? 'danger' : 'primary'}" id="cf-yes">${esc(opt.ok || '确定')}</button>
        </div>`);
      const done = v => { closeModal(); resolve(v); };
      $('#cf-no').onclick = () => done(false);
      $('#cf-yes').onclick = () => done(true);
    });
  }
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

  /* 0.6.1 排版改版的一次性迁移：老默认行距 2.0 太散（一屏少看四五行），
     段落间距又由行距推导成 1.05em。只动「还用着老默认值」的存档，
     自己调过行距的人保持原样。 */
  function migrateTypo() {
    const s = S.state && S.state.settings;
    if (!s || s.typoV) return;
    /* 只校正「还是老默认值」的存档：自己调过行距/段距的人保持原样 */
    if (s.lineHeight >= 1.95) s.lineHeight = 1.7;
    if (!(typeof s.paraGapEm === 'number')) s.paraGapEm = s.paraGap ? (s.lineHeight > 1.9 ? 1.05 : .8) : .2;
    if (s.paraGapEm > 0.9) s.paraGapEm = 0.5;
    s.typoV = 1;
    try { save(); } catch (e) { /* 存档写失败也不该挡住启动 */ }
  }

  async function boot() {
    S.info = await mo.info();
    S.state = await mo.state.get();
    S.searchMode = (S.state.settings && S.state.settings.searchMode) === 'web' ? 'web' : 'src';
    try { migrateTypo(); } catch (e) { console.error('排版迁移失败：', e); }
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
        dh.innerHTML = '点右上角 <b>导入</b> 选择 txt / epub 文件；在线书用右上角的搜索按钮搜到后加进书架';
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
    on('#btn-search', () => { setView('search'); setTimeout(() => $('#search-input')?.focus(), 60); });
    on('#btn-import', importBooks);
    on('#btn-import2', importBooks);

    /* 书架搜索框：左边下拉选「书源 / 网页」，回车按当前方式搜 */
    const qm = $('#quick-mode');
    if (qm) {
      qm.value = S.searchMode;
      qm.onchange = () => setSearchMode(qm.value);
    }
    const q = $('#quick-search');
    if (q) q.addEventListener('keydown', e => {
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

    on('#shelf-sort', () => shelfOptions('sort'));
    on('#shelf-size', () => shelfOptions('size'));

    bindDropZone();
    bindKeys();
  }

  function bindNav() {
    $$('.rail-btn').forEach(b => b.addEventListener('click', () => setView(b.dataset.view)));
  }

  /* ---------------- 扩展 ----------------
   * 书源 / 阅读历史 / 阅读统计原来各占一个侧栏入口，加上书架、网页、书签、设置
   * 一共七个，手机上挤成一排小图标。现在它们统一收进「扩展」，侧栏只留
   * 书架 / 扩展 / 设置三个大按钮；以后再加功能（比如词典、同步）也往这里挂，
   * 不用再动侧栏。 */
  const EXT = [
    {
      k: 'sources', name: '书源', desc: '导入、编辑、检测 Legado 书源',
      icon: '<circle cx="12" cy="12" r="8.2"/><path d="M3.8 12h16.4M12 3.8c2.2 2.3 3.3 5.1 3.3 8.2S14.2 17.9 12 20.2c-2.2-2.3-3.3-5.1-3.3-8.2S9.8 6.1 12 3.8z"/>',
      stat: () => {
        const n = S.state.sources.length, on = S.state.sources.filter(s => s.enabled).length;
        return n ? `${n} 个 · ${on} 个启用` : '还没有书源';
      }
    },
    {
      k: 'history', name: '阅读历史', desc: '按天回看读到哪一章',
      icon: '<circle cx="12" cy="12" r="8.2"/><path d="M12 7.5V12l3 1.8"/>',
      stat: () => S.state.history.length ? `${S.state.history.length} 条记录` : '暂无记录'
    },
    {
      k: 'stats', name: '阅读统计', desc: '每天读了多久、多少字',
      icon: '<path d="M5 19V9M12 19V5M19 19v-6"/>',
      stat: () => {
        const s = (S.state.stats || {})[dayKey()] || { sec: 0 };
        return s.sec ? `今天 ${fmtDur(s.sec)}` : '今天还没读';
      }
    }
  ];
  const EXT_NAME = { sources: '书源', history: '阅读历史', stats: '阅读统计', addon: '添加扩展' };

  /* ---------------- 用户导入的扩展 ----------------
   * 开发者写一个 HTML 面板（或给一个站点地址），包成 JSON 导进来，扩展菜单就多
   * 一张卡；点开就是面板。面板跑在 sandbox iframe 里，跟宿主只通过 postMessage
   * 说话（教程与接口清单见「添加扩展」子页）：
   *   parent.postMessage({ moread:'toast',  text:'导入成功' }, '*')
   *   parent.postMessage({ moread:'context' }, '*')          → 宿主回 context
   *   parent.postMessage({ moread:'search', q:'书名' }, '*')
   *   parent.postMessage({ moread:'openBook', id:'…', chapter:0 }, '*')
   * 存 data.json 的 addons 数组，跟着备份/换设备一起走。 */
  const ADDON_ICONS = {
    puzzle: '<path d="M10 4.6a2 2 0 1 1 4 0V6h2.4A1.6 1.6 0 0 1 18 7.6V10h1.4a2 2 0 1 1 0 4H18v2.4A1.6 1.6 0 0 1 16.4 18H14v-1.4a2 2 0 1 0-4 0V18H7.6A1.6 1.6 0 0 1 6 16.4V14H4.6a2 2 0 1 1 0-4H6V7.6A1.6 1.6 0 0 1 7.6 6H10z"/>',
    plus: '<path d="M12 5.2v13.6M5.2 12h13.6"/>',
    timer: '<circle cx="12" cy="13.2" r="6.8"/><path d="M12 9.8v3.6l2.2 1.4M9.4 3.6h5.2"/>',
    star: '<path d="M12 4.4l2.4 4.9 5.4.8-3.9 3.8.9 5.4L12 16.8l-4.8 2.5.9-5.4L4.2 10.1l5.4-.8z"/>',
    cloud: '<path d="M7.2 18h9.3a3.5 3.5 0 0 0 .3-7 5 5 0 0 0-9.6-1.2A3.9 3.9 0 0 0 7.2 18z"/>',
    note: '<path d="M6 3.8h9l3 3v13.4H6z"/><path d="M9 8.6h6M9 12h6M9 15.4h4"/>',
    code: '<path d="M9 8.2l-3.4 3.8L9 15.8M15 8.2l3.4 3.8L15 15.8"/>',
    book: '<path d="M4.2 5.6A1.6 1.6 0 0 1 5.8 4H10v16H5.8a1.6 1.6 0 0 1-1.6-1.6z"/><path d="M10 4h4.2a1.6 1.6 0 0 1 1.6 1.6v12.8a1.6 1.6 0 0 1-1.6 1.6H10"/>'
  };
  const addonIcon = k => ADDON_ICONS[k] || ADDON_ICONS.puzzle;
  const addonList = () => (S.state && Array.isArray(S.state.addons)) ? S.state.addons : [];

  function addonSlug(name) {
    const s = String(name || '').toLowerCase()
      .replace(/[^\w\u4e00-\u9fa5-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24);
    return (s || 'ext') + '-' + Date.now().toString(36).slice(-4);
  }

  /** 把粘贴/文件读到的文本解析成扩展对象；格式不对就抛错误给用户看 */
  function parseAddon(raw, filename) {
    const txt = String(raw || '').trim();
    if (!txt) throw new Error('内容是空的');
    let o;
    if (txt[0] === '{') {
      try { o = JSON.parse(txt); } catch (e) { throw new Error('JSON 格式不对：' + (e.message || e)); }
    } else if (txt[0] === '[') {
      throw new Error('一次只能导入一个扩展，请把数组拆成单个对象');
    } else {
      /* 直接丢一个 .html 进来：整个文件当面板，名字取 <title> 或文件名 */
      const t = (txt.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1];
      const nm = (t || String(filename || '').replace(/\.[^.]+$/, '') || '未命名扩展').trim();
      o = { name: nm, type: 'html', html: txt };
    }
    const name = String(o.name || '').trim();
    if (!name) throw new Error('缺少 name（扩展名称）');
    const url = String(o.url || '').trim();
    const html = String(o.html || '');
    const type = url && !html.trim() ? 'link' : 'html';
    if (type === 'html' && !html.trim()) throw new Error('缺少 html（面板内容），或改成填 url（站点地址）');
    if (type === 'link' && !/^https?:\/\//i.test(url)) throw new Error('url 必须以 http:// 或 https:// 开头');
    if (html.length > 400 * 1024) throw new Error('面板超过 400KB，建议精简一下或改用 url 方式');
    return {
      id: String(o.id || '').trim().replace(/[^\w.:-]/g, '') || addonSlug(name),
      name: name.slice(0, 40),
      desc: (String(o.desc || '').trim() || (type === 'link' ? url.replace(/^https?:\/\//i, '') : '自定义扩展')).slice(0, 80),
      version: String(o.version || '1.0.0').slice(0, 16),
      author: String(o.author || '').slice(0, 40),
      icon: ADDON_ICONS[o.icon] ? o.icon : 'puzzle',
      type, html, url,
      enabled: o.enabled !== false,
      at: Date.now()
    };
  }

  const ADDON_DEMO = {
    name: '阅读小助手',
    desc: '示例：显示当前在读的书',
    version: '1.0.0',
    author: '墨读',
    icon: 'star',
    type: 'html',
    html: `<div style="font:14px/1.7 system-ui;padding:20px;color:#1a1e26">
  <h3 style="margin:0 0 10px">阅读小助手</h3>
  <p id="ctx" style="color:#6b7280">正在读取当前状态…</p>
  <button id="go" style="margin-top:8px;padding:7px 14px;border:0;border-radius:8px;background:#2b6ce0;color:#fff">回到书架</button>
  <script>
    parent.postMessage({ moread:'context' }, '*');
    addEventListener('message', e => {
      const d = e.data || {};
      if (d.moread !== 'context') return;
      const b = d.data && d.data.book;
      document.getElementById('ctx').textContent = b
        ? '在读：' + b.name + '（' + (d.data.chapterTitle || '第 ' + (b.chapter + 1) + ' 章') + '）'
        : '还没打开书，去书架挑一本吧。';
    });
    document.getElementById('go').onclick = () => parent.postMessage({ moread:'shelf' }, '*');
  <\/script>
</div>`
  };

  function addonCard(a) {
    return `<button class="ext-card" data-ext="addon:${esc(a.id)}">
      <span class="ext-ico">${a.type === 'link' ? '<svg viewBox="0 0 24 24"><path d="M10 13.6a4 4 0 0 0 5.7 0l2.6-2.6a4 4 0 0 0-5.7-5.7l-1.3 1.3"/><path d="M14 10.4a4 4 0 0 0-5.7 0l-2.6 2.6a4 4 0 0 0 5.7 5.7l1.3-1.3"/></svg>' : `<svg viewBox="0 0 24 24">${addonIcon(a.icon)}</svg>`}</span>
      <span class="ext-info"><b>${esc(a.name)}</b><i>${esc(a.desc)}</i></span>
      <span class="ext-stat">v${esc(a.version)}${a.author ? ' · ' + esc(a.author) : ''}</span>
    </button>`;
  }

  const extTitle = () => {
    if (!S.ext) return '扩展';
    if (S.ext.indexOf('addon:') === 0) {
      const a = addonList().find(x => x.id === S.ext.slice(6));
      return a ? a.name : '扩展';
    }
    return EXT_NAME[S.ext] || '扩展';
  };

  function renderExt() {
    const v = $('#view-ext');
    if (!v) return;
    if (!S.ext) {
      v.innerHTML = `
        <div class="page-head"><h1>扩展</h1></div>
        <div class="ext-grid">
          ${EXT.map(e => `<button class="ext-card" data-ext="${e.k}">
            <span class="ext-ico"><svg viewBox="0 0 24 24">${e.icon}</svg></span>
            <span class="ext-info"><b>${e.name}</b><i>${e.desc}</i></span>
            <span class="ext-stat">${esc(e.stat())}</span>
          </button>`).join('')}
          ${addonList().map(addonCard).join('')}
          <button class="ext-card addon-add" data-ext="addon">
            <span class="ext-ico"><svg viewBox="0 0 24 24">${ADDON_ICONS.plus}</svg></span>
            <span class="ext-info"><b>添加扩展</b><i>导入开发者做的功能面板 · 附教程</i></span>
            <span class="ext-stat">JSON / HTML</span>
          </button>
        </div>`;
      $$('#view-ext [data-ext]').forEach(b => b.onclick = () => {
        S.ext = b.dataset.ext;
        const t = $('#tb-title');
        if (t) t.textContent = extTitle();
        renderExt();
      });
      return;
    }
    v.innerHTML = `<div id="ext-body"></div>`;
    const host = $('#ext-body');
    const back = document.createElement('button');
    back.className = 'ext-back';
    back.innerHTML = '<svg viewBox="0 0 24 24"><path d="M15 5l-7 7 7 7"/></svg>扩展';
    back.onclick = () => {
      S.ext = null;
      const t = $('#tb-title');
      if (t) t.textContent = '扩展';
      renderExt();
    };
    if (S.ext === 'sources') renderSources(host);
    else if (S.ext === 'history') renderHistory(host);
    else if (S.ext === 'stats') renderStats(host);
    else if (S.ext === 'addon') renderAddonManager(host);
    else if (S.ext.indexOf('addon:') === 0) renderAddonPanel(host, S.ext.slice(6));
    /* 返回按钮插进子页自己的 .page-head，跟着吸顶一起走 */
    const head = host.querySelector('.page-head');
    if (head) head.insertBefore(back, head.firstChild); else host.insertBefore(back, host.firstChild);
  }

  /* ---------------- 添加扩展：导入 · 教程 · 管理 ---------------- */
  const ADDON_EXT_RE = /\.(json|html?|txt)$/i;

  /** 解析 + 落库（同名同 id 会问一下覆盖）。成功返回扩展对象，失败返回 null。 */
  async function importAddon(raw, fname) {
    let a;
    try { a = parseAddon(raw, fname); } catch (e) { toast(e.message || String(e), 4000); return null; }
    const arr = addonList();
    const dup = arr.find(x => x.id === a.id || x.name === a.name);
    if (dup) {
      const ok = await confirmAsk({
        title: '覆盖扩展',
        text: `已经有「${esc(dup.name)}」了，用这次导入的内容覆盖它？`,
        ok: '覆盖'
      });
      if (!ok) return null;
      Object.assign(dup, a, { id: dup.id, at: Date.now() });
    } else {
      arr.push(a);
    }
    S.state.addons = arr;
    save(true);
    return a;
  }

  async function importAddonFile(file) {
    if (!file) return;
    let txt = '';
    try { txt = await file.text(); } catch (e) { toast('读文件失败：' + (e.message || e)); return; }
    const a = await importAddon(txt, file.name);
    if (a) { toast(`已导入「${a.name}」`); renderExt(); }
  }

  function renderAddonManager(host) {
    const list = addonList();
    host.innerHTML = `
      <div class="page-head"><h1>添加扩展</h1>
        <span class="sub">${list.length ? `已安装 ${list.length} 个` : '还没有导入过扩展'}</span></div>
      <div class="set-wrap one">
        <div class="card">
          <h3>导入扩展</h3>
          <div class="addon-drop" id="addon-drop">
            <b>把 .json / .html 拖进窗口</b>
            <span>也可以粘贴到下面，或点「选文件」</span>
          </div>
          <textarea class="addon-text" id="addon-text" spellcheck="false"
            placeholder='{"name":"我的扩展","desc":"一句话说明","html":"<div>你好，墨读</div>"}'></textarea>
          <div class="addon-acts">
            <button class="btn primary" id="addon-import">导入</button>
            <button class="btn" id="addon-file">选文件…</button>
            <button class="btn ghost" id="addon-demo">填入示例</button>
            <input type="file" id="addon-input" accept=".json,.html,.htm,.txt,application/json,text/html" hidden />
          </div>
          <p class="addon-tip">两种扩展：<b>HTML 面板</b>（自带界面，最常用）或 <b>站点入口</b>（填一个网址，浏览器里打开）。导入后扩展菜单里就会多一张卡。</p>
        </div>

        <div class="card">
          <h3>教程 · 三步做一个扩展</h3>
          <ol class="addon-steps">
            <li><b>写面板</b>：新建一个 <code>.html</code>，正常写 HTML / CSS / JS，不用管墨读的样式。</li>
            <li><b>写清单</b>：把面板内容放进 <code>html</code> 字段（整段 HTML 转义成字符串），或者只填 <code>url</code> 做成站点入口。</li>
            <li><b>导入</b>：把 JSON 拖进窗口、或粘贴到上面，成功后扩展菜单多一张卡，点开就是面板。</li>
          </ol>
          <pre class="addon-code">{
  "name": "阅读小助手",
  "desc": "显示当前在读的书",
  "version": "1.0.0",
  "author": "你的名字",
  "icon": "star",
  "html": "&lt;div&gt;你好，墨读&lt;/div&gt;"
}</pre>
          <p class="addon-tip">必填只有 <code>name</code> 和 <code>html</code>（或 <code>url</code>）。<code>icon</code> 可选 puzzle / star / timer / cloud / note / code / book。</p>
        </div>

        <div class="card">
          <h3>面板怎么跟墨读说话</h3>
          <pre class="addon-code">// 面板（iframe）里执行
parent.postMessage({ moread:'toast', text:'你好' }, '*');
parent.postMessage({ moread:'context' }, '*');      // 取当前在读
parent.postMessage({ moread:'search', q:'三体' }, '*');
parent.postMessage({ moread:'openBook', id:'…', chapter:0 }, '*');
parent.postMessage({ moread:'shelf' }, '*');       // 回书架

// 听宿主回复
addEventListener('message', e => {
  if (e.data &amp;&amp; e.data.moread === 'context') {
    console.log(e.data.data);   // { book, chapterTitle, theme, fontSize }
  }
});</pre>
          <p class="addon-tip">面板跑在沙箱里，读不到书库和存档；需要什么就问宿主。分发给别人只要给这一个 JSON 文件，对方导入即用。</p>
        </div>

        <div class="card">
          <h3>已安装<span class="chip">${list.length} 个</span></h3>
          ${list.length ? list.map(a => `
            <div class="addon-row">
              <span class="addon-row-ico"><svg viewBox="0 0 24 24">${addonIcon(a.icon)}</svg></span>
              <span class="rl"><b>${esc(a.name)}</b>
                <i>${esc(a.desc)} · v${esc(a.version)}${a.author ? ' · ' + esc(a.author) : ''}</i></span>
              <button class="btn sm" data-addon-open="${esc(a.id)}">打开</button>
              <button class="btn sm danger" data-addon-del="${esc(a.id)}">移除</button>
            </div>`).join('') : `<div class="empty">还没有扩展，拖个 JSON 进来试试。</div>`}
        </div>
      </div>`;

    const ta = $('#addon-text');
    const doImport = async (raw, fname) => {
      const a = await importAddon(raw, fname);
      if (a) { toast(`已导入「${a.name}」`); renderExt(); }
      return !!a;
    };

    $('#addon-import').onclick = () => {
      const txt = (ta && ta.value || '').trim();
      if (!txt) { toast('先粘贴扩展内容，或点「选文件」'); return; }
      doImport(txt, '');
    };
    $('#addon-demo').onclick = () => {
      if (ta) { ta.value = JSON.stringify(ADDON_DEMO, null, 2); ta.focus(); }
      toast('这是一份能直接导入的示例');
    };
    $('#addon-input').onchange = async e => {
      const f = e.target.files && e.target.files[0];
      if (!f) return;
      try { await doImport(await f.text(), f.name); } catch (err) { toast('读文件失败：' + (err.message || err)); }
      e.target.value = '';
    };
    $('#addon-file').onclick = () => $('#addon-input').click();

    /* 拖到这张卡片上也认：拖拽事件被全局接走时只改文案，见 bindDropZone */
    const drop = $('#addon-drop');
    drop.onclick = () => {
      const inp = $('#addon-input');
      if (inp) inp.click();
    };

    $$('[data-addon-open]').forEach(b => b.onclick = () => {
      S.ext = 'addon:' + b.dataset.addonOpen;
      const t = $('#tb-title');
      if (t) t.textContent = extTitle();
      renderExt();
    });
    $$('[data-addon-del]').forEach(b => b.onclick = async () => {
      const a = addonList().find(x => x.id === b.dataset.addonDel);
      if (!a) return;
      const ok = await confirmAsk({
        title: '移除扩展', text: `把「${esc(a.name)}」从扩展菜单里删掉？`, ok: '移除', danger: true
      });
      if (!ok) return;
      S.state.addons = addonList().filter(x => x.id !== a.id);
      save(true);
      toast('已移除');
      renderExt();
    });
  }

  function renderAddonPanel(host, id) {
    const a = addonList().find(x => x.id === id);
    if (!a) {
      host.innerHTML = `<div class="page-head"><h1>扩展</h1></div>
        <div class="empty">这个扩展已经不在了。</div>`;
      return;
    }
    const linkMode = a.type === 'link';
    host.innerHTML = `
      <div class="page-head addon-head"><h1>${esc(a.name)}</h1>
        <span class="sub">${esc(a.desc)}</span>
        <div class="head-tools">
          ${linkMode ? '<button class="btn sm" id="addon-visit">在浏览器打开</button>' : ''}
          <button class="btn sm ghost" id="addon-manage">管理</button>
        </div>
      </div>
      ${linkMode ? `
        <div class="addon-link">
          <span class="ext-ico"><svg viewBox="0 0 24 24"><path d="M10 13.6a4 4 0 0 0 5.7 0l2.6-2.6a4 4 0 0 0-5.7-5.7l-1.3 1.3"/><path d="M14 10.4a4 4 0 0 0-5.7 0l-2.6 2.6a4 4 0 0 0 5.7 5.7l1.3-1.3"/></svg></span>
          <b>${esc(a.name)}</b>
          <i>${esc(a.url)}</i>
          <button class="btn primary" id="addon-visit2">打开站点</button>
        </div>` : `
        <div class="addon-panel">
          <iframe id="addon-frame" title="${esc(a.name)}" sandbox="allow-scripts allow-forms allow-popups allow-modals allow-downloads"
            srcdoc="${esc(a.html)}"></iframe>
        </div>`}
    `;
    const open = () => {
      try {
        if (mo.openExternal) mo.openExternal(a.url);
        else window.open(a.url, '_blank', 'noopener');
      } catch (e) {
        try { window.open(a.url, '_blank', 'noopener'); } catch (_) { toast('打不开这个地址'); }
      }
    };
    ['#addon-visit', '#addon-visit2'].forEach(s => { const b = $(s); if (b) b.onclick = open; });
    const mg = $('#addon-manage');
    if (mg) mg.onclick = () => {
      S.ext = 'addon';
      const t = $('#tb-title');
      if (t) t.textContent = EXT_NAME.addon;
      renderExt();
    };
  }

  /* 扩展面板 ↔ 宿主的唯一通道。只认这几条，别的一律忽略。 */
  window.addEventListener('message', e => {
    const d = e.data;
    if (!d || typeof d !== 'object' || !d.moread) return;
    const reply = obj => { try { e.source && e.source.postMessage(obj, '*'); } catch (_) { } };
    if (d.moread === 'toast') { toast(String(d.text || '').slice(0, 200), 2600); return; }
    if (d.moread === 'shelf') { setView('shelf'); return; }
    if (d.moread === 'context') {
      const b = R && R.book;
      reply({
        moread: 'context',
        data: {
          book: b ? { id: b.id, name: b.name, author: b.author || '', chapter: R.ci || 0 } : null,
          chapterTitle: (R && R.title) || '',
          theme: (S.state.settings || {}).theme || 'paper',
          fontSize: (S.state.settings || {}).fontSize || 19,
          count: (S.state.books || []).length
        }
      });
      return;
    }
    if (d.moread === 'search') {
      setView('search');
      const kw = String(d.q || '').trim();
      const inp = $('#search-input') || $('#quick-search');
      if (kw && inp) { inp.value = kw; try { runSearch(kw); } catch (_) { } }
      return;
    }
    if (d.moread === 'openBook' && d.id) {
      try { openReader(String(d.id), parseInt(d.chapter, 10) || 0); } catch (_) { }
    }
  });

  /** 切换搜索方式：书源 / 网页。两边共用同一个输入框和结果区。 */
  function setSearchMode(mode) {
    S.searchMode = mode === 'web' ? 'web' : 'src';
    if (S.state && S.state.settings) { S.state.settings.searchMode = S.searchMode; save(); }
    const qm = $('#quick-mode'); if (qm) qm.value = S.searchMode;
    const q = $('#quick-search');
    if (q) q.placeholder = S.searchMode === 'web' ? '按书名去网上找站 / 粘网址' : '搜索书名 / 作者';
    /* 换方式等于换了一套结果，旧列表不能留着（书源结果混在网页结果里会误点）；
       输入框里的词保留着，切过去直接按新方式再搜一遍 */
    const v = $('#view-search');
    if (v) v.dataset.touched = '';
    if (S.view === 'search') {
      renderSearch();
      const inp = $('#search-input');
      const kw = inp ? inp.value.trim() : '';
      if (kw) runSearch(kw);
    }
  }

  function setView(v) {
    /* 已经停在某个扩展子页 / 面板里，再点侧栏「扩展」先回菜单，跟返回键一致 */
    if (v === 'ext' && S.view === 'ext' && S.ext) S.ext = null;
    /* 书源 / 历史 / 统计已经收进扩展：老名字继续认，外部调用点（空书架引导、
       搜索无结果的提示、快捷键）不用跟着改 */
    if (v === 'sources' || v === 'history' || v === 'stats') { S.ext = v; v = 'ext'; }
    if (v === 'web') { setSearchMode('web'); v = 'search'; }
    if (v === 'bookmarks') v = 'shelf';        // 书签搬进阅读器了，别停在空页上
    S.view = v;
    $$('.rail-btn').forEach(b => b.classList.toggle('active', b.dataset.view === v));
    $$('.view').forEach(el => el.classList.toggle('active', el.id === 'view-' + v));
    const names = {
      shelf: '书架', search: '搜索', ext: extTitle(),
      settings: S.set ? setSecName() : '设置'
    };
    $('#tb-title').textContent = names[v] || '';
    if (v === 'shelf') renderShelf();
    if (v === 'search') renderSearch();
    if (v === 'ext') renderExt();
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
    /* 在「扩展 → 添加扩展」页时，拖进来的是扩展清单而不是书：文案与去向都要换 */
    const addonMode = () => S.view === 'ext' && S.ext === 'addon';
    let depth = 0;
    window.addEventListener('dragenter', e => {
      e.preventDefault(); depth++;
      const label = dz.firstElementChild;
      if (label) label.textContent = addonMode() ? '松开以导入扩展（JSON / HTML）' : '松开以导入本地书籍';
      dz.classList.add('on');
    });
    window.addEventListener('dragover', e => e.preventDefault());
    window.addEventListener('dragleave', () => { if (--depth <= 0) { depth = 0; dz.classList.remove('on'); } });
    window.addEventListener('drop', async e => {
      e.preventDefault(); depth = 0; dz.classList.remove('on');
      const list = [...(e.dataTransfer.files || [])];
      if (addonMode() && list.length && ADDON_EXT_RE.test(list[0].name)) {
        importAddonFile(list[0]);
        return;
      }
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
    /* 有封面图时不再叠竖排书名和作者：小档封面只有 111px 宽，两套文字会互相压住，
       而且大多数封面图本身就带书名。图挂了就摘掉 has-img，文字自动回来。 */
    const img = b.cover
      ? `<img src="${esc(b.cover)}" alt="" onerror="this.parentNode.classList.remove('has-img');this.style.display='none'">`
      : '';
    const len = (b.name || '').length;
    const cls = len > 12 ? 'ct xlong' : len > 8 ? 'ct long' : 'ct';
    return `<div class="cover ${img ? 'has-img' : ''}" style="background:linear-gradient(150deg,${g[0]},${g[1]})">
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

  /* ---------------- 书架排序 / 封面大小 ---------------- */
  const SHELF_SORTS = [
    { k: 'recent', name: '最近阅读', hint: '刚读过的在前，没读过的按加入时间排' },
    { k: 'added', name: '最近加入', hint: '刚加进书架的在最前' },
    { k: 'name', name: '书名', hint: '按书名排，中文按拼音，数字按大小' },
    { k: 'author', name: '作者', hint: '同一个作者的书集中在一起' },
    { k: 'progress', name: '阅读进度', hint: '读得多的、快读完的在前' },
    { k: 'updated', name: '最近更新', hint: '目录刚更新过的在线书在前' }
  ];
  const SHELF_SIZES = [
    { k: 'sm', name: '小', hint: '一屏放更多，适合书多的时候' },
    { k: 'md', name: '中', hint: '默认大小，手机上每行两本' },
    { k: 'lg', name: '大', hint: '封面更大，书名更清楚' }
  ];
  let zhCollator = null;
  function zhCompare(a, b) {
    if (!zhCollator) {
      try { zhCollator = new Intl.Collator('zh-Hans-CN', { numeric: true, sensitivity: 'base' }); }
      catch (e) { zhCollator = null; }
    }
    return zhCollator ? zhCollator.compare(a, b) : String(a).localeCompare(String(b));
  }
  const shelfSortKey = () => {
    const k = S.state.settings.shelfSort;
    return SHELF_SORTS.some(x => x.k === k) ? k : 'recent';
  };
  const shelfSizeKey = () => {
    const k = S.state.settings.shelfSize;
    return SHELF_SIZES.some(x => x.k === k) ? k : 'md';
  };
  /* 书架只做展示排序，不改动存档里 books 的顺序（导出的书架文件顺序保持原样） */
  function sortBooks(list) {
    const pct = b => pctOf(b);
    /* 旧存档只有 progress.at，没有 book.readAt：两种都认，「最近阅读」才不会把老书全排到后面 */
    const lastRead = b => b.readAt || (progressOf(b.id) && progressOf(b.id).at) || 0;
    const byRecent = (a, b) => lastRead(b) - lastRead(a) || (b.createdAt || 0) - (a.createdAt || 0);
    const key = shelfSortKey();
    const cmp = {
      recent: byRecent,
      added: (a, b) => (b.createdAt || 0) - (a.createdAt || 0) || zhCompare(a.name || '', b.name || ''),
      name: (a, b) => zhCompare(a.name || '', b.name || ''),
      author: (a, b) => zhCompare(a.author || '佚名', b.author || '佚名') || zhCompare(a.name || '', b.name || ''),
      progress: (a, b) => pct(b) - pct(a) || byRecent(a, b),
      updated: (a, b) => (b.updatedAt || 0) - (a.updatedAt || 0) || byRecent(a, b)
    }[key] || byRecent;
    return list.slice().sort(cmp);
  }
  /* 书架的列数按「书架实际可用宽度」算，不交给媒体查询。
     手机的 CSS 宽度 = 物理像素 / DPR，同一块屏从 320 到 600 都可能：
     1272px 的机器在 3.0 倍下是 424，在 2.6 倍下是 489。断点钉在 440 时，
     441～600 那一档会掉回 auto-fill，列宽随书名长度乱涨（用户截图里
     一本就占了 72% 屏宽）。这里直接量容器宽度，任何 DPR/分屏都对得上。 */
  function shelfColsFor(w, key) {
    if (!w) return 0;
    if (w < 560) return key === 'sm' ? 3 : key === 'md' ? 2 : 1;
    /* 竖屏平板 / 横屏手机：多给一列，但别退回 auto-fill（书名一长就散） */
    if (document.documentElement.getAttribute('data-layout') && w < 880) {
      return key === 'sm' ? 4 : key === 'md' ? 3 : 2;
    }
    return 0; // 桌面窗口：沿用 auto-fill，一行能放几本放几本
  }
  function applyShelfCols() {
    const grid = $('#books');
    if (!grid) return;
    const w = Math.round(grid.getBoundingClientRect().width);
    const n = shelfColsFor(w, shelfSizeKey());
    if (n) grid.setAttribute('data-cols', String(n));
    else grid.removeAttribute('data-cols');
  }
  let colsT = 0;
  window.addEventListener('resize', () => {
    clearTimeout(colsT);
    colsT = setTimeout(applyShelfCols, 90);
  });
  window.addEventListener('orientationchange', () => setTimeout(applyShelfCols, 160));

  function applyShelfPrefs() {
    const st = S.state && S.state.settings;
    if (!st) return;
    document.documentElement.setAttribute('data-shelf-size', shelfSizeKey());
    const sl = $('#shelf-sort-label');
    if (sl) sl.textContent = (SHELF_SORTS.find(x => x.k === shelfSortKey()) || SHELF_SORTS[0]).name;
    const zl = $('#shelf-size-label');
    if (zl) zl.textContent = (SHELF_SIZES.find(x => x.k === shelfSizeKey()) || SHELF_SIZES[1]).name;
    applyShelfCols();
  }

  function shelfOptions(kind) {
    const s = S.state.settings;
    const isSort = kind === 'sort';
    const list = isSort ? SHELF_SORTS : SHELF_SIZES;
    const cur = isSort ? shelfSortKey() : shelfSizeKey();
    openModal(`<h3>${isSort ? '书籍排序' : '封面大小'}</h3>
      <p class="desc">${isSort ? '书架按这个顺序排列，选一次以后都记住（分组内同样生效）。' : '只改书架上的展示大小，不影响正文。'}</p>
      <div class="opt-list" id="opt-list">
        ${list.map(o => `<button class="opt ${o.k === cur ? 'on' : ''}" data-k="${o.k}">
          ${isSort ? '' : `<span class="opt-prev prev-${o.k}"><i></i></span>`}
          <span class="opt-body"><b>${o.name}</b><small>${o.hint}</small></span>
          <span class="opt-tick">✓</span>
        </button>`).join('')}
      </div>
      <div class="modal-actions"><button class="btn" onclick="window.__closeModal()">关闭</button></div>`);
    $$('#opt-list .opt').forEach(el => el.onclick = () => {
      const k = el.dataset.k;
      if (isSort) {
        s.shelfSort = k;
        toast('已按「' + (SHELF_SORTS.find(x => x.k === k) || {}).name + '」排序');
      } else {
        s.shelfSize = k;
        toast('封面大小：' + (SHELF_SIZES.find(x => x.k === k) || {}).name);
      }
      applyShelfPrefs();
      save(true);
      closeModal();
      renderShelf();
    });
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
          <div class="meta">${esc(heroBook.author || '佚名')} · ${heroBook.kind === 'local' ? '本地书' : esc(heroBook.sourceName || '在线')} · 共 ${bodyChapterCount(heroBook) || '?'} 章</div>
          <div class="prog"><i style="width:${pct}%"></i></div>
          <div class="prog-txt">${p ? '读到 ' + esc(p.title || '') + ' · ' + pct + '%' : '尚未开始'}</div>
          <div class="hero-actions">
            <button class="btn primary" data-open="${heroBook.id}">${p ? '继续阅读' : '开始阅读'}</button>
            <button class="btn" data-restart="${heroBook.id}">从头开始</button>
          </div>
        </div>
      </div>`;
      $('[data-open]', heroEl).onclick = () => openReader(heroBook.id);
      $('[data-restart]', heroEl).onclick = async () => {
        const p2 = progressOf(heroBook.id);
        const ok = await confirmAsk({
          title: '从头开始阅读？',
          text: p2
            ? `《${esc(heroBook.name)}》会从第 1 章重新打开，当前进度（${esc(p2.title || '第 ' + ((p2.ci || 0) + 1) + ' 章')}）不会删除，随时能在目录里跳回去。`
            : `《${esc(heroBook.name)}》会从第 1 章打开。`,
          ok: '从头开始'
        });
        if (ok) openReader(heroBook.id, 0);
      };
    }

    // 列表
    let list = st.books;
    if (S.filter === 'local') list = list.filter(b => b.kind === 'local');
    else if (S.filter === 'online') list = list.filter(b => b.kind !== 'local');
    if (S.group === 'none') list = list.filter(b => !b.groupId || b.groupId === 'g_default');
    else if (S.group !== 'all') list = list.filter(b => b.groupId === S.group);
    /* 排序只作用于当前筛选结果：分组/本地/在线筛选后依旧按用户选的顺序排 */
    list = sortBooks(list);

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
          <p>${onDeviceStore()
            ? '书、书源、阅读进度都存在这台机器上，家里任何设备打开都能看到同一份。'
            : '书、书源、阅读进度都存在你这台设备的浏览器里，不会上传到任何服务器。'}</p>
          <div class="web-start-btns">
            <button class="btn primary" data-start="import">导入本地书（TXT / EPUB）</button>
            <button class="btn" data-start="restore">从备份文件恢复</button>
            <button class="btn" data-start="source">搜一本网络小说</button>
          </div>
          <p class="web-start-tip">${onDeviceStore()
            ? '从手机「阅读」App 或墨读导出的备份，在这里恢复一次就永久留在服务器上。'
            : '换设备、或清理过浏览器数据后，用「从备份文件恢复」把书架和进度找回来。'}</p>
        </div>`
      : `<div class="empty" style="grid-column:1/-1">书架还是空的。<br>${isAndroidApp()
        ? '点右上角 <b>导入</b> 选手机里的 txt / epub，或用右上角的<b>放大镜</b>搜网络小说。'
        : '拖入 TXT / EPUB，或用右上角的<b>放大镜</b>搜索网络小说。'}</div>`);

    /* 网页版空书架已经有引导卡，底部那条「拖进窗口」的提示是重复的，先收起来 */
    const dh = $('.drop-hint');
    if (dh) dh.style.display = (IS_WEB && !st.books.length) ? 'none' : '';

    /* 网页版空书架的三个入口 */
    $$('#books [data-start]').forEach(btn => {
      btn.onclick = () => {
        const k = btn.dataset.start;
        if (k === 'import') importBooks();
        else if (k === 'restore') restoreFromZip();
        else if (k === 'source') { setSearchMode('src'); setView('search'); }
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

    /* 书卡都进 DOM 之后量一次容器宽度定列数（此时布局已完成，量得准） */
    applyShelfCols();
  }

  function bookMenu(id) {
    const b = getBook(id);
    if (!b) return;
    const groups = S.state.groups;
    const cur = b.groupId || 'g_default';
    openModal(`<h3>${esc(b.name)}</h3>
      <p class="desc">${esc(b.author || '佚名')} · ${b.kind === 'local' ? '本地书' : '在线书 · ' + esc(b.sourceName || '')} · ${bodyChapterCount(b)} 章
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
        const { chapters, info, tocUrl } = await Engine.getToc(netGet, src, b.bookUrl, {
          tocUrl: b.tocUrl && b.tocUrl !== b.bookUrl ? b.tocUrl : '',
          expect: b.total || 0,
          reverse: !!(b.readConfig && b.readConfig.reverseToc)
        });
        b.chapters = chapters; b.total = chapters.length; b.updatedAt = Date.now();
        if (tocUrl) b.tocUrl = tocUrl;
        b.tocFixed = true;   // 用户手动更新过，别再后台偷偷改
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

  /* ---------------- 搜索（书源 / 网页 二合一） ----------------
   * 以前是两个入口：侧栏「网页」是一个小浏览器，「书源搜索」另开一页。
   * 现在合成一个搜索框，左边下拉选「书源」还是「网页」：
   *   · 书源 —— 在本地书源里找书，搜到直接加书架（快、能换源）
   *   · 网页 —— 用搜索引擎找站点，按书归并成卡片，可预览 / 加书架
   * 两种结果都落在同一个 #search-results 里，样子一致，操作一致。 */
  const ENGINE_NAMES = [['bing', '必应'], ['baidu', '百度'], ['sogou', '搜狗'], ['so360', '360']];
  const webEngine = () => (S.state.settings.webSearch && S.state.settings.webSearch.engine) || 'bing';

  function searchHint() {
    if (S.searchMode === 'web') {
      return `<div class="empty">网页搜书：输入书名去搜索引擎找站点，或直接粘一个目录页网址。<br>
        同名的书在多个站会合成一张卡，可以点站点标签换站，<b>预览</b> 能先看目录和正文再加书架。<br>
        站点有反爬时可能抓不到，换个站或换个引擎再试。</div>`;
    }
    return `<div class="empty">书源搜索：在已启用的书源里找书，搜到直接加书架，同名多源可以换源。<br>
      想按网站自己找（包括漫画站）、或者书源里压根没有——把上面的方式切到 <b>网页</b>。<br>
      没有书源？去 <a class="link" id="go-src-manage">扩展 → 书源</a> 导入 Legado 书源 JSON。</div>`;
  }

  function renderSearch() {
    const v = $('#view-search');
    if (!v) return;
    if (!v.dataset.ready) {
      v.dataset.ready = '1';
      v.innerHTML = `
        <div class="page-head">
          <h1>搜索</h1>
          <span class="sub" id="search-sub"></span>
          <div class="head-tools">
            <div class="searchbox">
              <select id="search-mode" class="smode" title="搜索方式">
                <option value="src">书源</option>
                <option value="web">网页</option>
              </select>
              <svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.6-3.6"/></svg>
              <input id="search-input" placeholder="输入书名或作者，回车搜索" />
            </div>
            <select id="search-engine" class="tb-select" title="网页搜书用的搜索引擎">
              ${ENGINE_NAMES.map(([k, n]) => `<option value="${k}">${n}</option>`).join('')}
            </select>
            <button class="btn primary" id="btn-do-search">搜索</button>
          </div>
        </div>
        <div class="list" id="search-results"></div>`;
      $('#search-input').addEventListener('keydown', e => { if (e.key === 'Enter') runSearch(e.target.value.trim()); });
      $('#btn-do-search').onclick = () => runSearch($('#search-input').value.trim());
      $('#search-mode').onchange = e => setSearchMode(e.target.value);
      $('#search-engine').onchange = e => {
        S.state.settings.webSearch.engine = e.target.value;
        save(true);
        const kw = $('#search-input').value.trim();
        if (kw && S.searchMode === 'web') runSearch(kw);
      };
    }
    $('#search-mode').value = S.searchMode;
    const eng = $('#search-engine');
    if (eng) { eng.value = webEngine(); eng.style.display = S.searchMode === 'web' ? '' : 'none'; }
    const inp = $('#search-input');
    if (inp) inp.placeholder = S.searchMode === 'web' ? '按书名去网上搜站点，或粘网址' : '输入书名或作者，回车搜索';
    if (!v.dataset.touched) {
      $('#search-results').innerHTML = searchHint();
      const gs = $('#go-src-manage');
      if (gs) gs.onclick = () => setView('sources');
    }
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
    const view = $('#view-search');
    if (view) view.dataset.touched = '1';
    const inp = $('#search-input');
    if (inp) inp.value = kw;
    const seq = ++searchSeq;
    if (S.searchMode === 'web') { runWebSearch(kw, seq); return; }
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
      $('#search-progress').innerHTML = '没有启用的书源 —— <a class="link" id="go-src">去扩展 → 书源</a>';
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
          const r = await withTimeout(Engine.search(netGet, s, kw), 9000);
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

  /* 搜索结果是「一本书 × N 个源」。以前每个源单独一行、书名还可能是站点名，
     十条记录看起来像十本不同的书。现在按书名合并成一张卡片，
     书源收进标签里（用户要的就是「书名 + 是哪个源」），点进去还能换源。
     只按书名合并是因为同一本书在不同源上作者字段经常一个有一个没有
     （「扑街天线」vs「佚名」）；卡片里的作者取第一个非「佚名」的。 */
  function resKey(name) {
    return String(name || '').replace(/[\s·•・,，.。!！?？:：;；"'“”‘’()（）\[\]【】<>《》_\-—~～|/\\]/g, '').toLowerCase();
  }

  function groupResults(list) {
    const map = new Map();
    for (const r of list) {
      if (!r || !r.name) continue;
      const k = resKey(r.name);
      let g = map.get(k);
      if (!g) {
        g = { name: r.name, author: r.author, kind: r.kind, intro: r.intro, lastChapter: r.lastChapter, coverUrl: r.coverUrl, rel: r.rel || 0, alts: [] };
        map.set(k, g);
      }
      if ((!g.author || g.author === '佚名') && r.author && r.author !== '佚名') g.author = r.author;
      g.alts.push(r);
      if (!g.coverUrl && r.coverUrl) g.coverUrl = r.coverUrl;
      if (!g.lastChapter && r.lastChapter) g.lastChapter = r.lastChapter;
      if (!g.kind && r.kind) g.kind = r.kind;
      if (!g.intro && r.intro) g.intro = r.intro;
      if ((r.rel || 0) > g.rel) g.rel = r.rel;
    }
    const qrank = r => {
      const q = (sourceById(r.sourceId) || {}).quality;
      return q === 'great' ? 0 : q === 'ok' ? 1 : q === 'poor' ? 3 : q === 'dead' ? 4 : 2;
    };
    const groups = [...map.values()];
    for (const g of groups) {
      g.alts.sort((a, b) => (qrank(a) - qrank(b)) || (b.coverUrl ? 1 : 0) - (a.coverUrl ? 1 : 0));
    }
    groups.sort((a, b) => (b.rel - a.rel) || (b.alts.length - a.alts.length));
    return groups;
  }

  function paintOnline(list) {
    const box = $('#search-online');
    if (!box) return;
    if (!list.length) {
      box.innerHTML = `<div class="empty">这次没有搜到这本书。<br>书名里有错字、或者站点改名都会搜不到 —— 换个短一点的关键词再试；<br>也可以到「设置 → 每次搜索的书源数」调大，或切到<a class="link" id="res-go-web">网页搜书</a>直接找站。</div>`;
      const gw = $('#res-go-web');
      if (gw) gw.onclick = () => { setSearchMode('web'); };
      return;
    }
    const groups = groupResults(list);
    box.innerHTML = `<div class="src-label">网络 · ${groups.length} 本（共 ${list.length} 条，来自 ${new Set(list.map(r => r.sourceId)).size} 个源）</div>`
      + groups.slice(0, 60).map((g, i) => {
        const srcNames = g.alts.map(a => a.sourceName).filter(Boolean);
        const chips = srcNames.slice(0, 3).map(n => `<span class="chip res-src">${esc(n)}</span>`).join('')
          + (srcNames.length > 3 ? `<span class="chip res-src more">+${srcNames.length - 3}</span>` : '');
        return `<div class="row-card click res-card" data-g="${i}">
          ${g.coverUrl ? `<img class="res-cover" src="${esc(g.coverUrl)}" alt="" onerror="this.style.visibility='hidden'">`
            : `<div class="ico">${esc((g.name || '?')[0])}</div>`}
          <div class="body">
            <div class="t">${esc(g.name)}${g.kind ? `<span class="chip res-kind">${esc(g.kind)}</span>` : ''}</div>
            <div class="s">${esc(g.author || '佚名')}${g.lastChapter ? ' · ' + esc(g.lastChapter) : ''}</div>
            <div class="res-srcs">${chips}${g.alts.length > 1 ? `<span class="chip res-n">${g.alts.length} 个源，可换源</span>` : ''}</div>
          </div>
          <div class="act">
            <button class="btn sm" data-prev-btn="${i}">预览</button>
            <button class="btn sm primary" data-add="${i}">加入书架</button>
          </div>
        </div>`;
      }).join('');
    $$('[data-g]').forEach(el => el.onclick = e => {
      if (e.target.closest('[data-add]') || e.target.closest('[data-prev-btn]')) return;
      const g = groups[+el.dataset.g];
      previewOnlineBook(g.alts[0], g.alts);
    });
    $$('[data-prev-btn]').forEach(b => b.onclick = e => {
      e.stopPropagation();
      const g = groups[+b.dataset.prevBtn];
      previewOnlineBook(g.alts[0], g.alts);
    });
    $$('[data-add]').forEach(b => b.onclick = async e => {
      e.stopPropagation();
      const g = groups[+b.dataset.add];
      b.disabled = true; b.textContent = '添加中…';
      await addOnlineBook(g.alts[0]);
      b.textContent = '已加入';
    });
  }

  /* ---------------- 搜索结果预览 ----------------
   * 以前只有「加入书架」一个按钮：没看过目录就入库，进去才发现章节不对/根本是另一个页面。
   * 预览先把简介和目录抓回来给人看，确认无误再加；「试读」能直接看第一章正文。 */
  const pvCache = new Map();

  async function previewOnlineBook(r, alts) {
    const list = Array.isArray(alts) && alts.length ? alts : [r];
    const src = sourceById(r.sourceId);
    const inShelf = S.state.books.find(b => b.bookUrl === r.bookUrl);
    openModal(`<div class="pv-top">
        <div class="pv-cover">${r.coverUrl ? `<img src="${esc(r.coverUrl)}" alt="" onerror="this.parentNode.classList.add('ph')">` : esc((r.name || '?')[0])}</div>
        <div class="pv-meta">
          <div class="pv-name">${esc(r.name)}</div>
          <div class="pv-author">${esc(r.author || '佚名')}</div>
          <div class="pv-tags">
            <span class="chip tag">${esc(r.sourceName || (src && src.name) || '')}</span>
            ${r.kind ? `<span class="chip">${esc(r.kind)}</span>` : ''}
            ${list.length > 1 ? `<button class="btn sm" id="pv-switch">换源 · ${list.length} 个</button>` : ''}
          </div>
          <div class="pv-intro" id="pv-intro">${esc(r.intro || '（这个源没有给简介）')}</div>
        </div>
      </div>
      <div class="pv-toc-head">目录 <span class="sub" id="pv-count"></span></div>
      <div class="pv-toc" id="pv-toc"><div class="hint">正在获取目录…</div></div>
      <div class="modal-actions">
        <button class="btn left" id="pv-try">试读</button>
        <button class="btn" onclick="window.__closeModal()">关闭</button>
        <button class="btn primary" id="pv-add">${inShelf ? '已在书架' : '加入书架'}</button>
      </div>`, true);

    const swBtn = $('#pv-switch');
    if (swBtn) swBtn.onclick = () => showSourcePicker(r, list);

    const addBtn = $('#pv-add');
    addBtn.disabled = !!inShelf;
    addBtn.onclick = async () => {
      addBtn.disabled = true; addBtn.textContent = '添加中…';
      try {
        const bk = await addOnlineBook(r);
        addBtn.textContent = bk ? '已加入' : '已在书架';
        toast('已加入书架');
      } catch (e) {
        addBtn.disabled = false; addBtn.textContent = '加入书架';
      }
    };

    let chapters = [];
    const key = r.sourceId + '|' + r.bookUrl;
    const fetchToc = async () => {
      if (!src) throw new Error('这个书源已经不在了，换一个源或去网页搜书看看');
      if (pvCache.has(key)) return pvCache.get(key);
      const t = await withTimeout(Engine.getToc(netGet, src, r.bookUrl), 25000);
      pvCache.set(key, t);
      return t;
    };
    $('#pv-try').onclick = async () => {
      const btn = $('#pv-try');
      btn.disabled = true; btn.textContent = '加载中…';
      try {
        if (!chapters.length) {
          const t = await fetchToc();
          chapters = t.chapters;
        }
        if (!chapters.length) throw new Error('这个源没给目录，先试试加入书架');
        readPreview(r, src, chapters[0], list);
      } catch (e) { toast('打不开：' + (e.message || e)); }
      btn.disabled = false; btn.textContent = '试读';
    };

    try {
      const t = await fetchToc();
      chapters = t.chapters;
      if (t.info) {
        if (!r.intro && t.info.intro) $('#pv-intro').textContent = t.info.intro.slice(0, 300);
        if (t.info.author && !r.author) $('.pv-author').textContent = t.info.author;
        if (t.info.coverUrl && !r.coverUrl) {
          const c = $('.pv-cover');
          c.classList.remove('ph');
          c.innerHTML = `<img src="${esc(t.info.coverUrl)}" alt="" onerror="this.parentNode.classList.add('ph')">`;
        }
      }
      const box = $('#pv-toc');
      const cnt = $('#pv-count');
      if (cnt) cnt.textContent = chapters.length ? `共 ${chapters.length} 章` : '没有取到';
      if (!chapters.length) {
        box.innerHTML = `<div class="hint">这个源没有返回章节列表，多半是目录规则失效了 —— 建议换一个源再看。</div>`;
      } else {
        box.innerHTML = chapters.slice(0, 30).map((c, i) =>
          `<button class="pv-ch" data-ci="${i}">${esc(c.title)}</button>`).join('')
          + (chapters.length > 30 ? `<div class="hint">只显示前 30 章，共 ${chapters.length} 章</div>` : '');
        $$('.pv-ch').forEach(b => b.onclick = () => readPreview(r, src, chapters[+b.dataset.ci], list));
      }
    } catch (e) {
      const box = $('#pv-toc');
      const raw = String((e && e.message) || e || '');
      /* 「Cannot read properties of undefined」对用户没有意义，换成能行动的提示 */
      const msg = /Cannot read|undefined|null is not|not a function/i.test(raw)
        ? '这个源的目录规则失效了，换一个源试试'
        : raw;
      const tip = /换一个源|换源/.test(msg) ? '' : '<br>可以换个源，或先加入书架再「更新目录」。';
      if (box) box.innerHTML = `<div class="hint">目录没取到：${esc(msg)}${tip}</div>`;
    }
  }

  /** 预览里的换源：同一本书的其他书源，点一行直接换过去看目录 */
  function showSourcePicker(cur, list) {
    const qname = { great: '优质', ok: '有效', poor: '较差', dead: '失效' };
    openModal(`<h3 class="pv-title">换源 · ${esc(cur.name)}</h3>
      <p class="desc">同一个源偶尔目录/正文会失效，换一个往往就好了。点一行直接切过去看目录。</p>
      <div class="sw-list" id="pv-src-list">${list.map((r, i) => {
        const q = (sourceById(r.sourceId) || {}).quality;
        const on = r.bookUrl === cur.bookUrl;
        return `<div class="sw-item ${on ? 'cur' : ''}" data-i="${i}">
          <div class="sw-ico">${esc((r.sourceName || '源')[0])}</div>
          <div class="sw-body">
            <div class="sw-t">${esc(r.sourceName || '未知源')}<span class="chip">${esc(r.author || '佚名')}</span>${q ? `<span class="chip q-${q}">${qname[q] || ''}</span>` : ''}${on ? '<span class="chip on">正在看</span>' : ''}</div>
            <div class="sw-s">${esc(r.lastChapter || r.bookUrl)}</div>
          </div>
          <button class="btn sm ${on ? '' : 'primary'}">${on ? '当前' : '看这个源'}</button>
        </div>`;
      }).join('')}</div>
      <div class="modal-actions"><button class="btn" onclick="window.__closeModal()">关闭</button></div>`, true);
    $$('#pv-src-list [data-i]').forEach(el => el.onclick = () => {
      const r = list[+el.dataset.i];
      if (!r) return;
      previewOnlineBook(r, list);
    });
  }


  /* ---------------- 网页书预览 ----------------
   * 以前网页搜书只有一个「加入书架」：用户不知道点进去是目录页、详情页还是一篇文章，
   * 加完才发现读不了。这里跟书源预览一样，先把书名/简介/目录/正文摆出来再决定。
   * 目录补全统一交给 Engine.sniffBook（见引擎里的「网页书嗅探」）。 */

  /** 用嗅探出来的规则拼一个临时「源」，正文/目录都能像书源那样取 */
  function webPseudoSource(url, d) {
    let site = '';
    try { site = new URL(url).origin; } catch (e) { site = ''; }
    return {
      id: '__web', name: '网页抓取', url: site, charset: 'auto', type: 'web',
      headers: site ? { Referer: site + '/' } : undefined,
      ruleSearch: {}, ruleBookInfo: {},
      ruleToc: (d && d.toc && d.toc.rule) || {},
      ruleContent: (d && d.content) ? { content: d.content.selector } : {}
    };
  }

  async function previewWebBook(url, preset) {
    openModal(`<div class="pv-top">
        <div class="pv-cover ph">…</div>
        <div class="pv-meta">
          <div class="pv-name">正在分析页面…</div>
          <div class="pv-author">${esc(hostOf(url))}</div>
          <div class="pv-tags"><span class="chip tag">网页抓取</span></div>
          <div class="pv-intro">正在读取这本书的目录和简介，稍等。</div>
        </div>
      </div>
      <div class="pv-toc-head">目录 <span class="sub" id="pv-count"></span></div>
      <div class="pv-toc" id="pv-toc"><div class="hint">正在获取…</div></div>
      <div class="modal-actions">
        <button class="btn left" id="pv-try" disabled>试读</button>
        <button class="btn" onclick="window.__closeModal()">关闭</button>
        <button class="btn primary" id="pv-add" disabled>加入书架</button>
      </div>`, true);

    const t0 = Date.now();
    const box = $('#pv-toc');
    let painted = '';

    /* 先把手上已有的东西画出来（目录可能只有「最新章节」十来条），补全后再画一次。
       这样点开就有反应，而不是盯着「正在获取…」等两三个往返。 */
    const paint = (d, finalUrl, partial) => {
      const info = d.info || {};
      const name = (info.name || d.title || hostOf(finalUrl) || '未命名').replace(/[_-].*$/, '').trim().slice(0, 40) || '未命名';
      const chapters = d.toc ? d.toc.chapters : [];
      const comicN = d.comic ? d.comic.count : 0;
      const r = {
        name, author: info.author || '佚名', bookUrl: finalUrl,
        coverUrl: info.coverUrl || '', intro: info.intro || '',
        sourceName: '网页抓取', __web: true
      };
      const src = webPseudoSource(finalUrl, d);

      const top = $('.pv-top');
      if (top) {
        top.querySelector('.pv-cover').outerHTML = `<div class="pv-cover ${r.coverUrl ? '' : 'ph'}">${r.coverUrl ? `<img src="${esc(r.coverUrl)}" alt="" onerror="this.parentNode.classList.add('ph')">` : esc(name[0])}</div>`;
        top.querySelector('.pv-name').textContent = name;
        top.querySelector('.pv-author').textContent = r.author;
        top.querySelector('.pv-tags').innerHTML = `<span class="chip tag">${esc(Engine.siteLabel(hostOf(finalUrl)) || '网页抓取')}</span>`
          + (comicN >= 2 ? '<span class="chip">漫画</span>' : '')
          + (chapters.length ? `<span class="chip">${chapters.length} 章</span>` : '');
        top.querySelector('.pv-intro').textContent = r.intro || (comicN >= 2 ? '这一页是漫画图，没有简介。' : '（这个页面没有简介）');
      }

      const cnt = $('#pv-count');
      const secs = ((Date.now() - t0) / 1000).toFixed(1);
      if (cnt) cnt.textContent = chapters.length
        ? `共 ${chapters.length} 章${partial ? ' · 正在补全…' : ` · ${secs}s`}`
        : (comicN >= 2 ? `图片 ${comicN} 张` : (partial ? '正在找目录…' : '没有找到目录'));

      const addBtn = $('#pv-add'), tryBtn = $('#pv-try');
      addBtn.disabled = false;
      addBtn.textContent = '加入书架';
      addBtn.onclick = async () => {
        addBtn.disabled = true; addBtn.textContent = '添加中…';
        try {
          await addWebBook(finalUrl, d);
          addBtn.textContent = '已加入';
        } catch (e) {
          addBtn.disabled = false; addBtn.textContent = '加入书架';
          toast('加入失败：' + (e.message || e));
        }
      };
      const back = () => previewWebBook(finalUrl);

      if (chapters.length) {
        const key = chapters.length + '|' + (partial ? 1 : 0);
        if (painted !== key) {
          painted = key;
          const show = chapters.slice(0, 40);
          box.innerHTML = show.map((c, i) =>
            `<button class="pv-ch" data-ci="${i}">${esc(c.title)}</button>`).join('')
            + (chapters.length > show.length || partial
              ? `<div class="hint">${partial ? '正在补全目录' : `只显示前 ${show.length} 章`}，共 ${chapters.length} 章</div>` : '');
          $$('.pv-ch').forEach(b => {
            b.onclick = () => readPreview(r, src, chapters[+b.dataset.ci], null, back);
          });
          box.scrollTop = 0;
        }
        tryBtn.disabled = false;
        tryBtn.onclick = () => readPreview(r, src, chapters[0], null, back);
      } else if (comicN >= 2) {
        box.innerHTML = `<div class="hint">这一页是漫画图（${comicN} 张），没有目录 —— 加入后按「单页」读，点下面的「试读」先看看图能不能正常显示。</div>`;
        tryBtn.disabled = false;
        tryBtn.onclick = () => readPreview(r, src, { title: name, url: finalUrl }, null, back);
      } else {
        box.innerHTML = `<div class="hint">${partial ? '正在找这本书的目录…' : '这个页面里没有目录，只有一篇正文 —— 加入后只有这一页，不能按章翻。<br>想要按章读，请打开这本书的目录页再预览。'}</div>`;
        tryBtn.disabled = !partial;
      }
      return r;
    };

    try {
      let html = '', finalUrl = (preset && preset.url) || url;
      let d = preset && preset.d;
      if (!d) {
        const r = await netGet({ url, charset: 'auto', timeout: 15000 });
        if (!r || r.ok === false) throw new Error('打不开这个地址：' + ((r && r.error) || '网络错误'));
        html = r.text || '';
        finalUrl = r.url || url;
        d = Engine.detectPage(html, finalUrl);
      } else if (preset.html) {
        html = preset.html;
      } else {
        /* 只给了分析结果没给原文：补一次（有缓存，通常 0ms） */
        const r = await netGet({ url: finalUrl, charset: 'auto', timeout: 15000 });
        if (r && r.ok !== false) html = r.text || '';
      }
      if (d.serp) throw new Error('这是搜索结果页，不是书；点下面某一条进到书页再预览');
      if (Engine.pageBlocked(html, d.title)) throw new Error('这个站拦了自动抓取（人机验证），换一家站再试');

      paint(d, finalUrl, true);

      /* 补全目录：同页「目录」链接 / 章节页的「返回目录」/ 站点固定路径，三条路并行 */
      const res = await Engine.sniffBook(netGet, finalUrl, {
        page: html ? { html, url: finalUrl } : null,
        detected: d, timeout: 15000
      });
      const full = paint(res.d, res.url, false);

      /* 预热第一章：点「试读」时不用再等一个完整往返 */
      const ch0 = res.d.toc && res.d.toc.chapters[0];
      if (ch0) netGet({ url: ch0.url, charset: 'auto', timeout: 12000 }).catch(() => { });
      if (full && !res.d.toc && res.d.url !== finalUrl) finalUrl = res.d.url;
    } catch (e) {
      box.innerHTML = `<div class="hint">${esc(e.message || e)}</div>`;
    }
  }

  /** 弹窗里读一章（不加入书架也能看，判断这本书到底对不对） */
  async function readPreview(r, src, ch, alts, back) {
    openModal(`<h3 class="pv-title">${esc(r.name)}</h3>
      <div class="pv-ch-title">${esc(ch.title)}</div>
      <div class="pv-read" id="pv-read"><div class="hint">正在加载…</div></div>
      <div class="modal-actions">
        <button class="btn left" id="pv-back">返回目录</button>
        <button class="btn primary" id="pv-add2">加入书架</button>
      </div>`, true);
    $('#pv-back').onclick = () => (typeof back === 'function' ? back() : previewOnlineBook(r, alts));
    $('#pv-add2').onclick = async () => {
      const b = $('#pv-add2');
      b.disabled = true; b.textContent = '添加中…';
      try {
        if (r.__web) await addWebBook(r.bookUrl);
        else await addOnlineBook(r);
        b.textContent = '已加入';
      } catch (e) {
        b.disabled = false; b.textContent = '加入书架';
        toast('加入失败：' + (e.message || e));
      }
    };
    const box = $('#pv-read');
    try {
      const c = await withTimeout(Engine.getContent(netGet, src, ch.url), 20000);
      let paras = c.paras || [];
      if (c.blocked) throw new Error('这个站要求人机验证（或本章是 VIP 章节），过一会儿再试，或换个源');
      if (c.fail === 'json') throw new Error('这个源的正文是加密接口（返回 JSON 密文），本机解不开');
      if (paras.some(isRemoteImg)) paras = await resolveImgs(paras, src);
      if (!paras.length) throw new Error('正文为空');
      box.innerHTML = parasMap(paras, 360);
    } catch (e) {
      box.innerHTML = `<div class="hint">这一章打不开：${esc(e.message || e)}<br>正文规则可能失效，换个源试试。</div>`;
    }
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
      const toc = await Engine.getToc(netGet, src, r.bookUrl);
      const chapters = toc.chapters, info = toc.info || {};
      book.chapters = chapters;
      book.total = chapters.length;
      if (toc.tocUrl) book.tocUrl = toc.tocUrl;
      if (info.intro) book.intro = info.intro;
      if (info.coverUrl) book.cover = info.coverUrl;
      if (info.author) book.author = info.author;
      save(true);
      renderShelf();
      if (!chapters.length) toast(`《${book.name}》已加入，但这个源没给目录 —— 在书架里长按「换源」换一个源`);
      else toast(`《${book.name}》目录 ${chapters.length} 章`);
    } catch (e) {
      toast('目录获取失败：' + (e.message || e));
    }
    return book;
  }

  /* ===========================================================
     网页搜书（抓页面 → 本机识别 → 加书架）
     =========================================================== */
  const ENGINES = {
    bing: k => 'https://www.bing.com/search?q=' + encodeURIComponent(k),
    baidu: k => 'https://www.baidu.com/s?wd=' + encodeURIComponent(k),
    sogou: k => 'https://www.sogou.com/web?query=' + encodeURIComponent(k),
    so360: k => 'https://www.so.com/s?q=' + encodeURIComponent(k)
  };

  function isUrlLike(s) {
    return /^(https?:\/\/|www\.)\S+$/i.test(s.trim());
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

  const WA = { built: false, stack: [], busy: false, lastUrl: '', query: '', upTok: 0, elapsed: 0 };

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

  /* 搜索结果页里的「网页」模式：抓一页、按书归并成卡片，落在 #search-results 里。
     和书源搜索共用同一个结果区，卡片样式也一样。 */
  async function runWebSearch(kw, seq) {
    const box = $('#search-results');
    if (!box) return;
    const engName = (ENGINE_NAMES.find(e => e[0] === webEngine()) || [, '必应'])[1];
    const sub = $('#search-sub');
    if (sub) sub.textContent = `网页 · ${engName} · 抓取后在本机识别`;
    box.innerHTML = `<div class="wa-tools">
        <button class="btn xs" id="wa-back" disabled>← 返回上一页</button>
        <span class="wa-hint-s">搜不到就换个引擎，或直接把小说站的目录页网址粘进来</span>
      </div>
      <div class="wa-list" id="wa-list"></div>`;
    WA.stack = [];
    WA.busy = false;
    WA.lastUrl = '';
    const back = $('#wa-back');
    if (back) back.onclick = () => {
      const prev = WA.stack.pop();
      if (back) back.disabled = !WA.stack.length;
      if (prev) waFetch(prev, true);
    };
    await waFetch(kw);
    if (seq !== searchSeq) return;
  }

  function waHome() {
    WA.lastUrl = '';
    const box = $('#wa-list');
    if (!box) return;
    box.innerHTML = `
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
    if (!list) return;                       // 已经离开搜索页
    if (!isBack && WA.lastUrl && WA.lastUrl !== url) {
      WA.stack.push(WA.lastUrl);
      if (WA.stack.length > 12) WA.stack.shift();
    }
    const backBtn = $('#wa-back');
    if (backBtn) backBtn.disabled = !WA.stack.length;
    const inp = $('#wa-input');
    if (inp) inp.value = raw;
    WA.query = isUrlLike(raw) ? '' : raw;
    WA.busy = true;
    WA.upTok = (WA.upTok || 0) + 1;
    list.innerHTML = `<div class="wa-loading"><i></i><span>正在抓取 ${esc(hostOf(url) || '页面')} …</span></div>`;
    const t0 = Date.now();
    let r;
    try {
      r = await netGet({ url, charset: 'auto', timeout: 15000 });
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
    /* 被反爬拦下来的页面通常很短且带验证字样，直接说清楚，别让用户以为是站点没内容 */
    const blocked = Engine.pageBlocked(txt, (txt.match(/<title>([\s\S]*?)<\/title>/i) || [])[1]);
    if (blocked) {
      list.innerHTML = `
        <div class="wa-card bad">
          <div class="wa-card-t">这个站拦了自动抓取</div>
          <div class="wa-card-s">${esc(hostOf(finalUrl))} ${blocked === 'cloudflare' ? '走了 Cloudflare 人机验证' : '要求人机验证'}，换个搜索引擎或换一家站点试试。</div>
        </div>
        <div class="wa-src">${esc(hostOf(finalUrl))}</div>`;
      return;
    }
    const serpHint = isSerpUrl(finalUrl) || !WA.query;
    let d;
    try {
      /* 搜索页只要链接：跳过目录/正文/漫画那一圈，页面再大也是毫秒级 */
      d = Engine.detectPage(txt, finalUrl, serpHint ? { light: true } : undefined);
    } catch (e) {
      d = { info: {}, toc: null, content: null, links: [], title: '', serp: false };
    }
    WA.elapsed = Date.now() - t0;
    renderWaResult(d, finalUrl, isSerpUrl(finalUrl) || !!d.serp, { html: txt, upgrading: !d.toc || (d.toc.chapters || []).length < 15 });
    /* 详情页常常只挂十来章「最新章节」：先把页面画出来，再后台把真目录补上 */
    if (!d.serp && !isSerpUrl(finalUrl)) upgradeWa(finalUrl, d, txt);
  }

  /** 后台补全目录：升级后如果章数变多/多出正文，就重画一次 */
  async function upgradeWa(url, d, html) {
    const tok = WA.upTok || 0;
    const t0 = Date.now();
    if (d.toc && d.toc.chapters.length >= 30) return;
    const box = $('#wa-list');
    const card = box && box.querySelector('.wa-card.ok [data-up-tip], .wa-card.ok .wa-up-tip');
    if (card) card.textContent = '正在补全目录…';
    let res;
    try {
      res = await Engine.sniffBook(netGet, url, { page: html ? { html, url } : null, detected: d, timeout: 15000 });
    } catch (e) { return; }
    if (tok !== (WA.upTok || 0)) return;              // 用户已经翻到别的页面了
    const before = d.toc ? d.toc.chapters.length : 0;
    const after = res.d.toc ? res.d.toc.chapters.length : 0;
    if (after <= before && !(!d.content && res.d.content)) return;
    renderWaResult(res.d, res.url, false, { noUpgrade: true, elapsed: Date.now() - t0 });
  }

  function renderWaResult(d, url, serp, opts) {
    const list = $('#wa-list');
    if (!list) return;
    const o = opts || {};
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
    const tocN = d.toc ? d.toc.chapters.length : 0;
    const chars = d.content ? d.content.chars : 0;
    const comicN = d.comic ? d.comic.count : 0;
    const name = (d.info && d.info.name) || d.title || host || '未识别书名';
    const author = (d.info && d.info.author) || '';
    const elapsed = o.elapsed != null ? o.elapsed : (WA.elapsed || 0);

    /* ---------- 搜索页：按「书」归并成卡片，站点做成标签（跟书源搜索一致） ---------- */
    if (serp) {
      const key = WA.query || '';
      const books = Engine.serpBooks(d.links || [], key);
      const others = books.length ? [] : links.slice(0, 20);
      const secs = elapsed ? ` · ${(elapsed / 1000).toFixed(1)}s` : '';
      const head = `<div class="wa-src">${esc(host)} · ${books.length
        ? `${books.length} 本书 · 同一本在多个站会合成一张卡`
        : '没在这一页读到书'}${secs}</div>`;
      if (!books.length) {
        list.innerHTML = head + `
          <div class="wa-card bad">
            <div class="wa-card-t">这一页没读出能读的书</div>
            <div class="wa-card-s">可能是搜索引擎限流，或结果页版式变了。换个引擎再搜一次，或换一个短一点的关键词；
              如果结果里有「XX小说网」，也可以直接点下面的链接进去。</div>
          </div>
          ${links.length ? `<div class="wa-label">页面里的链接 · ${links.length}</div>
            <div class="wa-items">${waItemHtml(links, 0)}</div>` : ''}`;
        bindWaItems(links);
        return;
      }
      list.innerHTML = head + `<div class="wb-tip">点站点标签换站 · 「预览」可以先看目录和正文再决定</div>
        <div class="wb-list">${books.map((g, i) => {
        const first = g.sites[0];
        return `<div class="wb-card" data-bi="${i}" data-cur="${esc(first.url)}">
          <div class="wb-head">
            <div class="wb-cover">${esc((g.name || '?')[0])}</div>
            <div class="wb-info">
              <div class="wb-name">${esc(g.name)}</div>
              <div class="wb-sub">${esc(g.author || '佚名')}${g.sites.length > 1 ? ` · ${g.sites.length} 个站` : ''}</div>
              <div class="wb-sites">${g.sites.map((s, j) => `<button class="wb-site${j === 0 ? ' on' : ''}" data-bs="${i}:${j}" data-u="${esc(s.url)}">${esc(s.label)}</button>`).join('')}</div>
            </div>
          </div>
          <div class="wb-act">
            <button class="btn sm primary" data-bp="${i}">预览</button>
            <button class="btn sm" data-ba="${i}">加入书架</button>
          </div>
        </div>`;
      }).join('')}</div>
      ${links.length ? `<button class="wa-more" id="wa-more">全部 ${links.length} 条原始结果（含百科、视频等）</button>
        <div class="wa-items" id="wa-others" hidden>${waItemHtml(links, 0)}</div>` : ''}`;

      $$('[data-bs]').forEach(el => el.onclick = e => {
        e.stopPropagation();
        const card = el.closest('.wb-card');
        $$('.wb-site', card).forEach(x => x.classList.remove('on'));
        el.classList.add('on');
        card.dataset.cur = el.dataset.u;
      });
      $$('[data-bp]').forEach(b => b.onclick = e => {
        e.stopPropagation();
        const card = b.closest('.wb-card');
        previewWebBook(card.dataset.cur);
      });
      $$('[data-ba]').forEach(b => b.onclick = async e => {
        e.stopPropagation();
        const u = b.closest('.wb-card').dataset.cur;
        b.disabled = true; b.textContent = '分析中…';
        try { await addWebBook(u); b.textContent = '已加入'; b.classList.add('done'); }
        catch (err) { b.disabled = false; b.textContent = '加入书架'; toast('加入失败：' + (err.message || err)); }
      });
      const more = $('#wa-more');
      if (more) more.onclick = () => {
        const box = $('#wa-others');
        box.hidden = !box.hidden;
        more.textContent = box.hidden ? `全部 ${links.length} 条原始结果（含百科、视频等）` : '收起原始结果';
      };
      bindWaItems(links);
      return;
    }

    /* ---------- 普通页面：目录页 / 漫画页 / 单页正文 ---------- */
    const readable = !!(d.toc || d.content);
    const partial = tocN > 0 && tocN < 15 && !o.noUpgrade;
    let card;
    if (tocN >= 3) {
      card = `<div class="wa-card ok">
           <div class="wa-card-t">${esc(String(name).slice(0, 40))}</div>
           <div class="wa-card-s">${esc(author || '佚名')} · 目录 ${tocN} 章${comicN ? ` · 图片 ${comicN} 张` : ''}${chars ? ` · 正文 ${chars} 字` : ''}</div>
           ${partial ? '<div class="wa-up-tip">正在补全目录…</div>' : ''}
           <div class="wa-card-a">
             <button class="btn sm primary" id="wa-add">加入书架</button>
             <button class="btn sm" id="wa-prev2">预览</button>
             ${d.toc ? `<button class="btn sm" id="wa-add-toc">只导入目录</button>` : ''}
           </div>
         </div>`;
    } else if (comicN >= 2) {
      card = `<div class="wa-card ok">
           <div class="wa-card-t">${esc(String(name).slice(0, 40))} <span class="chip">漫画</span></div>
           <div class="wa-card-s">这一页是漫画图（${comicN} 张），没有目录。加入后按「单话」读，翻页看下一话要回到目录页重新加。</div>
           <div class="wa-card-a">
             <button class="btn sm primary" id="wa-add">加入书架（就这一话）</button>
             <button class="btn sm" id="wa-prev2">预览</button>
           </div>
         </div>`;
    } else if (chars && !d.content.weak) {
      card = `<div class="wa-card bad">
           <div class="wa-card-t">这一页是一篇网页正文，不是书的目录</div>
           <div class="wa-card-s">${esc(String(name).slice(0, 30))} · ${chars} 字。加入后只有这一页，不能按章翻。建议先找到这本书的目录页（下面带「目录 / 章节列表」的条目），再从那页加。</div>
           <div class="wa-card-a"><button class="btn sm" id="wa-add">仍然按单页加入</button></div>
         </div>`;
    } else {
      card = `<div class="wa-card bad">
           <div class="wa-card-t">这一页没有目录或正文</div>
           <div class="wa-card-s">${(partial || o.upgrading) ? '正在找这本书的目录…' : (links.length ? '多半是书籍详情页：点下面「目录」那类条目进目录页，或直接用下面的结果预览' : '换个链接，或把小说站的目录页地址直接粘进来')}</div>
         </div>`;
    }
    /* 认出来是一本书之后，页面上那些「武侠仙侠 / 作品百科」的导航链接就没用了，
       默认收起来，免得把书卡挤下去 */
    list.innerHTML = `
      <div class="wa-src">${esc(host)}${readable ? '' : ' · 只作浏览'}${elapsed ? ` · ${(elapsed / 1000).toFixed(1)}s` : ''}</div>
      ${card}
      ${links.length ? `<button class="wa-more" id="wa-links">页面里的链接 · ${links.length}</button>
        <div class="wa-items" id="wa-links-box" ${readable ? 'hidden' : ''}>${waItemHtml(links, 0)}</div>` : ''}`;
    const lk = $('#wa-links');
    if (lk) lk.onclick = () => {
      const box2 = $('#wa-links-box');
      box2.hidden = !box2.hidden;
      lk.textContent = box2.hidden ? `页面里的链接 · ${links.length}` : '收起页面里的链接';
    };

    const addBtn = $('#wa-add');
    if (addBtn) {
      addBtn.onclick = async () => {
        addBtn.disabled = true; addBtn.textContent = '分析中…';
        try {
          await addWebBook(url, readable ? d : null);
          addBtn.textContent = '已加入';
        } catch (e) {
          addBtn.disabled = false;
          addBtn.textContent = '加入书架';
          toast('加入失败：' + (e.message || e));
        }
      };
    }
    const pv2 = $('#wa-prev2');
    if (pv2) pv2.onclick = () => previewWebBook(url, { d, url });
    const at = $('#wa-add-toc');
    if (at) at.onclick = () => addWebBook(url, d, true);
    bindWaItems(links);
  }

  function waItemHtml(links) {
    return links.map((l, i) => `<span class="wa-item" data-wa-open="${i}">
            <span class="wa-item-t">${esc(l.title)}</span>
            <span class="wa-item-u">${esc(hostOf(l.url) || '')}</span>
            <span class="wa-item-a">
              <button class="btn xs primary" data-wa-prev="${i}">预览</button>
              <button class="btn xs" data-wa-add="${i}">加入书架</button>
            </span>
          </span>`).join('');
  }

  function bindWaItems(links) {
    $$('[data-wa-open]').forEach(el => {
      el.onclick = e => {
        if (e.target.closest('button')) return;
        waFetch(links[+el.dataset.waOpen].url);
      };
    });
    /* 网页搜出来的每一条也能先预览再决定加不加，跟书源搜索一致 */
    $$('[data-wa-prev]').forEach(b => b.onclick = e => {
      e.stopPropagation();
      previewWebBook(links[+b.dataset.waPrev].url);
    });
    $$('[data-wa-add]').forEach(b => b.onclick = async e => {
      e.stopPropagation();
      b.disabled = true; b.textContent = '分析中…';
      try { await addWebBook(links[+b.dataset.waAdd].url); b.textContent = '已加入'; }
      catch (err) { b.disabled = false; b.textContent = '加入书架'; toast('加入失败：' + (err.message || err)); }
    });
  }

  /** 把一个网页地址变成书架里的书：抓页面 → 找目录/正文 → 生成规则 */
  /**
   * 漫画单页站：顺着「下一话 / 下一章」把后面几话串起来（最多 12 话）。
   * 不加这一步，加了书架也只有一页图，读者每话都得回浏览器里重新加一次。
   */
  async function expandComicChain(startUrl, d0) {
    const out = [{ title: (d0.info.name || d0.title || '第1话').trim().slice(0, 40), url: startUrl }];
    const seen = new Set([startUrl]);
    let curUrl = startUrl, curHtml = d0.__html || '';
    for (let i = 0; i < 12; i++) {
      if (!curHtml) {
        const r = await netGet({ url: curUrl, charset: 'auto' }).catch(() => null);
        if (!r || r.ok === false) break;
        curHtml = r.text;
      }
      const next = Engine.nextChapterLink(curHtml, curUrl);
      if (!next || seen.has(next)) break;
      seen.add(next);
      const r2 = await netGet({ url: next, charset: 'auto' }).catch(() => null);
      if (!r2 || r2.ok === false) break;
      const dd = Engine.detectPage(r2.text, r2.url || next);
      if (dd.serp) break;
      const t = (dd.info.name || dd.title || '').trim().slice(0, 40) || ('第' + (out.length + 1) + '话');
      out.push({ title: t, url: r2.url || next });
      curUrl = r2.url || next;
      curHtml = r2.text;
    }
    return out;
  }

  async function addWebBook(url, detected, forceToc) {
    if (!url) return;
    const exists = S.state.books.find(b => b.bookUrl === url);
    if (exists) { toast('这本已经在书架里了'); return exists; }
    /* 搜索结果页 / 首页 / 分类页不是书：加进去就是「只能看网站首页」那种假书 */
    if (isSerpUrl(url)) throw new Error('这是搜索结果页，不是书；先点进书籍详情页再添加');

    /* 目录、正文规则、漫画判定一次嗅完；同一页刚才预览过，这里基本全命中缓存 */
    const res = await Engine.sniffBook(netGet, url, { detected: detected || null, timeout: 15000 });
    const d = res.d;
    url = res.url || url;
    if (d.serp) throw new Error('这一页是搜索结果，点进书籍页面再加');
    if (!d.toc && !d.content) throw new Error('这个页面里没有找到目录或正文；如果是详情页，先点「目录」进去再加');

    const name = (d.info.name || d.title || '未命名').replace(/[_-].*$/, '').trim().slice(0, 40) || '未命名';
    /* 有目录 = 按章读；没目录但有图 = 漫画，先顺着「下一话」把后面几话串起来 */
    const isComic = !d.toc && !!(d.comic && d.comic.count >= 2);
    let chapters;
    if (d.toc) chapters = d.toc.chapters;
    else if (isComic) chapters = await expandComicChain(url, d);
    else chapters = [{ title: name + '（单页）', url }];
    const book = {
      id: uid('W'), name, author: d.info.author || '佚名', kind: isComic ? 'comic' : 'web',
      bookUrl: url, sourceName: isComic ? '网页抓取 · 漫画' : '网页抓取',
      intro: d.info.intro || '', cover: d.info.coverUrl || '', total: chapters.length,
      chapters,
      webRule: {
        toc: d.toc ? d.toc.rule : null,
        content: d.content ? { content: d.content.selector } : null,
        siteUrl: (() => { try { return new URL(url).origin; } catch (e) { return ''; } })()
      },
      groupId: 'g_default', createdAt: Date.now(), updatedAt: Date.now()
    };

    if (!book.chapters.length && forceToc) throw new Error('这一页没有目录');

    upsertBook(book);
    renderShelf();
    toast(isComic
      ? `已加入《${book.name}》· 漫画单话（只有这一页）`
      : `已加入《${book.name}》${book.total > 1 ? '· ' + book.total + ' 章' : '（单页）'}`);
    return book;
  }

  /** 书的取源对象：网页书 / 网页漫画用自己嗅探出来的规则 */
  function srcForBook(b) {
    if (b.kind === 'web' || b.kind === 'comic') {
      const site = b.webRule?.siteUrl || '';
      return {
        id: '__web', name: b.sourceName || '网页抓取', charset: 'auto', url: site,
        /* 漫画站基本都校验 Referer，不带就只给防盗链占位图 */
        headers: site ? { Referer: site + '/' } : undefined,
        ruleSearch: {}, ruleBookInfo: {}, ruleToc: b.webRule?.toc || {}, ruleContent: b.webRule?.content || {}
      };
    }
    const direct = sourceById(b.sourceId);
    if (direct) return direct;
    /* 从原版备份恢复的书可能记的是旧书源 id：源被改名、重建或换了 id 时，
       按备份里的 origin（书源地址）+ originName 再找一次，别让书直接变「缺书源」。 */
    const nu = u => String(u || '').trim().replace(/\/+$/, '').toLowerCase()
      .replace(/^https?:\/\//, '').replace(/^www\./, '');
    const key = nu(b.origin || b.originRaw);
    if (key) {
      const hit = S.state.sources.find(s => nu(s.url) === key && s.name === b.originName)
        || S.state.sources.find(s => nu(s.url) === key);
      if (hit) return hit;
    }
    if (b.originName) {
      const hit = S.state.sources.find(s => s.name === b.originName);
      if (hit) return hit;
    }
    return null;
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

  function renderSources(host) {
    /* 书源页现在长在「扩展」里：只有当前真的停在书源页时才重画，
       否则（比如在设置页改了书源）不要往隐藏容器里塞内容 */
    if (!host) {
      if (!(S.view === 'ext' && S.ext === 'sources')) return;
      host = $('#ext-body');
    }
    const v = host;
    if (!v) return;
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
        const r = await withTimeout(Engine.search(netGet, s, '我的'), 10000);
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
    /* 并发不是越大越快：安卓桥的线程池有限，8 个 worker 只会排队，
       还更容易被站点限流、被误判成「无用」。手机默认 5，电脑 8。 */
    const maxConc = isAndroidApp() ? 8 : 16;
    const defConc = clamp(Number(st.settings.detectConc) || (isAndroidApp() ? 5 : 8), 1, maxConc);
    /* 老存档里这个字段叫 qualityAt，新的是 qAt，两种都认 */
    const qAtOf = s => s.qAt || s.qualityAt || 0;
    const freshN = st.sources.filter(s => qAtOf(s) && Date.now() - qAtOf(s) < 3 * 86400e3).length;

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
          <label>并发数 <span id="dt-conc-n">${defConc}</span>${isAndroidApp() ? '<span>手机建议 4~6</span>' : ''}</label>
          <input type="range" id="dt-conc" min="2" max="${maxConc}" value="${defConc}" />
        </div>
        <div class="field full">
          <label class="cb"><input type="checkbox" id="dt-deep" checked /> 深度检测：抓目录和正文（更准，每个源多花几秒）</label>
        </div>
        <div class="field full">
          <label class="cb"><input type="checkbox" id="dt-fresh" checked /> 跳过 3 天内检测过的（${freshN} 个，重测请取消）</label>
        </div>
      </div>
      ${done ? `<p class="desc" style="margin-top:12px">已检测过 ${done} 个，再次检测会覆盖旧结果。</p>` : ''}
      <p class="desc">判定口径：站点打不开才算「无用」；站点能打开但搜不到 / 规则不适配，只算「较差」。</p>
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
    const skipFresh = $('#dt-fresh').checked;
    st.settings.detectConc = conc;
    save();

    let targets = scope === 'filtered' ? srcFiltered() : scope === 'enabled' ? st.sources.filter(s => s.enabled) : st.sources.slice();
    targets = targets.filter(s => s.url || s.searchUrl);
    const before = targets.length;
    if (skipFresh) {
      const cutoff = Date.now() - 3 * 86400e3;
      targets = targets.filter(s => { const t = s.qAt || s.qualityAt || 0; return !t || t < cutoff; });
    }
    const skippedFresh = before - targets.length;
    if (!targets.length) {
      toast(skippedFresh ? `${skippedFresh} 个书源都是 3 天内检测过的，取消「跳过」可重测` : '没有可检测的书源');
      return;
    }

    /* 书架里用过的源，直接拿那本书的地址深检，比搜索关键词更靠谱 */
    const probe = new Map();
    for (const b of st.books) if (b.sourceId && b.bookUrl) probe.set(b.sourceId, b.bookUrl);

    detectAbort = false;
    const live = $('#dt-live');
    $('#dt-start').disabled = true;
    $('#dt-scope').disabled = true;
    live.innerHTML = `
      <div class="dt-bar"><i id="dt-bar-i"></i></div>
      <div class="dt-line"><span id="dt-cur">准备中…</span><span id="dt-count">0 / ${targets.length}${skippedFresh ? ` · 跳过 ${skippedFresh} 个新测过的` : ''}</span></div>
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
      timeout: isAndroidApp() ? 7000 : 8000,
      probeUrlOf: s => probe.get(s.id) || '',
      shouldStop: () => detectAbort,
      onProgress: (done, total, sum, r) => {
        const pct = Math.round(done / total * 100);
        const bar = $('#dt-bar-i');
        if (bar) bar.style.width = pct + '%';
        const cur = $('#dt-cur');
        if (cur) cur.textContent = `${done}/${total} · ${r.name.slice(0, 18)} → ${Q_NAME[r.quality] || ''}${r.note ? '（' + r.note + '）' : ''}`;
        const c = $('#dt-count');
        if (c) {
          const sec = Math.max(1, Math.round((Date.now() - t0) / 1000));
          const left = done > 0 ? Math.max(0, Math.round(sec / done * (total - done))) : 0;
          c.textContent = `${done} / ${total} · 已用 ${sec}s${done > 0 && left ? ` · 约剩 ${left}s` : ''}${skippedFresh ? ` · 跳过 ${skippedFresh}` : ''}`;
        }
        for (const k of ['great', 'ok', 'poor', 'dead']) {
          const el = $('#dt-n-' + k);
          if (el) el.textContent = `${Q_NAME[k]} ${sum[k] || 0}`;
        }
        /* 增量落盘，避免中断后白测。安卓端写盘是同步的，每 30 个写一次，
           几千个书源时不会因为反复序列化整份存档而拖慢检测。 */
        if (done - lastSave >= 30) { lastSave = done; save(true); }
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
        <p class="desc">共测 ${res.total} 个${skippedFresh ? `（跳过 ${skippedFresh} 个 3 天内测过的）` : ''}${res.stopped ? '（已中断）' : ''}，用时 ${sec} 秒${deep ? '' : '（未深检，只测了搜索）'}。</p>
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
    let arr = [];
    if (Array.isArray(json)) arr = json;
    else if (json && typeof json === 'object') {
      for (const k of ['bookSource', 'bookSources', 'sources', 'data', 'bookSourceList']) {
        if (Array.isArray(json[k])) { arr = json[k]; break; }
      }
    }
    if (!arr.length) arr = [json];
    return arr.filter(x => x && (x.bookSourceName || x.name)).map(Engine.normalizeSource);
  }

  function mergeSources(list) {
    let added = 0, updated = 0;
    /* 按站点地址去重：同一个书源改过名字、或 url 多一个尾部斜杠，
       以前会因为 name 不匹配而被重复添加，导几次就堆出几十条。
       先建索引：手机备份动辄两三千个书源，逐个 find 是 O(n²)，会卡到像死机。 */
    const norm = u => String(u || '').trim().replace(/\/+$/, '').toLowerCase();
    const idx = new Map();
    for (const s of S.state.sources) {
      const k = norm(s.url);
      if (k && !idx.has(k)) idx.set(k, s);
    }
    for (const s of list) {
      const key = norm(s.url);
      const old = key ? idx.get(key) : null;
      if (old) { Object.assign(old, s, { id: old.id, enabled: old.enabled }); updated++; }
      else { S.state.sources.push(s); added++; if (key) idx.set(key, s); }
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

  /* 书签不再是独立页面：它按书归属，放在阅读器的目录面板里（见 buildBookmarks） */

  /* ---------------- 阅读历史 ---------------- */
  function renderHistory(host) {
    if (!host) {
      if (!(S.view === 'ext' && S.ext === 'history')) return;
      host = $('#ext-body');
    }
    const v = host;
    if (!v) return;
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
      openReader(h.bookId, h.ci, null, h.title);
    });
    const c = $('#clear-hist');
    if (c) c.onclick = () => {
      if (!confirm('清空全部阅读历史？')) return;
      S.state.history = []; save(true); renderHistory();
    };
  }

  /* ---------------- 阅读统计 ---------------- */
  function renderStats(host) {
    if (!host) {
      if (!(S.view === 'ext' && S.ext === 'stats')) return;
      host = $('#ext-body');
    }
    const v = host;
    if (!v) return;
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

  /* ---------------- 设置 ----------------
   * 设置项越加越多（阅读、朗读、书架、搜索、备份、同步、关于），以前一页铺到底，
   * 手机上要往下划十几屏才找得到「关于」。现在和「扩展」一样做两级：进设置先看
   * 一屏模块卡片（右边挂当前状态），点进去只看那一组开关。
   * 卡片仍然一次性渲染、事件一次性绑好，子页只是把别的卡片 hidden 掉，
   * 所以来回切不会丢监听，改动也照旧即时生效。 */
  const SET = [
    {
      k: 'read', name: '阅读', desc: '字号 · 行距 · 字体 · 翻页',
      icon: '<path d="M4 5.6h6.4a2 2 0 0 1 2 2V19a1.9 1.9 0 0 0-1.9-1.9H4z"/><path d="M20 5.6h-6.4a2 2 0 0 0-2 2V19a1.9 1.9 0 0 1 1.9-1.9H20z"/>',
      stat: () => { const s = S.state.settings; return `${s.fontSize}px · ${s.lineHeight.toFixed(1)} 行距`; }
    },
    {
      k: 'tts', name: '朗读', desc: '音色 · 语速 · 自动下一章',
      icon: '<path d="M4 9.6h3l4.4-3.5v11.8L7 14.4H4z"/><path d="M16 8.7a4.7 4.7 0 0 1 0 6.6"/><path d="M18.6 6.1a8.2 8.2 0 0 1 0 11.8"/>',
      stat: () => S.state.settings.tts.autoNext ? '自动下一章' : '读完停下'
    },
    {
      k: 'shelf', name: '书架', desc: '排序方式 · 封面大小',
      icon: '<path d="M4 19h16"/><path d="M6.4 19V7.6a1.6 1.6 0 0 1 1.6-1.6h.5a1.6 1.6 0 0 1 1.6 1.6V19"/><path d="M10.6 19V6.8l3.8-1.2V19"/><path d="M14.4 19V8.6l3.9-1.2V19"/>',
      stat: () => (SHELF_SORTS.find(o => o.k === shelfSortKey()) || SHELF_SORTS[0]).name
    },
    {
      k: 'search', name: '搜索与网络', desc: '并发 · 书源数 · 代理',
      icon: '<circle cx="11" cy="11" r="6.4"/><path d="M15.8 15.8L20 20"/>',
      stat: () => `${S.state.settings.maxConcurrent || 2} 并发 · 搜 ${S.state.settings.searchLimit || 40} 源`
    },
    {
      k: 'data', name: '数据与备份', desc: '目录 · 缓存 · 备份恢复',
      icon: '<ellipse cx="12" cy="6.2" rx="7" ry="2.9"/><path d="M5 6.2v5.8c0 1.6 3.1 2.9 7 2.9s7-1.3 7-2.9V6.2"/><path d="M5 12v5.8c0 1.6 3.1 2.9 7 2.9s7-1.3 7-2.9V12"/>',
      stat: () => S.info.platform === 'web' ? '浏览器存储' : (onDeviceStore() ? '设备目录' : '本机目录')
    },
    {
      k: 'dav', name: '云端同步', desc: '坚果云 / WebDAV 备份',
      icon: '<path d="M7.4 18a4 4 0 0 1-.5-7.96A5 5 0 0 1 16.7 8.6 3.7 3.7 0 0 1 17 18z"/>',
      stat: () => {
        const w = S.state.settings.webdav;
        if (!(w.url && w.user && w.pass)) return '未配置';
        return w.enabled ? (w.lastBackupAt ? '上次 ' + fmtWhen(w.lastBackupAt) : '已配置') : '已配置 · 未启用';
      }
    },
    {
      k: 'system', name: '系统', desc: IS_ANDROID ? '触屏手势 · 窗口行为' : '窗口行为 · 快捷键',
      icon: '<path d="M4 7.2h9M17.6 7.2H20M4 16.8h3.4M11.8 16.8H20"/><circle cx="15.2" cy="7.2" r="2.1"/><circle cx="9.4" cy="16.8" r="2.1"/>',
      stat: () => IS_ANDROID ? '触屏操作' : (S.state.settings.closeToTray ? '× 收进托盘' : '× 直接退出')
    },
    {
      k: 'about', name: '关于', desc: '版本 · 开源地址 · 联系作者',
      icon: '<circle cx="12" cy="12" r="8.2"/><path d="M12 11.2V17M12 7.6h.01"/>',
      stat: () => 'v' + S.info.version
    }
  ];
  const setSecName = () => (SET.find(e => e.k === S.set) || {}).name || '设置';

  function renderSettings() {
    const v = $('#view-settings');
    const s = S.state.settings;
    v.innerHTML = `<div class="page-head"><h1>设置</h1><span class="sub">改动即时生效</span></div>
      <div class="set-wrap">
        <div class="card" data-sec="read">
          <h3>阅读</h3>
          <div class="row"><div class="rl">默认字号</div>
            <input type="range" id="s-fs" min="15" max="30" value="${s.fontSize}" /><span class="rv" id="s-fs-v">${s.fontSize}px</span></div>
          <div class="row"><div class="rl">行距<small>1.6~1.8 最接近纸书，越大一屏字越少</small></div>
            <input type="range" id="s-lh" min="12" max="24" step="1" value="${Math.round(s.lineHeight * 10)}" /><span class="rv" id="s-lh-v">${s.lineHeight.toFixed(1)}</span></div>
          <div class="row"><div class="rl">段距<small>段落之间空多少，只在阅读页生效</small></div>
            <input type="range" id="s-pg" min="0" max="150" step="5" value="${Math.round(paraGapEm(s) * 100)}" /><span class="rv" id="s-pg-v">${paraGapEm(s).toFixed(2)}em</span></div>
          <div class="row"><div class="rl">字体</div>
            <div class="seg" id="s-font"><button data-v="serif" class="${s.fontFamily === 'serif' ? 'on' : ''}">宋体</button>
            <button data-v="sans" class="${s.fontFamily === 'sans' ? 'on' : ''}">黑体</button></div></div>
          <div class="row"><div class="rl">翻页方式</div>
            <div class="seg" id="s-mode"><button data-v="scroll" class="${s.pageMode === 'scroll' ? 'on' : ''}">滚动</button>
            <button data-v="paged" class="${s.pageMode === 'paged' ? 'on' : ''}">翻页</button></div></div>
          <div class="row"><div class="rl">阅读时自动预取下一章<small>翻到章尾直接接上，弱网时少等一会儿</small></div>
            <div class="switch ${s.autoCacheNext ? 'on' : ''}" data-set="autoCacheNext"><i></i></div></div>
        </div>

        <div class="card" data-sec="tts">
          <h3>朗读 <span class="chip">${IS_ANDROID ? '系统语音' : OS_NAME() + ' 系统语音'}</span></h3>
          <div class="row"><div class="rl">音色 / 语速 / 音调<small id="tts-cur">${esc(ttsCurrentLabel())}</small></div>
            <button class="btn sm" id="s-tts">设置</button></div>
          <div class="row"><div class="rl">读完自动下一章</div>
            <div class="switch ${s.tts.autoNext ? 'on' : ''}" id="s-tts-next"><i></i></div></div>
          <div class="row"><div class="rl">试听<small>读一小段，确认音色和语速</small></div>
            <button class="btn sm" id="s-tts-test">播放</button></div>
        </div>

        <div class="card" data-sec="shelf">
          <h3>书架</h3>
          <div class="row"><div class="rl">书架排序<small>也可以直接在书架右上角切换</small></div>
            <select class="w-engine" id="s-shelf-sort">${SHELF_SORTS.map(o => `<option value="${o.k}" ${shelfSortKey() === o.k ? 'selected' : ''}>${o.name}</option>`).join('')}</select></div>
          <div class="row"><div class="rl">封面大小<small>书架上一本书占多大</small></div>
            <div class="seg" id="s-shelf-size">${SHELF_SIZES.map(o => `<button data-v="${o.k}" class="${shelfSizeKey() === o.k ? 'on' : ''}">${o.name}</button>`).join('')}</div></div>
        </div>

        <div class="card" data-sec="search">
          <h3>搜索与网络</h3>
          <div class="row"><div class="rl">搜索并发数<small>同时请求的书源数量，过大容易被限流</small></div>
            <div class="seg" id="s-conc">${[1, 2, 3, 4, 6].map(n => `<button data-v="${n}" class="${s.maxConcurrent === n ? 'on' : ''}">${n}</button>`).join('')}</div></div>
          <div class="row"><div class="rl">每次搜索的书源数<small>书源太多（比如几千个）时只搜一部分，优先书架用到的</small></div>
            <div class="seg" id="s-slimit">${[20, 40, 80, 200].map(n => `<button data-v="${n}" class="${(s.searchLimit || 40) === n ? 'on' : ''}">${n}</button>`).join('')}</div></div>
          <div class="row"><div class="rl">换源时搜索的书源数<small>越多越容易找到同名书，但更慢；书源上千时会自动提高到 48</small></div>
            <div class="seg" id="s-swlimit">${[24, 48, 96].map(n => `<button data-v="${n}" class="${([24, 48, 96].includes(s.switchLimit) ? s.switchLimit : 24) === n ? 'on' : ''}">${n}</button>`).join('')}</div></div>
          ${S.info.platform === 'web' ? `<div class="row"><div class="rl">书源代理地址<small>网页版默认不发起任何网络请求（数据不出设备）。填入你自部署的代理服务后可用在线书源与搜书；留空只能读本地书</small></div>
            <input class="inp" id="web-proxy" value="${esc((() => { try { const v = localStorage.getItem('moread.proxy'); if (v) return v; const m = document.querySelector('meta[name="moread-proxy"]'); return m && m.content ? new URL(m.content, location.href).href : ''; } catch (e) { return ''; } })())}" placeholder="https://你的代理地址/?url=" spellcheck="false" /></div>` : ''}
        </div>

        <div class="card" data-sec="data">
          <h3>数据与缓存</h3>
          <div class="row"><div class="rl">数据目录<small>${esc(onDeviceStore() ? (S.info.dataRoot || S.info.paths.root) : S.info.paths.root)}</small></div>
            ${IS_ANDROID ? '' : '<button class="link" id="open-dir">打开</button>'}</div>
          <div class="row"><div class="rl">缓存占用<small id="cache-size">计算中…</small></div>
            <button class="btn sm" id="clear-cache">清理</button></div>
        </div>

        <div class="card" data-sec="data">
          <h3>备份与恢复 <span class="chip">含 Legado 格式</span></h3>
          ${S.info.platform === 'web' ? `<div class="web-note">${onDeviceStore()
            ? '书、书源、阅读进度都保存在这台机器上（' + esc(S.info.dataRoot || '服务器') + '），'
              + '家里任何设备打开都是同一份书架，清理浏览器数据也不会丢。'
            : '数据只存在这台设备的浏览器里。清理浏览器数据、换手机、或用无痕模式打开都会丢，'
              + '建议每隔一阵点一次「完整导出」，把 zip 存到手机文件或网盘里。'}</div>` : ''}
          <div class="row"><div class="rl">导出备份 zip<small>内含 bookSource.json / bookshelf.json / bookmark.json，原版「阅读」可直接导入这个 zip</small></div>
            <button class="btn sm" id="bk-zip">导出</button></div>
          <div class="row"><div class="rl">完整备份（含本地书文件）<small>换设备能完整还原，本地书的正文也在里面${S.info.platform === 'web' ? '——网页版推荐用这个' : ''}</small></div>
            <button class="btn sm" id="bk-zip-full">完整导出</button></div>
          <div class="row"><div class="rl">从备份恢复<small>墨读 zip、原版「阅读」备份 zip、或手机导出的备份 JSON（含 bookSource / bookshelf 都行，文件名不限）；书架、书源、书签一起恢复</small></div>
            <button class="btn sm" id="bk-restore">选择文件</button></div>
        </div>

        <div class="card" data-sec="dav">
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

        <div class="card" data-sec="system">
          ${IS_ANDROID ? `<h3>触屏操作</h3>
          <div class="row"><div class="rl">进入书籍<small>全屏沉浸：顶栏底栏自动藏起，点屏幕中间唤出，几秒不碰自动再收</small></div></div>
          <div class="row"><div class="rl">轻点屏幕左右两侧<small>上一页 / 下一页，只在「翻页」模式下生效</small></div></div>
          <div class="row"><div class="rl">左右滑动<small>翻页；「滚动」模式下滑动即正常滚动正文</small></div></div>
          <div class="row"><div class="rl">长按书架封面<small>弹出「换源 / 删除」菜单</small></div></div>
          <div class="row"><div class="rl">长按顶栏 1.2 秒<small>打开自检：桥、存储、联网、WebView 版本逐项列出</small></div></div>` : `<h3>窗口与快捷键</h3>
          <div class="row"><div class="rl">关闭窗口时最小化到托盘<small>开启后点 × 不会退出程序</small></div>
            <div class="switch ${s.closeToTray ? 'on' : ''}" data-set="closeToTray"><i></i></div></div>
          <div class="row"><div class="rl">打开搜索</div><span><span class="kbd">Ctrl</span> + <span class="kbd">F</span></span></div>
          <div class="row"><div class="rl">导入本地书</div><span><span class="kbd">Ctrl</span> + <span class="kbd">O</span></span></div>
          <div class="row"><div class="rl">上一章 / 下一章</div><span><span class="kbd">←</span> <span class="kbd">→</span></span></div>
          <div class="row"><div class="rl">翻页（分页模式）</div><span><span class="kbd">PgUp</span> <span class="kbd">PgDn</span></span></div>
          <div class="row"><div class="rl">字号 / 主题 / 目录 / 书签</div><span><span class="kbd">+</span><span class="kbd">-</span><span class="kbd">T</span><span class="kbd">C</span><span class="kbd">B</span></span></div>
          <div class="row"><div class="rl">全屏 / 退出全屏</div><span><span class="kbd">F11</span> 或 <span class="kbd">F</span></span></div>
          <div class="row"><div class="rl">退出阅读</div><span class="kbd">Esc</span></div>`}
        </div>

        <div class="card" data-sec="about">
          <h3>关于</h3>
          <div class="row"><div class="rl">关于墨读<small>版本信息 · 开源地址 · 公众号 · 抖音</small></div>
            <button class="btn sm" id="open-about">查看</button></div>
          <div class="row"><div class="rl">版本<small>${IS_ANDROID ? `墨读 ${esc(S.info.version)} · Android` : (S.info.platform === 'web' ? `墨读 ${esc(S.info.version)} · 网页版` : (S.info.platform === 'ios' || S.info.platform === 'harmony') ? `墨读 ${esc(S.info.version)} · ${OS_NAME()}` : `墨读 ${esc(S.info.version)} · Electron ${esc(S.info.electron)} · Node ${esc(S.info.node)}`)}</small></div>
            <span class="rv">${IS_ANDROID ? '数据只存本机' : (S.info.portable ? '便携模式 · 数据在程序目录' : '数据只存本地')}</span></div>
          <div class="row"><div class="rl">数据位置<small>${esc(S.info.paths.root)}</small></div>
            ${IS_ANDROID ? '' : '<button class="link" id="open-dir2">打开</button>'}</div>
          <div class="row"><div class="rl">书源格式<small>兼容 Legado(阅读) bookSource JSON 的常用字段；xpath/复杂 JS 规则可能不生效</small></div></div>
          <div class="row"><div class="rl">备份格式<small>导出的 zip 内同时含 bookSource.json / bookshelf.json 等原版字段，原版「阅读」可直接导入</small></div></div>
        </div>
      </div>`;

    /* ---- 一级：模块菜单 ---- */
    if (!S.set) {
      const wrap = v.querySelector('.set-wrap');
      if (wrap) wrap.style.display = 'none';
      const grid = document.createElement('div');
      grid.className = 'ext-grid set-menu';
      grid.innerHTML = SET.map(e => `<button class="ext-card" data-sec-go="${e.k}">
          <span class="ext-ico"><svg viewBox="0 0 24 24">${e.icon}</svg></span>
          <span class="ext-info"><b>${e.name}</b><i>${e.desc}</i></span>
          <span class="ext-stat">${esc(e.stat())}</span>
          <svg class="set-chev" viewBox="0 0 24 24"><path d="M9 5l7 7-7 7"/></svg>
        </button>`).join('');
      v.appendChild(grid);
      $$('#view-settings [data-sec-go]').forEach(b => b.onclick = () => {
        S.set = b.dataset.secGo;
        const t = $('#tb-title'); if (t) t.textContent = setSecName();
        renderSettings();
      });
      return;
    }

    /* ---- 二级：只留这一组卡片 ---- */
    const sec = SET.find(e => e.k === S.set) || SET[0];
    S.set = sec.k;
    const wrap = v.querySelector('.set-wrap');
    if (wrap) wrap.classList.add('one');
    $$('#view-settings .card').forEach(c => { c.hidden = c.dataset.sec !== sec.k; });
    const h1 = v.querySelector('.page-head h1');
    if (h1) h1.textContent = sec.name;
    const subEl = v.querySelector('.page-head .sub');
    if (subEl) subEl.textContent = sec.desc;
    const back = document.createElement('button');
    back.className = 'ext-back';
    back.innerHTML = '<svg viewBox="0 0 24 24"><path d="M15 5l-7 7 7 7"/></svg>设置';
    back.onclick = () => {
      S.set = null;
      const t = $('#tb-title'); if (t) t.textContent = '设置';
      renderSettings();
    };
    const head = v.querySelector('.page-head');
    if (head) head.insertBefore(back, head.firstChild);

    $('#s-fs').oninput = e => {
      s.fontSize = +e.target.value; $('#s-fs-v').textContent = s.fontSize + 'px'; applyReaderStyle(); save();
    };
    $('#s-lh').oninput = e => {
      s.lineHeight = +e.target.value / 10; $('#s-lh-v').textContent = s.lineHeight.toFixed(1); applyReaderStyle(); save();
    };
    $('#s-pg').oninput = e => {
      s.paraGapEm = +e.target.value / 100; s.paraGap = s.paraGapEm > 0;
      $('#s-pg-v').textContent = s.paraGapEm.toFixed(2) + 'em'; applyReaderStyle(); save();
    };
    $$('#s-font button').forEach(b => b.onclick = () => {
      $$('#s-font button').forEach(x => x.classList.remove('on'));
      b.classList.add('on'); s.fontFamily = b.dataset.v; applyReaderStyle(); save();
    });
    $$('#s-mode button').forEach(b => b.onclick = () => {
      $$('#s-mode button').forEach(x => x.classList.remove('on'));
      b.classList.add('on'); s.pageMode = b.dataset.v; save();
      if (R.book) renderChapter();
    });
    $$('#s-conc button').forEach(b => b.onclick = () => {
      $$('#s-conc button').forEach(x => x.classList.remove('on'));
      b.classList.add('on'); s.maxConcurrent = +b.dataset.v; save();
    });
    $$('#s-slimit button').forEach(b => b.onclick = () => {
      $$('#s-slimit button').forEach(x => x.classList.remove('on'));
      b.classList.add('on'); s.searchLimit = +b.dataset.v; save();
    });
    if ($('#s-shelf-sort')) $('#s-shelf-sort').onchange = e => {
      s.shelfSort = e.target.value;
      applyShelfPrefs(); save(true); renderShelf();
    };
    $$('#s-shelf-size button').forEach(b => b.onclick = () => {
      $$('#s-shelf-size button').forEach(x => x.classList.remove('on'));
      b.classList.add('on'); s.shelfSize = b.dataset.v;
      applyShelfPrefs(); save(true); renderShelf();
    });
    $$('#s-swlimit button').forEach(b => b.onclick = () => {
      $$('#s-swlimit button').forEach(x => x.classList.remove('on'));
      b.classList.add('on'); s.switchLimit = +b.dataset.v; save();
    });
    $$('#view-settings [data-set]').forEach(el => el.onclick = () => {
      const k = el.dataset.set;
      s[k] = !s[k]; el.classList.toggle('on', s[k]); save(true);
    });
    /* 安卓没有「文件管理器」可跳转，这两个按钮根本不会渲染出来，要判空 */
    if ($('#open-dir')) $('#open-dir').onclick = () => mo.openDir && mo.openDir();
    if ($('#open-dir2')) $('#open-dir2').onclick = () => mo.openDir && mo.openDir();
    if ($('#open-about')) $('#open-about').onclick = aboutPanel;
    /* 网页版：书源代理地址（存 localStorage，由浏览器桥的 http 层读取） */
    if ($('#web-proxy')) $('#web-proxy').onchange = () => {
      try { localStorage.setItem('moread.proxy', $('#web-proxy').value.trim()); } catch (e) { }
      toast($('#web-proxy').value.trim() ? '代理已保存，下个请求开始生效' : '已清空代理：回到纯本地模式');
    };
    $('#s-tts').onclick = () => ttsPanel();
    $('#s-tts-test').onclick = () => {
      const v2 = ttsOrderedVoices().find(x => x.voiceURI === ttsCfg().voiceURI) || ttsOrderedVoices()[0];
      const u = new SpeechSynthesisUtterance('这是墨读的朗读试听，语速和音色可以随时调整。');
      if (v2) u.voice = v2;
      u.lang = (v2 && v2.lang) || 'zh-CN';
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
    /* 进了同步页才去读云端列表，别的模块不用为一屏看不到的列表掏网络 */
    if (sec.k === 'dav' && dav.enabled && dav.user && dav.pass) davLoadList();

    if (sec.k === 'data') updateCacheSize();
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
    /* 源名规范化：去空白、去装饰符号，只用于兜底模糊匹配。
       精确匹配仍用原名，避免把「🌸 二二中文」和「🍊 22中文」当成一个源。 */
    const normName = n => String(n || '').replace(/\s+/g, '').toLowerCase();
    const bareName = n => normName(n).replace(/[^0-9a-z\u4e00-\u9fff]/g, '');
    const srcKey = (u, n) => normUrl(u) + '\u0001' + normName(n);

    // 1) 书源：按「站点 URL + 源名」保真去重（几千源要用索引，不能用 find）
    /* 原版备份里同一个域名常挂好几个规则不同的源（用户这份就有 408 个重复 URL）。
       以前只按 URL 去重，同站不同规则的源被随手丢掉，书也绑不回自己那个源。 */
    let srcAdded = 0, srcUpdated = 0;
    const byKey = new Map(), byUrl = new Map(), byName = new Map();
    const indexSource = s => {
      const u = normUrl(s.url), n = normName(s.name);
      const k = srcKey(u, n);
      if (!byKey.has(k)) byKey.set(k, s);
      if (u) { if (!byUrl.has(u)) byUrl.set(u, []); byUrl.get(u).push(s); }
      if (n) { if (!byName.has(n)) byName.set(n, []); byName.get(n).push(s); }
    };
    st.sources.forEach(indexSource);
    for (const raw of parts.sources || []) {
      const s = Engine.normalizeSource(raw);
      const old = byKey.get(srcKey(s.url, s.name));
      if (old) { Object.assign(old, s, { id: old.id, enabled: old.enabled }); srcUpdated++; }
      else { st.sources.push(s); srcAdded++; indexSource(s); }
    }
    /* 按备份里的 customOrder 还原书源顺序，换源列表也跟着这个顺序走。
       没有 order 的源（自己新建的）排到最后，保持原有相对顺序。 */
    if ((parts.sources || []).length) {
      const ord = s => Number.isFinite(s.order) ? s.order : Number.MAX_SAFE_INTEGER;
      st.sources.sort((a, b) => ord(a) - ord(b));
    }

    // 2) 书架：优先绑回备份里记的那个源
    const findSource = raw => {
      const u = normUrl(raw.origin || raw.originRaw);
      const n = normName(raw.originName);
      const exact = byKey.get(srcKey(u, n));
      if (exact) return exact;
      const sameUrl = byUrl.get(u) || [];
      if (n) {
        const bn = bareName(n);
        const close = sameUrl.find(s => normName(s.name) === n)
          || sameUrl.find(s => bareName(s.name) === bn)
          || (byName.get(n) || []).find(s => normUrl(s.url) === u)
          || (byName.get(n) || [])[0];
        if (close) return close;
      }
      /* 站点换过域名时，备份里的 bookUrl 常指向旧域名，也拿它试一次 */
      const bu = normUrl(String(raw.bookUrl || '').replace(/^(https?:\/\/[^\/]+).*$/i, '$1'));
      if (bu && bu !== u && byUrl.has(bu)) return byUrl.get(bu)[0];
      return sameUrl[0] || null;
    };
    let added = 0, updated = 0, noSource = 0;
    for (const raw of parts.books || []) {
      const src = findSource(raw);
      if (!src) noSource++;
      /* 换过源、或目录解析改过书名/作者后，bookUrl 和作者都可能跟备份不一样；
         同名书基本就是同一本，再加一层兜底，避免重新导入时多出一本重复书。 */
      const exist = st.books.find(b => b.bookUrl && b.bookUrl === raw.bookUrl)
        || st.books.find(b => b.name === raw.name && b.author === raw.author)
        || st.books.find(b => b.name === raw.name);
      if (exist) {
        if (!exist.chapters || !exist.chapters.length) {
          exist.total = raw.total || exist.total;
          /* 老记录里没有目录页地址时用备份里的补上 —— 这一项决定能不能抓全目录 */
          if (!exist.tocUrl && raw.tocUrl) exist.tocUrl = raw.tocUrl;
        }
        exist.updatedAt = Date.now();
        /* 重新导入同一份备份时顺手把以前绑错的书源纠正回来；
           用户手工换过源的书不动，尊重他的选择。 */
        if (src && !exist.manualSource) { exist.sourceId = src.id; exist.sourceName = src.name; }
        exist.origin = raw.origin || exist.origin || '';
        exist.originRaw = raw.originRaw || exist.originRaw || '';
        exist.originName = raw.originName || exist.originName || '';
        updated++;
        const p = st.progress[exist.id] || {};
        if ((raw.durChapterIndex || 0) >= (p.ci || 0)) {
          st.progress[exist.id] = {
            ci: raw.durChapterIndex || 0, title: raw.durChapterTitle || p.title || '',
            pos: raw.durChapterPos || 0, pct: 0, at: raw.durChapterTime || Date.now()
          };
        }
        continue;
      }
      const id = uid('L');
      st.books.push({
        id, name: raw.name, author: raw.author || '佚名', kind: 'online',
        sourceId: src ? src.id : '', sourceName: src ? src.name : (raw.originName || '（缺书源）'),
        /* 记下备份里的原始书源：换源时把它排在最前，源被改名/重建也能找回来 */
        origin: raw.origin || '', originRaw: raw.originRaw || '', originName: raw.originName || '',
        bookUrl: raw.bookUrl, intro: raw.intro || '', cover: raw.cover || '',
        /* 目录页地址（原版 book.tocUrl）：书地址常常只是详情/下载页，目录得靠它 */
        tocUrl: raw.tocUrl || '',
        total: raw.total || 0, chapters: [], groupId: raw.groupName ? ensureGroup(raw.groupName) : 'g_default',
        /* 备份里记的总章数单独存一份：抓回来的目录明显少于它，就说明抓的是「最新章节」 */
        expectTotal: raw.total || 0,
        /* 备份里的其余元数据：只做展示/排序，不影响阅读 */
        latestChapterTitle: raw.latestChapterTitle || '', latestChapterTime: raw.latestChapterTime || 0,
        lastCheckTime: raw.lastCheckTime || 0, wordCount: raw.wordCount || '',
        tags: raw.kind || '', bookType: raw.bookType || 0, canUpdate: raw.canUpdate !== false,
        readConfig: raw.readConfig || null, variable: raw.variable || '',
        backupOrder: raw.order || 0,
        createdAt: Date.now(), updatedAt: Date.now()
      });
      if (raw.durChapterIndex) {
        st.progress[id] = {
          ci: raw.durChapterIndex, title: raw.durChapterTitle || '',
          pos: raw.durChapterPos || 0, pct: 0, at: raw.durChapterTime || Date.now()
        };
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
    // 网页版在同步用户手势里先打开选择框，避免手机浏览器把异步链里的 click 静默拦掉
    try {
      if (typeof window.__moreadPrimeFilePicker === 'function') {
        window.__moreadPrimeFilePicker(['application/zip', 'application/json', '*/*'], false);
      }
    } catch (e) { /* 桌面/安卓没有这个入口，走原来的路径 */ }
    let r;
    try {
      r = await mo.pickZip();
    } catch (e) {
      return toast('打开文件失败：' + (e && e.message || e), 6500);
    }
    if (!r || !r.ok) {
      if (r && r.canceled) return;   // 用户主动取消，不打扰
      const msg = (r && r.error) || '没有读到文件，请再试一次（或换一个备份文件）';
      const more = /不是有效的|没有识别到|读取失败|无法读取|JSON 解析失败/.test(msg)
        ? '。支持：墨读备份 zip、原版「阅读」备份 zip、以及任何含 bookSource / bookshelf 的 json（文件名不限）'
        : '';
      // 任何失败都要出声，绝不能像以前那样静默返回，让人以为按钮坏了
      toast(msg + more, 6500);
      return;
    }
    showRestoreConfirm(r);
  }

  /** 弹出恢复确认框——安卓「用墨读打开备份」也复用这里 */
  function showRestoreConfirm(r) {
    if (!r || !r.ok) { if (r && r.error) toast(r.error); return; }
    if (r.kind === 'sources') {
      const { added, updated } = mergeSources((r.sources || []).map(Engine.normalizeSource));
      return toast(`书源导入完成：新增 ${added}，更新 ${updated}${onDeviceStore() ? '，已保存到这台设备' : ''}`, 4200);
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
      return toast(`已恢复 ${n} 本书、${(res.state.sources || []).length} 个书源${onDeviceStore() ? '，已保存到这台设备' : ''}`, 4200);
    }
    // Legado 备份
    const counts = applyLegado(r.legado || {}, mode);
    closeModal();
    applySettings();
    renderShelf(); setView('shelf');
    toast(`恢复完成：书 ${counts.added} 本、书源 ${counts.srcAdded} 个、书签 ${counts.bmAdded} 条`
      + (counts.noSource ? `（${counts.noSource} 本没匹配到书源，阅读时可手动换源）` : '')
      + (onDeviceStore() ? '，已保存到这台设备' : ''), 4200);
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
    buf: null, bufTail: -1, bufLock: false, bufFail: {}, lastWithin: null, loadSeq: 0,
    /* 目录面板当前页签：toc=目录，bm=书签（书签按书归属，只在书里看） */
    tocTab: 'toc'
  };

  function applySettings() {
    const s = S.state.settings;
    $('#reader').dataset.theme = s.theme;
    $$('#r-swatches .sw').forEach(el => el.classList.toggle('on', el.dataset.t === s.theme));
    $('#r-fs-num').textContent = s.fontSize;
    applyShelfPrefs();
  }

  /* 段距：独立设置项（em）。没有该字段的旧存档按旧的推导规则回填，
     避免升级后老用户的段落突然贴在一起。 */
  function paraGapEm(s) {
    if (typeof s.paraGapEm === 'number') return clamp(s.paraGapEm, 0, 2);
    return s.paraGap ? (s.lineHeight > 1.9 ? 1.05 : .8) : .2;
  }

  function applyReaderStyle() {
    const s = S.state.settings;
    const page = $('#r-page');
    if (!page) return;
    page.style.setProperty('--r-fs', s.fontSize + 'px');
    page.style.setProperty('--r-lh', s.lineHeight);
    page.style.setProperty('--para-gap', paraGapEm(s) + 'em');
    /* 分页模式一行最多约 58 字：字号变大时书页跟着变宽，超宽屏也不会拉成一条长行 */
    page.style.setProperty('--page-max', Math.round(s.fontSize * 58) + 'px');
    page.classList.toggle('nofamily', s.fontFamily !== 'serif');
    $('#reader').classList.toggle('mode-paged', s.pageMode === 'paged');
    $('#r-fs-num').textContent = s.fontSize;
    /* 分页时底栏翻的是页，不是章 —— 文案跟着模式走，免得以为一下跳一章 */
    const prev = $('#r-prev'), next = $('#r-next');
    if (prev) prev.textContent = s.pageMode === 'paged' ? '上一页' : '上一章';
    if (next) next.textContent = s.pageMode === 'paged' ? '下一页' : '下一章';
    if (prev) prev.title = s.pageMode === 'paged' ? '上一页（← / PageUp）' : '上一章';
    if (next) next.title = s.pageMode === 'paged' ? '下一页（→ / PageDown / 空格）' : '下一章';
  }

  /* 换书 / 退出阅读器时彻底复位。
     以前只把 R.book 置空：退出再点另一本时，新章还在网络上飞，屏幕上仍是
     上一本的正文和标题；要是上一本的慢请求后回来，还会直接把旧内容糊到新书上。
     这里一次性作废在途加载、清空残留 DOM 与全部阅读状态。 */
  function resetReader() {
    R.loadSeq++;                       // 让所有在途 loadChapter / 续章请求过期
    stopTTS();
    clearInterval(R.timer); R.timer = null;
    clearTimeout(R.barsT); R.barsT = null;
    clearTimeout(R.saveT); R.saveT = null;
    R.book = null; R.ci = 0; R.chapters = []; R.paras = []; R.title = '';
    R.pages = [[]]; R.page = 0; R.chars = 0; R.ttsIdx = 0;
    R.buf = null; R.bufTail = -1; R.bufLock = false; R.bufFail = {};
    R.lastWithin = null;
    const page = $('#r-page'); if (page) page.innerHTML = '';
    const stage = $('#r-stage'); if (stage) stage.scrollTop = 0;
    for (const sel of ['#r-title', '#r-info', '#r-pagenum', '#r-loading']) {
      const el = $(sel); if (el) el.textContent = '';
    }
    /* 目录面板只清列表内容，不能整块 innerHTML='' —— #toc-list / #toc-count
       是它的子元素，清掉之后 buildToc() 会拿不到节点 */
    const tocList = $('#toc-list'); if (tocList) tocList.innerHTML = '';
    const bmList = $('#bm-list'); if (bmList) bmList.innerHTML = '';
    const bmN = $('#bm-tab-n'); if (bmN) bmN.textContent = '';
    const tocCount = $('#toc-count'); if (tocCount) tocCount.textContent = '';
    $('#r-toc-panel').classList.remove('open');
    $('#toc-mask').classList.remove('on');
  }

  async function openReader(bookId, ci, pct, title) {
    const b = getBook(bookId);
    if (!b) return;
    /* 「继续阅读」以前不带 ci，进书永远从第 1 章开始，备份里的进度等于白记。
       没显式指定章节就接上次读到的地方。 */
    const saved = progressOf(b.id) || {};
    let startCi = ci == null ? (saved.ci || 0) : ci;
    /* 书签 / 历史里存的同样是「相对旧目录」的索引：目录一变就指到别的章了，
       有书名+章节名就按标题找回来。 */
    const wantTitle = title || (ci == null ? saved.title : '');
    if (b.chapters && b.chapters.length && wantTitle) {
      const k = matchChapterIndex(b.chapters, wantTitle, startCi, 0);
      if (k >= 0) startCi = k;
    }
    resetReader();                     // 先跟上一本彻底断开
    R.book = b;
    R.chapters = b.chapters || [];
    R.ci = clamp(startCi, 0, Math.max(0, (b.total || 1) - 1));
    R.page = 0;
    /* 目录面板回到「目录」页签，并把书签页签上的数量按这本书刷一遍 */
    R.tocTab = 'toc';
    $$('#toc-tabs button').forEach(el => el.classList.toggle('on', el.dataset.tab === 'toc'));
    const tl = $('#toc-list'), bl = $('#bm-list');
    if (tl) tl.hidden = false;
    if (bl) bl.hidden = true;
    {
      const n = S.state.bookmarks.filter(x => x.bookId === b.id).length;
      const tabN = $('#bm-tab-n');
      if (tabN) tabN.textContent = n ? ` ${n}` : '';
    }
    buildToc();                        // 目录同步换成这本，别留着上一本的章节
    $('#reader').classList.add('open');
    /* 手机进书即沉浸：顶/底栏滑出屏幕，点中间唤出（几秒不用自动再藏） */
    if (isAndroidApp()) $('#reader').classList.add('bars-off');
    $('#r-switch').style.display = b.kind === 'local' ? 'none' : '';
    applySettings();
    closeTocPanel();
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
    resetReader();
    $('#reader').classList.remove('open', 'bars-off');
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

  /** 打开一本「目录短得反常」的在线书时，后台重抓一次完整目录
   *  （很多书当初只抓到详情页上的「最新章节」，读起来就是「章节不对」）。
   *  只在目录明显变大时替换，并按标题把当前章对上，不打断阅读。 */
  async function fixShortToc(b, src) {
    try {
      const curTitle = (b.chapters[R.ci] || {}).title || '';
      const t = await withTimeout(Engine.getToc(netGet, src, b.bookUrl, {
        tocUrl: b.tocUrl && b.tocUrl !== b.bookUrl ? b.tocUrl : '',
        expect: b.total || 0,
        reverse: !!(b.readConfig && b.readConfig.reverseToc)
      }), 45000);
      if (!t.chapters || t.chapters.length <= b.chapters.length) return;
      const idx = matchChapterIndex(t.chapters, curTitle, R.ci, b.chapters.length);
      b.chapters = t.chapters;
      b.total = t.chapters.length;
      if (t.tocUrl) b.tocUrl = t.tocUrl;
      if (idx >= 0 && R.book && R.book.id === b.id) {
        R.ci = idx;
        R.chapters = b.chapters;
        buildToc();
      }
      upsertBook(b);
      save(true);
      toast(`已补全目录：${b.total} 章`);
    } catch (e) { /* 补不上就算了，不能影响正常阅读 */ }
  }

  async function loadChapter(ci, dir, pct) {
    const b = R.book;
    if (!b) return;
    /* 并发导航互斥：快速连按「上一章」时，慢的那次可能后完成，把旧章节的标题/
       内容配新章节的 ci 渲染出来（章节和 data-ci 就错位了）。后启动的调用递增
       代数，先启动的完成后发现代数对不上就整个丢弃。
       换书时再多一道 bookId 校验：代数相同也不代表还是同一本书。 */
    const seq = ++R.loadSeq;
    const bookId = b.id;
    const stale = () => seq !== R.loadSeq || !R.book || R.book.id !== bookId;
    if (R.tts) stopTTS();
    R.ci = clamp(ci, 0, Math.max(0, (b.total || 1) - 1));
    const loading = $('#r-loading');
    loading.textContent = '加载中…';
    $('#r-pagenum').textContent = '';
    R.paras = [];
    R.lastWithin = null;
    /* 先把书名/章节名放上去，别让用户盯着一整屏空白等网络 */
    const earlyTitle = (b.chapters && b.chapters[R.ci] && b.chapters[R.ci].title) || '';
    $('#r-title').innerHTML = `${esc(b.name)}${earlyTitle ? `<em>${esc(earlyTitle)}</em>` : ''}`;

    try {
      let title = '', paras = [];
      if (b.kind === 'local') {
        const r = await mo.localChapter(b.id, R.ci);
        if (!r.ok) throw new Error(r.error || '读取失败');
        title = r.title; paras = r.text;
      } else {
        const src = srcForBook(b);
        if (!src) throw new Error('这个书源已被删除，可以点右上角「换源」换一个源继续读');
        /* 老版本把详情页上那十几条「最新章节」当成了全部目录并缓存下来 ——
           升级后第一次打开这类书时丢掉旧目录重抓一次，不用用户自己去点「更新目录」。 */
        if (!b.tocFix2 && b.chapters && b.chapters.length && b.chapters.length < 25
          && (b.origin || b.originRaw || b.tocUrl)) {
          b.tocFix2 = true;
          b.chapters = [];
        }
        if (!b.chapters || !b.chapters.length) {
          loading.textContent = '获取目录…';
          const expectTotal = b.expectTotal || b.total || 0;
          /* 30s 双保险：底层网络有自己的超时，但失效书源常走多级重定向/慢站，
             不兜一层的话「加载中…」能挂到天荒地老，看起来就像卡死 */
          const toc = await withTimeout(Engine.getToc(netGet, src, b.bookUrl, {
            /* 备份里的目录页（原版 book.tocUrl）：书地址常常只是详情/下载页 */
            tocUrl: b.tocUrl && b.tocUrl !== b.bookUrl ? b.tocUrl : '',
            /* 备份里的总章数：抓回来明显偏少就说明抓的是「最新章节」，继续找 */
            expect: expectTotal,
            reverse: !!(b.readConfig && b.readConfig.reverseToc)
          }), 45000);
          b.chapters = toc.chapters; b.total = toc.chapters.length;
          if (toc.tocUrl) b.tocUrl = toc.tocUrl;
          if (toc.info.name) b.name = toc.info.name;
          if (toc.info.author) b.author = toc.info.author;
          if (toc.info.coverUrl) b.cover = toc.info.coverUrl;
          upsertBook(b);
          R.chapters = b.chapters;
          buildToc();
          if (!b.chapters.length) throw new Error('目录为空，检查书源的目录规则');
          /* 阅读进度是按「原版那本书」的目录记的。站点改版、换源、或者目录从
             「最新章节 12 条」变成完整目录之后，同一个索引指向的章节完全不同
             （第59章 变成 第660章 就是这么来的）。所以只要标题对得上，就以标题为准。 */
          const p = progressOf(b.id) || {};
          const want = p.title || b.durChapterTitle || '';
          const k = matchChapterIndex(b.chapters, want, R.ci, expectTotal || p.total || 0);
          if (k >= 0) R.ci = k;
          else if (R.ci >= b.chapters.length) {
            /* 标题也对不上（站点把章节名改了）：按比例落位，至少不会从最后一章开始 */
            const ratio = expectTotal ? R.ci / expectTotal : 0;
            R.ci = ratio > 0 && ratio < 1 ? Math.round(ratio * (b.chapters.length - 1)) : b.chapters.length - 1;
          }
          R.ci = clamp(R.ci, 0, b.chapters.length - 1);
          /* 上面可能把 R.ci 按标题挪了位置，目录高亮得跟着走一次，
             否则目录里高亮的是「第60章」而正文是「第59章」 */
          const on = document.querySelector(`#toc-list .toc-item[data-ci="${R.ci}"]`);
          $$('#toc-list .toc-item.on').forEach(el => el.classList.remove('on'));
          if (on) on.classList.add('on');
          /* 站点自己只给了几十章（备份里却记着上千章）时说明它把完整目录藏了/删了，
             读者在这里多半会以为「又抓错了」，直接告诉他可以换源 */
          if (expectTotal && b.chapters.length < expectTotal * 0.6 && !b.tocShortWarned) {
            b.tocShortWarned = true;
            toast(`这个源只给了 ${b.chapters.length} 章（原书 ${expectTotal} 章），可以点「换源」换一个更全的源`, 7000);
          }
        }
        /* 目录只有十来章的在线书，多半当初只抓到「最新章节」：后台补一次完整目录 */
        if (!b.tocFixed && b.total > 0 && b.total < 15) {
          b.tocFixed = true;
          fixShortToc(b, src);
        }
        const ch = b.chapters[R.ci];
        if (!ch) throw new Error('章节不存在');
        title = ch.title;
        const cached = await mo.cache.get(b.id, R.ci);
        if (cached && cached.text && cached.text.length) {
          paras = cached.text;
        } else {
          loading.textContent = '加载正文…';
          const r = await withTimeout(Engine.getContent(netGet, src, ch.url), 20000);
          paras = r.paras;
          if (r.blocked) throw new Error('这个站要求人机验证（或本章是 VIP 章节），过一会儿再试，或换个源');
          /* 站点把正文换成了加密 JSON 接口，书源规则又没解开 —— 别再显示一屏密文 */
          if (r.fail === 'json') throw new Error('这个源的正文是加密接口（返回 JSON 密文），本机解不开。换一个源试试');
          if (!paras.length) throw new Error('正文为空，检查正文规则');
          /* 漫画章：先把图下回来再缓存，否则每次翻页都要重新下载，
             而且缓存里留下远程地址的话离线就全是白框 */
          if (paras.some(isRemoteImg)) {
            loading.textContent = '下载图片…';
            paras = await resolveImgs(paras, src);
            if (!paras.length) throw new Error('这一章的图片都下载失败了，可能是站点防盗链');
          }
          /* 缓存写入不必挡着渲染：IndexedDB 快但也是异步的，先出字再落盘 */
          Promise.resolve(mo.cache.set(b.id, R.ci, { title, text: paras })).catch(() => { });
        }
        if (S.state.settings.autoCacheNext) {
          /* 预取接下来两章：翻页时直接命中缓存，体感快一截 */
          for (let k = 1; k <= 2; k++) {
            if (R.ci + k < b.chapters.length) prefetch(b, src, R.ci + k);
          }
        }
      }

      /* 等待期间用户可能又点了别的章节：过期的这次直接丢弃，不渲染不写状态 */
      if (stale()) return;
      /* 本章带 EPUB 图片时先把图加载完再渲染：分页测量依赖图片真实尺寸 */
      if (paras.some(isImgPara)) {
        await preloadImgs(paras);
        if (stale()) return;
      }
      R.title = title;
      R.paras = paras;
      R.chars = paras.reduce((n, p) => n + (isImgPara(p) ? 0 : p.length), 0);
      /* 图片为主、文字很少 → 当漫画排版：单图占满整屏 */
      R.comic = paras.some(isImgPara) && R.chars < 300;
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
      if (!stale()) maybeContinueScroll();
    } catch (e) {
      if (stale()) return;      // 过期的失败也别把新章节的页面糊成错误页
      const msg = e.message || String(e);
      const canSwitch = b.kind !== 'local';
      const fromBackup = !!(b.origin || b.originRaw);
      $('#r-page').innerHTML = `<div class="err">加载失败：${esc(msg)}<br>
        <span style="font-size:12px;opacity:.7">${!canSwitch ? '检查「扩展 → 书源」里的规则，或重新导入这本书'
          : fromBackup ? '这本书来自备份：备份只存书源地址和目录页，原站点可能已换域名或失效。先点「重试」，不行就「换源继续读」，备份原源会排在最前'
            : '这个书源可能已失效，先点「重试」再抓一次；还不行就换一个源继续读'}</span>
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
      const r = await Engine.getContent(netGet, src, ch.url);
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
    const r = await withTimeout(Engine.getContent(netGet, src, ch.url), 30000);
    if (!r.paras.length) throw new Error('正文为空，检查正文规则');
    const paras = r.paras.some(isRemoteImg) ? await resolveImgs(r.paras, src) : r.paras;
    if (!paras.length) throw new Error('这一章的图片都下载失败了');
    await mo.cache.set(b.id, idx, { title: ch.title, text: paras });
    if (S.state.settings.autoCacheNext && idx + 1 < (b.chapters || []).length) prefetch(b, src, idx + 1);
    return { title: ch.title, paras };
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
      sec.dataset.chars = paras.reduce((n, p) => n + (isImgPara(p) ? 0 : p.length), 0);
      sec.innerHTML = `<div class="ch-no">${esc(b.name)} · 共 ${bodyChapterCount(b) || total} 章</div><h2>${esc(title)}</h2>` +
        `<div class="body">${parasMap(paras, imgMaxH())}</div>` + (last ? pageTailHtml() : '');
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
        `<div class="body">${parasMap(ps, imgMaxH())}</div>`;
      if (R.page === R.pages.length - 1) {
        page.insertAdjacentHTML('beforeend', pageTailHtml());
        /* 「本章完」是装饰，放不下就省掉：正文区被内容占满时它会被挤出页面。
           page 高度已锁死 100%，看正文区是否溢出来判断。 */
        const bEl = page.querySelector('.body');
        if (bEl && bEl.scrollHeight > bEl.clientHeight + 1 && page.lastElementChild) {
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
        head + `<div class="body">${parasMap(R.paras, imgMaxH())}</div>` +
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
    return paraGapEm(s) + 'em';
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
      `height:auto;display:block;` +   // 覆盖 .mode-paged .page 的 height:100% / flex，否则量出整屏高
      `width:${availW + padX}px;padding:${padTop}px ${parseFloat(cs.paddingRight) || 0}px ${padBottom}px ${parseFloat(cs.paddingLeft) || 0}px;` +
      `max-width:none;margin:0;`;
    /* 测量盒必须挂在 #reader 里：页眉 h2 / ch-no 的样式带 .reader.mode-paged 前缀，
       挂在 body 下量出来的头部高度和真实渲染不一样，availH 会差出一截 */
    const host = $('#reader') || document.body;
    const mk = inner => {
      const d = document.createElement('div');
      d.className = 'page' + (s.fontFamily !== 'serif' ? ' nofamily' : '');
      d.style.cssText = boxStyle;
      d.style.setProperty('--r-fs', s.fontSize + 'px');
      d.style.setProperty('--r-lh', s.lineHeight);
      d.style.setProperty('--para-gap', measPadV(s));      d.innerHTML = inner;
      /* 正文区在真实页里是 flex 容器（竖向摊开），测量盒要还原成块级流，
         否则段落高度相加的口径和渲染时不一致 */
      d.querySelectorAll('.body').forEach(b => { b.style.display = 'block'; b.style.flex = 'none'; });
      host.appendChild(d);
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
      host.removeChild(d);
      return h;
    };
    const baseNext = baseOf(false);
    const baseFirst = baseOf(true);

    const availH = Math.max(80, Math.round(stage.clientHeight - baseNext));
    /* 首页要多扣「书名 + 章节标题」比一行页眉多出来的高度 */
    const firstPenalty = Math.max(0, Math.round(baseFirst - baseNext));
    const key = [availW, availH, firstPenalty, s.fontSize, s.lineHeight, s.fontFamily, paraGapEm(s),
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
    bEl.style.cssText = 'display:block;flex:none;';   // 与 mk 里同理：还原块级流
    box.appendChild(bEl);
    const mb = el => parseFloat(getComputedStyle(el).marginBottom) || 0;
    const els = R.paras.map(t => {
      /* EPUB 图片段：建 <img> 量真实高度（进测量盒前已 preload，见 preloadImgs）。
         CSS 与正文段落同样只有下外边距，相邻段高度可直接相加。 */
      const el = document.createElement(isImgPara(t) ? 'img' : 'p');
      if (isImgPara(t)) { el.className = 'r-img'; el.style.maxHeight = imgMaxH() + 'px'; el.src = t; }
      else el.textContent = t;
      bEl.appendChild(el);
      return el;
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
        /* 图片没有「行」的概念，截断逻辑不适用：整张塞进当前空页（限高已保证
           空页放得下），走下一轮。正常流程到不了这里，纯防御。 */
        if (isImgPara(rest)) { pages[cur].push(rest); used = Math.min(whole, availH); break; }
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
    host.removeChild(box);

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
          b.innerHTML = parasMap(arr, imgMaxH());
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

  /* ---------------- 目录 / 书签面板 ----------------
   * 书签原来占一个侧栏入口，翻到别的书也能看到一堆混在一起的书签。
   * 现在它跟目录共用这个面板、按书归档：在书里点「书签」页签看的就是这本的。 */
  function closeTocPanel() {
    const p = $('#r-toc-panel');
    if (p) p.classList.remove('open');
    const m = $('#toc-mask');
    if (m) m.classList.remove('on');
  }

  function setTocTab(tab) {
    R.tocTab = tab === 'bm' ? 'bm' : 'toc';
    const isBm = R.tocTab === 'bm';
    $$('#toc-tabs button').forEach(b => b.classList.toggle('on', b.dataset.tab === R.tocTab));
    const tl = $('#toc-list'), bl = $('#bm-list');
    if (tl) tl.hidden = isBm;
    if (bl) bl.hidden = !isBm;
    if (isBm) buildBookmarks(); else buildToc();
  }

  function bookmarksOfBook() {
    const b = R.book;
    if (!b) return [];
    return S.state.bookmarks
      .filter(x => x.bookId === b.id)
      .sort((a, c) => (a.ci - c.ci) || (a.at - c.at));
  }

  function buildBookmarks() {
    const box = $('#bm-list');
    if (!box) return;
    const bms = bookmarksOfBook();
    const tabN = $('#bm-tab-n');
    if (tabN) tabN.textContent = bms.length ? ` ${bms.length}` : '';
    const cnt = $('#toc-count');
    if (cnt) cnt.textContent = bms.length ? `${bms.length} 个` : '';
    if (!bms.length) {
      box.innerHTML = `<div class="bm-empty">这本书还没有书签。<br>
        读到想记住的地方，点顶栏的<b>书签</b>图标（快捷键 B）。<br>
        书签会记下章节和当时的位置，只属于这本书。</div>`;
      return;
    }
    box.innerHTML = bms.map(x => `<div class="bm-item" data-bm="${x.id}">
        <div class="bm-t">${esc(x.title || '第 ' + (x.ci + 1) + ' 章')}</div>
        <div class="bm-s">${esc(x.text || '（这一页没有摘到文字）')}</div>
        <div class="bm-m"><span>${fmtWhen(x.at)}${x.pct ? ` · 全章 ${Math.round(x.pct * 100)}%` : ''}</span>
          <button class="bm-del" data-bmdel="${x.id}">删除</button></div>
      </div>`).join('');
    $$('#bm-list [data-bm]').forEach(el => el.onclick = e => {
      if (e.target.closest('[data-bmdel]')) return;
      const bm = S.state.bookmarks.find(y => y.id === el.dataset.bm);
      if (!bm) return;
      R.page = 0;
      loadChapter(bm.ci, bm.pct);
      closeTocPanel();
    });
    $$('#bm-list [data-bmdel]').forEach(b => b.onclick = e => {
      e.stopPropagation();
      S.state.bookmarks = S.state.bookmarks.filter(y => y.id !== b.dataset.bmdel);
      save(true);
      buildBookmarks();
      toast('已删除书签');
    });
  }

  /* ---------------- 目录：哪些算「章」，哪些不算 ----------------
     出版社做的 epub 里，卷首的封面 / 版权页 / 目录页，以及前言、序、附录、后记、致谢
     在 spine 里和正文章节长得一模一样。以前它们全被算进「共 N 章」，一本书 40 章能
     显示成 47 章，目录里的序号也跟着错位（看着是第 3 章，点进去是版权页后面那章）。
     现在分三类：
       · 封面 / 版权页 / 目录页 —— 目录里直接不列（没人要读它们）
       · 前言 / 序 / 附录 / 后记 / 致谢 —— 归到「卷首 · 附录」一组，不计入章节数
       · 其余 —— 正文章节，按 1..N 连续编号
     判定只看标题（不碰正文索引），所以 data-ci 仍是原始下标，点击、进度、书签都对得上。 */
  const TOC_JUNK_RE = /^(?:封面|封底|护封|书脊|书名页|扉页|版权页?|版权信息|版权声明|目录|目\s*录|contents|table of contents|cover|front cover|back cover|title\s*page|copyright|colophon)$/i;
  const TOC_EXTRA_RE = /^(?:前言|序言|序|自序|代序|总序|推荐序|译者序|编者序|引言|引子|导言|导论|作者的话|作者引言|作者序|编者的话|译者的话|内容简介|内容提要|本书简介|作者简介|关于作者|后记|编后记|译后记|跋|附录.*|致谢|参考文献|参考书目|注释|注释表|插图|插图目录|名人推荐|媒体推荐|完本感言|完结感言|上架感言|作者感言|写在前面|写在最后|感言|foreword|preface|introduction|afterword|appendix\w*|acknowledg\w*|bibliography|notes|about the author|praise)$/i;

  const tocTitleOf = c => (typeof c === 'string' ? c : (c && c.title) || '');
  /** 去掉「第 3 章」「3.」「（一）」这类前缀，只留称呼本身再比对 */
  function tocKey(title) {
    return String(title || '')
      .replace(/^[\s　]+|[\s　]+$/g, '')
      .replace(/^第[零一二三四五六七八九十百千两0-9]{1,9}[章节回卷篇集][\s:：.、·-]*/i, '')
      .replace(/^[(（\[【]?\d{1,4}[)）\]】.、:：\s]+/, '')
      .replace(/[\s:：.、·-]+$/, '');
  }
  const isJunkTitle = t => TOC_JUNK_RE.test(tocKey(t));
  const isExtraTitle = t => !isJunkTitle(t) && TOC_EXTRA_RE.test(tocKey(t));
  /** 书架/详情页显示「共 N 章」时用这个：不含前言附录，也不含封面版权页 */
  function bodyChapterCount(b) {
    const list = (b && b.chapters) || [];
    if (!list.length) return (b && b.total) || 0;
    let n = 0;
    for (let i = 0; i < list.length; i++) if (!isJunkTitle(tocTitleOf(list[i])) && !isExtraTitle(tocTitleOf(list[i]))) n++;
    return n || (b && b.total) || 0;
  }

  function buildToc() {
    const b = R.book;
    const list = b.chapters || [];
    const extra = [], body = [];
    list.forEach((c, i) => {
      const t = tocTitleOf(c);
      if (isJunkTitle(t)) return;                       // 封面 / 版权 / 目录页：不列
      (isExtraTitle(t) ? extra : body).push({ i, t });
    });
    /* 整本都是前言附录的（散文集、只抓了一篇的书）就别分组了，否则正文组是空的 */
    const split = extra.length > 0 && body.length > 0;
    const row = (it, n) => `<div class="toc-item ${it.i === R.ci ? 'on' : ''}" data-ci="${it.i}">`
      + `<span class="${n ? '' : 'dot'}">${n || '·'}</span>${esc(it.t)}</div>`;

    let html = '';
    if (split) {
      html += `<div class="toc-group">卷首 · 附录<em>${extra.length} 篇</em></div>`;
      html += extra.map(it => row(it, 0)).join('');
      html += `<div class="toc-group">正文<em>${body.length} 章</em></div>`;
      html += body.map((it, k) => row(it, k + 1)).join('');
      $('#toc-count').textContent = `共 ${body.length} 章 · 另有卷首附录 ${extra.length} 篇`;
    } else {
      const all = body.concat(extra).sort((a, c) => a.i - c.i);
      html = all.map((it, k) => row(it, k + 1)).join('');
      $('#toc-count').textContent = `共 ${all.length} 章`;
    }
    $('#toc-list').innerHTML = html;
    R.tocOn = null;                       // 列表重建了，旧的「当前项」引用作废
    $$('#toc-list .toc-item').forEach(el => el.onclick = () => {
      R.page = 0;
      loadChapter(+el.dataset.ci, 0);
      closeTocPanel();
    });
    updateTocActive();
  }
  function updateTocActive() {
    /* 每次翻页都会调这里。目录没开时整章几百个条目挨个 toggle 纯属白烧 CPU
       （老实现还会对当前项 scrollIntoView，等于每翻一页逼一次排版），
       目录打开时 buildToc 会重新标一次，所以这里直接返回。 */
    if (!$('#r-toc-panel').classList.contains('open')) return;
    if (R.tocTab === 'bm') return;        // 书签页签下没有「当前章高亮」这回事
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
      text = ((R.pages[R.page] || []).find(p => !isImgPara(p)) || '').slice(0, 60);
    } else {
      const stage = $('#r-stage');
      const max = stage.scrollHeight - stage.clientHeight;
      pct = max > 10 ? stage.scrollTop / max : 0;
      text = (R.paras.find(p => !isImgPara(p)) || '').slice(0, 60);
    }
    /* 同一章可以加多个书签（长章节里两处都想记），只挡「几乎同一个位置」
       的重复点击，避免手抖连按出好几条一模一样的 */
    const exist = S.state.bookmarks.find(x => x.bookId === b.id && x.ci === R.ci && Math.abs((x.pct || 0) - pct) < 0.015);
    if (exist) { toast('这个位置已经有书签了'); return; }
    S.state.bookmarks.unshift({
      id: uid('B'), bookId: b.id, name: b.name, ci: R.ci, title: R.title, pct, text, at: Date.now()
    });
    save(true);
    toast('已添加书签 · 在目录面板的「书签」里看');
    if (R.tocTab === 'bm' && $('#r-toc-panel').classList.contains('open')) buildBookmarks();
    else {
      const n = bookmarksOfBook().length;
      const tabN = $('#bm-tab-n');
      if (tabN) tabN.textContent = n ? ` ${n}` : '';
    }
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

  /* 关于我们：版本、开源地址、公众号二维码、作者抖音。
     三端共用这一个弹窗，图片走相对路径（ui/ 与 dist-web 里各放一份）。 */
  const GITHUB_URL = 'https://github.com/RoutineMiku/MoRead-Windows';
  const DOUYIN_URL = 'https://v.douyin.com/9TIIxVCANig/';
  const DOUYIN_ID = 'RoutineMiku';
  function aboutPanel() {
    const plat = OS_NAME();
    openModal(`<div class="about">
      <img class="about-logo" src="logo.png" alt="墨读" />
      <div class="about-name">墨读</div>
      <div class="about-ver">v${esc(S.info.version)} · ${plat}</div>
      <p class="about-desc">本地优先的阅读器。书架、书源、进度、备份都在你自己手里，不上传、不追踪，换设备用备份文件搬走。</p>
      <a class="about-link" href="${GITHUB_URL}" target="_blank" rel="noreferrer noopener">
        <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82a7.4 7.4 0 0 1 2-.27c.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8z"/></svg>
        <span>RoutineMiku / MoRead-Windows</span>
      </a>
      <div class="about-qr">
        <img src="gzh-qr.jpg" alt="公众号二维码" />
        <span>微信扫码关注公众号<br /><small>版本更新与书源分享都在这里</small></span>
      </div>
      <div class="about-qr dy" id="ab-dy" role="button" tabindex="0" title="点一下复制抖音主页链接">
        <img src="douyin-qr.png" alt="抖音码" />
        <span>抖音扫码找我 · 联系作者<br /><small>抖音号 ${DOUYIN_ID} · 点这里复制主页链接<br />日常 MIKU，更新和使用问题都能直接说</small></span>
      </div>
      <div class="about-by">powered by <b>routinemiku</b></div>
    </div>
    <div class="modal-actions"><button class="btn primary" id="ab-ok">知道了</button></div>`);
    $('#ab-ok').onclick = closeModal;
    const dy = $('#ab-dy');
    const copy = async () => {
      const ok = await copyText(DOUYIN_URL);
      toast(ok ? '抖音链接已复制，粘到抖音里就能打开' : '复制没成功，抖音号是 ' + DOUYIN_ID, 3000);
    };
    if (dy) {
      dy.onclick = copy;
      dy.onkeydown = e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); copy(); } };
    }
  }

  /* 阅读器里的「Aa」排版面板：字号 / 行距 / 段距 / 字体 / 翻页方式 / 主题。
     行距、段距以前只能去设置页调，而且段距由行距推导，压不紧段落。 */
  let typesetT = null;
  function typesetPanel() {
    const s = S.state.settings;
    const show = () => ({
      fs: s.fontSize + 'px',
      lh: s.lineHeight.toFixed(2).replace(/0$/, ''),
      pg: paraGapEm(s).toFixed(2) + 'em'
    });
    const v0 = show();
    openModal(`<h3>排版</h3>
      <p class="desc">拖动即时生效 · 只影响阅读页</p>
      <div class="ts-grid">
        <div class="ts-row"><span class="ts-k">字号</span>
          <input type="range" id="ts-fs" min="15" max="30" step="1" value="${s.fontSize}" />
          <span class="ts-v" id="ts-fs-v">${v0.fs}</span></div>
        <div class="ts-row"><span class="ts-k">行距</span>
          <input type="range" id="ts-lh" min="120" max="240" step="5" value="${Math.round(s.lineHeight * 100)}" />
          <span class="ts-v" id="ts-lh-v">${v0.lh}</span></div>
        <div class="ts-row"><span class="ts-k">段距</span>
          <input type="range" id="ts-pg" min="0" max="150" step="5" value="${Math.round(paraGapEm(s) * 100)}" />
          <span class="ts-v" id="ts-pg-v">${v0.pg}</span></div>
        <div class="ts-row"><span class="ts-k">字体</span>
          <div class="seg" id="ts-font"><button data-v="serif" class="${s.fontFamily === 'serif' ? 'on' : ''}">宋体</button><button data-v="sans" class="${s.fontFamily === 'sans' ? 'on' : ''}">黑体</button></div>
          <span class="ts-v"></span></div>
        <div class="ts-row"><span class="ts-k">翻页</span>
          <div class="seg" id="ts-mode"><button data-v="scroll" class="${s.pageMode === 'scroll' ? 'on' : ''}">滚动</button><button data-v="paged" class="${s.pageMode === 'paged' ? 'on' : ''}">翻页</button></div>
          <span class="ts-v"></span></div>
        <div class="ts-row"><span class="ts-k">主题</span>
          <div class="swatches" id="ts-theme">
            <button class="sw ${s.theme === 'paper' ? 'on' : ''}" data-t="paper" style="background:#fbfaf7" title="纸白"></button>
            <button class="sw ${s.theme === 'sepia' ? 'on' : ''}" data-t="sepia" style="background:#f6efe1" title="米黄"></button>
            <button class="sw ${s.theme === 'green' ? 'on' : ''}" data-t="green" style="background:#e6efe4" title="浅绿"></button>
            <button class="sw ${s.theme === 'night' ? 'on' : ''}" data-t="night" style="background:#1a1e24" title="夜间"></button>
          </div><span class="ts-v"></span></div>
      </div>
      <div class="modal-actions">
        <button class="btn" id="ts-reset">恢复推荐</button>
        <button class="btn primary" id="ts-done">完成</button>
      </div>`);

    /* 拖动时只更新样式，重排交给 90ms 防抖：一页几百段时每移动 1px 都重排会明显卡手 */
    const relayout = () => {
      applyReaderStyle();
      if (!R.book || !R.paras.length) return;
      clearTimeout(typesetT);
      typesetT = setTimeout(() => { try { renderChapter(); } catch (e) { /* 重排失败不该打断拖动 */ } }, 90);
    };
    const bindRange = (id, onInput) => {
      const el = $('#' + id);
      if (!el) return;
      el.oninput = () => onInput(+el.value);
      el.onchange = () => save();
    };
    bindRange('ts-fs', v => {
      s.fontSize = v; $('#ts-fs-v').textContent = v + 'px'; relayout();
    });
    bindRange('ts-lh', v => {
      s.lineHeight = v / 100; $('#ts-lh-v').textContent = (v / 100).toFixed(2).replace(/0$/, ''); relayout();
    });
    bindRange('ts-pg', v => {
      s.paraGapEm = v / 100; s.paraGap = v > 0;
      $('#ts-pg-v').textContent = (v / 100).toFixed(2) + 'em'; relayout();
    });
    $$('#ts-font button').forEach(b => b.onclick = () => {
      $$('#ts-font button').forEach(x => x.classList.remove('on'));
      b.classList.add('on'); s.fontFamily = b.dataset.v; relayout(); save();
    });
    $$('#ts-mode button').forEach(b => b.onclick = () => {
      $$('#ts-mode button').forEach(x => x.classList.remove('on'));
      b.classList.add('on'); s.pageMode = b.dataset.v; R.page = 0; relayout(); save();
    });
    $$('#ts-theme .sw').forEach(el => el.onclick = () => {
      $$('#ts-theme .sw').forEach(x => x.classList.remove('on'));
      el.classList.add('on'); setTheme(el.dataset.t); save();
    });
    $('#ts-reset').onclick = () => {
      s.fontSize = 19; s.lineHeight = 1.7; s.paraGapEm = 0.5; s.paraGap = true;
      s.fontFamily = 'serif'; s.typoV = 1;
      applyReaderStyle(); if (R.book && R.paras.length) renderChapter(); save();
      closeModal(); toast('已恢复推荐排版');
    };
    $('#ts-done').onclick = () => { save(); closeModal(); };
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

  /**
   * 在（可能已经变了的）目录里按标题找回「上次读的那一章」。
   * 章节索引只在同一份目录里才有意义：备份记的是原书源目录的索引，
   * 站点补全目录、换源、或者目录从「最新章节 12 条」变成 716 章之后，
   * 同一个 ci 指向的就是完全不同的章（显示第59章、点进去第660章）。
   */
  function matchChapterIndex(chapters, want, hint, oldTotal) {
    if (!chapters || !chapters.length) return -1;
    if (!String(want || '').trim()) return -1;
    const nw = normChapTitle(want);
    const hits = [];
    chapters.forEach((c, i) => {
      if (nw && normChapTitle(c.title) === nw) hits.push(i);
    });
    if (!hits.length && nw) {
      /* 站点在标题里加了前后缀（「第59章 xxx（1/2）」）：退一步用包含关系 */
      chapters.forEach((c, i) => {
        const t2 = normChapTitle(c.title);
        if (!t2 || hits.indexOf(i) >= 0) return;
        if (t2.indexOf(nw) === 0 || nw.indexOf(t2) === 0) hits.push(i);
      });
    }
    if (!hits.length) {
      /* 标题被彻底改过：用章节号兜底（第59章 ↔ 第059章） */
      const no = Engine.chapNo(want);
      if (isFinite(no)) chapters.forEach((c, i) => { if (Engine.chapNo(c.title) === no) hits.push(i); });
    }
    if (!hits.length) return -1;
    if (hits.length === 1) return hits[0];
    /* 同名章节（「第1章」在好几个卷里都出现）：挑离原位置最近的那个 */
    const guess = oldTotal && oldTotal !== chapters.length ? (hint || 0) * (chapters.length / oldTotal) : (hint || 0);
    return hits.reduce((best, i) => (Math.abs(i - guess) < Math.abs(best - guess) ? i : best), hits[0]);
  }

  /* 换源时同一个关键词会在多个源上反复搜：10 分钟内直接复用结果，
     第二次打开换源基本是立刻出列表，不用再等一轮网络。 */
  const SEARCH_MEMO = new Map();
  const MEMO_TTL = 10 * 60e3;
  /* 目录也缓存：换回上次用过的源时不用再抓一遍（588 章那本书一次要 700ms+） */
  const TOC_MEMO = new Map();
  function memoTocGet(src, bookUrl) {
    const m = TOC_MEMO.get(src.id + '|' + bookUrl);
    return m && Date.now() - m.at < MEMO_TTL ? m.toc : null;
  }
  function memoTocPut(src, bookUrl, toc) {
    if (TOC_MEMO.size > 60) TOC_MEMO.clear();
    TOC_MEMO.set(src.id + '|' + bookUrl, { at: Date.now(), toc });
  }
  async function fetchToc(src, bookUrl) {
    const hit = memoTocGet(src, bookUrl);
    if (hit) return hit;
    const toc = await withTimeout(Engine.getToc(netGet, src, bookUrl), 30000);
    if (toc && toc.chapters && toc.chapters.length) memoTocPut(src, bookUrl, toc);
    return toc;
  }
  function memoSearch(src, kw) {
    const k = src.id + '|' + kw;
    const m = SEARCH_MEMO.get(k);
    if (m && Date.now() - m.at < MEMO_TTL) return Promise.resolve(m.hits);
    /* 请求本身也要带超时：JS 这边 7 秒就放弃等它了，但底层连接不会跟着取消，
       安卓上会一直占着桥线程到默认的 18 秒 —— 并发一高就全在排队。 */
    const net = u => netGet(Object.assign({ timeout: 8000 }, u));
    const p = Engine.search(net, src, kw).then(hits => {
      if (SEARCH_MEMO.size > 400) SEARCH_MEMO.clear();
      SEARCH_MEMO.set(k, { at: Date.now(), hits });
      return hits;
    }, err => {
      /* 失败也记一笔：两千多个源里死源占大多数，不缓存的话每次打开换源面板
         都要陪它们把超时再等一遍 */
      if (SEARCH_MEMO.size > 400) SEARCH_MEMO.clear();
      SEARCH_MEMO.set(k, { at: Date.now(), hits: [], dead: true });
      throw err;
    });
    /* withTimeout 会先放手，底层请求失败时别冒成未处理的 rejection */
    p.catch(() => {});
    return p;
  }

  async function switchSource(kwOverride) {
    const b = R.book || (S.state.books.find(x => x.id === S.switchBookId));
    if (!b) return;
    const enabled = S.state.sources.filter(s => s.enabled && s.searchUrl);
    if (!enabled.length) { toast('没有启用的网络书源，先去「扩展 → 书源」里启用'); return; }
    /* 从原版备份恢复后动辄两千多个源，只搜 24 个等于把备份里排在后面的源全丢掉，
       「以前能看的那个源」往往就找不到。书源多时自动把上限提上来。 */
    let cap = clamp(S.state.settings.switchLimit || 24, 4, 120);
    if (enabled.length > 200) cap = Math.max(cap, 48);
    const alive = enabled.filter(s => s.quality !== 'dead');
    const pool = alive.length ? alive : enabled;
    const originSrc = srcForBook(b);      // 备份里这本书原本用的源
    const used = new Set(S.state.books.map(x => x.sourceId).filter(Boolean));
    /* 优先级：本书原源 → 书架在用的源 → 检测过的优质源 → 其余按备份里的顺序。
       第一屏就是「备份原源 + 以前能看的源」，列表顺序也跟着备份走。 */
    const prio = s => {
      if (originSrc && s.id === originSrc.id) return 0;
      if (used.has(s.id)) return 1;
      if (s.quality === 'great' || s.quality === 'ok') return 2;
      if (s.quality === 'poor') return 4;
      return 3;
    };
    const poolIdx = new Map(pool.map((s, i) => [s, i]));
    const cmp = (a, c) => (prio(a) - prio(c)) || (poolIdx.get(a) - poolIdx.get(c));
    const srcs = pool.slice().sort(cmp).slice(0, cap);
    const srcRank = new Map(srcs.map((s, i) => [s.id, i]));
    const skipped = enabled.length - srcs.length;
    const conc = isAndroidApp() ? 6 : 10;
    const kw = (typeof kwOverride === 'string' && kwOverride.trim())
      ? kwOverride.trim() : cleanSearchKw(b.name);

    openModal(`<h3>换源 · ${esc(b.name)}</h3>
      <p class="desc">在 ${srcs.length} 个书源里找同名书（共启用 ${enabled.length} 个，优先备份原源与书架在用的源${skipped > 0 ? `，本次不搜 ${skipped} 个` : ''}）。<br>当前读到：${esc(R.title || '未开始')}（第 ${(R.ci || 0) + 1} 章）</p>
      <div style="display:flex;gap:8px;align-items:center;margin:10px 0">
        <input id="sw-kw" type="text" value="${esc(kw)}" placeholder="搜索关键词" style="flex:1;min-width:0;padding:8px 10px;border:1px solid #c9ced8;border-radius:8px;background:#fff;color:#222;font-size:14px" />
        <button class="btn sm" id="sw-research">换个词搜</button>
      </div>
      <div class="sw-prog"><span id="sw-prog-t">准备搜索…</span><button class="link" id="sw-stop">停止</button></div>
      <div class="sw-list searching" id="sw-list"><div class="hint" id="sw-hint">搜索中…</div></div>
      <div class="modal-actions">
        <button class="btn left" id="sw-web">去网页搜书</button>
        <button class="btn" onclick="window.__closeModal()">关闭</button>
      </div>`, true);
    const swWeb = $('#sw-web');
    if (swWeb) swWeb.onclick = () => {
      closeModal();
      setSearchMode('web');
      setView('search');
      setTimeout(() => {
        const i = $('#search-input');
        if (i) i.value = kw;
        runSearch(kw);
      }, 60);
    };

    const box = $('#sw-list');
    const hits = [];
    const keys = new Set();
    const t0 = Date.now();
    let cursor = 0, done = 0, stopped = false, finished = false;

    const rowHtml = r => {
      const cur = r.sourceId === b.sourceId;
      const isOrigin = !!(originSrc && r.sourceId === originSrc.id);
      const q = (sourceById(r.sourceId) || {}).quality;
      const key = r.sourceId + '|' + r.bookUrl;
      return `<div class="sw-item ${cur ? 'cur' : ''}" data-key="${esc(key)}">
        <div class="sw-ico">${esc((r.sourceName || '源')[0])}</div>
        <div class="sw-body">
          <div class="sw-t">${esc(r.name)}<span class="chip">${esc(r.sourceName || '')}</span>${q ? `<span class="chip q-${q}">${Q_NAME[q] || ''}</span>` : ''}${isOrigin ? '<span class="chip on">备份原源</span>' : (cur ? '<span class="chip on">当前源</span>' : '')}</div>
          <div class="sw-s">${esc(r.author || '佚名')}${r.lastChapter ? ' · ' + esc(r.lastChapter) : ''}</div>
        </div>
        <button class="btn sm ${cur ? '' : 'primary'}" data-sw="${esc(key)}">${cur ? '重试此源' : '切到这本'}</button>
      </div>`;
    };
    /* 搜索过程中只往列表尾部追加，绝不整体重排 —— 这就是「列表不停跳动」的根因。
       全部搜完后按「备份书源顺序（原源在最前）→ 质量」排一次：
       换源列表的顺序要跟备份里的一致，不能让检测结果把它打乱。 */
    const appendHits = list => {
      const h = $('#sw-hint');
      if (h) h.remove();
      box.insertAdjacentHTML('beforeend', list.map(rowHtml).join(''));
    };
    const qrank = r => {
      const q = (sourceById(r.sourceId) || {}).quality;
      return q === 'great' ? 0 : q === 'ok' ? 1 : q === 'poor' ? 3 : q ? 4 : 2;
    };
    const sortHits = () => hits.sort((x, y) =>
      ((srcRank.get(x.sourceId) ?? 9999) - (srcRank.get(y.sourceId) ?? 9999)) ||
      (qrank(x) - qrank(y)) ||
      String(x.name).localeCompare(String(y.name)));
    const progress = () => {
      const el = $('#sw-prog-t');
      if (!el) return;
      const sec = Math.max(0, Math.round((Date.now() - t0) / 1000));
      const left = done > 0 ? Math.max(0, Math.round(sec / done * (srcs.length - done))) : 0;
      el.textContent = finished
        ? `已搜 ${done}/${srcs.length} 个源，找到 ${hits.length} 本 · 用时 ${sec}s${hits.length >= 20 ? ' · 够用了，提前结束' : ''}${hits.length ? '' : '（换个关键词或去网页里手动找）'}`
        : `已搜 ${done}/${srcs.length} · 找到 ${hits.length} 本 · 约剩 ${left}s`;
    };

    $('#sw-stop').onclick = () => {
      stopped = true;
      const el = $('#sw-prog-t');
      if (el) el.textContent = '正在停止…';
    };
    /* 备份里的书名常被拼上角色名（「XX王浩苏映雪」），拿全名去搜很多站都搜不到。
       允许用户改关键词重搜，这是「以前能看的书现在换源找不到」最常见的解法。 */
    $('#sw-research').onclick = () => {
      const nk = (($('#sw-kw') || {}).value || '').trim();
      if (!nk) return toast('关键词不能为空');
      if (nk === kw) return toast('关键词没变，直接用下面的列表就行');
      stopped = true;
      closeModal();
      setTimeout(() => switchSource(nk), 0);
    };
    box.addEventListener('click', e => {
      const btn = e.target.closest('[data-sw]');
      if (!btn) return;
      const key = btn.dataset.sw;
      const r = hits.find(h => h.sourceId + '|' + h.bookUrl === key);
      if (r) applySwitch(r, btn);
    });

    /* 高级源（带 jsLib 的书源）执行规则时走同步请求，一发起就把主线程钉住几百毫秒到 1.5 秒。
       以前它们和普通源一起被 8 个并发拉着跑，换源面板就一直在卡。
       现在拆成两条队列：普通源照旧并发，高级源一次只跑一个，跑前先把控制权还给界面。 */
    const isAdv = s => !!s.jsLib;
    const plainSrcs = srcs.filter(s => !isAdv(s));
    const advSrcs = srcs.filter(isAdv);
    const stillOpen = () => !stopped && document.body.contains(box) && $('#modal').classList.contains('open');
    const tryOne = async s => {
      try {
        const r = await withTimeout(memoSearch(s, kw), isAdv(s) ? 6000 : 4500);
        const fresh = [];
        for (const x of r) {
          /* 整页兜底解析出来的「结果」多数不是书，换源列表里只会添乱 */
          if (x.loose) continue;
          const a = normChapTitle(x.name), t = normChapTitle(kw);
          if (!(a === t || a.includes(t) || t.includes(a))) continue;
          const key = x.sourceId + '|' + x.bookUrl;
          if (keys.has(key)) continue;
          keys.add(key);
          hits.push(x);
          fresh.push(x);
        }
        if (fresh.length) appendHits(fresh);
      } catch (e) { /* 单个源失败不影响其他 */ }
      done++;
      progress();
    };
    const plainWorker = async () => {
      while (true) {
        if (stopped || hits.length >= 12) return;
        if (!stillOpen()) return;
        const i = cursor++;
        if (i >= plainSrcs.length) return;
        await new Promise(r => setTimeout(r, 0));      // 让界面先画一帧
        await tryOne(plainSrcs[i]);
      }
    };
    /* 高级源默认不搜：它们跑一次要把界面钉住 0.5~1.6 秒，
       换源面板的主要体验应该是「立刻有列表」。想试的用户点一下就跑。 */
    let advRunning = false;
    const runAdv = async () => {
      if (advRunning) return;
      advRunning = true;
      for (const s of advSrcs) {
        if (stopped) return;
        if (!stillOpen()) return;
        const el = $('#sw-prog-t');
        if (el) el.textContent = `正在试高级源 ${advSrcs.indexOf(s) + 1}/${advSrcs.length}：${s.name}（脚本源，界面会卡一下）`;
        await new Promise(r => setTimeout(r, 30));
        const before = hits.length;
        await tryOne(s);
        if (hits.length > before) {
          box.classList.remove('searching');
          box.insertAdjacentHTML('beforeend', hits.slice(before).map(rowHtml).join(''));
          box.scrollTop = box.scrollHeight;
        }
      }
    };
    await Promise.all(Array.from({ length: Math.max(1, Math.min(conc, plainSrcs.length)) }, plainWorker));
    finished = true;
    sortHits();
    if (document.body.contains(box)) {
      box.classList.remove('searching');
      box.innerHTML = hits.length
        ? hits.map(rowHtml).join('')
        : `<div class="hint">没有找到同名书。换个关键词，或去「网页」里手动找。</div>`;
      const st = $('#sw-stop');
      if (st) st.remove();
      progress();
      if (advSrcs.length) {
        const bar = document.createElement('div');
        bar.className = 'sw-adv';
        bar.innerHTML = `<span>还有 ${advSrcs.length} 个「脚本书源」没试（规则是 JS，跑起来会卡一下界面）</span>
          <button class="btn sm" id="sw-adv">试一下</button>`;
        box.parentNode.insertBefore(bar, box.nextSibling);
        const b2 = bar.querySelector('#sw-adv');
        if (b2) b2.onclick = () => { b2.disabled = true; b2.textContent = '试运行中…'; runAdv(); };
      }
    }
  }

  /* 阅读器顶部那行小字：换源/更新目录这种「要等一会儿」的动作拿它当进度条，
     比弹窗好——不挡正文，也不会有第二个窗口跳出来打断阅读。 */
  function showReaderBusy(msg) {
    const el = $('#r-loading');
    if (el) el.textContent = msg || '加载中…';
  }
  function hideReaderBusy() {
    const el = $('#r-loading');
    if (el) el.textContent = '';
  }

  async function applySwitch(r, btn) {
    const b = R.book || S.state.books.find(x => x.id === S.switchBookId);
    if (!b) return;
    const src = sourceById(r.sourceId);
    if (!src) return toast('书源不存在');
    /* 只锁被点的那一个：以前用 $('[data-sw]') 取到的是列表首个按钮，
       点第 3 本失败时变灰的是第 1 本，看着像「点了没反应」 */
    const label = btn ? btn.textContent : '';
    const busy = on => { if (!btn) return; btn.disabled = on; btn.textContent = on ? '切换中…' : label; };
    busy(true);
    /* 先把面板收掉：目录要抓 0.7~2 秒，让用户盯着一个不动的弹窗就是「卡」
       （目录有缓存时下面几乎是瞬间完成的） */
    const cached = memoTocGet(src, r.bookUrl);
    closeModal();
    showReaderBusy(`正在切到「${src.name}」…`);
    let toc;
    try {
      toc = await fetchToc(src, r.bookUrl);
    } catch (e) {
      busy(false);
      hideReaderBusy();
      return toast('换源失败：' + (e.message || e));
    }
    if (!toc.chapters.length) { busy(false); hideReaderBusy(); return toast('这个源没有目录，换一个试试'); }
    if (cached) hideReaderBusy();

    const curTitle = R.title || '';
    const curNorm = normChapTitle(curTitle);
    /* 换源后目录顺序/章数都可能变，索引不可信，一律按标题找回当前章 */
    let idx = matchChapterIndex(toc.chapters, curTitle, R.ci, b.chapters ? b.chapters.length : 0);
    if (idx < 0 && curNorm) idx = toc.chapters.findIndex(c => normChapTitle(c.title).includes(curNorm) && curNorm.length > 1);
    if (idx < 0) idx = clamp(R.ci, 0, toc.chapters.length - 1);

    /* 标记为用户手工选的源：以后再导入备份时不要把他选的覆盖回备份里的旧源 */
    b.manualSource = true;
    b.kind = 'online';       // 从网页书/漫画换回书源时，类型也要跟着变
    b.tocFixed = true;       // 换源就是人工确认过目录，别再后台自动补
    if (toc.tocUrl) b.tocUrl = toc.tocUrl;
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
    renderShelf();          // 书架卡片上的来源名 / 进度跟着换，不然回到书架像没换成
    R.chapters = b.chapters;
    R.ci = idx;
    buildToc();
    if (R.book) await loadChapter(idx, 0);
    hideReaderBusy();
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
    $('#r-type').onclick = typesetPanel;
    $('#r-toc').onclick = () => {
      const open = $('#r-toc-panel').classList.toggle('open');
      $('#toc-mask').classList.toggle('on', open);
      if (open) setTocTab(R.tocTab || 'toc');
    };
    $$('#toc-tabs button').forEach(b => b.onclick = () => setTocTab(b.dataset.tab));
    $('#toc-mask').onclick = closeTocPanel;
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
      /* 扩展里的子页（书源 / 历史 / 统计）先退回扩展菜单，再退到书架 */
      if (S.view === 'ext' && S.ext) { S.ext = null; renderExt(); const t = $('#tb-title'); if (t) t.textContent = '扩展'; return true; }
      /* 设置里的模块页（阅读 / 朗读 / 备份…）先退回设置菜单 */
      if (S.view === 'settings' && S.set) { S.set = null; renderSettings(); const t = $('#tb-title'); if (t) t.textContent = '设置'; return true; }
      /* 网页搜书里点进某个站之后，返回应当退回搜索结果那一页 */
      if (S.view === 'search' && S.searchMode === 'web' && WA.stack.length) {
        const wb = $('#wa-back');
        if (wb && !wb.disabled) { wb.click(); return true; }
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
          /* 直接落到「数据与备份」那一页，别让用户在设置菜单里再找一遍 */
          S.set = 'data';
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
      openReader, loadChapter, runSearch, ttsVoices, ttsOrderedVoices, pickSearchSources,
      previewOnlineBook, readPreview, resolveImgs, paintOnline,   // 预览 / 漫画取图：自动化验证用
      previewWebBook, waFetch, upgradeWa,                          // 网页书预览 / 抓取：自动化验证用
      renderWaResult,                                              // 网页搜书结果渲染：自动化验证用
      showSourcePicker, groupResults,   // 搜索结果合并 / 换源面板：自动化验证用
      doImport   // 自动化导入用：绕过 pickBooks（contextBridge 对象不可改写）
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
