import { describe, it, expect } from "vitest";
import { AnthropicTransformer } from "../transformer/anthropic.transformer";

// Helpers to build an OpenAI Chat Completions SSE stream and parse the
// Anthropic SSE that AnthropicTransformer.transformResponseIn emits.
function sseResponse(chunks: object[]): Response {
  const text = chunks
    .map((c) => `data: ${JSON.stringify(c)}`)
    .join("\n\n") + "\n\ndata: [DONE]\n\n";
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    },
  });
  return new Response(body, {
    headers: { "Content-Type": "text/event-stream" },
  });
}

interface AnthropicSseEvent {
  event: string;
  data: any;
}

async function collectAnthropicSse(response: Response): Promise<AnthropicSseEvent[]> {
  const out: AnthropicSseEvent[] = [];
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const blocks = buffer.split("\n\n");
    buffer = blocks.pop() || "";
    for (const block of blocks) {
      const lines = block.split("\n");
      let event = "";
      let dataLine = "";
      for (const line of lines) {
        if (line.startsWith("event: ")) event = line.slice(7).trim();
        else if (line.startsWith("data: ")) dataLine = line.slice(6);
      }
      if (event && dataLine) {
        try {
          out.push({ event, data: JSON.parse(dataLine) });
        } catch {
          // ignore non-JSON data lines
        }
      }
    }
  }
  return out;
}

const noopLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

function makeTransformer(): AnthropicTransformer {
  const t = new AnthropicTransformer();
  t.logger = noopLogger;
  return t;
}

describe("AnthropicTransformer streaming usage (transformResponseIn)", () => {
  it("captures real usage from a trailing choices:[] chunk after finish_reason (fireworks/GLM-5.2)", async () => {
    // Reproduces the fireworks chunk order:
    //   role delta -> content delta -> finish_reason (usage=null) -> choices:[] real usage
    const transformer = makeTransformer();
    const response = sseResponse([
      {
        id: "chatcmpl-x",
        object: "chat.completion.chunk",
        choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }],
      },
      {
        id: "chatcmpl-x",
        object: "chat.completion.chunk",
        choices: [{ index: 0, delta: { content: "hello" }, finish_reason: null }],
      },
      {
        id: "chatcmpl-x",
        object: "chat.completion.chunk",
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        // fireworks: finish_reason chunk carries NO usage
        usage: null as any,
      },
      {
        id: "chatcmpl-x",
        object: "chat.completion.chunk",
        // real usage arrives AFTER finish, in a choices:[] chunk
        choices: [],
        usage: {
          prompt_tokens: 88017,
          completion_tokens: 3,
          total_tokens: 88020,
          prompt_tokens_details: { cached_tokens: 88016 },
        },
      },
    ]);

    const result = await transformer.transformResponseIn(response, {
      req: { id: "req-1", tokenCount: 88004, isTargetAnthropic: false },
    } as any);

    const events = await collectAnthropicSse(result);
    const deltas = events.filter((e) => e.event === "message_delta");
    const stops = events.filter((e) => e.event === "message_stop");
    const contentDeltas = events.filter(
      (e) => e.event === "content_block_delta"
    );

    // Exactly one message_delta / message_stop (no duplication from continuing the loop)
    expect(deltas.length).toBe(1);
    expect(stops.length).toBe(1);

    const usage = deltas[0].data.usage;
    // The core regression: output and cache_read must NOT be zeroed by the
    // finish_reason chunk's null usage. They come from the trailing usage chunk.
    expect(usage.output_tokens).toBe(3);
    expect(usage.cache_read_input_tokens).toBe(88016);
    // input_tokens is net of cache reads: 88017 - 88016 = 1
    expect(usage.input_tokens).toBe(1);

    // Content was still emitted (the bug only zeroed usage, not content)
    expect(contentDeltas.length).toBeGreaterThanOrEqual(1);
    // stop_reason should reflect the finish_reason mapping (stop -> end_turn)
    expect(deltas[0].data.delta.stop_reason).toBe("end_turn");
  });

  it("standard provider: finish_reason chunk carries its own usage, no trailing chunk", async () => {
    // Standard OpenAI: usage travels WITH the finish_reason chunk, nothing after.
    const transformer = makeTransformer();
    const response = sseResponse([
      {
        id: "chatcmpl-y",
        object: "chat.completion.chunk",
        choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }],
      },
      {
        id: "chatcmpl-y",
        object: "chat.completion.chunk",
        choices: [{ index: 0, delta: { content: "hi" }, finish_reason: null }],
      },
      {
        id: "chatcmpl-y",
        object: "chat.completion.chunk",
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        usage: {
          prompt_tokens: 120,
          completion_tokens: 5,
          total_tokens: 125,
          prompt_tokens_details: { cached_tokens: 100 },
        },
      },
    ]);

    const result = await transformer.transformResponseIn(response, {
      req: { id: "req-2", tokenCount: 120, isTargetAnthropic: false },
    } as any);

    const events = await collectAnthropicSse(result);
    const deltas = events.filter((e) => e.event === "message_delta");

    expect(deltas.length).toBe(1);
    const usage = deltas[0].data.usage;
    // finish chunk's own usage is captured via the if(chunk.usage) merge
    expect(usage.output_tokens).toBe(5);
    expect(usage.cache_read_input_tokens).toBe(100);
    expect(usage.input_tokens).toBe(20); // 120 - 100
    expect(deltas[0].data.delta.stop_reason).toBe("end_turn");
  });

  it("does not re-emit content from chunks arriving after finish_reason", async () => {
    // A misbehaving upstream that sends another content delta AFTER finish.
    // The loop now continues past finish, but content paths are guarded by
    // !hasFinished, so this late content must NOT produce a second
    // content_block_delta.
    const transformer = makeTransformer();
    const response = sseResponse([
      {
        id: "chatcmpl-z",
        object: "chat.completion.chunk",
        choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }],
      },
      {
        id: "chatcmpl-z",
        object: "chat.completion.chunk",
        choices: [{ index: 0, delta: { content: "first" }, finish_reason: null }],
      },
      {
        id: "chatcmpl-z",
        object: "chat.completion.chunk",
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        usage: null as any,
      },
      // late content delta AFTER finish — must be ignored
      {
        id: "chatcmpl-z",
        object: "chat.completion.chunk",
        choices: [{ index: 0, delta: { content: "LATE" }, finish_reason: null }],
      },
      {
        id: "chatcmpl-z",
        object: "chat.completion.chunk",
        choices: [],
        usage: { prompt_tokens: 50, completion_tokens: 2, total_tokens: 52 },
      },
    ]);

    const result = await transformer.transformResponseIn(response, {
      req: { id: "req-3", tokenCount: 50, isTargetAnthropic: false },
    } as any);

    const events = await collectAnthropicSse(result);
    const contentDeltas = events.filter((e) => e.event === "content_block_delta");
    const texts = contentDeltas.map((e) => e.data.delta?.text).join("");
    expect(texts).toBe("first");
    expect(texts).not.toContain("LATE");
  });
});
