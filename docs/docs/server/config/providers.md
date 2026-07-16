---
sidebar_position: 2
---

# Providers Configuration

Detailed guide for configuring LLM providers.

## Supported Providers

### DeepSeek

```json
{
  "name": "deepseek",
  "api_base_url": "https://api.deepseek.com/chat/completions",
  "api_key": "your-api-key",
  "models": ["deepseek-chat", "deepseek-reasoner"],
  "transformer": {
    "use": ["deepseek"]
  }
}
```

### Groq

```json
{
  "name": "groq",
  "api_base_url": "https://api.groq.com/openai/v1/chat/completions",
  "api_key": "your-api-key",
  "models": ["llama-3.3-70b-versatile"]
}
```

### Gemini

```json
{
  "name": "gemini",
  "api_base_url": "https://generativelanguage.googleapis.com/v1beta/models/",
  "api_key": "your-api-key",
  "models": ["gemini-2.5-flash", "gemini-2.5-pro"],
  "transformer": {
    "use": ["gemini"]
  }
}
```

### OpenRouter

```json
{
  "name": "openrouter",
  "api_base_url": "https://openrouter.ai/api/v1/chat/completions",
  "api_key": "your-api-key",
  "models": ["anthropic/claude-3.5-sonnet"],
  "transformer": {
    "use": ["openrouter"]
  }
}
```

## Provider Configuration Options

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | Yes | Unique provider identifier |
| `api_base_url` | string | Yes | API base URL |
| `api_key` | string | Yes | API authentication key |
| `models` | string[] | No | List of available models |
| `transformer` | object | No | Transformer configuration |
| `proxy_enabled` | boolean | No | When `PROXY_GLOBAL_ENABLED` is `false`, only providers with `proxy_enabled: true` route through `PROXY_URL`. Ignored when `PROXY_GLOBAL_ENABLED` is `true` or unconfigured (all providers use the proxy). See [Basic Configuration > Proxy](./basic#proxy). |

## Model Selection

When selecting a model in routing, use the format:

```
{provider-name},{model-name}
```

For example:

```
deepseek,deepseek-chat
```

## Next Steps

- [Routing Configuration](./routing) - Configure how requests are routed
- [Transformers](./transformers) - Apply transformations to requests