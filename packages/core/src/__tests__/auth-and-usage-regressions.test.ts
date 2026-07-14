import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock provider-health/quota/fallback-promotion so router() can run in isolation.
vi.mock("../services/provider-health", () => ({
  getHealthStore: () => ({ isAvailable: () => true }),
}));
vi.mock("../services/quota-store", () => ({ getQuotaResult: () => undefined }));
vi.mock("../utils/fallback-promotion", () => ({
  getFallbackPromotionStore: () => ({ getPromotion: () => null, clear: vi.fn() }),
}));

// Control project Router resolution without touching ~/.claude.
const { mockReadFile, mockOpendir, mockStat } = vi.hoisted(() => ({
  mockReadFile: vi.fn(),
  mockOpendir: vi.fn(),
  mockStat: vi.fn(),
}));
vi.mock("fs/promises", () => ({
  readFile: mockReadFile,
  opendir: mockOpendir,
  stat: mockStat,
}));

import { createCcrPreHandlerCallbacks } from "../ccr/request-pipeline";
import { sessionUsageCache } from "../utils/cache";
import Server from "../server";

const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

function setupProjectRouter(sessionId: string, projectRouter: Record<string, any> | null) {
  mockOpendir.mockResolvedValue({
    async *[Symbol.asyncIterator]() {
      yield { isDirectory: () => true, name: "test-project-regression" };
    },
  });
  mockStat.mockResolvedValue({ isFile: () => true });
  mockReadFile.mockImplementation(async (path: string) => {
    if (typeof path === "string" && path.includes("config.json")) {
      return JSON.stringify({ Router: projectRouter });
    }
    if (typeof path === "string" && path.endsWith(`${sessionId}.json`)) {
      return JSON.stringify({});
    }
    return JSON.stringify({});
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("auth phase does not hang on auth failure", () => {
  // Regression: apiKeyAuth replies directly (reply.send) on auth-failure paths
  // without invoking `done`. The Promise wrapper must settle on the auth
  // function's own resolution, not only on `done`, otherwise the hook Promise
  // stays pending forever in a real HTTP server and leaks the request context.

  it("resolves (no hang) when the API key is missing on a remote request", async () => {
    const config = {
      Providers: [{ name: "p", api_base_url: "x", api_key: "k", models: ["m"] }],
      APIKEY: "secret",
    };
    const callbacks = createCcrPreHandlerCallbacks(config as any);

    const reply: any = {
      sent: false,
      status(code: number) {
        this.__code = code;
        return this;
      },
      send(body: any) {
        this.sent = true;
        this.__body = body;
        return this;
      },
      log,
    };
    const req: any = {
      ip: "203.0.113.7", // non-local -> auth required
      url: "/v1/messages",
      headers: {}, // no auth header
    };

    // If the wrapper hung, this race would reject with "hung" after the timeout.
    await expect(
      Promise.race([
        callbacks.authCodex(req, reply),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("authCodex hung on auth failure")), 1000)
        ),
      ])
    ).resolves.toBeUndefined();

    expect(reply.sent).toBe(true);
    expect(reply.__code).toBe(401);
  });

  it("resolves (no hang) when the API key mismatches on a remote request", async () => {
    const config = {
      Providers: [{ name: "p", api_base_url: "x", api_key: "k", models: ["m"] }],
      APIKEY: "secret",
    };
    const callbacks = createCcrPreHandlerCallbacks(config as any);

    const reply: any = {
      sent: false,
      status(code: number) { this.__code = code; return this; },
      send() { this.sent = true; return this; },
      log,
    };
    const req: any = {
      ip: "203.0.113.8",
      url: "/v1/messages",
      headers: { authorization: "Bearer wrong" },
    };

    await expect(
      Promise.race([
        callbacks.authCodex(req, reply),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("authCodex hung on key mismatch")), 1000)
        ),
      ])
    ).resolves.toBeUndefined();

    expect(reply.sent).toBe(true);
    expect(reply.__code).toBe(401);
  });
});

describe("router failure preserves prior session usage", () => {
  // Regression: the namespace preHandler used to clear the sessionUsageCache
  // slot in a `finally` around router(). A ProjectRoutingError thrown by
  // router() would then wipe the previous successful request's usage, so the
  // next request in the same session lost its longContext/extendedContext
  // baseline. The slot must only be cleared after a successful routing.

  it("keeps prior session usage when a project routing error is thrown", async () => {
    const sessionId = "regression-keep-usage";
    setupProjectRouter(sessionId, {
      default: "disabled-provider,some-model",
      enableFallback: false,
      enableFamilyRouting: false,
    });

    // Seed the session slot as if a prior successful request captured usage.
    sessionUsageCache.put("claude-code:session:" + sessionId, {
      input_tokens: 120000,
      output_tokens: 500,
      cache_read_input_tokens: 30000,
      cache_creation_input_tokens: 1000,
    });

    const server = new Server({
      logger: false,
      useJsonFile: false,
      initialConfig: {
        providers: [
          { name: "disabled-provider", enabled: false, models: ["some-model"] },
        ],
        Router: { default: "disabled-provider,some-model" },
      },
    });
    await server.ready();
    server.ccrPreHandlerCallbacks = {
      authCodex: async () => {},
      agent: async () => {},
    };
    await server.registerNamespace("/");
    await server.app.ready();

    try {
      const response = await server.app.inject({
        method: "POST",
        url: "/v1/messages",
        payload: {
          model: "ccr-opus",
          messages: [{ role: "user", content: "hello" }],
          stream: false,
          metadata: { user_id: `user_abc_session_${sessionId}` },
        },
      });

      // The project default points at a disabled provider -> ProjectRoutingError.
      expect(response.statusCode).toBe(503);
      const body = JSON.parse(response.body);
      expect(body.error.code).toBe("provider_disabled");

      // The prior session usage must survive the routing failure so the next
      // request in this session still has its context baseline.
      const kept = sessionUsageCache.get("claude-code:session:" + sessionId);
      expect(kept?.input_tokens).toBe(120000);
      expect(kept?.cache_read_input_tokens).toBe(30000);
    } finally {
      sessionUsageCache.delete("claude-code:session:" + sessionId);
      await server.app.close();
    }
  });
});
