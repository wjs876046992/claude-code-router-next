/**
 * Codex official usage cache — fetches and caches per-account usage from
 * ChatGPT backend API for the UI's Codex accounts view.
 *
 * Extracted from the legacy server's server.ts (createServer route handlers).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { HOME_DIR, listCodexAccounts, type CodexAccountsResult } from "@wengine-ai/claude-code-router-shared";

interface CodexUsageRateLimitWindow {
  used_percent?: number;
  limit_window_seconds?: number;
  reset_after_seconds?: number;
  reset_at?: number | null;
}

interface CodexOfficialUsage {
  used5h?: number;
  used7d?: number;
  reset5h?: string;
  reset7d?: string;
  planType?: string;
  rateLimitReachedType?: string | null;
}

type CodexUsageCacheEntry = CodexOfficialUsage & {
  fetchedAt: string;
};

type CodexUsageCache = Record<string, CodexUsageCacheEntry>;

interface StoredCodexAuth {
  tokens?: {
    access_token?: string;
    account_id?: string;
  };
}

const CODEX_USAGE_CACHE_DIR = join(HOME_DIR, "data");
const CODEX_USAGE_CACHE_PATH = join(CODEX_USAGE_CACHE_DIR, "codex-usage-cache.json");
const ACTIVE_CODEX_USAGE_CACHE_REFRESH_INTERVAL_MS = 60 * 1000;
const INACTIVE_CODEX_USAGE_CACHE_REFRESH_INTERVAL_MS = 30 * 60 * 1000;
const codexUsageRefreshes = new Map<string, Promise<void>>();

function epochSecondsToIso(value: unknown): string | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return new Date(value * 1000).toISOString();
}

function readCodexUsageCache(): CodexUsageCache {
  if (!existsSync(CODEX_USAGE_CACHE_PATH)) return {};
  try {
    const parsed = JSON.parse(readFileSync(CODEX_USAGE_CACHE_PATH, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return parsed as CodexUsageCache;
  } catch {
    return {};
  }
}

function writeCodexUsageCache(cache: CodexUsageCache): void {
  mkdirSync(CODEX_USAGE_CACHE_DIR, { recursive: true });
  writeFileSync(CODEX_USAGE_CACHE_PATH, `${JSON.stringify(cache, null, 2)}\n`, "utf8");
}

function pruneCodexUsageCache(cache: CodexUsageCache, accountIds: Set<string>): CodexUsageCache {
  let changed = false;
  const next: CodexUsageCache = {};
  for (const [accountId, entry] of Object.entries(cache)) {
    if (accountIds.has(accountId)) {
      next[accountId] = entry;
    } else {
      changed = true;
    }
  }
  if (changed) writeCodexUsageCache(next);
  return changed ? next : cache;
}

function isCodexUsageCacheFresh(entry: CodexUsageCacheEntry | undefined, active: boolean): boolean {
  if (!entry?.fetchedAt) return false;
  const fetchedAt = Date.parse(entry.fetchedAt);
  const refreshInterval = active
    ? ACTIVE_CODEX_USAGE_CACHE_REFRESH_INTERVAL_MS
    : INACTIVE_CODEX_USAGE_CACHE_REFRESH_INTERVAL_MS;
  return Number.isFinite(fetchedAt) && Date.now() - fetchedAt < refreshInterval;
}

function normalizeCodexUsageResponse(payload: any): CodexOfficialUsage | null {
  const rateLimit = payload?.rate_limit;
  if (!rateLimit) return null;

  const primary = rateLimit.primary_window as CodexUsageRateLimitWindow | undefined;
  const secondary = rateLimit.secondary_window as CodexUsageRateLimitWindow | undefined;
  const usage: CodexOfficialUsage = {
    planType: typeof payload.plan_type === "string" ? payload.plan_type : undefined,
    rateLimitReachedType: typeof payload.rate_limit_reached_type?.type === "string"
      ? payload.rate_limit_reached_type.type
      : null,
  };

  if (typeof primary?.used_percent === "number") {
    usage.used5h = primary.used_percent;
    usage.reset5h = epochSecondsToIso(primary.reset_at);
  }
  if (typeof secondary?.used_percent === "number") {
    usage.used7d = secondary.used_percent;
    usage.reset7d = epochSecondsToIso(secondary.reset_at);
  }

  return usage.used5h !== undefined || usage.used7d !== undefined ? usage : null;
}

function readStoredCodexAuth(accountId: string): StoredCodexAuth | null {
  const storedAuthPath = join(HOME_DIR, "codex-accounts", `${accountId}.auth.json`);
  if (!existsSync(storedAuthPath)) return null;
  try {
    return JSON.parse(readFileSync(storedAuthPath, "utf8")) as StoredCodexAuth;
  } catch {
    return null;
  }
}

async function readCodexOfficialUsage(accountId: string): Promise<CodexOfficialUsage | null> {
  const auth = readStoredCodexAuth(accountId);
  const accessToken = auth?.tokens?.access_token;
  const chatGptAccountId = auth?.tokens?.account_id || accountId;
  if (!accessToken) return null;

  const headers: Record<string, string> = {
    Authorization: `Bearer ${accessToken}`,
    "ChatGPT-Account-Id": chatGptAccountId,
    originator: "codex_cli_rs",
    Accept: "application/json",
    "Accept-Encoding": "gzip, deflate",
    "User-Agent": "codex_cli_rs/0.0.0",
  };

  const urls = [
    "https://chatgpt.com/backend-api/wham/usage",
    "https://chatgpt.com/backend-api/codex/usage",
  ];

  for (const url of urls) {
    try {
      const response = await fetch(url, {
        headers,
        signal: AbortSignal.timeout(15000),
      });
      if (!response.ok) continue;

      const payload = await response.json();
      const usage = normalizeCodexUsageResponse(payload);
      if (usage) return usage;
    } catch {
      // Fall through to the next compatible usage endpoint.
    }
  }

  return null;
}

function applyCodexOfficialUsage(account: any, officialUsage?: CodexOfficialUsage | null): any {
  if (!officialUsage) return account;
  return {
    ...account,
    plan: officialUsage.planType || account.plan,
    limitedWindow: officialUsage.rateLimitReachedType ? account.limitedWindow || "unknown" : account.limitedWindow,
    usage: {
      used5h: officialUsage.used5h ?? 0,
      used7d: officialUsage.used7d ?? 0,
      limit5h: officialUsage.used5h !== undefined ? 100 : undefined,
      limit7d: officialUsage.used7d !== undefined ? 100 : undefined,
      reset5h: officialUsage.reset5h,
      reset7d: officialUsage.reset7d,
    },
  };
}

function refreshCodexUsageCache(accountIds: string[]): void {
  for (const accountId of accountIds) {
    if (codexUsageRefreshes.has(accountId)) continue;

    const refresh = (async () => {
      const officialUsage = await readCodexOfficialUsage(accountId);
      if (!officialUsage) return;

      const cache = readCodexUsageCache();
      cache[accountId] = {
        ...officialUsage,
        fetchedAt: new Date().toISOString(),
      };
      writeCodexUsageCache(cache);
    })().catch((error) => {
      console.error(`Failed to refresh Codex usage for ${accountId}:`, error);
    }).finally(() => {
      codexUsageRefreshes.delete(accountId);
    });

    codexUsageRefreshes.set(accountId, refresh);
  }
}

export async function computeCodexAccountUsage(config: Record<string, any>): Promise<CodexAccountsResult> {
  const accountsResult = listCodexAccounts(config);
  const accountIds = new Set(accountsResult.accounts.map((account) => account.id));
  const usageCache = pruneCodexUsageCache(readCodexUsageCache(), accountIds);
  const staleAccountIds = accountsResult.accounts
    .filter((account) => !isCodexUsageCacheFresh(usageCache[account.id], account.active))
    .map((account) => account.id);

  if (staleAccountIds.length > 0) {
    refreshCodexUsageCache(staleAccountIds);
  }

  const accounts = accountsResult.accounts.map((account) => (
    applyCodexOfficialUsage(account, usageCache[account.id])
  ));

  return {
    ...accountsResult,
    accounts,
  };
}