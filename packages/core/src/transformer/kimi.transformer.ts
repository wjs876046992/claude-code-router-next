import { UnifiedChatRequest } from "../types/llm";
import { Transformer } from "../types/transformer";

/**
 * Kimi (Moonshot AI) Transformer
 *
 * Handles Kimi-specific requirements for thinking mode:
 * - When thinking is enabled, assistant messages with tool_calls must have reasoning_content
 * - Preserves reasoning_content_signature for multi-turn conversations
 *
 * Kimi API requires reasoning_content in assistant tool call messages when thinking mode is active.
 * Without this, the API returns: "thinking is enabled but reasoning_content is missing in assistant tool call message"
 */
export class KimiTransformer implements Transformer {
  name = "kimi";

  async transformRequestIn(request: UnifiedChatRequest): Promise<UnifiedChatRequest> {
    // Check if thinking/reasoning is enabled
    const hasThinking = request.thinking || request.reasoning?.enabled ||
      request.messages.some(m => m.thinking?.content);

    if (hasThinking) {
      request.messages.forEach((message) => {
        if (message.role === "assistant") {
          const thinkingContent = message.thinking?.content;
          const thinkingSignature = message.thinking?.signature;

          // Case 1: Has thinking content - convert to reasoning_content format
          if (thinkingContent && typeof thinkingContent === "string" && thinkingContent.trim()) {
            (message as any).reasoning_content = thinkingContent;
            if (thinkingSignature) {
              (message as any).reasoning_content_signature = thinkingSignature;
            }
          }

          // Case 2: Has tool_calls but no reasoning_content - Kimi requires at least empty reasoning_content
          // This is the key fix for the error: "thinking is enabled but reasoning_content is missing"
          if (message.tool_calls && message.tool_calls.length > 0) {
            if (!(message as any).reasoning_content) {
              // Add empty reasoning_content to satisfy Kimi API requirement
              (message as any).reasoning_content = "";
            }
          }

          // Clean up thinking field - Kimi uses reasoning_content format
          if (message.thinking) {
            delete message.thinking;
          }
        }
      });
    }

    return request;
  }

  async transformResponseOut(response: Response): Promise<Response> {
    const contentType = response.headers.get("Content-Type");

    // Handle streaming response
    if (contentType?.includes("stream")) {
      if (!response.body) {
        return response;
      }

      const decoder = new TextDecoder();
      const encoder = new TextEncoder();
      let reasoningContent = "";
      let buffer = "";

      const stream = new ReadableStream({
        async start(controller) {
          const reader = response.body!.getReader();

          try {
            while (true) {
              const { done, value } = await reader.read();
              if (done) {
                if (buffer.trim()) {
                  controller.enqueue(encoder.encode(buffer + "\n"));
                }
                break;
              }

              const chunk = decoder.decode(value, { stream: true });
              buffer += chunk;

              const lines = buffer.split("\n");
              buffer = lines.pop() || "";

              for (const line of lines) {
                if (!line.trim()) continue;

                if (line.startsWith("data: ") && line.trim() !== "data: [DONE]") {
                  try {
                    const data = JSON.parse(line.slice(6));

                    // Convert reasoning_content to thinking format for Claude Code
                    if (data.choices?.[0]?.delta?.reasoning_content) {
                      reasoningContent += data.choices[0].delta.reasoning_content;
                      const thinkingChunk = {
                        ...data,
                        choices: [
                          {
                            ...data.choices[0],
                            delta: {
                              thinking: {
                                content: data.choices[0].delta.reasoning_content,
                              },
                            },
                          },
                        ],
                      };
                      delete thinkingChunk.choices[0].delta.reasoning_content;
                      controller.enqueue(encoder.encode(`data: ${JSON.stringify(thinkingChunk)}\n\n`));
                      continue;
                    }

                    // When reasoning is complete, send the full thinking block with signature
                    if (data.choices?.[0]?.delta?.content && reasoningContent && !data.choices[0]?.delta?.reasoning_content) {
                      const signature = Date.now().toString();
                      const thinkingBlockChunk = {
                        ...data,
                        choices: [
                          {
                            ...data.choices[0],
                            delta: {
                              content: null,
                              thinking: {
                                content: reasoningContent,
                                signature: signature,
                              },
                            },
                          },
                        ],
                      };
                      controller.enqueue(encoder.encode(`data: ${JSON.stringify(thinkingBlockChunk)}\n\n`));
                      reasoningContent = ""; // Reset after sending
                    }

                    // Clean up reasoning_content from response
                    if (data.choices?.[0]?.delta?.reasoning_content) {
                      delete data.choices[0].delta.reasoning_content;
                    }

                    if (data.choices?.[0]?.delta && Object.keys(data.choices[0].delta).length > 0) {
                      controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
                    }
                  } catch (e) {
                    controller.enqueue(encoder.encode(line + "\n"));
                  }
                } else {
                  controller.enqueue(encoder.encode(line + "\n"));
                }
              }
            }
          } catch (error) {
            controller.error(error);
          } finally {
            try {
              reader.releaseLock();
            } catch (e) {}
            controller.close();
          }
        },
      });

      return new Response(stream, {
        status: response.status,
        statusText: response.statusText,
        headers: {
          "Content-Type": contentType || "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        },
      });
    }

    // Handle non-streaming response
    if (contentType?.includes("application/json")) {
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

    return response;
  }
}