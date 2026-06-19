# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

### Fixed

- **忽略已删除模型的残留路由，防止健康池污染**: 运行中从 provider 配置删除某个模型后，路由和 fallback 路径中残留的 `provider,model` 字符串仍会被当作有效候选，反复请求失败后进入健康池（fail pool），导致无关的 fallback 模型也被跳过。现在 `resolveConfiguredModel` 对无法在当前 provider 注册表中匹配到的 `provider,model` 直接返回 `null`，主路由保留客户端原始 model 而非传递失效字符串；fallback 循环在尝试请求前即校验模型是否存在于 provider 配置，跳过不存在的候选；`ProviderHealthStore` 所有公开方法统一在 `getKey` 层拦截空 provider/model，防止 `",model"` 等畸形 key 污染池数据。同时修复 fallback catch 块与成功路径使用不同变量（raw vs canonical）导致 `recordSuccess`/`recordFailure` 可能记录不同 key 的问题；抽取 `findProviderModel` 共用函数消除 `routes.ts` 与 `router.ts` 之间的重复 provider/model 查找逻辑。

## [2.3.16] - 2026-06-18

### Fixed

- **修复 system 消息顺序兼容 DeepSeek/vLLM**: OpenAI 兼容提供商（DeepSeek V4、GLM、vLLM）要求消息按 `[system, user, assistant]` 顺序排列。此前 CCR 在 `routes.ts` 与 `anthropic.transformer.ts` 两处会把 system 消息排在 user/assistant 之后，导致这些上游返回乱码输出。现在统一将 system 消息前置到数组开头并对完全重复的 system 内容去重。

### Added

- **接管时去除 Claude Code Attribution 动态头以提升缓存命中**: CCR 接管 Claude Code 时（`ccr code` 运行时环境、写入全局 `~/.claude/settings.json`、以及项目级 `.claude/settings.local.json` 接管）默认注入 `CLAUDE_CODE_ATTRIBUTION_HEADER=0`，去掉系统提示词开头随每次请求变化的 attribution 头（客户端版本 + prompt fingerprint）。该动态头每条请求都不一样，会破坏上游 prompt-cache 的稳定前缀，导致通过 CCR 网关路由的请求几乎无法命中缓存、每次都重新计费整段上下文。去掉它与本版本的「system 消息前置 + 去重」配合，可在保证 vLLM/DeepSeek/GLM 兼容的同时稳定命中上游 prompt 缓存，显著降低重复请求的 token 用量与延迟。新增顶层配置项 `disableAttributionHeader`（默认开启），可在 Web UI 设置页或配置文件中设为 `false` 关闭；项目级接管会与最大上下文（`CLAUDE_CODE_AUTO_COMPACT_WINDOW`）、自动压缩（`CLAUDE_AUTOCOMPACT_PCT_OVERRIDE`）一并从全局配置继承该设置；关闭接管（全局 `removeClaudeManagedFields` 与项目级 `removeCcrProjectTakeover`）时会自动清理该环境变量。

### Changed

- **设置页布局紧凑化**: Web UI 设置页将「日志级别」下拉从独占整行移入两列网格，与「API 密钥」并排显示，减少页面纵向高度，避免单独半行留白。

## [2.3.15] - 2026-06-17

### Added

- **Fallback 前同模型重试一次（Double-Check）**: 此前模型调用出现一次异常（网络抖动、偶发限流、空 SSE 响应等）就立即切换到备用模型。现在先对同一模型自动重试一次请求，重试成功则正常返回，避免不必要的模型切换；重试仍失败才走原有的 fallback 流程。
- **用量统计显示上游真实模型**: 部分上游网关会在 ccr 不知情的情况下将请求偷偷路由/降级到另一个后端模型（如请求 glm-5 实际返回 MiniMax-M2.5）。用量统计的模型映射显示现在追加上游返回的真实模型，格式为 `originalModel → routedModel → upstreamModel`（如 `ccr-opus → glm-5 → minimax-m2.5`），上游未偷换时与路由模型相同则自动省略。后端在三种响应形态（Anthropic SSE `message_start`、Responses API `response.completed`、非流式 JSON）下捕获上游返回的 model 字段，存入 `usage_records.upstream_model` 列（走 `user_version` v2 迁移，旧库自动 ALTER TABLE 加列）。

## [2.3.14] - 2026-06-16

### Fixed

- **状态栏显示 `<synthetic>` 而非真实模型名**: Claude Code 在 auto-compact 自动压缩、中断恢复等场景会向 transcript 写入 `model: "<synthetic>"` 的合成 assistant 消息（并非真实 LLM 响应）。ccr 状态栏从后往前取「最后一条 assistant 消息的 model」时未排除这类合成消息，导致状态栏模型段直接显示 `<synthetic>`（从 Claude 账号会话切换到 ccr 接管、或发生自动压缩后尤其常见）。现在过滤掉 `<...>` 形式的合成标识，正确显示实际调用的模型名，同时不再把合成消息的 usage 计入 token 统计。

## [2.3.13] - 2026-06-15

### Fixed

- **删除项目配置未清理项目 `settings.local.json`**: 添加项目时会自动启用 ccr takeover，把代理地址、模型族路由环境变量、auto-compact、statusline 等 ccr 托管字段写入项目的 `.claude/settings.local.json`；但删除项目时此前只删除了 `~/.claude-code-router/<project-id>/` 配置目录，未反向清理 `settings.local.json`，导致 ccr 相关配置残留。现在删除项目前会先关闭 takeover，移除这些托管字段。

## [2.3.12] - 2026-06-15

### Fixed

- **定时唤醒未真正触发计费周期**: `wakeupProvider()` 此前使用 `max_tokens: 1` 和 `content: "ping"` 发送极简 dummy 请求，部分 Coding Plan 类提供商（如智谱）会接受请求但不产生实际 token 消耗，导致日额度周期未被激活。现在改用真实推理 prompt 并将 `max_tokens` 提高到 `10`，确保唤醒请求被计入实际使用。
- **Codex 等 `/messages` 端点提供商唤醒 404**: `wakeupProvider()` 此前仅通过 URL 是否包含 `anthropic` 或模型名是否包含 `claude` 判断 Anthropic 协议，Codex 等使用 `gpt-*` 模型但 baseUrl 以 `/messages` 结尾的提供商被误判为 OpenAI 协议，URL 被错误拼接为 `/v1/messages/chat/completions`。现在以 `baseUrl` 是否包含 `/messages` 作为 Anthropic 协议判定依据，且 `baseUrl` 作为完整路径直接使用，不再拼接任何后缀。
- **唤醒/探测请求缺少来源标识**: 为唤醒和独立探测请求增加 `x-claude-code-router-source` 与 `x-claude-code-router-version` 请求头，方便上游服务识别这是 CCR 内部发起的探测/唤醒流量。

## [2.3.11] - 2026-06-14

### Fixed

- **新会话首个请求绕过项目级路由（会话/项目检测竞态）**: 新会话的第一个请求（如 Claude Code 的标题生成元请求，通常比主请求早到约十几毫秒）到达时，对应的 session 转写文件 `~/.claude/projects/<project>/<sessionId>.jsonl` 可能尚未落盘，导致 `searchProjectBySession()` 通过 `stat` 找不到文件、回退到全局 `Router`，使这一个请求绕过项目级路由（例如项目已关闭 `enableFamilyRouting`，却仍走了全局模型族路由）。现在缓存未命中时会进行有限次短延迟重试（最多 3 次、每次 50ms），给文件落盘留出时间；并用 `sessionRetryAttempted` 标记保证每个 session 仅重试一次，避免真正非托管会话的每个请求都被附加延迟。命中后仍只缓存成功结果（保持 v2.3.8 的“不缓存未命中”语义）。

## [2.3.10] - 2026-06-13

### Fixed

- **`thinking: {type: "disabled"}` 误触发 `think` 场景路由**: `resolveFamilyModel()` 与 `getUseModel()` 判断是否进入 `think` 场景时，此前仅检查 `req.body.thinking` 是否存在；但 Claude Code 标题生成等元请求会固定携带 `thinking: {type: "disabled"}`，作为真值对象会被误判为"已开启思考"，导致即使项目关闭了模型族路由（`enableFamilyRouting: false`）也会被路由到全局 `think` 模型。现在仅当 `req.body.thinking?.type === "enabled"` 时才进入 `think` 场景路由。
- **主模型熔断且无可用 fallback 时返回空模型**: `getUseModel()` 此前在 `Router.default` 因健康检查（fail-pool 熔断）不可用、且未启用 fallback 或所有 fallback 均不可用时，直接返回空模型，导致下游抛出合成的 "provider not found" 错误而非真实上游响应。现在会作为最后兜底，跳过健康检查重新尝试 `Router.default`（仍遵循 `enabled: false` 与配额耗尽限制），让请求送达上游获得真实响应，便于 Claude Code 自行重试。

## [2.3.9] - 2026-06-13

### Added

- **Codex 代管理账号令牌自动刷新**: 新增后台调度器（启动 60 秒后首次执行，之后每 30 分钟一次），自动检查所有 Codex 代管理账号——无论是否为当前激活账号——当 `access_token` 距过期不足 24 小时，或自上次刷新已超过 7 天时，使用 `refresh_token` 自动换取新 token 并写回账号存储；若为当前激活账号，同时备份并同步覆盖 `~/.codex/auth.json`。换取前会优先比对 `~/.codex/auth.json` 中是否存在更新的 `last_refresh`（如官方 Codex CLI 自行刷新过），避免用过期的 refresh_token 换取失败。可通过 `Clients.codex.autoRefreshTokens` 关闭（默认开启）。

### Fixed

- **运行时 fallback 重试未遵循项目级 `enableFallback`**: 请求实际发出后失败（如限流）触发的重试 fallback（`handleFallback`）此前直接读取全局 `Router.enableFallback` 与全局顶层 `fallback` 配置，忽略项目级路由的 `enableFallback: false` 与项目自定义的 `Router.fallback`；现在 `router()` 会将解析出的项目级 `enableFallback`/`fallback` 通过请求上下文传递给运行时重试逻辑，确保两处 fallback 判定使用同一份配置。

## [2.3.8] - 2026-06-13

### Added

- **可配置上下文窗口**: 设置页新增 `ContextWindow` 配置项，用于控制 Claude Code / Codex 接管时的自动压缩上下文窗口，默认 `200000` tokens。

### Changed

- **接管配置同步上下文窗口**: Claude Code 接管时根据全局 `ContextWindow` 写入 `CLAUDE_CODE_AUTO_COMPACT_WINDOW`；Codex 接管时写入 `model_context_window` 与 `model_auto_compact_token_limit`（约 90%），确保 CCR 模型别名也能在真实模型溢出前触发自动压缩。

### Fixed

- **项目路由会话识别修复**: 兼容 `metadata.user_id` 为 JSON 字符串（`{"session_id":"..."}`）、对象（`{session_id: "..."}`）和 legacy（`user_..._session_<id>`）三种格式；对 session id 增加安全校验（仅允许 `[A-Za-z0-9_-]+`），防止路径穿越。
- **项目 session 缓存修复**: `searchProjectBySession()` 仅缓存成功命中的 session → project 映射，不再缓存未命中和错误结果，避免 Claude Code 首次请求时 session 文件尚未创建导致项目级路由被长期判定为未命中。
- **关闭模型族路由后别名映射旁路修复**: 当项目 `enableFamilyRouting` 为 `false` 时，`ccr-opus`/`ccr-sonnet`/`ccr-haiku` 等 CCR 注入的族路由别名不再被 `Router.models` 中遗留的别名映射（如接管 Codex 时写入的 `ccr-opus -> <旧 default>`）拦截，正确回退到项目自定义的 scenario 路由（`default`/`background`/`think`/`longContext` 等）。

## [2.3.7] - 2026-06-13

### Fixed

- **项目级 fallback 复制丢失**: 关闭「使用全局配置」自定义项目路由时，正确将全局顶层 `fallback`（全局配置中 `fallback` 是 `Router` 的同级字段）合并进项目 `Router` 的嵌套 `fallback`，避免复制全局配置时丢失备用模型链；同时回填已受影响的存量项目配置。
- **CCR 接管后模型配置不同步**: 切换 CCR 接管开关时，无论是否存在历史备份，都会基于*当前*全局配置重新生成 ccr 托管字段（`ANTHROPIC_BASE_URL`/`ANTHROPIC_AUTH_TOKEN`、模型族路由环境变量、auto-compact、状态栏命令），确保全局配置变更后重新接管能同步最新模型路由，同时保留备份中的 `permissions`/`hooks` 等非托管字段。

### Changed

- **新增项目默认接管并跟随全局**: 在「项目配置」页添加项目时，默认开启「CCR 接管」与「使用全局配置」——自动将 ccr 代理配置写入该项目的 `.claude/settings.local.json`，并保持项目 `Router` 为空以实时跟随全局路由，新项目无需手动操作即可开箱即用（接管写入失败不影响项目添加，返回的 `ccrTakeover` 如实反映结果）。

## [2.3.6] - 2026-06-12

### Added

- **项目级 CCR 接管**: Web UI 项目配置页新增「CCR 接管」开关，开启后会将 `ANTHROPIC_BASE_URL`/`ANTHROPIC_AUTH_TOKEN`、模型族路由环境变量（`ANTHROPIC_DEFAULT_OPUS_MODEL`/`ANTHROPIC_DEFAULT_SONNET_MODEL`/`ANTHROPIC_DEFAULT_HAIKU_MODEL`/`ANTHROPIC_MODEL`/`ANTHROPIC_REASONING_MODEL`）、auto-compact 相关配置（`CLAUDE_CODE_AUTO_COMPACT_WINDOW`/`CLAUDE_AUTOCOMPACT_PCT_OVERRIDE`/`autoCompactEnabled`）以及状态栏 `statusLine: ccr statusline` 同步写入该项目的 `.claude/settings.local.json`，使该项目的 Claude Code CLI 无需 `ccr code` 即可直接通过 CCR 路由，同时保留原有的 `permissions`/`hooks` 等配置。
- **接管开关备份/还原机制**: 关闭接管时会将当前 ccr 管理的配置备份到 `~/.claude-code-router/<project-id>/settings.local.backup.json`，并从 `.claude/settings.local.json` 中移除 ccr 相关字段；重新开启接管时优先恢复备份，没有备份则按当前全局配置重新生成，避免个性化配置丢失。
- **项目配置页改进**: 项目卡片支持折叠/展开；关闭「使用全局配置」后正确同步全局路由的 fallback 与模型族配置；保存/新增项目接口返回结果中包含 `ccrTakeover` 状态，修复保存后接管状态短暂显示为关闭的问题。

## [2.3.5] - 2026-06-10

### Added

- **讯飞 Coding Plan 用量查询**: 支持将讯飞 MaaS 控制台订阅查询页面的 `Cookie` 作为 `quotaToken`，在 Web UI 中自动查询并展示 5h / 7d 限额；该 token 可能会过期，过期后需要重新手动添加。

## [2.3.4] - 2026-06-10

### Fixed

- **Raw config round-trip**: 添加 `readConfigFileRaw()` 读取未插值的原始配置，确保 UI 保存时 `$VAR` 环境变量占位符不被替换；保存/切换/删除 provider 后从服务端重新拉取配置，避免乐观更新导致 UI 状态与服务端不一致；移除 UI 中未使用的 API 方法（`getProviders`、`addProvider` 等）

## [2.3.3] - 2026-06-09

### Fixed

- **状态栏 token 速率上限**: 修复 token 速率显示异常大数字（如 7000）的问题，统一限幅最大 999 t/s；调整速率来源优先级为插件实测值 > SQLite usage 记录 > 累计 token 估算；仅在主题需要 speed 相关变量时才执行 token-speed I/O 和 usage fallback，避免不必要的文件/数据库读取

## [2.3.2] - 2026-06-09

### Fixed

- **状态栏 token 速率显示**: 状态栏支持读取 timestamped token-speed 临时文件，并在 Claude Code 未提供当前输出 token 时回退使用插件记录的 `tokensPerSecond`

## [2.3.1] - 2026-06-08

### Fixed

- **CLI 发布包 Node peer 依赖**: 移除发布包中的 `peerDependencies.node`，只保留 `engines.node`，避免 npm 自动安装 `node` 包导致 `better-sqlite3` 使用错误 Node ABI 编译
- **CLI stale dist 发布风险**: CLI 构建前会清理 `packages/cli/dist`，防止旧的 `dist/index.js`、`dist/package.json` 混入 npm 发布包
- **发布前校验**: `scripts/release.sh` 增加 `PUBLISH_DRY_RUN=1` 和 npm pack preflight，发布前校验必需产物、拒绝 stale dist 文件并确保不会生成 `peerDependencies.node`

## [2.3.0] - 2026-06-08

### Added

- **SQLite 用量存储**: 将本地用量数据从 JSONL 文件迁移到 SQLite 单文件数据库（`~/.claude-code-router/data/usage.sqlite`），提升查询性能和数据管理能力
  - 采用 `better-sqlite3` 嵌入式数据库，对用户透明无感
  - WAL 模式 + 索引优化，支持按时间、供应商、模型、场景、客户端类型等多维度高效查询
  - 自动一次性迁移：首次启动时从旧 `usage.jsonl` 导入历史记录（`INSERT OR IGNORE` 保证幂等），迁移完成后不再重复导入
  - 旧 `usage.jsonl` 保留为备份，不会被删除或截断
- **180 天自动保留策略**: 自动清理超过 180 天的用量记录，在数据库初始化时和定期追加时执行，减少磁盘占用
- **优雅关闭**: 新增 `close()` 函数支持 WAL checkpoint 和数据库连接清理

### Changed

- **数据库 schema 版本管理**: 通过 `PRAGMA user_version` 跟踪 schema 版本，为未来数据库迁移预留扩展路径
- **Docker 构建**: Alpine 镜像增加 `python3`、`make`、`g++`（构建）和 `libstdc++`（运行时）依赖以支持 `better-sqlite3` 原生模块
- **发布包**: CLI 发布依赖新增 `better-sqlite3`，确保用户安装后原生模块可正常解析
- **Usage API 文档**: 新增 `docs/docs/server/api/usage-api.md`，完整记录存储位置、迁移行为、保留策略和 API 端点

### Fixed

- **用量统计浮点精度**: `ttft` 和 `tokensPerSecond` 字段使用 `parseFloat` 替代 `parseInt`，保留小数精度

## [2.2.1] - 2026-06-07

### Fixed

- **Codex 用量统计缺少缓存数据**: 补齐 Responses API 与服务端 usage 归一化链路，正确统计并展示 `cache hit`、`cache creation` 与缓存命中率
  - 兼容 `input_tokens_details.cached_tokens`
  - 兼容 `input_tokens_details.cache_creation_tokens` / `cache_write_tokens`
  - 兼容 `prompt_tokens_details.cached_tokens` / `cache_creation_tokens`
  - 保证流式 `response.completed` 与非流式响应都能写入缓存统计
- **Codex 客户端 TTFT 统计缺失**: `token-speed` 插件补充 `/v1/responses` 监听与 Responses API SSE 事件解析；避免用 `ccr-opus` 等模型族别名判断客户端类型，防止 Claude Code 请求被误判为 Codex 客户端

## [2.2.0] - 2026-06-06

### Added

- **Codex CLI 完整支持**: 通过 Responses API (`/v1/responses`) 协议转换，支持 Codex CLI 接入任意 LLM 提供商
  - Anthropic SSE → Responses API SSE 流式转换（工具调用、文本、推理）
  - OpenAI Chat SSE → Responses API SSE 流式转换
  - 完整的工具调用链路：`response.output_item.added` → `response.function_call_arguments.delta` → `response.function_call_arguments.done` → `response.output_item.done` → `response.completed`
- CCR 模型族别名路由（`ccr-opus`、`ccr-sonnet`、`ccr-haiku`）支持 Codex 请求
- `normalizeResponsesBody`: 自动将 Codex Responses API 请求体转为统一聊天格式
- Codex 客户端检测：支持 User-Agent 和请求路径双重识别
- Codex 账户管理 API (`/api/clients/codex/accounts`)

### Fixed

- **Codex 工具调用不执行**: `response.function_call_arguments.done` 事件使用了错误的 `delta` 字段名，改为符合 OpenAI Responses API 规范的 `arguments` 字段
- **Codex 收到响应但无动作**: Responses API SSE 事件缺少必需字段（`object`、`status`、`output`、`usage`），导致 Codex SDK 无法正确解析响应
- **缺少 `response.output_item.done` 事件**: Codex SDK 需要此事件确认输出项已完成
- **Anthropic SSE 经 `transformResponseOut` 损坏**: 当上游返回 Anthropic SSE 时，`transformResponseOut` 不再尝试转为 Chat 格式，直接透传给 `transformResponseIn` 处理
- **`response.completed` 事件不保证发出**: 添加 `completedEmitted` 标志，在 `message_delta`、`message_stop`、流结束三处保证发出
- UI 设置页面客户端状态显示：接管开关打开时状态显示"已关闭"的问题

## [2.1.38] - 2026-06-06

### Fixed

- 保留 Anthropic 原始响应给 Claude Code 客户端，避免不必要的转换

## [2.1.35] - 2026-06-05

### Fixed

- 修复 macOS 休眠/唤醒后健康探针调度异常
- 改进 Codex 账户管理
