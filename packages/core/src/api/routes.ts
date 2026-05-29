import {
  FastifyInstance,
  FastifyPluginAsync,
  FastifyRequest,
  FastifyReply,
} from "fastify";
import { RegisterProviderRequest, LLMProvider } from "@/types/llm";
import { sendUnifiedRequest } from "@/utils/request";
import { createApiError } from "./middleware";
import {
  isDebugLogEnabled,
  getDebugLogOptions,
  logProviderRequest,
  logProviderResponse,
  readStreamForDebug,
} from "@/utils/debug-log";
import { version } from "../../package.json";
import { ConfigService } from "@/services/config";
import { ProviderService } from "@/services/provider";
import { TransformerService } from "@/services/transformer";
import { Transformer } from "@/types/transformer";
import { getHealthStore } from "@/services/provider-health";
import { captureRateLimitHeaders } from "@/services/rate-limit";
import { getFallbackPromotionStore } from "@/utils/fallback-promotion";

// Extend FastifyInstance to include custom services
declare module "fastify" {
  interface FastifyInstance {
    configService: ConfigService;
    providerService: ProviderService;
    transformerService: TransformerService;
    recordUsage?: (data: any) => void;
  }

  interface FastifyRequest {
    provider?: string;
  }
}

/**
 * Main handler for transformer endpoints
 * Coordinates the entire request processing flow: validate provider, handle request transformers,
 * send request, handle response transformers, format response
 */
async function handleTransformerEndpoint(
  req: FastifyRequest,
  reply: FastifyReply,
  fastify: FastifyInstance,
  transformer: any
) {
  const body = req.body as any;
  const providerName = req.provider!;
  const provider = fastify.providerService.getProvider(providerName);

  // Validate provider exists
  if (!provider) {
    throw createApiError(
      `Provider '${providerName}' not found`,
      404,
      "provider_not_found"
    );
  }

  try {
    // Process request transformer chain
    const { requestBody, config, bypass } = await processRequestTransformers(
      body,
      provider,
      transformer,
      req.headers,
      {
        req,
      }
    );

    // Send request to LLM provider
    const response = await sendRequestToProvider(
      requestBody,
      config,
      provider,
      fastify,
      bypass,
      transformer,
      {
        req,
      }
    );

    // Capture rate limit headers from upstream response
    try {
      if (provider?.baseUrl && response?.headers) {
        captureRateLimitHeaders(providerName, provider.baseUrl, response.headers);
      }
    } catch {}

    // Process response transformer chain
    const finalResponse = await processResponseTransformers(
      requestBody,
      response,
      provider,
      transformer,
      bypass,
      {
        req,
      }
    );

    const result = formatResponse(finalResponse, reply, body, fastify);

    try {
      const model = body.model || (req as any).originalModel;
      if (providerName && model) {
        getHealthStore().recordSuccess(providerName, model);
      }
    } catch {}

    return result;
  } catch (error: any) {
    // Handle fallback for any request error (timeout, network, API errors)
    const fallbackResult = await handleFallback(req, reply, fastify, transformer, error);
    if (fallbackResult) {
      return fallbackResult;
    }
    throw error;
  }
}

/**
 * Handle fallback logic when request fails
 * Tries each fallback model in sequence until one succeeds
 * Skips models in fail pool (open state), uses half-open models as lower priority
 */
async function handleFallback(
  req: FastifyRequest,
  reply: FastifyReply,
  fastify: FastifyInstance,
  transformer: any,
  error: any
): Promise<any> {
  const scenarioType = (req as any).scenarioType || 'default';
  const familyFallback = (req as any).familyFallback;
  const modelFamily = (req as any).modelFamily;
  const globalFallback = fastify.configService.get<any>('fallback');
  const healthStore = getHealthStore();

  const originalProvider = req.provider || "";
  const originalModel = (req.body as any).model || "";
  const attemptedFallbacks = new Set<string>();

  if (originalProvider && originalModel) {
    healthStore.recordFailure(originalProvider, originalModel, error?.message);
    attemptedFallbacks.add(`${originalProvider},${originalModel}`);

    // Record failed primary model attempt in usage stats
    fastify.recordUsage?.({
      provider: originalProvider,
      model: originalModel,
      originalModel: (req as any).originalModel || originalModel,
      scenarioType,
      modelFamily: (req as any).modelFamily,
      errorMessage: error?.message || String(error),
      sessionId: (req as any).usageSessionId || req.id,
      stream: (req.body as any).stream,
      inputTokens: (req as any).tokenCount || 0,
    });
  }

  // Check if fallback is enabled (default: false - disabled when not set)
  const Router = fastify.configService.get<any>('Router');
  if (!Router?.enableFallback) {
    req.log.info(`Fallback disabled by configuration, skipping fallback attempts`);
    return null;
  }

  const parseFallbackModel = (fallbackModel: string) => {
    const [provider, ...modelParts] = fallbackModel.split(',');
    const providerName = provider?.trim();
    const model = modelParts.join(',').trim();

    if (!providerName || !model) {
      return null;
    }

    return {
      provider: providerName,
      model,
      key: `${providerName},${model}`,
    };
  };

  const fallbackStages: Array<{ name: string; models: string[] }> = [];
  if (modelFamily) {
    const familyScenarioFallback = familyFallback?.[scenarioType];
    if (Array.isArray(familyScenarioFallback) && familyScenarioFallback.length > 0) {
      fallbackStages.push({
        name: `${modelFamily}/${scenarioType}`,
        models: familyScenarioFallback,
      });
    } else {
      req.log.warn(`No ${modelFamily} fallback configured for ${scenarioType}; will try global ${scenarioType} fallback`);
    }
  }

  if (Array.isArray(globalFallback?.[scenarioType]) && globalFallback[scenarioType].length > 0) {
    fallbackStages.push({
      name: `global/${scenarioType}`,
      models: globalFallback[scenarioType],
    });
  }



  if (fallbackStages.length === 0) {
    return null;
  }

  const totalFallbacks = fallbackStages.reduce((total, stage) => total + stage.models.length, 0);
  req.log.warn(`Request failed for ${scenarioType}, trying ${totalFallbacks} fallback models across ${fallbackStages.length} fallback stage(s)`);

  for (const fallbackStage of fallbackStages) {
    req.log.info(`Trying ${fallbackStage.name} fallback stage with ${fallbackStage.models.length} models`);

    // Try each fallback model in configured order, skipping open (fail pool) models
    for (const fallbackModel of fallbackStage.models) {
      const fallbackRoute = parseFallbackModel(fallbackModel);
      if (!fallbackRoute) {
        req.log.warn(`Fallback model '${fallbackModel}' is invalid, skipping`);
        continue;
      }

      if (attemptedFallbacks.has(fallbackRoute.key)) {
        continue;
      }
      attemptedFallbacks.add(fallbackRoute.key);

      const fallbackProvider = fallbackRoute.provider;
      const model = fallbackRoute.model;

      try {
        // Skip if model is in fail pool (open state)
        if (!healthStore.isAvailable(fallbackProvider, model)) {
          req.log.warn(`Fallback model ${fallbackModel} unavailable (fail pool), skipping`);
          continue;
        }

        req.log.info(`Trying fallback model: ${fallbackModel}`);

        // Update request with fallback model
        const newBody = { ...(req.body as any) };
        newBody.model = model;

        // Create new request object with updated provider and body
        const newReq = {
          ...req,
          provider: fallbackProvider,
          body: newBody,
        };

        const provider = fastify.providerService.getProvider(fallbackProvider);
        if (!provider) {
          req.log.warn(`Fallback provider '${fallbackProvider}' not found, skipping`);
          continue;
        }

        if (provider.enabled === false) {
          req.log.warn(`Fallback provider '${fallbackProvider}' is disabled, skipping`);
          continue;
        }

        // Process request transformer chain
        const { requestBody, config, bypass } = await processRequestTransformers(
          newBody,
          provider,
          transformer,
          req.headers,
          { req: newReq }
        );

        // Send request to LLM provider
        const response = await sendRequestToProvider(
          requestBody,
          config,
          provider,
          fastify,
          bypass,
          transformer,
          { req: newReq }
        );

        // Capture rate limit headers from upstream response
        try {
          if (provider?.baseUrl && response?.headers) {
            captureRateLimitHeaders(fallbackProvider, provider.baseUrl, response.headers);
          }
        } catch {}

        // Process response transformer chain
        const finalResponse = await processResponseTransformers(
          requestBody,
          response,
          provider,
          transformer,
          bypass,
          { req: newReq }
        );

        req.log.info(`Fallback model ${fallbackModel} succeeded`);

        // Record success for the fallback model
        healthStore.recordSuccess(fallbackProvider, model);

        // Promote the fallback model globally for this primary + scenario
        // This ensures all clients skip the failing primary until TTL expires
        if (originalProvider && originalModel) {
          const fallbackPromotion = getFallbackPromotionStore();
          fallbackPromotion.promote(
            originalProvider,
            originalModel,
            scenarioType,
            fallbackProvider,
            model
          );
          req.log.info(`Promoted fallback model ${fallbackProvider},${model} for ${originalProvider},${originalModel}:${scenarioType}`);

          // Immediately mark the original model as unavailable so routing skips it
          // even when promotion TTL expires or is cleared
          healthStore.forceOpen(originalProvider, originalModel, error?.message);
          req.log.info(`Marked original model ${originalProvider},${originalModel} as unavailable`);
        }

        // Write back to original req so onResponse hook records correct provider/model
        req.provider = fallbackProvider;
        req.body = newBody;

        // Format and return response
        return formatResponse(finalResponse, reply, newBody, fastify);
      } catch (fallbackError: any) {
        healthStore.recordFailure(fallbackProvider, model, fallbackError.message);
        req.log.warn(`Fallback model ${fallbackRoute.key} failed: ${fallbackError.message}`);

        // Record failed fallback attempt in usage stats
        fastify.recordUsage?.({
          provider: fallbackProvider,
          model,
          originalModel: (req.body as any).model,
          scenarioType,
          modelFamily: (req as any).modelFamily,
          errorMessage: fallbackError.message,
          sessionId: (req as any).usageSessionId || req.id,
          stream: (req.body as any).stream,
        });

        continue;
      }
    }
  }

  req.log.error(`All fallback models failed for ${scenarioType}`);
  return null;
}

/**
 * Process request transformer chain
 * Sequentially execute transformRequestOut, provider transformers, model-specific transformers
 * Returns processed request body, config, and flag indicating whether to skip transformers
 */
async function processRequestTransformers(
  body: any,
  provider: any,
  transformer: any,
  headers: any,
  context: any
) {
  // Deep clone the request body to preserve original messages for caching
  // and to ensure thinking blocks are not lost when switching between models
  let requestBody = JSON.parse(JSON.stringify(body));
  let config: any = {};
  let bypass = false;

  // Check if transformers should be bypassed (passthrough mode)
  bypass = shouldBypassTransformers(provider, transformer, body);

  if (bypass) {
    if (headers instanceof Headers) {
      headers.delete("content-length");
    } else {
      delete headers["content-length"];
    }
    config.headers = headers;
  }

  // Execute transformer's transformRequestOut method
  if (!bypass && typeof transformer.transformRequestOut === "function") {
    const transformOut = await transformer.transformRequestOut(requestBody);
    if (transformOut.body) {
      requestBody = transformOut.body;
      config = transformOut.config || {};
    } else {
      requestBody = transformOut;
    }
  }

  // Execute provider-level transformers
  if (!bypass && provider.transformer?.use?.length) {
    for (const providerTransformer of provider.transformer.use) {
      if (
        !providerTransformer ||
        typeof providerTransformer.transformRequestIn !== "function"
      ) {
        continue;
      }
      const transformIn = await providerTransformer.transformRequestIn(
        requestBody,
        provider,
        context
      );
      if (transformIn.body) {
        requestBody = transformIn.body;
        config = { ...config, ...transformIn.config };
      } else {
        requestBody = transformIn;
      }
    }
  }

  // Execute model-specific transformers
  if (!bypass && provider.transformer?.[body.model]?.use?.length) {
    for (const modelTransformer of provider.transformer[body.model].use) {
      if (
        !modelTransformer ||
        typeof modelTransformer.transformRequestIn !== "function"
      ) {
        continue;
      }
      requestBody = await modelTransformer.transformRequestIn(
        requestBody,
        provider,
        context
      );
    }
  }

  return { requestBody, config, bypass };
}

/**
 * Determine if transformers should be bypassed (passthrough mode)
 * Skip other transformers when provider only uses one transformer and it matches the current one
 */
function shouldBypassTransformers(
  provider: any,
  transformer: any,
  body: any
): boolean {
  // If the request contains system messages in the messages array, we cannot bypass
  // because Anthropic-compatible targets do not support system messages in the messages array.
  const hasSystemMessage = body?.messages?.some((msg: any) => msg.role === "system");
  if (hasSystemMessage) {
    return false;
  }

  return (
    provider.transformer?.use?.length === 1 &&
    provider.transformer.use[0].name === transformer.name &&
    (!provider.transformer?.[body.model]?.use.length ||
      (provider.transformer?.[body.model]?.use.length === 1 &&
        provider.transformer?.[body.model]?.use[0].name === transformer.name))
  );
}

/**
 * Send request to LLM provider
 * Handle authentication, build request config, send request and handle errors
 */
async function sendRequestToProvider(
  requestBody: any,
  config: any,
  provider: any,
  fastify: FastifyInstance,
  bypass: boolean,
  transformer: any,
  context: any
) {
  const url = config.url || new URL(provider.baseUrl);

  // Apply timeout from config
  if (!config.TIMEOUT) {
    const timeoutMs = fastify.configService.get<string | number>('API_TIMEOUT_MS');
    if (timeoutMs) {
      config.TIMEOUT = typeof timeoutMs === 'string' ? parseInt(timeoutMs, 10) : timeoutMs;
    }
  }

  // Handle authentication in passthrough mode
  if (bypass && typeof transformer.auth === "function") {
    const auth = await transformer.auth(requestBody, provider);
    if (auth.body) {
      requestBody = auth.body;
      let headers = config.headers || {};
      if (auth.config?.headers) {
        headers = {
          ...headers,
          ...auth.config.headers,
        };
        delete headers.host;
        delete auth.config.headers;
      }
      config = {
        ...config,
        ...auth.config,
        headers,
      };
    } else {
      requestBody = auth;
    }
  }

  // Send HTTP request
  // Prepare headers
  const requestHeaders: Record<string, string> = {
    Authorization: `Bearer ${provider.apiKey}`,
    ...(config?.headers || {}),
  };

  for (const key in requestHeaders) {
    if (requestHeaders[key] === "undefined") {
      delete requestHeaders[key];
    } else if (
      ["authorization", "Authorization"].includes(key) &&
      requestHeaders[key]?.includes("undefined")
    ) {
      delete requestHeaders[key];
    }
  }

  // Debug: log outgoing request to provider
  if (isDebugLogEnabled(fastify.configService)) {
    logProviderRequest(fastify.log, context.req.id, {
      url: String(url),
      headers: requestHeaders,
      body: requestBody,
    });
  }

  const response = await sendUnifiedRequest(
    url,
    requestBody,
    {
      httpsProxy: fastify.configService.getHttpsProxy(),
      ...config,
      headers: JSON.parse(JSON.stringify(requestHeaders)),
    },
    context,
    fastify.log
  );

  // Handle request errors
  if (!response.ok) {
    const errorText = await response.text();
    fastify.log.error(
      `[provider_response_error] Error from provider(${provider.name},${requestBody.model}: ${response.status}): ${errorText}`,
    );
    const error = createApiError(
      `Error from provider(${provider.name},${requestBody.model}: ${response.status}): ${errorText}`,
      response.status,
      "provider_response_error"
    );
    error.rawBody = errorText;
    throw error;
  }

  // Handle hidden errors in HTTP 200 OK responses (e.g. Zhipu rate limits)
  if (response.ok) {
    const contentType = response.headers.get("content-type") || "";
    if (contentType.includes("application/json")) {
      const cloned = response.clone();
      try {
        const bodyText = await cloned.text();
        const bodyJson = JSON.parse(bodyText);
        // Check if the response contains an error object
        if (bodyJson && typeof bodyJson === 'object' && bodyJson.error) {
          // If error is null or explicitly empty, it might not be a real error
          const hasRealError =
            typeof bodyJson.error === 'string' ||
            (typeof bodyJson.error === 'object' && Object.keys(bodyJson.error).length > 0);

          if (hasRealError) {
            fastify.log.error(
              `[provider_response_error] Hidden error from provider(${provider.name},${requestBody.model}: ${response.status}): ${bodyText}`,
            );
            const error = createApiError(
              `Error from provider(${provider.name},${requestBody.model}: ${response.status}): ${bodyText}`,
              // Promote to 400 to trigger fallback and correct usage logging
              400,
              "provider_response_error"
            );
            error.rawBody = bodyText;
            throw error;
          }
        }
      } catch (e) {
        // Ignore JSON parse errors or other issues, let it pass through
      }
    }
  }

  // Debug: log non-stream response from provider
  if (!requestBody.stream && isDebugLogEnabled(fastify.configService)) {
    const cloned = response.clone();
    const bodyText = await cloned.text();
    logProviderResponse(fastify.log, context.req.id, {
      status: response.status,
      headers: Object.fromEntries(response.headers.entries()),
      body: bodyText,
    });
  }

  return response;
}

/**
 * Process response transformer chain
 * Sequentially execute provider transformers, model-specific transformers, transformer's transformResponseIn
 */
async function processResponseTransformers(
  requestBody: any,
  response: any,
  provider: any,
  transformer: any,
  bypass: boolean,
  context: any
) {
  let finalResponse = response;

  // Execute provider-level response transformers
  if (!bypass && provider.transformer?.use?.length) {
    for (const providerTransformer of Array.from(
      provider.transformer.use
    ).reverse() as Transformer[]) {
      if (
        !providerTransformer ||
        typeof providerTransformer.transformResponseOut !== "function"
      ) {
        continue;
      }
      finalResponse = await providerTransformer.transformResponseOut!(
        finalResponse,
        context
      );
    }
  }

  // Execute model-specific response transformers
  if (!bypass && provider.transformer?.[requestBody.model]?.use?.length) {
    for (const modelTransformer of Array.from(
      provider.transformer[requestBody.model].use
    ).reverse() as Transformer[]) {
      if (
        !modelTransformer ||
        typeof modelTransformer.transformResponseOut !== "function"
      ) {
        continue;
      }
      finalResponse = await modelTransformer.transformResponseOut!(
        finalResponse,
        context
      );
    }
  }

  // Execute transformer's transformResponseIn method
  if (!bypass && transformer.transformResponseIn) {
    finalResponse = await transformer.transformResponseIn(
      finalResponse,
      context
    );
  }

  return finalResponse;
}

/**
 * Format and return response
 * Handle HTTP status codes, format streaming and regular responses
 */
function formatResponse(response: any, reply: FastifyReply, body: any, fastify?: FastifyInstance) {
  // Set HTTP status code
  if (!response.ok) {
    reply.code(response.status);
  }

  // Handle streaming response
  const isStream = body.stream === true;
  if (isStream) {
    reply.header("Content-Type", "text/event-stream");
    reply.header("Cache-Control", "no-cache");
    reply.header("Connection", "keep-alive");

    // Debug: tee stream to log SSE chunks
    if (fastify && isDebugLogEnabled(fastify.configService)) {
      const [debugStream, clientStream] = response.body.tee();
      const options = getDebugLogOptions(fastify.configService);
      readStreamForDebug(debugStream, fastify.log, reply.request.id, options);
      return reply.send(clientStream);
    }

    return reply.send(response.body);
  } else {
    // Handle regular JSON response
    return response.json();
  }
}

export const registerApiRoutes = async (
  fastify: FastifyInstance
) => {
  // Health and info endpoints
  fastify.get("/", async () => {
    return { message: "LLMs API", version };
  });

  fastify.get("/health", async () => {
    return { status: "ok", timestamp: new Date().toISOString() };
  });

  // Provider health status endpoint
  fastify.get("/providers/health", async () => {
    const healthStore = getHealthStore();
    const states = healthStore.getAllStates();
    return {
      states: states.map(s => ({
        provider: s.provider,
        model: s.model,
        status: s.status,
        failureCount: s.failureCount,
        successCount: s.successCount,
        lastFailureTime: s.lastFailureTime,
        lastError: s.lastError,
      })),
      timestamp: new Date().toISOString(),
    };
  });

  const transformersWithEndpoint =
    fastify.transformerService.getTransformersWithEndpoint();

  for (const { transformer } of transformersWithEndpoint) {
    if (transformer.endPoint) {
      fastify.post(
        transformer.endPoint,
        async (req: FastifyRequest, reply: FastifyReply) => {
          return handleTransformerEndpoint(req, reply, fastify, transformer);
        }
      );
    }
  }

  fastify.post(
    "/providers",
    {
      schema: {
        body: {
          type: "object",
          properties: {
            id: { type: "string" },
            name: { type: "string" },
            type: { type: "string", enum: ["openai", "anthropic"] },
            baseUrl: { type: "string" },
            apiKey: { type: "string" },
            models: { type: "array", items: { type: "string" } },
          },
          required: ["id", "name", "type", "baseUrl", "apiKey", "models"],
        },
      },
    },
    async (
      request: FastifyRequest<{ Body: RegisterProviderRequest }>,
      reply: FastifyReply
    ) => {
      // Validation
      const { name, baseUrl, apiKey, models } = request.body;

      if (!name?.trim()) {
        throw createApiError(
          "Provider name is required",
          400,
          "invalid_request"
        );
      }

      if (!baseUrl || !isValidUrl(baseUrl)) {
        throw createApiError(
          "Valid base URL is required",
          400,
          "invalid_request"
        );
      }

      if (!apiKey?.trim()) {
        throw createApiError("API key is required", 400, "invalid_request");
      }

      if (!models || !Array.isArray(models) || models.length === 0) {
        throw createApiError(
          "At least one model is required",
          400,
          "invalid_request"
        );
      }

      // Check if provider already exists
      if (fastify.providerService.getProvider(request.body.name)) {
        throw createApiError(
          `Provider with name '${request.body.name}' already exists`,
          400,
          "provider_exists"
        );
      }

      return fastify.providerService.registerProvider(request.body);
    }
  );

  fastify.get("/providers", async () => {
    return fastify.providerService.getProviders();
  });

  fastify.get(
    "/providers/:id",
    {
      schema: {
        params: {
          type: "object",
          properties: { id: { type: "string" } },
          required: ["id"],
        },
      },
    },
    async (request: FastifyRequest<{ Params: { id: string } }>) => {
      const provider = fastify.providerService.getProvider(
        request.params.id
      );
      if (!provider) {
        throw createApiError("Provider not found", 404, "provider_not_found");
      }
      return provider;
    }
  );

  fastify.put(
    "/providers/:id",
    {
      schema: {
        params: {
          type: "object",
          properties: { id: { type: "string" } },
          required: ["id"],
        },
        body: {
          type: "object",
          properties: {
            name: { type: "string" },
            type: { type: "string", enum: ["openai", "anthropic"] },
            baseUrl: { type: "string" },
            apiKey: { type: "string" },
            models: { type: "array", items: { type: "string" } },
            enabled: { type: "boolean" },
          },
        },
      },
    },
    async (
      request: FastifyRequest<{
        Params: { id: string };
        Body: Partial<LLMProvider>;
      }>,
      reply
    ) => {
      const provider = fastify.providerService.updateProvider(
        request.params.id,
        request.body
      );
      if (!provider) {
        throw createApiError("Provider not found", 404, "provider_not_found");
      }
      return provider;
    }
  );

  fastify.delete(
    "/providers/:id",
    {
      schema: {
        params: {
          type: "object",
          properties: { id: { type: "string" } },
          required: ["id"],
        },
      },
    },
    async (request: FastifyRequest<{ Params: { id: string } }>) => {
      const success = fastify.providerService.deleteProvider(
        request.params.id
      );
      if (!success) {
        throw createApiError("Provider not found", 404, "provider_not_found");
      }
      return { message: "Provider deleted successfully" };
    }
  );

  fastify.patch(
    "/providers/:id/toggle",
    {
      schema: {
        params: {
          type: "object",
          properties: { id: { type: "string" } },
          required: ["id"],
        },
        body: {
          type: "object",
          properties: { enabled: { type: "boolean" } },
          required: ["enabled"],
        },
      },
    },
    async (
      request: FastifyRequest<{
        Params: { id: string };
        Body: { enabled: boolean };
      }>,
      reply
    ) => {
      const success = fastify.providerService.toggleProvider(
        request.params.id,
        request.body.enabled
      );
      if (!success) {
        throw createApiError("Provider not found", 404, "provider_not_found");
      }
      return {
        message: `Provider ${
          request.body.enabled ? "enabled" : "disabled"
        } successfully`,
      };
    }
  );
};

// Helper function
function isValidUrl(url: string): boolean {
  try {
    new URL(url);
    return true;
  } catch {
    return false;
  }
}
