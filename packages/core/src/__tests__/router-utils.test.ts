import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock external dependencies before importing the module under test
vi.mock("../services/provider-health", () => {
  let _available = true;
  return {
    getHealthStore: () => ({
      isAvailable: () => _available,
      recordSuccess: vi.fn(),
      recordFailure: vi.fn(),
    }),
    __setAvailable: (v: boolean) => { _available = v; },
  };
});

vi.mock("../utils/fallback-promotion", () => ({
  getFallbackPromotionStore: () => ({
    getPromotion: () => null,
    clear: vi.fn(),
  }),
}));

vi.mock("../services/quota", () => ({
  getQuotaResult: () => null,
}));

import { findProviderModel } from "../utils/router";

// --- findProviderModel ---

describe("findProviderModel", () => {
  const providers = [
    {
      name: "OpenAI",
      enabled: true,
      models: ["gpt-4o", "gpt-4o-mini", "o3"],
    },
    {
      name: "Anthropic",
      enabled: true,
      models: ["claude-sonnet-4-20250514", "claude-opus-4-20250514"],
    },
    {
      name: "Disabled",
      enabled: false,
      models: ["disabled-model"],
    },
  ];

  it("should find an existing model with exact name match", () => {
    const result = findProviderModel(providers, "OpenAI", "gpt-4o");
    expect(result).not.toBeNull();
    expect(result!.provider.name).toBe("OpenAI");
    expect(result!.model).toBe("gpt-4o");
  });

  it("should find a model with case-insensitive provider name", () => {
    const result = findProviderModel(providers, "openai", "gpt-4o");
    expect(result).not.toBeNull();
    expect(result!.provider.name).toBe("OpenAI");
    expect(result!.model).toBe("gpt-4o");
  });

  it("should find a model with case-insensitive model name", () => {
    const result = findProviderModel(providers, "OpenAI", "GPT-4O");
    expect(result).not.toBeNull();
    expect(result!.model).toBe("gpt-4o");
  });

  it("should return null for non-existent provider", () => {
    const result = findProviderModel(providers, "Google", "gemini-pro");
    expect(result).toBeNull();
  });

  it("should return null for non-existent model in existing provider", () => {
    const result = findProviderModel(providers, "OpenAI", "gpt-3.5-turbo");
    expect(result).toBeNull();
  });

  it("should return null for disabled provider", () => {
    const result = findProviderModel(providers, "Disabled", "disabled-model");
    expect(result).toBeNull();
  });

  it("should return null for empty provider name", () => {
    const result = findProviderModel(providers, "", "gpt-4o");
    expect(result).toBeNull();
  });

  it("should return null for empty model name", () => {
    const result = findProviderModel(providers, "OpenAI", "");
    expect(result).toBeNull();
  });

  it("should return null for provider with no models array", () => {
    const result = findProviderModel(
      [{ name: "Empty", enabled: true }],
      "Empty",
      "any-model"
    );
    expect(result).toBeNull();
  });

  it("should return canonical (case-matched) model name from provider config", () => {
    const result = findProviderModel(providers, "anthropic", "CLAUDE-SONNET-4-20250514");
    expect(result).not.toBeNull();
    expect(result!.model).toBe("claude-sonnet-4-20250514");
    expect(result!.provider.name).toBe("Anthropic");
  });

  // Regression guard for the fallback "Invalid URL" bug. handleFallback() in
  // routes.ts feeds the matched provider straight into sendRequestToProvider,
  // which calls `new URL(provider.baseUrl)`. The input array MUST therefore be
  // registered LLMProvider objects (with `baseUrl`), NOT raw ConfigProvider
  // objects from configService.get("providers") (which carry `api_base_url`
  // instead and have no baseUrl, making new URL(undefined) throw "Invalid URL"
  // for every fallback model). These two tests pin that contract so a future
  // change of the data source is caught here rather than in production.
  it("preserves baseUrl on the matched provider (LLMProvider contract for fallback URL construction)", () => {
    const llmProviders = [
      { name: "Zhipu", enabled: true, models: ["glm-5.2"], baseUrl: "https://open.bigmodel.cn/api/anthropic/v1/messages" },
    ];
    const result = findProviderModel(llmProviders, "zhipu", "GLM-5.2");
    expect(result).not.toBeNull();
    expect(result!.provider.baseUrl).toBe("https://open.bigmodel.cn/api/anthropic/v1/messages");
  });

  it("does not synthesize a baseUrl when the input array lacks it (raw ConfigProvider shape)", () => {
    // ConfigProvider uses `api_base_url`, not `baseUrl` — this is exactly the
    // shape configService.get("providers") returns. If fallback ever feeds
    // this shape to sendRequestToProvider, provider.baseUrl is undefined.
    const configProviders = [
      { name: "Zhipu", enabled: true, models: ["glm-5.2"], api_base_url: "https://open.bigmodel.cn/api/anthropic/v1/messages" },
    ];
    const result = findProviderModel(configProviders, "zhipu", "glm-5.2");
    expect(result).not.toBeNull();
    expect((result!.provider as any).baseUrl).toBeUndefined();
  });
});
