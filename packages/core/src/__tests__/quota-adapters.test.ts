import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getQuotaAdapter,
  parseAliyunTokenPlanUsage,
} from "../services/quota-adapters";
import type { LLMProvider } from "../types/llm";

// Tests for getQuotaAdapter hostname dispatch (no network) and the
// AliyunTokenPlanQuotaAdapter request/parsing behaviour (network mocked).

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

function makeProvider(overrides: Partial<LLMProvider> = {}): LLMProvider {
  return {
    name: "test-aliyun-maas",
    baseUrl: "https://token-plan.cn-beijing.maas.aliyuncs.com/apps/anthropic/v1/messages",
    apiKey: "dummy-api-key",
    models: ["qwen-plus"],
    quotaToken: "dummy_cookie=abc123",
    ...overrides,
  };
}

describe("getQuotaAdapter hostname dispatch", () => {
  it("routes Aliyun DashScope hostnames to the coding-plan adapter", () => {
    expect(
      getQuotaAdapter("https://dashscope.aliyuncs.com/api/v1/services/aigc/...")
    ).not.toBeNull();
    expect(
      getQuotaAdapter("https://coding.dashscope.aliyuncs.com/v1/messages")
    ).not.toBeNull();
  });

  it("routes the Aliyun maas.aliyuncs.com token-plan gateway to a quota adapter", () => {
    const adapter = getQuotaAdapter(
      "https://token-plan.cn-beijing.maas.aliyuncs.com/apps/anthropic/v1/messages"
    );
    expect(adapter).not.toBeNull();
  });

  it("uses DIFFERENT adapters for maas token-plan and dashscope endpoints", () => {
    // The maas.aliyuncs.com token-plan gateway has a dedicated adapter that
    // queries cs-data.qianwenai.com, separate from the DashScope coding-plan
    // adapter that queries the Bailian console.
    const maasAdapter = getQuotaAdapter(
      "https://token-plan.cn-beijing.maas.aliyuncs.com/apps/anthropic/v1/messages"
    );
    const dashscopeAdapter = getQuotaAdapter(
      "https://dashscope.aliyuncs.com/api/v1/services/aigc/..."
    );
    expect(maasAdapter).not.toBe(dashscopeAdapter);
  });

  it("returns null for unknown hostnames", () => {
    expect(getQuotaAdapter("https://example.com/v1/messages")).toBeNull();
    expect(getQuotaAdapter("not-a-url")).toBeNull();
  });
});

describe("parseAliyunTokenPlanUsage", () => {
  it("parses a flat response with camelCase fields", () => {
    const result = parseAliyunTokenPlanUsage({
      used5h: 1200,
      total5h: 5000,
      remaining5h: 3800,
      used7d: 8000,
      total7d: 50000,
      remaining7d: 42000,
    });
    expect(result).toEqual({
      usedDailyBalance: 1200,
      limitDaily: 5000,
      usedBalance: 8000,
      totalBalance: 50000,
      remainingBalance: 42000,
    });
  });

  it("parses a response wrapped in a data envelope", () => {
    const result = parseAliyunTokenPlanUsage({
      data: {
        used_5h: 100,
        total_5h: 500,
        used_7d: 1000,
        total_7d: 5000,
      },
    });
    expect(result).toEqual({
      usedDailyBalance: 100,
      limitDaily: 500,
      usedBalance: 1000,
      totalBalance: 5000,
    });
  });

  it("derives used from total and remaining when used is missing", () => {
    const result = parseAliyunTokenPlanUsage({
      total5h: 5000,
      remaining5h: 3800,
      total7d: 50000,
      remaining7d: 42000,
    });
    expect(result).toEqual({
      usedDailyBalance: 1200,
      limitDaily: 5000,
      usedBalance: 8000,
      totalBalance: 50000,
      remainingBalance: 42000,
    });
  });

  it("parses reset times", () => {
    const result = parseAliyunTokenPlanUsage({
      used5h: 100,
      total5h: 500,
      resetTime5h: "2026-07-20T10:00:00Z",
      resetTime7d: "2026-07-23T10:00:00Z",
    });
    expect(result).toEqual({
      usedDailyBalance: 100,
      limitDaily: 500,
      resetTime: "2026-07-20T10:00:00.000Z",
      resetTime7d: "2026-07-23T10:00:00.000Z",
    });
  });

  it("returns null when no recognised quota fields are present", () => {
    expect(parseAliyunTokenPlanUsage({ foo: "bar", baz: 42 })).toBeNull();
  });

  it("returns null for non-object payloads", () => {
    expect(parseAliyunTokenPlanUsage(null)).toBeNull();
    expect(parseAliyunTokenPlanUsage("string")).toBeNull();
    expect(parseAliyunTokenPlanUsage(42)).toBeNull();
  });

  it("does not treat unknown fields as quota values", () => {
    const result = parseAliyunTokenPlanUsage({
      randomField: 999,
      anotherField: "abc",
    });
    expect(result).toBeNull();
  });
});

describe("AliyunTokenPlanQuotaAdapter request behaviour", () => {
  it("sends Cookie auth and no Authorization Bearer header", async () => {
    let capturedInit: RequestInit | undefined;
    let capturedUrl: string | undefined;

    globalThis.fetch = vi.fn(async (url: any, init: any) => {
      capturedUrl = url;
      capturedInit = init;
      return new Response(JSON.stringify({
        data: { used5h: 10, total5h: 100 },
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as any;

    const adapter = getQuotaAdapter(
      "https://token-plan.cn-beijing.maas.aliyuncs.com/apps/anthropic/v1/messages"
    );
    expect(adapter).not.toBeNull();

    const result = await adapter!.queryQuota(makeProvider(), 5000);
    expect(result).not.toBeNull();
    expect(result!.usedDailyBalance).toBe(10);
    expect(result!.limitDaily).toBe(100);

    // Verify the request used the exact cs-data.qianwenai.com endpoint.
    expect(capturedUrl).toBe(
      "https://cs-data.qianwenai.com/data/api.json?product=sfm_bailian&action=BroadScopeAspnGateway&api=zeldaHttp.apikeyMgr.%2Ftokenplan%2Fpersonal%2Fapi%2Fv2%2Fusage"
    );

    // Verify Cookie header is set from quotaToken.
    const headers = capturedInit!.headers as Record<string, string>;
    expect(headers.Cookie).toBe("dummy_cookie=abc123");

    // Verify no Authorization header is sent.
    expect(headers.Authorization).toBeUndefined();
    expect(headers.authorization).toBeUndefined();
  });

  it("returns null when quotaToken is missing", async () => {
    const adapter = getQuotaAdapter(
      "https://token-plan.cn-beijing.maas.aliyuncs.com/apps/anthropic/v1/messages"
    );
    const result = await adapter!.queryQuota(
      makeProvider({ quotaToken: undefined }),
      5000
    );
    expect(result).toBeNull();
  });

  it("returns null on HTTP error", async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response("Forbidden", { status: 403 })
    ) as any;

    const adapter = getQuotaAdapter(
      "https://token-plan.cn-beijing.maas.aliyuncs.com/apps/anthropic/v1/messages"
    );
    const result = await adapter!.queryQuota(makeProvider(), 5000);
    expect(result).toBeNull();
  });

  it("returns null on network error", async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error("network error");
    }) as any;

    const adapter = getQuotaAdapter(
      "https://token-plan.cn-beijing.maas.aliyuncs.com/apps/anthropic/v1/messages"
    );
    const result = await adapter!.queryQuota(makeProvider(), 5000);
    expect(result).toBeNull();
  });
});