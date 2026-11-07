# 墨读 · iOS

一个 WKWebView 壳：界面还是 `dist-web/`（与桌面、安卓、网页、鸿蒙同一套前端），
`ios/` 只负责「把网页装进 iOS 应用」。

**为什么不能直接在 Windows 上出 `.ipa`**：iOS 的可执行文件必须由 Xcode 的 clang + Swift 工具链编译，
而 Xcode 只在 macOS 上跑。所以这里交付的是**一个完整可编译的 Xcode 工程 + 一键打 ipa 脚本**，
你在 Mac 上（或任意云的 macOS 机器）点一下就有 ipa，然后用自己的 Apple ID 签。

## 一、为什么要有本地 HTTP 服务

`LocalServer.swift` 在 `127.0.0.1:8765` 起一个只监听回环的极简 HTTP 服务，做两件事：

1. **给页面一个真实的同源**。用 `file://` 加载时是不透明源，localStorage 不稳、IndexedDB 不持久、
   Service Worker 根本不注册。有了 `http://127.0.0.1:8765`，网页版那份「IndexedDB 虚拟文件系统」
   （书架、本地书正文、章节缓存）原样可用。
2. **当书源抓取代理**。浏览器里跨域受同源策略限制，网页版是靠用户自填「书源代理」绕过的；
   手机上没这个服务，于是把 `/fetch` 做成原生 `URLSession` 代理，并在响应 `index.html` 时
   注入 `<meta name="moread-proxy" content="/fetch?format=text">` —— 和自建网关 `server/gateway.js`
   完全同一套协议（`?url=&h=<base64url(headers)>`，GBK 自动转码），前端一行不用改。

端口写死在 `8765`（失败才往 8766…8785 试），因为**端口是 origin 的一部分**：
换了端口，IndexedDB 就是另一个库，用户的书架看起来就「没了」。

## 二、在 Mac 上构建

```bash
# 1) 前端产物（Windows 上跑过就不用，仓库里已带一份）
cd <仓库根>
node build/gen-web.js
node build/sync-ios.js          # → ios/MoRead/web/（顺带把 platform 改成 ios、写入版本号）

# 2) 直接跑起来（真机或模拟器）
open ios/MoRead.xcodeproj       # 选 Team → 选设备 → ⌘R

# 3) 或者出一份 ipa
cd ios
./scripts/build-ipa.sh                     # 未签名 ipa → dist/MoRead-<版本>-unsigned.ipa
TEAM_ID=ABCDE12345 ./scripts/build-ipa.sh signed   # 用你的证书签好
```

要求：Xcode 15+、iOS 15.0+。命令行构建用的是
`xcodebuild ... CODE_SIGNING_ALLOWED=NO`，不需要任何账号。

## 三、签名安装（三种，按你有没有 Mac / 有没有开发者账号选）

| 方式 | 需要 | 有效期 | 做法 |
|---|---|---|---|
| **Xcode 直连真机** | Mac + 任意 Apple ID | 7 天，到期重连一次 | Xcode 里填 Team（免费账号就是个人 Apple ID）→ Run |
| **未签名 ipa + 重签工具** | Windows 也行 | 7 天 | 拿 `MoRead-<版本>-unsigned.ipa`，用 **Sideloadly / AltStore / 爱思助手** 载入，输自己的 Apple ID 签 |
| **付费开发者账号** | ￥688/年 | 1 年，可 TestFlight | `TEAM_ID=... ./scripts/build-ipa.sh signed` |

免费账号签的包有 7 天限制、最多 3 个 App，到期重签即可，数据不会丢（在应用沙箱的 IndexedDB 里，
重签覆盖安装不清数据）。

## 四、目录

```
ios/
├── MoRead.xcodeproj/                  手写的工程（objectVersion 56，Xcode 14+ 直接打开）
│   ├── project.pbxproj
│   └── xcshareddata/xcschemes/MoRead.xcscheme
├── MoRead/
│   ├── AppDelegate.swift              纯代码窗口，没有 Storyboard
│   ├── WebViewController.swift        WKWebView + 下载→分享面板 + 原生 alert/confirm
│   ├── LocalServer.swift              127.0.0.1 本地服务：静态文件 + /fetch 代理
│   ├── Info.plist                     显示名「墨读」、ATS 放开、横竖屏、文件共享
│   ├── Assets.xcassets/AppIcon        1024×1024
│   └── web/                           ← dist-web 同步进来（蓝色文件夹，整目录进 .app）
├── scripts/build-ipa.sh               打 ipa（unsigned / signed 两种）
├── project.yml                        XcodeGen 配置（工程打不开时的兜底）
└── capacitor.config.json              Capacitor 路线留档（见下）
```

工程文件是手写的，万一你的 Xcode 版本不认（或想重建一个干净的）：

```bash
brew install xcodegen
cd ios && xcodegen generate      # 用 project.yml 重新生成 MoRead.xcodeproj
```

## 五、已知限制

- **朗读**走 WKWebView 的 `speechSynthesis`，能出声但音色取决于系统；要做「后台连续朗读 + 锁屏控制」
  需要接 `AVSpeechSynthesizer` + `MPNowPlayingInfoCenter`，这层还没写。
- **导出备份**点了会走下载 → 弹系统分享面板 → 存到「文件」。不会像桌面版那样直接写到你选的目录。
- **不能长期后台运行**：iOS 会挂起进程，本地服务随之暂停；回到前台自动恢复。
- **不越狱就装不了非签名包**：这是系统策略，没有绕过的办法。

## 六、Capacitor 路线（可选）

`capacitor.config.json` 是给 `npx cap add ios` 用的老方案：好处是插件生态现成，
坏处是它把 `webDir` 静态拷进 `public/`，同样受 `file://`（`capacitor://localhost`）限制，
跨域抓书源还得自己写插件。所以默认走本目录这套原生壳，Capacitor 只作留档。
