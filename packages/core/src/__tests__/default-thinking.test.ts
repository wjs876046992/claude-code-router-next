import { describe, it, expect } from "vitest";
import { DefaultThinkingTransformer, sniffEndpointKind, parseThinkingLevel } from "../transformer/defaultthinking.transformer";
import { AnthropicTransformer } from "../transformer/anthropic.transformer";
import { convertToAnthropic } from "../utils/converter";
import { getThinkBudget, getThinkLevel, normalizeEffort } from "../utils/thinking";
import { ProviderService } from "../services/provider";
import { TransformerService } from "../services/transformer";
import { UnifiedChatRequest } from "../types/llm";

function makeRequest(overrides?: Partial<UnifiedChatRequest>): UnifiedChatRequest {
  return {
    messages: [
      { role: "system", content: "sys" },
      { role: "user", content: "hi" },
    ],
    model: "test-model",
    stream: true,
    ...overrides,
  };
}

describe("sniffEndpointKind", () => {
  it("detects anthropic, responses and chat endpoints", () => {
    expect(sniffEndpointKind("https://open.bigmodel.cn/api/anthropic/v1/messages")).toBe("anthropic");
    expect(sniffEndpointKind("https://api.openai.com/v1/responses")).toBe("responses");
    expect(sniffEndpointKind("https://api.deepseek.com/v1/chat/completions")).toBe("chat");
    expect(sniffEndpointKind("https://example.com")).toBe("chat");
    expect(sniffEndpointKind(undefined)).toBe("chat");
    expect(sniffEndpointKind("not-a-url")).toBe("chat");
  });
});

describe("DefaultThinkingTransformer", () => {
  it("injects reasoning_effort for OpenAI-compatible chat endpoints", async () => {
    const t = new DefaultThinkingTransformer({ level: "high" });
    const request = makeRequest();
    const result: any = await t.transformRequestIn(request, {
      baseUrl: "https://api.deepseek.com/v1/chat/completions",
    });
    expect(result.reasoning_effort).toBe("high");
    expect(result.reasoning).toBeUndefined();
  });

  it("injects unified reasoning for Anthropic and Responses endpoints", async () => {
    const t = new DefaultThinkingTransformer({ level: "medium" });
    const anthropicResult = await t.transformRequestIn(makeRequest(), {
      baseUrl: "https://open.bigmodel.cn/api/anthropic/v1/messages",
    });
    expect(anthropicResult.reasoning).toEqual({ enabled: true, effort: "medium" });

    const responsesResult = await t.transformRequestIn(makeRequest(), {
      baseUrl: "https://api.openai.com/v1/responses",
    });
    expect(responsesResult.reasoning).toEqual({ enabled: true, effort: "medium" });
  });

  it("never overrides client-set reasoning, even when disabled", async () => {
    const t = new DefaultThinkingTransformer({ level: "high" });
    const explicitOff = makeRequest({
      reasoning: { enabled: false, effort: "low" },
    });
    const result: any = await t.transformRequestIn(explicitOff, {
      baseUrl: "https://api.deepseek.com/v1/chat/completions",
    });
    expect(result.reasoning_effort).toBeUndefined();
    expect(result.reasoning).toEqual({ enabled: false, effort: "low" });
  });

  it("is a no-op for level none or missing", async () => {
    const none = new DefaultThinkingTransformer({ level: "none" });
    const request = makeRequest();
    const result: any = await none.transformRequestIn(request, {
      baseUrl: "https://api.deepseek.com/v1/chat/completions",
    });
    expect(result.reasoning_effort).toBeUndefined();

    const noOptions = new DefaultThinkingTransformer(undefined);
    const result2: any = await noOptions.transformRequestIn(makeRequest(), {
      baseUrl: "https://api.deepseek.com/v1/chat/completions",
    });
    expect(result2.reasoning_effort).toBeUndefined();
  });

  it("is registered under the defaultthinking name", async () => {
    const mockConfig = { get: () => [] } as any;
    const ts = new TransformerService(mockConfig, { info: () => {}, error: () => {} });
    await ts.initialize();
    expect(ts.getTransformer("defaultthinking")).toBeDefined();
  });
});

describe("DefaultThinkingTransformer custom budget", () => {
  it("passes a numeric budget verbatim to Anthropic endpoints via reasoning.max_tokens", async () => {
    const t = new DefaultThinkingTransformer({ level: 4096 });
    const result = await t.transformRequestIn(makeRequest(), {
      baseUrl: "https://open.bigmodel.cn/api/anthropic/v1/messages",
    });
    expect(result.reasoning).toEqual({ enabled: true, max_tokens: 4096 });
  });

  it("raises a sub-minimum numeric budget to Anthropic's 1024 floor", async () => {
    const t = new DefaultThinkingTransformer({ level: 500 });
    const result = await t.transformRequestIn(makeRequest(), {
      baseUrl: "https://open.bigmodel.cn/api/anthropic/v1/messages",
    });
    expect(result.reasoning).toEqual({ enabled: true, max_tokens: 1024 });
  });

  it("collapses a numeric budget to the effort enum on OpenAI endpoints", async () => {
    const t = new DefaultThinkingTransformer({ level: 4096 });
    const chat: any = await t.transformRequestIn(makeRequest(), {
      baseUrl: "https://api.deepseek.com/v1/chat/completions",
    });
    expect(chat.reasoning_effort).toBe("medium");
    expect(chat.reasoning).toBeUndefined();

    const responses = await t.transformRequestIn(makeRequest(), {
      baseUrl: "https://api.openai.com/v1/responses",
    });
    expect(responses.reasoning).toEqual({ enabled: true, effort: "medium" });
  });

  it("accepts numeric strings and passes provider-specific values verbatim on OpenAI endpoints", async () => {
    const t = new DefaultThinkingTransformer({ level: "2048" });
    const result: any = await t.transformRequestIn(makeRequest(), {
      baseUrl: "https://api.deepseek.com/v1/chat/completions",
    });
    expect(result.reasoning_effort).toBe("medium");

    const minimal = new DefaultThinkingTransformer({ level: "minimal" });
    const passthrough: any = await minimal.transformRequestIn(makeRequest(), {
      baseUrl: "https://api.deepseek.com/v1/chat/completions",
    });
    expect(passthrough.reasoning_effort).toBe("minimal");

    const responses = await minimal.transformRequestIn(makeRequest(), {
      baseUrl: "https://api.openai.com/v1/responses",
    });
    expect(responses.reasoning).toEqual({ enabled: true, effort: "minimal" });
  });

  it("resolves alias strings to standard levels on Anthropic endpoints and skips unknown ones", async () => {
    const minimal = new DefaultThinkingTransformer({ level: "minimal" });
    const minResult = await minimal.transformRequestIn(makeRequest(), {
      baseUrl: "https://open.bigmodel.cn/api/anthropic/v1/messages",
    });
    expect(minResult.reasoning).toEqual({ enabled: true, effort: "low" });

    const maximum = new DefaultThinkingTransformer({ level: "MAX" });
    const maxResult = await maximum.transformRequestIn(makeRequest(), {
      baseUrl: "https://open.bigmodel.cn/api/anthropic/v1/messages",
    });
    expect(maxResult.reasoning).toEqual({ enabled: true, effort: "max" });

    const unknown = new DefaultThinkingTransformer({ level: "off" });
    const unknownResult = await unknown.transformRequestIn(makeRequest(), {
      baseUrl: "https://open.bigmodel.cn/api/anthropic/v1/messages",
    });
    expect(unknownResult.reasoning).toBeUndefined();
  });

  it("sends the max tier as an effort level on every endpoint kind", async () => {
    const t = new DefaultThinkingTransformer({ level: "max" });

    const chat: any = await t.transformRequestIn(makeRequest(), {
      baseUrl: "https://api.deepseek.com/v1/chat/completions",
    });
    expect(chat.reasoning_effort).toBe("max");

    const anthropic = await t.transformRequestIn(makeRequest(), {
      baseUrl: "https://open.bigmodel.cn/api/anthropic/v1/messages",
    });
    expect(anthropic.reasoning).toEqual({ enabled: true, effort: "max" });

    const responses = await t.transformRequestIn(makeRequest(), {
      baseUrl: "https://api.openai.com/v1/responses",
    });
    expect(responses.reasoning).toEqual({ enabled: true, effort: "max" });
  });

  it("keeps the author's spelling of an alias on OpenAI-style endpoints", async () => {
    const light = new DefaultThinkingTransformer({ level: "light" });

    const chat: any = await light.transformRequestIn(makeRequest(), {
      baseUrl: "https://api.deepseek.com/v1/chat/completions",
    });
    expect(chat.reasoning_effort).toBe("light");

    const anthropic = await light.transformRequestIn(makeRequest(), {
      baseUrl: "https://open.bigmodel.cn/api/anthropic/v1/messages",
    });
    expect(anthropic.reasoning).toEqual({ enabled: true, effort: "low" });
  });

  it("ignores empty and none values", async () => {
    const empty = new DefaultThinkingTransformer({ level: "" });
    const none: any = await empty.transformRequestIn(makeRequest(), {
      baseUrl: "https://api.deepseek.com/v1/chat/completions",
    });
    expect(none.reasoning_effort).toBeUndefined();

    const off = new DefaultThinkingTransformer({ level: "none" });
    const none2: any = await off.transformRequestIn(makeRequest(), {
      baseUrl: "https://api.deepseek.com/v1/chat/completions",
    });
    expect(none2.reasoning_effort).toBeUndefined();
  });
});

describe("parseThinkingLevel", () => {
  it("parses enum strings, positive integers, numeric strings, and passes the rest through", () => {
    expect(parseThinkingLevel("high")).toBe("high");
    expect(parseThinkingLevel(" none ")).toBe("none");
    expect(parseThinkingLevel(4096)).toBe(4096);
    expect(parseThinkingLevel("4096")).toBe(4096);
    expect(parseThinkingLevel("minimal")).toBe("minimal");
    expect(parseThinkingLevel("Off")).toBe("Off"); // provider casing preserved
    expect(parseThinkingLevel("")).toBeUndefined();
    expect(parseThinkingLevel("   ")).toBeUndefined();
    expect(parseThinkingLevel(null)).toBeUndefined();
  });
});

describe("convertToAnthropic reasoning mapping", () => {
  it("maps enabled reasoning to an Anthropic thinking block with a clamped budget", () => {
    const body: any = convertToAnthropic(
      makeRequest({
        max_tokens: 4096,
        reasoning: { enabled: true, effort: "high" },
      })
    );
    // high=16384 clamped below max_tokens 4096 -> 3072
    expect(body.thinking).toEqual({ type: "enabled", budget_tokens: 3072 });

    const roomy: any = convertToAnthropic(
      makeRequest({
        max_tokens: 64000,
        reasoning: { enabled: true, effort: "medium" },
      })
    );
    expect(roomy.thinking).toEqual({ type: "enabled", budget_tokens: 8192 });
  });

  it("also publishes the level as output_config.effort", () => {
    const body: any = convertToAnthropic(
      makeRequest({
        max_tokens: 64000,
        reasoning: { enabled: true, effort: "medium" },
      })
    );
    expect(body.output_config).toEqual({ effort: "medium" });

    const low: any = convertToAnthropic(
      makeRequest({ max_tokens: 64000, reasoning: { enabled: true, effort: "low" } })
    );
    expect(low.output_config).toEqual({ effort: "low" });
  });

  it("derives the effort tier from a custom budget", () => {
    const body: any = convertToAnthropic(
      makeRequest({
        max_tokens: 64000,
        reasoning: { enabled: true, max_tokens: 4096 },
      })
    );
    expect(body.thinking).toEqual({ type: "enabled", budget_tokens: 4096 });
    expect(body.output_config).toEqual({ effort: "medium" });
  });

  it("omits output_config for the max tier, which only the budget can carry", () => {
    const named: any = convertToAnthropic(
      makeRequest({ max_tokens: 64000, reasoning: { enabled: true, effort: "max" } })
    );
    expect(named.thinking).toEqual({ type: "enabled", budget_tokens: 32768 });
    expect(named.output_config).toBeUndefined();

    const budgeted: any = convertToAnthropic(
      makeRequest({ max_tokens: 64000, reasoning: { enabled: true, max_tokens: 32768 } })
    );
    expect(budgeted.thinking).toEqual({ type: "enabled", budget_tokens: 32768 });
    expect(budgeted.output_config).toBeUndefined();
  });

  it("honors explicit reasoning.max_tokens as the budget", () => {
    const body: any = convertToAnthropic(
      makeRequest({
        max_tokens: 32000,
        reasoning: { enabled: true, max_tokens: 4096 },
      })
    );
    expect(body.thinking).toEqual({ type: "enabled", budget_tokens: 4096 });
  });

  it("omits thinking when reasoning is absent, disabled, or no budget fits", () => {
    const absent: any = convertToAnthropic(makeRequest({ max_tokens: 4096 }));
    expect(absent.thinking).toBeUndefined();
    expect(absent.output_config).toBeUndefined();

    const disabled: any = convertToAnthropic(
      makeRequest({ max_tokens: 4096, reasoning: { enabled: false } })
    );
    expect(disabled.thinking).toBeUndefined();

    const tooSmall: any = convertToAnthropic(
      makeRequest({ max_tokens: 1024, reasoning: { enabled: true, effort: "high" } })
    );
    expect(tooSmall.thinking).toBeUndefined();
  });
});

describe("ProviderService injects default_thinking_level", () => {
  it("prepends a defaultthinking transformer when the provider config sets it", async () => {
    const mockConfig = {
      get: (key: string) => {
        if (key === "providers") {
          return [
            {
              name: "p1",
              api_base_url: "https://api.deepseek.com/v1/chat/completions",
              api_key: "k",
              models: ["m1"],
              default_thinking_level: "high",
              transformer: { use: ["deepseek"] },
            },
          ];
        }
        return undefined;
      },
    } as any;
    const ts = new TransformerService(mockConfig, { info: () => {}, error: () => {} });
    await ts.initialize();
    const ps = new ProviderService(mockConfig, ts, { info: () => {}, warn: () => {}, error: () => {} });

    const provider = ps.getProvider("p1")!;
    expect(provider).toBeDefined();
    expect(provider.transformer?.use?.length).toBe(2);
    expect((provider.transformer?.use?.[0] as any).constructor.TransformerName).toBe("defaultthinking");

    // The injected transformer carries the configured level.
    const injected = provider.transformer!.use![0] as any;
    const result: any = await injected.transformRequestIn(makeRequest(), provider);
    expect(result.reasoning_effort).toBe("high");
  });

  it("does not inject when default_thinking_level is unset", async () => {
    const mockConfig = {
      get: (key: string) => {
        if (key === "providers") {
          return [
            {
              name: "p2",
              api_base_url: "https://api.deepseek.com/v1/chat/completions",
              api_key: "k",
              models: ["m1"],
            },
          ];
        }
        return undefined;
      },
    } as any;
    const ts = new TransformerService(mockConfig, { info: () => {}, error: () => {} });
    await ts.initialize();
    const ps = new ProviderService(mockConfig, ts, { info: () => {}, warn: () => {}, error: () => {} });

    const provider = ps.getProvider("p2")!;
    expect(provider.transformer?.use).toBeUndefined();
  });
});

describe("thinking level ladder", () => {
  it("round-trips every level through its budget", () => {
    for (const level of ["low", "medium", "high", "max"] as const) {
      expect(getThinkLevel(getThinkBudget(level))).toBe(level);
    }
    expect(getThinkBudget("none")).toBe(0);
  });

  it("normalizes the effort spellings providers publish", () => {
    expect(normalizeEffort("minimal")).toBe("low");
    expect(normalizeEffort("light")).toBe("low");
    expect(normalizeEffort("XHIGH")).toBe("max");
    expect(normalizeEffort("ultra")).toBe("max");
    expect(normalizeEffort("disabled")).toBe("none");
    expect(normalizeEffort("bogus")).toBeUndefined();
    expect(normalizeEffort(4096)).toBeUndefined();
  });
});

describe("AnthropicTransformer thinking ingress", () => {
  const transformer = new AnthropicTransformer();
  const body = (extra: Record<string, any> = {}) => ({
    model: "glm-5.3",
    max_tokens: 64000,
    messages: [{ role: "user", content: "hi" }],
    ...extra,
  });

  it("keeps a client budget and derives its level", async () => {
    const unified: any = await transformer.transformRequestOut(
      body({ thinking: { type: "enabled", budget_tokens: 20000 } })
    );
    expect(unified.reasoning).toEqual({
      enabled: true,
      effort: "max",
      max_tokens: 20000,
    });
  });

  it("treats adaptive thinking as enabled instead of dropping it", async () => {
    const unified: any = await transformer.transformRequestOut(
      body({ thinking: { type: "adaptive" } })
    );
    expect(unified.reasoning).toEqual({ enabled: true });
  });

  it("reads output_config.effort, which wins over the switch and budget", async () => {
    const unified: any = await transformer.transformRequestOut(
      body({
        thinking: { type: "adaptive", budget_tokens: 4096 },
        output_config: { effort: "max" },
      })
    );
    expect(unified.reasoning).toEqual({
      enabled: true,
      effort: "max",
      max_tokens: 4096,
    });
  });

  it("maps provider alias spellings from output_config.effort", async () => {
    const unified: any = await transformer.transformRequestOut(
      body({ output_config: { effort: "minimal" } })
    );
    expect(unified.reasoning).toEqual({ enabled: true, effort: "low" });
  });

  it("honors an explicit disable and leaves absent thinking to the provider default", async () => {
    const off: any = await transformer.transformRequestOut(
      body({ thinking: { type: "disabled" } })
    );
    expect(off.reasoning).toEqual({ enabled: false });

    const absent: any = await transformer.transformRequestOut(body());
    expect(absent.reasoning).toBeUndefined();

    // An unrecognized effort is not a form Anthropic can carry; leaving
    // reasoning unset keeps the provider's configured default in play.
    const unknownEffort: any = await transformer.transformRequestOut(
      body({ output_config: { effort: "bogus" } })
    );
    expect(unknownEffort.reasoning).toBeUndefined();
  });

  it("round-trips client effort into the upstream Anthropic body", async () => {
    const unified: any = await transformer.transformRequestOut(
      body({ output_config: { effort: "low" } })
    );
    const out: any = convertToAnthropic(unified);
    expect(out.thinking).toEqual({ type: "enabled", budget_tokens: 1024 });
    expect(out.output_config).toEqual({ effort: "low" });
  });

  it("sends a configured max default as a budget, leaving the provider on its own max", async () => {
    const injected: any = await new DefaultThinkingTransformer({ level: "max" }).transformRequestIn(
      body(),
      { baseUrl: "https://open.bigmodel.cn/api/anthropic/v1/messages" }
    );
    const out: any = convertToAnthropic(injected);
    expect(out.thinking).toEqual({ type: "enabled", budget_tokens: 32768 });
    expect(out.output_config).toBeUndefined();
  });
});
