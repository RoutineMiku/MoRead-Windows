/**
 * 书源自动检测：批量探活 + 采样抓目录/正文，把书源分成
 *   优质 great / 有效 ok / 较差 poor / 无用 dead
 * 结果写回 source.quality / qScore / qNote / qAt，供书源页筛选、分组和「换源」优先使用。
 *
 * 判定口径（改过两次，都是为了少误杀）：
 *   1. 先分清「站点打不开」和「站点能开但规则不对」——只有前者才是无用；
 *      后者只是这个源写得不好，站点还在，换个规则也许就能用。
 *   2. 同一域名已经确认打不开，后面同域的书源直接跳过，不再逐个等超时
 *      （书源包里几十个源指向同一个站很常见，这是检测慢的主因）。
 *   3. 超时/连接重置这类抖动错误重试一次，安卓网络切换 WiFi/流量时尤其常见。
 */
(function (global) {
  'use strict';
  const LEVELS = [
    { key: 'great', name: '优质', desc: '目录完整、正文正常、响应快' },
    { key: 'ok', name: '有效', desc: '能搜能读，但章节少或偏慢' },
    { key: 'poor', name: '较差', desc: '能连通，但搜不到 / 目录空 / 正文异常' },
    { key: 'dead', name: '无用', desc: '连不通：域名失效、404/403、超时' }
  ];
  const LEVEL_MAP = Object.fromEntries(LEVELS.map(l => [l.key, l]));
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  /* 把原始错误信息压成一句人话 */
  function brief(msg) {
    const m = String(msg || '');
    if (/ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(m)) return '域名解析失败（站点已关停）';
    if (/域名无法解析|无法解析/.test(m)) return '域名解析失败（站点已关停）';
    if (/404/.test(m)) return '404 地址失效';
    if (/403/.test(m)) return '403 被拒绝（反爬）';
    if (/429/.test(m)) return '429 请求过快';
    if (/明文 HTTP|cleartext/i.test(m)) return '明文 HTTP 被系统拦截';
    if (/网络不可用|ENETUNREACH/i.test(m)) return '网络不可用';
    if (/5\d\d/.test(m)) return '服务器错误';
    if (/超时|timeout|ETIMEDOUT/i.test(m)) return '请求超时';
    if (/证书|CERT|SSL|trust anchor/i.test(m)) return '证书异常';
    if (/ECONNREFUSED|连接被拒绝/i.test(m)) return '连接被拒绝';
    if (/ECONNRESET|连接被重置|socket/i.test(m)) return '连接被重置';
    return m.slice(0, 40);
  }

  /* 一眼能断定「这个站没了」的错误：同域可以直接跳过 */
  const HOST_DOWN_RE = /ENOTFOUND|EAI_AGAIN|getaddrinfo|域名解析失败|域名无法解析|无法解析|ECONNREFUSED|连接被拒绝|网络不可用|ENETUNREACH|地址不合法/i;
  /* 抖动类错误：值得再试一次 */
  const TRANSIENT_RE = /超时|timeout|ETIMEDOUT|ECONNRESET|连接被重置|socket|429|服务器错误|5\d\d/i;

  function hostOf(src) {
    const raw = src.url || src.searchUrl || '';
    try { return new URL(raw).hostname.toLowerCase(); } catch (e) { return ''; }
  }

  /* 硬超时：请求本身取消不了，但不必再等它的结果 */
  function race(p, ms) {
    return new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error('检测超时')), ms);
      Promise.resolve(p).then(v => { clearTimeout(t); res(v); }, e => { clearTimeout(t); rej(e); });
    });
  }

  /** 站点还活着吗：只发一个首页请求，任何 HTTP 状态码都算活着 */
  async function siteAlive(src, o) {
    const host = hostOf(src);
    if (!host) return null;
    if (o.siteCache && o.siteCache.has(host)) return o.siteCache.get(host);
    const target = src.url || (() => { try { return new URL(src.searchUrl).origin; } catch (e) { return ''; } })();
    if (!target) return null;
    let alive = false;
    try {
      const r = await race(o.fetch({ url: target, timeout: Math.min(5000, o.timeout), charset: 'auto' }), 6000);
      alive = !!(r && r.ok);
      /* 证书出错说明站点在，只是证书烂；本来就是「能连通但不好用」 */
      if (!alive && r && /证书|CERT|SSL/i.test(String(r.error || ''))) alive = true;
    } catch (e) { alive = false; }
    if (o.siteCache) o.siteCache.set(host, alive);
    if (!alive && o.hostDown && host) o.hostDown.add(host);
    return alive;
  }

  /** 搜索命中的书名和关键词最像的那本，深检才不会被第一本杂书带偏 */
  function bestHit(hits, kw) {
    if (!hits.length) return null;
    const k = String(kw || '');
    const score = h => {
      const n = String(h.name || '');
      let s = 0;
      if (n === k) s += 5;
      else if (n.includes(k)) s += 3;
      else if (k && n.includes(k.slice(0, 1))) s += 1;
      if (h.author && h.author !== '佚名') s += 1;
      if (h.lastChapter) s += 1;
      return s;
    };
    return hits.slice().sort((a, b) => score(b) - score(a))[0];
  }

  /**
   * 单个书源检测
   * @param src 书源对象
   * @param o   { fetch, keyword, deep, timeout, probeUrl, hostDown, siteCache }
   * @returns   { id, quality, score, note, ms, search, chapters, chars }
   */
  async function one(src, o) {
    const t0 = Date.now();
    const out = {
      id: src.id, name: src.name, quality: 'dead', score: 0, note: '',
      ms: 0, search: 0, chapters: 0, chars: 0, deep: false, reach: null
    };
    const net = u => o.fetch(Object.assign({ timeout: o.timeout }, u));
    const host = hostOf(src);

    if (!src.searchUrl && !o.probeUrl) {
      out.note = '没有搜索地址';
      out.quality = 'poor';
      out.ms = Date.now() - t0;
      return out;
    }
    /* 同域已经确认站点没了：不再花 8 秒等超时 */
    if (host && o.hostDown && o.hostDown.has(host)) {
      out.note = '同一站点无法访问';
      out.ms = Date.now() - t0;
      return out;
    }

    /* ---- 阶段 A：搜索探活（抖动错误重试一次） ---- */
    let hits = [];
    let aErr = '';
    const kw = o.keyword || '剑';
    if (src.searchUrl) {
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          hits = await race(Engine.search(net, src, kw), o.timeout + 1500);
          aErr = '';
          break;
        } catch (e) {
          aErr = brief(e.message || e);
          const raw = String(e.message || e);
          if (attempt === 0 && TRANSIENT_RE.test(raw)) { await sleep(260); continue; }
          break;
        }
      }
      out.search = hits.length;
      out.loose = hits.length > 0 && hits.every(h => h.loose);
      if (aErr && HOST_DOWN_RE.test(aErr) && host && o.hostDown) o.hostDown.add(host);
    }

    /* ---- 阶段 A2：搜索失败不等于站点没了，先确认站点能不能打开 ---- */
    if (aErr && !(host && o.hostDown && o.hostDown.has(host))) {
      out.reach = await siteAlive(src, o);
      if (out.reach === false) {
        out.quality = 'dead';
        out.note = aErr || '站点无法访问';
        out.ms = Date.now() - t0;
        return out;
      }
    }

    /* ---- 阶段 B：抓目录 + 正文（默认只搜到结果才深检，省时间） ---- */
    /* 优先用书架上这本书的真实地址；它失效了再退回搜索结果里最像的那本，
       不然一个过期的书架地址会把整条书源误判成「目录为空」。 */
    const candidates = [];
    if (o.probeUrl) candidates.push(o.probeUrl);
    const bh = bestHit(hits, kw);
    if (bh && bh.bookUrl && candidates.indexOf(bh.bookUrl) < 0) candidates.push(bh.bookUrl);
    if (o.deep && candidates.length) {
      out.deep = true;
      /* 检测只要知道目录抓不抓得到，不翻页，否则一个源可能拖几十秒 */
      const s2 = Object.assign({}, src, {
        ruleToc: Object.assign({}, src.ruleToc || {}, { nextTocUrl: '' })
      });
      for (const bookUrl of candidates.slice(0, 2)) {
        try {
          const toc = await race(Engine.getToc(net, s2, bookUrl), o.timeout + 2000);
          out.chapters = (toc.chapters || []).length;
          out.note = '';
          if (out.chapters) {
            const mid = Math.min(Math.floor(out.chapters / 2), out.chapters - 1);
            try {
              const c = await race(Engine.getContent(net, s2, toc.chapters[mid].url), o.timeout + 2000);
              out.chars = (c.paras || []).join('').replace(/\s/g, '').length;
            } catch (e) { out.chars = 0; }
            break;
          }
        } catch (e) {
          if (!out.chapters) out.note = brief(e.message || e);
        }
      }
    }

    out.ms = Date.now() - t0;

    /* ---- 定级 ---- */
    if (aErr && !out.search && !out.chapters) {
      /* 站点刚确认能打开：这是规则/反爬问题，不是死源 */
      if (out.reach === true) {
        out.quality = 'poor';
        out.score = 25;
        out.note = '站点可达，但搜索失败：' + aErr;
      } else {
        out.quality = 'dead';
        out.note = aErr;
        out.score = 0;
      }
      return out;
    }

    if (out.deep) {
      if (out.chapters >= 20 && out.chars >= 800 && out.ms < 12000) {
        out.quality = 'great'; out.score = 90 + Math.min(10, Math.floor(out.chapters / 100));
      } else if (out.chapters >= 5 && out.chars >= 200) {
        out.quality = 'ok'; out.score = 60 + Math.min(25, Math.floor(out.chars / 200));
      } else if (out.chapters > 0) {
        out.quality = 'poor'; out.score = 30;
        out.note = out.note || `目录 ${out.chapters} 章 / 正文 ${out.chars} 字`;
      } else {
        out.quality = 'poor'; out.score = 20;
        out.note = out.note || '目录为空（规则可能不适配）';
      }
    } else if (out.loose) {
      /* 搜索页整页被当成一本书的兜底解析：能连上，但结果不可信 */
      out.quality = 'poor'; out.score = 25;
      out.note = '搜索页解析不到列表（规则可能不适配）';
    } else {
      /* 没深检就分不出「优质」：只证明能搜到，不代表目录和正文正常 */
      if (out.search > 0) {
        out.quality = 'ok'; out.score = out.search >= 3 ? 65 : 55;
        out.note = `未深检 · 搜到 ${out.search} 条`;
      } else {
        out.quality = 'poor'; out.score = 15;
        out.note = out.note || aErr || '搜索无结果';
      }
    }
    if (out.ms > 12000 && out.quality === 'great') out.quality = 'ok';
    return out;
  }

  /**
   * 批量检测
   * @param o { sources, fetch, keyword, deep, concurrency, timeout, onProgress, onResult, shouldStop, probeUrlOf }
   */
  async function run(o) {
    const list = o.sources || [];
    const conc = Math.max(1, Math.min(20, o.concurrency || 8));
    const summary = { great: 0, ok: 0, poor: 0, dead: 0 };
    const results = [];
    let cursor = 0, done = 0;
    const stopped = () => (o.shouldStop && o.shouldStop());
    /* 整轮共享：哪些域名已经确认挂了、哪些站点确认能开 */
    const hostDown = new Set();
    const siteCache = new Map();

    const worker = async () => {
      while (true) {
        if (stopped()) return;
        const i = cursor++;
        if (i >= list.length) return;
        const s = list[i];
        let r;
        try {
          /* 总闸：单个源最多占这么久，避免个别站把整轮拖死 */
          r = await race(one(s, {
            fetch: o.fetch, keyword: o.keyword || '剑', deep: !!o.deep,
            timeout: o.timeout || 8000,
            probeUrl: o.probeUrlOf ? o.probeUrlOf(s) : '',
            hostDown, siteCache
          }), o.deep ? 24000 : 12000);
        } catch (e) {
          r = { id: s.id, name: s.name, quality: 'dead', score: 0, note: brief(e.message || e), ms: 0 };
          /* 不把「这一轮太慢」当成域名失效：慢站也可能只是正文页卡，
             同域其它书源还会单独检测，避免一次超时连坐一整个站点。 */
        }
        results.push(r);
        summary[r.quality] = (summary[r.quality] || 0) + 1;
        done++;
        if (o.onResult) o.onResult(r);
        if (o.onProgress) o.onProgress(done, list.length, summary, r);
      }
    };

    await Promise.all(Array.from({ length: Math.min(conc, list.length) }, worker));
    results.sort((a, b) => b.score - a.score);
    return { results, summary, total: results.length, stopped: stopped() };
  }

  global.Detect = { run, one, LEVELS, LEVEL_MAP, brief };
})(window);
