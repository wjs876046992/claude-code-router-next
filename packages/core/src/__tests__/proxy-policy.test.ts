import { afterEach, describe, expect, it, vi } from "vitest";
import { ConfigService } from "../services/config";
import { ProviderService } from "../services/provider";
import { TokenizerService } from "../services/tokenizer";
import {
  closeProxyDispatchers,
  getConfiguredProxyUrl,
  getProxyDispatcher,
  isGlobalProxyEnabled,
  resolveProviderProxyUrl,
} from "../services/proxy";

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  await closeProxyDispatchers();
});

describe("proxy configuration", () => {
  it("resolves proxy URL by compatibility priority and trims whitespace", () => {
    const configService = createConfigService({
      HTTPS_PROXY: "   ",
      https_proxy: "  http://lowercase.example:8080  ",
      httpsProxy: "http://camel.example:8080",
      PROXY_URL: "http://fallback.example:8080",
    });

    expect(getConfiguredProxyUrl(configService)).toBe(
      "http://lowercase.example:8080"
    );
    expect(configService.getHttpsProxy()).toBe(
      "http://lowercase.example:8080"
    );
  });

  it("uses the first non-empty proxy URL", () => {
    const configService = createConfigService({
      HTTPS_PROXY: " http://primary.example:8080 ",
      https_proxy: "http://secondary.example:8080",
    });

    expect(getConfiguredProxyUrl(configService)).toBe(
      "http://primary.example:8080"
    );
  });
});

describe("global proxy policy", () => {
  it.each([
    [undefined, true],
    [false, false],
    ["false", false],
    [" FALSE ", false],
    [0, false],
    ["0", false],
    [true, true],
    ["true", true],
    [" TRUE ", true],
    [1, true],
    ["1", true],
    ["enabled", true],
    // Empty/null/missing values keep the legacy "proxy applies to all" default
    // so a partially-written config never silently falls back to direct connections.
    ["", true],
    [null, true],
  ])("interprets %j as %s", (value, expected) => {
    expect(isGlobalProxyEnabled(value)).toBe(expected);
  });

  it("proxies every provider when the global policy is missing or enabled", () => {
    const defaultConfig = createConfigService({
      PROXY_URL: "http://proxy.example:8080",
    });
    const enabledConfig = createConfigService({
      PROXY_URL: "http://proxy.example:8080",
      PROXY_GLOBAL_ENABLED: "true",
    });

    expect(resolveProviderProxyUrl(defaultConfig, { proxyEnabled: false })).toBe(
      "http://proxy.example:8080"
    );
    expect(resolveProviderProxyUrl(enabledConfig, {})).toBe(
      "http://proxy.example:8080"
    );
  });

  it("requires an explicit provider opt-in when the global policy is disabled", () => {
    const configService = createConfigService({
      PROXY_URL: "http://proxy.example:8080",
      PROXY_GLOBAL_ENABLED: "0",
    });

    expect(resolveProviderProxyUrl(configService, {})).toBeUndefined();
    expect(
      resolveProviderProxyUrl(configService, { proxyEnabled: true })
    ).toBe("http://proxy.example:8080");
    expect(
      resolveProviderProxyUrl(configService, { proxy_enabled: true })
    ).toBe("http://proxy.example:8080");
  });

  it("uses a direct connection when no proxy URL is configured", () => {
    const configService = createConfigService({
      PROXY_GLOBAL_ENABLED: true,
    });

    expect(
      resolveProviderProxyUrl(configService, { proxyEnabled: true })
    ).toBeUndefined();
  });
});

describe("provider proxy mapping", () => {
  it("maps snake_case proxy settings and defaults missing values to false", () => {
    const configService = createConfigService({
      providers: [
        {
          name: "proxied",
          api_base_url: "https://proxied.example/v1/messages",
          api_key: "test-key",
          models: ["model-a"],
          proxy_enabled: true,
        },
        {
          name: "direct",
          api_base_url: "https://direct.example/v1/messages",
          api_key: "test-key",
          models: ["model-b"],
        },
      ],
    });
    const providerService = new ProviderService(
      configService,
      { getTransformer: () => undefined } as any,
      { info: () => undefined, error: () => undefined }
    );

    expect(providerService.getProvider("proxied")?.proxyEnabled).toBe(true);
    expect(providerService.getProvider("direct")?.proxyEnabled).toBe(false);
  });
});

describe("API tokenizer proxy scoping", () => {
  it("keeps API tokenizer instances provider-scoped", async () => {
    const configService = createConfigService({
      providers: [
        { name: "provider-a", proxy_enabled: true },
        { name: "provider-b", proxy_enabled: false },
      ],
      PROXY_URL: "http://proxy.example:8080",
      PROXY_GLOBAL_ENABLED: false,
    });
    const tokenizerService = new TokenizerService(configService, {
      info: vi.fn(),
      error: vi.fn(),
    });
    const tokenizerConfig = {
      type: "api" as const,
      url: "https://tokenizer.example/count",
      apiKey: "test-key",
    };

    const providerATokenizer = await tokenizerService.getTokenizer(
      tokenizerConfig,
      "provider-a"
    );
    const providerBTokenizer = await tokenizerService.getTokenizer(
      tokenizerConfig,
      "provider-b"
    );

    expect(providerATokenizer).not.toBe(providerBTokenizer);
    expect(
      await tokenizerService.getTokenizer(tokenizerConfig, "provider-a")
    ).toBe(providerATokenizer);
  });

  it("resolves the raw provider proxy policy for every API call", async () => {
    const rawProvider = { name: "provider-a", proxy_enabled: true };
    const configService = createConfigService({
      providers: [rawProvider],
      PROXY_URL: "http://proxy.example:8080",
      PROXY_GLOBAL_ENABLED: false,
    });
    const tokenizerService = new TokenizerService(configService, {
      info: vi.fn(),
      error: vi.fn(),
    });
    const observedDispatchers: unknown[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, options: RequestInit & { dispatcher?: unknown }) => {
        observedDispatchers.push(options.dispatcher);
        return new Response(JSON.stringify({ token_count: 1 }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      })
    );
    const tokenizer = await tokenizerService.getTokenizer(
      {
        type: "api",
        url: "https://tokenizer.example/count",
        apiKey: "test-key",
      },
      "provider-a"
    );
    const request = { messages: [{ role: "user", content: "hello" }] };

    await tokenizer.countTokens(request);
    rawProvider.proxy_enabled = false;
    await tokenizer.countTokens(request);

    expect(observedDispatchers[0]).toBeDefined();
    expect(observedDispatchers[1]).toBeUndefined();
  });
});

describe("proxy dispatcher cache", () => {
  it("normalizes URLs and reuses the same dispatcher", () => {
    const firstDispatcher = getProxyDispatcher(" http://localhost:18080 ");
    const secondDispatcher = getProxyDispatcher("http://localhost:18080/");

    expect(secondDispatcher).toBe(firstDispatcher);
  });

  it("throws for invalid or unsupported proxy URLs", () => {
    expect(() => getProxyDispatcher("not a URL")).toThrow();
    expect(() => getProxyDispatcher("socks5://localhost:1080")).toThrow(
      "Unsupported proxy protocol"
    );
  });

  it("clears the cache when dispatchers are closed", async () => {
    const firstDispatcher = getProxyDispatcher("http://localhost:18081");

    await closeProxyDispatchers();

    const secondDispatcher = getProxyDispatcher("http://localhost:18081");
    expect(secondDispatcher).not.toBe(firstDispatcher);
  });
});

function createConfigService(initialConfig: Record<string, unknown>): ConfigService {
  return new ConfigService({
    useJsonFile: false,
    useEnvironmentVariables: false,
    initialConfig,
  });
}
