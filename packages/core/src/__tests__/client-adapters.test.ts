import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  applyClientAdapter,
  builtinClientAdapterRegistry,
  clearClientAdapterCaches,
  detectClientType,
} from "../clients/adapters";

const tempDirs: string[] = [];

function createTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "ccr-client-adapter-"));
  tempDirs.push(dir);
  return dir;
}

function request(overrides: Record<string, any> = {}): any {
  return {
    id: "request-1",
    url: "/v1/messages",
    headers: {},
    body: { model: "ccr-opus", messages: [] },
    ...overrides,
  };
}

afterEach(() => {
  clearClientAdapterCaches();
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("builtin client adapter registry", () => {
  it("contains every persisted client type", () => {
    expect(Object.keys(builtinClientAdapterRegistry)).toEqual([
      "claude-code",
      "pi",
      "qwen-code",
      "opencode",
      "codex",
      "api",
      "unknown",
    ]);
  });

  it("preserves the legacy detection priority", () => {
    expect(detectClientType(request({
      headers: {
        "user-agent": "claude-cli/9.9",
        "x-anthropic-billing-header": "cc_version=9.9",
      },
      body: {
        model: "ccr-opus",
        system: [{ type: "text", text: "You are Qwen Code, an interactive CLI agent" }],
        metadata: { user_id: "user_x_session_claude-session" },
      },
    }))).toBe("qwen-code");

    expect(detectClientType(request({
      headers: { "user-agent": "claude-cli/9.9" },
      body: {
        model: "ccr-opus",
        system: [{ type: "text", text: "You are operating inside pi as a coding agent harness" }],
      },
    }))).toBe("pi");

    expect(detectClientType(request({
      headers: { "x-anthropic-billing-header": "cc_version=9.9" },
    }))).toBe("claude-code");

    expect(detectClientType(request({
      url: "/v1/responses",
      body: { model: "gpt-5", input: [] },
    }))).toBe("codex");

    // Codex strong signals must beat the generic metadata.user_id heuristic:
    // a /v1/responses (or codex UA) request carrying an OpenAI-style
    // metadata.user_id must still classify as codex so account selection runs.
    expect(detectClientType(request({
      url: "/v1/responses",
      body: { model: "gpt-5", input: [], metadata: { user_id: "user_abc_session_xyz" } },
    }))).toBe("codex");
    expect(detectClientType(request({
      headers: { "user-agent": "codex-cli/1.0" },
      body: { model: "gpt-5", metadata: { user_id: "user_abc_session_xyz" } },
    }))).toBe("codex");
  });
});

describe("applyClientAdapter", () => {
  it("uses a stable Claude Code metadata session across requests", () => {
    const first = request({
      id: "request-a",
      headers: { "x-anthropic-billing-header": "cc_version=1" },
      body: {
        model: "ccr-opus[1m]",
        messages: [],
        metadata: { user_id: JSON.stringify({ session_id: "stable-session" }) },
      },
    });
    const second = request({
      id: "request-b",
      headers: { "x-anthropic-billing-header": "cc_version=1" },
      body: {
        model: "ccr-opus[1m]",
        messages: [],
        metadata: { user_id: "user_x_session_stable-session" },
      },
    });

    applyClientAdapter(first, {});
    applyClientAdapter(second, {});

    expect(first.clientContext.usageScope).toBe("session");
    expect(first.sessionId).toBe("stable-session");
    expect(first.usageSessionId).toBe("stable-session");
    expect(first.usageCacheKey).toBe("claude-code:session:stable-session");
    expect(second.usageCacheKey).toBe(first.usageCacheKey);
  });

  it("allows qwen session scope only with stable metadata", () => {
    const stable = request({
      id: "qwen-a",
      headers: { "user-agent": "QwenCode/1.0" },
      body: {
        model: "ccr-opus[1m]",
        messages: [],
        metadata: { user_id: { session_id: "qwen-stable" } },
      },
    });
    const unstable = request({
      id: "qwen-b",
      headers: { "user-agent": "QwenCode/1.0" },
    });

    applyClientAdapter(stable, {});
    applyClientAdapter(unstable, {});

    expect(stable.clientContext.usageScope).toBe("session");
    expect(stable.usageCacheKey).toBe("qwen-code:session:qwen-stable");
    expect(unstable.clientContext.usageScope).toBe("request");
    expect(unstable.sessionId).toBeUndefined();
    expect(unstable.usageCacheKey).toBe("qwen-code:request:qwen-b");
  });

  it("namespaces identical stable session ids by client", () => {
    const claude = request({
      id: "claude-shared",
      headers: { "x-anthropic-billing-header": "cc_version=1" },
      body: {
        model: "ccr-opus",
        messages: [],
        metadata: { user_id: "user_x_session_shared-session" },
      },
    });
    const qwen = request({
      id: "qwen-shared",
      headers: { "user-agent": "QwenCode/1.0" },
      body: {
        model: "ccr-opus",
        messages: [],
        system: "You are Qwen Code, an interactive CLI agent",
        metadata: { user_id: "user_x_session_shared-session" },
      },
    });

    applyClientAdapter(claude, {});
    applyClientAdapter(qwen, {});

    expect(claude.usageSessionId).toBe("shared-session");
    expect(qwen.usageSessionId).toBe("shared-session");
    expect(claude.usageCacheKey).toBe("claude-code:session:shared-session");
    expect(qwen.usageCacheKey).toBe("qwen-code:session:shared-session");
  });

  it.each([
    ["pi", { body: { model: "ccr-opus", messages: [], system: "You are operating inside pi" } }],
    ["opencode", { body: { model: "ccr-opus", messages: [], system: "You are opencode" } }],
    ["codex", { url: "/v1/responses", body: { model: "gpt-5", input: [] } }],
    ["api", { body: { model: "plain-model", messages: [] } }],
    ["unknown", { url: "/health", body: {} }],
  ])("keeps %s request-scoped", (clientType, overrides) => {
    const req = request({ id: `${clientType}-request`, ...overrides });
    applyClientAdapter(req, {});

    expect(req.clientType).toBe(clientType);
    expect(req.clientContext.usageScope).toBe("request");
    expect(req.sessionId).toBeUndefined();
    expect(req.usageCacheKey).toBe(`${clientType}:request:${clientType}-request`);
  });

  it("uses Pi models.json contextWindow, strips suffix semantics, and validates ratios", () => {
    const configDir = createTempDir();
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, "models.json"), JSON.stringify({
      providers: {
        ccr: {
          models: [
            { id: "ccr-opus", contextWindow: 500000 },
            { id: "ccr-sonnet", contextWindow: 300000 },
          ],
        },
      },
    }));
    const config = {
      ContextWindow: 200000,
      Clients: {
        pi: {
          configPath: configDir,
          modelAlias: "ccr-opus[1m]",
          routing: {
            extendedContextRatio: 0.75,
          },
        },
      },
    };
    const req = request({
      id: "pi-context",
      body: {
        model: "ccr-opus[1m]",
        messages: [],
        system: "You are operating inside pi",
      },
    });

    applyClientAdapter(req, config);

    expect(req.clientContext).toMatchObject({
      clientType: "pi",
      usageScope: "request",
      supportsExplicitExtendedContext: false,
      contextWindow: 500000,
      extendedContextThreshold: 375000,
    });
    // longContextThreshold must NOT be set by the pi adapter — it inherits the
    // absolute threshold chain (familyConfig -> Router -> 60000) in the router.
    expect(req.clientContext.longContextThreshold).toBeUndefined();

    expect(() => applyClientAdapter(request({
      id: "pi-invalid",
      body: {
        model: "ccr-opus",
        messages: [],
        system: "You are operating inside pi",
      },
    }), {
      Clients: {
        pi: {
          configPath: configDir,
          routing: { extendedContextRatio: 1.5 },
        },
      },
    })).toThrow(/extendedContextRatio must be a finite number/);

    expect(() => applyClientAdapter(request({
      id: "pi-unknown-key",
      body: {
        model: "ccr-opus",
        messages: [],
        system: "You are operating inside pi",
      },
    }), {
      Clients: {
        pi: {
          configPath: configDir,
          routing: { extraRatio: 0.5 },
        },
      },
    })).toThrow(/unsupported field: extraRatio/);
  });

  it("refreshes Pi contextWindow when models.json mtime changes", async () => {
    const configDir = createTempDir();
    const modelsPath = join(configDir, "models.json");
    writeFileSync(modelsPath, JSON.stringify({
      providers: { ccr: { models: [{ id: "ccr-opus", contextWindow: 200000 }] } },
    }));
    const config = { Clients: { pi: { configPath: configDir } } };
    const first = request({
      id: "pi-first",
      body: { model: "ccr-opus", messages: [], system: "You are operating inside pi" },
    });
    applyClientAdapter(first, config);
    expect(first.clientContext.contextWindow).toBe(200000);

    await new Promise((resolve) => setTimeout(resolve, 20));
    writeFileSync(modelsPath, JSON.stringify({
      providers: { ccr: { models: [{ id: "ccr-opus", contextWindow: 400000 }] } },
    }));
    const second = request({
      id: "pi-second",
      body: { model: "ccr-opus", messages: [], system: "You are operating inside pi" },
    });
    applyClientAdapter(second, config);
    expect(second.clientContext.contextWindow).toBe(400000);
  });
});
