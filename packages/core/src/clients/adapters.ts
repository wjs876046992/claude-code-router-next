import { randomUUID } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  getContextWindow,
  type ClientConfig,
  type ClientId,
} from "@wengine-ai/claude-code-router-shared";
import { extractSessionIdFromUserId } from "../utils/session-id";

export const CLIENT_TYPES = [
  "claude-code",
  "pi",
  "qwen-code",
  "opencode",
  "codex",
  "api",
  "unknown",
] as const;

export type ClientType = (typeof CLIENT_TYPES)[number];
export type ClientUsageScope = "session" | "request";

export interface ClientContext {
  clientType: ClientType;
  usageScope: ClientUsageScope;
  stableSessionId?: string;
  supportsExplicitExtendedContext: boolean;
  contextWindow?: number;
  longContextThreshold?: number;
  extendedContextThreshold?: number;
}

export interface ClientAdapter {
  type: ClientType;
  createContext(req: any, config: Record<string, any>): ClientContext;
}

interface PiModelsCacheEntry {
  mtimeMs: number;
  size: number;
  contextWindows: Map<string, number>;
  firstContextWindow?: number;
}

const PI_DEFAULT_EXTENDED_CONTEXT_RATIO = 0.8;
const PI_ROUTING_KEYS = new Set(["extendedContextRatio"]);
const piModelsCache = new Map<string, PiModelsCacheEntry>();

function isObject(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function firstSystemHead(system: unknown): string {
  if (typeof system === "string") return system.slice(0, 1000);
  if (Array.isArray(system)) {
    const first = system.find((block: any) => block && typeof block.text === "string");
    return first ? String(first.text).slice(0, 1000) : "";
  }
  return "";
}

function getPathname(req: any): string {
  if (typeof req?.pathname === "string") return req.pathname;
  if (typeof req?.url !== "string") return "";
  try {
    return new URL(req.url, "http://127.0.0.1").pathname;
  } catch {
    return req.url;
  }
}

function normalizeRequestModel(model: unknown): string {
  if (typeof model !== "string") return "";
  const routeModel = model.includes(",") ? model.split(",").pop() || model : model;
  return routeModel.trim().replace(/\[1m\]$/i, "").toLowerCase();
}

function positiveInteger(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return Math.floor(value);
  }
  if (typeof value === "string" && /^\d+$/.test(value.trim())) {
    const parsed = Number.parseInt(value.trim(), 10);
    return parsed > 0 ? parsed : undefined;
  }
  return undefined;
}

function expandHome(filePath: string): string {
  if (filePath === "~") return homedir();
  if (filePath.startsWith("~/")) return join(homedir(), filePath.slice(2));
  return filePath;
}

function getRawClientConfig(config: Record<string, any>, key: ClientId): ClientConfig {
  const clients = isObject(config?.Clients) ? config.Clients : {};
  return isObject(clients[key]) ? clients[key] : {};
}

function readPiModelsCache(modelsPath: string): PiModelsCacheEntry | undefined {
  let fileStat: ReturnType<typeof statSync>;
  try {
    fileStat = statSync(modelsPath);
  } catch {
    piModelsCache.delete(modelsPath);
    return undefined;
  }

  const cached = piModelsCache.get(modelsPath);
  if (cached && cached.mtimeMs === fileStat.mtimeMs && cached.size === fileStat.size) {
    return cached;
  }

  try {
    const parsed = JSON.parse(readFileSync(modelsPath, "utf8"));
    const provider = isObject(parsed?.providers) && isObject(parsed.providers.ccr)
      ? parsed.providers.ccr
      : undefined;
    const models = Array.isArray(provider?.models) ? provider.models : [];
    const contextWindows = new Map<string, number>();
    let firstContextWindow: number | undefined;

    for (const model of models) {
      if (!isObject(model)) continue;
      const contextWindow = positiveInteger(model.contextWindow);
      if (!contextWindow) continue;
      if (!firstContextWindow) firstContextWindow = contextWindow;
      if (typeof model.id === "string" && model.id.trim()) {
        contextWindows.set(normalizeRequestModel(model.id), contextWindow);
      }
    }

    const entry: PiModelsCacheEntry = {
      mtimeMs: fileStat.mtimeMs,
      size: fileStat.size,
      contextWindows,
      firstContextWindow,
    };
    piModelsCache.set(modelsPath, entry);
    return entry;
  } catch {
    piModelsCache.delete(modelsPath);
    return undefined;
  }
}

function getPiContextWindow(req: any, config: Record<string, any>): number {
  const piConfig = getRawClientConfig(config, "pi");
  const configDir = expandHome(piConfig.configPath || "~/.pi/agent");
  const cache = readPiModelsCache(join(configDir, "models.json"));
  const requestModel = normalizeRequestModel(req?.originalModel || req?.body?.model);
  const configuredAlias = normalizeRequestModel(piConfig.modelAlias || "ccr-opus");

  return (
    (requestModel ? cache?.contextWindows.get(requestModel) : undefined) ||
    (configuredAlias ? cache?.contextWindows.get(configuredAlias) : undefined) ||
    cache?.firstContextWindow ||
    getContextWindow(config)
  );
}

function parsePiRouting(config: Record<string, any>): {
  extendedContextRatio: number;
} {
  const routing = getRawClientConfig(config, "pi").routing;
  if (routing === undefined) {
    return {
      extendedContextRatio: PI_DEFAULT_EXTENDED_CONTEXT_RATIO,
    };
  }
  if (!isObject(routing)) {
    throw new Error("Clients.pi.routing must be an object");
  }

  for (const key of Object.keys(routing)) {
    if (!PI_ROUTING_KEYS.has(key)) {
      throw new Error(`Clients.pi.routing contains unsupported field: ${key}`);
    }
  }

  const validateRatio = (key: "extendedContextRatio", fallback: number) => {
    const value = routing[key];
    if (value === undefined) return fallback;
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || value > 1) {
      throw new Error(`Clients.pi.routing.${key} must be a finite number greater than 0 and at most 1`);
    }
    return value;
  };

  const extendedContextRatio = validateRatio("extendedContextRatio", PI_DEFAULT_EXTENDED_CONTEXT_RATIO);

  return { extendedContextRatio };
}

function requestScopeContext(
  clientType: ClientType,
  supportsExplicitExtendedContext = true
): ClientContext {
  return {
    clientType,
    usageScope: "request",
    supportsExplicitExtendedContext,
  };
}

function metadataSessionContext(
  req: any,
  clientType: ClientType,
  supportsExplicitExtendedContext = true
): ClientContext {
  const stableSessionId = extractSessionIdFromUserId(req?.body?.metadata?.user_id);
  return {
    clientType,
    usageScope: stableSessionId ? "session" : "request",
    stableSessionId,
    supportsExplicitExtendedContext,
  };
}

const claudeCodeAdapter: ClientAdapter = {
  type: "claude-code",
  createContext(req) {
    return metadataSessionContext(req, "claude-code");
  },
};

const piAdapter: ClientAdapter = {
  type: "pi",
  createContext(req, config) {
    const contextWindow = getPiContextWindow(req, config);
    const routing = parsePiRouting(config);
    // pi's longContextThreshold is NOT set here — it must inherit the absolute
    // threshold chain: familyConfig.longContextThreshold -> Router.longContextThreshold -> 60000.
    // Only the extendedContextThreshold is derived from contextWindow * extendedContextRatio.
    return {
      ...requestScopeContext("pi", false),
      contextWindow,
      extendedContextThreshold: Math.max(1, Math.floor(contextWindow * routing.extendedContextRatio)),
    };
  },
};

const qwenCodeAdapter: ClientAdapter = {
  type: "qwen-code",
  createContext(req) {
    return metadataSessionContext(req, "qwen-code");
  },
};

const opencodeAdapter: ClientAdapter = {
  type: "opencode",
  createContext() {
    return requestScopeContext("opencode");
  },
};

const codexAdapter: ClientAdapter = {
  type: "codex",
  createContext() {
    return requestScopeContext("codex");
  },
};

const apiAdapter: ClientAdapter = {
  type: "api",
  createContext() {
    return requestScopeContext("api");
  },
};

const unknownAdapter: ClientAdapter = {
  type: "unknown",
  createContext() {
    return requestScopeContext("unknown");
  },
};

export const builtinClientAdapterRegistry: Readonly<Record<ClientType, ClientAdapter>> = {
  "claude-code": claudeCodeAdapter,
  pi: piAdapter,
  "qwen-code": qwenCodeAdapter,
  opencode: opencodeAdapter,
  codex: codexAdapter,
  api: apiAdapter,
  unknown: unknownAdapter,
};

export function isClientType(value: unknown): value is ClientType {
  return typeof value === "string" && (CLIENT_TYPES as readonly string[]).includes(value);
}

export function detectClientType(req: any): ClientType {
  if (isClientType(req?.clientType)) return req.clientType;

  const pathname = getPathname(req);
  const headers = req?.headers || {};
  const userAgent = typeof headers["user-agent"] === "string" ? headers["user-agent"] : "";
  const body = req?.body || {};

  // Keep this order aligned with the legacy server detector. System identities
  // must win because pi and qwen-code can share or impersonate Claude Code signals.
  const sysHead = firstSystemHead(body.system);
  if (/\bYou are Qwen Code\b/i.test(sysHead) || /Qwen Code, an interactive CLI agent/i.test(sysHead)) {
    return "qwen-code";
  }
  if (/operating inside pi\b/i.test(sysHead) || /a coding agent harness/i.test(sysHead)) {
    return "pi";
  }
  if (/\bYou are opencode\b/i.test(sysHead)) {
    return "opencode";
  }

  const billingHeader = headers["x-anthropic-billing-header"];
  if (typeof billingHeader === "string" && billingHeader.includes("cc_version=")) {
    return "claude-code";
  }
  if (body.metadata && typeof body.metadata === "object" && typeof body.metadata.user_id === "string") {
    return "claude-code";
  }

  if (userAgent.includes("codex") || userAgent.includes("Codex")) return "codex";
  if (pathname.endsWith("/v1/responses")) return "codex";

  if (userAgent.includes("opencode")) return "opencode";
  if (userAgent.includes("pi-coding-agent")) return "pi";
  if (userAgent.includes("QwenCode")) return "qwen-code";

  const originalModel = req?.originalModel || body.model || "";
  if (/^ccr-(opus|sonnet|haiku)(\[1m\])?$/i.test(originalModel)) {
    if (userAgent.includes("Anthropic/")) return "pi";
    if (userAgent.includes("claude-cli") || userAgent.includes("Claude-CLI")) return "qwen-code";
    if (typeof headers["x-stainless-package-version"] === "string") return "pi";
    return "claude-code";
  }

  if (userAgent.includes("claude-cli") || userAgent.includes("Claude-CLI")) return "claude-code";
  if (String(originalModel).toLowerCase() === "ccr-codex") return "codex";
  if (pathname.endsWith("/v1/messages")) return "api";
  return "unknown";
}

export function getClientAdapter(clientType: ClientType): ClientAdapter {
  return builtinClientAdapterRegistry[clientType];
}

function requestScopeId(req: any): string {
  if (typeof req?.__ccrRequestScopeId === "string" && req.__ccrRequestScopeId) {
    return req.__ccrRequestScopeId;
  }

  const id =
    (typeof req?.id === "string" && req.id) ||
    randomUUID();
  req.__ccrRequestScopeId = id;
  return id;
}

export function applyClientAdapter(
  req: any,
  config: Record<string, any> = {}
): ClientContext {
  const clientType = detectClientType(req);
  const context = getClientAdapter(clientType).createContext(req, config);
  const usageSessionId = context.stableSessionId || requestScopeId(req);
  const scopeLabel = context.usageScope === "session" ? "session" : "request";

  req.clientType = clientType;
  req.clientContext = context;
  if (context.stableSessionId) {
    req.sessionId = context.stableSessionId;
  } else {
    delete req.sessionId;
  }
  req.usageSessionId = usageSessionId;
  req.usageCacheKey = `${clientType}:${scopeLabel}:${usageSessionId}`;
  return context;
}

export function clearClientAdapterCaches(): void {
  piModelsCache.clear();
}
