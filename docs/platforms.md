# 支持的平台 · 打包与限制

同一套前端（`ui/` 里的 `app.js` / `engine.js` / `style.css`）跑在五个运行环境里，
原生能力由各自的桥接层顶替：

```
                    ┌──────────────────────────────┐
                    │  ui/  阅读器 · 书源引擎 · 排版  │
                    └──────────────┬───────────────┘
      ┌──────────────┬─────────────┼──────────────┬──────────────┐
 Electron          Kotlin        ArkWeb        浏览器        Node 网关
 Windows/Linux/mac  Android       HarmonyOS     Web/PWA      OpenStick
 src/main.js        MoBridge.kt   Index.ets     bridge-web.js  server/gateway.js
```

iOS 不在上面这五列里：它是 WKWebView 壳，复用同一份 `bridge-web.js`，
但多了应用内的 `127.0.0.1` 本地服务（`ios/MoRead/LocalServer.swift`），见 `ios/README.md`。

## 一览

| 平台 | 产物 | 状态 | 构建命令 |
| --- | --- | --- | --- |
| Windows x64 | `MoRead-windows-*.zip` | ✅ 主力，实测 | `npm run pack` |
| Android 7+ | `MoRead-android-*.apk` | ✅ 真机实测 | `node build/android-build.js` |
| 网页版 / PWA | GitHub Pages | ✅ 线上 | `npm run web` |
| Linux x64 / arm64 | `MoRead-linux-*.tar.gz` | ✅ 已出包，**未在真机验证** | `npm run pack:linux` |
| macOS Intel / Apple Silicon | `MoRead-mac-*.zip` | ⚠️ 已出包，**未签名、未真机验证** | `npm run pack:mac` |
| HarmonyOS 4.x 及以下 | 直接装 Android APK | ✅ 系统兼容 | — |
| HarmonyOS NEXT (5.0) | `MoRead-harmony-*.hap` | ✅ **能编出 hap**（OpenHarmony SDK + hvigor，未在真机验证） | `npm run harmony:pack` |
| iOS / iPadOS | PWA | ✅ 现在就能用 | — |
| iOS 原生 | `MoRead-*-unsigned.ipa` | ✅ **已出包**（GitHub Actions 的 macOS runner），未真机验证 | Actions → `ios-ipa.yml` |

出完包统一发到 GitHub Releases（一条命令，可重复运行，同名同尺寸的会跳过）：

```bash
GH_TOKEN=xxx npm run release:publish -- v0.6.3
```

它会建 tag（指向 main 的 HEAD）+ Release，把 `dist/` 里九个产物逐个上传，
最后打印远端资产清单；`--dry` 只列清单不上传。


## 桌面三端（Electron）

Windows 走 `build/pack.js`（要写 exe 资源、改中文目录名、压 zip），
Linux / macOS 走 `build/pack-multi.js`：

```bash
npm run pack            # Windows
npm run pack:linux      # Linux x64 + arm64
npm run pack:mac        # macOS Intel + Apple Silicon
npm run pack:all        # 四个一起（约 5 分钟，首次要下 4×120MB 运行时）
```

跨平台打得动，是因为这个项目**没有任何原生模块**（没有 sqlite3、没有 sharp、没有 node-gyp），
Electron 的运行时就是预编译好的压缩包，换平台等于换一个运行时再塞进同一份 `src/` + `ui/`。

### Linux

```bash
tar -xzf MoRead-linux-x64-0.6.3.tar.gz
cd MoRead-linux-x64
./启动墨读.sh        # 或 ./install.sh 装进应用菜单
```

- 默认带 `--no-sandbox`：Electron 的 `chrome-sandbox` 需要 `root:root` + `4755`，
  普通用户装不了。想开沙箱：`sudo chown root:root chrome-sandbox && sudo chmod 4755 chrome-sandbox`，
  然后把启动脚本里的 `--no-sandbox` 去掉。
- 依赖：GTK3 / libnss3 / libasound2（Debian/Ubuntu: `libgtk-3-0 libnss3 libasound2t64`）。
- 打包细节：Windows 的 `tar.exe` 会按 NTFS ACL 写成 0666，`moread` 解压后不可执行，
  所以 `build/pack-multi.js` 会重写 tar 头的 mode 字段并重算校验和（`fixTarModes()`）。

### macOS

```bash
unzip MoRead-mac-arm64-0.6.3.zip
mv MoRead.app /Applications/
xattr -cr /Applications/MoRead.app     # 第一次必须做：包是在 Windows 上打的，没签名
```

- **未签名、未公证**：Apple Silicon 上如果提示「已损坏」，再补一次临时签名
  `codesign --force --deep --sign - /Applications/MoRead.app`。
- 打包细节：macOS 运行时里 `.framework/Versions/Current` 是**符号链接**，
  PowerShell 的 `Expand-Archive`/`Compress-Archive` 会把它展平成一个内容为 `A` 的普通文件，
  装上去必然打不开。所以 `build/lib/zippatch.js` 直接读写 zip 中央目录，
  只改条目名和内容，原样保留 external attributes（Unix mode + symlink 位）。
- 界面差异：用系统红绿灯（`titleBarStyle: 'hiddenInset'`），菜单栏有「编辑」菜单
  （否则 ⌘C/⌘V 在输入框里失效），托盘图标缩到 18px。

## 鸿蒙

两条路，别混淆：

- **HarmonyOS 4.x 及更早**：系统自带安卓兼容，直接装 `MoRead-android-*.apk`。
- **HarmonyOS NEXT（5.0，纯血鸿蒙）**：不再兼容 APK，要用 `harmony/` 工程编 `.hap`。

`harmony/` 是一个 ArkWeb 壳，加载 `rawfile/web/` 里的 `dist-web`。**Windows 上也能出包**：

```bash
node build/gen-web.js        # 生成网页版
node build/build-hap.js      # 编译 + 自签 → dist/MoRead-harmony-<版本>.hap
```

装 OpenHarmony SDK（API 12）+ JDK 17 + 在 `harmony/` 里 `npm i --registry=https://repo.harmonyos.com/npm/`
即可；签名用 SDK 自带的 `OpenHarmony.p12`（OpenHarmony 测试 CA），`verify-app` 通过才输出。
零售版 HarmonyOS NEXT 手机只认华为签发的证书，那种情况用 DevEco 的「自动签名」（免费，绑自己设备），
或 `--own` 换成你自己的 p12/cer/p7b。限制（导入本地书、备份导出、系统朗读）详见 `harmony/README.md`。

## iOS

Windows 上编不了 `.ipa`（`xcodebuild` 只在 macOS 有）。三条路：

1. **PWA**（现在就能用）：Safari 打开 <https://routinemiku.github.io/MoRead-Windows/> →
   分享 → 添加到主屏幕。
2. **原生 WKWebView 工程**（推荐，`ios/` 已完整）：`ios/MoRead.xcodeproj` + 三个 Swift 文件 +
   1024 图标 + `scripts/build-ipa.sh`。关键是内置了一个只监听 `127.0.0.1` 的本地 HTTP 服务，
   页面有真实同源（IndexedDB 书架可用），`/fetch` 由原生 `URLSession` 代理跨域抓书源 ——
   协议与 `server/gateway.js` 完全一致，前端一行没改。Mac 上：
   ```bash
   node build/gen-web.js && node build/sync-ios.js
   open ios/MoRead.xcodeproj     # 或 cd ios && ./scripts/build-ipa.sh
   ```
3. **Capacitor**（可选留档）：`ios/capacitor.config.json` 仍在，但受 `capacitor://localhost` 限制，
   跨域还得自己写插件，所以默认走第 2 条。

## 自托管（OpenStick / 任意 Linux 小主机）

```bash
node build/gen-web.js
DATA_DIR=./data STATIC_DIR=./dist-web PORT=8080 node server/gateway.js
```

同一份 `dist-web` 既能丢 GitHub Pages，也能跑在自己家里那台机器上，
前端会自动探测 `/api/fs/ping` 切到「设备存储」模式。详见 `docs/self-hosting.md`。
