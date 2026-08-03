import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ActiveProbeService } from "../services/active-probe";
import { getHealthStore } from "../services/provider-health";

// Deterministic latency: probeProvider measures elapsed time with
// performance.now(), so advance the mocked clock inside fetch instead of
// sleeping in real time.
let nowMs = 0;

const baseProvider = {
  name: "probe-provider",
  baseUrl: "http://stub.local/v1/messages",
  apiKey: "test-key",
  models: ["m1"],
  enabled: true,
} as any;

function createService(
  providers: any[] = [baseProvider],
  overrides: Record<string, any> = {}
): ActiveProbeService {
  return new ActiveProbeService(
    () => providers,
    {
      enabled: true,
      probeTimeoutMs: 15000,
      slowThresholdMs: 3000,
      // Never start() the service in tests; keep timers out of the picture.
      initialDelayMs: 60 * 60 * 1000,
      ...overrides,
    },
    undefined,
    { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    () => undefined
  );
}

function mockFetch(handler: () => Promise<Response> | Response): void {
  vi.stubGlobal("fetch", vi.fn(async () => {
    nowMs += 120;
    return handler();
  }));
}

beforeEach(() => {
  nowMs = 0;
  vi.spyOn(performance, "now").mockImplementation(() => nowMs);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("provider probe telemetry", () => {
  it("records a fast successful probe as healthy", async () => {
    mockFetch(() => new Response(JSON.stringify({ data: [] }), { status: 200 }));
    const service = createService();

    const result = await service.probeProviderManually("probe-provider");

    expect(result.success).toBe(true);
    expect(result.latencyMs).toBe(120);
    expect(result.status).toBe("healthy");
    expect(result.isSlow).toBe(false);

    const telemetry = service.getProviderProbeTelemetry("probe-provider");
    expect(telemetry).toMatchObject({
      provider: "probe-provider",
      latencyMs: 120,
      status: "healthy",
      isSlow: false,
      source: "manual",
    });
    expect(telemetry?.lastProbeAt).toBeGreaterThan(0);
    expect(telemetry?.lastSuccessAt).toBeGreaterThan(0);
  });

  it("flags slow-but-successful probes without opening the circuit breaker", async () => {
    // 3500 ms > 3000 ms threshold.
    vi.stubGlobal("fetch", vi.fn(async () => {
      nowMs += 3500;
      return new Response(JSON.stringify({ data: [] }), { status: 200 });
    }));
    const service = createService();

    const result = await service.probeProviderManually("probe-provider");

    expect(result.success).toBe(true);
    expect(result.status).toBe("slow");
    expect(result.isSlow).toBe(true);

    const state = getHealthStore().getState("probe-provider", "m1");
    expect(state?.status ?? "closed").not.toBe("open");
    expect(service.getProbeTelemetry()[0].isSlow).toBe(true);
  });

  it("classifies aborted probes as timeout failures", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      nowMs += 15000;
      const error = new Error("The operation was aborted due to timeout");
      error.name = "TimeoutError";
      throw error;
    }));
    const service = createService();

    const result = await service.probeProviderManually("probe-provider");

    expect(result.success).toBe(false);
    expect(result.status).toBe("timeout");
    expect(result.errorKind).toBe("timeout");
    expect(service.getProviderProbeTelemetry("probe-provider")?.status).toBe("timeout");
  });

  it("classifies fetch exceptions as network errors", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      nowMs += 50;
      throw new TypeError("fetch failed");
    }));
    const service = createService();

    const result = await service.probeProviderManually("probe-provider");

    expect(result.success).toBe(false);
    expect(result.status).toBe("error");
    expect(result.errorKind).toBe("network");
  });

  it("classifies server errors as http failures but treats 4xx as reachable", async () => {
    mockFetch(() => new Response("boom", { status: 500 }));
    const failing = createService([baseProvider]);
    const failure = await failing.probeProviderManually("probe-provider");
    expect(failure.success).toBe(false);
    expect(failure.errorKind).toBe("http");
    expect(failure.status).toBe("error");

    mockFetch(() => new Response("unauthorized", { status: 401 }));
    const reachable = createService([{ ...baseProvider, name: "probe-4xx", models: ["m2"] }]);
    const auth = await reachable.probeProviderManually("probe-4xx");
    expect(auth.success).toBe(true);
    expect(auth.status).toBe("healthy");
  });

  it("rejects unknown or disabled providers without telemetry", async () => {
    mockFetch(() => new Response("{}", { status: 200 }));
    const service = createService([{ ...baseProvider, enabled: false }]);

    const missing = await service.probeProviderManually("nope");
    expect(missing.success).toBe(false);
    expect(missing.status).toBe("error");

    const disabled = await service.probeProviderManually("probe-provider");
    expect(disabled.success).toBe(false);
    expect(service.getProbeTelemetry()).toEqual([]);
  });

  it("records scheduled health probes with source 'health'", async () => {
    mockFetch(() => new Response(JSON.stringify({ data: [] }), { status: 200 }));
    const service = createService();

    await (service as any).runHealthProbe();

    expect(service.getProviderProbeTelemetry("probe-provider")?.source).toBe("health");
  });

  it("records Kimi/Moonshot header probes with source 'rate-limit-headers'", async () => {
    mockFetch(() => new Response(JSON.stringify({ data: [] }), { status: 200 }));
    const moonshot = {
      ...baseProvider,
      name: "moonshot-provider",
      baseUrl: "https://api.moonshot.cn/v1/chat/completions",
    };
    const service = createService([moonshot]);

    await (service as any).runQuotaProbe();

    const telemetry = service.getProviderProbeTelemetry("moonshot-provider");
    expect(telemetry?.source).toBe("rate-limit-headers");
    expect(telemetry?.status).toBe("healthy");
  });

  it("does not let quota adapter or wakeup cycles overwrite reachability telemetry", async () => {
    mockFetch(() => new Response(JSON.stringify({ data: [] }), { status: 200 }));
    // stub.local matches no quota adapter and is not a header-probe host, so
    // runQuotaProbe has nothing to record; wakeup is globally disabled.
    const service = createService();

    await (service as any).runQuotaProbe();
    await (service as any).runScheduledWakeup();

    expect(service.getProviderProbeTelemetry("probe-provider")).toBeUndefined();
    expect(service.getProbeTelemetry()).toEqual([]);
  });
});
