import { ThinkLevel } from "@/types/llm";

export const getThinkLevel = (thinking_budget: number): ThinkLevel => {
  if (!(thinking_budget > 0)) return "none";
  if (thinking_budget <= 1024) return "low";
  if (thinking_budget <= 8192) return "medium";
  if (thinking_budget <= 16384) return "high";
  return "max";
};

// Inverse of getThinkLevel for producing an Anthropic thinking budget from a
// ThinkLevel. Anthropic requires budget_tokens >= 1024, so "none" maps to 0
// and callers must not emit a thinking block for it.
export const getThinkBudget = (level: ThinkLevel): number => {
  if (level === "none") return 0;
  if (level === "low") return 1024;
  if (level === "medium") return 8192;
  if (level === "high") return 16384;
  return 32768;
};

/**
 * Effort values safe to send as an explicit Anthropic `output_config.effort`.
 *
 * "max" is deliberately absent: upstream it is model-gated (only the newest
 * Opus exposes it), while the providers that do accept it — GLM and other
 * Anthropic-compatible endpoints — already resolve a bare enabled thinking
 * block to their own max tier. Sending it would risk a 400 without buying
 * anything, so max rides on the thinking budget instead.
 */
export const ANTHROPIC_EFFORT_LEVELS: ThinkLevel[] = ["low", "medium", "high"];

/**
 * Alias table for effort values seen in the wild, normalized onto the unified
 * ladder. Mirrors what Anthropic-compatible providers publish (GLM documents
 * minimal|light|low → low, medium|high → high, xhigh|max|ultra → max).
 */
export const EFFORT_ALIASES: Record<string, ThinkLevel> = {
  none: "none",
  off: "none",
  disabled: "none",
  min: "low",
  minimal: "low",
  light: "low",
  low: "low",
  medium: "medium",
  mid: "medium",
  high: "high",
  xhigh: "max",
  max: "max",
  maximum: "max",
  ultra: "max",
  ultracode: "max",
};

/**
 * Normalize a client- or config-supplied effort value onto the unified ladder.
 * Unknown strings return undefined so callers can keep them verbatim on
 * endpoints that accept free-form values (OpenAI-style `reasoning_effort`).
 */
export const normalizeEffort = (raw: unknown): ThinkLevel | undefined => {
  if (typeof raw !== "string") return undefined;
  return EFFORT_ALIASES[raw.trim().toLowerCase()];
};
