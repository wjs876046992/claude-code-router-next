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
        if (sessionConfig && sessionConfig.Router) {
          return sessionConfig.Router;
        }
      } catch {}
      try {
        const projectConfig = JSON.parse(await readFile(projectConfigPath, "utf8"));
        if (projectConfig && projectConfig.Router) {
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

function extractModelFamily(modelName: string): { family: string | null; extended: boolean } {
  const normalized = normalizeModelName(modelName);

  // Check for [1m] suffix for extended context
  const extended = normalized.includes("[1m]") || normalized.endsWith("[1m");
  const cleanModel = normalized.replace(/\[1m\]|\[1m$/g, "");

  // Match ccr-opus, ccr-sonnet, ccr-haiku format (injected by CCR into Claude Code settings)
  const ccrMatch = cleanModel.match(/^ccr-(opus|sonnet|haiku)$/i);
  if (ccrMatch) {
    return { family: ccrMatch[1].toLowerCase(), extended };
  }

  // Match standard Claude model names: claude-opus-4-20250514, claude-sonnet-4-20250514, etc.
  const claudeMatch = cleanModel.match(
    /claude-(?:\d+-\d+-|\d+-)?(sonnet|opus|haiku)(?:-|$)/i
  ) || cleanModel.match(/claude-(sonnet|opus|haiku)(?:-|$)/i);
  if (claudeMatch) {
    return { family: claudeMatch[1].toLowerCase(), extended };
  }
  return { family: null, extended };
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

function resolveConfiguredModel(
  modelName: string,
  providers: any[],
  skipHealthCheck?: boolean,
  scenarioType?: string
): string | null {
  const route = parseConfiguredRoute(modelName);
  if (!route) {
    return modelName;
  }

  const { providerName, routeModel } = route;

  const finalProvider = providers.find(
    (p: any) => p.name.toLowerCase() === providerName.toLowerCase()
  );

  // Switch has the highest priority. If disabled, return null immediately.
  if (finalProvider && finalProvider.enabled === false) {
    return null;
  }

  // Check if there is an active fallback promotion for this primary model
  // If a fallback succeeded globally, use the promoted model instead
  if (scenarioType && !skipHealthCheck) {
    const fallbackPromotion = getFallbackPromotionStore();
    const promoted = fallbackPromotion.getPromotion(providerName, routeModel, scenarioType, providers);
    if (promoted) {
      // Parse the promoted model to verify it exists in providers
      const promotedRoute = parseConfiguredRoute(promoted);
      if (promotedRoute) {
        const promotedProvider = providers.find(
          (p: any) => p.name.toLowerCase() === promotedRoute.providerName.toLowerCase()
        );
        const promotedModel = promotedProvider?.models?.find(
          (m: any) => String(m).toLowerCase() === promotedRoute.routeModel.toLowerCase()
        );
        if (promotedProvider && promotedModel) {
          return `${promotedProvider.name},${promotedModel}`;
        }
      }
      // Promoted model no longer valid, clear it and proceed normally
      fallbackPromotion.clear(providerName, routeModel, scenarioType);
    }
  }

  // Check health status - skip if model is in fail pool
  if (!skipHealthCheck) {
    const healthStore = getHealthStore();
    if (!healthStore.isAvailable(providerName, routeModel)) {
      return null; // Model is unavailable, return null to signal skip
    }
  }

  // Check quota status - skip if provider quota is exhausted
  const quotaResult = getQuotaResult(providerName);
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

  const finalModel = finalProvider?.models?.find(
    (m: any) => String(m).toLowerCase() === routeModel.toLowerCase()
  );

  if (finalProvider && finalModel) {
    return `${finalProvider.name},${finalModel}`;
  }

  return modelName;
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
  globalFallback?: RouterFallbackConfig
): { model: string; scenarioType: RouterScenarioType; isFallback: boolean } | null {
  const longContextThreshold = familyConfig.longContextThreshold || 60000;
  const effectiveTokenCount = Math.max(tokenCount, getUsageInputTokens(lastUsage));
  const family = req.modelFamily;

  // Check extended context (1M+) first - higher priority than long context
  // Triggered by: 1) explicit [1m] suffix in model name, 2) token count > 200k
  const extendedThreshold = 200000;
  const shouldUseExtended = modelExtended || effectiveTokenCount > extendedThreshold;
  if (shouldUseExtended && familyConfig.extendedContext) {
    const model = resolveConfiguredModel(familyConfig.extendedContext, providers, false, 'extendedContext');
    if (model) {
      req.log.info(`Family: using extended context model (1M+), tokens: ${effectiveTokenCount}, estimated: ${tokenCount}, explicit: ${modelExtended}`);
      return { model, scenarioType: 'extendedContext', isFallback: false };
    }

    const fallbackResult = resolveScenarioFallbackModel('extendedContext', providers, familyConfig.fallback, globalFallback, family);
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
      ? resolveConfiguredModel(familyConfig.longContext, providers, false, 'longContext')
      : null;
    if (primary) {
      req.log.info(`Family: using long context model, tokens: ${effectiveTokenCount}, estimated: ${tokenCount}`);
      return { model: primary, scenarioType: 'longContext', isFallback: false };
    }

    const fallbackResult = resolveScenarioFallbackModel('longContext', providers, familyConfig.fallback, globalFallback, family);
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
    const model = resolveConfiguredModel(familyConfig.webSearch, providers, false, 'webSearch');
    if (model) {
      return { model, scenarioType: 'webSearch', isFallback: false };
    }

    const fallbackResult = resolveScenarioFallbackModel('webSearch', providers, familyConfig.fallback, globalFallback, family);
    if (fallbackResult) {
      req.log.info(`Family: using webSearch fallback model`);
      return { model: fallbackResult, scenarioType: 'webSearch', isFallback: true };
    }

    req.log.warn(`Family: webSearch model unavailable (fail pool), skipping`);
  }

  if (req.body.thinking && familyConfig.think) {
    const model = resolveConfiguredModel(familyConfig.think, providers, false, 'think');
    if (model) {
      return { model, scenarioType: 'think', isFallback: false };
    }

    const fallbackResult = resolveScenarioFallbackModel('think', providers, familyConfig.fallback, globalFallback, family);
    if (fallbackResult) {
      req.log.info(`Family: using think fallback model`);
      return { model: fallbackResult, scenarioType: 'think', isFallback: true };
    }

    req.log.warn(`Family: think model unavailable (fail pool), skipping`);
  }

  if (familyConfig.default) {
    const model = resolveConfiguredModel(familyConfig.default, providers, false, 'default');
    if (model) {
      return { model, scenarioType: 'default', isFallback: false };
    }

    const fallbackResult = resolveScenarioFallbackModel('default', providers, familyConfig.fallback, globalFallback, family);
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
  const globalFallback = configService.get<RouterFallbackConfig>('fallback');

  // Handle explicit provider,model format
  if (req.body.model.includes(",")) {
    const model = resolveConfiguredModel(req.body.model, providers, false, 'default');
    if (model) {
      return { model, scenarioType: 'default' };
    }
    req.log.warn(`Explicit model ${req.body.model} unavailable (fail pool), trying fallback`);
    // Try fallback for default scenario (explicit models are treated as default)
    const fallbackResult = resolveScenarioFallbackModel('default', providers, undefined, globalFallback);
    if (fallbackResult) {
      req.log.info(`Using fallback for explicit model: ${fallbackResult}`);
      return { model: fallbackResult, scenarioType: 'default' };
    }
    // No fallback available, continue through routing logic as last resort
    req.log.warn(`No fallback available for explicit model ${req.body.model}, continuing through routing logic`);
  }

  // Model family routing: extract opus/sonnet/haiku and use family-specific config
  const { family, extended: modelExtended } = extractModelFamily(req.body.model);
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
      globalFallback
    );
    if (familyResult) {
      // Return only model and scenarioType (isFallback is internal)
      return { model: familyResult.model, scenarioType: familyResult.scenarioType };
    }
  }

  const mappedModel = lookupModelMapping(req.body.model, Router?.models as Record<string, string> | undefined);
  if (mappedModel) {
    const model = resolveConfiguredModel(mappedModel, providers, false, 'modelMapping');
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
    const model = resolveConfiguredModel(Router.extendedContext, providers, false, 'extendedContext');
    if (model) {
      return { model, scenarioType: 'extendedContext' };
    }
    req.log.warn(`Extended context model ${Router.extendedContext} unavailable (fail pool), trying fallback`);
    const fallbackResult = resolveScenarioFallbackModel('extendedContext', providers, undefined, globalFallback);
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
    const model = resolveConfiguredModel(Router.longContext, providers, false, 'longContext');
    if (model) {
      return { model, scenarioType: 'longContext' };
    }
    req.log.warn(`Long context model ${Router.longContext} unavailable (fail pool), trying fallback`);
    const fallbackResult = resolveScenarioFallbackModel('longContext', providers, undefined, globalFallback);
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
  const globalRouter = configService.get("Router");
  if (
    req.body.model?.includes("claude") &&
    req.body.model?.includes("haiku") &&
    globalRouter?.background
  ) {
    req.log.info(`Using background model for ${req.body.model}`);
    const bgModel = resolveConfiguredModel(globalRouter.background, providers, false, 'background');
    if (bgModel) {
      return { model: bgModel, scenarioType: 'background' };
    }
    req.log.warn(`Background model ${globalRouter.background} unavailable (fail pool), falling through`);
    // Fall through to other routing logic
  }
  // The priority of websearch must be higher than thinking.
  if (
    Array.isArray(req.body.tools) &&
    req.body.tools.some((tool: any) => tool.type?.startsWith("web_search")) &&
    Router?.webSearch
  ) {
    const model = resolveConfiguredModel(Router.webSearch, providers, false, 'webSearch');
    if (model) {
      return { model, scenarioType: 'webSearch' };
    }
    req.log.warn(`WebSearch model ${Router.webSearch} unavailable (fail pool), trying fallback`);
    const fallbackResult = resolveScenarioFallbackModel('webSearch', providers, undefined, globalFallback);
    if (fallbackResult) {
      return { model: fallbackResult, scenarioType: 'webSearch' };
    }
    // Fall through to other scenarios
  }
  // if exits thinking, use the think model
  if (req.body.thinking && Router?.think) {
    req.log.info(`Using think model for ${req.body.thinking}`);
    const model = resolveConfiguredModel(Router.think, providers, false, 'think');
    if (model) {
      return { model, scenarioType: 'think' };
    }
    req.log.warn(`Think model ${Router.think} unavailable (fail pool), trying fallback`);
    const fallbackResult = resolveScenarioFallbackModel('think', providers, undefined, globalFallback);
    if (fallbackResult) {
      return { model: fallbackResult, scenarioType: 'think' };
    }
    // Fall through to default
  }
  // Default routing with health check
  if (Router?.default) {
    const model = resolveConfiguredModel(Router.default, providers, false, 'default');
    if (model) {
      return { model, scenarioType: 'default' };
    }
    req.log.warn(`Default model ${Router.default} unavailable (fail pool), trying fallback`);
    const fallbackResult = resolveScenarioFallbackModel('default', providers, undefined, globalFallback);
    if (fallbackResult) {
      return { model: fallbackResult, scenarioType: 'default' };
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

  // Parse sessionId from metadata.user_id
  if (req.body.metadata?.user_id) {
    const parts = req.body.metadata.user_id.split("_session_");
    if (parts.length > 1) {
      req.sessionId = parts[1];
    }
  }
  const projectSpecificRouter = await getProjectSpecificRouter(req, configService);
  const routerConfig = projectSpecificRouter || configService.get("Router");
  const providers = configService.get<any[]>("providers") || [];
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
      const imageModel = resolveConfiguredModel(routerConfig.image, providers, false, 'image');
      if (imageModel) {
        req.log.info(`Using image model fallback for ${model}`);
        model = imageModel;
        req.scenarioType = 'image';
      } else {
        req.log.warn(`Image model ${routerConfig.image} unavailable (fail pool), keeping ${model}`);
      }
    }

    req.body.model = model;
  } catch (error: any) {
    req.log.error(`Error in router middleware: ${error.message}`);
    req.body.model = routerConfig?.default;
    req.scenarioType = 'default';
  }
  return;
};

// Memory cache for sessionId to project name mapping
// null value indicates previously searched but not found
// Uses Map instead of lru-cache to avoid esbuild bundling issues
const sessionProjectCache = new Map<string, string | null>();
const SESSION_CACHE_MAX = 1000;

function trimCache(): void {
  if (sessionProjectCache.size <= SESSION_CACHE_MAX) return;
  const keysToDelete = [...sessionProjectCache.keys()].slice(0, sessionProjectCache.size - SESSION_CACHE_MAX);
  for (const key of keysToDelete) {
    sessionProjectCache.delete(key);
  }
}

export const searchProjectBySession = async (
  sessionId: string
): Promise<string | null> => {
  // Check cache first
  if (sessionProjectCache.has(sessionId)) {
    const result = sessionProjectCache.get(sessionId);
    if (!result || result === '') {
      return null;
    }
    return result;
  }

  try {
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
        `${sessionId}.jsonl`
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
        // Cache the found result
        sessionProjectCache.set(sessionId, result);
        trimCache();
        return result;
      }
    }

    // Cache not found result (null value means previously searched but not found)
    sessionProjectCache.set(sessionId, '');
    trimCache();
    return null; // No matching project found
  } catch (error) {
    console.error("Error searching for project by session:", error);
    // Cache null result on error to avoid repeated errors
    sessionProjectCache.set(sessionId, '');
    trimCache();
    return null;
  }
};
