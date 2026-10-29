/* 本地模拟书源站点，用于测试规则引擎（不作为产品的一部分） */
const http = require('http');

const P = 8123;

const searchHtml = `<!DOCTYPE html><html><head><title>搜索</title></head><body>
<div class="result">
  <div class="item"><h3><a href="/book/1">夜航船（测试）</a></h3><span class="author">沈砚</span><p class="intro">一个测试用的小说简介。</p></div>
  <div class="item"><h3><a href="/book/2">夜航之后</a></h3><span class="author">林九思</span><p class="intro">第二本测试书。</p></div>
</div></body></html>`;

const bookHtml = `<!DOCTYPE html><html><head><title>夜航船 详情</title></head><body>
<h1>夜航船</h1><span class="author">沈砚</span>
<a id="catalog" href="/toc/1">查看目录</a>
</body></html>`;

const tocHtml = `<!DOCTYPE html><html><head><title>目录</title></head><body>
<div id="list"><dl>
  <dd><a href="/read/1-1">第1章 启程</a></dd>
  <dd><a href="/read/1-2">第2章 江雾</a></dd>
  <dd><a href="/read/1-3">第3章 收梢</a></dd>
</dl></div></body></html>`;

const readHtml = (n) => `<!DOCTYPE html><html><head><title>第${n}章</title></head><body>
<div id="content"><p>这是第 ${n} 章的第一段正文，用来测试正文规则是否生效。</p>
<p>第二段：江面上起了雾，渡船的马灯只剩一团昏黄。</p>
<p>第三段：他把书合上，听见远处的钟声。</p></div></body></html>`;

/* ---- 以下是「普通网页」结构，用于测试网页嗅探 / 自动识别（没有书源规则） ---- */
const webHome = `<!DOCTYPE html><html><head><title>某个小说网 - 首页</title></head><body>
<nav><a href="/web/">首页</a><a href="/web/">书架</a><a href="/web/">排行</a><a href="/web/">登录</a></nav>
<div class="booklist">
  <div class="item"><a href="/web/book/1">山居笔记</a><span>作者：顾野</span></div>
  <div class="item"><a href="/web/book/2">长夜行舟</a><span>作者：沈砚</span></div>
  <div class="item"><a href="/web/book/3">渡口记事</a><span>作者：林九思</span></div>
</div>
<div class="footer"><a href="/about">关于我们</a><a href="/contact">联系方式</a></div>
</body></html>`;

const webBook = `<!DOCTYPE html><html><head><title>山居笔记_顾野_小说</title></head><body>
<h1>山居笔记</h1>
<p>作者：顾野</p>
<p class="intro">一部关于山居生活的散文化小说。</p>
<a href="/web/toc/1">查看目录</a>
</body></html>`;

const chapters = Array.from({ length: 20 }, (_, i) =>
  `<li><a href="/web/read/1-${i + 1}">第${i + 1}章 ${['入山', '听雨', '扫叶', '煮茶', '夜话'][i % 5]}</a></li>`).join('');

const webToc = `<!DOCTYPE html><html><head><title>山居笔记 目录</title></head><body>
<h1>山居笔记</h1>
<div class="listmain"><ul>${chapters}</ul></div>
<p class="pager"><a href="/web/toc/0">上一页</a><a href="/web/toc/2">下一页</a></p>
</body></html>`;

const webRead = (n) => `<!DOCTYPE html><html><head><title>第${n}章 山居笔记</title></head><body>
<div class="header"><a href="/web/">首页</a><a href="/web/toc/1">目录</a></div>
<article class="content">
  <p>${'清晨的雾还没有散，山道上湿得厉害，他走得极慢。'.repeat(2)}</p>
  <p>${'石阶上的青苔被雨水泡得发软，脚踩上去会轻轻往下陷。'.repeat(2)}</p>
  <p>${'林子里传来鸟叫，一声比一声远，最后只剩下风。'.repeat(2)}</p>
  <p>${'他停下来歇了口气，把手里的书换了只手拿。'.repeat(2)}</p>
</article>
<div class="footer"><a href="/web/toc/1">回目录</a></div>
</body></html>`;

const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://127.0.0.1:' + P);
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  if (u.pathname === '/search') return res.end(searchHtml);
  if (u.pathname === '/book/1' || u.pathname === '/book/2') return res.end(bookHtml);
  if (u.pathname === '/toc/1') return res.end(tocHtml);
  if (u.pathname.startsWith('/read/')) return res.end(readHtml(u.pathname.split('-')[1]));
  if (u.pathname === '/web/' || u.pathname === '/web') return res.end(webHome);
  if (u.pathname.startsWith('/web/book/')) return res.end(webBook);
  if (u.pathname.startsWith('/web/toc/')) return res.end(webToc);
  if (u.pathname.startsWith('/web/read/')) return res.end(webRead(u.pathname.split('-')[1]));
  res.statusCode = 404;
  res.end('<html><body>404</body></html>');
});

server.listen(P, '127.0.0.1', () => console.log('mock listening ' + P));
