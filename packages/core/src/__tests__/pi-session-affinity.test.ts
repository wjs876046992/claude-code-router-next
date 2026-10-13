// Pi stable session affinity tests.
//
// Pi advertises its stable conversation id through session-affinity headers
// (x-session-affinity from the managed compat flag, plus generic carriers).
// The client adapter must surface it as stableSessionId so the concurrency
// router can build sticky bindings, while keeping usage bookkeeping
// request-scoped (Pi issues parallel requests within one session). The
// outbound path must translate the id into LiteLLM's x-litellm-session-id
// carrier and never leak the raw inbound headers upstream.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
import { stampUpstreamSessionId } from "../api/routes";
import {
  applyClientAdapter,
  detectClientType,
} from "../clients/adapters";
import {
  getConcurrencyTracker,
  getSessionBindingStore,
  getRequestSlotKey,
  releaseRequestLease,
  resetConcurrencyPriorityState,
} from "../utils/concurrency-router";


const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

// Minimal request factory for cross-client detection assertions (mirrors the
// helper in client-adapters.test.ts but kept local to avoid cross-file imports).
function bareRequest(overrides: Record<string, any> = {}): any {
  return {
    id: `bare-${Math.random().toString(36).slice(2, 8)}`,
    url: "/v1/messages",
    headers: {},
    log,
    body: { model: "ccr-opus", messages: [] },
    ...overrides,
  };
}

function piRequest(sessionId: string | undefined, overrides: Record<string, any> = {}): any {
  const headers: Record<string, any> = {
    "user-agent": "pi-coding-agent",
    "x-stainless-package-version": "1.0",
    ...(sessionId ? { "x-session-affinity": sessionId } : {}),
    ...(overrides.headers || {}),
  };
  delete overrides.headers;
  return {
    id: `pi-req-${Math.random().toString(36).slice(2, 8)}`,
    url: "/v1/messages",
    headers,
    log,
    body: {
      model: "claude-sonnet-4-20250514",
      messages: [{ role: "user", content: "hi" }],
      system: "You are operating inside pi",
      tools: [],
      ...overrides,
    },
  };
}

function concurrencyConfig(): ConfigService {
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

beforeEach(() => {
  vi.clearAllMocks();
  resetConcurrencyPriorityState();
});

afterEach(() => {
  // Pi usage bookkeeping is request-scoped; nothing session-keyed is cached.
  resetConcurrencyPriorityState();
});

describe("pi session affinity adapter", () => {
  it("extracts a stable session id from the affinity header and keeps request-scoped usage", () => {
    const req = piRequest("0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d");
    applyClientAdapter(req, {});

    expect(req.clientType).toBe("pi");
    expect(req.clientContext.stableSessionId).toBe("0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d");
    expect(req.clientContext.usageScope).toBe("request");
    expect(req.sessionId).toBe("0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d");
    // Usage stays request-scoped so parallel streams never overwrite each
    // other's partial usage frames in sessionUsageCache.
    expect(req.clientContext.usageScope).toBe("request");
    expect(req.usageSessionId).toBe(req.id);
    expect(req.usageCacheKey).toBe(`pi:request:${req.id}`);
  });

  it("recognizes pi from the affinity header alone", () => {
    // A gateway-style request with no pi system prompt or UA must still be
    // identified as pi when it carries the affinity carrier, so the id is
    // honored instead of falling through to claude-code/api classification.
    const req = piRequest("sess-12345678", {
      headers: { "user-agent": "custom-client/1.0" },
    });
    req.body.system = undefined;
    expect(detectClientType(req)).toBe("pi");
  });

  it("prefers the affinity header over generic carriers and metadata", () => {
    const req = piRequest("affinity-session", {
      headers: {
        "x-session-id": "generic-session",
        "x-litellm-session-id": "litellm-session",
      },
    });
    req.body.metadata = { user_id: "user_x_session_metadata-session" };

    applyClientAdapter(req, {});
    expect(req.clientContext.stableSessionId).toBe("affinity-session");
  });

  it("falls back to the vendor-less session id header when no affinity header exists", () => {
    const req = piRequest(undefined, {
      headers: { "x-session-id": "fallback-session" },
    });
    applyClientAdapter(req, {});
    expect(req.clientContext.stableSessionId).toBe("fallback-session");
  });

  it("falls back to Claude-Code-style metadata.user_id before giving up", () => {
    const req = piRequest(undefined);
    req.body.metadata = { user_id: JSON.stringify({ session_id: "meta-session" }) };
    applyClientAdapter(req, {});
    expect(req.clientContext.stableSessionId).toBe("meta-session");
  });

  it("rejects invalid header values and stays request-scoped", () => {
    for (const bad of ["../etc/passwd", "", "   ", "has space", "a".repeat(257)]) {
      const req = piRequest(bad);
      applyClientAdapter(req, {});
      expect(req.clientContext.stableSessionId).toBeUndefined();
      expect(req.sessionId).toBeUndefined();
    }
  });

  it("strips the inbound affinity headers so they never leak upstream", () => {
    const req = piRequest("sess-abcd1234", {
      headers: { "x-litellm-session-id": "already-stamped" },
    });
    applyClientAdapter(req, {});
    expect(req.headers["x-session-affinity"]).toBeUndefined();
    expect(req.headers["x-session-id"]).toBeUndefined();
    expect(req.headers["x-litellm-session-id"]).toBeUndefined();
    // Case-variant carriers are stripped too.
    const cased = piRequest("sess-abcd1234", {
      headers: { "X-Session-Affinity": "sess-abcd1234" },
    });
    applyClientAdapter(cased, {});
    expect(cased.headers["X-Session-Affinity"]).toBeUndefined();
  });

  it("keeps requests without any session carrier request-scoped", () => {
    const req = piRequest(undefined);
    applyClientAdapter(req, {});
    expect(req.clientContext.stableSessionId).toBeUndefined();
    expect(req.usageScope_label_check).toBeUndefined();
    expect(req.usageCacheKey).toBe(`pi:request:${req.id}`);
  });

  it("does not reclassify other clients from generic session headers", () => {
    // x-session-id / x-litellm-session-id are generic carriers also sent by
    // Codex, ZCode and LiteLLM-fronted clients. They must never override the
    // strong identity signals of those clients (regression guard).
    const codex = bareRequest({
      url: "/v1/responses",
      headers: { "user-agent": "codex-cli/1.0", "x-session-id": "sess-12345678" },
      body: { model: "gpt-5", input: [] },
    });
    expect(detectClientType(codex)).toBe("codex");

    const zcode = bareRequest({
      headers: {
        "user-agent": "ZCode/3.11.2 ai-sdk/anthropic/2.0.0",
        "x-zcode-app-version": "3.11.2",
        "x-session-id": "sess-12345678",
      },
      body: {
        model: "ccr-opus",
        metadata: { user_id: JSON.stringify({ session_id: "zcode-session" }) },
      },
    });
    expect(detectClientType(zcode)).toBe("zcode");

    const claude = bareRequest({
      headers: {
        "user-agent": "claude-cli/9.9",
        "x-anthropic-billing-header": "cc_version=9.9",
        "x-session-id": "sess-12345678",
      },
      body: {
        model: "ccr-opus",
        metadata: { user_id: "user_x_session_claude-session" },
      },
    });
    expect(detectClientType(claude)).toBe("claude-code");

    // Generic carriers ARE consumed as data for already-identified pi requests.
    const pi = piRequest(undefined, {
      headers: { "x-litellm-session-id": "downstream-session" },
    });
    applyClientAdapter(pi, {});
    expect(pi.clientContext.stableSessionId).toBe("downstream-session");
  });

  it("keeps the stable id when the adapter is applied twice", () => {
    const req = piRequest("sess-abcd1234");
    applyClientAdapter(req, {});
    applyClientAdapter(req, {});
    expect(req.clientContext.stableSessionId).toBe("sess-abcd1234");
    expect(req.sessionId).toBe("sess-abcd1234");
  });
});

describe("upstream LiteLLM session id stamping", () => {
  it("stamps the stable session id as x-litellm-session-id", () => {
    const req = piRequest("sess-abcd1234");
    applyClientAdapter(req, {});
    const headers: Record<string, string> = {
      Authorization: "Bearer key",
      "X-Litellm-Session-Id": "shadow-value",
    };
    stampUpstreamSessionId(headers, req);
    expect(headers["x-litellm-session-id"]).toBe("sess-abcd1234");
    // Case-variant shadow stamps are removed so the stable id wins.
    expect(headers["X-Litellm-Session-Id"]).toBeUndefined();
  });

  it("does not invent a header without a stable session id", () => {
    const req = piRequest(undefined);
    applyClientAdapter(req, {});
    const headers: Record<string, string> = { Authorization: "Bearer key" };
    stampUpstreamSessionId(headers, req);
    expect(headers["x-litellm-session-id"]).toBeUndefined();
  });

  it("ignores per-request ids: only real stableSessionId values are stamped", () => {
    const headers: Record<string, string> = {};
    stampUpstreamSessionId(headers, {
      id: "req-42",
      usageSessionId: "req-42",
      clientContext: { stableSessionId: undefined },
    });
    expect(headers["x-litellm-session-id"]).toBeUndefined();
  });
});

describe("upstream passthrough guard", () => {
  it("the inbound affinity headers never survive adapter application", () => {
    // sendUnifiedRequest serializes config.headers from requestHeaders; the
    // guard contract is that applyClientAdapter consumes every carrier, so
    // even a bypass-mode provider cannot forward them verbatim.
    const req = piRequest("sess-abcd1234", {
      headers: {
        "x-session-id": "generic",
        "x-litellm-session-id": "stamped-by-caller",
      },
    });
    applyClientAdapter(req, {});
    const passthroughHeaders = { ...req.headers };
    stampUpstreamSessionId(passthroughHeaders, req);
    expect(passthroughHeaders["x-session-affinity"]).toBeUndefined();
    expect(passthroughHeaders["x-session-id"]).toBeUndefined();
    expect(passthroughHeaders["x-litellm-session-id"]).toBe("sess-abcd1234");
  });
});

describe("router() concurrency-priority integration for pi sessions", () => {
  it("overflows a new pi session when the primary is congested, then sticks to the bound model", async () => {
    const tracker = getConcurrencyTracker();
    const leases = [
      tracker.acquire("provider,primary"),
      tracker.acquire("provider,primary"),
    ];

    const req1 = piRequest("PI-STICKY-SESSION");
    await router(req1, undefined, { configService: concurrencyConfig() });
    expect(req1.body.model).toBe("provider,fallback");
    const slotKey = getRequestSlotKey(req1);
    expect(slotKey).toContain("PI-STICKY-SESSION");
    expect(getSessionBindingStore().get(slotKey)).toBe("provider,fallback");
    releaseRequestLease(req1);
    leases.forEach((l) => tracker.release(l));

    // Congestion gone: the same pi session must still use the bound fallback.
    const req2 = piRequest("PI-STICKY-SESSION");
    await router(req2, undefined, { configService: concurrencyConfig() });
    expect(req2.body.model).toBe("provider,fallback");
    releaseRequestLease(req2);
  });

  it("uses the primary model for a pi session when below the threshold", async () => {
    const req = piRequest("PI-FRESH-SESSION");
    await router(req, undefined, { configService: concurrencyConfig() });
    expect(req.body.model).toBe("provider,primary");
    expect(getSessionBindingStore().get(getRequestSlotKey(req))).toBe("provider,primary");
    releaseRequestLease(req);
  });

  it("routes pi requests without a session carrier per-request without bindings", async () => {
    const req = piRequest(undefined);
    await router(req, undefined, { configService: concurrencyConfig() });
    expect(req.body.model).toBe("provider,primary");
    expect(getRequestSlotKey(req)).toBe("");
    releaseRequestLease(req);
  });

  it("keeps different pi sessions on independent slots", async () => {
    const reqA = piRequest("PI-SESSION-A");
    const reqB = piRequest("PI-SESSION-B");
    await router(reqA, undefined, { configService: concurrencyConfig() });
    await router(reqB, undefined, { configService: concurrencyConfig() });
    expect(getRequestSlotKey(reqA)).not.toBe(getRequestSlotKey(reqB));
    releaseRequestLease(reqA);
    releaseRequestLease(reqB);
  });
});
