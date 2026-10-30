// 桌面端回归：确认安卓那套 viewport / data-layout / 圆角 / pointer:coarse 改动没影响电脑版
const de = document.documentElement;
const r = {
  // 桌面必须保留窗口按钮，且绝不能出现移动端标记
  hasWinbtns: !!document.querySelector('.winbtns'),
  dataLayout: de.getAttribute('data-layout'),
  dataSw: de.getAttribute('data-sw'),
  isAndroidClass: de.classList.contains('is-android'),
  // 视口不能被 viewport meta 影响
  innerW: window.innerWidth,
  innerH: window.innerHeight,
  // 这几个尺寸是桌面版的原值，变了就说明被污染了
  titlebarH: Math.round((document.querySelector('.titlebar') || {}).offsetHeight || 0),
  tbBtnW: Math.round((document.querySelector('.tb-btn') || {}).offsetWidth || 0),
  railW: Math.round((document.querySelector('.rail') || {}).offsetWidth || 0),
  bodyFont: getComputedStyle(document.body).fontSize,
  // 底部导航在桌面绝不能出现：rail 应在左侧且是竖向的
  railHorizontal: (document.querySelector('.rail') || {}).offsetWidth > window.innerWidth / 2,
  hasMo: typeof window.mo !== 'undefined',
  view: (document.querySelector('.view.active') || {}).id || null
};
return r;
