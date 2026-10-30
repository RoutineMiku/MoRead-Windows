/**
 * bridge.js —— 安卓端 Node 兼容层的入口（桌面端无害）
 *
 * 桌面 Electron：没有 MoNativeBridge，这里什么都不做。
 *
 * 安卓：构建时 build/gen-nodebundle.js 会把本文件**直接替换成** nodebundle.js 的内容
 *      （写进 android/app/src/main/assets/ui/bridge.js，Gradle 同步时跳过本文件）。
 *      也就是说正常路径下本文件根本不会被打包进去。
 *
 *      下面这段是**兜底**：万一替换没生效（构建顺序、缓存、WebView 请求拦截没触发……
 *      任何一环出问题，页面加载到的就会是这个空壳），它同步把 ../nodebundle.js 拉进来执行。
 *      没有它，一旦加载失败，window.mo 不存在 → app.js 起不来 → 界面显示但所有按钮点不动，
 *      而且完全没有任何报错，极难排查。
 */
(function () {
  if (typeof window.MoNativeBridge === 'undefined') return;   // 桌面：什么都不做
  if (window.MoNative && window.mo) return;                   // 已经加载好了

  var tried = false;
  function load() {
    if (tried || (window.MoNative && window.mo)) return;
    tried = true;
    try {
      var x = new XMLHttpRequest();
      x.open('GET', '../nodebundle.js', false);   // 必须同步：后面的 engine.js / app.js 依赖它
      x.send(null);
      var src = x.responseText || '';
      if (src.length > 1000) (0, eval)(src);      // 间接 eval：在全局作用域执行
    } catch (e) {
      tried = false;
    }
  }
  load();

  /* 还是没起来就别装死：把错误直接写在屏幕上 */
  function banner(msg) {
    try {
      var d = document.createElement('div');
      d.style.cssText = 'position:fixed;z-index:99999;left:0;right:0;top:0;padding:14px 16px;' +
        'background:#b3261e;color:#fff;font:14px/1.6 system-ui;white-space:pre-wrap;';
      d.textContent = '墨读：界面脚本加载失败，功能不可用。\n' + msg;
      document.body.appendChild(d);
    } catch (e) { }
  }
  function check() {
    if (!window.mo && window.MoNativeBridge) banner('window.mo 未定义（nodebundle.js 没被执行）');
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', function () { load(); setTimeout(check, 0); });
  else setTimeout(check, 0);
})();
