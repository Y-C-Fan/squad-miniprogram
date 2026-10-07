#!/usr/bin/env bash
# 一键编译手环版 .rpk
#
#   bash band/build.sh            # 编译 debug 包
#   bash band/build.sh release    # 编译正式包（需先有 sign/）
#
# 会自动做依赖检查，缺什么装什么。

set -e
cd "$(dirname "$0")"

MODE="${1:-debug}"
NODE="C:/Users/chaowi/.workbuddy/binaries/node/versions/22.22.2-6/node.exe"
NPM="C:/Users/chaowi/.workbuddy/binaries/node/versions/22.22.2-6/npm.cmd"

echo "==> 检查依赖"
if [ ! -d node_modules/aiot-toolkit ]; then
  echo "    未安装 aiot-toolkit，开始安装（约 2 分钟）..."
  # --legacy-peer-deps 必须加：aiot-toolkit 的 @aiot-toolkit/commander 嵌套了一整套
  # @inquirer/*，与顶层版本冲突，不加会装出无法解析的依赖树。
  "$NPM" install aiot-toolkit --legacy-peer-deps --no-audit --no-fund
fi

echo "==> 同步核心算法"
# Vela 不支持 require 外部目录，手环工程必须自带一份算法副本。
# 不做这一步的话，改了 utils/ 忘了同步，手环版会一直跑旧阈值。
"$NODE" ../tools/sync-band.js

if [ "$MODE" = "release" ] && [ ! -f sign/private.pem ]; then
  echo "    缺少签名证书，正在生成..."
  mkdir -p sign
  openssl req -newkey rsa:2048 -nodes -keyout sign/private.pem -x509 -days 3650 \
    -out sign/certificate.pem -subj "/C=CN/O=chaowi/CN=squad-band" 2>/dev/null
  echo "    已生成 sign/private.pem + sign/certificate.pem"
fi

echo "==> 编译（$MODE）"
export PATH="$PWD/node_modules/.bin:$PATH"

if [ "$MODE" = "release" ]; then
  aiot release
else
  aiot build
fi

echo ""
echo "==> 产物"
ls -la dist/
echo ""
echo "装到手环：手机装 AstroBox → 连接手环 → 本地安装 → 选 dist/*.rpk"
