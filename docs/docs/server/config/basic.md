---
sidebar_position: 1
---

# Basic Configuration

Learn how to configure Claude Code Router to suit your needs.

## Configuration File Location

The configuration file is located at:

```
~/.claude-code-router/config.json
```

## Configuration Structure

### Providers

Configure LLM providers to route requests to:

```json
{
  "Providers": [
    {
      "name": "deepseek",
      "api_base_url": "https://api.deepseek.com/chat/completions",
      "api_key": "your-api-key",
      "models": ["deepseek-chat", "deepseek-reasoner"],
      "transformer": {
        "use": ["deepseek"]
      }
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

### Router

Configure which model to use by default:

```json
{
  "Router": {
    "default": "deepseek,deepseek-chat"
  }
}
```

Format: `{provider-name},{model-name}`

### Transformers

Apply transformations to requests/responses:

```json
{
  "transformers": [
    {
      "name": "anthropic",
      "providers": ["deepseek", "groq"]
    }
  ]
}
```

### Environment Variables

Use environment variables in your configuration:

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

Both `$VAR_NAME` and `${VAR_NAME}` syntax are supported.

### Proxy

CCR can route its outbound API requests through an HTTP/HTTPS proxy. This is useful when your providers are only reachable via a proxy (e.g. in restricted network environments).

- **`PROXY_URL`**: The proxy address, e.g. `"http://127.0.0.1:7890"`. The CCR process itself connects to this proxy port — no system-wide proxy, TUN mode, or proxy-app global mode is required.
- **`PROXY_GLOBAL_ENABLED`**: Controls the scope of the proxy (see below).

| `PROXY_GLOBAL_ENABLED` | Behaviour |
|---|---|
| Unconfigured or `true` (default) | **All** providers' outbound traffic goes through `PROXY_URL`. This preserves backward compatibility with existing configs. |
| `false` | Only providers marked with `proxy_enabled: true` use the proxy; all other providers connect directly. |

Additional notes:

- All providers share the single top-level `PROXY_URL` — per-provider proxy URLs are not supported.
- If `PROXY_URL` is not set (empty), all proxy switches are ineffective and every connection is direct.
- Provider-specific outbound requests (inference, fallback, health probes, quota queries, wakeup, provider API tokenizer, etc.) all follow the same per-provider proxy policy.

:::warning Security
The proxy can see your API keys and request payloads. Only configure a proxy you trust.
:::

Example with per-provider proxy:

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

In the example above, `openrouter` traffic goes through the proxy while `ollama` connects directly.

## Complete Example

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
      "models": ["deepseek-chat", "deepseek-reasoner"],
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

## Editing Configuration

Use the CLI to edit the configuration:

```bash
ccr config edit
```

This will open the configuration file in your default editor.

## Reloading Configuration

After editing the configuration, restart the router:

```bash
ccr restart
```

## Next Steps

- [Providers Configuration](./providers) - Detailed provider configuration
- [Routing Configuration](./routing) - Configure routing rules
- [Transformers](./transformers) - Apply transformations