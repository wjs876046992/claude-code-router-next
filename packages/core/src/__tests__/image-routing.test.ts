import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockIsAvailable } = vi.hoisted(() => ({
  mockIsAvailable: vi.fn((_provider: string, _model: string) => true),
}));

vi.mock("../services/provider-health", () => ({
  getHealthStore: () => ({ isAvailable: mockIsAvailable }),
}));

vi.mock("../services/quota-store", () => ({
  getQuotaResult: () => undefined,
}));

vi.mock("../utils/fallback-promotion", () => ({
  getFallbackPromotionStore: () => ({
    getPromotion: () => null,
    clear: vi.fn(),
  }),
}));

import { ImageAgent } from "../ccr/agents/image.agent";
import { ConfigService } from "../services/config";
import { router } from "../utils/router";

const log = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

const imageContent = {
  type: "image",
  source: {
    type: "base64",
    media_type: "image/png",
    data: "aW1hZ2U=",
  },
};

function createConfig(routerOverrides: Record<string, any> = {}): ConfigService {
  return new ConfigService({
    useJsonFile: false,
    initialConfig: {
      providers: [{
        name: "provider",
        enabled: true,
        models: [
          "text-model",
          "opus-image",
          "global-image",
          "claude-sonnet-4",
        ],
      }],
      Router: {
        enableFamilyRouting: true,
        image: "provider,global-image",
        families: {
          opus: {
            default: "provider,text-model",
            image: "provider,opus-image",
          },
        },
        ...routerOverrides,
      },
    },
  });
}

function createRequest(bodyOverrides: Record<string, any> = {}): any {
  return {
    id: "image-request",
    url: "/v1/messages",
    headers: {},
    log,
    originalModel: "ccr-opus",
    body: {
      model: "ccr-opus",
      messages: [{
        role: "user",
        content: [imageContent],
      }],
      system: "You are operating inside pi",
      tools: [],
      ...bodyOverrides,
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockIsAvailable.mockReturnValue(true);
});

describe("image routing", () => {
  it("preserves the client model and prefers the family image route", async () => {
    const req = createRequest();
    const configService = createConfig();

    await router(req, undefined, { configService });

    expect(req.originalModel).toBe("ccr-opus");
    expect(req.modelFamily).toBe("opus");
    expect(req.body.model).toBe("provider,opus-image");
    expect(req.scenarioType).toBe("image");
  });

  it("does not overwrite an original model captured before routing", async () => {
    const req = createRequest({ model: "provider,global-image" });
    const configService = createConfig();

    await router(req, undefined, { configService });

    expect(req.originalModel).toBe("ccr-opus");
    // An explicit route to a configured image model is preserved (only the
    // scenario is tagged); the router must not re-route it to the family image.
    expect(req.body.model).toBe("provider,global-image");
    expect(req.scenarioType).toBe("image");
  });

  it("falls back to the global image route when the family has none", async () => {
    const req = createRequest();
    const configService = createConfig({
      families: {
        opus: {
          default: "provider,text-model",
        },
      },
    });

    await router(req, undefined, { configService });

    expect(req.body.model).toBe("provider,global-image");
    expect(req.scenarioType).toBe("image");
  });

  it("tries the global image route when the family image route is unavailable", async () => {
    mockIsAvailable.mockImplementation((_provider: string, model: string) =>
      model !== "opus-image"
    );
    const req = createRequest();
    const configService = createConfig();

    await router(req, undefined, { configService });

    expect(req.body.model).toBe("provider,global-image");
    expect(req.scenarioType).toBe("image");
  });

  it("marks the image scenario when the family default and image routes match", async () => {
    const req = createRequest();
    const configService = createConfig({
      families: {
        opus: {
          default: "provider,text-model",
          image: "provider,text-model",
        },
      },
    });

    await router(req, undefined, { configService });

    expect(req.body.model).toBe("provider,text-model");
    expect(req.scenarioType).toBe("image");
  });

  it("keeps a family route that already supports images", async () => {
    const req = createRequest();
    const configService = createConfig({
      families: {
        opus: {
          default: "provider,claude-sonnet-4",
          image: "provider,opus-image",
        },
      },
    });

    await router(req, undefined, { configService });

    expect(req.body.model).toBe("provider,claude-sonnet-4");
    expect(req.scenarioType).toBe("default");
  });

  it("routes directly to the family image when only a family image is configured", async () => {
    const req = createRequest();
    const configService = createConfig({ image: undefined });
    const agent = new ImageAgent();

    // Without a global Router.image the force agent cannot issue a valid
    // subrequest, so it must stay off and let direct routing handle images.
    expect(agent.shouldHandle(req, {
      ...configService.getAll(),
      forceUseImageAgent: true,
    })).toBe(false);

    await router(req, undefined, { configService });

    expect(req.body.model).toBe("provider,opus-image");
    expect(req.scenarioType).toBe("image");
  });
});

describe("image agent", () => {
  it("keeps the request model while promoting tool-result images in non-force mode", () => {
    const req = createRequest({
      messages: [{
        role: "user",
        content: [{
          type: "tool_result",
          tool_use_id: "tool-1",
          content: [imageContent],
        }],
      }],
    });
    const agent = new ImageAgent();
    const config = createConfig().getAll();

    expect(agent.shouldHandle(req, config)).toBe(false);
    expect(req.body.model).toBe("ccr-opus");
    expect(req.body.messages[0].content).toEqual([
      {
        type: "tool_result",
        tool_use_id: "tool-1",
        content: "read image successfully",
      },
      imageContent,
    ]);
  });

  it("leaves tool results without images untouched", () => {
    const req = createRequest({
      messages: [
        {
          role: "user",
          content: [imageContent],
        },
        {
          role: "user",
          content: [{
            type: "tool_result",
            tool_use_id: "tool-1",
            content: [{ type: "text", text: "plain tool output" }],
          }],
        },
      ],
    });
    const agent = new ImageAgent();
    const config = createConfig().getAll();

    expect(agent.shouldHandle(req, config)).toBe(false);
    expect(req.body.messages[1].content).toEqual([{
      type: "tool_result",
      tool_use_id: "tool-1",
      content: [{ type: "text", text: "plain tool output" }],
    }]);
  });

  it("keeps text blocks when promoting images from mixed tool results", () => {
    const textBlock = { type: "text", text: "chart summary" };
    const req = createRequest({
      messages: [{
        role: "user",
        content: [{
          type: "tool_result",
          tool_use_id: "tool-1",
          content: [textBlock, imageContent],
        }],
      }],
    });
    const agent = new ImageAgent();
    const config = createConfig().getAll();

    expect(agent.shouldHandle(req, config)).toBe(false);
    expect(req.body.messages[0].content).toEqual([
      {
        type: "tool_result",
        tool_use_id: "tool-1",
        content: [textBlock],
      },
      imageContent,
    ]);
  });

  it("does not promote tool-result images when the current model supports images", () => {
    const req = createRequest({
      model: "provider,claude-sonnet-4",
      messages: [{
        role: "user",
        content: [{
          type: "tool_result",
          tool_use_id: "tool-1",
          content: [imageContent],
        }],
      }],
    });
    const originalContent = structuredClone(req.body.messages[0].content);
    const agent = new ImageAgent();
    const config = createConfig().getAll();

    expect(agent.shouldHandle(req, config)).toBe(false);
    expect(req.body.messages[0].content).toEqual(originalContent);
  });

  it("preserves the global image route for force-agent analysis calls", async () => {
    const req = createRequest();
    const agent = new ImageAgent();
    const config = {
      ...createConfig().getAll(),
      PORT: 3456,
      APIKEY: "test-key",
      forceUseImageAgent: true,
    };
    const originalFetch = globalThis.fetch;
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      content: [{ type: "text", text: "ok" }],
    }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
    globalThis.fetch = fetchMock as any;

    try {
      const result = await agent.tools.get("analyzeImage")!.handler(
        { task: "describe the image" },
        { req, config }
      );

      expect(result).toBe("ok");
      expect(fetchMock).toHaveBeenCalledOnce();
      const fetchCall = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
      const requestBody = JSON.parse(fetchCall[1].body as string);
      expect(requestBody.model).toBe("provider,global-image");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
