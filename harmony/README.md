# 墨读 · 鸿蒙（HarmonyOS / OpenHarmony）

一个 ArkWeb 壳：整份界面还是那套 `dist-web/`（和桌面、安卓、网页共用一个前端），
`harmony/` 里只有「怎么把网页装进鸿蒙应用」这一层。

**这个工程是真的能编出 `.hap` 的** —— 在 Windows 上用 OpenHarmony SDK + hvigor 跑通过，
产物 `dist/MoRead-harmony-0.6.3.hap`（未签名）与 `MoRead-harmony-0.6.3-signed.hap`（自签，verify 通过）。

## 一、一条命令出包

```bash
# 仓库根目录
node build/gen-web.js        # 生成网页版产物 dist-web/
node build/build-hap.js      # 编译 + 自签 → dist/MoRead-harmony-<版本>.hap
```

前置条件：

| 依赖 | 版本 | 说明 |
|---|---|---|
| OpenHarmony SDK | API 12（5.0.0 Release） | 目录结构必须是 `<sdk>/12/{ets,js,native,previewer,toolchains}` |
| Node.js | 18+ | 跑 hvigor |
| JDK | 17 | 打 hap 时要调 `app_packing_tool.jar` |

```bash
# SDK 下载（2.6GB，官方源）
curl -O https://repo.huaweicloud.com/openharmony/os/5.0.0-Release/ohos-sdk-windows_linux-public.tar.gz
# 解到 C:/ohos-sdk，再把 windows/{ets,js,native,previewer,toolchains} 放进 C:/ohos-sdk/12/

# 构建依赖（只装 hvigor，走华为的 npm 源）
cd harmony && npm i --registry=https://repo.harmonyos.com/npm/
```

SDK 路径写在 `harmony/local.properties` 的 `sdk.dir=`，或用环境变量 `OHOS_SDK_HOME`。
`local.properties` 不进版本库（每台机器路径不同）。

## 二、三种「自己签名安装」的路径

### A. 零售版 HarmonyOS NEXT 手机（最常见）

这种机器只认**华为签发的证书链**，SDK 测试 CA 签的包装不上，也不存在离线办法。
唯一的自签方式是 DevEco Studio 的「自动签名」——免费，用你自己的华为账号，绑定自己的设备 UDID：

1. DevEco Studio 打开 `harmony/` 目录
2. `File → Project Structure → Signing Configs` → 勾 `Automatically generate signature`（登录华为账号）
3. 手机开开发者模式 + USB 调试，连上，点 ▶ Run

DevEco 会把 `signingConfigs` 写回 `harmony/build-profile.json5`，
之后在仓库根跑 `node build/build-hap.js`，hvigor 就会直接用这份配置签名出包。

### B. OpenHarmony 开发板 / 模拟器 / 允许侧载的设备

`build-hap.js` 默认就走这条：用 SDK 自带的 `toolchains/lib/OpenHarmony.p12` 生成
profile + 证书链，再 `sign-app`，最后跑 `verify-app` 验证（不通过就不输出）。

```bash
hdc install dist/MoRead-harmony-0.6.3-signed.hap
```

### C. 你自己已有的证书

```bash
mkdir -p harmony/signing
# 放三个文件：app.p12（密钥库）、app.cer（证书链 pem）、app.p7b（profile）
KEY_ALIAS=debugKey KEY_PWD=xxxxxx KS_PWD=xxxxxx node build/build-hap.js --own
```

只想要未签名包，交给别人签：`node build/build-hap.js --no-sign`。

## 三、目录

```
harmony/
├── AppScope/app.json5                 包名 cn.moread.harmony、版本（由 sync-harmony.js 写入）
├── build-profile.json5                产品配置：compatibleSdkVersion 12 + runtimeOS OpenHarmony
├── hvigor/hvigor-config.json5         hvigor 版本 5.3.3、modelVersion 5.0.0、daemon=false
├── entry/
│   ├── build-profile.json5            stage 模型；release 不混淆
│   └── src/main/
│       ├── module.json5               EntryAbility + deviceTypes: default/tablet + INTERNET
│       ├── ets/entryability/EntryAbility.ets   沉浸式（正文铺到状态栏下）
│       ├── ets/pages/Index.ets        一个 Web 组件占满全屏
│       └── resources/rawfile/web/     ← dist-web 同步进来（1MB）
└── README.md
```

同步命令：`node build/sync-harmony.js`（`build-hap.js` 会自己先跑一次）。

## 四、几个踩过的坑

- **hvigor 不在公共 npm 上**：`@ohos/hvigor` 只在 `https://repo.harmonyos.com/npm/`，npmmirror / npmjs 都是 404。
- **必须写 `modelVersion`**：`hvigor-config.json5` 和根 `oh-package.json5` 两处都要有且相等（当前 `5.0.0`），
  否则报「The project structure and configuration need to be upgraded」。
- **`compatibleSdkVersion` 类型随 runtimeOS 变**：`runtimeOS: "OpenHarmony"` 时是整数 `12`；
  换成 `"HarmonyOS"` 时要写字符串 `"5.0.0(12)"`。
- **deviceTypes 只能填 SDK 有的**：OpenHarmony SDK 的 `ets/api/device-define/` 只有
  `default / tablet / liteWearable`，写 `phone`、`2in1` 会因 systemCapability 交集为空而失败。
  在 HarmonyOS SDK 下可以改回 `phone / tablet / 2in1`。
- **打 hap 要 `java`**：`PackageHap` 调 `app_packing_tool.jar`，PATH 里没有 JDK 就 `spawn java ENOENT`
  （`build-hap.js` 会自动找 `.androidenv/jdk/*` 并注入 PATH）。
- **daemon 会拖累 CI**：`hvigor-config.json5` 里 `execution.daemon = false`，避免守护进程僵死导致
  `ECONNREFUSED 127.0.0.1:45000`。

## 五、还没接的原生能力

网页版靠 `window.MoNativeBridge` 兜底，所以下面三件事在鸿蒙上是「降级」而不是崩：

| 能力 | 现状 | 要做的事 |
|---|---|---|
| 导入本地书 | 点了没反应 | `Web` 上挂 `onShowFileSelector` + `@ohos.file.picker` |
| 备份导出 zip | 走浏览器下载，落不到盘 | 实现 `DownloadDelegate`（`onDownloadStart` → `@ohos.request`） |
| 朗读 | ArkWeb 的 `speechSynthesis` 不可用 | 接 `@ohos.ai.tts` 造 `TtsClient`，在 page 里 `registerJavaScriptProxy` |

其余（书架、书源、进度、搜索、排版、主题）都是纯前端逻辑，和桌面版一模一样。
数据落在应用沙箱的 IndexedDB 里，卸载才清。
