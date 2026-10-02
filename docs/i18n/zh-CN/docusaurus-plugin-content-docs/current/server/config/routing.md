---
title: 路由配置
sidebar_position: 3
---

# 路由配置

配置如何将请求路由到不同的模型。

## 默认路由

为所有请求设置默认模型：

```json
{
  "Router": {
    "default": "deepseek,deepseek-chat"
  }
}
```

## 内置场景

### 后台任务

将后台任务路由到轻量级模型：

```json
{
  "Router": {
    "background": "groq,llama-3.3-70b-versatile"
  }
}
```

### 思考模式（计划模式）

将思考密集型任务路由到更强大的模型：

```json
{
  "Router": {
    "think": "deepseek,deepseek-reasoner"
  }
}
```

### 长上下文

路由长上下文请求：

```json
{
  "Router": {
    "longContextThreshold": 100000,
    "longContext": "gemini,gemini-2.5-pro"
  }
}
```

### 网络搜索

路由网络搜索任务：

```json
{
  "Router": {
    "webSearch": "gemini,gemini-2.5-flash"
  }
}
```

### 图像任务

路由图像相关任务：

```json
{
  "Router": {
    "image": "gemini,gemini-2.5-pro"
  }
}
```

## 故障转移（Fallback）

当请求失败时，可以配置备用模型列表。系统会按顺序尝试每个模型，直到请求成功：

### 基本配置

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

### 工作原理

1. **触发条件**：当某个路由场景的模型请求失败时（HTTP 错误响应）
2. **自动切换**：系统自动检查该场景的 fallback 配置
3. **顺序尝试**：按照列表顺序依次尝试每个备用模型
4. **成功返回**：一旦某个模型成功响应，立即返回结果
5. **全部失败**：如果所有备用模型都失败，返回原始错误

### 配置说明

- **格式**：每个备用模型格式为 `provider,model`
- **验证**：备用模型必须在 `Providers` 配置中存在
- **灵活性**：可以为不同场景配置不同的备用列表
- **可选性**：如果某个场景不需要备用，可以不配置或使用空数组

### 使用场景

#### 场景一：主模型配额不足

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

当主模型配额用完时，自动切换到备用模型。

#### 场景二：服务稳定性保障

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

当主服务商出现故障时，自动切换到其他服务商。

### 日志监控

系统会记录详细的 fallback 过程：

```
[warn] Request failed for default, trying 2 fallback models
[info] Trying fallback model: aihubmix,Z/glm-4.5
[warn] Fallback model aihubmix,Z/glm-4.5 failed: API rate limit exceeded
[info] Trying fallback model: openrouter,anthropic/claude-sonnet-4
[info] Fallback model openrouter,anthropic/claude-sonnet-4 succeeded
```

### 注意事项

1. **成本考虑**：备用模型可能产生不同的费用，请合理配置
2. **性能差异**：不同模型的响应速度和质量可能有差异
3. **配额管理**：确保备用模型有足够的配额
4. **测试验证**：定期测试备用模型的可用性

## 并发优先模式

当多个项目共用一个 CCR 实例时，大量并发请求打到同一个模型会导致排队变慢。并发优先模式叠加在现有路由结果之上：无论路由为请求选中哪个模型（default、think、longContext、模型族默认值等），都会按其实时在途并发数检查，忙碌时把新会话分流到该场景对应的备用列表。

### 配置

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

- **`enableConcurrencyPriority`**（布尔，默认 `false`）：开启并发优先路由。
- **`concurrencyThreshold`**（数字，默认 `3`）：当路由选中模型的在途并发请求数达到该值时，新会话（未粘连的 session）分流到该场景对应的备用列表。

### 工作原理

1. **首次分配**：路由选中模型的在途并发低于阈值时，新会话使用该模型；达到阈值后，新会话被分配到该场景对应备用列表中负载最低的健康模型（先看模型族 fallback，再看全局 `fallback[场景]` 列表）。
2. **会话粘连**：会话按**路由槽位**（session + 模型族 + 场景）粘连在首次分配的模型上——即一个会话的 default 流量和 think 流量各自粘连一个模型。已粘连的 session 不会因为并发而中途切换，从而保持供应商侧 prompt 缓存的命中率。
3. **仅报错切换**：只有当当前模型报错且错误 fallback 成功时（需开启 `enableFallback`），会话才会切换并重新绑定到成功的模型。
4. **作用范围**：作用于路由为请求选中的模型（覆盖 `default`/`think`/`longContext`/`extendedContext`/`webSearch`/`image`/`background`/模型族默认值等所有场景）；显式指定 `provider,model` 的请求不受影响。

### 注意事项

- 分流池来自对应场景的备用列表，请为需要生效的场景至少配置一个备用模型。候选按在途负载最低挑选——所有候选都忙碌时，负载最低的仍会接管溢出流量。
- 如果备用列表为空或所有候选都不可用，新会话继续使用忙碌模型，不会失败。
- 粘连依赖稳定的 session id（Claude Code 会提供）。没有 session id 的请求参与溢出分流但不做固定，每次请求重新评估负载最低的目标。
- 配置了 `CUSTOM_ROUTER_PATH` 时，并发层仍会作用于自定义路由返回的模型（视为 default 场景流量，受粘连与溢出影响）；如需自定义路由拥有最终决定权，请关闭本模式。
- 在途并发数与会话绑定保存在内存中，服务重启后重置。

## 项目级路由

在 `~/.claude/projects/<project-id>/claude-code-router.json` 中为每个项目配置路由：

```json
{
  "Router": {
    "default": "groq,llama-3.3-70b-versatile"
  }
}
```

项目级配置优先于全局配置。

## 自定义路由器

创建自定义 JavaScript 路由器函数：

1. 创建路由器文件（例如 `custom-router.js`）：

```javascript
module.exports = async function(req, config) {
  // 分析请求上下文
  const userMessage = req.body.messages.find(m => m.role === 'user')?.content;

  // 自定义路由逻辑
  if (userMessage && userMessage.includes('解释代码')) {
    return 'openrouter,anthropic/claude-3.5-sonnet';
  }

  // 返回 null 以使用默认路由
  return null;
};
```

2. 在 `config.json` 中设置 `CUSTOM_ROUTER_PATH`：

```json
{
  "CUSTOM_ROUTER_PATH": "/path/to/custom-router.js"
}
```

## Token 计数

路由器使用 `tiktoken` (cl100k_base) 来估算请求 token 数量。这用于：

- 确定请求是否超过 `longContextThreshold`
- 基于 token 数量的自定义路由逻辑

## 子代理路由

使用特殊标签为子代理指定模型：

```
<CCR-SUBAGENT-MODEL>provider,model</CCR-SUBAGENT-MODEL>
请帮我分析这段代码...
```

## 动态模型切换

在 Claude Code 中使用 `/model` 命令动态切换模型：

```
/model provider_name,model_name
```

示例：`/model openrouter,anthropic/claude-3.5-sonnet`

## 路由优先级

1. 项目级配置
2. 自定义路由器
3. 内置场景路由
4. 默认路由

## 下一步

- [转换器](/zh/docs/config/transformers) - 对请求应用转换
- [自定义路由器](/zh/docs/advanced/custom-router) - 高级自定义路由
