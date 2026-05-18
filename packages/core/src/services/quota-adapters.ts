import type { LLMProvider } from "../types/llm";

export interface ProviderQuotaResult {
  totalBalance?: number;
  usedBalance?: number;
  remainingBalance?: number;
  usedDailyBalance?: number;
  /** Explicit limit for the short-window (5h) rate limit, if available */
  limitDaily?: number;
  currency?: string;
  resetTime?: string;
}

export interface QuotaAdapter {
  queryQuota(
    provider: LLMProvider,
    timeoutMs: number,
    proxyUrl?: string
  ): Promise<ProviderQuotaResult | null>;
}

abstract class BaseQuotaAdapter implements QuotaAdapter {
  abstract queryQuota(
    provider: LLMProvider,
    timeoutMs: number,
    proxyUrl?: string
  ): Promise<ProviderQuotaResult | null>;

  protected async fetchJson(
    endpoint: string,
    provider: LLMProvider,
    timeoutMs: number,
    proxyUrl?: string
  ): Promise<any | null> {
    if (!provider.apiKey) return null;

    const fetchOptions: RequestInit & { dispatcher?: unknown } = {
      method: "GET",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${provider.apiKey}`,
      },
      signal: AbortSignal.timeout(timeoutMs),
    };

    if (proxyUrl) {
      try {
        const { ProxyAgent } = await import("undici");
        fetchOptions.dispatcher = new ProxyAgent(new URL(proxyUrl).toString());
      } catch {
        // Continue without a proxy if the proxy agent cannot be initialized.
      }
    }

    try {
      const response = await fetch(endpoint, fetchOptions);
      if (!response.ok) return null;
      return await response.json();
    } catch {
      return null;
    }
  }

  protected hasQuotaData(result: ProviderQuotaResult): boolean {
    return (
      result.totalBalance !== undefined ||
      result.usedBalance !== undefined ||
      result.remainingBalance !== undefined ||
      result.usedDailyBalance !== undefined ||
      result.limitDaily !== undefined ||
      result.resetTime !== undefined
    );
  }
}

class DeepSeekQuotaAdapter extends BaseQuotaAdapter {
  async queryQuota(
    provider: LLMProvider,
    timeoutMs: number,
    proxyUrl?: string
  ): Promise<ProviderQuotaResult | null> {
    const payload = await this.fetchJson(
      "https://api.deepseek.com/user/balance",
      provider,
      timeoutMs,
      proxyUrl
    );

    const balanceInfos = Array.isArray(payload?.balance_infos)
      ? payload.balance_infos
      : [];
    const balanceInfo = balanceInfos.find(
      (info: any) => parseOptionalNumber(info?.total_balance) !== undefined
    );

    if (!balanceInfo) return null;

    const totalBalance = parseOptionalNumber(balanceInfo.total_balance);
    if (totalBalance === undefined) return null;

    return {
      totalBalance,
      currency:
        typeof balanceInfo.currency === "string" ? balanceInfo.currency : undefined,
    };
  }
}

class OpenRouterQuotaAdapter extends BaseQuotaAdapter {
  async queryQuota(
    provider: LLMProvider,
    timeoutMs: number,
    proxyUrl?: string
  ): Promise<ProviderQuotaResult | null> {
    const payload = await this.fetchJson(
      "https://openrouter.ai/api/v1/key",
      provider,
      timeoutMs,
      proxyUrl
    );

    const data = payload?.data;
    if (!data || typeof data !== "object") return null;

    const result: ProviderQuotaResult = {};
    const limit = parseOptionalNumber(data.limit);
    const limitRemaining = parseOptionalNumber(data.limit_remaining);
    const usage = parseOptionalNumber(data.usage);
    const usageDaily = parseOptionalNumber(data.usage_daily);

    if (limit !== undefined) result.totalBalance = limit;
    if (limitRemaining !== undefined) result.remainingBalance = limitRemaining;
    if (usage !== undefined) result.usedBalance = usage;
    if (usageDaily !== undefined) result.usedDailyBalance = usageDaily;

    return this.hasQuotaData(result) ? result : null;
  }
}

class SiliconFlowQuotaAdapter extends BaseQuotaAdapter {
  async queryQuota(
    provider: LLMProvider,
    timeoutMs: number,
    proxyUrl?: string
  ): Promise<ProviderQuotaResult | null> {
    const endpoint = getSiliconFlowEndpoint(provider.baseUrl);
    const payload = await this.fetchJson(endpoint, provider, timeoutMs, proxyUrl);

    const data = payload?.data;
    if (!data || typeof data !== "object") return null;

    const result: ProviderQuotaResult = {};
    const totalBalance = parseOptionalNumber(data.totalBalance);
    const remainingBalance = parseOptionalNumber(data.balance);

    if (totalBalance !== undefined) result.totalBalance = totalBalance;
    if (remainingBalance !== undefined) result.remainingBalance = remainingBalance;

    if (totalBalance !== undefined && remainingBalance !== undefined) {
      result.usedBalance = Math.max(0, totalBalance - remainingBalance);
    }

    return this.hasQuotaData(result) ? result : null;
  }
}

class ZhipuQuotaAdapter extends BaseQuotaAdapter {
  async queryQuota(
    provider: LLMProvider,
    timeoutMs: number,
    proxyUrl?: string
  ): Promise<ProviderQuotaResult | null> {
    if (!provider.quotaToken) return null;

    const fetchOptions: RequestInit & { dispatcher?: unknown } = {
      method: "GET",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${provider.quotaToken}`,
      },
      signal: AbortSignal.timeout(timeoutMs),
    };

    if (proxyUrl) {
      try {
        const { ProxyAgent } = await import("undici");
        fetchOptions.dispatcher = new ProxyAgent(new URL(proxyUrl).toString());
      } catch {
        // Continue without proxy
      }
    }

    try {
      const response = await fetch(
        "https://bigmodel.cn/api/monitor/usage/quota/limit",
        fetchOptions
      );
      if (!response.ok) return null;

      const payload = await response.json();
      const limits = Array.isArray(payload?.data?.limits)
        ? payload.data.limits
        : [];

      const result: ProviderQuotaResult = {};

      for (const limit of limits) {
        if (limit.type === "TIME_LIMIT") {
          // TIME_LIMIT is the rolling rate-limit window (typically 5-hour).
          // Map to usedDailyBalance so it lands in the 5h UI slot.
          const usage = parseOptionalNumber(limit.usage);
          const current = parseOptionalNumber(limit.currentValue);
          const remaining = parseOptionalNumber(limit.remaining);

          if (usage !== undefined) {
            result.usedDailyBalance = usage;
          }
          if (current !== undefined && remaining !== undefined) {
            result.limitDaily = current + remaining;
          } else if (usage !== undefined && remaining !== undefined) {
            result.limitDaily = usage + remaining;
          }
          if (limit.nextResetTime) {
            result.resetTime = new Date(limit.nextResetTime).toISOString();
          }
        }
      }

      return this.hasQuotaData(result) ? result : null;
    } catch {
      return null;
    }
  }
}

const deepSeekQuotaAdapter = new DeepSeekQuotaAdapter();
const openRouterQuotaAdapter = new OpenRouterQuotaAdapter();
const siliconFlowQuotaAdapter = new SiliconFlowQuotaAdapter();
const zhipuQuotaAdapter = new ZhipuQuotaAdapter();

export function getQuotaAdapter(baseUrl: string): QuotaAdapter | null {
  const hostname = getHostname(baseUrl);
  if (!hostname) return null;

  if (hostname === "deepseek.com" || hostname.endsWith(".deepseek.com")) {
    return deepSeekQuotaAdapter;
  }

  if (hostname === "openrouter.ai" || hostname.endsWith(".openrouter.ai")) {
    return openRouterQuotaAdapter;
  }

  if (
    hostname === "siliconflow.com" ||
    hostname.endsWith(".siliconflow.com") ||
    hostname === "siliconflow.cn" ||
    hostname.endsWith(".siliconflow.cn")
  ) {
    return siliconFlowQuotaAdapter;
  }

  if (
    hostname === "bigmodel.cn" ||
    hostname.endsWith(".bigmodel.cn")
  ) {
    return zhipuQuotaAdapter;
  }

  return null;
}

function getSiliconFlowEndpoint(baseUrl: string): string {
  const hostname = getHostname(baseUrl);
  const isCnEndpoint = hostname?.endsWith(".siliconflow.cn") || hostname === "siliconflow.cn";
  return isCnEndpoint
    ? "https://api.siliconflow.cn/v1/user/info"
    : "https://api.siliconflow.com/v1/user/info";
}

function getHostname(baseUrl: string): string | null {
  try {
    return new URL(baseUrl).hostname.toLowerCase();
  } catch {
    return null;
  }
}

function parseOptionalNumber(value: unknown): number | undefined {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : undefined;
  }

  if (typeof value !== "string") return undefined;

  const normalized = value.trim().replace(/,/g, "");
  if (!normalized) return undefined;

  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : undefined;
}
