import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../services/provider-health", () => ({
  getHealthStore: () => ({ isAvailable: () => true }),
}));

vi.mock("../services/quota-store", () => ({
  getQuotaResult: () => undefined,
}));

vi.mock("../utils/fallback-promotion", () => ({
  getFallbackPromotionStore: () => ({
    getPromotion: () => null,
    clear: vi.fn(),
  }),
}));

import type { Usage } from "../utils/cache";
import { sessionUsageCache } from "../utils/cache";
import { ConfigService } from "../services/config";
import {
  getEffectiveTokenCount,
  getExtendedContextThreshold,
  router,
} from "../utils/router";

const log = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

function routeConfig(overrides: Record<string, any> = {}): ConfigService {
  return new ConfigService({
    useJsonFile: false,
    initialConfig: {
      providers: [{
        name: "provider",
        enabled: true,
        models: ["default", "long", "extended"],
      }],
      Router: {
        enableFamilyRouting: true,
        families: {
          opus: {
            default: "provider,default",
            longContext: "provider,long",
            extendedContext: "provider,extended",
          },
        },
        ...overrides,
      },
    },
  });
}

function routeRequest(overrides: Record<string, any> = {}): any {
  return {
    id: "route-request",
    url: "/v1/messages",
    headers: {},
    log,
    body: {
      model: "ccr-opus",
      messages: [{ role: "user", content: "hello" }],
      system: [],
      tools: [],
      ...overrides,
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

const usage: Usage = {
  input_tokens: 100000,
  output_tokens: 1000,
  cache_read_input_tokens: 50000,
  cache_creation_input_tokens: 10000,
};

describe("adapter-driven router context", () => {
  it("uses only the current token count for request-scoped clients", () => {
    expect(getEffectiveTokenCount(25000, usage, {
      clientType: "pi",
      usageScope: "request",
      supportsExplicitExtendedContext: false,
    })).toBe(25000);
  });

  it("uses max current/last usage for session-scoped clients", () => {
    expect(getEffectiveTokenCount(25000, usage, {
      clientType: "claude-code",
      usageScope: "session",
      stableSessionId: "session-1",
      supportsExplicitExtendedContext: true,
    })).toBe(160000);
  });

  it("resolves extended thresholds adapter then family then global then default", () => {
    const context = {
      clientType: "pi" as const,
      usageScope: "request" as const,
      supportsExplicitExtendedContext: false,
      extendedContextThreshold: 320000,
    };

    expect(getExtendedContextThreshold(context, { default: "p,m", extendedContextThreshold: 410000 }, 510000)).toBe(320000);
    expect(getExtendedContextThreshold(undefined, { default: "p,m", extendedContextThreshold: 410000 }, 510000)).toBe(410000);
    expect(getExtendedContextThreshold(undefined, { default: "p,m" }, 510000)).toBe(510000);
    expect(getExtendedContextThreshold(undefined, { default: "p,m" }, undefined)).toBe(200000);
  });

  it("routes Claude Code [1m] explicitly and ignores the suffix for Pi", async () => {
    const claudeReq = routeRequest({
      model: "ccr-opus[1m]",
      metadata: { user_id: "user_x_session_explicit-extended" },
    });
    await router(claudeReq, undefined, { configService: routeConfig() });
    expect(claudeReq.body.model).toBe("provider,extended");
    expect(claudeReq.scenarioType).toBe("extendedContext");

    const piReq = routeRequest({
      model: "ccr-opus[1m]",
      system: "You are operating inside pi",
    });
    await router(piReq, undefined, { configService: routeConfig() });
    expect(piReq.body.model).toBe("provider,default");
    expect(piReq.scenarioType).toBe("default");
  });

  it("uses prior usage only for stable session-scoped clients", async () => {
    const claudeReq = routeRequest({
      model: "ccr-opus",
      metadata: { user_id: "user_x_session_usage-session" },
    });
    sessionUsageCache.put("claude-code:session:usage-session", {
      input_tokens: 210000,
      output_tokens: 0,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    });
    await router(claudeReq, undefined, { configService: routeConfig() });
    expect(claudeReq.body.model).toBe("provider,extended");

    const piReq = routeRequest({
      model: "ccr-opus",
      system: "You are operating inside pi",
    });
    sessionUsageCache.put("pi:request:route-request", {
      input_tokens: 210000,
      output_tokens: 0,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    });
    await router(piReq, undefined, { configService: routeConfig() });
    expect(piReq.body.model).toBe("provider,default");
  });
});

describe("pi uses absolute context thresholds like every other client", () => {
  // pi no longer derives extendedContextThreshold from contextWindow * ratio.
  // It inherits the absolute chain: familyConfig.extendedContextThreshold ->
  // Router.extendedContextThreshold -> 200000, and longContextThreshold inherits
  // familyConfig -> Router -> 60000.

  function piRouteConfig(overrides: Record<string, any> = {}): ConfigService {
    return new ConfigService({
      useJsonFile: false,
      initialConfig: {
        providers: [{
          name: "provider",
          enabled: true,
          models: ["default", "long", "extended"],
        }],
        // pi inherits the default extendedContextThreshold (200000) from the
        // router; ContextWindow is kept only for reference. configPath points
        // at a non-existent dir since pi no longer reads models.json.
        ContextWindow: 200000,
        Clients: {
          pi: {
            configPath: "/nonexistent/pi-test-path",
          },
        },
        Router: {
          enableFamilyRouting: true,
          longContextThreshold: 60000,
          families: {
            opus: {
              default: "provider,default",
              longContext: "provider,long",
              extendedContext: "provider,extended",
            },
          },
          ...overrides,
        },
      },
    });
  }

  function piRequest(tokenCount: number): any {
    // Generate a message with enough text to reach the desired token count.
    // In cl100k_base, "hello " is approximately 1 token per word, so repeat
    // the word roughly tokenCount times (with a small safety buffer).
    const content = "hello ".repeat(tokenCount + 10);
    return {
      id: "pi-route",
      url: "/v1/messages",
      headers: {},
      log,
      body: {
        model: "ccr-opus",
        messages: [{ role: "user", content }],
        system: "You are operating inside pi",
        tools: [],
      },
    };
  }

  it("hits longContext at absolute threshold + 1 (token=60001)", async () => {
    const req = piRequest(60001);
    await router(req, undefined, { configService: piRouteConfig() });
    expect(req.scenarioType).toBe("longContext");
    expect(req.body.model).toBe("provider,long");
  });

  it("does NOT hit longContext when token > contextWindow*30% but under absolute threshold", async () => {
    // With a high absolute longContextThreshold (e.g. 200000), a token count
    // of 100000 is under it — so long must NOT fire. 100000 is also under the
    // extended threshold (default 200000), so extended should not fire either.
    // The request falls through to default.
    const req = piRequest(100000);
    const config = piRouteConfig({ longContextThreshold: 200000 });
    await router(req, undefined, { configService: config });
    expect(req.scenarioType).not.toBe("longContext");
    expect(req.scenarioType).toBe("default");
    expect(req.body.model).toBe("provider,default");
  });

  it("hits extendedContext when token > global extendedContextThreshold (200000)", async () => {
    // pi inherits the default extendedContextThreshold of 200000.
    // token=200001 > 200000 -> extended.
    const req = piRequest(200001);
    await router(req, undefined, { configService: piRouteConfig() });
    expect(req.scenarioType).toBe("extendedContext");
    expect(req.body.model).toBe("provider,extended");
  });

  it("extended takes priority over long when both thresholds are exceeded", async () => {
    // token=500000 exceeds both longContextThreshold (60000) and the
    // extendedContextThreshold (default 200000). Extended must win because
    // it is checked first in resolveFamilyModel.
    const req = piRequest(500000);
    await router(req, undefined, { configService: piRouteConfig() });
    expect(req.scenarioType).toBe("extendedContext");
    expect(req.body.model).toBe("provider,extended");
  });

  it("inherits familyConfig.longContextThreshold when Router.longContextThreshold is absent", async () => {
    // Family-level threshold takes precedence over the global default.
    const config = new ConfigService({
      useJsonFile: false,
      initialConfig: {
        providers: [{
          name: "provider",
          enabled: true,
          models: ["default", "long", "extended"],
        }],
        ContextWindow: 200000,
        Clients: {
          pi: {
            configPath: "/nonexistent/pi-test-path",
          },
        },
        Router: {
          enableFamilyRouting: true,
          families: {
            opus: {
              default: "provider,default",
              longContext: "provider,long",
              extendedContext: "provider,extended",
              longContextThreshold: 100000,
            },
          },
        },
      },
    });
    // token=50000 < 100000 (family threshold) -> default
    const reqBelow = piRequest(50000);
    await router(reqBelow, undefined, { configService: config });
    expect(reqBelow.scenarioType).toBe("default");

    // token=100001 > 100000 (family threshold) -> long
    const reqAbove = piRequest(100001);
    await router(reqAbove, undefined, { configService: config });
    expect(reqAbove.scenarioType).toBe("longContext");
    expect(reqAbove.body.model).toBe("provider,long");
  });
});

describe("pi ignores stale [1m] suffix from legacy takeover", () => {
  // Regression guard: an already-managed pi install may still carry the legacy
  // `ccr-opus[1m]` alias. The pi adapter declares supportsExplicitExtendedContext
  // = false, so the router must NOT let the stray suffix force extendedContext
  // on a small request — it must route to default until the token count
  // genuinely crosses the absolute extended threshold (default 200000).

  function piRouteConfig(): ConfigService {
    return new ConfigService({
      useJsonFile: false,
      initialConfig: {
        providers: [{
          name: "provider",
          enabled: true,
          models: ["default", "long", "extended"],
        }],
        ContextWindow: 400000,
        Clients: {
          pi: {
            configPath: "/nonexistent/pi-test-path",
            // Stale ratio config: must be ignored now that pi inherits the
            // absolute extendedContextThreshold. Kept to guard the regression.
            routing: { extendedContextRatio: 0.8 },
          },
        },
        Router: {
          enableFamilyRouting: true,
          longContextThreshold: 60000,
          families: {
            opus: {
              default: "provider,default",
              longContext: "provider,long",
              extendedContext: "provider,extended",
              enableExtendedContext: true,
            },
          },
        },
      },
    });
  }

  it("routes a small ccr-opus[1m] request to default, not extendedContext", async () => {
    const req = {
      id: "pi-stale-1m",
      url: "/v1/messages",
      headers: { "user-agent": "pi-coding-agent", "x-stainless-package-version": "1.0" },
      log,
      body: {
        model: "ccr-opus[1m]",
        messages: [{ role: "user", content: "hi" }],
        system: "You are operating inside pi",
        tools: [],
      },
    };
    await router(req, undefined, { configService: piRouteConfig() });
    expect(req.clientType).toBe("pi");
    expect(req.clientContext.supportsExplicitExtendedContext).toBe(false);
    expect(req.scenarioType).toBe("default");
    expect(req.body.model).toBe("provider,default");
  });

  it("still allows extendedContext for pi via token threshold despite no [1m]", async () => {
    // extendedContextThreshold inherits the default 200000. A request above
    // that must route to extended even though pi carries no explicit suffix.
    const content = "hello ".repeat(320001 + 10);
    const req = {
      id: "pi-stale-big",
      url: "/v1/messages",
      headers: { "user-agent": "pi-coding-agent", "x-stainless-package-version": "1.0" },
      log,
      body: {
        model: "ccr-opus",
        messages: [{ role: "user", content }],
        system: "You are operating inside pi",
        tools: [],
      },
    };
    await router(req, undefined, { configService: piRouteConfig() });
    expect(req.scenarioType).toBe("extendedContext");
    expect(req.body.model).toBe("provider,extended");
  });
});
