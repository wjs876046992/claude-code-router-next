# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Claude Code Router (`ccr`) is a proxy that routes Claude Code / Codex requests to different LLM providers with request/response transformation, fallback, health monitoring, and a web management UI.

## Monorepo Structure & Dependency Chain

```
cli → core → shared
server (facade over core, re-exports everything)
ui (standalone React + Vite, bundled to single index.html)
docs (Docusaurus site)
```

| Package | npm name | Role |
|---------|----------|------|
| `packages/core` | `@wengine-ai/llms` | **All runtime logic** — Fastify server, routing, transformers, agents, config, health, quota, proxy. This is where real work happens. |
| `packages/cli` | `@wengine-ai/claude-code-router-next` | CLI entry (`ccr` command). Bundles core via esbuild; no server runtime of its own. |
| `packages/server` | `@wengine-ai/claude-code-router-server` | Thin facade — re-exports everything from `@wengine-ai/llms`. **Never add logic here.** |
| `packages/shared` | `@wengine-ai/claude-code-router-shared` | Constants, preset system, shared utilities. |
| `packages/ui` | `@wengine-ai/claude-code-router-ui` | React + Vite web UI. Private (not published). Bundled to single `index.html` via `vite-plugin-singlefile`. |

## Build & Dev Commands

```bash
# Build everything (order: shared → core → server → cli → ui)
pnpm build

# Build individual packages (use root scripts, NOT package-level pnpm build)
pnpm build:shared
pnpm build:core
pnpm build:server
pnpm build:cli      # also rebuilds shared + core + UI internally
pnpm build:ui       # also copies index.html to cli/dist and core/dist

# Dev servers
pnpm dev:core       # same as dev:server — both run @wengine-ai/llms
pnpm dev:ui         # Vite dev server for UI
pnpm dev:cli        # ts-node for CLI
```

**Build order matters**: `shared` must build before `core`. `core` must build before `server` or `cli`. `build:cli` is self-contained (builds shared + core + UI internally), so don't use it if you only changed core — use `build:core` instead.

**CLI bundles core via esbuild alias**: `@wengine-ai/llms` is aliased to `../core/dist/cjs/server.cjs`. The CLI always uses the CJS output of core.

## Testing

Tests use **vitest** in `core` and `shared` only. No tests exist for cli, server, or ui packages.

```bash
pnpm --filter @wengine-ai/llms test                    # core tests
pnpm --filter @wengine-ai/claude-code-router-shared test # shared tests
```

Both packages have a `globalSetup` that creates a temp `CCR_CONFIG_DIR` so tests never touch `~/.claude-code-router`. Tests live at `src/__tests__/**/*.test.ts`.

**CI only runs `pnpm build`** — there is no test or lint step in the GitHub Actions workflow. Run tests locally before pushing.

## Core Architecture

### Request Pipeline (deterministic hook order)

The pipeline is registered in `packages/core/src/ccr/request-pipeline.ts` and executed via Fastify hooks in `Server.registerNamespace()`:

1. **request-normalize**: Normalize body, set defaults (`stream: false`)
2. **adapter**: `applyClientAdapter()` detects client type (Claude Code, Codex, pi, qwen-code, opencode) and adjusts request format
3. **auth-client**: API key auth + client context injection
4. **agent**: Agent mutation (e.g., imageAgent tool injection)
5. **router**: Scenario-based model selection (default/background/think/longContext/webSearch/image)
6. **provider-model-normalize**: Split `provider,model` string, set `req.provider` and `req.model`
7. **handler**: `handleTransformerEndpoint` — applies transformers, forwards to upstream provider
8. **onSend**: Agent tool rewrite, usage/upstream-model capture
9. **onResponse**: TTFT/speed/health recording, final usage append

### Routing System (`packages/core/src/utils/router.ts`)

Routing priority (highest to lowest):
1. **Family routing** (`enableFamilyRouting`): Maps model tiers (opus/sonnet/haiku) to provider-specific models
2. **Project-level routing**: `~/.claude/projects/<project-id>/claude-code-router.json` — strict mode: failures throw `ProjectRoutingError` instead of falling back to global
3. **Custom router**: `CUSTOM_ROUTER_PATH` — external JS module exporting `async function router(req, config)`
4. **Scenario routing**: `background`, `think`, `longContext` (token threshold), `webSearch`, `image`
5. **Default routing**: `Router.default`

Token calculation uses `tiktoken` (cl100k_base) for request size estimation and `@huggingface/tokenizers` for the tokenizer service.

### Transformer System (`packages/core/src/services/transformer.ts`)

Transformers adapt requests/responses to different provider APIs. Provided by `@wengine-ai/llms` with built-in transformers: `anthropic`, `deepseek`, `gemini`, `openrouter`, `groq`, `maxtoken`, `tooluse`, `reasoning`, `enhancetool`, `cleancache`, `vertex-gemini`, etc.

Configuration supports global (provider-level) and model-specific application, plus option passing via nested arrays.

### Agent System (`packages/core/src/ccr/agents/`)

Pluggable modules with `shouldHandle`, `reqHandler`, and `tools` methods. Built-in: `imageAgent`. Agent tool calls are intercepted in the `onSend` hook, executed, and new LLM requests are initiated to stream results back.

### SSE Stream Processing (`packages/core/src/utils/sse/`)

- `SSEParserTransform`: Parses SSE text → event objects
- `SSESerializerTransform`: Serializes event objects → SSE text
- `rewriteStream`: Intercepts/modifies stream data (agent tool calls)

### Health & Fallback (`packages/core/src/services/provider-health.ts`)

Health states: `closed` (healthy) → `open` (failed, auto-skip) → `half-open` (recovering). After 3 consecutive failures, model enters `open` state. Fallback promotion temporarily "promotes" a working fallback model (TTL 10 min). Auto-recovery probe runs every 5 minutes.

### Configuration (`packages/core/src/ccr/config.ts`)

Location: `~/.claude-code-router/config.json` (JSON5 with env var interpolation `$VAR_NAME`/`${VAR_NAME}`). Automatic backups (last 3). Hot reload requires `ccr restart`.

### Logging

Two systems:
- **Server-level** (pino): `~/.claude-code-router/logs/ccr-*.log` — HTTP requests, API calls
- **Application-level**: `~/.claude-code-router/claude-code-router.log` — routing decisions, business logic

### Client Adapters (`packages/core/src/clients/adapters.ts`)

Runtime adapter layer that normalizes differences between Claude Code, Codex, pi, qwen-code, and opencode clients. Each adapter defines `transformRequest`, `transformResponse`, and `usageScope`.

### Services (`packages/core/src/services/`)

Key services: `ConfigService`, `ProviderService`, `TransformerService`, `TokenizerService`, `ActiveProbeService` (health/quota probing), `ProxyService` (per-provider proxy control), `RateLimitService`, `QuotaStore`.

## Subagent Routing

Use special tags in subagent prompts to specify models:
```
<CCR-SUBAGENT-MODEL>provider,model</CCR-SUBAGENT-MODEL>
Please help me analyze this code...
```

## Preset System

Presets stored in `~/.claude-code-router/presets/<preset-name>/manifest.json`. Core logic in `packages/shared/src/preset/` (export, install, merge, sensitiveFields, schema). CLI wrappers in `packages/cli/src/utils/preset/`.

## Development Notes

1. **CCR service management**: Always use `ccr restart` instead of `ccr stop` + `ccr start`. Stopping interrupts all active LLM routing.
2. **Node.js version**: Requires >= 20.0.0
3. **Package manager**: pnpm (workspace protocol for inter-package deps)
4. **TypeScript**: All packages use TS; UI is ESM module. Shared tsconfig at `tsconfig.base.json` (target ES2022, module CommonJS).
5. **Path alias `@/`**: Maps to `src/` in both `core` (via esbuild plugin) and `ui` (via Vite resolve alias).
6. **Code comments**: All comments MUST be written in English.
7. **Documentation**: Add to `docs/` project, not standalone md files.
8. **No lint/format in CI**: Individual packages have lint scripts but they're not wired into CI. No unified format command.
9. **`workspace:*` protocol**: Used for inter-package deps. Release script rewrites to real version ranges before publishing.

## Changelog & Release Notes Convention

Three places must stay consistent:

1. **`CHANGELOG.md`**: Complete, detailed changelog (Keep a Changelog style). Every version recorded permanently — never trim.
2. **`README.md` / `README_en.md` changelog tables**: Bilingual summary, keeps **only latest 10 versions**.
3. **`CHANGELOG-archive.md`**: Overflow when README exceeds 10 rows.

**Release checklist**: Bump `version` in all 6 `package.json` files (root + 5 packages) to same value, prepend section to `CHANGELOG.md`, add top row to both README tables, move oldest to archive if >10 rows.

**Automated gate**: `scripts/release.sh` validates before publishing (including dry-run): all 6 versions match, CHANGELOG has section, READMEs have row, version > npm latest (numeric compare).

### Version numbering

Daily iterations extend patch segment with extra digit (`2.3.23` → `2.3.231` → `2.3.232`). Patch compares numerically, so `2.3.24` after `2.3.231` is a downgrade and rejected. Next feature version: `2.3.240` or `2.4.0`. Stable releases must not carry pre-release suffixes.

## Update System & API Conventions

- UI `ApiClient` (`packages/ui/src/lib/api.ts`) uses `/api` as `baseUrl`. Endpoint args must be relative (`/update/check`, not `/api/update/check`).
- CLI registers update routes as `GET /api/update/check` and `POST /api/update/perform` in `packages/cli/src/utils/index.ts`.
- `checkForUpdates` must return non-empty changelog when newer version available (reads from published npm README, falls back to GitHub CHANGELOG.md).
- `packages/cli/README.md` and `packages/core/README.md` are release-time copies generated by `scripts/release.sh`. Treat root `README.md` and `CHANGELOG.md` as source of truth.

## .mimocode Directory

The `.mimocode/` directory contains configuration for the mimocode AI assistant plugin (`@mimo-ai/plugin`). It is not part of the application source.

**Contents:**
- `command/create-agents-md.md` — Command template for generating/updating `AGENTS.md`. Describes the investigation methodology (read manifests → build config → CI workflows → existing instruction files → representative code) and writing rules (high-signal, repo-specific only; exclude generic advice).
- `plans/1784703009846-clever-star.md` — A draft implementation plan for **Named Configuration Profiles** (multi-profile support with `ccr profile` CLI commands, per-profile `CCR_CONFIG_DIR` isolation, concurrent server execution on different ports). This feature has **not been implemented** yet.
- `.cron-lock` — Tracks a running mimocode cron process (PID + start time).
- `package.json` — Declares `@mimo-ai/plugin` dependency.
