import { UnifiedChatRequest } from "../types/llm";
import { Transformer } from "../types/transformer";

export class DeepseekTransformer implements Transformer {
  name = "deepseek";

  async transformRequestIn(request: UnifiedChatRequest): Promise<UnifiedChatRequest> {
    if (request.max_tokens && request.max_tokens > 8192) {
      request.max_tokens = 8192; // DeepSeek has a max token limit of 8192
    }

    const isReasoningModel = request.model?.includes("reasoner") || request.model?.includes("v4") || request.model?.includes("pro") || request.model?.includes("think");
    const hasThinking = request.thinking || request.reasoning?.enabled || request.messages.some(m => m.thinking?.content) || isReasoningModel;

    // DeepSeek thinking mode does not support tool_choice parameter.
    // When present, the API returns 400: "Thinking mode does not support this tool_choice".
    // Strip it so the model can still auto-select tools without the forced constraint.
    if (hasThinking && request.tool_choice) {
      delete request.tool_choice;
    }

    // DeepSeek V4 thinking mode requirement:
    // When assistant messages have thinking content from previous turns,
    // we must pass it back as reasoning_content WITH signature.
    // DeepSeek requires: reasoning_content + signature must be preserved exactly.
    request.messages.forEach((message) => {
      if (message.role === "assistant") {
        const thinkingContent = message.thinking?.content;
        const thinkingSignature = message.thinking?.signature;

        let extractedThinking = "";
        
        // Case 1: Extract thinking block from content if Claude Code encoded it as text
        if (typeof message.content === "string") {
          const thinkingRegex = /<thinking>([\s\S]*?)<\/thinking>/g;
          const match = thinkingRegex.exec(message.content);
          if (match) {
            extractedThinking = match[1].trim();
            message.content = message.content.replace(match[0], "").trim();
          }
        }

        // Case 2: Claude-style thinking block - convert to DeepSeek format
        if (thinkingContent && typeof thinkingContent === "string" && thinkingContent.trim()) {
          (message as any).reasoning_content = thinkingContent;
          // DeepSeek V4 requires signature to be passed back
          if (thinkingSignature) {
            (message as any).reasoning_content_signature = thinkingSignature;
          }
        } else if (extractedThinking) {
          (message as any).reasoning_content = extractedThinking;
        }

        // DeepSeek V4 requires reasoning_content to be present in assistant messages
        // when thinking mode is enabled, even if there was no thinking content.
        if (hasThinking && !(message as any).reasoning_content) {
          (message as any).reasoning_content = " "; // Use a space instead of empty string to avoid empty content validation errors
        }

        // Always clean up thinking field - DeepSeek doesn't recognize it
        if (message.thinking) {
          delete message.thinking;
        }
      }
    });

    return request;
  }

  async transformResponseOut(response: Response): Promise<Response> {
    if (response.headers.get("Content-Type")?.includes("application/json")) {
      const jsonResponse = await response.json();
      // Handle non-streaming response if needed
      return new Response(JSON.stringify(jsonResponse), {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    } else if (response.headers.get("Content-Type")?.includes("stream")) {
      if (!response.body) {
        return response;
      }

      const decoder = new TextDecoder();
      const encoder = new TextEncoder();
      let reasoningContent = "";
      let isReasoningComplete = false;
      let buffer = ""; // Buffer for incomplete data chunks

      const stream = new ReadableStream({
        async start(controller) {
          const reader = response.body!.getReader();
          const processBuffer = (
            buffer: string,
            controller: ReadableStreamDefaultController,
            encoder: TextEncoder
          ) => {
            const lines = buffer.split("\n");
            for (const line of lines) {
              if (line.trim()) {
                controller.enqueue(encoder.encode(line + "\n"));
              }
            }
          };

          const processLine = (
            line: string,
            context: {
              controller: ReadableStreamDefaultController;
              encoder: TextEncoder;
              reasoningContent: () => string;
              appendReasoningContent: (content: string) => void;
              isReasoningComplete: () => boolean;
              setReasoningComplete: (val: boolean) => void;
            }
          ) => {
            const { controller, encoder } = context;

            if (
              line.startsWith("data: ") &&
              line.trim() !== "data: [DONE]"
            ) {
              try {
                const data = JSON.parse(line.slice(6));

                // Extract reasoning_content from delta
                if (data.choices?.[0]?.delta?.reasoning_content) {
                  context.appendReasoningContent(
                    data.choices[0].delta.reasoning_content
                  );
                  const thinkingChunk = {
                    ...data,
                    choices: [
                      {
                        ...data.choices[0],
                        delta: {
                          ...data.choices[0].delta,
                          thinking: {
                            content: data.choices[0].delta.reasoning_content,
                          },
                        },
                      },
                    ],
                  };
                  delete thinkingChunk.choices[0].delta.reasoning_content;
                  const thinkingLine = `data: ${JSON.stringify(
                    thinkingChunk
                  )}\n\n`;
                  controller.enqueue(encoder.encode(thinkingLine));
                  return;
                }

                // Check if reasoning is complete (when delta has content but no reasoning_content)
                if (
                  data.choices?.[0]?.delta?.content &&
                  context.reasoningContent() &&
                  !context.isReasoningComplete()
                ) {
                  context.setReasoningComplete(true);
                  const signature = "ccr_think_signature";
                  // Save the original content before we null it for thinking chunk
                  const originalContent = data.choices[0].delta.content;

                  // Create a new chunk with thinking block
                  const thinkingChunk = {
                    ...data,
                    choices: [
                      {
                        ...data.choices[0],
                        delta: {
                          ...data.choices[0].delta,
                          content: null,
                          thinking: {
                            content: context.reasoningContent(),
                            signature: signature,
                          },
                        },
                      },
                    ],
                  };
                  delete thinkingChunk.choices[0].delta.reasoning_content;
                  // Send the accumulated thinking as a single chunk
                  const thinkingLine = `data: ${JSON.stringify(
                    thinkingChunk
                  )}\n\n`;
                  controller.enqueue(encoder.encode(thinkingLine));

                  // Immediately send the original content delta after thinking chunk
                  // This ensures the first content chunk is not lost
                  const contentChunk = {
                    ...data,
                    choices: [
                      {
                        ...data.choices[0],
                        delta: {
                          ...data.choices[0].delta,
                          content: originalContent,
                        },
                      },
                    ],
                  };
                  delete contentChunk.choices[0].delta.reasoning_content;
                  const contentLine = `data: ${JSON.stringify(contentChunk)}\n\n`;
                  controller.enqueue(encoder.encode(contentLine));
                  return; // Skip further processing, we already sent the content
                }

                if (data.choices[0]?.delta?.reasoning_content) {
                  delete data.choices[0].delta.reasoning_content;
                }

                // Send the modified chunk
                // Send the modified chunk (reasoning_content already deleted above)
                if (
                  data.choices?.[0]?.delta &&
                  Object.keys(data.choices[0].delta).length > 0
                ) {
                  const modifiedLine = `data: ${JSON.stringify(data)}\n\n`;
                  controller.enqueue(encoder.encode(modifiedLine));
                }
              } catch (e) {
                // If JSON parsing fails, pass through the original line
                controller.enqueue(encoder.encode(line + "\n"));
              }
            } else {
              // Pass through non-data lines (like [DONE])
              controller.enqueue(encoder.encode(line + "\n"));
            }
          };

          try {
            while (true) {
              const { done, value } = await reader.read();
              if (done) {
                // Process remaining buffered data
                if (buffer.trim()) {
                  processBuffer(buffer, controller, encoder);
                }
                break;
              }

              const chunk = decoder.decode(value, { stream: true });
              buffer += chunk;

              // Process complete data lines in buffer
              const lines = buffer.split("\n");
              buffer = lines.pop() || ""; // Last line may be incomplete, keep in buffer

              for (const line of lines) {
                if (!line.trim()) continue;

                try {
                  processLine(line, {
                    controller,
                    encoder,
                    reasoningContent: () => reasoningContent,
                    appendReasoningContent: (content) =>
                      (reasoningContent += content),
                    isReasoningComplete: () => isReasoningComplete,
                    setReasoningComplete: (val) => (isReasoningComplete = val),
                  });
                } catch (error) {
                  console.error("Error processing line:", line, error);
                  // If parsing fails, pass through original line
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
          "Content-Type": response.headers.get("Content-Type") || "text/plain",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        },
      });
    }

    return response;
  }
}
