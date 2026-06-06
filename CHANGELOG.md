# Changelog

All notable changes to this project will be documented in this file.

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
