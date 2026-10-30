/* 墨读 · 安卓桥接占位
 *
 * 桌面版（Electron）不需要这个文件：window.mo 由 preload.js 通过 contextBridge 提供。
 * 安卓版里 MainActivity 会拦截这个请求，改返回 assets/nodebundle.js（Node 兼容层 + mo 实现），
 * 所以这里留空即可，两边共用同一份 index.html。
 */
