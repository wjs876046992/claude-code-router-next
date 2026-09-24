# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

> **Note**: See `AGENTS.md` for a condensed version of this guide.

## Project Overview

Claude Code Router (`ccr`) is a proxy that routes Claude Code / Codex requests to different LLM providers with request/response transformation, fallback, health monitoring, and a web management UI.

## Monorepo Structure & Dependency Chain

```
cli → core → shared
server (facade over core, re-exports everything)
ui (standalone React + Vite, bundled to single index.html)
docs (Docusaurus site)

Build order: shared → core → server → cli → ui
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
pnpm dev:core       # same as dev:server — both run @wengine-ai/llms (nodemon)
pnpm dev:ui         # Vite dev server for UI
```

⚠️ `pnpm dev:cli` is currently broken: the root script filters `@wengine-ai/claude-code-router-cli`, but the CLI package is named `@wengine-ai/claude-code-router-next`. Build the CLI instead (`pnpm build:cli`) and run `ccr` from `packages/cli/dist/cli.js`.

**Build order matters**: `shared` must build before `core`. `core` must build before `server` or `cli`. `build:cli` is self-contained (builds shared + core + UI internally), so don't use it if you only changed core — use `build:core` instead.

**CLI bundles core via esbuild alias**: `@wengine-ai/llms` is aliased to `../core/dist/cjs/server.cjs`. The CLI always uses the CJS output of core.

## Testing

Tests use **vitest** in `core` and `shared` only. No tests exist for cli, server, or ui packages.

```bash
pnpm --filter @wengine-ai/llms test                      # core tests
pnpm --filter @wengine-ai/claude-code-router-shared test # shared tests

# Single test file (run from the package dir):
cd packages/core && npx vitest run src/__tests__/hook-order.test.ts
```

Both packages' vitest configs pin `CCR_CONFIG_DIR` to a temp dir via the `env` option, so tests never touch `~/.claude-code-router`. Tests live at `src/__tests__/**/*.test.ts`.

**CI only runs `pnpm build`** — there is no test or lint step in the GitHub Actions workflow. Run tests locally before pushing.

## Core Architecture

### Request Pipeline (deterministic hook order)

Registered by `createCcrServer` via `registerRequestPipeline()` (`packages/core/src/ccr/request-pipeline.ts`); the namespace's single ordered preHandler dispatcher lives in `packages/core/src/server.ts` `Server.registerNamespace()`. The pipeline applies to `/v1/messages` and `/v1/responses`:

```
Client → [1. onRequest] → [2. request-normalize] → [3. adapter] → [4. auth-client] 
       → [5. agent] → [6. router] → [7. provider-model-normalize] → [8. handler] 
       → [9. onSend] → [10. onResponse] → Client
```

1. **onRequest**: request timing (`requestStartTime`)
2. **request-normalize**: Normalize body, set defaults (`stream: false`), normalize Responses API `input` → `messages`
3. **adapter**: `applyClientAdapter()` detects client type (claude-code, zcode, pi, qwen-code, opencode, codex) and builds `req.clientContext` (usage scope, session/project id)
4. **auth-client**: API key auth + client context injection
5. **agent**: Agent mutation (e.g., imageAgent tool injection)
6. **router**: Scenario-based model selection (default/background/think/longContext/webSearch/image)
7. **provider-model-normalize**: Split `provider,model` string, set `req.provider` and `req.model`
8. **handler**: `handleTransformerEndpoint` (`packages/core/src/api/routes.ts`) — applies transformers, forwards to upstream provider. Endpoints are derived from each transformer's `endPoint` property (anthropic → `/v1/messages`, openai → `/v1/chat/completions`, openai.responses → `/v1/responses`)
9. **onSend**: Agent tool rewrite, usage/upstream-model capture (streams are tee'd; the clone is read in the background)
10. **onResponse**: TTFT/speed/health recording, final usage append to SQLite (`~/.claude-code-router/data/usage.sqlite` via better-sqlite3)

API-key auth also runs globally for non-`/v1/messages` routes (admin/management endpoints), since the namespace dispatcher only handles the LLM endpoints.

### Routing System (`packages/core/src/utils/router.ts`)

Routing priority (highest to lowest):
1. **Family routing** (`enableFamilyRouting`): Maps model tiers (opus/sonnet/haiku) to provider-specific models; also handles `ccr-*[1m]` extended-context aliases
2. **Project-level routing**: per-project `Router` stored at `~/.claude-code-router/<project-id>/config.json` (project id = path with `/.\` → `-`, via `getClaudeProjectId`). Session discovery: Claude Code sessions resolved by scanning `~/.claude/projects` transcripts; managed clients use the `x-ccr-project` header; ZCode uses its local task index (`~/.zcode/v2/tasks-index.sqlite`) and is opt-in per project via takeover state. Strict mode: managed project failures throw `ProjectRoutingError` instead of falling back to global. Per-session overrides: `<project-id>/<session-id>.json`
3. **Custom router**: `CUSTOM_ROUTER_PATH` — external JS module exporting `async function router(req, config)`
4. **Scenario routing**: `background`, `think`, `longContext` (token threshold), `webSearch`, `image`
5. **Default routing**: `Router.default`

Token calculation uses `tiktoken` (cl100k_base) for request size estimation and `@huggingface/tokenizers` for the tokenizer service.

### Transformer System (`packages/core/src/services/transformer.ts`, `packages/core/src/transformer/`)

Transformers adapt requests/responses to different provider APIs. Interface in `packages/core/src/types/transformer.ts`: hooks are `transformRequestIn`/`transformRequestOut` (request → unified format), `transformResponseIn`/`transformResponseOut` (upstream `Response` → unified → client), plus `endPoint` (registers the HTTP route served by this transformer) and `auth`.

**Transformer catalog** (`packages/core/src/transformer/*.transformer.ts`):
- **Protocol transformers** (define `endPoint`): `anthropic` (`/v1/messages`), `openai` (`/v1/chat/completions`), `openai.responses` (`/v1/responses`)
- **Provider transformers**: `deepseek`, `gemini`, `openrouter`, `groq`, `kimi`, `cerebras`, `opencode`, `vercel`, `vertex-claude`, `vertex-gemini`
- **Request modifiers**: `maxtoken`, `maxcompletiontokens`, `tooluse`, `reasoning`, `forcereasoning`, `defaultthinking`, `enhancetool`, `customparams`, `sampling`, `streamoptions`, `cleancache`

Configuration supports global (provider-level) and model-specific application, plus option passing via nested arrays.

### Agent System (`packages/core/src/ccr/agents/`)

Pluggable modules with `shouldHandle`, `reqHandler`, and `tools` methods. Built-in: `imageAgent`. Agent tool calls are intercepted in the `onSend` hook, executed, and new LLM requests are initiated to stream results back. Agent tools are injected into the request during the `agent` pipeline hook.

### SSE Stream Processing (`packages/core/src/utils/sse/`)

- `SSEParserTransform`: Parses SSE text → event objects
- `SSESerializerTransform`: Serializes event objects → SSE text
- `rewriteStream`: Intercepts/modifies stream data (agent tool calls)

Streams are tee'd in `onSend` for usage capture; the clone is read in background to avoid blocking the client.

### Health & Fallback (`packages/core/src/services/provider-health.ts`)

Health states: `closed` (healthy) → `open` (failed, auto-skip) → `half-open` (recovering). After 3 consecutive failures, model enters `open` state. Fallback promotion temporarily "promotes" a working fallback model (TTL 10 min). Auto-recovery probe runs every 5 minutes.

Health data is persisted and reconciled on startup via `health-reconcile.ts`.

### Configuration (`packages/core/src/ccr/config.ts`)

Location: `~/.claude-code-router/config.json` (JSON5 with env var interpolation `$VAR_NAME`/`${VAR_NAME}`). Every write snapshots the previous config into `~/.claude-code-router/config-history/` with a timestamped name. Hot reload requires `ccr restart`.

Config structure: `providers[]`, `Router` (default/background/think/longContext/webSearch/image), `transformers[]`, `HOST`, `PORT`, `APIKEY`, plus optional `CUSTOM_ROUTER_PATH`, `familyRouting`, etc.

Path constants live in `packages/shared/src/constants.ts` and are easy to confuse:
- `HOME_DIR` = `CCR_CONFIG_DIR` env or `~/.claude-code-router` — **follows the active profile**; most per-runtime state (config, presets, usage DB, pid file) resolves from it
- `BASE_DIR` = always `~/.claude-code-router` — used for cross-profile shared state (logs, plugins) and profile management (`profiles/`, `active-profile`) so profiles never nest inside each other

### Configuration Profiles (`packages/shared/src/profile.ts`, `packages/cli/src/utils/profile-commands.ts`)

Named profiles give each `CCR_CONFIG_DIR` its own config, presets, usage DB, and port. Commands: `ccr profile list|create|switch|delete|show`. `switch` restarts the server with the profile's `CCR_CONFIG_DIR`. Profile names: alphanumeric + `-`/`_`, max 64 chars.

### Logging

Two systems:
- **Server-level** (pino): `~/.claude-code-router/logs/ccr-*.log` — HTTP requests, API calls
- **Application-level**: `~/.claude-code-router/claude-code-router.log` — routing decisions, business logic

### Client Adapters (`packages/core/src/clients/adapters.ts`)

Adapter registry keyed by `ClientType` (`claude-code`, `zcode`, `pi`, `qwen-code`, `opencode`, `codex`, `api`, `unknown`). Each adapter implements `createContext(req, config)` which detects the client from headers/body shape (e.g. `User-Agent: ZCode/...`, `metadata.user_id`, Codex `session_id`) and returns a `ClientContext`: `usageScope` (`session` vs `request` — controls whether usage is cached across requests for longContext thresholding), `stableSessionId`, `projectId`, and extended-context support flags.

### Project Takeover (`packages/shared/src/client-integrations.ts`, `projectConfig.ts`)

Per-project Router overrides are managed via "takeover": CCR writes its endpoint into each client's settings file (e.g. `~/.claude/settings.json`), recording what it wrote in `~/.claude-code-router/client-state.json` so it can distinguish its own values from user edits. Per-project takeover markers live in `~/.claude-code-router/<project-id>/takeover-clients.json`. `buildProjectTakeoverConfig()` (global settings + project Router) is the single source shared by takeover and `ccr code` session env.

### Plugin System (`packages/core/src/plugins/`)

Plugins extend functionality via `PluginManager`. Built-in: `token-speed` (tracks generation speed). Plugin output goes to `~/.claude-code-router/plugins/output/`. Interface: `shouldHandle`, `reqHandler`, `tools` methods (similar to agents).

### Services (`packages/core/src/services/`)

Key services: `ConfigService`, `ProviderService`, `TransformerService`, `TokenizerService`, `ActiveProbeService` (health/quota probing), `ProxyService` (per-provider proxy control), `RateLimitService`, `QuotaStore`.

## Subagent Routing

Use special tags in subagent prompts to specify models:
```
<CCR-SUBAGENT-MODEL>provider,model</CCR-SUBAGENT-MODEL>
Please help me analyze this code...
```

This is useful for routing specific tasks to specialized models (e.g., code review to a thinking model, quick fixes to a fast model).

## Preset System

Presets stored in `~/.claude-code-router/presets/<preset-name>/manifest.json` (resolved from `HOME_DIR`, so they are per-profile). Core logic in `packages/shared/src/preset/` (export, install, merge, sensitiveFields, schema). CLI wrappers in `packages/cli/src/utils/preset/`. Each preset is served as its own API namespace at `/preset/<name>/v1/messages` — `Server.registerNamespace(name, config)` builds isolated ConfigService/TransformerService/ProviderService instances per namespace.

## Development Notes

1. **CCR service management**: Always use `ccr restart` instead of `ccr stop` + `ccr start`. Stopping interrupts all active LLM routing.
2. **Node.js version**: Requires >= 20.0.0
3. **Package manager**: pnpm (workspace protocol for inter-package deps)
4. **TypeScript**: All packages use TS; UI is ESM module. Shared tsconfig at `tsconfig.base.json` (target ES2022, module CommonJS).
5. **Path alias `@/`**: Maps to `src/` in both `core` (via esbuild plugin) and `ui` (via Vite resolve alias).
6. **Code comments**: All comments MUST be written in English.
7. **Documentation**: Add to `docs/` project (Docusaurus), not standalone md files. Build with `pnpm build:docs`, dev with `pnpm dev:docs`.
8. **No lint/format in CI**: Individual packages have lint scripts but they're not wired into CI. No unified format command.
9. **`workspace:*` protocol**: Used for inter-package deps. Release script rewrites to real version ranges before publishing.

## Common Tasks

### Adding a new transformer
1. Create `packages/core/src/transformer/<name>.transformer.ts`
2. Implement `Transformer` interface (see `packages/core/src/types/transformer.ts`)
3. Register in `packages/core/src/transformer/index.ts`
4. If it defines an endpoint, ensure the route is served in `handleTransformerEndpoint` (`packages/core/src/api/routes.ts`)

### Adding a new client adapter
1. Add `ClientType` to `packages/core/src/clients/adapters.ts`
2. Implement `createContext(req, config)` to detect client and return `ClientContext`
3. Register in the adapter registry

### Debugging routing decisions
Application logs at `~/.claude-code-router/claude-code-router.log` show routing decisions. Set `DEBUG=ccr:*` for verbose output.

## Changelog & Release Notes Convention

Three places must stay consistent:

1. **`CHANGELOG.md`**: Complete, detailed changelog (Keep a Changelog style). Every version recorded permanently — never trim.
2. **`README.md` / `README_en.md` changelog tables**: Bilingual summary, keeps **only latest 10 versions**.
3. **`CHANGELOG-archive.md`**: Overflow when README exceeds 10 rows.

**Release checklist**: Bump `version` in all 6 `package.json` files (root + 5 packages) to same value, prepend section to `CHANGELOG.md`, add top row to both README tables, move oldest to archive if >10 rows.

**Automated gate**: `scripts/release.sh` validates before publishing (including dry-run): all 6 versions match, CHANGELOG has section, READMEs have row, version > npm latest (numeric compare).

### Version numbering

Daily iterations extend patch segment with extra digit (`2.3.23` → `2.3.231` → `2.3.232`). Patch compares numerically, so `2.3.24` after `2.3.231` is a downgrade and rejected. Next feature version: `2.3.240` or `2.4.0`. Stable releases must not carry pre-release suffixes.

**Examples**: `2.3.23` → `2.3.231` (daily iteration) → `2.3.240` (feature) → `2.3.2401` (daily) → `2.4.0` (feature) → `2.4.1` (patch fix)

## Update System & API Conventions

- UI `ApiClient` (`packages/ui/src/lib/api.ts`) uses `/api` as `baseUrl`. Endpoint args must be relative (`/update/check`, not `/api/update/check`).
- CLI registers update routes as `GET /api/update/check` and `POST /api/update/perform` in `packages/cli/src/utils/index.ts`.
- `checkForUpdates` must return non-empty changelog when newer version available (reads from published npm README, falls back to GitHub CHANGELOG.md).
- `packages/cli/README.md` and `packages/core/README.md` are release-time copies generated by `scripts/release.sh`. Treat root `README.md` and `CHANGELOG.md` as source of truth.

## Tech Stack Highlights

- **Fastify** — HTTP server framework
- **better-sqlite3** — Usage tracking database (`~/.claude-code-router/data/usage.sqlite`)
- **tiktoken** / **@huggingface/tokenizers** — Token counting
- **esbuild** — CLI bundling (with alias for core)
- **Vite** + **React 19** + **Tailwind CSS 4** + **Radix UI** — UI stack
- **vite-plugin-singlefile** — Bundles UI to single `index.html`
- **vitest** — Testing (core + shared only)
- **Docusaurus** — Documentation site (`docs/`)

## CLI Command Surface (`packages/cli/src/cli.ts`)

`ccr start|stop|restart|status|statusline|code|model|preset|profile|install|clients|activate|ui`. Notable:
- `ccr code` runs Claude Code with session env derived from the **effective** config (global settings + current project's Router via `readProjectConfig`/`buildProjectTakeoverConfig`), including context-window caps and family aliases — the same computation as project takeover.
- `ccr model --project` configures routing for the current project only (writes `<project-id>/config.json`).
- The CLI adds `/api/restart`, `/api/update/check`, `/api/update/perform` routes on top of core's admin routes.
- Root `ccr <preset-name>` serves that preset's namespace.
- `ccr -v` / `ccr --version` — Show version.

## Quick Reference

| Task | Command |
|------|---------|
| Build all | `pnpm build` |
| Build one package | `pnpm build:core` (or `:shared`, `:cli`, `:ui`, `:server`) |
| Run core tests | `pnpm --filter @wengine-ai/llms test` |
| Run shared tests | `pnpm --filter @wengine-ai/claude-code-router-shared test` |
| Single test file | `cd packages/core && npx vitest run src/__tests__/<file>.test.ts` |
| Dev server | `pnpm dev:core` |
| Dev UI | `pnpm dev:ui` |
| Restart CCR | `ccr restart` |
| Release | `pnpm release` (or `PUBLISH_DRY_RUN=1 pnpm release` for dry run) |

## .mimocode Directory

The `.mimocode/` directory contains configuration for the mimocode AI assistant plugin (`@mimo-ai/plugin`). It is not part of the application source.

**Contents:**
- `command/create-agents-md.md` — Command template for generating/updating `AGENTS.md`. Describes the investigation methodology (read manifests → build config → CI workflows → existing instruction files → representative code) and writing rules (high-signal, repo-specific only; exclude generic advice).
- `plans/1784703009846-clever-star.md` — Implementation plan for **Named Configuration Profiles** (`ccr profile` CLI commands, per-profile `CCR_CONFIG_DIR` isolation). Now implemented — see Configuration Profiles above; the plan is historical reference.
- `.cron-lock` — Tracks a running mimocode cron process (PID + start time).
- `package.json` — Declares `@mimo-ai/plugin` dependency.
