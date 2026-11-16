# 多商店上架指南（0.6.13）

各商店的门槛、材料位置、操作步骤。✅ = 材料已就绪；👤 = 需要你本人操作。

## 一览表

| 商店 | 平台 | 包 | 门槛 | 状态 |
| --- | --- | --- | --- | --- |
| 微软商店 | Windows | `dist/MoRead-0.6.13-x64.msix` | 已注册开发者账号 | ✅ 已提交，正在认证 |
| Flathub | Linux（Fedora/Arch/SteamOS…） | 清单 `build/flathub/` | 开源项目免费，GitHub PR | ✅ 清单就绪，👤 提 PR |
| Snap Store | Ubuntu 官方商店 | `snap/snapcraft.yaml` | 免费注册，CI 构建 | ✅ 清单就绪，👤 注册+触发 |
| 统信 UOS / deepin 商店 | UOS、deepin | `dist/MoRead-linux-{x64,arm64}-0.6.13.deb` | 开发者认证；工具类不强制软著 | ✅ deb 就绪，👤 认证+提交 |
| Google Play | 安卓国际 | `dist/MoRead-android-0.6.13.aab` | $25 + **12 测试者 × 14 天封闭测试** | ✅ AAB 就绪（targetSdk 36），👤 全部 |
| F-Droid | 安卓开源商店 | 源码构建 | 开源即可，免费 | 👤 提交申请，⚠️ 审核周期长 |
| 华为 AppGallery（鸿蒙） | HarmonyOS NEXT | `.app`（需 DevEco 签名） | 软著或电子版权 + APP 备案 + 受邀名单 | ⚠️ 材料部分就绪，👤 软著先行 |
| 小米/OPPO/vivo/应用宝 | 安卓国内 | `dist/MoRead-android-0.6.13.apk` | **软著（硬性）** + 实名 + 部分需备案 | ⚠️ 等软著，材料已备好 |

## 已就绪的包与材料

```
dist/MoRead-0.6.13-x64.msix              微软商店（已提交认证）
dist/MoRead-android-0.6.13.apk           正式签名 APK（CN=MoRead，SHA-256 b6ddc1b0…）
dist/MoRead-android-0.6.13.aab           Google Play 用的 AAB（targetSdk 36）
dist/MoRead-linux-x64-0.6.13.deb         UOS/deepin 商店（/opt/apps/cn.moread.app 规范目录）
dist/MoRead-linux-arm64-0.6.13.deb       同上，arm64
snap/snapcraft.yaml + snap/gui/ + snap/launcher/   Snap Store 打包定义
build/flathub/cn.moread.MoRead.yaml      Flathub 清单（zypak 沙箱、runtime 24.08）
build/flathub/cn.moread.MoRead.desktop   Flatpak 桌面入口
build/flathub/cn.moread.MoRead.metainfo.xml  AppStream 元数据
store/copyright/source-code.txt          软著源代码文档（60 页 × 50 行，规范格式）
store/copyright/manual.md                软著软件说明书
store/listing-zh.md                      商店文案（描述/关键词/分级，各店通用）
store/screenshots/                       5 张 1920×1080 截图
web/privacy.html                         隐私政策（已上线 Pages，各商店都要填 URL）
```

**重要**：安卓正式签名密钥在 `android/moread-release.keystore` + `android/keystore.properties`
（都不入库）。**丢了就永远无法更新任何已上架商店的应用**，请立即异地备份
（网盘/移动硬盘，别放仓库里）。

## 安卓签名切换的影响

之前发的 APK 都是 debug 签名。商店只收正式签名，且**签名不同的包无法覆盖安装**。
GitHub Release 上的 v0.6.13 APK 仍是旧 debug 签名的版本；下次发版（0.6.14+）
建议把 Release 里的 APK 也换成正式签名版，并在下载页注明「升级需卸载重装（先导出备份）」。

## 各商店操作步骤

### 1. Flathub（Linux 桌面事实标准商店，推荐优先）

1. 👤 用 GitHub 账号登录 <https://flathub.org>，创建应用 ID `cn.moread.MoRead`
   （新应用要走 <https://github.com/flathub-infra/flatpak-external-data-checker> 的
   申请流程，通常自动通过）
2. 👤 fork <https://github.com/flathub/new-prs>，建仓库 `cn.moread.MoRead`
3. 把 `build/flathub/` 三个文件放进去，补 `git submodule add https://github.com/flathub/shared-modules`
4. 👤 提 PR；Flathub 维护者审核（1–2 周），合并后 CI 自动构建上架
5. 之后每次更新：改 yaml 里的 url + sha256，提 PR 即可

### 2. Snap Store（Ubuntu 官方商店）

1. 👤 注册 <https://snapcraft.io>（Ubuntu One 账号，免费）
2. 👤 预留名称：`snapcraft register moread`（或网页操作）
3. 两种构建方式任选：
   - **推荐**：Snap Store 网页上直接连接 GitHub 仓库，自动用 `snap/snapcraft.yaml`
     构建 amd64（GitHub Actions `.github/workflows/linux-store.yml` 也能本地验证）
   - 手动：在任意 Ubuntu/WSL 上 `sudo snap install snapcraft --classic && snapcraft`
4. 👤 上传 `.snap`，选 stable channel，审核通常几小时~2 天
5. arm64 版：把 yaml 的 source 换成 arm64 tar.gz 再构建一次（或 CI 加 job）

### 3. 统信 UOS / deepin 商店

1. 👤 注册认证：<https://identity.chinauos.com/main/index> → 开发者中心 →
   个人认证（身份证，1–3 个工作日）
2. deb 已按 UOS 规范打包（`/opt/apps/cn.moread.app/` + entries + info），
   直接上传 `dist/MoRead-linux-x64-0.6.13.deb`（arm64 版同传）
3. 👤 填写应用信息：名称「墨读」、分类「办公阅读」、截图用 `store/screenshots/`、
   隐私政策 URL 填 Pages 上的 privacy.html
4. 审核 3–5 个工作日。**工具类应用个人开发者可上，不强制软著**
   （以商店实际要求为准，如被要求补软著则等证书下来再交）

### 4. Google Play

1. 👤 注册 Play Console（$25 一次性，身份验证 1–3 天）
2. 👤 **封闭测试**：建 closed testing track，上传 AAB，添加 ≥12 名测试者
   （邮箱列表），保持 14 天连续 opt-in —— 这是个人账号的硬性前置，没法绕过
3. 14 天后申请 production access（审核 ≤7 天），然后提交正式版
4. 商店列表材料：`store/listing-zh.md`（英文化后填）、feature graphic 1024×500、
   图标 512×512（`ui/logo.png` 可用）、Data safety 表单（我们全部「不收集」）
5. 总周期：约 3–4 周

### 5. F-Droid

1. 👤 在 <https://gitlab.com/fdroid/fdroiddata> 提交应用元数据 MR
   （或走 RFP 流程）；F-Droid 从源码自行构建，不接受二进制
2. 构建配方需要适配我们的「node 生成 bundle + gradle」两段式构建，
   可能要多轮沟通；审核周期 1–3 个月，适合长线挂着
3. 好处：无软著无费用，纯开源商店，Linux 用户信任度高

### 6. 华为 AppGallery（鸿蒙 NEXT）

前置（缺一不可）：
1. 👤 **软著或电子版权认证**：走「易版权」鸿蒙版电子版权最快（10–15 个工作日），
   或中国版权保护中心软著（免费，20–40 个工作日）。材料已生成在 `store/copyright/`
2. 👤 **APP 备案**（工信部，约 7 个工作日）
3. 👤 华为开发者账号实名 + 新账号需要申请「应用创建受邀名单」
   （发邮件 agconnect@huawei.com 附 Developer ID，3–5 个工作日）
4. 👤 签名必须用 AGC 的发布证书 + Profile（不是现在的自签），需装 DevEco Studio
   或在 AGC 网页云签名
5. 之后上传 `.app` 包 → 填信息（材料全齐）→ 审核 1–3 个工作日

### 7. 小米 / OPPO / vivo / 应用宝（安卓国内）

- 全部要求：**软著证书**（硬性，材料已备好，就差提交申请）+ 个人实名
- 建议顺序：先小米（个人开发者门槛最低、审核快），过审后再铺 OPPO/vivo
  （两家支持联合上架）；应用宝个人开发者限制多，可最后考虑
- APK 用 `dist/MoRead-android-0.6.13.apk`（正式签名）

## 软著申请（最优先，卡着 5 家商店）

1. 👤 注册 <https://register.ccopyright.com.cn>（中国版权保护中心），身份证实名
2. 在线填表：软件全称「墨读软件」或「墨读电子书阅读器软件」（须以"软件"结尾，
   与 APP 名称强相关），版本号 V0.6.13，开发完成日期 2026-11-14
3. 上传：
   - `store/copyright/source-code.txt` → 打印成 PDF（已按前30页+后30页规范排好）
   - `store/copyright/manual.md` → 转 PDF，配上 `store/screenshots/` 截图
4. 免费，普通通道 20–40 个工作日；**拿到证书后小米/OPPO/vivo/华为都能解锁**
5. 更快的替代：华为认可的「易版权」电子版权认证，10–15 个工作日，鸿蒙版有免费活动

## 待办优先级

1. 🔴 **备份 keystore**（丢了所有商店都无法更新）
2. 🔴 提交软著申请（解锁国内 5 家商店）
3. 🟡 Flathub PR + Snap Store 注册（纯自助，本周可完成）
4. 🟡 UOS/deepin 开发者认证（deb 已就绪）
5. 🟢 Google Play（想清楚再花 $25，12 人测试是硬门槛）
6. 🟢 F-Droid（长线）
