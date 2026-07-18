#!/bin/bash
set -e

# Release script
# - Publish shared utilities as @wengine-ai/claude-code-router-shared
# - Publish the core package as @wengine-ai/llms
# - Publish the CLI package as @wengine-ai/claude-code-router-next
# - Publish the server package as a Docker image

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

CLI_BACKUP_ORIGINAL="$ROOT_DIR/packages/cli/.backup/package.json.original"
CORE_BACKUP_DIR="$ROOT_DIR/.release-backup"
CORE_BACKUP_ORIGINAL="$CORE_BACKUP_DIR/core-package.json.original"

# Restore source manifests left by an interrupted release before reading versions
# or publishing anything. Without this early recovery, a rerun could validate a
# stale publish manifest and publish shared/core before noticing the CLI backup.
recover_interrupted_publish() {
  local recovered=0
  if [ -f "$CLI_BACKUP_ORIGINAL" ]; then
    mv "$CLI_BACKUP_ORIGINAL" "$ROOT_DIR/packages/cli/package.json"
    rm -f "$ROOT_DIR/packages/cli/package.publish.json"
    recovered=1
  fi
  if [ -f "$CORE_BACKUP_ORIGINAL" ]; then
    mv "$CORE_BACKUP_ORIGINAL" "$ROOT_DIR/packages/core/package.json"
    rm -f "$ROOT_DIR/packages/core/package.publish.json"
    recovered=1
  fi
  rmdir "$CORE_BACKUP_DIR" 2>/dev/null || true
  if [ "$recovered" = "1" ]; then
    echo "⚠️  已恢复上次中断发布留下的 source package.json，将重新执行完整校验。"
  fi
}

recover_interrupted_publish

VERSION=$(node -e "console.log(require(process.argv[1]).version)" "$ROOT_DIR/packages/cli/package.json")
IMAGE_NAME="ccr/router"
IMAGE_TAG="${VERSION}"
LATEST_TAG="latest"
PUBLISH_DRY_RUN="${PUBLISH_DRY_RUN:-0}"

# Ensure source package.json files are restored if the script aborts mid-publish.
# The RETURN traps inside publish functions do not fire on set -e aborts.
trap '
  if [ -f "$CLI_BACKUP_ORIGINAL" ]; then mv "$CLI_BACKUP_ORIGINAL" "$ROOT_DIR/packages/cli/package.json" 2>/dev/null || true; fi
  if [ -f "$CORE_BACKUP_ORIGINAL" ]; then mv "$CORE_BACKUP_ORIGINAL" "$ROOT_DIR/packages/core/package.json" 2>/dev/null || true; fi
  rmdir "$CORE_BACKUP_DIR" 2>/dev/null || true
' EXIT

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

// 4. Source workspace dependencies must point to real packages in this monorepo.
// The publish transforms replace these ranges with registry-safe versions; an
// unresolved workspace reference would otherwise produce a broken manifest.
const workspacePackages = new Set();
for (const rel of fs.readdirSync(path.join(root, 'packages'))) {
  const manifest = path.join(root, 'packages', rel, 'package.json');
  if (!fs.existsSync(manifest)) continue;
  const pkg = JSON.parse(fs.readFileSync(manifest, 'utf8'));
  if (pkg.name) workspacePackages.add(pkg.name);
}
for (const rel of ['packages/shared/package.json', 'packages/core/package.json', 'packages/cli/package.json']) {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, rel), 'utf8'));
  for (const field of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
    for (const [name, spec] of Object.entries(pkg[field] || {})) {
      if (typeof spec === 'string' && spec.startsWith('workspace:') && !workspacePackages.has(name)) {
        errors.push(`无法解析 workspace 依赖: ${rel} 的 ${field}.${name} = ${spec}`);
      }
    }
  }
}

// 5. New version must be strictly greater than the latest published version.
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

validate_shared_dist() {
  local shared_dir="$1"
  local dist_dir="$shared_dir/dist"

  node - "$dist_dir" <<'EOF'
const fs = require('fs');
const path = require('path');

const distDir = process.argv[2];
for (const file of ['index.js', 'index.d.ts']) {
  if (!fs.existsSync(path.join(distDir, file))) {
    throw new Error(`missing required shared dist artifact: ${file}`);
  }
}
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

# Assert a manifest contains no pnpm/yarn "workspace:" protocol ranges.
# npm cannot resolve "workspace:*" / "workspace:^1.2.3" and crashes silently
# when installing a published package that still carries them. Run this against
# every publish manifest (after any workspace->version rewriting) so a polluted
# package can never reach the registry.
assert_no_workspace_in_manifest() {
  local manifest="$1"
  if [ ! -f "$manifest" ]; then
    echo "错误: 待校验的 manifest 不存在: $manifest" >&2
    exit 1
  fi
  if grep -q '"[^"]*":[[:space:]]*"workspace:' "$manifest"; then
    echo "❌ 发布中止: $manifest 仍包含 \"workspace:\" 协议依赖范围:" >&2
    grep -n '"workspace:' "$manifest" >&2 || true
    echo "   npm 无法解析 workspace 协议，发布到 npm 会让 npm install 静默崩溃。" >&2
    exit 1
  fi
}

# Validate the three npm publish manifests before any package is published.
# This mirrors their release transformations and catches both unresolvable
# workspace references and any "workspace:" range that would leak to npm.
validate_workspace_publish_plan() {
  ROOT_DIR="$ROOT_DIR" node <<'EOF'
const fs = require('fs');
const path = require('path');

const root = process.env.ROOT_DIR;
const dependencyFields = [
  'dependencies',
  'devDependencies',
  'peerDependencies',
  'optionalDependencies',
];
const packageDirs = fs.readdirSync(path.join(root, 'packages'), { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => path.join(root, 'packages', entry.name));
const workspacePackages = new Map();

for (const dir of packageDirs) {
  const manifest = path.join(dir, 'package.json');
  if (!fs.existsSync(manifest)) continue;
  const pkg = JSON.parse(fs.readFileSync(manifest, 'utf8'));
  workspacePackages.set(pkg.name, pkg);
}

function readPackage(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(root, relativePath), 'utf8'));
}

function resolveWorkspaceSpec(spec, depName) {
  const workspacePkg = workspacePackages.get(depName);
  if (!workspacePkg) {
    throw new Error(`Cannot resolve workspace dependency ${depName}`);
  }
  const selector = spec.slice('workspace:'.length);
  if (selector === '*' || selector === '^' || selector === '') {
    return `^${workspacePkg.version}`;
  }
  if (selector === '~') {
    return `~${workspacePkg.version}`;
  }
  return selector;
}

function replaceWorkspaceRanges(pkg) {
  for (const field of dependencyFields) {
    const deps = pkg[field];
    if (!deps || typeof deps !== 'object') continue;
    for (const [name, spec] of Object.entries(deps)) {
      if (typeof spec === 'string' && spec.startsWith('workspace:')) {
        deps[name] = resolveWorkspaceSpec(spec, name);
      }
    }
  }
  return pkg;
}

function assertClean(pkg, name) {
  const serialized = JSON.stringify(pkg);
  if (serialized.includes('workspace:')) {
    throw new Error(`${name} publish manifest still contains a workspace: range`);
  }
}

const sharedPkg = readPackage('packages/shared/package.json');
assertClean(sharedPkg, sharedPkg.name);

const corePkg = replaceWorkspaceRanges(readPackage('packages/core/package.json'));
assertClean(corePkg, corePkg.name);

const cliPkg = readPackage('packages/cli/package.json');
const serverPkg = readPackage('packages/server/package.json');
delete cliPkg.scripts;
delete cliPkg.peerDependencies;
delete cliPkg.devDependencies;
cliPkg.dependencies = {
  '@wengine-ai/llms': `^${corePkg.version}`,
  'better-sqlite3': serverPkg.dependencies['better-sqlite3'],
  'lru-cache': cliPkg.dependencies['lru-cache'],
};
assertClean(cliPkg, cliPkg.name);

console.log('✅ npm 发布 manifest 校验通过: shared/core/cli 均不包含 workspace: 协议');
EOF
}

# Publish shared npm package (@wengine-ai/claude-code-router-shared).
# Must run BEFORE core: @wengine-ai/llms depends on shared (^<version>), so npm
# needs the matching shared version to be already published when resolving core.
# shared has no workspace: deps of its own, so it can be published as-is.
publish_shared_npm() {
  echo ""
  echo "========================================="
  echo "发布 npm 包 @wengine-ai/claude-code-router-shared"
  echo "========================================="

  require_npm_login

  local SHARED_DIR="$ROOT_DIR/packages/shared"
  local SHARED_VERSION
  SHARED_VERSION=$(node -e "console.log(require(process.argv[1]).version)" "$SHARED_DIR/package.json")

  validate_shared_dist "$SHARED_DIR"
  assert_no_workspace_in_manifest "$SHARED_DIR/package.json"

  cd "$SHARED_DIR"
  if [ "$PUBLISH_DRY_RUN" = "1" ]; then
    echo "执行 npm pack dry-run..."
    npm pack --dry-run --json
    echo "✅ Shared npm 包 dry-run 校验成功!"
  else
    echo "执行 npm publish..."
    npm publish --access public ${NPM_OTP:+--otp="$NPM_OTP"}
    echo "✅ Shared npm 包发布成功!"
  fi

  echo "   包名: @wengine-ai/claude-code-router-shared@${SHARED_VERSION}"
}

# Publish core npm package (@wengine-ai/llms)
publish_core_npm() {
  echo ""
  echo "========================================="
  echo "发布 npm 包 @wengine-ai/llms"
  echo "========================================="

  require_npm_login

  local CORE_DIR="$ROOT_DIR/packages/core"
  local BACKUP_DIR="$CORE_BACKUP_DIR"
  local CORE_VERSION
  mkdir -p "$BACKUP_DIR"
  CORE_VERSION=$(node -e "console.log(require(process.argv[1]).version)" "$CORE_DIR/package.json")

  cp "$ROOT_DIR/README.md" "$CORE_DIR/" 2>/dev/null || echo "README.md 不存在，跳过..."
  cp "$ROOT_DIR/LICENSE" "$CORE_DIR/" 2>/dev/null || echo "LICENSE 文件不存在，跳过..."

  # Build a publish manifest with pnpm "workspace:" ranges rewritten to real
  # npm version ranges. npm does not understand "workspace:*" (it is a
  # pnpm/yarn workspace protocol), and shipping it makes `npm install` silently
  # crash while resolving the dependency tree. Mirrors publish_npm()'s
  # package.publish.json + RETURN-trap restore pattern so the source manifest is
  # never mutated on disk.
  local PUBLISH_PKG_PATH="$CORE_DIR/package.publish.json"
  CORE_PKG_PATH="$CORE_DIR/package.json" PUBLISH_PKG_PATH="$PUBLISH_PKG_PATH" ROOT_DIR="$ROOT_DIR" node <<'EOF'
const fs = require('fs');
const path = require('path');

const pkg = JSON.parse(fs.readFileSync(process.env.CORE_PKG_PATH, 'utf8'));
const root = process.env.ROOT_DIR;

function findWorkspacePackage(depName) {
  const packagesDir = path.join(root, 'packages');
  for (const entry of fs.readdirSync(packagesDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const manifest = path.join(packagesDir, entry.name, 'package.json');
    if (!fs.existsSync(manifest)) continue;
    const workspacePkg = JSON.parse(fs.readFileSync(manifest, 'utf8'));
    if (workspacePkg.name === depName) return workspacePkg;
  }
  throw new Error(`Cannot resolve workspace dependency ${depName}`);
}

// Map a workspace dependency spec ("workspace:*", "workspace:^1.2.3", ...) to a
// real npm range. Bare selectors use the referenced workspace package version;
// explicit ranges keep their range after the protocol prefix is removed.
function resolveWorkspaceSpec(spec, depName) {
  const selector = spec.slice('workspace:'.length);
  const workspacePkg = findWorkspacePackage(depName);

  if (selector === '*' || selector === '^' || selector === '') {
    return `^${workspacePkg.version}`;
  }
  if (selector === '~') {
    return `~${workspacePkg.version}`;
  }
  return selector;
}

for (const field of ['dependencies', 'peerDependencies', 'optionalDependencies']) {
  const deps = pkg[field];
  if (!deps || typeof deps !== 'object') continue;
  for (const [name, spec] of Object.entries(deps)) {
    if (typeof spec === 'string' && spec.startsWith('workspace:')) {
      deps[name] = resolveWorkspaceSpec(spec, name);
    }
  }
}

fs.writeFileSync(process.env.PUBLISH_PKG_PATH, JSON.stringify(pkg, null, 2) + '\n');
EOF

  assert_no_workspace_in_manifest "$PUBLISH_PKG_PATH"

  if [ -f "$CORE_BACKUP_ORIGINAL" ]; then
    echo "错误: 检测到未恢复的 core package.json 备份: $CORE_BACKUP_ORIGINAL" >&2
    echo "请先确认并恢复该文件，避免覆盖未完成发布留下的源 manifest。" >&2
    exit 1
  fi
  mv "$CORE_DIR/package.json" "$CORE_BACKUP_ORIGINAL"
  mv "$CORE_DIR/package.publish.json" "$CORE_DIR/package.json"

  restore_core_package_json() {
    if [ -f "$CORE_BACKUP_ORIGINAL" ]; then
      mv "$CORE_BACKUP_ORIGINAL" "$CORE_DIR/package.json"
    fi
    rmdir "$CORE_BACKUP_DIR" 2>/dev/null || true
  }
  trap restore_core_package_json RETURN

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

  restore_core_package_json
  trap - RETURN

  echo "   包名: @wengine-ai/llms@${CORE_VERSION}"
}

# Publish CLI npm package
publish_npm() {
  echo ""
  echo "========================================="
  echo "发布 npm 包 @wengine-ai/claude-code-router-next"
  echo "========================================="

  require_npm_login

  local CLI_DIR="$ROOT_DIR/packages/cli"
  local BACKUP_DIR="$CLI_DIR/.backup"
  mkdir -p "$BACKUP_DIR"
  if [ -f "$CLI_BACKUP_ORIGINAL" ]; then
    echo "错误: 检测到未恢复的 CLI package.json 备份: $CLI_BACKUP_ORIGINAL" >&2
    echo "请先确认并恢复该文件，避免用残留的发布 manifest 覆盖源配置。" >&2
    exit 1
  fi
  cp "$CLI_DIR/package.json" "$BACKUP_DIR/package.json.bak"

  local CLI_PKG_PATH="$CLI_DIR/package.json"
  local SERVER_PKG_PATH="$ROOT_DIR/packages/server/package.json"
  local CORE_PKG_PATH="$ROOT_DIR/packages/core/package.json"
  local PUBLISH_PKG_PATH="$CLI_DIR/package.publish.json"

  CLI_PKG_PATH="$CLI_PKG_PATH" SERVER_PKG_PATH="$SERVER_PKG_PATH" CORE_PKG_PATH="$CORE_PKG_PATH" PUBLISH_PKG_PATH="$PUBLISH_PKG_PATH" node <<'EOF'
const fs = require('fs');

const pkg = JSON.parse(fs.readFileSync(process.env.CLI_PKG_PATH, 'utf8'));
const serverPkg = JSON.parse(fs.readFileSync(process.env.SERVER_PKG_PATH, 'utf8'));
const corePkg = JSON.parse(fs.readFileSync(process.env.CORE_PKG_PATH, 'utf8'));

pkg.name = '@wengine-ai/claude-code-router-next';
delete pkg.scripts;
delete pkg.peerDependencies;
delete pkg.devDependencies;
pkg.files = ['dist/*', 'README.md', 'LICENSE'];
pkg.dependencies = {
  '@wengine-ai/llms': `^${corePkg.version}`,
  'better-sqlite3': serverPkg.dependencies['better-sqlite3'],
  'lru-cache': pkg.dependencies['lru-cache'],
};
pkg.engines = {
  node: '>=18.0.0',
};

fs.writeFileSync(process.env.PUBLISH_PKG_PATH, JSON.stringify(pkg, null, 2) + '\n');
EOF

  assert_no_workspace_in_manifest "$PUBLISH_PKG_PATH"

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
  validate_workspace_publish_plan
  publish_shared_npm
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
