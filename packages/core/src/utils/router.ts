import { get_encoding } from "tiktoken";
import { sessionUsageCache, Usage } from "./cache";
import { readFile } from "fs/promises";
import { opendir, stat } from "fs/promises";
import { join } from "path";
import { CLAUDE_PROJECTS_DIR, HOME_DIR } from "@wengine-ai/claude-code-router-shared";
import { ConfigService } from "../services/config";
import { TokenizerService } from "../services/tokenizer";
import { getHealthStore } from "../services/provider-health";
import { getQuotaResult } from "../services/quota-store";
import { getFallbackPromotionStore } from "./fallback-promotion";
import { extractSessionIdFromUserId, normalizeSessionId } from "./session-id";

// Types from @anthropic-ai/sdk
interface Tool {
  name: string;
  description?: string;
  input_schema: object;
}

interface ContentBlockParam {
  type: string;
  [key: string]: any;
}

interface MessageParam {
  role: string;
  content: string | ContentBlockParam[];
}

interface MessageCreateParamsBase {
  messages?: MessageParam[];
  system?: string | any[];
  tools?: Tool[];
  [key: string]: any;
}

const enc = get_encoding("cl100k_base");

export const calculateTokenCount = (
  messages: MessageParam[],
  system: any,
  tools: Tool[]
) => {
  let tokenCount = 0;
  if (Array.isArray(messages)) {
    messages.forEach((message) => {
      if (typeof message.content === "string") {
        tokenCount += enc.encode(message.content).length;
      } else if (Array.isArray(message.content)) {
        message.content.forEach((contentPart: any) => {
          if (contentPart.type === "text") {
            tokenCount += enc.encode(contentPart.text).length;
          } else if (contentPart.type === "tool_use") {
            tokenCount += enc.encode(JSON.stringify(contentPart.input)).length;
          } else if (contentPart.type === "tool_result") {
            tokenCount += enc.encode(
              typeof contentPart.content === "string"
                ? contentPart.content
                : JSON.stringify(contentPart.content)
            ).length;
          }
        });
      }
    });
  }
  if (typeof system === "string") {
    tokenCount += enc.encode(system).length;
  } else if (Array.isArray(system)) {
    system.forEach((item: any) => {
      if (item.type !== "text") return;
      if (typeof item.text === "string") {
        tokenCount += enc.encode(item.text).length;
      } else if (Array.isArray(item.text)) {
        item.text.forEach((textPart: any) => {
          tokenCount += enc.encode(textPart || "").length;
        });
      }
    });
  }
  if (tools) {
    tools.forEach((tool: Tool) => {
      if (tool.description) {
        tokenCount += enc.encode(tool.name + tool.description).length;
      }
      if (tool.input_schema) {
        tokenCount += enc.encode(JSON.stringify(tool.input_schema)).length;
      }
    });
  }
  return tokenCount;
};

const getProjectSpecificRouter = async (
  req: any,
  configService: ConfigService
) => {
  // Check if there is project-specific configuration
  if (req.sessionId) {
    const project = await searchProjectBySession(req.sessionId);
    if (project) {
      const projectConfigPath = join(HOME_DIR, project, "config.json");
      const sessionConfigPath = join(
        HOME_DIR,
        project,
        `${req.sessionId}.json`
      );

      // First try to read sessionConfig file
      try {
        const sessionConfig = JSON.parse(await readFile(sessionConfigPath, "utf8"));
        if (sessionConfig && sessionConfig.Router && Object.keys(sessionConfig.Router).length > 0) {
          return sessionConfig.Router;
        }
      } catch {}
      try {
        const projectConfig = JSON.parse(await readFile(projectConfigPath, "utf8"));
        if (projectConfig && projectConfig.Router && Object.keys(projectConfig.Router).length > 0) {
          return projectConfig.Router;
        }
      } catch {}
    }
  }
  return undefined; // Return undefined to use original configuration
};

function normalizeModelName(modelName: string): string {
  let normalized = modelName || "";
  if (normalized.includes(",")) {
    normalized = normalized.split(",").pop() || normalized;
  }
  if (normalized.includes("/")) {
    normalized = normalized.split("/").pop() || normalized;
  }
  if (normalized.includes(":")) {
    normalized = normalized.split(":")[0];
  }
  return normalized.trim().toLowerCase();
}

function extractModelFamily(modelName: string): { family: string | null; extended: boolean; isCcrAlias: boolean } {
  const normalized = normalizeModelName(modelName);

  // Check for [1m] suffix for extended context
  const extended = normalized.includes("[1m]") || normalized.endsWith("[1m");
  const cleanModel = normalized.replace(/\[1m\]|\[1m$/g, "");

  // Match ccr-opus, ccr-sonnet, ccr-haiku format (injected by CCR into Claude Code settings)
  const ccrMatch = cleanModel.match(/^ccr-(opus|sonnet|haiku)$/i);
  if (ccrMatch) {
    return { family: ccrMatch[1].toLowerCase(), extended, isCcrAlias: true };
  }

  // Match standard Claude model names: claude-opus-4-20250514, claude-sonnet-4-20250514, etc.
  const claudeMatch = cleanModel.match(
    /claude-(?:\d+-\d+-|\d+-)?(sonnet|opus|haiku)(?:-|$)/i
  ) || cleanModel.match(/claude-(sonnet|opus|haiku)(?:-|$)/i);
  if (claudeMatch) {
    return { family: claudeMatch[1].toLowerCase(), extended, isCcrAlias: false };
  }
  return { family: null, extended, isCcrAlias: false };
}

function lookupModelMapping(
  modelName: string,
  mapping?: Record<string, string>
): string | null {
  if (!mapping || !modelName) return null;

  const normalized = normalizeModelName(modelName);
  if (mapping[modelName]) {
    return mapping[modelName];
  }
  if (mapping[normalized]) {
    return mapping[normalized];
  }

  const { family } = extractModelFamily(modelName);
  if (family && mapping[family]) {
    return mapping[family];
  }

  for (const [key, value] of Object.entries(mapping)) {
    const normalizedKey = normalizeModelName(key);
    if (normalizedKey && normalized.includes(normalizedKey)) {
      return value;
    }
  }

  return null;
}

function getUsageInputTokens(usage?: Usage): number {
  if (!usage) {
    return 0;
  }

  return (usage.input_tokens || 0) +
    (usage.cache_read_input_tokens || 0) +
    (usage.cache_creation_input_tokens || 0);
}

function parseConfiguredRoute(modelName: string): { providerName: string; routeModel: string } | null {
  if (!modelName?.includes(",")) {
    return null;
  }

  const [provider, ...modelParts] = modelName.split(",");
  const providerName = provider.trim();
  const routeModel = modelParts.join(",").trim();

  if (!providerName || !routeModel) {
    return null;
  }

  return { providerName, routeModel };
}

/**
 * Look up a provider and model by name in the current provider list.
 * Returns canonical (case-matched) values or null when the provider is
 * missing, disabled, or the model is not listed under it.
 */
export function findProviderModel(
  providers: any[],
  providerName: string,
  modelName: string
): { provider: any; model: string } | null {
  const provider = providers.find(
    (p: any) => p.name.toLowerCase() === providerName.toLowerCase()
  );
  if (!provider || provider.enabled === false) {
    return null;
  }

  const model = provider.models?.find(
    (m: any) => String(m).toLowerCase() === modelName.toLowerCase()
  );
  if (!model) {
    return null;
  }

  return { provider, model: String(model) };
}

function resolveConfiguredModel(
  modelName: string,
  providers: any[],
  skipHealthCheck?: boolean,
  scenarioType?: string,
  enableFallback?: boolean
): string | null {
  const route = parseConfiguredRoute(modelName);
  if (!route) {
    return modelName;
  }

  const { providerName, routeModel } = route;

  const found = findProviderModel(providers, providerName, routeModel);

  // Provider disabled or missing — skip immediately
  if (!found) {
    // Still need to check fallback promotion even when the primary is stale,
    // because a previously promoted fallback may still be valid.
    if (enableFallback === true && scenarioType && !skipHealthCheck) {
      const fallbackPromotion = getFallbackPromotionStore();
      const promoted = fallbackPromotion.getPromotion(providerName, routeModel, scenarioType, providers);
      if (promoted) {
        const promotedRoute = parseConfiguredRoute(promoted);
        if (promotedRoute) {
          const promotedFound = findProviderModel(providers, promotedRoute.providerName, promotedRoute.routeModel);
          if (promotedFound) {
            return `${promotedFound.provider.name},${promotedFound.model}`;
          }
        }
        // Promoted model no longer valid, clear it and proceed normally
        fallbackPromotion.clear(providerName, routeModel, scenarioType);
      }
    }
    return null;
  }

  // Check if there is an active fallback promotion for this primary model
  // If a fallback succeeded globally, use the promoted model instead
  if (enableFallback === true && scenarioType && !skipHealthCheck) {
    const fallbackPromotion = getFallbackPromotionStore();
    const promoted = fallbackPromotion.getPromotion(providerName, routeModel, scenarioType, providers);
    if (promoted) {
      const promotedRoute = parseConfiguredRoute(promoted);
      if (promotedRoute) {
        const promotedFound = findProviderModel(providers, promotedRoute.providerName, promotedRoute.routeModel);
        if (promotedFound) {
          return `${promotedFound.provider.name},${promotedFound.model}`;
        }
      }
      // Promoted model no longer valid, clear it and proceed normally
      fallbackPromotion.clear(providerName, routeModel, scenarioType);
    }
  }

  // Check health status - skip if model is in fail pool
  if (!skipHealthCheck) {
    const healthStore = getHealthStore();
    if (!healthStore.isAvailable(found.provider.name, found.model)) {
      return null; // Model is unavailable, return null to signal skip
    }
  }

  // Check quota status - skip if provider quota is exhausted
  const quotaResult = getQuotaResult(found.provider.name);
  if (quotaResult) {
    const is5hExhausted = quotaResult.limitDaily !== undefined &&
      quotaResult.usedDailyBalance !== undefined &&
      quotaResult.usedDailyBalance >= quotaResult.limitDaily;
    const is7dExhausted = quotaResult.totalBalance !== undefined &&
      quotaResult.usedBalance !== undefined &&
      quotaResult.usedBalance >= quotaResult.totalBalance;

    if (is5hExhausted || is7dExhausted) {
      return null; // Quota exhausted, skip this provider
    }
  }

  return `${found.provider.name},${found.model}`;
}

function resolveScenarioFallbackModel(
  scenarioType: RouterScenarioType,
  providers: any[],
  familyFallback?: Record<string, string[] | undefined>,
  globalFallback?: Record<string, string[] | undefined>,
  family?: string
): string | null {
  const healthStore = getHealthStore();

  // Iterate through fallback stages: family-specific first, then global
  const fallbackStages = [familyFallback?.[scenarioType], globalFallback?.[scenarioType]];

  for (const fallbackList of fallbackStages) {
    if (!Array.isArray(fallbackList) || fallbackList.length === 0) {
      continue;
    }

    // Queue-based fallback: iterate in configured order, return first available model
    // Models in fail pool (open state) are automatically skipped
    // This ensures consistent fallback selection without rotation
    for (const fallbackModel of fallbackList) {
      const model = resolveConfiguredModel(fallbackModel, providers);
      if (model) {
        return model;
      }
    }
  }

  return null;
}

function requestHasImages(req: any): boolean {
  return req.body.messages?.some(
    (msg: any) =>
      msg.role === "user" &&
      Array.isArray(msg.content) &&
      msg.content.some(
        (item: any) =>
          item.type === "image" ||
          item.type === "image_url" ||
          (Array.isArray(item?.content) &&
            item.content.some(
              (sub: any) => sub.type === "image" || sub.type === "image_url"
            ))
      )
  );
}

function modelSupportsImages(modelName: string): boolean {
  const normalized = normalizeModelName(modelName);
  const imageModelPatterns = [
    /claude/i,
    /gemini/i,
    /gpt-4o/i,
    /gpt-4\.1/i,
    /gpt-4-vision/i,
    /qwen.*vl/i,
    /glm-4v/i,
    /grok.*vision/i,
    /pixtral/i,
    /llava/i,
  ];

  return imageModelPatterns.some((pattern) => pattern.test(normalized));
}

interface RouterFamilyConfig {
  default: string;
  background?: string;
  think?: string;
  longContext?: string;
  longContextThreshold?: number;
  extendedContext?: string;
  enableExtendedContext?: boolean; // Whether to append [1m] in Claude Code settings
  webSearch?: string;
  image?: string;
  fallback?: Record<string, string[]>;
}

function resolveFamilyModel(
  req: any,
  tokenCount: number,
  familyConfig: RouterFamilyConfig,
  providers: any[],
  lastUsage?: Usage,
  modelExtended?: boolean,
  globalFallback?: RouterFallbackConfig,
  enableFallback?: boolean,
  globalLongContextThreshold?: number
): { model: string; scenarioType: RouterScenarioType; isFallback: boolean } | null {
  const longContextThreshold = familyConfig.longContextThreshold ?? globalLongContextThreshold ?? 60000;
  const effectiveTokenCount = Math.max(tokenCount, getUsageInputTokens(lastUsage));
  const family = req.modelFamily;

  // Check extended context (1M+) first - higher priority than long context
  // Triggered by: 1) explicit [1m] suffix in model name, 2) token count > 200k
  const extendedThreshold = 200000;
  const shouldUseExtended = modelExtended || effectiveTokenCount > extendedThreshold;
  if (shouldUseExtended && familyConfig.extendedContext) {
    const model = resolveConfiguredModel(familyConfig.extendedContext, providers, false, 'extendedContext', enableFallback);
    if (model) {
      req.log.info(`Family: using extended context model (1M+), tokens: ${effectiveTokenCount}, estimated: ${tokenCount}, explicit: ${modelExtended}`);
      return { model, scenarioType: 'extendedContext', isFallback: false };
    }

    const fallbackResult = enableFallback
      ? resolveScenarioFallbackModel('extendedContext', providers, familyConfig.fallback, globalFallback, family)
      : null;
    if (fallbackResult) {
      req.log.info(`Family: using extended context fallback model (1M+), tokens: ${effectiveTokenCount}, estimated: ${tokenCount}, explicit: ${modelExtended}`);
      return { model: fallbackResult, scenarioType: 'extendedContext', isFallback: true };
    }

    req.log.warn(`Family: extendedContext model unavailable (fail pool), skipping`);
  }

  const tokenCountThreshold = effectiveTokenCount > longContextThreshold;

  if (
    tokenCountThreshold &&
    (familyConfig.longContext || familyConfig.fallback?.longContext?.length || globalFallback?.longContext?.length)
  ) {
    const primary = familyConfig.longContext
      ? resolveConfiguredModel(familyConfig.longContext, providers, false, 'longContext', enableFallback)
      : null;
    if (primary) {
      req.log.info(`Family: using long context model, tokens: ${effectiveTokenCount}, estimated: ${tokenCount}`);
      return { model: primary, scenarioType: 'longContext', isFallback: false };
    }

    const fallbackResult = enableFallback
      ? resolveScenarioFallbackModel('longContext', providers, familyConfig.fallback, globalFallback, family)
      : null;
    if (fallbackResult) {
      req.log.info(`Family: using long context fallback model, tokens: ${effectiveTokenCount}, estimated: ${tokenCount}`);
      return { model: fallbackResult, scenarioType: 'longContext', isFallback: true };
    }

    // No healthy longContext model available - fall through to other scenarios
    req.log.warn(`Family: no healthy longContext model available, falling through to other scenarios`);
  }

  if (
    Array.isArray(req.body.tools) &&
    req.body.tools.some((tool: any) => tool.type?.startsWith("web_search")) &&
    familyConfig.webSearch
  ) {
    const model = resolveConfiguredModel(familyConfig.webSearch, providers, false, 'webSearch', enableFallback);
    if (model) {
      return { model, scenarioType: 'webSearch', isFallback: false };
    }

    const fallbackResult = enableFallback
      ? resolveScenarioFallbackModel('webSearch', providers, familyConfig.fallback, globalFallback, family)
      : null;
    if (fallbackResult) {
      req.log.info(`Family: using webSearch fallback model`);
      return { model: fallbackResult, scenarioType: 'webSearch', isFallback: true };
    }

    req.log.warn(`Family: webSearch model unavailable (fail pool), skipping`);
  }

  if (req.body.thinking?.type === "enabled" && familyConfig.think) {
    const model = resolveConfiguredModel(familyConfig.think, providers, false, 'think', enableFallback);
    if (model) {
      return { model, scenarioType: 'think', isFallback: false };
    }

    const fallbackResult = enableFallback
      ? resolveScenarioFallbackModel('think', providers, familyConfig.fallback, globalFallback, family)
      : null;
    if (fallbackResult) {
      req.log.info(`Family: using think fallback model`);
      return { model: fallbackResult, scenarioType: 'think', isFallback: true };
    }

    req.log.warn(`Family: think model unavailable (fail pool), skipping`);
  }

  if (familyConfig.default) {
    const model = resolveConfiguredModel(familyConfig.default, providers, false, 'default', enableFallback);
    if (model) {
      return { model, scenarioType: 'default', isFallback: false };
    }

    const fallbackResult = enableFallback
      ? resolveScenarioFallbackModel('default', providers, familyConfig.fallback, globalFallback, family)
      : null;
    if (fallbackResult) {
      req.log.info(`Family: using default fallback model`);
      return { model: fallbackResult, scenarioType: 'default', isFallback: true };
    }

    req.log.warn(`Family: default model unavailable (fail pool), skipping`);
  }

  return null;
}

const getUseModel = async (
  req: any,
  tokenCount: number,
  configService: ConfigService,
  lastUsage?: Usage | undefined
): Promise<{ model: string | undefined; scenarioType: RouterScenarioType }> => {
  const projectSpecificRouter = await getProjectSpecificRouter(req, configService);
  const providers = configService.get<any[]>("providers") || [];
  const Router = projectSpecificRouter || configService.get("Router");
  const enableFallback = Router?.enableFallback === true;
  const globalFallback = enableFallback
    ? (Router?.fallback as RouterFallbackConfig | undefined) || configService.get<RouterFallbackConfig>('fallback')
    : undefined;

  // Handle explicit provider,model format
  if (req.body.model.includes(",")) {
    const model = resolveConfiguredModel(req.body.model, providers, false, 'default', enableFallback);
    if (model) {
      return { model, scenarioType: 'default' };
    }
    req.log.warn(`Explicit model ${req.body.model} unavailable (fail pool), trying fallback`);
    // Try fallback for default scenario (explicit models are treated as default)
    const fallbackResult = enableFallback
      ? resolveScenarioFallbackModel('default', providers, undefined, globalFallback)
      : null;
    if (fallbackResult) {
      req.log.info(`Using fallback for explicit model: ${fallbackResult}`);
      return { model: fallbackResult, scenarioType: 'default' };
    }
    // No fallback available, continue through routing logic as last resort
    req.log.warn(`No fallback available for explicit model ${req.body.model}, continuing through routing logic`);
  }

  // Model family routing: extract opus/sonnet/haiku and use family-specific config
  const { family, extended: modelExtended, isCcrAlias } = extractModelFamily(req.body.model);
  const familyConfig = Router?.families?.[family || ''] as RouterFamilyConfig | undefined;
  if (familyConfig && Router?.enableFamilyRouting) {
    req.log.info(`Using model family routing for: ${family}${modelExtended ? ' (1M)' : ''}`);
    req.modelFamily = family;
    req.familyFallback = familyConfig.fallback;
    const familyResult = resolveFamilyModel(
      req,
      tokenCount,
      familyConfig,
      providers,
      lastUsage,
      modelExtended,
      globalFallback,
      enableFallback,
      Router?.longContextThreshold
    );
    if (familyResult) {
      // Return only model and scenarioType (isFallback is internal)
      return { model: familyResult.model, scenarioType: familyResult.scenarioType };
    }
  }

  // ccr-opus/ccr-sonnet/ccr-haiku are aliases CCR injects for family routing.
  // When family routing is disabled, treat them as plain unmapped models so
  // they fall through to scenario-based default routing, rather than being
  // intercepted by a Router.models[alias] entry written during client takeover.
  const mappedModel = isCcrAlias && !Router?.enableFamilyRouting
    ? null
    : lookupModelMapping(req.body.model, Router?.models as Record<string, string> | undefined);
  if (mappedModel) {
    const model = resolveConfiguredModel(mappedModel, providers, false, 'modelMapping', enableFallback);
    if (model) {
      req.log.info(`Using mapped model for ${req.body.model}: ${mappedModel}`);
      return { model, scenarioType: 'modelMapping' };
    }
    req.log.warn(`Mapped model ${mappedModel} unavailable (fail pool), skipping`);
  }

  const effectiveTokenCount = Math.max(tokenCount, getUsageInputTokens(lastUsage));

  // Check extended context (1M+) first
  const extendedContextThreshold = Router?.extendedContextThreshold || 200000;
  if (effectiveTokenCount > extendedContextThreshold && Router?.extendedContext) {
    req.log.info(
      `Using extended context (1M) model due to token count: ${effectiveTokenCount}, estimated: ${tokenCount}, threshold: ${extendedContextThreshold}`
    );
    const model = resolveConfiguredModel(Router.extendedContext, providers, false, 'extendedContext', enableFallback);
    if (model) {
      return { model, scenarioType: 'extendedContext' };
    }
    req.log.warn(`Extended context model ${Router.extendedContext} unavailable (fail pool), trying fallback`);
    const fallbackResult = enableFallback
      ? resolveScenarioFallbackModel('extendedContext', providers, undefined, globalFallback)
      : null;
    if (fallbackResult) {
      return { model: fallbackResult, scenarioType: 'extendedContext' };
    }
    // Fall through to other scenarios
  }

  // if tokenCount is greater than the configured threshold, use the long context model
  const longContextThreshold = Router?.longContextThreshold || 60000;
  const tokenCountThreshold = effectiveTokenCount > longContextThreshold;
  if (tokenCountThreshold && Router?.longContext) {
    req.log.info(
      `Using long context model due to token count: ${effectiveTokenCount}, estimated: ${tokenCount}, threshold: ${longContextThreshold}`
    );
    const model = resolveConfiguredModel(Router.longContext, providers, false, 'longContext', enableFallback);
    if (model) {
      return { model, scenarioType: 'longContext' };
    }
    req.log.warn(`Long context model ${Router.longContext} unavailable (fail pool), trying fallback`);
    const fallbackResult = enableFallback
      ? resolveScenarioFallbackModel('longContext', providers, undefined, globalFallback)
      : null;
    if (fallbackResult) {
      return { model: fallbackResult, scenarioType: 'longContext' };
    }
    // Fall through to other scenarios
  }
  if (
    req.body?.system?.length > 1 &&
    req.body?.system[1]?.text?.startsWith("<CCR-SUBAGENT-MODEL>")
  ) {
    const model = req.body?.system[1].text.match(
      /<CCR-SUBAGENT-MODEL>(.*?)<\/CCR-SUBAGENT-MODEL>/s
    );
    if (model) {
      req.body.system[1].text = req.body.system[1].text.replace(
        `<CCR-SUBAGENT-MODEL>${model[1]}</CCR-SUBAGENT-MODEL>`,
        ""
      );
      return { model: model[1], scenarioType: 'default' };
    }
  }
  // Use the background model for any Claude Haiku variant
  if (
    req.body.model?.includes("claude") &&
    req.body.model?.includes("haiku") &&
    Router?.background
  ) {
    req.log.info(`Using background model for ${req.body.model}`);
    const bgModel = resolveConfiguredModel(Router.background, providers, false, 'background', enableFallback);
    if (bgModel) {
      return { model: bgModel, scenarioType: 'background' };
    }
    req.log.warn(`Background model ${Router.background} unavailable (fail pool), falling through`);
    // Fall through to other routing logic
  }
  // The priority of websearch must be higher than thinking.
  if (
    Array.isArray(req.body.tools) &&
    req.body.tools.some((tool: any) => tool.type?.startsWith("web_search")) &&
    Router?.webSearch
  ) {
    const model = resolveConfiguredModel(Router.webSearch, providers, false, 'webSearch', enableFallback);
    if (model) {
      return { model, scenarioType: 'webSearch' };
    }
    req.log.warn(`WebSearch model ${Router.webSearch} unavailable (fail pool), trying fallback`);
    const fallbackResult = enableFallback
      ? resolveScenarioFallbackModel('webSearch', providers, undefined, globalFallback)
      : null;
    if (fallbackResult) {
      return { model: fallbackResult, scenarioType: 'webSearch' };
    }
    // Fall through to other scenarios
  }
  // if extended thinking is enabled, use the think model
  if (req.body.thinking?.type === "enabled" && Router?.think) {
    req.log.info(`Using think model for ${req.body.thinking}`);
    const model = resolveConfiguredModel(Router.think, providers, false, 'think', enableFallback);
    if (model) {
      return { model, scenarioType: 'think' };
    }
    req.log.warn(`Think model ${Router.think} unavailable (fail pool), trying fallback`);
    const fallbackResult = enableFallback
      ? resolveScenarioFallbackModel('think', providers, undefined, globalFallback)
      : null;
    if (fallbackResult) {
      return { model: fallbackResult, scenarioType: 'think' };
    }
    // Fall through to default
  }
  // Default routing with health check
  if (Router?.default) {
    const model = resolveConfiguredModel(Router.default, providers, false, 'default', enableFallback);
    if (model) {
      return { model, scenarioType: 'default' };
    }
    req.log.warn(`Default model ${Router.default} unavailable (fail pool), trying fallback`);
    const fallbackResult = enableFallback
      ? resolveScenarioFallbackModel('default', providers, undefined, globalFallback)
      : null;
    if (fallbackResult) {
      return { model: fallbackResult, scenarioType: 'default' };
    }
    // Last resort: no fallback (or none available) and the default model is
    // only unavailable due to the fail-pool circuit breaker. Returning
    // `undefined` here would surface a synthetic "provider not found" error
    // instead of a real upstream response. Send the request to the default
    // model anyway (skipping the health check) so Claude Code gets a genuine
    // upstream error/response and can retry on its own.
    const unhealthyDefault = resolveConfiguredModel(Router.default, providers, true, 'default', enableFallback);
    if (unhealthyDefault) {
      req.log.warn(`No fallback available; retrying default model ${Router.default} despite fail-pool state`);
      return { model: unhealthyDefault, scenarioType: 'default' };
    }
  }
  return { model: undefined, scenarioType: 'default' };
};

export interface RouterContext {
  configService: ConfigService;
  tokenizerService?: TokenizerService;
  event?: any;
}

export type RouterScenarioType = 'default' | 'background' | 'think' | 'longContext' | 'extendedContext' | 'webSearch' | 'modelMapping' | 'image';

export interface RouterFallbackConfig {
  [key: string]: string[] | undefined;
  default?: string[];
  background?: string[];
  think?: string[];
  longContext?: string[];
  extendedContext?: string[];
  webSearch?: string[];
  modelMapping?: string[];
  image?: string[];
}

export const router = async (req: any, _res: any, context: RouterContext) => {
  const { configService, event } = context;
  // Save original request model before routing (for usage stats mapping)
  req.originalModel = req.body.model;

  const sessionId = extractSessionIdFromUserId(req.body.metadata?.user_id);
  if (sessionId) {
    req.sessionId = sessionId;
  }
  const projectSpecificRouter = await getProjectSpecificRouter(req, configService);
  const routerConfig = projectSpecificRouter || configService.get("Router");
  const enableFallback = routerConfig?.enableFallback === true;
  const providers = configService.get<any[]>("providers") || [];

  // Expose the resolved (project-aware) fallback settings on req so that
  // handleFallback() in routes.ts honors the same enableFallback flag and
  // fallback chain that the routing decision above used, instead of
  // re-reading the global config and ignoring project-level overrides.
  req.enableFallback = enableFallback;
  req.fallbackConfig = (routerConfig?.fallback as RouterFallbackConfig | undefined) || configService.get<RouterFallbackConfig>('fallback');
  const lastMessageUsage = sessionUsageCache.get(req.sessionId);
  const { messages, system = [], tools }: MessageCreateParamsBase = req.body;
  const rewritePrompt = configService.get("REWRITE_SYSTEM_PROMPT");
  if (
    rewritePrompt &&
    system.length > 1 &&
    system[1]?.text?.includes("<env>")
  ) {
    const prompt = await readFile(rewritePrompt, "utf-8");
    system[1].text = `${prompt}<env>${system[1].text.split("<env>").pop()}`;
  }

  try {
    // Try to get tokenizer config for the current model
    const [providerName, modelName] = req.body.model.split(",");
    const tokenizerConfig = context.tokenizerService?.getTokenizerConfigForModel(
      providerName,
      modelName
    );

    // Use TokenizerService if available, otherwise fall back to legacy method
    let tokenCount: number;

    if (context.tokenizerService) {
      const result = await context.tokenizerService.countTokens(
        {
          messages: messages as MessageParam[],
          system,
          tools: tools as Tool[],
        },
        tokenizerConfig
      );
      tokenCount = result.tokenCount;
    } else {
      // Legacy fallback
      tokenCount = calculateTokenCount(
        messages as MessageParam[],
        system,
        tools as Tool[]
      );
    }

    req.tokenCount = tokenCount;

    let model;
    const customRouterPath = configService.get("CUSTOM_ROUTER_PATH");
    if (customRouterPath) {
      try {
        const customRouter = require(customRouterPath);
        model = await customRouter(req, configService.getAll(), {
          event,
        });
      } catch (e: any) {
        req.log.error(`failed to load custom router: ${e.message}`);
      }
    }
    if (!model) {
      const result = await getUseModel(req, tokenCount, configService, lastMessageUsage);
      model = result.model;
      req.scenarioType = result.scenarioType;
    } else {
      // Custom router doesn't provide scenario type, default to 'default'
      req.scenarioType = 'default';
    }

    if (
      routerConfig?.image &&
      model !== routerConfig.image &&
      requestHasImages(req) &&
      !modelSupportsImages(model)
    ) {
      const imageModel = resolveConfiguredModel(routerConfig.image, providers, false, 'image', enableFallback);
      if (imageModel) {
        req.log.info(`Using image model fallback for ${model}`);
        model = imageModel;
        req.scenarioType = 'image';
      } else {
        req.log.warn(`Image model ${routerConfig.image} unavailable (fail pool), keeping ${model}`);
        // Mark scenario as 'image' so that fallback.image is used when this model fails
        req.scenarioType = 'image';
      }
    }

    if (typeof model === "string" && model.trim()) {
      req.body.model = model;
    } else {
      req.log.warn(`Router could not resolve a valid model for ${req.originalModel || req.body.model}; keeping original request model`);
      req.scenarioType = req.scenarioType || 'default';
    }
  } catch (error: any) {
    req.log.error(`Error in router middleware: ${error.message}`);
    req.body.model = routerConfig?.default;
    req.scenarioType = 'default';
  }
  return;
};

// Memory cache for sessionId to project name mapping.
// Only positive results are cached because Claude Code may create the
// <sessionId>.jsonl file after the first routed request.
// Uses Map instead of lru-cache to avoid esbuild bundling issues.
const sessionProjectCache = new Map<string, string>();
const SESSION_CACHE_MAX = 1000;

// Sessions for which the one-shot retry window has already been spent on a
// cache miss. This prevents re-paying the retry delay on every request of a
// genuinely un-managed session, while still giving a brand-new session's very
// first request enough time for Claude Code to flush its transcript to disk.
const sessionRetryAttempted = new Set<string>();
const SESSION_RETRY_ATTEMPTED_MAX = 1000;

// On a cache miss, retry the project lookup a few times with a short delay so
// the first request of a new session can still resolve its project once Claude
// Code creates the session transcript (.jsonl) file (~tens of ms later).
const SESSION_LOOKUP_RETRY_COUNT = 3;
const SESSION_LOOKUP_RETRY_DELAY_MS = 50;

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

function trimCache(): void {
  if (sessionProjectCache.size <= SESSION_CACHE_MAX) return;
  const keysToDelete = [...sessionProjectCache.keys()].slice(0, sessionProjectCache.size - SESSION_CACHE_MAX);
  for (const key of keysToDelete) {
    sessionProjectCache.delete(key);
  }
}

function trimRetryAttempted(): void {
  if (sessionRetryAttempted.size <= SESSION_RETRY_ATTEMPTED_MAX) return;
  const keysToDelete = [...sessionRetryAttempted].slice(0, sessionRetryAttempted.size - SESSION_RETRY_ATTEMPTED_MAX);
  for (const key of keysToDelete) {
    sessionRetryAttempted.delete(key);
  }
}

// Scan all Claude project folders for a `${sessionId}.jsonl` transcript and
// return the owning folder name, or null if none exists yet.
const scanProjectFoldersForSession = async (
  safeSessionId: string
): Promise<string | null> => {
  const dir = await opendir(CLAUDE_PROJECTS_DIR);
  const folderNames: string[] = [];

  // Collect all folder names
  for await (const dirent of dir) {
    if (dirent.isDirectory()) {
      folderNames.push(dirent.name);
    }
  }

  // Concurrently check each project folder for sessionId.jsonl file
  const checkPromises = folderNames.map(async (folderName) => {
    const sessionFilePath = join(
      CLAUDE_PROJECTS_DIR,
      folderName,
      `${safeSessionId}.jsonl`
    );
    try {
      const fileStat = await stat(sessionFilePath);
      return fileStat.isFile() ? folderName : null;
    } catch {
      // File does not exist, continue checking next
      return null;
    }
  });

  const results = await Promise.all(checkPromises);

  // Return the first existing project directory name
  for (const result of results) {
    if (result) {
      return result;
    }
  }

  return null;
};

export const searchProjectBySession = async (
  sessionId: string
): Promise<string | null> => {
  const safeSessionId = normalizeSessionId(sessionId);
  if (!safeSessionId) {
    return null;
  }

  // Check cache first
  if (sessionProjectCache.has(safeSessionId)) {
    return sessionProjectCache.get(safeSessionId) || null;
  }

  try {
    let result = await scanProjectFoldersForSession(safeSessionId);

    // Cache miss: the very first request of a brand-new session (e.g. Claude
    // Code's title-generation meta request) can arrive before the session
    // transcript has been flushed to disk, which would otherwise make this one
    // request fall back to the global Router and bypass project-level routing.
    // Retry the lookup briefly so the file has a chance to appear. Only do this
    // once per session so un-managed sessions don't pay the delay repeatedly.
    if (!result && !sessionRetryAttempted.has(safeSessionId)) {
      sessionRetryAttempted.add(safeSessionId);
      trimRetryAttempted();
      for (let i = 0; i < SESSION_LOOKUP_RETRY_COUNT && !result; i++) {
        await sleep(SESSION_LOOKUP_RETRY_DELAY_MS);
        result = await scanProjectFoldersForSession(safeSessionId);
      }
    }

    if (result) {
      // Cache only successful matches; never cache a miss so a later request
      // can still resolve the project once the transcript exists.
      sessionProjectCache.set(safeSessionId, result);
      trimCache();
      return result;
    }

    return null; // No matching project found
  } catch (error) {
    console.error("Error searching for project by session:", error);
    return null;
  }
};
