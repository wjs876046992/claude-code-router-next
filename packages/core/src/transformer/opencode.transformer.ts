import { UnifiedChatRequest } from "@/types/llm";
import { Transformer, TransformerOptions } from "../types/transformer";
import { v4 as uuidv4 } from "uuid";

/**
 * OpenCode Transformer
 *
 * Handles requests to OpenCode (opencode.ai) providers which expose an
 * OpenAI-compatible /v1/chat/completions endpoint backed by GLM/Zhipu models.
 *
 * Key responsibilities:
 * - Declares endPoint="/v1/chat/completions" so CCR does NOT bypass the
 *   transformer chain. Without this declaration, a provider whose only
 *   resolved transformer is AnthropicTransformer would trigger bypass mode,
 *   sending Anthropic-format tools ({name,description,input_schema}) to an
 *   OpenAI-compatible API that requires {type:"function",function:{…}}.
 * - Cleans cache_control and Anthropic-specific image_url fields that GLM
 *   does not understand.
 * - Converts reasoning_content in streaming/non-streaming responses to the
 *   thinking format expected by Claude Code.
 * - Replaces purely-numeric tool_call IDs with UUID-based IDs to avoid
 *   downstream parsing issues.
 */
export class OpenCodeTransformer implements Transformer {
  static TransformerName = "opencode";
  endPoint = "/v1/chat/completions";

  constructor(private readonly options?: TransformerOptions) {}

  async transformRequestIn(
    request: UnifiedChatRequest
  ): Promise<UnifiedChatRequest> {
    // Clean cache_control and Anthropic-specific media_type from messages.
    // GLM/OpenAI-compatible APIs do not support these fields.
    request.messages.forEach((msg) => {
      if (Array.isArray(msg.content)) {
        msg.content.forEach((item: any) => {
          if (item.cache_control) {
            delete item.cache_control;
          }
          if (item.type === "image_url") {
            if (!item.image_url.url.startsWith("http")) {
              item.image_url.url = `data:${item.media_type};base64,${item.image_url.url}`;
            }
            delete item.media_type;
          }
        });
      } else if (msg.cache_control) {
        delete msg.cache_control;
      }
    });

    // Apply any additional options from config (e.g. custom params)
    Object.assign(request, this.options || {});
    return request;
  }

  async transformResponseOut(response: Response): Promise<Response> {
    // Handle non-streaming JSON response
    if (response.headers.get("Content-Type")?.includes("application/json")) {
      const jsonResponse = await response.json();

      // Convert reasoning_content to thinking format
      if (jsonResponse.choices?.[0]?.message?.reasoning_content) {
        jsonResponse.choices[0].message.thinking = {
          content: jsonResponse.choices[0].message.reasoning_content,
        };
        delete jsonResponse.choices[0].message.reasoning_content;
      }

      return new Response(JSON.stringify(jsonResponse), {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    }

    // Handle streaming response
    if (response.headers.get("Content-Type")?.includes("stream")) {
      if (!response.body) {
        return response;
      }

      const decoder = new TextDecoder();
      const encoder = new TextEncoder();
      let hasTextContent = false;
      let reasoningContent = "";
      let isReasoningComplete = false;
      let hasToolCall = false;
      let buffer = "";

      const stream = new ReadableStream({
        async start(controller) {
          const reader = response.body!.getReader();

          const processBuffer = (
            buf: string,
            ctrl: ReadableStreamDefaultController,
            enc: TextEncoder
          ) => {
            const lines = buf.split("\n");
            for (const line of lines) {
              if (line.trim()) {
                ctrl.enqueue(enc.encode(line + "\n"));
              }
            }
          };

          const processLine = (
            line: string,
            ctx: {
              controller: ReadableStreamDefaultController;
              encoder: TextEncoder;
              hasTextContent: () => boolean;
              setHasTextContent: (val: boolean) => void;
              reasoningContent: () => string;
              appendReasoningContent: (content: string) => void;
              isReasoningComplete: () => boolean;
              setReasoningComplete: (val: boolean) => void;
            }
          ) => {
            const { controller, encoder } = ctx;

            if (line.startsWith("data: ") && line.trim() !== "data: [DONE]") {
              try {
                const data = JSON.parse(line.slice(6));

                // Handle usage chunk — map finish_reason for tool calls
                if (data.usage) {
                  data.choices[0].finish_reason = hasToolCall
                    ? "tool_calls"
                    : "stop";
                }

                // Propagate error events as SSE error data
                if (data.choices?.[0]?.finish_reason === "error") {
                  controller.enqueue(
                    encoder.encode(
                      `data: ${JSON.stringify({
                        error: data.choices?.[0]?.error,
                      })}\n\n`
                    )
                  );
                  return;
                }

                // Track first text content
                if (
                  data.choices?.[0]?.delta?.content &&
                  !ctx.hasTextContent()
                ) {
                  ctx.setHasTextContent(true);
                }

                // Extract reasoning content from delta
                // GLM may use "reasoning" or "reasoning_content" fields
                const reasoningDelta =
                  data.choices?.[0]?.delta?.reasoning ||
                  data.choices?.[0]?.delta?.reasoning_content;
                if (reasoningDelta) {
                  ctx.appendReasoningContent(reasoningDelta);
                  const thinkingChunk = {
                    ...data,
                    choices: [
                      {
                        ...data.choices?.[0],
                        delta: {
                          ...data.choices[0].delta,
                          thinking: {
                            content: reasoningDelta,
                          },
                        },
                      },
                    ],
                  };
                  if (thinkingChunk.choices?.[0]?.delta) {
                    delete thinkingChunk.choices[0].delta.reasoning;
                    delete thinkingChunk.choices[0].delta.reasoning_content;
                  }
                  controller.enqueue(
                    encoder.encode(
                      `data: ${JSON.stringify(thinkingChunk)}\n\n`
                    )
                  );
                  return;
                }

                // When reasoning is complete and text content starts, emit the
                // full thinking block with a synthetic signature.
                if (
                  data.choices?.[0]?.delta?.content &&
                  ctx.reasoningContent() &&
                  !ctx.isReasoningComplete()
                ) {
                  ctx.setReasoningComplete(true);
                  const signature = "ccr_think_signature";
                  const originalContent = data.choices[0].delta.content;

                  const thinkingChunk = {
                    ...data,
                    choices: [
                      {
                        ...data.choices?.[0],
                        delta: {
                          ...data.choices[0].delta,
                          content: null,
                          thinking: {
                            content: ctx.reasoningContent(),
                            signature: signature,
                          },
                        },
                      },
                    ],
                  };
                  if (thinkingChunk.choices?.[0]?.delta) {
                    delete thinkingChunk.choices[0].delta.reasoning;
                    delete thinkingChunk.choices[0].delta.reasoning_content;
                  }
                  controller.enqueue(
                    encoder.encode(
                      `data: ${JSON.stringify(thinkingChunk)}\n\n`
                    )
                  );

                  // Immediately send the original content delta after thinking
                  const contentChunk = {
                    ...data,
                    choices: [
                      {
                        ...data.choices?.[0],
                        delta: {
                          ...data.choices[0].delta,
                          content: originalContent,
                        },
                      },
                    ],
                  };
                  if (contentChunk.choices?.[0]?.delta) {
                    delete contentChunk.choices[0].delta.reasoning;
                    delete contentChunk.choices[0].delta.reasoning_content;
                  }
                  controller.enqueue(
                    encoder.encode(
                      `data: ${JSON.stringify(contentChunk)}\n\n`
                    )
                  );
                  return;
                }

                // Clean up any residual reasoning fields
                if (data.choices?.[0]?.delta?.reasoning) {
                  delete data.choices[0].delta.reasoning;
                }
                if (data.choices?.[0]?.delta?.reasoning_content) {
                  delete data.choices[0].delta.reasoning_content;
                }

                // Replace purely-numeric tool call IDs with UUID-based IDs.
                // Some providers (including GLM via OpenCode) return numeric
                // IDs that can cause downstream parsing issues.
                if (
                  data.choices?.[0]?.delta?.tool_calls?.length &&
                  !Number.isNaN(
                    parseInt(data.choices?.[0]?.delta?.tool_calls[0].id, 10)
                  )
                ) {
                  data.choices?.[0]?.delta?.tool_calls.forEach((tool: any) => {
                    tool.id = `call_${uuidv4()}`;
                  });
                }

                if (
                  data.choices?.[0]?.delta?.tool_calls?.length &&
                  !hasToolCall
                ) {
                  hasToolCall = true;
                }

                // Skip empty heartbeat chunks
                const delta = data.choices?.[0]?.delta;
                const hasMeaningfulDelta =
                  delta && Object.keys(delta).length > 0;
                const hasFinishReason = data.choices?.[0]?.finish_reason;
                const hasUsage = data.usage;

                if (hasMeaningfulDelta || hasFinishReason || hasUsage) {
                  controller.enqueue(
                    encoder.encode(`data: ${JSON.stringify(data)}\n\n`)
                  );
                }
              } catch (e) {
                controller.enqueue(encoder.encode(line + "\n"));
              }
            } else {
              controller.enqueue(encoder.encode(line + "\n"));
            }
          };

          try {
            while (true) {
              const { done, value } = await reader.read();
              if (done) {
                if (buffer.trim()) {
                  processBuffer(buffer, controller, encoder);
                }
                break;
              }

              if (!value || value.length === 0) {
                continue;
              }

              let chunk;
              try {
                chunk = decoder.decode(value, { stream: true });
              } catch (decodeError) {
                console.warn("Failed to decode chunk", decodeError);
                continue;
              }

              if (chunk.length === 0) {
                continue;
              }

              buffer += chunk;

              // Flush partial data if buffer grows too large
              if (buffer.length > 1000000) {
                console.warn(
                  "Buffer size exceeds limit, processing partial data"
                );
                const lines = buffer.split("\n");
                buffer = lines.pop() || "";

                for (const line of lines) {
                  if (line.trim()) {
                    try {
                      processLine(line, {
                        controller,
                        encoder,
                        hasTextContent: () => hasTextContent,
                        setHasTextContent: (val) => (hasTextContent = val),
                        reasoningContent: () => reasoningContent,
                        appendReasoningContent: (content) =>
                          (reasoningContent += content),
                        isReasoningComplete: () => isReasoningComplete,
                        setReasoningComplete: (val) =>
                          (isReasoningComplete = val),
                      });
                    } catch (error) {
                      console.error("Error processing line:", line, error);
                      controller.enqueue(encoder.encode(line + "\n"));
                    }
                  }
                }
                continue;
              }

              const lines = buffer.split("\n");
              buffer = lines.pop() || "";

              for (const line of lines) {
                if (!line.trim()) continue;

                try {
                  processLine(line, {
                    controller,
                    encoder,
                    hasTextContent: () => hasTextContent,
                    setHasTextContent: (val) => (hasTextContent = val),
                    reasoningContent: () => reasoningContent,
                    appendReasoningContent: (content) =>
                      (reasoningContent += content),
                    isReasoningComplete: () => isReasoningComplete,
                    setReasoningComplete: (val) =>
                      (isReasoningComplete = val),
                  });
                } catch (error) {
                  console.error("Error processing line:", line, error);
                  controller.enqueue(encoder.encode(line + "\n"));
                }
              }
            }
          } catch (error) {
            console.error("Stream error:", error);
            controller.error(error);
          } finally {
            try {
              reader.releaseLock();
            } catch (e) {
              console.error("Error releasing reader lock:", e);
            }
            controller.close();
          }
        },
      });

      return new Response(stream, {
        status: response.status,
        statusText: response.statusText,
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        },
      });
    }

    return response;
  }
}
