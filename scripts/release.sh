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
PUBLISH_DRY_RUN="${PUBLISH_DRY_RUN:-0}"

# Ensure packages/cli/package.json is restored if the script aborts mid-publish.
# The RETURN trap inside publish_npm() does not fire on set -e aborts.
CLI_BACKUP_ORIGINAL="$ROOT_DIR/packages/cli/.backup/package.json.original"
trap 'if [ -f "$CLI_BACKUP_ORIGINAL" ]; then mv "$CLI_BACKUP_ORIGINAL" "$ROOT_DIR/packages/cli/package.json" 2>/dev/null || true; fi' EXIT

if [ "$PUBLISH_DRY_RUN" = "true" ]; then
  PUBLISH_DRY_RUN="1"
fi

if [ "$PUBLISH_DRY_RUN" = "1" ]; then
  echo "DRY RUN 模式：执行打包校验，但不会发布 npm 包或 Docker 镜像。"
fi

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

require_npm_login() {
  if [ "$PUBLISH_DRY_RUN" = "1" ]; then
    return 0
  fi

  if ! npm whoami &>/dev/null; then
    echo "错误: 未登录 npm，请先运行: npm login"
    exit 1
  fi
}

# Pre-publish checklist gate: all package versions aligned, and the
# changelog/README release notes for $VERSION are actually written.
# Runs for every publish mode (npm/docker/all), including dry-run.
validate_release_docs() {
  echo ""
  echo "校验发布确认点（版本一致性 + changelog）..."

  ROOT_DIR="$ROOT_DIR" VERSION="$VERSION" node <<'EOF'
const fs = require('fs');
const path = require('path');

const root = process.env.ROOT_DIR;
const version = process.env.VERSION;
const errors = [];

// 1. All 6 package.json files (root + 5 packages) must carry the same version
const pkgPaths = [
  'package.json',
  'packages/cli/package.json',
  'packages/core/package.json',
  'packages/server/package.json',
  'packages/shared/package.json',
  'packages/ui/package.json',
];
for (const rel of pkgPaths) {
  const v = JSON.parse(fs.readFileSync(path.join(root, rel), 'utf8')).version;
  if (v !== version) {
    errors.push(`版本不一致: ${rel} 是 ${v}，应为 ${version}`);
  }
}

// 2. CHANGELOG.md must contain a non-empty "## [<version>]" section
const changelog = fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8');
const escaped = version.replace(/\./g, '\\.');
const section = changelog.match(
  new RegExp(`^## \\[${escaped}\\][^\\n]*\\n([\\s\\S]*?)(?=^## \\[|$(?![\\s\\S]))`, 'm')
);
if (!section) {
  errors.push(`CHANGELOG.md 缺少 "## [${version}]" 版本段落`);
} else if (!section[1].trim()) {
  errors.push(`CHANGELOG.md 的 "## [${version}]" 段落是空的，请补全变更内容`);
}

// 3. Both README changelog tables must contain a row for this version
for (const readme of ['README.md', 'README_en.md']) {
  const content = fs.readFileSync(path.join(root, readme), 'utf8');
  if (!content.includes(`| **v${version}** |`)) {
    errors.push(`${readme} 的更新日志表格缺少 "| **v${version}** |" 行`);
  }
}

// 4. New version must be strictly greater than the latest published version.
// Numeric per-segment compare (same rule as CLI's checkForUpdates), so
// multi-digit patch segments like 2.3.231 are supported and ordered
// correctly (2.3.231 > 2.3.24 would be rejected as a downgrade).
// Skipped with a warning if the registry is unreachable.
function compareVersions(v1, v2) {
  const p1 = v1.split('.').map(Number);
  const p2 = v2.split('.').map(Number);
  for (let i = 0; i < Math.max(p1.length, p2.length); i++) {
    const n1 = i < p1.length ? p1[i] : 0;
    const n2 = i < p2.length ? p2[i] : 0;
    if (n1 > n2) return 1;
    if (n1 < n2) return -1;
  }
  return 0;
}
try {
  const { execSync } = require('child_process');
  const published = execSync('npm view @wengine-ai/claude-code-router-next version', {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 15000,
  }).trim();
  if (published && compareVersions(version, published) <= 0) {
    errors.push(`版本号未递增: npm 上已发布 ${published}，本次要发布的 ${version} 不比它新`);
  }
} catch {
  console.warn('⚠️  无法从 npm registry 获取已发布版本，跳过版本递增校验');
}

if (errors.length) {
  console.error('❌ 发布确认点未通过:');
  for (const e of errors) console.error(`   ✗ ${e}`);
  console.error('请按 CLAUDE.md 的 Release checklist 补全后重新发布。');
  process.exit(1);
}
console.log(`✅ 发布确认点通过: 6 个 package.json 均为 ${version}，CHANGELOG.md 与两份 README 均已记录该版本`);
EOF
}

validate_cli_dist() {
  local cli_dir="$1"
  local dist_dir="$cli_dir/dist"

  node - "$cli_dir/package.json" "$dist_dir" <<'EOF'
const fs = require('fs');
const path = require('path');

const packagePath = process.argv[2];
const distDir = process.argv[3];
const pkg = JSON.parse(fs.readFileSync(packagePath, 'utf8'));

if (pkg.peerDependencies?.node) {
  throw new Error('publish package must not include peerDependencies.node');
}
if (!pkg.engines?.node) {
  throw new Error('publish package must include engines.node');
}

const required = ['cli.js', 'index.html', 'tiktoken_bg.wasm'];
for (const file of required) {
  if (!fs.existsSync(path.join(distDir, file))) {
    throw new Error(`missing required CLI dist artifact: ${file}`);
  }
}

const forbidden = ['index.js', 'package.json'];
for (const file of forbidden) {
  if (fs.existsSync(path.join(distDir, file))) {
    throw new Error(`stale CLI dist artifact must not be published: dist/${file}`);
  }
}
EOF
}

validate_cli_pack() {
  local cli_dir="$1"

  echo "校验 CLI npm 包内容..."
  local pack_json
  pack_json=$(cd "$cli_dir" && npm pack --dry-run --json)

  PACK_JSON="$pack_json" node <<'EOF'
const pack = JSON.parse(process.env.PACK_JSON);
const files = new Set((pack[0]?.files || []).map((file) => file.path.replace(/^package\//, '')));
const required = [
  'dist/cli.js',
  'dist/index.html',
  'dist/tiktoken_bg.wasm',
  'package.json',
];
const forbidden = [
  'dist/index.js',
  'dist/package.json',
];

for (const file of required) {
  if (!files.has(file)) {
    throw new Error(`npm pack is missing required file: ${file}`);
  }
}

for (const file of forbidden) {
  if (files.has(file)) {
    throw new Error(`npm pack includes forbidden stale file: ${file}`);
  }
}

console.log(JSON.stringify({
  package: pack[0]?.name,
  version: pack[0]?.version,
  files: Array.from(files).sort(),
}, null, 2));
EOF
}

# Publish core npm package (@wengine-ai/llms)
publish_core_npm() {
  echo ""
  echo "========================================="
  echo "发布 npm 包 @wengine-ai/llms"
  echo "========================================="

  require_npm_login

  CORE_DIR="$ROOT_DIR/packages/core"
  CORE_VERSION=$(node -e "console.log(require(process.argv[1]).version)" "$CORE_DIR/package.json")

  cp "$ROOT_DIR/README.md" "$CORE_DIR/" 2>/dev/null || echo "README.md 不存在，跳过..."
  cp "$ROOT_DIR/LICENSE" "$CORE_DIR/" 2>/dev/null || echo "LICENSE 文件不存在，跳过..."

  cd "$CORE_DIR"
  if [ "$PUBLISH_DRY_RUN" = "1" ]; then
    echo "执行 npm pack dry-run..."
    npm pack --dry-run --json
    echo "✅ Core npm 包 dry-run 校验成功!"
  else
    echo "执行 npm publish..."
    npm publish --access public ${NPM_OTP:+--otp="$NPM_OTP"}
    echo "✅ Core npm 包发布成功!"
  fi

  echo "   包名: @wengine-ai/llms@${CORE_VERSION}"
}

# Publish CLI npm package
publish_npm() {
  echo ""
  echo "========================================="
  echo "发布 npm 包 @wengine-ai/claude-code-router-next"
  echo "========================================="

  require_npm_login

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
delete pkg.peerDependencies;
pkg.files = ['dist/*', 'README.md', 'LICENSE'];
pkg.dependencies = {
  '@wengine-ai/llms': `^${corePkg.version}`,
  'better-sqlite3': serverPkg.dependencies['better-sqlite3'],
  'lru-cache': `^11.2.2`,
};
pkg.engines = {
  node: '>=18.0.0',
};

fs.writeFileSync(process.env.PUBLISH_PKG_PATH, JSON.stringify(pkg, null, 2) + '\n');
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

  validate_cli_dist "$CLI_DIR"
  validate_cli_pack "$CLI_DIR"

  cd "$CLI_DIR"
  if [ "$PUBLISH_DRY_RUN" = "1" ]; then
    echo "DRY RUN: 跳过 npm publish。"
  else
    echo "执行 npm publish..."
    npm publish --access public ${NPM_OTP:+--otp="$NPM_OTP"}
  fi

  restore_cli_package_json
  trap - RETURN

  echo ""
  if [ "$PUBLISH_DRY_RUN" = "1" ]; then
    echo "✅ npm 包 dry-run 校验成功!"
  else
    echo "✅ npm 包发布成功!"
  fi
  echo "   包名: @wengine-ai/claude-code-router-next@${VERSION}"
}

# Publish Docker image
publish_docker() {
  echo ""
  echo "========================================="
  echo "发布 Docker 镜像"
  echo "========================================="

  if [ "$PUBLISH_DRY_RUN" = "1" ]; then
    echo "DRY RUN: 跳过 Docker 构建和推送。"
    return 0
  fi

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

# Pre-publish gate: docs and versions must be release-ready before anything ships
validate_release_docs

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
