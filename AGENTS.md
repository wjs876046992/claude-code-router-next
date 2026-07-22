# AGENTS.md

Agent guidance for working in this repository. See also `CLAUDE.md` for detailed architecture and release conventions.

## Repository at a glance

Monorepo managed by pnpm workspaces. Five packages under `packages/` plus a Docusaurus docs site:

| Package | npm name | Role |
|---------|----------|------|
| `packages/core` | `@wengine-ai/llms` | **All runtime logic** — Fastify server, routing, transformers, agents, config. This is where real work happens. |
| `packages/cli` | `@wengine-ai/claude-code-router-next` | CLI entry (`ccr` command). Bundles core via esbuild; no server runtime of its own. |
| `packages/server` | `@wengine-ai/claude-code-router-server` | Thin facade — re-exports everything from `@wengine-ai/llms`. Never add logic here. |
| `packages/shared` | `@wengine-ai/claude-code-router-shared` | Constants, preset system, shared utilities. |
| `packages/ui` | `@wengine-ai/claude-code-router-ui` | React + Vite web UI. Bundled to a single `index.html` via `vite-plugin-singlefile`. Private (not published). |
| `docs/` | `claude-code-router-docs` | Docusaurus documentation site. |

Dependency chain: `cli → core → shared`. The `server` package is a facade over `core`.

## Build commands

**Build everything** (respects order: shared → core → server → cli → ui):
```bash
pnpm build
```

**Build a single package** — use the root scripts. Do NOT run `pnpm build` inside a package directory (some packages delegate to root `scripts/build-*.js`):
```bash
pnpm build:shared
pnpm build:core
pnpm build:server
pnpm build:cli
pnpm build:ui
```

**Build order matters**: `shared` must build before `core`. `core` must build before `server` or `cli`. The `build:cli` script internally builds shared + core + UI, so it's self-contained. The `build:ui` script also copies `index.html` into `cli/dist` and `core/dist` if those directories exist.

**Dev servers**:
```bash
pnpm dev:core    # or pnpm dev:server — same thing, both run @wengine-ai/llms
pnpm dev:ui      # Vite dev server for UI
pnpm dev:cli     # ts-node for CLI
```

## Testing

Tests use **vitest** in `core` and `shared` only. No tests exist for cli, server, or ui packages.

```bash
pnpm --filter @wengine-ai/llms test                    # core tests
pnpm --filter @wengine-ai/claude-code-router-shared test # shared tests
```

Both packages have a `globalSetup` that creates a temp config directory (`CCR_CONFIG_DIR`) so tests never touch `~/.claude-code-router`. Tests live at `src/__tests__/**/*.test.ts`.

**CI only runs `pnpm build`** — there is no test or lint step in the GitHub Actions workflow. Run tests locally before pushing.

## Key gotchas

- **`build:cli` rebuilds everything**: It internally runs build-shared, build-core, and build-ui before building the CLI. Don't run `build:cli` if you only changed core — use `build:core` instead and rebuild cli only when needed.
- **`build:server` needs core built first**: It checks for `packages/core/dist/server.d.ts` and auto-builds core if missing.
- **UI is a single HTML file**: `vite-plugin-singlefile` inlines all JS/CSS. The output `index.html` is copied to `cli/dist` during cli build. Editing UI requires a rebuild to see changes served by `ccr`.
- **CLI bundles core via esbuild alias**: `@wengine-ai/llms` is aliased to `../core/dist/cjs/server.cjs` in the CLI esbuild config. This means the CLI always uses the CJS output of core.
- **`dev:core` and `dev:server` are identical**: Both filter to `@wengine-ai/llms`.
- **No lint or format step in CI or root scripts**: There's no unified lint/format command. Individual packages have their own lint scripts but they're not wired into CI.

## Conventions

- **All code comments must be in English** (hard requirement per CLAUDE.md).
- **Trunk-based development**: PRs go to `main`. No `dev` branch.
- **Conventional Commits**: `fix:`, `feat:`, `docs:`, `chore:`, etc.
- **Path alias `@/`**: Maps to `src/` in both `core` (via esbuild plugin) and `ui` (via Vite resolve alias).
- **Config file**: `~/.claude-code-router/config.json` (JSON5 with env var interpolation).
- **`workspace:*` protocol**: Used for inter-package dependencies. The release script rewrites these to real version ranges before publishing.

## Release

```bash
pnpm release          # build + publish npm + docker
pnpm release:npm      # npm only
PUBLISH_DRY_RUN=1 pnpm release  # validate without publishing
```

The release gate (`scripts/release.sh`) validates: all 6 `package.json` versions match, CHANGELOG.md has a section for the version, both README tables have the version row, and the version is strictly greater than the latest published on npm.

Version must be bumped in **all 6** `package.json` files (root + 5 packages) before releasing. See CLAUDE.md for the full release checklist and version numbering rules.
