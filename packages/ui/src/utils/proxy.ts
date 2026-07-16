import type { Config } from "@/types";

const PROXY_CONFIG_KEYS = [
  "HTTPS_PROXY",
  "https_proxy",
  "httpsProxy",
  "PROXY_URL",
] as const;

export function getConfiguredProxyUrl(config: Config): string {
  for (const key of PROXY_CONFIG_KEYS) {
    const value = config[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }

  return "";
}

export function isGlobalProxyEnabled(value: unknown): boolean {
  if (value === undefined || value === null || value === "") return true;
  if (value === false || value === 0) return false;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "false" || normalized === "0") return false;
    if (normalized === "true" || normalized === "1") return true;
  }
  return Boolean(value);
}

// Matches $VAR / ${VAR} placeholders; values containing them cannot be
// statically validated because they are interpolated at runtime.
const ENV_VAR_PLACEHOLDER_PATTERN = /\$\{[^}]+\}|\$[A-Z_][A-Z0-9_]*/;

export type ProxyUrlValidation =
  | { ok: true }
  | { ok: false; error: string };

/**
 * Validate a proxy URL config value before the UI submits it to the server.
 *
 * Acceptance rules mirror the backend (findInvalidProxyUrls in core):
 *   1. Empty / whitespace-only value is allowed (means "no proxy").
 *   2. Values containing an env-var placeholder ($VAR / ${VAR}) are allowed —
 *      the final URL is enforced at request time by getProxyDispatcher.
 *   3. Otherwise the value must parse as a URL with protocol http: or https:.
 */
export function validateProxyUrl(rawUrl: unknown): ProxyUrlValidation {
  if (rawUrl === undefined || rawUrl === null) return { ok: true };

  const trimmed = String(rawUrl).trim();
  if (!trimmed) return { ok: true };

  if (ENV_VAR_PLACEHOLDER_PATTERN.test(trimmed)) return { ok: true };

  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return {
        ok: false,
        error: `Unsupported proxy protocol: ${parsed.protocol}. Only http:// and https:// are allowed.`,
      };
    }
    return { ok: true };
  } catch {
    return { ok: false, error: `Invalid proxy URL: ${trimmed}` };
  }
}

/**
 * Scan a config object for proxy-related keys and return a list of
 * human-readable validation errors. Returns an empty array if all valid.
 */
export function findInvalidProxyUrls(
  config: Record<string, unknown>
): Array<{ key: string; error: string }> {
  const errors: Array<{ key: string; error: string }> = [];
  for (const key of PROXY_CONFIG_KEYS) {
    const value = config[key];
    if (value === undefined || value === null) continue;
    const result = validateProxyUrl(value);
    if (!result.ok) {
      errors.push({ key, error: result.error });
    }
  }
  return errors;
}
