# 微软商店（Microsoft Store）提交说明

这个目录放的是**商店提交需要的素材**；MSIX 包由 `build/msix.js` 生成。

```
build/msix.js                 打 MSIX（FullTrust 桌面应用，x64）
build/gen-msix-assets.js      生成商店图标（50/44/71/150/310 + 310x150）
build/msix/AppxManifest.xml   清单模板（{{IDENTITY}} 等占位符由脚本替换）
build/msix/Assets/            图标输出
store/listing-zh.md           商店文案（名称/描述/关键词/分级/隐私政策 URL）
store/screenshots/            1920×1080 截图（5 张）
web/privacy.html              隐私政策页，随网页版发布到 Pages
```

## 一、准备账号

1. 打开 <https://partner.microsoft.com/dashboard>，用个人 Microsoft 账号注册开发者（个人约 ¥/US$19 一次性，企业需营业执照）。
2. 等账号审核通过（通常 1–3 天）。
3. 「应用和游戏 → 新建产品 → 应用」→ 预留名称 **墨读**。

## 二、拿到 Identity，重打一次包

预留名称后，在「产品 → 产品标识」里能看到两行关键信息：

```
Package/Identity/Name       例如 12345RoutineMiku.MoRead
Package/Identity/Publisher  例如 CN=8F3A1B2C-...
Package/Properties/PublisherDisplayName  例如 RoutineMiku
```

用它们重打（**Publisher 必须与 Partner Center 给的一字不差**）：

```bash
node build/msix.js \
  --identity "12345RoutineMiku.MoRead" \
  --publisher "CN=8F3A1B2C-..." \
  --publisher-name "RoutineMiku"
```

输出：`dist/MoRead-0.6.13-x64.msix`（约 144 MB）。

> 提交给商店的包**不需要自己签名**，微软会用商店证书重签。
> 只有想在本机双击安装测试时，才需要自签 + 把证书装进「受信任的根」：
> `node build/msix.js --sign --sha1 <证书指纹>`，证书由 `build/msix-test.cer` 导入。

## 三、上传与填写

在 Partner Center「提交」里依次完成：

1. **包**：上传 `dist/MoRead-0.6.13-x64.msix`（单包，x64）。
2. **商店列表**：按 `store/listing-zh.md` 粘贴名称、简短描述、详细描述、关键词、版权。
3. **截图**：上传 `store/screenshots/` 里 5 张 1920×1080 图（第一张会是列表页主图）。
4. **年龄分级**：问卷按「无用户生成内容、无社交、无支付」填，建议 12+。
5. **定价**：免费；不做应用内购买。
6. **隐私政策**：`https://routinemiku.github.io/MoRead-Windows/privacy.html`
7. **系统要求**：Windows 10 1809+，x64，4GB 内存，400MB 存储。
8. **提交审核**：通常 1–3 个工作日；被拒会给出具体条款，按提示改完重新提交即可。

## 四、每次更新的流程

```bash
node build/version.js --bump patch   # 改版本号
node build/pack.js                   # 先出 Windows 目录（MSIX 的输入）
node build/msix.js --identity "..." --publisher "CN=..."   # 重打 MSIX
```

然后在 Partner Center 新建提交 → 上传新包 → 更新「此版本中的新增功能」→ 提交。商店版本号取 `package.json` 的 version（脚本会自动补成四段 `0.6.13.0`）。

## 五、注意事项

- **数据目录**：MSIX 会装进 `C:\Program Files\WindowsApps`（只读），所以打包时必须去掉 `portable.txt`（脚本已自动删）。应用会改用 `%APPDATA%`，数据仍在用户本机。
- **体积**：MSIX 144MB，商店单包上限远高于此，但首次上传会比较慢。
- **架构**：目前只打 x64。要支持 ARM64，需要再出一份 `win32-arm64` 的 Electron 运行时并用 `ProcessorArchitecture="arm64"` 重打，作为第二个包一起上传（可选）。
- **自动更新**：商店版由 Microsoft Store 负责更新，应用内「检查更新」仍可用，但提示的是官网安装包；商店版用户可以忽略，等商店推送即可。
- **证书文件**：`build/msix-test.pfx` 只用于本地测试，**不要提交到仓库**（已在 `.gitignore`）。
