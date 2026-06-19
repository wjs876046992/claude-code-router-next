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
});
