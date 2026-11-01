/**
 * 书源自动检测：批量探活 + 采样抓目录/正文，把书源分成
 *   优质 great / 有效 ok / 较差 poor / 无用 dead
 * 结果写回 source.quality / qScore / qNote / qAt，供书源页筛选、分组和「换源」优先使用。
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

  /* 把原始错误信息压成一句人话 */
  function brief(msg) {
    const m = String(msg || '');
    if (/ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(m)) return '域名解析失败（站点已关停）';
    if (/404/.test(m)) return '404 地址失效';
    if (/403/.test(m)) return '403 被拒绝（反爬）';
    if (/429/.test(m)) return '429 请求过快';
    if (/5\d\d/.test(m)) return '服务器错误';
    if (/超时|timeout|ETIMEDOUT/i.test(m)) return '请求超时';
    if (/证书|CERT|SSL/i.test(m)) return '证书异常';
    if (/ECONNREFUSED|ECONNRESET|socket/i.test(m)) return '连接被重置';
    return m.slice(0, 40);
  }

  /**
   * 单个书源检测
   * @param src 书源对象
   * @param o   { fetch, keyword, deep, timeout, probeUrl }
   * @returns   { id, quality, score, note, ms, search, chapters, chars }
   */
  /* 硬超时：请求本身取消不了，但不必再等它的结果 */
  function race(p, ms) {
    return new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error('检测超时')), ms);
      Promise.resolve(p).then(v => { clearTimeout(t); res(v); }, e => { clearTimeout(t); rej(e); });
    });
  }

  async function one(src, o) {
    const t0 = Date.now();
    const out = { id: src.id, name: src.name, quality: 'dead', score: 0, note: '', ms: 0, search: 0, chapters: 0, chars: 0, deep: false };
    const net = u => o.fetch(Object.assign({ timeout: o.timeout }, u));

    if (!src.searchUrl && !o.probeUrl) {
      out.note = '没有搜索地址';
      out.quality = 'poor';
      out.ms = Date.now() - t0;
      return out;
    }

    /* ---- 阶段 A：搜索探活 ---- */
    let hits = [];
    let aErr = '';
    if (src.searchUrl) {
      try {
        hits = await race(Engine.search(net, src, o.keyword), o.timeout + 2000);
        out.search = hits.length;
      } catch (e) { aErr = brief(e.message || e); }
    }

    /* ---- 阶段 B：抓目录 + 正文（默认只搜到结果才深检，省时间） ---- */
    let bookUrl = (hits[0] && hits[0].bookUrl) || o.probeUrl || '';
    if (o.deep && bookUrl) {
      out.deep = true;
      /* 检测只要知道目录抓不抓得到，不翻页，否则一个源可能拖几十秒 */
      const s2 = Object.assign({}, src, {
        ruleToc: Object.assign({}, src.ruleToc || {}, { nextTocUrl: '' })
      });
      try {
        const toc = await race(Engine.getToc(net, s2, bookUrl), o.timeout + 2000);
        out.chapters = (toc.chapters || []).length;
        if (out.chapters) {
          const mid = Math.min(Math.floor(out.chapters / 2), out.chapters - 1);
          try {
            const c = await race(Engine.getContent(net, s2, toc.chapters[mid].url), o.timeout + 2000);
            out.chars = (c.paras || []).join('').replace(/\s/g, '').length;
          } catch (e) { out.chars = 0; }
        }
      } catch (e) {
        if (!out.chapters) out.note = brief(e.message || e);
      }
    }

    out.ms = Date.now() - t0;

    /* ---- 定级 ---- */
    if (aErr && !out.search && !out.chapters) {
      out.quality = 'dead';
      out.note = aErr;
      out.score = 0;
      return out;
    }
    if (out.deep) {
      if (out.chapters >= 20 && out.chars >= 800 && out.ms < 7000) { out.quality = 'great'; out.score = 90 + Math.min(10, Math.floor(out.chapters / 100)); }
      else if (out.chapters >= 5 && out.chars >= 200) { out.quality = 'ok'; out.score = 60 + Math.min(25, Math.floor(out.chars / 200)); }
      else if (out.chapters > 0) { out.quality = 'poor'; out.score = 30; out.note = out.note || `目录仅 ${out.chapters} 章 / 正文 ${out.chars} 字`; }
      else { out.quality = 'poor'; out.score = 20; out.note = out.note || '目录为空'; }
    } else {
      /* 没深检就分不出「优质」：只证明能搜到，不代表目录和正文正常 */
      if (out.search >= 3) { out.quality = 'ok'; out.score = 65; out.note = `未深检 · 搜到 ${out.search} 条`; }
      else if (out.search > 0) { out.quality = 'ok'; out.score = 55; out.note = `未深检 · 搜到 ${out.search} 条`; }
      else { out.quality = 'poor'; out.score = 15; out.note = out.note || aErr || '搜索无结果'; }
    }
    if (out.ms > 10000 && out.quality === 'great') out.quality = 'ok';
    return out;
  }

  /**
   * 批量检测
   * @param o { sources, fetch, keyword, deep, concurrency, timeout, onProgress, shouldStop, probeUrlOf }
   */
  async function run(o) {
    const list = o.sources || [];
    const conc = Math.max(1, Math.min(20, o.concurrency || 8));
    const summary = { great: 0, ok: 0, poor: 0, dead: 0 };
    const results = [];
    let cursor = 0, done = 0;
    const stopped = () => (o.shouldStop && o.shouldStop());

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
            probeUrl: o.probeUrlOf ? o.probeUrlOf(s) : ''
          }), o.deep ? 24000 : 12000);
        } catch (e) {
          r = { id: s.id, name: s.name, quality: 'dead', score: 0, note: brief(e.message || e), ms: 0 };
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
