import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock external dependencies before importing the module under test.
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

import { ConfigService } from "../services/config";
import { router } from "../utils/router";
import {
  getConcurrencyTracker,
  getSessionBindingStore,
  getRequestSlotKey,
  releaseRequestLease,
  resetConcurrencyPriorityState,
} from "../utils/concurrency-router";

const log = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

function routeConfig(): ConfigService {
  return new ConfigService({
    useJsonFile: false,
    initialConfig: {
      providers: [
        {
          name: "provider",
          enabled: true,
          models: ["primary", "fallback", "think", "thinkFallback"],
        },
      ],
      Router: {
        default: "provider,primary",
        think: "provider,think",
        enableConcurrencyPriority: true,
        concurrencyThreshold: 2,
        fallback: {
          default: ["provider,fallback"],
          think: ["provider,thinkFallback"],
        },
      },
    },
  });
}

// Claude Code adapter extracts the session id from metadata.user_id; encoding
// it as a JSON object makes a stable, valid session id ("SESS-x").
function claudeRequest(sessionId: string, overrides: Record<string, any> = {}): any {
  return {
    id: `req-${sessionId}`,
    url: "/v1/messages",
    headers: { "user-agent": "claude-cli/1.0" },
    log,
    body: {
      model: "claude-sonnet-4-20250514",
      messages: [{ role: "user", content: "hi" }],
      system: [],
      tools: [],
      metadata: {
        user_id: JSON.stringify({ session_id: sessionId }),
      },
      ...overrides,
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  resetConcurrencyPriorityState();
});

describe("router() concurrency-priority integration", () => {
  it("overflows a new session to the fallback model once the primary reaches the threshold", async () => {
    const tracker = getConcurrencyTracker();
    // Two in-flight requests on the primary (threshold = 2) from other sessions.
    const l1 = tracker.acquire("provider,primary");
    const l2 = tracker.acquire("provider,primary");

    const req = claudeRequest("SESS-overflow");
    await router(req, undefined, { configService: routeConfig() });

    expect(req.body.model).toBe("provider,fallback");
    expect(
      getSessionBindingStore().get(getRequestSlotKey(req))
    ).toBe("provider,fallback");

    releaseRequestLease(req);
    tracker.release(l1);
    tracker.release(l2);
  });

  it("sticks a session to its bound fallback model after congestion clears", async () => {
    const tracker = getConcurrencyTracker();
    // Force the first request to overflow.
    const leases = [
      tracker.acquire("provider,primary"),
      tracker.acquire("provider,primary"),
    ];
    const req1 = claudeRequest("SESS-sticky");
    await router(req1, undefined, { configService: routeConfig() });
    expect(req1.body.model).toBe("provider,fallback");
    releaseRequestLease(req1);
    leases.forEach((l) => tracker.release(l));

    // Primary congestion is now gone; the session must still use the fallback.
    const req2 = claudeRequest("SESS-sticky");
    await router(req2, undefined, { configService: routeConfig() });
    expect(req2.body.model).toBe("provider,fallback");
    releaseRequestLease(req2);
  });

  it("uses the primary model for a fresh session when below the threshold", async () => {
    const req = claudeRequest("SESS-fresh");
    await router(req, undefined, { configService: routeConfig() });
    expect(req.body.model).toBe("provider,primary");
    expect(
      getSessionBindingStore().get(getRequestSlotKey(req))
    ).toBe("provider,primary");
    releaseRequestLease(req);
  });

  it("overflows think-scenario traffic via the think fallback list when the think model is congested", async () => {
    const tracker = getConcurrencyTracker();
    // Congest the think model (threshold = 2). Default traffic stays unaffected.
    const leases = [
      tracker.acquire("provider,think"),
      tracker.acquire("provider,think"),
    ];

    const req = claudeRequest("SESS-think", {
      thinking: { type: "enabled", budget_tokens: 1024 },
    });
    await router(req, undefined, { configService: routeConfig() });

    expect(req.scenarioType).toBe("think");
    expect(req.body.model).toBe("provider,thinkFallback");
    expect(
      getSessionBindingStore().get(getRequestSlotKey(req))
    ).toBe("provider,thinkFallback");

    releaseRequestLease(req);
    leases.forEach((l) => tracker.release(l));
  });

  it("does not apply concurrency routing to explicit provider,model requests", async () => {
    const tracker = getConcurrencyTracker();
    // Congest the explicitly-requested model (threshold = 2).
    const leases = [
      tracker.acquire("provider,fallback"),
      tracker.acquire("provider,fallback"),
    ];

    // Explicit "provider,model" pins are honored as-is: no overflow, no binding.
    const req = claudeRequest("SESS-explicit");
    req.body.model = "provider,fallback";
    await router(req, undefined, { configService: routeConfig() });

    expect(req.body.model).toBe("provider,fallback");
    expect(
      getSessionBindingStore().get(getRequestSlotKey(req))
    ).toBeUndefined();

    leases.forEach((l) => tracker.release(l));
  });

  it("lets the <CCR-SUBAGENT-MODEL> override win over session stickiness", async () => {
    // Bind the session's default slot to the primary, as the parent session
    // traffic would have done.
    getSessionBindingStore().bind("SESS-sub::default", "provider,primary");

    const req = claudeRequest("SESS-sub");
    req.body.system = [
      { type: "text", text: "head" },
      {
        type: "text",
        text: "ctx <CCR-SUBAGENT-MODEL>provider,fallback</CCR-SUBAGENT-MODEL> tail",
      },
    ];
    await router(req, undefined, { configService: routeConfig() });

    // The subagent override must be used verbatim — stickiness must NOT
    // replace it with the bound slot model.
    expect(req.body.model).toBe("provider,fallback");
    expect(req.body.system[1].text).not.toContain("<CCR-SUBAGENT-MODEL>");
    // The parent slot binding must not be poisoned by the subagent request.
    expect(getSessionBindingStore().get("SESS-sub::default")).toBe(
      "provider,primary"
    );
  });
});
