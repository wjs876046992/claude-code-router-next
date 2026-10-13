---
sidebar_position: 3
---

# Routing Configuration

Configure how requests are routed to different models.

## Default Routing

Set the default model for all requests:

```json
{
  "Router": {
    "default": "deepseek,deepseek-chat"
  }
}
```

## Built-in Scenarios

### Background Tasks

Route background tasks to a lightweight model:

```json
{
  "Router": {
    "background": "groq,llama-3.3-70b-versatile"
  }
}
```

### Thinking Mode (Plan Mode)

Route thinking-intensive tasks to a more capable model:

```json
{
  "Router": {
    "think": "deepseek,deepseek-chat"
  }
}
```

### Long Context

Route requests with long context:

```json
{
  "Router": {
    "longContextThreshold": 100000,
    "longContext": "gemini,gemini-1.5-pro"
  }
}
```

### Web Search

Route web search tasks:

```json
{
  "Router": {
    "webSearch": "deepseek,deepseek-chat"
  }
}
```

### Image Tasks

Route image-related tasks:

```json
{
  "Router": {
    "image": "gemini,gemini-1.5-pro"
  }
}
```

## Fallback

When a request fails, you can configure a list of backup models. The system will try each model in sequence until one succeeds:

### Basic Configuration

```json
{
  "Router": {
    "default": "deepseek,deepseek-chat",
    "background": "ollama,qwen2.5-coder:latest",
    "think": "deepseek,deepseek-reasoner",
    "longContext": "openrouter,google/gemini-2.5-pro-preview",
    "longContextThreshold": 60000,
    "webSearch": "gemini,gemini-2.5-flash"
  },
  "fallback": {
    "default": [
      "aihubmix,Z/glm-4.5",
      "openrouter,anthropic/claude-sonnet-4"
    ],
    "background": [
      "ollama,qwen2.5-coder:latest"
    ],
    "think": [
      "openrouter,anthropic/claude-3.7-sonnet:thinking"
    ],
    "longContext": [
      "modelscope,Qwen/Qwen3-Coder-480B-A35B-Instruct"
    ],
    "webSearch": [
      "openrouter,anthropic/claude-sonnet-4"
    ]
  }
}
```

### How It Works

1. **Trigger**: When a model request fails for a routing scenario (HTTP error response)
2. **Auto-switch**: The system automatically checks the fallback configuration for that scenario
3. **Sequential retry**: Tries each backup model in order
4. **Success**: Once a model responds successfully, returns immediately
5. **All failed**: If all backup models fail, returns the original error

### Configuration Details

- **Format**: Each backup model format is `provider,model`
- **Validation**: Backup models must exist in the `Providers` configuration
- **Flexibility**: Different scenarios can have different fallback lists
- **Optional**: If a scenario doesn't need fallback, omit it or use an empty array

### Use Cases

#### Scenario 1: Primary Model Quota Exhausted

```json
{
  "Router": {
    "default": "openrouter,anthropic/claude-sonnet-4"
  },
  "fallback": {
    "default": [
      "deepseek,deepseek-chat",
      "aihubmix,Z/glm-4.5"
    ]
  }
}
```

Automatically switches to backup models when the primary model quota is exhausted.

#### Scenario 2: Service Reliability

```json
{
  "Router": {
    "background": "volcengine,deepseek-v3-250324"
  },
  "fallback": {
    "background": [
      "modelscope,Qwen/Qwen3-Coder-480B-A35B-Instruct",
      "dashscope,qwen3-coder-plus"
    ]
  }
}
```

Automatically switches to other providers when the primary service fails.

### Log Monitoring

The system logs detailed fallback process:

```
[warn] Request failed for default, trying 2 fallback models
[info] Trying fallback model: aihubmix,Z/glm-4.5
[warn] Fallback model aihubmix,Z/glm-4.5 failed: API rate limit exceeded
[info] Trying fallback model: openrouter,anthropic/claude-sonnet-4
[info] Fallback model openrouter,anthropic/claude-sonnet-4 succeeded
```

### Important Notes

1. **Cost consideration**: Backup models may incur different costs, configure appropriately
2. **Performance differences**: Different models may have varying response speeds and quality
3. **Quota management**: Ensure backup models have sufficient quotas
4. **Testing**: Regularly test the availability of backup models

## Concurrency Priority Mode

When multiple projects share one CCR instance, heavy concurrent traffic against a single model causes queueing and slowdowns. Concurrency Priority mode layers on top of the normal routing decision: whatever model the router selects for a request (default, think, longContext, family default, ...), it is checked against live in-flight concurrency and new sessions overflow to the scenario-matching fallback list once it gets busy.

### Configuration

```json
{
  "Router": {
    "default": "openrouter,anthropic/claude-sonnet-4",
    "think": "openrouter,anthropic/claude-3.7-sonnet:thinking",
    "enableConcurrencyPriority": true,
    "concurrencyThreshold": 3
  },
  "fallback": {
    "default": [
      "deepseek,deepseek-chat",
      "aihubmix,Z/glm-4.5"
    ],
    "think": [
      "openrouter,anthropic/claude-sonnet-4"
    ]
  }
}
```

- **`enableConcurrencyPriority`** (boolean, default `false`): enable concurrency-priority routing.
- **`concurrencyThreshold`** (number, default `3`): once the selected model's in-flight request count reaches this value, new (not yet pinned) sessions overflow to that scenario's fallback list.

### How It Works

1. **Fresh assignment**: while the selected model's in-flight concurrency is below the threshold, new sessions use that model. Once the threshold is reached, new sessions are assigned to the least-loaded healthy model in the matching fallback list (family fallback first, then the global `fallback[scenario]` list).
2. **Session stickiness**: a session sticks to its initially assigned model **per routing slot** (session + model family + scenario), so a session keeps one model for its default traffic and another for think traffic. Already-pinned sessions are never moved by congestion, which keeps provider-side prompt caches warm.
3. **Error-driven switch only**: a session changes models only when its current model errors and the error-fallback path succeeds (requires `enableFallback`); the session is then rebound to the model that succeeded.
4. **Scope**: applies to the model selected by the normal routing decision for every scenario (`default`, `think`, `longContext`, `extendedContext`, `webSearch`, `image`, `background`, model family defaults). Explicit `provider,model` requests are left untouched.

### Notes

- The overflow pool is the scenario-matching fallback list; configure at least one fallback model for a scenario for the mode to take effect on that scenario. Candidates are chosen by least in-flight load — when every candidate is busy, the least-loaded one still receives the overflow.
- If the fallback list is empty or every candidate is unhealthy, new sessions stay on the busy model rather than failing.
- Stickiness requires a stable session id. Claude Code provides one via `metadata.user_id`. Pi provides one through session-affinity headers (see below). Requests without a session id participate in overflow balancing but are never pinned; each request re-evaluates the least-loaded target.
- When `CUSTOM_ROUTER_PATH` is configured, the concurrency layer still applies to the model the custom router returns (treated as default-scenario traffic, subject to stickiness and overflow). Disable the mode if your custom router must have the final say.
- In-flight counts and session bindings live in memory and reset on restart.

### Pi Session Affinity

Pi exposes its stable conversation id when the managed CCR model declares `compat.sendSessionAffinityHeaders: true` (CCR's Pi takeover writes this automatically; refresh the takeover or restart the CCR server after upgrading).

With the header present, CCR:

1. Reads `x-session-affinity` (then `x-session-id`, then `x-litellm-session-id`) as the conversation's stable session id and validates it (alphanumeric/`-`/`_`, max 256 chars). Invalid values are ignored.
2. Uses it for concurrency-priority stickiness: all requests of one Pi conversation share a routing slot, so the conversation stays on one model per scenario. Usage/token-speed bookkeeping stays request-scoped, so parallel requests inside one conversation (compaction, subagents) never overwrite each other's stats.
3. Forwards the id upstream as `x-litellm-session-id` on every provider request — including fallback attempts — so gateways such as LiteLLM group the whole conversation's spend logs under one session id instead of a fresh trace id per request.
4. Strips the inbound session-affinity headers before forwarding, so they never leak to providers that do not understand them.

If your Pi models are configured manually (not through the CCR takeover), add the compat flag to each model in `models.json`:

```json
{
  "providers": {
    "ccr": {
      "baseUrl": "http://127.0.0.1:3456",
      "api": "anthropic-messages",
      "models": [
        {
          "id": "ccr-opus",
          "compat": { "sendSessionAffinityHeaders": true }
        }
      ]
    }
  }
}
```

Without the flag (or with pi's `cacheRetention: "none"`, which drops session ids from requests), Pi requests stay request-scoped: overflow balancing still works, but sessions are not pinned and LiteLLM logs each request under its own id.

## Project-Level Routing

Configure routing per project in `~/.claude/projects/<project-id>/claude-code-router.json`:

```json
{
  "Router": {
    "default": "groq,llama-3.3-70b-versatile"
  }
}
```

Project-level configuration takes precedence over global configuration.

## Custom Router

Create a custom JavaScript router function:

1. Create a router file (e.g., `custom-router.js`):

```javascript
module.exports = function(config, context) {
  // Analyze the request context
  const { scenario, projectId, tokenCount } = context;

  // Custom routing logic
  if (scenario === 'background') {
    return 'groq,llama-3.3-70b-versatile';
  }

  if (tokenCount > 100000) {
    return 'gemini,gemini-1.5-pro';
  }

  // Default
  return 'deepseek,deepseek-chat';
};
```

2. Set the `CUSTOM_ROUTER_PATH` environment variable:

```bash
export CUSTOM_ROUTER_PATH="/path/to/custom-router.js"
```

## Token Counting

The router uses `tiktoken` (cl100k_base) to estimate request token count. This is used for:

- Determining if a request exceeds `longContextThreshold`
- Custom routing logic based on token count

## Subagent Routing

Specify models for subagents using special tags:

```
<CCR-SUBAGENT-MODEL>provider,model</CCR-SUBAGENT-MODEL>
Please help me analyze this code...
```

## Next Steps

- [Transformers](/docs/config/transformers) - Apply transformations to requests
- [Custom Router](/docs/advanced/custom-router) - Advanced custom routing
