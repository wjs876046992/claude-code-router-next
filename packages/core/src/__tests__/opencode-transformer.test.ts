import { describe, it, expect } from "vitest";
import { OpenCodeTransformer } from "../transformer/opencode.transformer";
import { AnthropicTransformer } from "../transformer/anthropic.transformer";
import { UnifiedChatRequest, UnifiedTool } from "../types/llm";
import { TransformerService } from "../services/transformer";
import { ConfigService } from "../services/config";

// ---------------------------------------------------------------------------
// Helper: build a minimal UnifiedChatRequest with tools
// ---------------------------------------------------------------------------
function makeRequest(overrides?: Partial<UnifiedChatRequest>): UnifiedChatRequest {
  return {
    messages: [
      { role: "system", content: "You are a helpful assistant." },
      { role: "user", content: "Hello" },
    ],
    model: "glm-5.2",
    stream: true,
    tools: [
      {
        type: "function",
        function: {
          name: "Bash",
          description: "Execute a bash command",
          parameters: {
            type: "object",
            properties: {
              command: { type: "string", description: "The command to execute" },
            },
          },
        },
      },
    ],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Helper: build a provider object for AnthropicTransformer.transformRequestIn
// ---------------------------------------------------------------------------
function makeProvider(baseUrl: string) {
  return {
    name: "opencode go",
    baseUrl,
    apiKey: "test-key",
    models: ["glm-5.2"],
  } as any;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe("OpenCodeTransformer", () => {
  it("should declare endPoint=/v1/chat/completions", () => {
    const t = new OpenCodeTransformer();
    expect(t.endPoint).toBe("/v1/chat/completions");
    expect(t.name).toBeUndefined(); // uses static TransformerName
    expect((OpenCodeTransformer as any).TransformerName).toBe("opencode");
  });

  it("should clean cache_control from messages in transformRequestIn", async () => {
    const t = new OpenCodeTransformer();
    const request = makeRequest({
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "hello", cache_control: { type: "ephemeral" } },
          ],
        } as any,
      ],
    });

    const result = await t.transformRequestIn(request, makeProvider("https://opencode.ai"), {});
    const msg = result.messages[0];
    if (Array.isArray(msg.content)) {
      msg.content.forEach((item: any) => {
        expect(item.cache_control).toBeUndefined();
      });
    }
  });

  it("should clean media_type from image_url in transformRequestIn", async () => {
    const t = new OpenCodeTransformer();
    const request = makeRequest({
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image_url",
              image_url: { url: "data:image/png;base64,abc123" },
              media_type: "image/png",
            },
          ],
        } as any,
      ],
    });

    const result = await t.transformRequestIn(request, makeProvider("https://opencode.ai"), {});
    const msg = result.messages[0];
    if (Array.isArray(msg.content)) {
      const imgItem = (msg.content as any[]).find((i: any) => i.type === "image_url");
      expect(imgItem.media_type).toBeUndefined();
    }
  });

  it("should keep tools with type='function' after transformRequestIn", async () => {
    const t = new OpenCodeTransformer();
    const request = makeRequest();

    const result = await t.transformRequestIn(request, makeProvider("https://opencode.ai"), {});
    expect(result.tools).toBeDefined();
    expect(result.tools!.length).toBe(1);
    expect(result.tools![0].type).toBe("function");
    expect(result.tools![0].function.name).toBe("Bash");
  });

  it("should apply options from constructor", async () => {
    const t = new OpenCodeTransformer({ temperature: 0.5 });
    const request = makeRequest();

    const result = await t.transformRequestIn(request, makeProvider("https://opencode.ai"), {});
    expect(result.temperature).toBe(0.5);
  });
});

describe("OpenCodeTransformer registration prevents bypass", () => {
  it("should be resolvable by TransformerService", async () => {
    // Simulate how ProviderService resolves the "opencode" transformer name
    const mockConfig = {
      get: () => [],
    } as any;
    const mockLogger = { info: () => {}, error: () => {} };
    const ts = new TransformerService(mockConfig, mockLogger);
    await ts.initialize();

    const resolved = ts.getTransformer("opencode");
    expect(resolved).toBeDefined();

    // The transformer should have an endPoint
    if (typeof resolved === "function") {
      const instance = new (resolved as any)();
      expect(instance.endPoint).toBe("/v1/chat/completions");
    } else {
      expect((resolved as any).endPoint).toBe("/v1/chat/completions");
    }
  });
});

describe("End-to-end: Anthropic request → OpenCode provider tools format", () => {
  it("should produce tools with type='function' when sent to OpenAI-compatible endpoint", async () => {
    // Step 1: Simulate AnthropicTransformer.transformRequestOut (incoming Anthropic request)
    const anthropicTransformer = new AnthropicTransformer();
    const anthropicRequest = {
      model: "glm-5.2",
      max_tokens: 4096,
      stream: true,
      system: "You are a helpful assistant.",
      messages: [
        { role: "user", content: "Hello" },
      ],
      tools: [
        {
          name: "Bash",
          description: "Execute a bash command",
          input_schema: {
            type: "object",
            properties: {
              command: { type: "string", description: "The command to execute" },
            },
          },
        },
      ],
    };

    const unifiedRequest = await anthropicTransformer.transformRequestOut(anthropicRequest);

    // Verify unified format has type="function"
    expect(unifiedRequest.tools).toBeDefined();
    expect(unifiedRequest.tools!.length).toBe(1);
    expect(unifiedRequest.tools![0].type).toBe("function");
    expect(unifiedRequest.tools![0].function.name).toBe("Bash");

    // Step 2: Simulate OpenCodeTransformer.transformRequestIn
    const openCodeTransformer = new OpenCodeTransformer();
    const processedRequest = await openCodeTransformer.transformRequestIn(
      unifiedRequest,
      makeProvider("https://opencode.ai/zen/go/v1/chat/completions"),
      {}
    );

    // Step 3: Verify the tools still have type="function" after processing
    expect(processedRequest.tools).toBeDefined();
    expect(processedRequest.tools!.length).toBe(1);
    expect(processedRequest.tools![0].type).toBe("function");

    // Step 4: Simulate what gets sent via JSON.stringify (same as sendUnifiedRequest)
    const serialized = JSON.stringify(processedRequest);
    const parsed = JSON.parse(serialized);
    expect(parsed.tools[0].type).toBe("function");
    expect(parsed.tools[0].function.name).toBe("Bash");

    // Verify the old Anthropic format fields are NOT present at top level
    expect(parsed.tools[0].name).toBeUndefined();
    expect(parsed.tools[0].input_schema).toBeUndefined();
  });
});
