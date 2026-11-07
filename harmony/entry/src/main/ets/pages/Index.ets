import { webview } from '@kit.ArkWeb';

/**
 * 单页容器：把 dist-web/ 整个塞进 rawfile，用 ArkWeb 跑起来。
 *
 * 前端自己会走「网页版」分支（bridge-web.js 提供 window.MoNativeBridge），
 * 书架/书源/进度存在 IndexedDB 里，也就是应用沙箱内，卸载才清。
 *
 * 已知限制（见 harmony/README.md）：
 *   1. 还没接 onShowFileSelector，所以「导入本地书」暂时点了没反应；
 *   2. 备份「导出 zip」走的是浏览器下载，HarmonyOS 需要 DownloadDelegate 才能落盘；
 *   3. 语音朗读依赖系统 TTS，ArkWeb 的 speechSynthesis 目前不可用。
 */
@Entry
@Component
struct Index {
  controller: webview.WebviewController = new webview.WebviewController();

  onBackPress(): boolean {
    // 先让网页自己处理（关弹窗、退出阅读页），退无可退再退出应用
    if (this.controller.accessBackward()) {
      this.controller.backward();
      return true;
    }
    return false;
  }

  build() {
    Column() {
      Web({ src: $rawfile('web/index.html'), controller: this.controller })
        .javaScriptAccess(true)
        .domStorageAccess(true)
        .databaseAccess(true)
        .fileAccess(true)
        .imageAccess(true)
        .onlineImageAccess(true)
        .mixedMode(MixedMode.All)
        .cacheMode(CacheMode.Default)
        .darkMode(WebDarkMode.Auto)
        .zoomAccess(false)
        .horizontalScrollBarAccess(false)
        .verticalScrollBarAccess(false)
        .overScrollMode(OverScrollMode.NEVER)
        .width('100%')
        .height('100%')
    }
    .width('100%')
    .height('100%')
    .backgroundColor('#F4EFE6')
  }
}
