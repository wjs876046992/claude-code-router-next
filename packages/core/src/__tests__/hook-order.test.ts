import { describe, expect, it, vi } from "vitest";
import Server from "../server";
import { sessionUsageCache } from "../utils/cache";

const EXPECTED_PHASES = [
  "request-normalize",
  "adapter",
  "auth-codex",
  "agent",
  "router",
  "provider-model-normalize",
  "handler",
];

describe("CCR request pipeline order", () => {
  it("executes pre-handler phases explicitly before the handler", async () => {
    const server = new Server({
      logger: false,
      useJsonFile: false,
      initialConfig: {
        providers: [{
          name: "demo",
          api_base_url: "https://example.com/v1/messages",
          api_key: "test",
          models: ["model-a"],
        }],
        Router: { default: "demo,model-a" },
      },
    });
    await server.ready();

    server.ccrPreHandlerCallbacks = {
      authCodex: async (_req: any) => {},
      agent: async (_req: any) => {},
    };

    const observedPhases: Record<string, string[]> = {};
    let observed: string[] = [];
    server.addHook("preHandler", async (req: any) => {
      observedPhases[req.id] = [...(req.ccrHookOrder || [])];
    });
    server.addHook("onSend", async (req: any, _reply: any, payload: any) => {
      observed = [...(req.ccrHookOrder || []), "onSend"];
      return payload;
    });
    server.addHook("onResponse", async (req: any, _reply: any) => {
      observed = [...(req.ccrHookOrder || []), "onSend", "onResponse"];
    });

    await server.registerNamespace("/");
    await server.app.ready();

    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({
      id: "chatcmpl-test",
      object: "chat.completion",
      model: "model-a",
      choices: [{
        index: 0,
        message: { role: "assistant", content: "ok" },
        finish_reason: "stop",
      }],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as any;

    try {
      const response = await server.app.inject({
        method: "POST",
        url: "/v1/messages",
        payload: {
          model: "ccr-opus",
          messages: [{ role: "user", content: "hello" }],
          stream: false,
        },
      });
      if (response.statusCode !== 200) {
        console.error("Non-200 response:", response.statusCode, response.body);
      }
      expect(response.statusCode).toBe(200);
      console.error("OBSERVED:", JSON.stringify(observed));
      // handler→onSend→onResponse all observe ccrHookOrder.
      expect(observed).toEqual([...EXPECTED_PHASES, "onSend", "onResponse"]);
    } finally {
      globalThis.fetch = originalFetch;
      await server.app.close();
    }
  });

  it("isolates request-scoped usage cache keys and clears them after use", () => {
    sessionUsageCache.put("pi:request:req-a", {
      input_tokens: 10,
      output_tokens: 1,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    });
    sessionUsageCache.put("opencode:request:req-a", {
      input_tokens: 20,
      output_tokens: 2,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    });

    expect(sessionUsageCache.get("pi:request:req-a")?.input_tokens).toBe(10);
    expect(sessionUsageCache.get("opencode:request:req-a")?.input_tokens).toBe(20);
    expect(sessionUsageCache.delete("pi:request:req-a")).toBe(true);
    expect(sessionUsageCache.get("pi:request:req-a")).toBeUndefined();
    expect(sessionUsageCache.get("opencode:request:req-a")?.input_tokens).toBe(20);
    sessionUsageCache.delete("opencode:request:req-a");
  });
});
