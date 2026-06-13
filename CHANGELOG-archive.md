# 历史版本变更记录 / Release Notes Archive

本文档归档 `README.md` / `README_en.md` 变更日志表格中超出「最近 10 个版本」范围的更早版本摘要。完整、详细的变更记录请见 [CHANGELOG.md](./CHANGELOG.md)。

This document archives the older release summaries that fall outside the "latest 10 versions" kept in the `README.md` / `README_en.md` changelog tables. For the full, detailed changelog, see [CHANGELOG.md](./CHANGELOG.md).

## 中文

| 版本 | 发布内容 |
| --- | --- |
| **v2.1.26** | <ul><li>**修复 Anthropic Transformer URI 覆盖问题**：当 `Anthropic` 与 DeepSeek/OpenAI 兼容提供商组合使用时，不再把 `chat/completions` 端点错误改写为 `/v1/messages`，避免 DeepSeek 返回 404。</li><li>**协议转换边界收紧**：仅当 provider 的 `api_base_url` 明确指向 `/messages` 端点时，才将请求体转换为 Anthropic messages 结构。</li></ul> |
| **v2.1.25** | <ul><li>**修复新版 Claude Code (v2.1.154+) 422 报错**：完美解决请求 `/v1/messages` 兼容提供商时因 messages 数组中包含 `role: "system"` 造成的 400/422 报错。</li><li>**动态 Passthrough 绕过自愈**：强制拦截带有 system 消息的 Anthropic 兼容提供商透传，自动进行双向协议规范化与 system 字段合并。</li><li>**响应无损透传修复**：支持目标为 Anthropic 协议响应的原样直出，解决了第三方接口转发时“请求成功但无数据返回”的重大漏洞。</li></ul> |
| **v2.1.22** | <ul><li>**提供商定时唤醒功能 (定时唤醒)**：新增通用及提供商级别的清晨定时自动重置/唤醒机制，通过发送 dummy 消息提前激活额度。</li><li>**对称用量展示面板**：将 Web 控制台的用量统计网格从 8 张卡片升级为更美观对称的 10 卡片布局。</li><li>**高级用量指标统计**：新增对缓存命中率 (Cache Hit Rate) 及生成速度 (Average Speed) 的多维度计算与动态展示。</li></ul> |
| **v2.1.7** | <ul><li>**Gemini 思考模式签名支持**：完美支持 Gemini 思考模式 (thinking mode) 及思维链签名 (thought_signature)，防止转发时出现 400 校验异常并拦截 API Key 泄露。</li><li>**系统级调试日志面板**：引入运行时一键切换的系统调试日志，与 Web 控制台深度集成，提供实时请求响应细节。</li></ul> |
| **v2.1.2** | <ul><li>**状态栏 Token 缓存计数**：支持 CLI 状态栏 (statusline) 中的 Token 计数正确显示缓存命中详情，并在响应速度及文字格式上完成多项优化。</li></ul> |
| **v2.0.87** | <ul><li>**Web 控制台额度支持**：正式打通并适配智谱 GLM 与百炼 Qwen 等主流渠道的额度使用详情实时分析。</li><li>**健康失败记录优化**：修复 HTTP 429 速率限制请求在健康监测系统中未被记录为失败并导致熔断延迟的 Bug。</li></ul> |

## English

| Version | Release Details |
| --- | --- |
| **v2.1.26** | <ul><li>**Fix Anthropic Transformer URI Override**: When `Anthropic` is combined with DeepSeek/OpenAI-compatible providers, it no longer rewrites `chat/completions` endpoints to `/v1/messages`, preventing DeepSeek 404 responses.</li><li>**Tighter Protocol Conversion Boundary**: Request bodies are converted to Anthropic messages format only when the provider `api_base_url` explicitly points to a `/messages` endpoint.</li></ul> |
| **v2.1.25** | <ul><li>**Fix Claude Code (v2.1.154+) 422 Error**: Solves the 400/422 validation errors when calling Anthropic-compatible `/v1/messages` target providers due to `role: "system"` appearing in the messages array.</li><li>**Self-Healing Passthrough Protection**: Blocks passthrough bypass for requests containing system messages, enforcing symmetric protocol normalization and system parameter extraction.</li><li>**Response Passthrough Fix**: Passes original Anthropic-compatible responses through unchanged, resolving the issue where requests succeeded but returned empty/no content.</li></ul> |
| **v2.1.22** | <ul><li>**Provider Scheduled Wake-up**: Introduces a global and provider-level scheduled reset/wake-up mechanism to activate provider quotas early in the morning by sending dummy requests.</li><li>**Symmetric Web UI Grid**: Upgraded the usage statistics grid on the dashboard from 8 cards to a symmetric 10-card layout.</li><li>**Advanced Usage Metrics**: Added real-time displays and calculations for Cache Hit Rate and Average Speed (tok/s).</li></ul> |
| **v2.1.7** | <ul><li>**Gemini Thinking Mode & Signature Support**: Cleanly supports Gemini thinking mode and handles thought signatures, preventing 400 validation failures and blocking API key leaks.</li><li>**Runtime Debug Logging**: Introduced a system debug logging system with one-click toggles and Web UI integration for easier troubleshooting.</li></ul> |
| **v2.1.2** | <ul><li>**Status Bar Cache Tokens**: Fixed the CLI statusline token count display to correctly account for cache hits, and implemented multiple visual/speed optimizations.</li></ul> |
| **v2.0.87** | <ul><li>**Web Console Quota Display**: Fully integrated and displayed real-time Web console quota usage details for Zhipu GLM and Aliyun Qwen.</li><li>**Health Store Failure Tracking**: Correctly recorded HTTP 429 Rate Limit responses as health check failures to trigger fallback mechanism early.</li></ul> |
