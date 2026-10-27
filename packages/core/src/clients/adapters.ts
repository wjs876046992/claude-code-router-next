import { randomUUID } from "node:crypto";
import { CCR_PROJECT_HEADER } from "@wengine-ai/claude-code-router-shared";
import { extractSessionIdFromUserId, normalizeSessionId } from "../utils/session-id";

/**
 * Headers a Pi session may carry to advertise its stable conversation id.
 * Pi sends `x-session-affinity` when the managed CCR model declares
 * `compat.sendSessionAffinityHeaders: true`; LiteLLM/gateways may also send a
 * vendor-less `x-session-id`. The affinity header is checked first so Pi's own
 * value wins; LiteLLM's `x-litellm-session-id` is accepted last as a generic
 * carrier so a downstream gateway that already stamped one is honored.
 */
const PI_SESSION_HEADERS = [
  "x-session-affinity",
  "x-session-id",
  "x-litellm-session-id",
] as const;

/** Session ids longer than this are rejected: they flow into file paths and
 *  usage-store/log fields, so an abusive value must not bloat them. */
const MAX_SESSION_ID_LENGTH = 256;

/**
 * Read and validate a Pi session id from the incoming request headers.
 * Returns the normalized id or undefined when no valid carrier is present.
 * Invalid values (non-string, empty, path/control chars, overly long) are
 * rejected so they never reach filesystem paths or upstream logs.
 */
function isValidPiSessionId(value: unknown): value is string {
  return typeof value === "string" && value.length <= MAX_SESSION_ID_LENGTH;
}

function extractPiSessionIdFromHeaders(req: any): string | undefined {
  if (!req?.headers || typeof req.headers !== "object") return undefined;
  for (const name of PI_SESSION_HEADERS) {
    const { value } = getHeader(req, name);
    if (!isValidPiSessionId(value)) continue;
    const normalized = normalizeSessionId(value);
    if (normalized) return normalized;
  }
  return undefined;
}

export const CLIENT_TYPES = [
  "claude-code",
  "zcode",
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
  projectId?: string;
  projectHeaderPresent?: boolean;
  supportsExplicitExtendedContext: boolean;
  longContextThreshold?: number;
  extendedContextThreshold?: number;
}

export interface ClientAdapter {
  type: ClientType;
  createContext(req: any, config: Record<string, any>): ClientContext;
}

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

function getHeader(req: any, name: string): { present: boolean; value?: string } {
  const headers = req?.headers;
  if (!headers || typeof headers !== "object") return { present: false };
  const key = Object.keys(headers).find((candidate) => candidate.toLowerCase() === name);
  if (!key) return { present: false };

  const raw = headers[key];
  if (typeof raw === "string") return { present: true, value: raw.trim() };
  if (Array.isArray(raw) && typeof raw[0] === "string") {
    return { present: true, value: raw[0].trim() };
  }
  return { present: true };
}

function removeHeader(req: any, name: string): void {
  if (!req?.headers || typeof req.headers !== "object") return;
  for (const key of Object.keys(req.headers)) {
    if (key.toLowerCase() === name) delete req.headers[key];
  }
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

const zcodeAdapter: ClientAdapter = {
  type: "zcode",
  createContext(req) {
    // ZCode is Claude Code compatible (same `metadata.user_id` session
    // signalling), so it gets the same session-scoped usage bookkeeping under
    // its own client type.
    return metadataSessionContext(req, "zcode");
  },
};

const piAdapter: ClientAdapter = {
  type: "pi",
  createContext(req) {
    // pi no longer derives extendedContextThreshold from a per-client ratio of
    // its own context window. Like every other client it inherits the absolute
    // threshold chain: familyConfig.extendedContextThreshold ->
    // Router.extendedContextThreshold -> 200000. The threshold represents the
    // default target model's usable window (which other models may not support),
    // not pi's own client window, so a uniform absolute value is correct.
    const projectHeader = getHeader(req, CCR_PROJECT_HEADER);
    // Pi exposes its stable conversation id through session-affinity headers
    // (see PI_SESSION_HEADERS). When present and valid, surface it as
    // stableSessionId so the concurrency-priority router can build a sticky
    // session:family:scenario binding and the upstream provider (e.g. LiteLLM)
    // receives a constant x-litellm-session-id across the whole conversation.
    // Usage bookkeeping stays request-scoped: a Pi session can issue parallel
    // requests (compaction + user turn, subagents), and a session-scoped usage
    // cache would let one stream overwrite another's partial usage frame.
    const stableSessionId =
      extractPiSessionIdFromHeaders(req) ||
      // Idempotency: re-applying the adapter on the same request object after
      // the raw headers were stripped must keep the same stable id (this is an
      // exported API also used outside the main pipeline).
      (typeof req?.__ccrSessionAffinity === "string" ? req.__ccrSessionAffinity : undefined) ||
      extractSessionIdFromUserId(req?.body?.metadata?.user_id);
    // Enforce the documented length cap on the FINAL id regardless of source:
    // metadata-extracted ids bypass the header path's isValidPiSessionId check,
    // and the value flows into token-speed file names, concurrency slot keys,
    // usage-store fields and the upstream x-litellm-session-id header.
    const cappedSessionId = isValidPiSessionId(stableSessionId)
      ? stableSessionId
      : undefined;
    return {
      ...requestScopeContext("pi", false),
      stableSessionId: cappedSessionId,
      projectId: projectHeader.value,
      projectHeaderPresent: projectHeader.present,
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
  zcode: zcodeAdapter,
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

/**
 * ZCode is the Electron coding agent. It drives Anthropic-compatible endpoints
 * with the same `ccr-*` model aliases and Claude Code compatible
 * `metadata.user_id` that Claude Code uses, so by those signals alone it is
 * indistinguishable and used to be reported as claude-code. Its request
 * headers carry its identity though: ZCode merges its own source headers into
 * every provider request it builds, so each call arrives with
 * `User-Agent: ZCode/<version> ai-sdk/anthropic/<version>` (ZCode's own agent
 * plus the AI SDK's suffix) and an X-ZCode-* header (X-ZCode-App-Version,
 * X-ZCode-Agent, x-zcode-trace-id, ...).
 */
function isZCodeRequest(headers: Record<string, any>, userAgent: string): boolean {
  if (/zcode/i.test(userAgent)) return true;
  return Object.keys(headers).some((key) => key.toLowerCase().startsWith("x-zcode"));
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
  // Pi management headers rank with the project header. Only the pi-specific
  // affinity carrier is strong enough to identify a client on its own: generic
  // session headers (x-session-id, x-litellm-session-id) are also sent by
  // Codex/ZCode/LiteLLM-fronted clients and must never re-classify them. For
  // requests already identified as pi below, those generic headers are still
  // consumed as data carriers by the pi adapter.
  if (getHeader(req, CCR_PROJECT_HEADER).present) return "pi";
  if (getHeader(req, "x-session-affinity").present) return "pi";
  // Header fingerprint, ahead of the Claude Code heuristics below: ZCode sends
  // a ccr-* alias plus Claude Code style metadata, which would otherwise
  // resolve to claude-code.
  if (isZCodeRequest(headers, userAgent)) return "zcode";

  const billingHeader = headers["x-anthropic-billing-header"];
  if (typeof billingHeader === "string" && billingHeader.includes("cc_version=")) {
    return "claude-code";
  }
  // Codex strong signals must precede the generic metadata.user_id heuristic:
  // a /v1/responses request can carry an OpenAI-style metadata.user_id and
  // would otherwise be misclassified as claude-code, skipping Responses
  // protocol handling and mislabeling usage/client attribution.
  if (userAgent.includes("codex") || userAgent.includes("Codex")) return "codex";
  if (pathname.endsWith("/v1/responses")) return "codex";

  if (body.metadata && typeof body.metadata === "object" && typeof body.metadata.user_id === "string") {
    return "claude-code";
  }

  if (userAgent.includes("opencode")) return "opencode";
  if (userAgent.includes("pi-coding-agent")) return "pi";
  if (userAgent.includes("QwenCode")) return "qwen-code";

  const originalModel = req?.originalModel || body.model || "";
  if (/^ccr-(fable|opus|sonnet|haiku)(\[1m\])?$/i.test(originalModel)) {
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
  // Usage bookkeeping follows the adapter's declared usageScope, not the
  // presence of a stableSessionId. Pi carries a stableSessionId for routing
  // stickiness and upstream session affinity while remaining request-scoped
  // for usage, so a per-request id keeps parallel streams' usage frames
  // isolated. Session-scoped clients (Claude Code, Qwen Code, ZCode) keep
  // using their stableSessionId for usage too, preserving existing behavior.
  const usageSessionId =
    context.usageScope === "session" && context.stableSessionId
      ? context.stableSessionId
      : requestScopeId(req);
  const scopeLabel = context.usageScope === "session" ? "session" : "request";

  req.clientType = clientType;
  req.clientContext = context;
  if (context.stableSessionId) {
    req.sessionId = context.stableSessionId;
  } else {
    delete req.sessionId;
  }
  if (context.projectHeaderPresent) {
    req.projectId = context.projectId;
  } else {
    delete req.projectId;
  }
  // The project id is router-internal metadata. Keep it on the request
  // context, but never let passthrough providers forward even an invalid or
  // empty instance of the header upstream.
  removeHeader(req, CCR_PROJECT_HEADER);
  // Session-affinity headers are consumed here: they must not be forwarded to
  // upstream providers verbatim. LiteLLM does not recognize x-session-affinity
  // (its generic scan only matches x-<vendor>-session-id), and leaking a raw
  // carrier could collide with another gateway's session semantics. The
  // canonical upstream carrier is stamped in sendRequestToProvider from the
  // validated stableSessionId (x-litellm-session-id), so strip all carriers
  // regardless of validity to avoid passthrough leakage.
  if (clientType === "pi" && context.stableSessionId) {
    req.__ccrSessionAffinity = context.stableSessionId;
  }
  for (const name of PI_SESSION_HEADERS) removeHeader(req, name);
  req.usageSessionId = usageSessionId;
  req.usageCacheKey = `${clientType}:${scopeLabel}:${usageSessionId}`;
  return context;
}

export function clearClientAdapterCaches(): void {
  // No per-client caches remain after the pi extendedContextRatio removal.
  // Kept as a no-op so server lifecycle callers (onClose) stay compatible.
}
