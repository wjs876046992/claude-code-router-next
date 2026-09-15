import { UnifiedChatRequest, ThinkLevel } from "@/types/llm";
import { Transformer, TransformerOptions } from "../types/transformer";
import { getThinkLevel } from "../utils/thinking";

export type DefaultThinkingLevel = "none" | "low" | "medium" | "high";

type EndpointKind = "anthropic" | "responses" | "chat";

/**
 * Parse the configured level. Accepted forms:
 * - "none" | "low" | "medium" | "high" — the standard enum
 * - a positive integer (or its decimal string form) — custom token budget
 * - any other non-empty string — provider-specific level passed through
 *   verbatim (e.g. "minimal", "off"); only meaningful on OpenAI-style
 *   endpoints, which accept string effort values
 * Empty/unparsable input parses as undefined (no injection).
 */
export function parseThinkingLevel(
  raw: unknown
): DefaultThinkingLevel | number | string | undefined {
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : undefined;
  if (typeof raw !== "string") return undefined;
  const value = raw.trim();
  if (!value) return undefined;
  const normalized = value.toLowerCase();
  if (["none", "low", "medium", "high"].includes(normalized)) {
    return normalized as DefaultThinkingLevel;
  }
  if (/^\d+$/.test(value)) return parseInt(value, 10);
  // Provider-specific value — keep the author's casing.
  return value;
}

/**
 * Resolve the provider's upstream endpoint kind from its base URL so the
 * default thinking level can be expressed in the endpoint's native parameter.
 * Defaults to OpenAI-compatible chat completions, the most common shape.
 */
export function sniffEndpointKind(baseUrl?: string): EndpointKind {
  let pathname = "";
  try {
    pathname = new URL(String(baseUrl || "")).pathname.replace(/\/+$/, "");
  } catch {
    return "chat";
  }
  if (pathname.endsWith("/messages")) return "anthropic";
  if (pathname.endsWith("/responses")) return "responses";
  return "chat";
}

/**
 * DefaultThinkingTransformer
 *
 * Applies a provider-configured default thinking level when the client did
 * not express any thinking intent. Configured via the provider field
 * `default_thinking_level` (wired into the chain by ProviderService) or
 * directly as `["defaultthinking", { "level": "high" }]` in a transformer
 * `use` list.
 *
 * The value is one of "low" | "medium" | "high", a custom token budget
 * (number or numeric string), or a provider-specific effort string (e.g.
 * "minimal", "off") passed through verbatim. Conversion per endpoint kind:
 * - Anthropic /v1/messages: unified `reasoning` — a custom budget flows into
 *   `reasoning.max_tokens` (kept as the exact budget by convertToAnthropic,
 *   raised to Anthropic's 1024 minimum); an enum maps through the standard
 *   budget table; provider-specific strings are skipped (no string form).
 * - OpenAI /v1/responses: unified `reasoning` mapped to `reasoning.effort` —
 *   custom budgets collapse to the closest effort enum, free-form strings
 *   pass through.
 * - OpenAI-compatible /v1/chat/completions: `reasoning_effort` — same enum
 *   mapping for budgets, verbatim passthrough for free-form strings.
 *
 * Client intent always wins: any defined `request.reasoning` — including an
 * explicit disabled — skips injection entirely. "none" (or an unparsable
 * value) is a no-op, so the field can stay set in config while effectively
 * off.
 */
export class DefaultThinkingTransformer implements Transformer {
  static TransformerName = "defaultthinking";

  constructor(private readonly options?: TransformerOptions) {}

  async transformRequestIn(
    request: UnifiedChatRequest,
    provider?: any
  ): Promise<Record<string, any>> {
    const level = parseThinkingLevel(this.options?.level ?? this.options?.value);
    if (level === undefined || level === "none") return request;
    if (request.reasoning) return request;

    const kind = sniffEndpointKind(provider?.baseUrl);

    if (typeof level === "number") {
      if (level <= 0) return request;
      if (kind === "anthropic") {
        // Exact budget for Anthropic-style endpoints; convertToAnthropic
        // consumes reasoning.max_tokens verbatim (still clamped below the
        // request's max_tokens). Raise to the 1024 API minimum.
        request.reasoning = {
          enabled: true,
          max_tokens: Math.max(1024, Math.floor(level)),
        };
      } else {
        // Effort enums have no numeric form — collapse the budget to a level.
        const effort = getThinkLevel(level);
        if (kind === "chat") {
          (request as any).reasoning_effort = effort;
        } else {
          request.reasoning = { enabled: true, effort };
        }
      }
      return request;
    }

    if (level === "low" || level === "medium" || level === "high") {
      if (kind === "chat") {
        (request as any).reasoning_effort = level;
      } else {
        // anthropic and responses endpoints both consume the unified shape;
        // on Anthropic the enum maps through the standard budget table.
        request.reasoning = { enabled: true, effort: level };
      }
      return request;
    }

    // Provider-specific string (e.g. "minimal", "off"): only OpenAI-style
    // endpoints accept free-form effort values, so pass it through there.
    // Anthropic has no string parameter to receive it — skip rather than
    // guess a budget.
    if (kind === "chat") {
      (request as any).reasoning_effort = level;
    } else if (kind === "responses") {
      request.reasoning = { enabled: true, effort: level as ThinkLevel };
    }
    return request;
  }
}
