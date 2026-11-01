/* 滚动模式连续阅读专项检查（作为 MOREAD_SHOT_JS 执行）
 * 校验：滚到底自动接下一章、判定线换当前章（标题/进度跟随）、
 *       最后一章收敛并出现「本章完」、切模式后缓冲区重置、短章主动续章。
 * 返回 JSON，由 main.js 打印为 [shot-js-result]。 */
(async () => {
  const t = window.__t;
  if (!t) return 'NO_TEST_HOOK';
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const $ = s => document.querySelector(s);
  const $$ = s => [...document.querySelectorAll(s)];
  const out = { win: [innerWidth, innerHeight], checks: [] };
  const ok = (name, pass, detail) => { out.checks.push({ name, pass: !!pass, detail }); };

  const S = t.state, R = t.reader;
  S.settings.pageMode = 'scroll';
  await t.openReader('L1', 0);
  await wait(1200);
  const stage = $('#r-stage');
  const secs = () => $$('#r-page .ch-sec').map(el => +el.dataset.ci);
  const toBottom = async () => {
    stage.scrollTop = stage.scrollHeight;
    stage.dispatchEvent(new Event('scroll'));
    await wait(700);
  };

  /* ---------- 1. 初始状态 ---------- */
  ok('本章渲染为 ch-sec', !!$('#r-page .ch-sec[data-ci="0"]'), `缓冲区=[${secs()}]`);
  ok('末章之前不显示「本章完」', !/本章完/.test($('#r-page').textContent));

  /* ---------- 2. 滚到底自动续章 ---------- */
  await toBottom();
  await toBottom();
  const afterScroll = secs();
  ok('滚到底接上了下一章', afterScroll.includes(1), `缓冲区=[${afterScroll}]`);
  ok('续章不动当前章内容', $('#r-page .ch-sec[data-ci="0"] .body p') !== null);

  /* ---------- 3. 一路滚到底：链式续到最后一章并收敛 ---------- */
  for (let i = 0; i < 8; i++) await toBottom();
  const full = secs();
  ok('连续滚动能一路续到最后一章', full.length === 6 && full[5] === 5, `缓冲区=[${full}]`);
  ok('最后一章显示「本章完」', /本章完/.test($('#r-page .ch-sec[data-ci="5"]')?.textContent || ''));
  ok('缓冲区收敛不再增长', R.bufTail === 5, `bufTail=${R.bufTail}`);

  /* ---------- 4. 判定线换当前章：标题与进度跟随 ---------- */
  const sec1 = $('#r-page .ch-sec[data-ci="1"]');
  stage.scrollTop = sec1.offsetTop + 200;
  stage.dispatchEvent(new Event('scroll'));
  await wait(400);
  ok('滚进第二章后当前章跟随', R.ci === 1, `R.ci=${R.ci} 标题=${R.title}`);
  ok('顶栏标题跟着换', ($('#r-title').textContent || '').includes((sec1.dataset.title || '').slice(0, 4)),
    $('#r-title').textContent);
  ok('本章内进度在 0~1', R.lastWithin >= 0 && R.lastWithin <= 1, `lastWithin=${(R.lastWithin || 0).toFixed(3)}`);

  /* ---------- 5. 中间章不出现「本章完」 ---------- */
  const midTails = $$('#r-page .ch-sec .end').map(el => el.closest('.ch-sec')?.dataset.ci);
  ok('只有最后一章带「本章完」', midTails.length === 1 && midTails[0] === '5', `tail所在章=[${midTails}]`);

  /* ---------- 6. 切到翻页再切回：缓冲区重置 ---------- */
  S.settings.pageMode = 'paged';
  await t.loadChapter(0, 0);
  await wait(600);
  ok('切翻页后没有 ch-sec 残留', $$('#r-page .ch-sec').length === 0);
  S.settings.pageMode = 'scroll';
  await t.loadChapter(2, 0);
  await wait(900);
  ok('切回滚动从指定章开始', secs().length >= 1 && secs()[0] === 2, `缓冲区=[${secs()}]`);

  /* ---------- 7. 短章：加载完不满一屏也要主动续 ---------- */
  const h0 = stage.scrollHeight;
  await wait(900);
  ok('短章链式续章不卡在单章', stage.scrollHeight >= h0, `scrollHeight ${h0} -> ${stage.scrollHeight}`);

  $('#r-back') && $('#r-back').click();
  return out;
})();
