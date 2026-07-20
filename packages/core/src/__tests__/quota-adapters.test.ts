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

  it("parses a response wrapped in a single data envelope", () => {
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

  it("parses a response wrapped in the confirmed BroadScope data.DataV2.data.data envelope", () => {
    // The sibling coding-plan adapter confirms the gateway wraps real data at
    // payload.data.DataV2.data.data.<result>. The token-plan usage payload is
    // served by the same gateway, so the parser must reach that depth.
    const result = parseAliyunTokenPlanUsage({
      code: "200",
      data: {
        DataV2: {
          data: {
            data: {
              used5h: 10,
              total5h: 100,
              used7d: 200,
              total7d: 2000,
            },
          },
        },
      },
    });
    expect(result).toEqual({
      usedDailyBalance: 10,
      limitDaily: 100,
      usedBalance: 200,
      totalBalance: 2000,
    });
  });

  it("returns null when the gateway reports a login/business error", () => {
    // Confirmed shape of an unauthenticated token-plan gateway response.
    const result = parseAliyunTokenPlanUsage({
      code: "200",
      data: {
        success: false,
        httpStatus: 200,
        errorCode: "BailianGateway.Login.NotLogined",
        api: "zeldaHttp.apikeyMgr./tokenplan/personal/api/v2/usage",
        errorMsg: "BailianGateway.Login.NotLogined",
      },
      successResponse: true,
    });
    expect(result).toBeNull();
  });

  it("parses the confirmed coding-plan field names as a fallback", () => {
    // If the token-plan payload reuses the coding-plan field spelling, the
    // parser must still recognise it.
    const result = parseAliyunTokenPlanUsage({
      data: {
        data: {
          per5HourUsedQuota: 30,
          per5HourTotalQuota: 300,
          perWeekUsedQuota: 400,
          perWeekTotalQuota: 4000,
        },
      },
    });
    expect(result).toEqual({
      usedDailyBalance: 30,
      limitDaily: 300,
      usedBalance: 400,
      totalBalance: 4000,
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
  it("POSTs to the gateway with Cookie auth, a params body, and no Bearer header", async () => {
    let capturedInit: RequestInit | undefined;
    let capturedUrl: string | undefined;

    globalThis.fetch = vi.fn(async (url: any, init: any) => {
      capturedUrl = url;
      capturedInit = init;
      return new Response(JSON.stringify({
        data: { DataV2: { data: { data: { used5h: 10, total5h: 100 } } } },
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

    // The gateway rejects GET — the adapter must POST.
    expect(capturedInit!.method).toBe("POST");

    // The URL targets the confirmed token-plan usage endpoint on
    // cs-data.qianwenai.com, with the token-plan api path.
    expect(capturedUrl).toContain("https://cs-data.qianwenai.com/data/api.json");
    expect(capturedUrl).toContain("action=BroadScopeAspnGateway");
    expect(capturedUrl).toContain("api=zeldaHttp.apikeyMgr.");
    expect(capturedUrl).toContain("tokenplan");

    const headers = capturedInit!.headers as Record<string, string>;
    // Cookie auth is set from quotaToken (trimmed) and is the ONLY auth.
    expect(headers.Cookie).toBe("dummy_cookie=abc123");
    expect(headers.Authorization).toBeUndefined();
    expect(headers.authorization).toBeUndefined();
    // The BroadScope gateway requires the form-encoded params envelope.
    expect(headers["Content-Type"]).toBe("application/x-www-form-urlencoded");
    const body = String(capturedInit!.body);
    expect(body).toContain("params=");
    expect(body).toContain("region=cn-beijing");
    expect(body).toContain(encodeURIComponent("zeldaHttp.apikeyMgr./tokenplan/personal/api/v2/usage"));
  });

  it("sets the proxy dispatcher when a proxyUrl is provided", async () => {
    let capturedInit: RequestInit & { dispatcher?: unknown } | undefined;
    const fakeDispatcher = { __fake: true };

    globalThis.fetch = vi.fn(async (_url: any, init: any) => {
      capturedInit = init;
      return new Response(JSON.stringify({ data: { used5h: 1 } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as any;

    const adapter = getQuotaAdapter(
      "https://token-plan.cn-beijing.maas.aliyuncs.com/apps/anthropic/v1/messages"
    );
    await adapter!.queryQuota(makeProvider(), 5000, "http://127.0.0.1:7897");
    // getProxyDispatcher returns an undici ProxyAgent; just assert a dispatcher
    // was attached (proves the proxy branch ran rather than being skipped).
    expect(capturedInit?.dispatcher).toBeDefined();
  });

  it("trims a whitespace-padded cookie before sending", async () => {
    let capturedInit: RequestInit | undefined;
    globalThis.fetch = vi.fn(async (_url: any, init: any) => {
      capturedInit = init;
      return new Response(JSON.stringify({ data: { used5h: 1 } }), { status: 200 });
    }) as any;

    const adapter = getQuotaAdapter(
      "https://token-plan.cn-beijing.maas.aliyuncs.com/apps/anthropic/v1/messages"
    );
    await adapter!.queryQuota(makeProvider({ quotaToken: "  dummy_cookie=abc123  " }), 5000);
    const headers = capturedInit!.headers as Record<string, string>;
    expect(headers.Cookie).toBe("dummy_cookie=abc123");
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