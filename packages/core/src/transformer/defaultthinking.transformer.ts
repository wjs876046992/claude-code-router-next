import { UnifiedChatRequest, ThinkLevel } from "@/types/llm";
import { Transformer, TransformerOptions } from "../types/transformer";
import { getThinkLevel } from "../utils/thinking";

export type DefaultThinkingLevel = "none" | "low" | "medium" | "high";

type EndpointKind = "anthropic" | "responses" | "chat";

/**
 * Parse the configured level. Besides the enum, a positive integer (or its
 * decimal string form) is accepted as a custom thinking budget in tokens;
 * anything else parses as undefined (no injection).
 */
export function parseThinkingLevel(
  raw: unknown
): DefaultThinkingLevel | number | undefined {
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : undefined;
  if (typeof raw !== "string") return undefined;
  const value = raw.trim().toLowerCase();
  if (["none", "low", "medium", "high"].includes(value)) {
    return value as DefaultThinkingLevel;
  }
  if (/^\d+$/.test(value)) return parseInt(value, 10);
  return undefined;
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
 * The value is one of "low" | "medium" | "high", or a custom token budget
 * (number or numeric string). Conversion per endpoint kind:
 * - Anthropic /v1/messages: unified `reasoning` — a custom budget flows into
 *   `reasoning.max_tokens` (kept as the exact budget by convertToAnthropic,
 *   raised to Anthropic's 1024 minimum); a level maps through the standard
 *   budget table.
 * - OpenAI /v1/responses: unified `reasoning` mapped to `reasoning.effort` —
 *   a custom budget collapses to the closest effort enum.
 * - OpenAI-compatible /v1/chat/completions: `reasoning_effort` — same enum
 *   mapping for custom budgets.
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

    if (kind === "chat") {
      (request as any).reasoning_effort = level as ThinkLevel;
    } else {
      // anthropic and responses endpoints both consume the unified shape
      request.reasoning = { enabled: true, effort: level };
    }
    return request;
  }
}
