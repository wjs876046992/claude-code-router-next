# Changelog

All notable changes to this project will be documented in this file.

## [2.3.2] - 2026-06-09

### Fixed

- **CLI 发布包 Node peer 依赖**: 移除发布包中的 `peerDependencies.node`，只保留 `engines.node`，避免 npm 自动安装 `node` 包导致 `better-sqlite3` 使用错误 Node ABI 编译
- **CLI stale dist 发布风险**: CLI 构建前会清理 `packages/cli/dist`，防止旧的 `dist/index.js`、`dist/package.json` 混入 npm 发布包
- **发布前校验**: `scripts/release.sh` 增加 `PUBLISH_DRY_RUN=1` 和 npm pack preflight，发布前校验必需产物、拒绝 stale dist 文件并确保不会生成 `peerDependencies.node`
- **状态栏 token 速率显示**: 状态栏支持读取 timestamped token-speed 临时文件，并在 Claude Code 未提供当前输出 token 时回退使用插件记录的 `tokensPerSecond`

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

## [2.1.27] - 2026-06-04

### Fixed

- 修复 DeepSeek 和 GLM API 的 `tool_choice` 错误

## [2.1.26] - 2026-06-04

### Fixed

- 添加缺失的 `/api/providers/health` 端点用于 UI 轮询
- 即使未配置 fallback 也记录健康失败
- 修复 Gemini `thought_signature` 400 错误
- 修复转发到下游提供商时未剥离 thinking signature 的问题

## [2.1.0] - 2026-06-03

### Added

- 用量统计与限额监控
- 状态栏 token 计数优化（包含缓存 token）

### Changed

- 版本号统一管理
