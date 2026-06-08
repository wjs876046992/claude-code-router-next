#!/bin/bash
set -e

# Release script
# - Publish the core package as @wengine-ai/llms
# - Publish the CLI package as @wengine-ai/claude-code-router-next
# - Publish the server package as a Docker image

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

VERSION=$(node -e "console.log(require(process.argv[1]).version)" "$ROOT_DIR/packages/cli/package.json")
IMAGE_NAME="ccr/router"
IMAGE_TAG="${VERSION}"
LATEST_TAG="latest"

echo "========================================="
echo "发布 Claude Code Router v${VERSION}"
echo "========================================="

# Get publish mode
PUBLISH_TYPE="${1:-all}"

case "$PUBLISH_TYPE" in
  npm)
    echo "仅发布 npm 包..."
    ;;
  docker)
    echo "仅发布 Docker 镜像..."
    ;;
  all)
    echo "发布 npm 包和 Docker 镜像..."
    ;;
  *)
    echo "用法: $0 [npm|docker|all]"
    echo "  npm    - 仅发布到 npm"
    echo "  docker - 仅发布到 Docker Hub"
    echo "  all    - 发布到 npm 和 Docker Hub (默认)"
    exit 1
    ;;
esac

# Publish core npm package (@wengine-ai/llms)
publish_core_npm() {
  echo ""
  echo "========================================="
  echo "发布 npm 包 @wengine-ai/llms"
  echo "========================================="

  if ! npm whoami &>/dev/null; then
    echo "错误: 未登录 npm，请先运行: npm login"
    exit 1
  fi

  CORE_DIR="$ROOT_DIR/packages/core"
  CORE_VERSION=$(node -e "console.log(require(process.argv[1]).version)" "$CORE_DIR/package.json")

  cp "$ROOT_DIR/README.md" "$CORE_DIR/" 2>/dev/null || echo "README.md 不存在，跳过..."
  cp "$ROOT_DIR/LICENSE" "$CORE_DIR/" 2>/dev/null || echo "LICENSE 文件不存在，跳过..."

  cd "$CORE_DIR"
  echo "执行 npm publish..."
  npm publish --access public

  echo ""
  echo "✅ Core npm 包发布成功!"
  echo "   包名: @wengine-ai/llms@${CORE_VERSION}"
}

# Publish CLI npm package
publish_npm() {
  echo ""
  echo "========================================="
  echo "发布 npm 包 @wengine-ai/claude-code-router-next"
  echo "========================================="

  if ! npm whoami &>/dev/null; then
    echo "错误: 未登录 npm，请先运行: npm login"
    exit 1
  fi

  CLI_DIR="$ROOT_DIR/packages/cli"
  BACKUP_DIR="$CLI_DIR/.backup"
  mkdir -p "$BACKUP_DIR"
  cp "$CLI_DIR/package.json" "$BACKUP_DIR/package.json.bak"

  CLI_PKG_PATH="$CLI_DIR/package.json"
  SERVER_PKG_PATH="$ROOT_DIR/packages/server/package.json"
  CORE_PKG_PATH="$ROOT_DIR/packages/core/package.json"
  PUBLISH_PKG_PATH="$CLI_DIR/package.publish.json"

  CLI_PKG_PATH="$CLI_PKG_PATH" SERVER_PKG_PATH="$SERVER_PKG_PATH" CORE_PKG_PATH="$CORE_PKG_PATH" PUBLISH_PKG_PATH="$PUBLISH_PKG_PATH" node <<'EOF'
const fs = require('fs');

const pkg = JSON.parse(fs.readFileSync(process.env.CLI_PKG_PATH, 'utf8'));
const serverPkg = JSON.parse(fs.readFileSync(process.env.SERVER_PKG_PATH, 'utf8'));
const corePkg = JSON.parse(fs.readFileSync(process.env.CORE_PKG_PATH, 'utf8'));

pkg.name = '@wengine-ai/claude-code-router-next';
delete pkg.scripts;
pkg.files = ['dist/*', 'README.md', 'LICENSE'];
pkg.dependencies = {
  '@wengine-ai/llms': `^${corePkg.version}`,
  'better-sqlite3': serverPkg.dependencies['better-sqlite3'] || '^12.10.0',
  'lru-cache': `^11.2.2`,
};
pkg.peerDependencies = {
  node: '>=18.0.0',
};
pkg.engines = {
  node: '>=18.0.0',
};

fs.writeFileSync(process.env.PUBLISH_PKG_PATH, JSON.stringify(pkg, null, 2));
EOF

  mv "$CLI_DIR/package.json" "$BACKUP_DIR/package.json.original"
  mv "$CLI_DIR/package.publish.json" "$CLI_DIR/package.json"

  restore_cli_package_json() {
    if [ -f "$BACKUP_DIR/package.json.original" ]; then
      mv "$BACKUP_DIR/package.json.original" "$CLI_DIR/package.json"
    fi
  }
  trap restore_cli_package_json RETURN

  cp "$ROOT_DIR/README.md" "$CLI_DIR/"
  cp "$ROOT_DIR/LICENSE" "$CLI_DIR/" 2>/dev/null || echo "LICENSE 文件不存在，跳过..."

  cd "$CLI_DIR"
  echo "执行 npm publish..."
  npm publish --access public

  restore_cli_package_json
  trap - RETURN

  echo ""
  echo "✅ npm 包发布成功!"
  echo "   包名: @wengine-ai/claude-code-router-next@${VERSION}"
}

# Publish Docker image
publish_docker() {
  echo ""
  echo "========================================="
  echo "发布 Docker 镜像"
  echo "========================================="

  if ! docker info &>/dev/null; then
    echo "错误: Docker 未运行"
    exit 1
  fi

  echo "构建 Docker 镜像 ${IMAGE_NAME}:${IMAGE_TAG}..."
  docker build -t "${IMAGE_NAME}:${IMAGE_TAG}" -f "$ROOT_DIR/packages/server/Dockerfile" "$ROOT_DIR"

  echo "标记为 latest..."
  docker tag "${IMAGE_NAME}:${IMAGE_TAG}" "${IMAGE_NAME}:${LATEST_TAG}"

  echo "推送 ${IMAGE_NAME}:${IMAGE_TAG}..."
  docker push "${IMAGE_NAME}:${IMAGE_TAG}"

  echo "推送 ${IMAGE_NAME}:${LATEST_TAG}..."
  docker push "${IMAGE_NAME}:${LATEST_TAG}"

  echo ""
  echo "✅ Docker 镜像发布成功!"
  echo "   镜像: ${IMAGE_NAME}:${IMAGE_TAG}"
  echo "   镜像: ${IMAGE_NAME}:latest"
}

# Run release steps
if [ "$PUBLISH_TYPE" = "npm" ] || [ "$PUBLISH_TYPE" = "all" ]; then
  publish_core_npm
  publish_npm
fi

if [ "$PUBLISH_TYPE" = "docker" ] || [ "$PUBLISH_TYPE" = "all" ]; then
  publish_docker
fi

echo ""
echo "========================================="
echo "发布完成!"
echo "========================================="
