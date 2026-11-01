/* 翻页模式专项检查（作为 MOREAD_SHOT_JS 执行）
 * 校验：书页是否铺满阅读区、正文是否溢出页外、分页是否丢字/重复、
 *       点击两侧 / 滚轮能否翻页、章末标记与页码、滚动模式是否保持原样。
 * 返回 JSON，由 main.js 打印为 [shot-js-result]。
 * 注意：openReader() 会把页码重置为 0，所以逐页测量一律靠「真实点击翻页」推进。 */
(async () => {
  const t = window.__t;
  if (!t) return 'NO_TEST_HOOK';
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const $ = s => document.querySelector(s);
  const out = { win: [innerWidth, innerHeight], checks: [] };
  const ok = (name, pass, detail) => { out.checks.push({ name, pass: !!pass, detail }); };

  await t.openReader('L1', 1);
  await wait(700);
  const R = t.reader, S = t.state;
  const stage = $('#r-stage'), reader = $('#reader');
  /* 点在「真实命中的元素」上（正文段落），而不是容器本身 —— 手指点到的就是 p */
  const clickX = ratio => {
    const r = stage.getBoundingClientRect();
    const x = r.left + r.width * ratio, y = r.top + r.height * 0.5;
    const el = document.elementFromPoint(x, y) || stage;
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: x, clientY: y }));
  };

  /* ---------- 1. 切到翻页模式 ---------- */
  S.settings.pageMode = 'paged';
  await t.openReader('L1', 1);
  await wait(900);
  let page = $('#r-page');

  ok('mode-paged 生效', reader.classList.contains('mode-paged'));
  const cs = getComputedStyle(page);
  const padL = parseFloat(cs.paddingLeft), padR = parseFloat(cs.paddingRight);
  const contentW = Math.round(page.getBoundingClientRect().width - padL - padR);
  const fill = page.getBoundingClientRect().width / stage.clientWidth;
  ok('书页铺满阅读区', fill > 0.98, `page=${Math.round(page.getBoundingClientRect().width)} stage=${stage.clientWidth} 占比=${(fill * 100).toFixed(1)}%`);
  ok('不是原来的 730px 窄栏', contentW > Math.min(700, stage.clientWidth - 120),
    `内容宽=${contentW}px 左右边距=${padL}/${padR} 约${Math.round(contentW / S.settings.fontSize)}字/行`);

  /* ---------- 2. 分页完整性 ---------- */
  const pages = R.pages || [];
  const joined = pages.map(p => p.join('')).join('');
  const origin = (R.paras || []).join('');
  ok('未丢字/未重复', joined === origin, `分页后 ${joined.length} 字 / 原文 ${origin.length} 字，共 ${pages.length} 页`);
  ok('页数合理', pages.length >= 2, `${pages.length} 页`);

  /* ---------- 3. 逐页：不溢出页框（靠点击翻页推进） ---------- */
  const stageH = stage.clientHeight;
  const overflow = [];
  for (let i = 0; i < pages.length; i++) {
    const h = Math.round($('#r-page').getBoundingClientRect().height);
    if (h > stageH + 2) overflow.push({ page: i + 1, h, over: h - stageH });
    if (i < pages.length - 1) { clickX(0.95); await wait(300); }
  }
  ok('每页正文都不超出阅读区', overflow.length === 0,
    overflow.length ? JSON.stringify(overflow) : `阅读区高=${stageH}px，${pages.length} 页全部容纳`);
  ok('末页显示「本章完」', /本章完/.test($('#r-page').textContent));
  ok('页码显示 x/y', /\d+\/\d+\s*页/.test($('#r-pagenum').textContent), $('#r-pagenum').textContent);

  /* ---------- 4. 翻页方向（都在章内，避免跨章干扰判断） ---------- */
  await t.openReader('L1', 1);
  await wait(700);
  const p0 = R.page;
  clickX(0.95); await wait(320);
  ok('点击右侧→下一页', R.page === p0 + 1, `页码 ${p0} → ${R.page}`);

  const p1 = R.page;
  clickX(0.05); await wait(320);
  ok('点击左侧→上一页', R.page === p1 - 1, `页码 ${p1} → ${R.page}`);

  const p2 = R.page;
  stage.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: 120 }));
  await wait(400);
  ok('滚轮向下→下一页', R.page === p2 + 1, `页码 ${p2} → ${R.page}`);

  /* 末页再往后：进下一章第 1 页，标题要跟着换 */
  R.page = pages.length - 1;
  const titleBefore = R.title, ciBefore = R.ci;
  clickX(0.95); await wait(900);
  ok('末页再翻→进下一章', R.ci === ciBefore + 1 || R.page > 0,
    `章 ${ciBefore}(${titleBefore}) → 章 ${R.ci}(${R.title}) 页 ${R.page}`);

  /* 页内首屏不该出现「本章完」 */
  R.page = 0; await t.openReader('L1', 1); await wait(600);
  ok('首页无章末标记', !/本章完/.test($('#r-page').textContent));

  /* ---------- 5. 滚动模式回归 ---------- */
  S.settings.pageMode = 'scroll';
  await t.openReader('L1', 1);
  await wait(600);
  const w = Math.round($('#r-page').getBoundingClientRect().width);
  ok('滚动模式仍是 730px 窄栏', w <= 732, `page 宽=${w}px max-width=${getComputedStyle($('#r-page')).maxWidth}`);
  ok('滚动模式可上下滚动', stage.scrollHeight > stage.clientHeight, `scrollH=${stage.scrollHeight} clientH=${stage.clientHeight}`);
  ok('滚动模式底栏写「上一章」', $('#r-prev').textContent === '上一章', $('#r-prev').textContent);

  const failed = out.checks.filter(c => !c.pass);
  out.pass = failed.length === 0;
  out.failedCount = failed.length;
  return JSON.stringify(out, null, 1);
})()
