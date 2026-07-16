---
title: 基础配置
sidebar_position: 1
---

# 基础配置

学习如何配置 Claude Code Router 以满足您的需求。

## 配置文件位置

配置文件位于：

```
~/.claude-code-router/config.json
```

## 配置结构

### Providers（提供商）

配置 LLM 提供商以将请求路由到：

```json
{
  "Providers": [
    {
      "name": "deepseek",
      "api_base_url": "https://api.deepseek.com/chat/completions",
      "api_key": "your-api-key",
      "models": ["deepseek-chat", "deepseek-coder"]
    },
    {
      "name": "groq",
      "api_base_url": "https://api.groq.com/openai/v1/chat/completions",
      "api_key": "your-groq-api-key",
      "models": ["llama-3.3-70b-versatile"]
    }
  ]
}
```

### Router（路由器）

配置默认使用的模型：

```json
{
  "Router": {
    "default": "deepseek,deepseek-chat"
  }
}
```

格式：`{provider-name},{model-name}`

### Transformers（转换器）

对请求/响应应用转换：

```json
{
  "transformers": [
    {
      "path": "/path/to/custom-transformer.js",
      "options": {
        "key": "value"
      }
    }
  ]
}
```

### 环境变量

在配置中使用环境变量：

```json
{
  "Providers": [
    {
      "name": "deepseek",
      "api_base_url": "https://api.deepseek.com/chat/completions",
      "api_key": "$DEEPSEEK_API_KEY"
    }
  ]
}
```

同时支持 `$VAR_NAME` 和 `${VAR_NAME}` 语法。

### 代理

CCR 可以通过 HTTP/HTTPS 代理发出出站 API 请求。当您的 provider 仅能通过代理访问时（例如受限网络环境），此功能非常有用。

- **`PROXY_URL`**：代理地址，例如 `"http://127.0.0.1:7890"`。CCR 进程自身通过此地址连接代理端口，无需开启系统代理、TUN 或代理软件的全局模式。
- **`PROXY_GLOBAL_ENABLED`**：控制代理的作用范围（见下表）。

| `PROXY_GLOBAL_ENABLED` | 行为 |
|---|---|
| 未配置或 `true`（默认） | **所有** provider 的出站请求均走 `PROXY_URL`，保持与旧配置的兼容性。 |
| `false` | 仅标记了 `proxy_enabled: true` 的 provider 走代理，其余 provider 直连。 |

补充说明：

- 所有 provider 共用顶层 `PROXY_URL`，不支持为每个 provider 单独设置代理地址。
- 如果 `PROXY_URL` 未设置（空地址），则所有代理开关均不生效，全部直连。
- provider 专属的出站请求（推理、fallback、健康探测、额度查询、wakeup 唤醒、provider API tokenizer 等）均遵循同一 provider 代理策略。

:::warning 安全提示
代理可看到您的 API key 和请求内容，请仅配置可信代理。
:::

按 provider 启用代理的示例：

```json
{
  "PROXY_URL": "http://127.0.0.1:7890",
  "PROXY_GLOBAL_ENABLED": false,
  "Providers": [
    {
      "name": "openrouter",
      "api_base_url": "https://openrouter.ai/api/v1/chat/completions",
      "api_key": "sk-xxx",
      "models": ["anthropic/claude-sonnet-4"],
      "transformer": { "use": ["openrouter"] },
      "proxy_enabled": true
    },
    {
      "name": "ollama",
      "api_base_url": "http://localhost:11434/v1/chat/completions",
      "api_key": "ollama",
      "models": ["qwen2.5-coder:latest"]
    }
  ]
}
```

上例中，`openrouter` 的流量走代理，而 `ollama` 直连。

## 完整示例

```json
{
  "PORT": 8080,
  "APIKEY": "your-secret-key",
  "PROXY_URL": "http://127.0.0.1:7890",
  "PROXY_GLOBAL_ENABLED": false,
  "LOG": true,
  "LOG_LEVEL": "error",
  "API_TIMEOUT_MS": 600000,
  "Providers": [
    {
      "name": "deepseek",
      "api_base_url": "https://api.deepseek.com/chat/completions",
      "api_key": "$DEEPSEEK_API_KEY",
      "models": ["deepseek-chat", "deepseek-coder"],
      "transformer": {
        "use": ["deepseek"]
      }
    },
    {
      "name": "groq",
      "api_base_url": "https://api.groq.com/openai/v1/chat/completions",
      "api_key": "$GROQ_API_KEY",
      "models": ["llama-3.3-70b-versatile"],
      "proxy_enabled": true
    }
  ],
  "Router": {
    "default": "deepseek,deepseek-chat",
    "longContextThreshold": 100000,
    "background": "groq,llama-3.3-70b-versatile"
  }
}
```

## 编辑配置

使用 CLI 编辑配置：

```bash
ccr config edit
```

这将在您的默认编辑器中打开配置文件。

## 重新加载配置

编辑配置后，重启路由器：

```bash
ccr restart
```

## 配置选项说明

- **PORT**: 服务器端口号（默认：3456）
- **APIKEY**: API 密钥，用于身份验证
- **HOST**: 服务器监听地址（默认：127.0.0.1，如果配置了 Providers 且没有设置 APIKEY，则强制为 127.0.0.1）
- **PROXY_URL**: 代理服务器地址。CCR 进程自身通过此地址连接代理端口，无需开启系统代理、TUN 或代理软件的全局模式。
- **PROXY_GLOBAL_ENABLED**: 代理作用范围开关。未配置或 `true`（默认）时所有 provider 走代理；`false` 时仅 `proxy_enabled: true` 的 provider 走代理。`PROXY_URL` 为空时所有开关不生效。
- **LOG**: 是否启用日志（默认：true）
- **LOG_LEVEL**: 日志级别（fatal/error/warn/info/debug/trace）
- **API_TIMEOUT_MS**: API 请求超时时间（毫秒）
- **NON_INTERACTIVE_MODE**: 非交互模式（用于 CI/CD 环境）

## 下一步

- [提供商配置](./providers) - 详细的提供商配置
- [路由配置](./routing) - 配置路由规则
- [转换器](./transformers) - 应用转换