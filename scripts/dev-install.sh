#!/bin/bash
set -e

# dev-install.sh — 一键构建并替换本地版本到全局安装目录
#
# 原理：本地 dist/cli.js 是 esbuild 打包产物，better-sqlite3 / lru-cache 被标记为
# external，运行时必须从 node_modules 找到。npm 全局安装的包里有完整依赖，
# 所以只需覆盖 dist/ 目录即可复用其 node_modules。
#
# 用法：
#   pnpm dev        # 等同于 pnpm exec bash scripts/dev-install.sh
#   bash scripts/dev-install.sh

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
GLOBAL_PREFIX="$(npm prefix -g)"

# 可能存在的旧版全局安装路径（按优先级查找）
CANDIDATES=(
  "$GLOBAL_PREFIX/lib/node_modules/@wengine-ai/claude-code-router-next"
  "$GLOBAL_PREFIX/lib/node_modules/claude-code-router-workspace"
)

# 找到目标目录
TARGET_DIR=""
for dir in "${CANDIDATES[@]}"; do
  if [ -d "$dir/dist" ]; then
    TARGET_DIR="$dir"
    break
  fi
done

# 没找到：先安装一次，拿回 node_modules
if [ -z "$TARGET_DIR" ]; then
  echo "⏳ 未找到全局安装，正在 npm install -g @wengine-ai/claude-code-router-next ..."
  npm install -g @wengine-ai/claude-code-router-next
  for dir in "${CANDIDATES[@]}"; do
    if [ -d "$dir/dist" ]; then
      TARGET_DIR="$dir"
      break
    fi
  done
  if [ -z "$TARGET_DIR" ]; then
    echo "❌ 安装后仍未找到全局目录，请手动检查" >&2
    exit 1
  fi
fi

echo "📁 全局安装目录：$TARGET_DIR"

# Step 1: 构建
echo ""
echo "🔨 正在构建..."
cd "$ROOT_DIR"
pnpm build 2>&1 | tail -3
echo "✅ 构建完成"

# Step 2: 覆盖 dist/
DIST_FILES=(cli.js index.html tiktoken_bg.wasm)
for f in "${DIST_FILES[@]}"; do
  src="$ROOT_DIR/dist/$f"
  dst="$TARGET_DIR/dist/$f"
  if [ -f "$src" ]; then
    cp "$src" "$dst"
    echo "  ✓ $f"
  else
    echo "  ⚠ $f 不存在，跳过"
  fi
done

# Step 3: 验证
VERSION=$(ccr -v 2>&1)
echo ""
echo "🎉 完成！$VERSION"
