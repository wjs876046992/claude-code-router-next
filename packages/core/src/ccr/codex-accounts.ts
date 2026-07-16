/**
 * Codex account management — token refresh, usage-based auto-switch, and
 * rate-limit-triggered switching.
 *
 * Extracted from the legacy server's index.ts so the CCR runtime in core owns
 * all Codex lifecycle logic.
 */
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import {
  HOME_DIR,
  getActiveCodexAccount,
  listCodexAccounts,
  markActiveCodexAccountLimitedAndSwitch,
  refreshDueCodexAccounts,
} from "@wengine-ai/claude-code-router-shared";
import { readConfigFile, writeConfigFile } from "./config";

interface CodexUsageWindow {
  used_percent?: number;
  reset_after_seconds?: number;
  reset_at?: number | null;
}

interface CodexUsageSnapshot {
  used5h?: number;
  used7d?: number;
  resetAfter5h?: number;
  resetAfter7d?: number;
}

function getCodexUsageAutoSwitchThreshold(config: Record<string, any>): number {
  const value = config.Clients?.codex?.autoSwitchUsageThreshold;
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.min(100, Math.max(1, value));
  }
  return 95;
}

function readStoredCodexAccess(accountId: string): { accessToken?: string; chatGptAccountId?: string } {
  try {
    const authPath = join(HOME_DIR, "codex-accounts", `${accountId}.auth.json`);
    if (!existsSync(authPath)) return {};
    const auth = JSON.parse(readFileSync(authPath, "utf8"));
    return {
      accessToken: auth?.tokens?.access_token,
      chatGptAccountId: auth?.tokens?.account_id || accountId,
    };
  } catch {
    return {};
  }
}

function normalizeCodexUsageSnapshot(payload: any): CodexUsageSnapshot | null {
  const rateLimit = payload?.rate_limit;
  if (!rateLimit) return null;
  const primary = rateLimit.primary_window as CodexUsageWindow | undefined;
  const secondary = rateLimit.secondary_window as CodexUsageWindow | undefined;
  return {
    used5h: typeof primary?.used_percent === "number" ? primary.used_percent : undefined,
    used7d: typeof secondary?.used_percent === "number" ? secondary.used_percent : undefined,
    resetAfter5h: typeof primary?.reset_after_seconds === "number" ? primary.reset_after_seconds : undefined,
    resetAfter7d: typeof secondary?.reset_after_seconds === "number" ? secondary.reset_after_seconds : undefined,
  };
}

async function readCodexUsageSnapshot(accountId: string): Promise<CodexUsageSnapshot | null> {
  const { accessToken, chatGptAccountId } = readStoredCodexAccess(accountId);
  if (!accessToken) return null;

  const headers: Record<string, string> = {
    Authorization: `Bearer ${accessToken}`,
    "ChatGPT-Account-Id": chatGptAccountId || accountId,
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
      const usage = normalizeCodexUsageSnapshot(await response.json());
      if (usage) return usage;
    } catch {
      // Try the next compatible usage endpoint.
    }
  }
  return null;
}

function getExceededCodexUsageWindow(
  usage: CodexUsageSnapshot,
  threshold: number
): { window: "5h" | "7d"; used: number; retryAfterSeconds?: number } | null {
  const weeklyExceeded = typeof usage.used7d === "number" && usage.used7d >= threshold;
  const shortExceeded = typeof usage.used5h === "number" && usage.used5h >= threshold;
  if (weeklyExceeded) {
    return { window: "7d", used: usage.used7d!, retryAfterSeconds: usage.resetAfter7d };
  }
  if (shortExceeded) {
    return { window: "5h", used: usage.used5h!, retryAfterSeconds: usage.resetAfter5h };
  }
  return null;
}

async function getCurrentCodexAccountForUsage(): Promise<{ id?: string; email?: string }> {
  try {
    const currentConfig = await readConfigFile();
    const account = getActiveCodexAccount(currentConfig);
    return { id: account?.id, email: account?.email };
  } catch {
    return {};
  }
}

export async function switchCodexAccountBeforeUsageLimit(): Promise<void> {
  try {
    let currentConfig = await readConfigFile();
    const clientConfig = currentConfig.Clients?.codex || {};
    if (clientConfig.autoSwitchAccounts === false) return;

    const threshold = getCodexUsageAutoSwitchThreshold(currentConfig);
    const maxAttempts = Math.max(1, listCodexAccounts(currentConfig).accounts.length);
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      const activeAccount = getActiveCodexAccount(currentConfig);
      if (!activeAccount?.id) return;

      const usage = await readCodexUsageSnapshot(activeAccount.id);
      if (!usage) return;

      const exceeded = getExceededCodexUsageWindow(usage, threshold);
      if (!exceeded) return;

      const reason = `Codex ${exceeded.window} usage reached ${Math.round(exceeded.used)}% (auto-switch threshold ${threshold}%)`;
      const result = markActiveCodexAccountLimitedAndSwitch(
        currentConfig,
        reason,
        exceeded.retryAfterSeconds
      );
      await writeConfigFile(result.config);
      if (!result.switchedAccount) {
        console.warn(`[Codex] ${reason}; no available Codex account could be switched to`);
        return;
      }

      console.warn(`[Codex] ${reason}; switched account to ${result.switchedAccount.email || result.switchedAccount.id}`);
      currentConfig = result.config;
    }
  } catch (error) {
    console.error("Failed to auto-switch Codex account before usage limit:", error);
  }
}

export async function switchCodexAccountAfterRateLimit(reason?: string): Promise<void> {
  try {
    const currentConfig = await readConfigFile();
    const clientConfig = currentConfig.Clients?.codex || {};
    if (clientConfig.autoSwitchAccounts === false) return;
    const result = markActiveCodexAccountLimitedAndSwitch(currentConfig, reason);
    await writeConfigFile(result.config);
    if (result.switchedAccount) {
      console.warn(`[Codex] Rate limit detected; switched account to ${result.switchedAccount.email || result.switchedAccount.id}`);
    } else {
      console.warn("[Codex] Rate limit detected, but no available Codex account could be switched to");
    }
  } catch (error) {
    console.error("Failed to auto-switch Codex account after rate limit:", error);
  }
}

const CODEX_TOKEN_REFRESH_INTERVAL_MS = 30 * 60 * 1000;
let codexTokenRefreshSchedulerStarted = false;

async function runCodexTokenRefreshCycle(): Promise<void> {
  try {
    const config = await readConfigFile();
    if (config.Clients?.codex?.autoRefreshTokens === false) return;
    const results = await refreshDueCodexAccounts(config);
    for (const result of results) {
      if (result.refreshed) {
        console.log(`[Codex] Refreshed tokens for account ${result.label} (${result.id})`);
      } else {
        console.warn(`[Codex] Failed to refresh tokens for account ${result.label} (${result.id}): ${result.error}`);
      }
    }
  } catch (error) {
    console.error("[Codex] Token refresh cycle failed:", error);
  }
}

/** Periodically refresh managed Codex account tokens, active or not, so refresh_tokens never go stale. */
export function startCodexTokenRefreshScheduler(): void {
  if (codexTokenRefreshSchedulerStarted) return;
  codexTokenRefreshSchedulerStarted = true;

  const initialTimer = setTimeout(() => void runCodexTokenRefreshCycle(), 60_000);
  initialTimer.unref();
  const intervalTimer = setInterval(
    () => void runCodexTokenRefreshCycle(),
    CODEX_TOKEN_REFRESH_INTERVAL_MS
  );
  intervalTimer.unref();
}

export function isRateLimitMessage(statusCode: number, message?: string): boolean {
  return statusCode === 429 ||
    Boolean(message && /rate[\s_]limit|too many|限流|频率限制|qps_limit|token_limit|quota exhausted|usage limit|limit reached/i.test(message));
}

export async function getCurrentCodexAccountForRequest(): Promise<{ id?: string; email?: string }> {
  return getCurrentCodexAccountForUsage();
}