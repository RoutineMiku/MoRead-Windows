#!/bin/bash
# 在 macOS 上把 ios/ 工程打成 ipa。
#
#   ./scripts/build-ipa.sh              # 无签名 ipa，自己用 Sideloadly / AltStore / 爱思签
#   TEAM_ID=ABCDE12345 ./scripts/build-ipa.sh signed   # 用你的开发者证书签好
#
set -euo pipefail

cd "$(dirname "$0")/.."
ROOT="$(pwd)"
VERSION="$(grep -m1 'MARKETING_VERSION = ' MoRead.xcodeproj/project.pbxproj | tr -d ' ;' | cut -d= -f2)"
DIST="$ROOT/dist"
MODE="${1:-unsigned}"

if [ ! -f "MoRead/web/index.html" ]; then
  echo "缺少 MoRead/web/index.html。"
  echo "回到仓库根目录执行：node build/gen-web.js && node build/sync-ios.js"
  exit 1
fi
if ! command -v xcodebuild >/dev/null 2>&1; then
  echo "没有 xcodebuild：这个脚本只能在装了 Xcode 的 macOS 上跑。"
  exit 1
fi

mkdir -p "$DIST"

if [ "$MODE" = "signed" ]; then
  if [ -z "${TEAM_ID:-}" ]; then
    echo "用 signed 模式请先设置 TEAM_ID（Xcode → Settings → Accounts 里能看到，10 位）。"
    exit 1
  fi
  BUNDLE_ID="${BUNDLE_ID:-com.routinemiku.moread}"
  echo "== 归档（Development 签名，TEAM_ID=$TEAM_ID）"
  xcodebuild -project MoRead.xcodeproj -scheme MoRead -configuration Release \
    -sdk iphoneos -archivePath build/MoRead.xcarchive \
    DEVELOPMENT_TEAM="$TEAM_ID" PRODUCT_BUNDLE_IDENTIFIER="$BUNDLE_ID" \
    -allowProvisioningUpdates archive

  cat > build/ExportOptions.plist <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>method</key><string>development</string>
  <key>signingStyle</key><string>automatic</string>
  <key>teamID</key><string>$TEAM_ID</string>
  <key>stripSwiftSymbols</key><true/>
  <key>compileBitcode</key><false/>
</dict>
</plist>
PLIST

  echo "== 导出 ipa"
  rm -rf build/export
  xcodebuild -exportArchive -archivePath build/MoRead.xcarchive \
    -exportPath build/export -exportOptionsPlist build/ExportOptions.plist \
    -allowProvisioningUpdates
  cp build/export/*.ipa "$DIST/MoRead-$VERSION-signed.ipa"
  echo "完成：$DIST/MoRead-$VERSION-signed.ipa"
  exit 0
fi

echo "== 无签名构建（CODE_SIGNING_ALLOWED=NO）"
rm -rf build/Build build/Payload
xcodebuild -project MoRead.xcodeproj -scheme MoRead -configuration Release \
  -sdk iphoneos -derivedDataPath build \
  CODE_SIGNING_ALLOWED=NO CODE_SIGNING_REQUIRED=NO CODE_SIGN_IDENTITY="" \
  build

APP="build/Build/Products/Release-iphoneos/MoRead.app"
if [ ! -d "$APP" ]; then
  echo "构建产物不存在：$APP"
  exit 1
fi

echo "== 组装 Payload"
mkdir -p build/Payload
cp -R "$APP" build/Payload/
OUT="$DIST/MoRead-$VERSION-unsigned.ipa"
rm -f "$OUT"
(cd build && zip -qry "$OUT" Payload)
echo "完成：$OUT"
echo "签名安装：用 Sideloadly / AltStore / 爱思助手 载入这个 ipa，用自己的 Apple ID 签一次即可。"
