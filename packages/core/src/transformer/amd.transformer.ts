import { UnifiedChatRequest } from "@/types/llm";
import { Transformer } from "@/types/transformer";
import { getThinkLevel } from "@/utils/thinking";
import { parseResponseJson, peekBodyForSSE, readBodyForSSE } from "./response-body";

/** Adapt AMD chat completions' model-specific effort and reasoning fields. */
export class AmdTransformer implements Transformer {
  static TransformerName = "amd";
  name = "amd";

  private resolveEffort(
    effort: string | undefined,
    model: string | undefined
  ): string | undefined {
    if (!effort) return undefined;
    const family = (model ?? "").toLowerCase();
    const isGlm = family.includes("glm");
    const isQwen = !isGlm && family.includes("qwen");
    const isDeepSeek = !isGlm && !isQwen && family.includes("deepseek");
    if (effort === "none") {
      // Only the documented Flash-Next model (not arbitrary Qwen variants)
      // and AMD DeepSeek accept an explicit disable tier.
      return isDeepSeek || family.split("/").pop() === "qwen3.8-flash-next"
        ? "none"
        : undefined;
    }
    switch (effort) {
      case "minimal":
        return isDeepSeek ? "minimal" : "low";
      case "low":
      case "medium":
        return effort;
      case "high":
        return isQwen ? "xhigh" : "high";
      case "xhigh":
      case "max":
        if (isDeepSeek) return effort;
        return isQwen ? "xhigh" : "high";
      default:
        return "medium";
    }
  }

  async transformRequestIn(
    request: UnifiedChatRequest
  ): Promise<UnifiedChatRequest> {
    const transformed = JSON.parse(JSON.stringify(request)) as UnifiedChatRequest & {
      thinking?: any;
      enable_thinking?: boolean;
      reasoning_effort?: string;
    };
    const model = transformed.model;

    // Intent resolution: an explicit unified effort always wins. An empty
    // string means "no tier requested" — neither the native field nor a
    // default is injected. Otherwise a budget derives its tier, an enabled
    // flag without a tier falls back to the native field (or medium), and a
    // disabled flag forces the explicit none tier.
    const reasoning = transformed.reasoning as
      | { enabled?: boolean; effort?: string; max_tokens?: number }
      | undefined;
    let rawEffort: string | undefined;
    let explicitNone = reasoning?.enabled === false;
    if (reasoning && typeof reasoning.effort === "string") {
      rawEffort = reasoning.effort === "" ? undefined : reasoning.effort;
      explicitNone = explicitNone || reasoning.effort === "none";
    } else if (typeof reasoning?.max_tokens === "number") {
      rawEffort = getThinkLevel(reasoning.max_tokens);
    } else if (reasoning?.enabled === true) {
      rawEffort = transformed.reasoning_effort ?? "medium";
    } else {
      rawEffort = transformed.reasoning_effort;
      // Anthropic/Qwen disable spellings are honored only when the unified
      // reasoning object carries no intent of its own. AMD rejects them on
      // the wire, so they must never pass through untouched.
      if (
        !explicitNone &&
        (transformed.enable_thinking === false ||
          (transformed.thinking as any)?.type === "disabled")
      ) {
        explicitNone = true;
      }
    }
    const effort = this.resolveEffort(explicitNone ? "none" : rawEffort, model);
    if (effort) {
      transformed.reasoning_effort = effort;
    } else {
      delete transformed.reasoning_effort;
    }

    // AMD 400s on every Anthropic/Qwen spelling of thinking. Remove them all.
    delete transformed.reasoning;
    delete transformed.thinking;
    delete transformed.enable_thinking;

    return transformed;
  }

  async transformResponseOut(response: Response): Promise<Response> {
    const contentType = response.headers.get("Content-Type") ?? "";
    if (contentType.includes("application/json")) {
      if (!response.body) return response;
      // Peek only a bounded prefix: JSON-claimed SSE must remain streaming.
      const peeked = await peekBodyForSSE(response);
      if (peeked) {
        const headers = new Headers(response.headers);
        if (peeked.isSSE) headers.set("Content-Type", "text/event-stream");
        response = new Response(peeked.body, {
          status: response.status,
          statusText: response.statusText,
          headers,
        });
        if (peeked.isSSE) return this.transformStream(response);
      } else {
        // Body locked or otherwise unpeekable: drain and classify as a last
        // resort so a JSON-claimed SSE body still streams instead of failing
        // JSON parse (mirrors the Anthropic endpoint converter's fallback).
        const drained = await readBodyForSSE(response);
        response = drained.response;
        if (drained.isSSE) return this.transformStream(response);
      }
      const json = await parseResponseJson(response);
      this.liftMessageReasoning(json);
      // Drop content-length: the JSON body was rewritten and the original
      // length no longer matches.
      const headers = new Headers(response.headers);
      headers.delete("content-length");
      return new Response(JSON.stringify(json), {
        status: response.status,
        statusText: response.statusText,
        headers,
      });
    }

    if (contentType.includes("stream") || contentType.includes("event-stream")) {
      if (!response.body) return response;
      return this.transformStream(response);
    }

    return response;
  }

  // Provider response hooks run before the Anthropic endpoint converter,
  // which reads thinking.content rather than AMD's reasoning field.
  private liftMessageReasoning(json: any): void {
    if (!Array.isArray(json?.choices)) return;
    for (const choice of json.choices) {
      liftReasoning(choice?.message);
    }
  }

  /** Lift reasoning per SSE data line without changing event boundaries. */
  private transformStream(response: Response): Response {
    const decoder = new TextDecoder();
    const encoder = new TextEncoder();
    let buffer = "";

    /**
     * Rewrite one complete SSE line. Returns the line verbatim unless an AMD
     * `reasoning` field was actually lifted, so comment lines (": ping"),
     * `event:` tags, [DONE], usage-only chunks (empty/missing choices) and
     * malformed JSON all pass through untouched — no chunk is ever dropped.
     */
    const rewriteDataLine = (line: string): string => {
      // Matches both "data: {...}" and "data:{...}" (some servers omit the
      // space). Anything else is not a data line.
      if (!line.startsWith("data:")) return line;
      const payload = line.slice(5).trim();
      if (payload === "[DONE]") return line;
      let data: any;
      try {
        data = JSON.parse(payload);
      } catch {
        // Malformed JSON — preserve the original line rather than swallow it.
        return line;
      }
      let changed = false;
      const choices = Array.isArray(data?.choices) ? data.choices : [];
      for (const choice of choices) {
        // Do not short-circuit: every choice must be visited even after one
        // delta has changed. Empty reasoning never creates an empty block.
        if (liftReasoning(choice?.delta, true)) changed = true;
      }
      return changed ? `data: ${JSON.stringify(data)}` : line;
    };

    const drainLines = (
      controller: TransformStreamDefaultController<Uint8Array>,
      final = false
    ) => {
      const endings = /\r\n|\r|\n/g;
      let start = 0;
      let match: RegExpExecArray | null;
      let output = "";
      while ((match = endings.exec(buffer)) !== null) {
        // A trailing CR may be the first byte of CRLF in the next chunk.
        if (!final && match[0] === "\r" && endings.lastIndex === buffer.length) {
          break;
        }
        output += rewriteDataLine(buffer.slice(start, match.index)) + match[0];
        start = endings.lastIndex;
      }
      buffer = buffer.slice(start);
      if (final) {
        // Preserve even an unterminated or whitespace-only tail verbatim.
        output += rewriteDataLine(buffer);
        buffer = "";
      }
      if (output) controller.enqueue(encoder.encode(output));
    };

    // pipeThrough propagates upstream errors and downstream cancellation and
    // supplies backpressure. Preserve blank lines and line endings: inserting
    // an extra blank after event:/id:/comment lines would split SSE events.
    const stream = response.body!.pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          buffer += decoder.decode(chunk, { stream: true });
          drainLines(controller);
        },
        flush(controller) {
          buffer += decoder.decode();
          drainLines(controller, true);
        },
      })
    );

    const headers = new Headers(response.headers);
    headers.delete("content-length");
    return new Response(stream, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  }
}

/** Lift known reasoning shapes without overwriting existing thinking. */
function liftReasoning(message: any, streaming = false): boolean {
  if (!message || typeof message !== "object" || message.thinking) return false;
  const reasoning = message.reasoning;
  const text = typeof reasoning === "string" ? reasoning : reasoning?.content;
  if (typeof text === "string" && text.length > 0) {
    if (streaming && typeof reasoning === "object") {
      // The Anthropic stream converter prioritizes thinking.signature over
      // thinking.content and treats it as a block-closing control signal.
      // AMD object metadata is not an Anthropic signature event: copy only
      // text into thinking and retain the original object/metadata so neither
      // this text nor later reasoning deltas get lost behind a closed block.
      message.thinking = { content: text };
    } else {
      // Non-streaming thinking can safely retain object metadata/signatures.
      message.thinking = typeof reasoning === "string"
        ? { content: text }
        : { ...reasoning };
      delete message.reasoning;
    }
    return true;
  }
  // Some DeepSeek models use reasoning_content. Copy it, never delete it or
  // stringify unknown objects: other transformers may still need that field.
  if (typeof message.reasoning_content === "string" && message.reasoning_content) {
    message.thinking = { content: message.reasoning_content };
    return true;
  }
  return false;
}
