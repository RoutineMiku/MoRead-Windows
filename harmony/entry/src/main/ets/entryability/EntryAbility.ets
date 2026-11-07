import { AbilityConstant, UIAbility, Want } from '@kit.AbilityKit';
import { window } from '@kit.ArkUI';
import { hilog } from '@kit.PerformanceAnalysisKit';

const TAG = 'MoRead';

/**
 * 鸿蒙（HarmonyOS NEXT）入口。这里不重写任何界面：
 * 整个应用就是一个 ArkWeb 容器，加载 rawfile/web/index.html，
 * 和安卓版「WebView + 兼容层」、桌面版「Electron + ui/」是同一套前端。
 *
 * 同步前端资源：node build/sync-harmony.js（会把 dist-web/ 复制到
 * entry/src/main/resources/rawfile/web/）
 */
export default class EntryAbility extends UIAbility {
  onCreate(want: Want, launchParam: AbilityConstant.LaunchParam): void {
    hilog.info(0x0000, TAG, 'onCreate');
  }

  onWindowStageCreate(windowStage: window.WindowStage): void {
    windowStage.loadContent('pages/Index', (err) => {
      if (err && err.code) {
        hilog.error(0x0000, TAG, 'loadContent failed: %{public}s', JSON.stringify(err));
        return;
      }
      // 沉浸式：正文可以铺到状态栏下面，界面自己留安全区
      try {
        const win = windowStage.getMainWindowSync();
        win.setWindowLayoutFullScreen(true).catch(() => {});
      } catch (e) {
        hilog.warn(0x0000, TAG, 'setWindowLayoutFullScreen failed');
      }
    });
  }

  onWindowStageDestroy(): void {}

  onForeground(): void {}

  onBackground(): void {}

  onDestroy(): void {}
}
