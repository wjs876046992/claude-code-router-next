/** Anthropic-compatible model metadata exposed by /v1/models. */
export interface AnthropicModelInfo {
  type: "model";
  id: string;
  display_name: string;
  created_at: string;
  context_window: number;
  contextWindow: number;
  max_input_tokens: number;
  maxInputTokens: number;
  max_tokens: number;
  maxTokens: number;
  max_output_tokens: number;
  maxOutputTokens: number;
  capabilities: {
    context_window: number;
    contextWindow: number;
    max_input_tokens: number;
    maxInputTokens: number;
    max_tokens: number;
    maxTokens: number;
    max_output_tokens: number;
    maxOutputTokens: number;
  };
}

function getModelContextWindow(modelId: string): number {
  return /\[1m\]/i.test(modelId) ? 1_000_000 : 200_000;
}

function getModelMaxOutputTokens(modelId: string): number {
  const normalized = modelId.toLowerCase();
  if (normalized.includes("haiku") || normalized.includes("mini")) return 8_192;
  return 32_000;
}

function createAnthropicModelInfo(id: string, displayName = id): AnthropicModelInfo {
  const contextWindow = getModelContextWindow(id);
  const maxOutputTokens = getModelMaxOutputTokens(id);
  return {
    type: "model",
    id,
    display_name: displayName,
    created_at: "2024-01-01T00:00:00Z",
    context_window: contextWindow,
    contextWindow,
    max_input_tokens: contextWindow,
    maxInputTokens: contextWindow,
    max_tokens: maxOutputTokens,
    maxTokens: maxOutputTokens,
    max_output_tokens: maxOutputTokens,
    maxOutputTokens: maxOutputTokens,
    capabilities: {
      context_window: contextWindow,
      contextWindow,
      max_input_tokens: contextWindow,
      maxInputTokens: contextWindow,
      max_tokens: maxOutputTokens,
      maxTokens: maxOutputTokens,
      max_output_tokens: maxOutputTokens,
      maxOutputTokens: maxOutputTokens,
    },
  };
}

export function listAnthropicCompatibleModels(config: any): AnthropicModelInfo[] {
  const models = new Map<string, AnthropicModelInfo>();
  const addModel = (id: string, displayName = id) => {
    if (!id || models.has(id)) return;
    models.set(id, createAnthropicModelInfo(id, displayName));
  };

  addModel("ccr-opus", "CCR Opus");
  addModel("ccr-sonnet", "CCR Sonnet");
  addModel("ccr-haiku", "CCR Haiku");
  addModel("ccr-opus[1m]", "CCR Opus 1M");
  addModel("ccr-sonnet[1m]", "CCR Sonnet 1M");
  addModel("ccr-haiku[1m]", "CCR Haiku 1M");

  for (const provider of config.Providers || config.providers || []) {
    if (!provider?.name || !Array.isArray(provider.models)) continue;
    for (const model of provider.models) {
      if (typeof model !== "string" || !model) continue;
      addModel(model, model);
      addModel(`${provider.name},${model}`, `${provider.name}/${model}`);
    }
  }

  return Array.from(models.values());
}