import { Transformer, TransformerContext } from "@/types/transformer";
import { LLMProvider, UnifiedChatRequest } from "@/types/llm";
import { convertToAnthropic } from "@/utils/converter";
import { parseResponseJson, peekBodyForSSE } from "./response-body";

export class OpenAITransformer implements Transformer {
  name = "OpenAI";
  endPoint = "/v1/chat/completions";

  private isAnthropicMessagesEndpoint(baseUrl?: string): boolean {
    if (!baseUrl) return false;
    const url = baseUrl.toLowerCase();
    return url.includes("/v1/messages") || url.includes("anthropic");
  }

  async transformRequestIn(
    request: UnifiedChatRequest,
    provider: LLMProvider,
    context: TransformerContext
  ): Promise<any> {
    // If the upstream provider is an Anthropic-style endpoint (/v1/messages),
    // convert the OpenAI-style chat payload to Anthropic format.
    if (this.isAnthropicMessagesEndpoint(provider.baseUrl)) {
      if (context && context.req) {
        context.req.isTargetAnthropic = true;
      }
      return convertToAnthropic(request);
    }

    // Otherwise, upstream is OpenAI compatible (e.g. /v1/chat/completions), passthrough directly.
    return request;
  }

  async transformResponseOut(
    response: Response,
    context?: TransformerContext
  ): Promise<Response> {
    // If upstream is OpenAI compatible, passthrough the response directly
    if (!context?.req?.isTargetAnthropic) {
      return response;
    }

    const isStream = context?.req?.body?.stream ?? false;
    if (isStream) {
      if (!response.body) {
        throw new Error("Stream response body is null");
      }
      const convertedStream = await this.convertAnthropicStreamToOpenAI(
        response.body,
        context!
      );
      return new Response(convertedStream, {
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        },
      });
    }

    let textResponse = response;
    const peeked = await peekBodyForSSE(response);
    if (peeked?.isSSE && peeked?.body) {
      const convertedStream = await this.convertAnthropicStreamToOpenAI(
        peeked.body,
        context!
      );
      return new Response(convertedStream, {
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        },
      });
    } else if (peeked?.body) {
      textResponse = new Response(peeked.body, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    }

    const data = (await parseResponseJson(textResponse)) as any;
    const openAIResponse = this.convertAnthropicToOpenAI(data, context?.req?.body?.model);
    return new Response(JSON.stringify(openAIResponse), {
      status: response.status,
      headers: { "Content-Type": "application/json" },
    });
  }

  private convertAnthropicToOpenAI(data: any, requestedModel?: string): any {
    if (!data || typeof data !== "object") return data;
    // If it's already an OpenAI response format, return as-is
    if (data.choices && Array.isArray(data.choices)) {
      return data;
    }

    let textContent = "";
    const toolCalls: any[] = [];

    if (Array.isArray(data.content)) {
      for (const block of data.content) {
        if (block.type === "text") {
          textContent += block.text || "";
        } else if (block.type === "tool_use") {
          toolCalls.push({
            id: block.id,
            type: "function",
            function: {
              name: block.name,
              arguments:
                typeof block.input === "string"
                  ? block.input
                  : JSON.stringify(block.input || {}),
            },
          });
        }
      }
    }

    const finishReasonMap: Record<string, string> = {
      end_turn: "stop",
      stop_sequence: "stop",
      max_tokens: "length",
      tool_use: "tool_calls",
    };

    const finish_reason = finishReasonMap[data.stop_reason] || data.stop_reason || "stop";

    return {
      id: data.id || `chatcmpl-${Date.now()}`,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: requestedModel || data.model || "unknown",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: textContent || null,
            ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
          },
          finish_reason,
        },
      ],
      usage: {
        prompt_tokens: data.usage?.input_tokens ?? 0,
        completion_tokens: data.usage?.output_tokens ?? 0,
        total_tokens: (data.usage?.input_tokens ?? 0) + (data.usage?.output_tokens ?? 0),
      },
    };
  }

  private async convertAnthropicStreamToOpenAI(
    stream: ReadableStream,
    context: TransformerContext
  ): Promise<ReadableStream> {
    const reader = stream.getReader();
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();

    let buffer = "";
    const requestedModel = context?.req?.body?.model || "unknown";
    const streamId = `chatcmpl-${Date.now()}`;
    const created = Math.floor(Date.now() / 1000);

    return new ReadableStream({
      async pull(controller) {
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) {
              if (buffer.trim()) {
                // Process any trailing SSE event
                const lines = buffer.split("\n");
                for (const line of lines) {
                  if (line.startsWith("data: ")) {
                    const dataStr = line.slice(6).trim();
                    if (dataStr && dataStr !== "[DONE]") {
                      try {
                        const event = JSON.parse(dataStr);
                        const chunk = OpenAITransformer.mapAnthropicEventToOpenAIChunk(
                          event,
                          streamId,
                          created,
                          requestedModel
                        );
                        if (chunk) {
                          controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
                        }
                      } catch {
                        // Skip malformed chunk
                      }
                    }
                  }
                }
              }
              controller.enqueue(encoder.encode("data: [DONE]\n\n"));
              controller.close();
              return;
            }

            buffer += decoder.decode(value, { stream: true });
            const events = buffer.split("\n\n");
            buffer = events.pop() || "";

            for (const eventBlock of events) {
              const lines = eventBlock.split("\n");
              for (const line of lines) {
                if (line.startsWith("data: ")) {
                  const dataStr = line.slice(6).trim();
                  if (!dataStr) continue;
                  if (dataStr === "[DONE]") {
                    controller.enqueue(encoder.encode("data: [DONE]\n\n"));
                    controller.close();
                    return;
                  }
                  try {
                    const event = JSON.parse(dataStr);
                    const chunk = OpenAITransformer.mapAnthropicEventToOpenAIChunk(
                      event,
                      streamId,
                      created,
                      requestedModel
                    );
                    if (chunk) {
                      controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
                    }
                  } catch {
                    // Ignore non-JSON lines or ping events
                  }
                }
              }
            }
          }
        } catch (err) {
          controller.error(err);
        }
      },
      cancel() {
        reader.cancel();
      },
    });
  }

  private static mapAnthropicEventToOpenAIChunk(
    event: any,
    id: string,
    created: number,
    model: string
  ): any | null {
    if (!event || typeof event !== "object") return null;

    // Handle text delta
    if (event.type === "content_block_delta" && event.delta?.type === "text_delta") {
      return {
        id,
        object: "chat.completion.chunk",
        created,
        model,
        choices: [
          {
            index: 0,
            delta: {
              content: event.delta.text || "",
            },
            finish_reason: null,
          },
        ],
      };
    }

    // Handle thinking delta
    if (event.type === "content_block_delta" && event.delta?.type === "thinking_delta") {
      return {
        id,
        object: "chat.completion.chunk",
        created,
        model,
        choices: [
          {
            index: 0,
            delta: {
              reasoning_content: event.delta.thinking || "",
            },
            finish_reason: null,
          },
        ],
      };
    }

    // Handle tool use block start
    if (event.type === "content_block_start" && event.content_block?.type === "tool_use") {
      return {
        id,
        object: "chat.completion.chunk",
        created,
        model,
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index: event.index ?? 0,
                  id: event.content_block.id,
                  type: "function",
                  function: {
                    name: event.content_block.name,
                    arguments: "",
                  },
                },
              ],
            },
            finish_reason: null,
          },
        ],
      };
    }

    // Handle tool call arguments delta
    if (event.type === "content_block_delta" && event.delta?.type === "input_json_delta") {
      return {
        id,
        object: "chat.completion.chunk",
        created,
        model,
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index: event.index ?? 0,
                  function: {
                    arguments: event.delta.partial_json || "",
                  },
                },
              ],
            },
            finish_reason: null,
          },
        ],
      };
    }

    // Handle message stop / finish reason
    if (event.type === "message_delta" && event.delta?.stop_reason) {
      const finishReasonMap: Record<string, string> = {
        end_turn: "stop",
        stop_sequence: "stop",
        max_tokens: "length",
        tool_use: "tool_calls",
      };
      const finish_reason =
        finishReasonMap[event.delta.stop_reason] || event.delta.stop_reason || "stop";

      return {
        id,
        object: "chat.completion.chunk",
        created,
        model,
        choices: [
          {
            index: 0,
            delta: {},
            finish_reason,
          },
        ],
      };
    }

    return null;
  }
}
