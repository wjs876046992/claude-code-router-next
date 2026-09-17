import { describe, it, expect } from "vitest";
import { OpenAITransformer } from "../transformer/openai.transformer";
import { UnifiedChatRequest } from "../types/llm";

describe("OpenAITransformer", () => {
  const transformer = new OpenAITransformer();

  it("has the correct endpoint /v1/chat/completions", () => {
    expect(transformer.endPoint).toBe("/v1/chat/completions");
  });

  it("passes through OpenAI-compatible providers on transformRequestIn", async () => {
    const request: UnifiedChatRequest = {
      model: "deepseek-v4.1-flash",
      messages: [{ role: "user", content: "hello" }],
    };
    const provider: any = {
      name: "workbuddy2api",
      baseUrl: "http://localhost:7863/v1/chat/completions",
    };
    const context: any = { req: {} };

    const result = await transformer.transformRequestIn(request, provider, context);
    expect(result).toBe(request);
    expect(context.req.isTargetAnthropic).toBeUndefined();
  });

  it("converts OpenAI request to Anthropic Messages when targeting Anthropic endpoint", async () => {
    const request: UnifiedChatRequest = {
      model: "gemini-3.8-flash-high",
      messages: [
        { role: "system", content: "You are a helpful assistant" },
        { role: "user", content: "hello" },
      ],
    };
    const provider: any = {
      name: "antigravity",
      baseUrl: "http://localhost:8045/v1/messages",
    };
    const context: any = { req: {} };

    const result = await transformer.transformRequestIn(request, provider, context);
    expect(context.req.isTargetAnthropic).toBe(true);
    expect(result.system).toBeDefined();
    expect(result.messages[0].role).toBe("user");
    expect(result.messages[0].content).toEqual([
      {
        type: "text",
        text: "hello",
        cache_control: { type: "ephemeral" },
      },
    ]);
  });

  it("converts Anthropic non-stream response into OpenAI chat.completion format", async () => {
    const anthropicResponse = {
      id: "msg_12345",
      type: "message",
      role: "assistant",
      content: [{ type: "text", text: "Hello! How can I assist you today?" }],
      model: "claude-3-opus",
      stop_reason: "end_turn",
      usage: {
        input_tokens: 15,
        output_tokens: 10,
      },
    };

    const mockResponse = new Response(JSON.stringify(anthropicResponse), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });

    const context: any = {
      req: {
        isTargetAnthropic: true,
        body: { model: "ccr-opus" },
      },
    };

    const resultResponse = await transformer.transformResponseOut(mockResponse, context);
    const resultJson = await resultResponse.json();

    expect(resultJson.object).toBe("chat.completion");
    expect(resultJson.id).toBe("msg_12345");
    expect(resultJson.model).toBe("ccr-opus");
    expect(resultJson.choices[0].message.role).toBe("assistant");
    expect(resultJson.choices[0].message.content).toBe("Hello! How can I assist you today?");
    expect(resultJson.choices[0].finish_reason).toBe("stop");
    expect(resultJson.usage.prompt_tokens).toBe(15);
    expect(resultJson.usage.completion_tokens).toBe(10);
    expect(resultJson.usage.total_tokens).toBe(25);
  });

  it("converts Anthropic tool_use into OpenAI tool_calls", async () => {
    const anthropicResponse = {
      id: "msg_tool_1",
      type: "message",
      role: "assistant",
      content: [
        {
          type: "tool_use",
          id: "call_abc123",
          name: "get_weather",
          input: { location: "Beijing" },
        },
      ],
      stop_reason: "tool_use",
      usage: { input_tokens: 20, output_tokens: 15 },
    };

    const mockResponse = new Response(JSON.stringify(anthropicResponse), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });

    const context: any = {
      req: {
        isTargetAnthropic: true,
        body: { model: "ccr-opus" },
      },
    };

    const resultResponse = await transformer.transformResponseOut(mockResponse, context);
    const resultJson = await resultResponse.json();

    expect(resultJson.choices[0].finish_reason).toBe("tool_calls");
    expect(resultJson.choices[0].message.tool_calls).toBeDefined();
    expect(resultJson.choices[0].message.tool_calls[0].id).toBe("call_abc123");
    expect(resultJson.choices[0].message.tool_calls[0].function.name).toBe("get_weather");
    expect(resultJson.choices[0].message.tool_calls[0].function.arguments).toBe('{"location":"Beijing"}');
  });
});
