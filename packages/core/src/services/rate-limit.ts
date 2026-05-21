/**
 * Rate limit info captured from upstream provider response headers
 */

export interface RateLimitInfo {
  provider: string;
  remaining: number | null;
  limit: number | null;
  reset: number | null;
  capturedAt: number;
}

const store = new Map<string, RateLimitInfo>();

const REMAINING_HEADERS = [
  'x-ratelimit-remaining-tokens',
  'x-ratelimit-remaining-requests',
  'x-ratelimit-remaining',
] as const;

const LIMIT_HEADERS = [
  'x-ratelimit-limit-tokens',
  'x-ratelimit-limit-requests',
  'x-ratelimit-limit',
] as const;

const RESET_HEADERS = [
  'x-ratelimit-reset-tokens',
  'x-ratelimit-reset-requests',
  'x-ratelimit-reset',
] as const;

/**
 * Capture rate limit headers from an upstream response.
 */
export function captureRateLimitHeaders(
  providerName: string,
  apiBaseUrl: string,
  headers: Headers | Record<string, string>
): void {
  // Keep the base URL parameter for backward-compatible callers.
  void apiBaseUrl;

  const getHeader = (name: string): string | null => {
    if (headers instanceof Headers) {
      return headers.get(name);
    }
    // Case-insensitive lookup for plain objects
    const key = Object.keys(headers).find(k => k.toLowerCase() === name);
    return key ? headers[key] : null;
  };

  const remainingRaw = getFirstHeader(getHeader, REMAINING_HEADERS);
  const limitRaw = getFirstHeader(getHeader, LIMIT_HEADERS);
  const resetRaw = getFirstHeader(getHeader, RESET_HEADERS);

  if (remainingRaw || limitRaw || resetRaw) {
    store.set(providerName, {
      provider: providerName,
      remaining: parseHeaderNumber(remainingRaw),
      limit: parseHeaderNumber(limitRaw),
      reset: parseResetHeader(resetRaw),
      capturedAt: Date.now(),
    });
  }
}

/**
 * Get cached rate limit info for a provider
 */
export function getRateLimitInfo(providerName: string): RateLimitInfo | undefined {
  return store.get(providerName);
}

/**
 * Get all cached rate limit info
 */
export function getAllRateLimitInfo(): RateLimitInfo[] {
  return Array.from(store.values());
}

function getFirstHeader(
  getHeader: (name: string) => string | null,
  names: readonly string[]
): string | null {
  for (const name of names) {
    const value = getHeader(name);
    if (value) return value;
  }
  return null;
}

function parseHeaderNumber(value: string | null): number | null {
  if (!value) return null;

  const parsed = Number(value.trim().replace(/,/g, ''));
  return Number.isFinite(parsed) ? parsed : null;
}

function parseResetHeader(value: string | null): number | null {
  if (!value) return null;

  const trimmed = value.trim();
  if (!trimmed) return null;

  const numeric = Number(trimmed);
  if (Number.isFinite(numeric)) {
    // Millisecond epoch timestamps are converted to seconds.
    if (numeric > 1_000_000_000_000) return Math.floor(numeric / 1000);
    // Second epoch timestamps are kept as-is.
    if (numeric > 1_000_000_000) return Math.floor(numeric);
    // Small numeric reset values are treated as seconds from now.
    return Math.floor(Date.now() / 1000 + numeric);
  }

  const parsedDate = Date.parse(trimmed);
  if (Number.isFinite(parsedDate)) {
    return Math.floor(parsedDate / 1000);
  }

  const durationMs = parseDurationToMs(trimmed);
  if (durationMs === null) return null;

  return Math.floor((Date.now() + durationMs) / 1000);
}

function parseDurationToMs(value: string): number | null {
  const regex = /(\d+(?:\.\d+)?)(ms|s|m|h|d)/gi;
  let totalMs = 0;
  let matched = false;

  for (const match of value.matchAll(regex)) {
    matched = true;
    const amount = Number(match[1]);
    const unit = match[2].toLowerCase();

    if (!Number.isFinite(amount)) continue;

    switch (unit) {
      case 'ms':
        totalMs += amount;
        break;
      case 's':
        totalMs += amount * 1000;
        break;
      case 'm':
        totalMs += amount * 60 * 1000;
        break;
      case 'h':
        totalMs += amount * 60 * 60 * 1000;
        break;
      case 'd':
        totalMs += amount * 24 * 60 * 60 * 1000;
        break;
    }
  }

  return matched ? totalMs : null;
}
