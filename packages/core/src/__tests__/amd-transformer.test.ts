import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { AmdTransformer } from "../transformer/amd.transformer";
import { AnthropicTransformer } from "../transformer/anthropic.transformer";
import { OpenAITransformer } from "../transformer/openai.transformer";
import { Transformer } from "../types/transformer";
import Transformers from "../transformer";

function makeRequest(overrides: Record<string, any> = {}): any {
  return {
    model: "GLM-5.3-Flash",
    messages: [{ role: "user", content: "hi" }],
    max_tokens: 4096,
    ...overrides,
  };
}

function jsonResponse(payload: any): Response {
  return new Response(JSON.stringify(payload), {
    headers: { "Content-Type": "application/json" },
  });
}

function streamResponse(chunks: Array<string | Uint8Array>): Response {
  const encoder = new TextEncoder();
  let index = 0;
  return new Response(new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index === chunks.length) {
        controller.close();
      } else {
        const chunk = chunks[index++];
        controller.enqueue(typeof chunk === "string" ? encoder.encode(chunk) : chunk);
      }
    },
  }), { headers: { "Content-Type": "text/event-stream" } });
}

function sseData(text: string): any[] {
  return text.split(/\r\n|\r|\n/)
    .filter((line) => line.startsWith("data:") && line.slice(5).trim() !== "[DONE]")
    .map((line) => JSON.parse(line.slice(5)));
}

// Mirror routes.ts: reverse provider hooks first, then the /v1/messages endpoint.
async function convertProviderResponse(response: Response, use: Transformer[]): Promise<Response> {
  const endpoint = new AnthropicTransformer();
  endpoint.logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const context = { req: { id: "amd-test" } };
  for (const item of [...use].reverse()) {
    if (item.transformResponseOut) response = await item.transformResponseOut(response, context);
  }
  return endpoint.transformResponseIn(response, context);
}

describe("AmdTransformer", () => {
  let transformer: AmdTransformer;

  beforeEach(() => {
    transformer = new AmdTransformer();
  });

  describe("transformRequestIn", () => {
    it("drops the unified reasoning object that AMD 400s on", async () => {
      const req = makeRequest({
        reasoning: { enabled: true, effort: "high", max_tokens: 16000 },
      });
      const out: any = await transformer.transformRequestIn(req);
      expect(out.reasoning).toBeUndefined();
    });

    // Documented per-model enums (https://amd-aim.github.io/radeon-cloud-docs/
    // zh-cn/api/chat-completions/): DeepSeek supports
    // none|minimal|low|medium|high|xhigh|max; Qwen3.8-Flash-Next supports
    // none|low|medium|xhigh; Qwen3.8-27B supports low|medium|xhigh (both Qwen
    // models reject high); GLM supports low|medium|high.
    it.each([
      ["GLM-5.3-Flash", ["low", "low", "medium", "high", "high", "high"]],
      ["vendor/glm-5", ["low", "low", "medium", "high", "high", "high"]],
      ["Qwen3.8-Flash-Next", ["low", "low", "medium", "xhigh", "xhigh", "xhigh"]],
      ["Qwen3.8-27B", ["low", "low", "medium", "xhigh", "xhigh", "xhigh"]],
      ["vendor/qWeN", ["low", "low", "medium", "xhigh", "xhigh", "xhigh"]],
      ["DeepSeek-V4", ["minimal", "low", "medium", "high", "xhigh", "max"]],
      ["vendor/dEePsEeK", ["minimal", "low", "medium", "high", "xhigh", "max"]],
      // Unknown models only accept the generic low|medium|high ladder.
      ["unknown", ["low", "low", "medium", "high", "high", "high"]],
      ["", ["low", "low", "medium", "high", "high", "high"]],
    ])("maps the documented effort matrix for %s", async (model, expected) => {
      const inputs = ["minimal", "low", "medium", "high", "xhigh", "max"];
      for (let index = 0; index < inputs.length; index++) {
        const out: any = await transformer.transformRequestIn(makeRequest({
          model, reasoning: { enabled: true, effort: inputs[index] },
        }));
        expect(out.reasoning_effort, `${model}: ${inputs[index]}`).toBe(expected[index]);
        expect(out.reasoning).toBeUndefined();
      }
    });

    it("keeps DeepSeek native tiers and never aliases xhigh to max", async () => {
      const req = makeRequest({ model: "DeepSeek-V4", reasoning: { enabled: true, effort: "xhigh" } });
      const out: any = await transformer.transformRequestIn(req);
      expect(out.reasoning_effort).toBe("xhigh");
    });

    it("normalizes native effort fields and respects explicit disabled/none intent", async () => {
      const cases = [
        // Unified effort wins over the native top-level field.
        [{ reasoning_effort: "max" }, "xhigh"],
        [{ reasoning: { effort: "max" } }, "xhigh"],
        [{ reasoning_effort: "private-tier" }, "medium"],
        [{ reasoning_effort: "none" }, undefined],
        [{ reasoning_effort: "" }, undefined],
        [{ reasoning: { enabled: false }, reasoning_effort: "max" }, undefined],
        [{ reasoning: { enabled: true, effort: "none" }, reasoning_effort: "max" }, undefined],
        [{ reasoning: { enabled: true, effort: "" }, reasoning_effort: "max" }, undefined],
        [{ reasoning: { enabled: true }, reasoning_effort: "max" }, "xhigh"],
      ] as const;
      for (const [fields, expected] of cases) {
        const out: any = await transformer.transformRequestIn(makeRequest({ model: "Qwen", ...fields }));
        expect(out.reasoning_effort).toBe(expected);
        expect(out.reasoning).toBeUndefined();
      }
    });

    it("emits none only where the docs allow disabling thinking", async () => {
      const cases: Array<[string, string | undefined]> = [
        ["DeepSeek-V4", "none"],
        ["vendor/deepseek", "none"],
        ["Qwen3.8-Flash-Next", "none"],
        ["vendor/qwen3.8-flash-next", "none"],
        // Qwen3.8-27B has no none tier; GLM/unknown cannot disable thinking.
        ["Qwen3.8-27B", undefined],
        ["GLM-5.3-Flash", undefined],
        ["unknown", undefined],
      ];
      for (const [model, expected] of cases) {
        const disabled: any = await transformer.transformRequestIn(makeRequest({
          model, reasoning: { enabled: false },
        }));
        expect(disabled.reasoning_effort, `${model}: enabled=false`).toBe(expected);
        const none: any = await transformer.transformRequestIn(makeRequest({
          model, reasoning: { enabled: true, effort: "none" },
        }));
        expect(none.reasoning_effort, `${model}: effort=none`).toBe(expected);
      }
    });

    it("honors disable spellings when the unified reasoning object is absent", async () => {
      // Models documenting a none tier keep the disable intent.
      for (const model of ["DeepSeek-V4", "Qwen3.8-Flash-Next"]) {
        const disabled: any = await transformer.transformRequestIn(
          makeRequest({ model, enable_thinking: false })
        );
        expect(disabled.reasoning_effort, `${model}: enable_thinking=false`).toBe("none");
        const thinkingOff: any = await transformer.transformRequestIn(
          makeRequest({ model, thinking: { type: "disabled" } })
        );
        expect(thinkingOff.reasoning_effort, `${model}: thinking disabled`).toBe("none");
        expect(thinkingOff.thinking).toBeUndefined();
      }
      // Models without a none tier cannot disable thinking; the field is dropped.
      for (const model of ["GLM-5.3-Flash", "Qwen3.8-27B", "unknown"]) {
        const disabled: any = await transformer.transformRequestIn(
          makeRequest({ model, enable_thinking: false })
        );
        expect(disabled.reasoning_effort, `${model}: enable_thinking=false`).toBeUndefined();
      }
      // An explicit unified intent still wins over a disable spelling.
      const unified: any = await transformer.transformRequestIn(makeRequest({
        model: "DeepSeek-V4",
        enable_thinking: false,
        reasoning: { enabled: true, effort: "high" },
      }));
      expect(unified.reasoning_effort).toBe("high");
    });

    it("derives the effort tier from a budget-only request", async () => {
      const cases: Array<[number, string]> = [
        [512, "low"], [1024, "low"], [8192, "medium"], [16384, "high"], [32768, "max"],
      ];
      for (const [budget, expected] of cases) {
        const out: any = await transformer.transformRequestIn(makeRequest({
          model: "DeepSeek-V4", reasoning: { max_tokens: budget },
        }));
        expect(out.reasoning_effort, `budget ${budget}`).toBe(expected);
        expect(out.reasoning).toBeUndefined();
      }
    });

    it("defaults an enabled-without-effort request to medium", async () => {
      for (const model of ["DeepSeek-V4", "Qwen3.8-27B", "GLM-5.3-Flash", "unknown"]) {
        const out: any = await transformer.transformRequestIn(makeRequest({
          model, reasoning: { enabled: true },
        }));
        expect(out.reasoning_effort, model).toBe("medium");
      }
    });

    it("does not add reasoning_effort when thinking is disabled on Qwen27B/GLM", async () => {
      const req = makeRequest({ model: "Qwen3.8-27B", reasoning: { enabled: false, effort: "high" } });
      const out: any = await transformer.transformRequestIn(req);
      expect(out.reasoning_effort).toBeUndefined();
      expect(out.reasoning).toBeUndefined();
    });

    it("strips Anthropic/Qwen thinking spellings AMD rejects", async () => {
      const req = makeRequest({
        reasoning: { enabled: true, effort: "low" },
        thinking: { type: "enabled", budget_tokens: 2048 },
        enable_thinking: true,
      });
      const out: any = await transformer.transformRequestIn(req);
      expect(out.thinking).toBeUndefined();
      expect(out.enable_thinking).toBeUndefined();
      expect(out.reasoning_effort).toBe("low");
    });

    it("leaves reasoning_effort absent when no thinking intent is present", async () => {
      const out: any = await transformer.transformRequestIn(makeRequest());
      expect(out.reasoning_effort).toBeUndefined();
      expect(out.reasoning).toBeUndefined();
      expect(out.thinking).toBeUndefined();
    });

    it("uses the fallback model rather than caching the primary model ceiling", async () => {
      const original = makeRequest({ model: "GLM-5.3-Flash", reasoning: { enabled: true, effort: "max" } });
      const primary: any = await transformer.transformRequestIn(original);
      const fallback: any = await transformer.transformRequestIn({ ...original, model: "DeepSeek-V4" });
      expect(primary.reasoning_effort).toBe("high");
      expect(fallback.reasoning_effort).toBe("max");
      expect(original.reasoning.effort).toBe("max");
    });

    it("preserves messages and other request fields", async () => {
      const req = makeRequest({
        reasoning: { enabled: true, effort: "medium" },
        temperature: 0.4,
        stream: true,
      });
      const out: any = await transformer.transformRequestIn(req);
      expect(out.messages).toEqual(req.messages);
      expect(out.temperature).toBe(0.4);
      expect(out.stream).toBe(true);
      expect(out.model).toBe("GLM-5.3-Flash");
    });

    it("does not mutate the original request object", async () => {
      const req = makeRequest({ reasoning: { enabled: true, effort: "high" } });
      const snapshot = JSON.parse(JSON.stringify(req));
      await transformer.transformRequestIn(req);
      expect(req).toEqual(snapshot);
    });
  });

  describe("transformResponseOut (non-stream)", () => {
    it("rewrites message.reasoning into an Anthropic thinking block", async () => {
      const payload = {
        choices: [
          {
            message: {
              role: "assistant",
              content: "final answer",
              reasoning: "let me think",
            },
          },
        ],
      };
      const response = new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
      const out = await transformer.transformResponseOut(response);
      const json = await out.json();
      expect(json.choices[0].message.thinking).toEqual({
        content: "let me think",
      });
      expect(json.choices[0].message.reasoning).toBeUndefined();
      expect(json.choices[0].message.content).toBe("final answer");
    });

    it("passes a response without reasoning through unchanged", async () => {
      const payload = {
        choices: [{ message: { role: "assistant", content: "plain" } }],
      };
      const response = new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
      const out = await transformer.transformResponseOut(response);
      const json = await out.json();
      expect(json.choices[0].message.content).toBe("plain");
      expect(json.choices[0].message.thinking).toBeUndefined();
    });
  });

  describe("response edge cases", () => {
    it("lifts object reasoning while preserving metadata and reasoning_content", async () => {
      const payload = { choices: [{ message: {
        content: "answer", reasoning: { content: "thought", signature: "sig", extra: 1 },
        reasoning_content: "deepseek thought",
      } }] };
      const json = await (await transformer.transformResponseOut(jsonResponse(payload))).json();
      expect(json.choices[0].message).toEqual({
        content: "answer", thinking: { content: "thought", signature: "sig", extra: 1 },
        reasoning_content: "deepseek thought",
      });
    });

    it("preserves unknown reasoning objects, nulls and empty strings", async () => {
      const payload = { choices: [
        { message: { reasoning: { text: "unknown wrapper" }, content: "a" } },
        { message: { reasoning: null } }, { message: { reasoning: "" } },
        { message: { reasoning: { content: 42 } } }, { message: null }, null,
      ] };
      expect(await (await transformer.transformResponseOut(jsonResponse(payload))).json()).toEqual(payload);
    });

    it("normalizes every choice and copies DeepSeek reasoning_content without deleting it", async () => {
      const payload = { choices: [
        { index: 0, message: { reasoning: "first", content: "a" } },
        { index: 1, message: { reasoning_content: "second", content: "b" } },
      ], usage: { total_tokens: 42 } };
      const json = await (await transformer.transformResponseOut(jsonResponse(payload))).json();
      expect(json.choices[0].message.thinking.content).toBe("first");
      expect(json.choices[1].message.thinking.content).toBe("second");
      expect(json.choices[1].message.reasoning_content).toBe("second");
      expect(json.usage).toEqual(payload.usage);
    });

    it("is idempotent and never overwrites existing thinking or tool calls", async () => {
      const payload = { choices: [{ message: {
        thinking: { content: "existing", signature: "sig" }, reasoning: "native",
        reasoning_content: "legacy", tool_calls: [{ id: "call" }], content: "answer",
      } }] };
      const once = await transformer.transformResponseOut(jsonResponse(payload));
      const twice = await transformer.transformResponseOut(once);
      expect(await twice.json()).toEqual(payload);
    });

    it("passes Anthropic JSON and error/usage-only payloads through unchanged", async () => {
      for (const payload of [
        { type: "message", content: [{ type: "thinking", thinking: "already converted" }] },
        { error: { message: "bad request" } }, { choices: [], usage: { total_tokens: 2 } },
        { choices: null },
      ]) {
        expect(await (await transformer.transformResponseOut(jsonResponse(payload))).json()).toEqual(payload);
      }
    });

    it("preserves status and unrelated headers but removes stale content-length", async () => {
      const response = new Response(JSON.stringify({ choices: [{ message: { reasoning: "thought" } }] }), {
        status: 201, statusText: "Created", headers: {
          "Content-Type": "application/json", "Content-Length": "1", "X-Request-ID": "id",
        },
      });
      const out = await transformer.transformResponseOut(response);
      expect(out.status).toBe(201);
      expect(out.statusText).toBe("Created");
      expect(out.headers.get("X-Request-ID")).toBe("id");
      expect(out.headers.has("Content-Length")).toBe(false);
      await out.text();
    });

    it("returns unsupported content types and bodyless responses unchanged", async () => {
      for (const response of [
        new Response("plain", { headers: { "Content-Type": "text/plain" } }),
        new Response(null, { status: 204, headers: { "Content-Type": "text/event-stream" } }),
        new Response(null, { status: 204, headers: { "Content-Type": "application/json" } }),
      ]) {
        expect(await transformer.transformResponseOut(response)).toBe(response);
      }
    });

    it("routes a JSON-claimed SSE body through the stream rewriter", async () => {
      const source = 'data: {"choices":[{"delta":{"reasoning":"thought"}}]}\n\ndata: [DONE]\n\n';
      const response = new Response(source, {
        headers: { "Content-Type": "application/json" },
      });
      const out = await transformer.transformResponseOut(response);
      expect(out.headers.get("Content-Type")).toBe("text/event-stream");
      const text = await out.text();
      expect(text).toBe('data: {"choices":[{"delta":{"thinking":{"content":"thought"}}}]}\n\ndata: [DONE]\n\n');
    });

    it("detects mislabeled SSE preceded by a comment heartbeat across chunks", async () => {
      const event = '\ndata: {"choices":[{"delta":{"reasoning":"t"}}]}';
      const chunks = [": ping\n", event.slice(0, 20), event.slice(20), "\n\ndata: [DONE]\n\n"];
      const encoder = new TextEncoder();
      const response = new Response(new ReadableStream({
        start(controller) {
          for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
          controller.close();
        },
      }), { headers: { "Content-Type": "application/json" } });
      const out = await transformer.transformResponseOut(response);
      expect(out.headers.get("Content-Type")).toBe("text/event-stream");
      const text = await out.text();
      expect(sseData(text)[0].choices[0].delta.thinking.content).toBe("t");
      expect(text).toContain("[DONE]");
      expect(text).toBe(chunks.join("").replace('"reasoning":"t"', '"thinking":{"content":"t"}'));
    });

    it("handles a mislabeled SSE body whose first event is fragmented at byte level", async () => {
      const source = 'data: {"choices":[{"delta":{"reasoning":"frag"}}]}\n\ndata: [DONE]\n\n';
      const bytes = new TextEncoder().encode(source);
      const response = new Response(new ReadableStream({
        start(controller) {
          // Split the first data line so no single read classifies the body.
          for (let i = 0; i < 10; i++) controller.enqueue(bytes.slice(i * 3, i * 3 + 3));
          controller.enqueue(bytes.slice(30));
          controller.close();
        },
      }), { headers: { "Content-Type": "application/json" } });
      const out = await transformer.transformResponseOut(response);
      const text = await out.text();
      expect(sseData(text)[0].choices[0].delta.thinking.content).toBe("frag");
      expect(text).toContain("[DONE]");
    });

    it("keeps treating genuine JSON bodies as JSON after peeking", async () => {
      const payload = { choices: [{ message: { content: "answer", reasoning: "thought" } }] };
      const out = await transformer.transformResponseOut(jsonResponse(payload));
      expect(out.headers.get("Content-Type")).toBe("application/json");
      const json = await out.json();
      expect(json.choices[0].message.thinking.content).toBe("thought");
    });

    it("still rewrites a genuine JSON body whose leading whitespace precedes the brace", async () => {
      const payload = { choices: [{ message: { reasoning: "thought" } }] };
      const response = new Response("\n\n  " + JSON.stringify(payload), {
        headers: { "Content-Type": "application/json" },
      });
      const out = await transformer.transformResponseOut(response);
      expect(out.headers.get("Content-Type")).toBe("application/json");
      const json = await out.json();
      expect(json.choices[0].message.thinking.content).toBe("thought");
    });
  });

  describe("transformResponseOut (stream)", () => {
    it("rewrites delta.reasoning into delta.thinking", async () => {
      const chunks = [
        'data: {"choices":[{"delta":{"reasoning":"step one"},"index":0}]}\n\n',
        'data: {"choices":[{"delta":{"reasoning":"step two"},"index":0}]}\n\n',
        'data: {"choices":[{"delta":{"content":"answer"},"index":1}]}\n\n',
        "data: [DONE]\n\n",
      ].join("");

      const response = new Response(chunks, {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      });
      const out = await transformer.transformResponseOut(response);
      const text = await out.text();

      // AMD's `reasoning` key must not survive; thinking carries the content.
      expect(text).not.toContain('"reasoning"');
      expect(text).toContain('"thinking"');
      expect(text).toContain("step one");
      expect(text).toContain("step two");
      expect(text).toContain("answer");
      expect(text).toContain("[DONE]");
    });

    it("passes through non-data SSE lines and [DONE]", async () => {
      const chunks = ": ping\n\ndata: [DONE]\n\n";
      const response = new Response(chunks, {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      });
      const out = await transformer.transformResponseOut(response);
      const text = await out.text();
      expect(text).toContain(": ping");
      expect(text).toContain("[DONE]");
    });

    it("preserves empty reasoning chunks, content and usage-only chunks exactly", async () => {
      const source = [
        'data: {"choices":[{"delta":{"reasoning":"","content":"answer"},"index":0}]}\n\n',
        'data: {"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":5}}\n\n',
        'data: {"choices":[{"delta":{},"finish_reason":"stop","index":0}]}\n\n',
        "data: [DONE]\n\n",
      ].join("");
      expect(await (await transformer.transformResponseOut(streamResponse([source]))).text()).toBe(source);
    });

    it("rewrites all choices including objects and DeepSeek fields without dropping metadata", async () => {
      const payload = { choices: [
        { index: 0, delta: { reasoning: "one", content: "a", tool_calls: [{ id: "call" }] } },
        { index: 1, delta: { reasoning: { content: "two", signature: "sig" } } },
        { index: 2, delta: { reasoning_content: "three" } },
        { index: 3, delta: { reasoning: "", content: "b" } },
      ], usage: { total_tokens: 8 } };
      const text = await (await transformer.transformResponseOut(streamResponse([
        `data:${JSON.stringify(payload)}\n\n`,
      ]))).text();
      const [json] = sseData(text);
      expect(json.choices.map((choice: any) => choice.delta.thinking?.content)).toEqual(["one", "two", "three", undefined]);
      expect(json.choices[0].delta.tool_calls).toEqual([{ id: "call" }]);
      expect(json.choices[1].delta.thinking).toEqual({ content: "two" });
      expect(json.choices[1].delta.reasoning).toEqual({ content: "two", signature: "sig" });
      expect(json.choices[2].delta.reasoning_content).toBe("three");
      expect(json.choices[3].delta.content).toBe("b");
      expect(json.usage).toEqual(payload.usage);
    });

    it("preserves comments, event/id/retry lines and CRLF event boundaries", async () => {
      const source = ': ping\r\nevent: completion\r\nid: 7\r\nretry: 1000\r\ndata: {"choices":[{"delta":{"reasoning":"thought"}}]}\r\n\r\n\r\ndata: [DONE]\r\n\r\n';
      const expected = source.replace('"reasoning":"thought"', '"thinking":{"content":"thought"}');
      expect(await (await transformer.transformResponseOut(streamResponse([source]))).text()).toBe(expected);
    });

    it("handles data lines and UTF-8 split at every byte including split CRLF", async () => {
      const source = 'data:{"choices":[{"delta":{"reasoning":"思考🙂","content":"答案"}}]}\r\n\r\ndata: [DONE]\r\n\r\n';
      const bytes = new TextEncoder().encode(source);
      const chunks = Array.from(bytes, (byte) => new Uint8Array([byte]));
      const out = await transformer.transformResponseOut(streamResponse(chunks));
      const text = await out.text();
      expect(sseData(text)[0].choices[0].delta).toEqual({ content: "答案", thinking: { content: "思考🙂" } });
      expect(text).not.toContain("�");
      expect(text.endsWith("\r\n\r\ndata: [DONE]\r\n\r\n")).toBe(true);
    });

    it("rewrites the final unterminated data line without losing its tail", async () => {
      const source = 'data: {"choices":[{"delta":{"reasoning":"tail"}}]}';
      const text = await (await transformer.transformResponseOut(streamResponse(["", source.slice(0, 9), source.slice(9)]))).text();
      expect(text).toBe('data: {"choices":[{"delta":{"thinking":{"content":"tail"}}}]}');
    });

    it("preserves unknown objects, whitespace tails and Anthropic SSE exactly", async () => {
      for (const source of [
        'data: {"choices":[{"delta":{"reasoning":{"text":"unknown"}}}]}\n\n  ',
        'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"thinking_delta","thinking":"done"}}\n\n',
        ': heartbeat\r\rdata: [DONE]\r\r',
        'data: null\n\ndata: {"choices":null}\n\n',
      ]) {
        expect(await (await transformer.transformResponseOut(streamResponse([source]))).text()).toBe(source);
      }
    });

    it("is idempotent on normalized SSE and preserves existing thinking", async () => {
      const source = 'data: {"choices":[{"delta":{"thinking":{"content":"existing"},"reasoning":"keep"}}]}\n\n';
      const once = await transformer.transformResponseOut(streamResponse([source]));
      const twice = await transformer.transformResponseOut(once);
      expect(await twice.text()).toBe(source);
    });

    it("propagates upstream errors without closing an already errored controller", async () => {
      const error = new Error("upstream failed");
      const response = new Response(new ReadableStream({
        pull(controller) { controller.error(error); },
      }), { headers: { "Content-Type": "text/event-stream" } });
      const out = await transformer.transformResponseOut(response);
      await expect(out.text()).rejects.toThrow("upstream failed");
    });

    it("propagates downstream cancellation and removes stale stream content-length", async () => {
      const cancel = vi.fn();
      const response = new Response(new ReadableStream({ cancel }), {
        headers: { "Content-Type": "text/event-stream", "Content-Length": "1", "X-Test": "kept" },
      });
      const out = await transformer.transformResponseOut(response);
      expect(out.headers.has("Content-Length")).toBe(false);
      expect(out.headers.get("X-Test")).toBe("kept");
      await out.body!.cancel("client disconnected");
      await vi.waitFor(() => expect(cancel).toHaveBeenCalledWith("client disconnected"));
    });

    it("leaves malformed SSE lines untouched instead of dropping them", async () => {
      const chunks = "data: not-json\n\n";
      const response = new Response(chunks, {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      });
      const out = await transformer.transformResponseOut(response);
      const text = await out.text();
      expect(text).toBe(chunks);
    });
  });

  describe("Anthropic endpoint integration", () => {
    it("shows OpenAI-only provider chains convert text but cannot read AMD reasoning", async () => {
      const json = await (await convertProviderResponse(jsonResponse({
        model: "GLM", choices: [{ message: { content: "answer", reasoning: "thought" }, finish_reason: "stop" }],
      }), [new OpenAITransformer()])).json();
      expect(json.type).toBe("message");
      expect(json.content).toEqual([{ type: "text", text: "answer" }]);
    });

    it.each([false, true])("emits one non-stream thinking block with provider Anthropic=%s", async (includeAnthropic) => {
      const use: Transformer[] = [includeAnthropic ? new AnthropicTransformer() : new OpenAITransformer(), transformer];
      const json = await (await convertProviderResponse(jsonResponse({
        model: "GLM", choices: [{ message: { content: "answer", reasoning: "thought" }, finish_reason: "stop" }],
      }), use)).json();
      expect(json.type).toBe("message");
      expect(json.content.filter((block: any) => block.type === "thinking")).toEqual([{ type: "thinking", thinking: "thought" }]);
      expect(json.content.filter((block: any) => block.type === "text")).toEqual([{ type: "text", text: "answer" }]);
    });

    it("preserves consecutive signed reasoning objects through the Anthropic stream endpoint", async () => {
      const source = [
        { model: "GLM", choices: [{ delta: { reasoning: { content: "first", signature: "amd-sig-1" } } }] },
        { choices: [{ delta: { reasoning: { content: "second", signature: "amd-sig-2" } } }] },
        { choices: [{ delta: { content: "answer" } }] },
        { choices: [{ delta: {}, finish_reason: "stop" }] },
      ].map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n";
      const events = sseData(await (await convertProviderResponse(streamResponse([source]), [new OpenAITransformer(), transformer])).text());
      const thoughts = events.filter((event) => event.delta?.type === "thinking_delta");
      expect(thoughts.map((event) => event.delta.thinking)).toEqual(["first", "second"]);
      expect(thoughts.map((event) => event.index)).toEqual([0, 0]);
      expect(events.filter((event) => event.delta?.type === "signature_delta")).toHaveLength(0);
      expect(events.filter((event) => event.delta?.type === "text_delta").map((event) => event.delta.text)).toEqual(["answer"]);
    });

    it.each([false, true])("emits one streaming thinking block with provider Anthropic=%s", async (includeAnthropic) => {
      const use: Transformer[] = [includeAnthropic ? new AnthropicTransformer() : new OpenAITransformer(), transformer];
      const source = [
        'data: {"model":"GLM","choices":[{"index":0,"delta":{"reasoning":"thought"}}]}\n\n',
        'data: {"choices":[{"index":0,"delta":{"content":"answer"}}]}\n\n',
        'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n',
        'data: {"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":5}}\n\n',
        'data: [DONE]\n\n',
      ].join("");
      const events = sseData(await (await convertProviderResponse(streamResponse([source]), use)).text());
      expect(events.filter((event) => event.type === "content_block_start" && event.content_block.type === "thinking")).toHaveLength(1);
      expect(events.filter((event) => event.delta?.type === "thinking_delta").map((event) => event.delta.thinking)).toEqual(["thought"]);
      expect(events.filter((event) => event.delta?.type === "text_delta").map((event) => event.delta.text)).toEqual(["answer"]);
      expect(events.find((event) => event.type === "message_delta").usage).toMatchObject({ input_tokens: 10, output_tokens: 5 });
      expect(events.filter((event) => event.type === "message_stop")).toHaveLength(1);
    });
  });

  describe("registration and runtime", () => {
    it("registers via TransformerService from defaults and config", async () => {
      const { TransformerService } = await import("../services/transformer");
      const { ConfigService } = await import("../services/config");
      const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

      const defaults = new TransformerService(new ConfigService({ useJsonFile: false, useEnvironmentVariables: false }), logger as any);
      await defaults.initialize();
      expect(defaults.getTransformer("amd")).toBe(AmdTransformer);

      const configured = new TransformerService(
        new ConfigService({
          useJsonFile: false,
          useEnvironmentVariables: false,
          initialConfig: { transformers: [{ name: "amd" }] },
        }),
        logger as any
      );
      await configured.initialize();
      expect(configured.getTransformer("amd")).toBe(AmdTransformer);
    });

    it("maps a real Claude Code /v1/messages request to AMD wire format and preserves thinking", async () => {
      const { default: Server } = await import("../server");
      const wireRequests: any[] = [];
      const originalFetch = globalThis.fetch;
      globalThis.fetch = (async (url: any, init: any) => {
        wireRequests.push({ url: String(url), body: JSON.parse(init?.body), headers: init?.headers });
        return new Response(JSON.stringify({
          id: "chatcmpl-amd",
          object: "chat.completion",
          created: 1700000000,
          model: "GLM-5.3-Flash",
          choices: [{
            index: 0,
            message: { role: "assistant", content: "final answer", reasoning: "thought" },
            finish_reason: "stop",
          }],
          usage: { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 },
        }), { status: 200, headers: { "content-type": "application/json" } });
      }) as any;

      let server: any;
      try {
        server = new Server({
          logger: false,
          useJsonFile: false,
          useEnvFile: false,
          useEnvironmentVariables: false,
          initialConfig: {
            HOST: "127.0.0.1",
            PORT: 0,
            providers: [{
              name: "amd",
              api_base_url: "https://upstream.example/v1/chat/completions",
              api_key: "test-key",
              models: ["GLM-5.3-Flash"],
              transformer: { use: ["OpenAI", "amd"] },
            }],
            Router: { default: "amd,GLM-5.3-Flash", enableFamilyRouting: false },
          },
        });
        await server.ready();
        await server.registerNamespace("/");

        const res = await server.app.inject({
          method: "POST",
          url: "/v1/messages",
          payload: {
            model: "ccr-opus",
            max_tokens: 256,
            messages: [{ role: "user", content: "hello" }],
            thinking: { type: "enabled", budget_tokens: 8192 },
            stream: false,
          },
        });

        expect(res.statusCode).toBe(200);
        expect(wireRequests).toHaveLength(1);
        const wire = wireRequests[0];
        expect(wire.url).toBe("https://upstream.example/v1/chat/completions");
        // Budget 8192 derives medium; rejected spellings never reach the wire.
        expect(wire.body.model).toBe("GLM-5.3-Flash");
        expect(wire.body.reasoning_effort).toBe("medium");
        expect(wire.body.reasoning).toBeUndefined();
        expect(wire.body.thinking).toBeUndefined();
        expect(wire.body.enable_thinking).toBeUndefined();

        // AMD's reasoning field is lifted into thinking for Anthropic clients.
        const body = JSON.parse(res.body);
        expect(body.type).toBe("message");
        expect(body.content.filter((block: any) => block.type === "thinking")).toEqual([
          { type: "thinking", thinking: "thought" },
        ]);
        expect(body.content.filter((block: any) => block.type === "text")).toEqual([
          { type: "text", text: "final answer" },
        ]);
        expect(body.usage).toMatchObject({ input_tokens: 12, output_tokens: 3 });
      } finally {
        globalThis.fetch = originalFetch;
        if (server) await server.app.close();
      }
    });
  });
});
