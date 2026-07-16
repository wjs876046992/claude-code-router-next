import type { LLMProvider } from "../types/llm";
import { getProxyDispatcher } from "./proxy";

export interface ProviderQuotaResult {
  totalBalance?: number;
  usedBalance?: number;
  remainingBalance?: number;
  usedDailyBalance?: number;
  /** Explicit limit for the short-window (5h) rate limit, if available */
  limitDaily?: number;
  currency?: string;
  resetTime?: string;
  resetTime7d?: string;
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
    proxyUrl?: string,
    authToken?: string
  ): Promise<any | null> {
    const token = authToken || provider.apiKey;
    if (!token) return null;

    const fetchOptions: RequestInit & { dispatcher?: unknown } = {
      method: "GET",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${token}`,
      },
      signal: AbortSignal.timeout(timeoutMs),
    };

    try {
      if (proxyUrl) {
        fetchOptions.dispatcher = getProxyDispatcher(proxyUrl);
      }
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
    if (!provider.apiKey) return null;

    // Zhipu API Key authentication: send raw without 'Bearer ' prefix
    const authHeader = provider.apiKey.trim();

    const fetchOptions: RequestInit & { dispatcher?: unknown } = {
      method: "GET",
      headers: {
        Accept: "application/json",
        Authorization: authHeader,
      },
      signal: AbortSignal.timeout(timeoutMs),
    };

    try {
      if (proxyUrl) {
        fetchOptions.dispatcher = getProxyDispatcher(proxyUrl);
      }
      const response = await fetch(
        "https://api.z.ai/api/monitor/usage/quota/limit",
        fetchOptions
      );
      if (!response.ok) return null;

      const payload = await response.json();
      const limits = Array.isArray(payload?.data?.limits)
        ? payload.data.limits
        : [];

      let limit5h: any = null;
      let limitWeekly: any = null;
      let limitMcp: any = null;

      for (const limit of limits) {
        if (limit.type === "TOKENS_LIMIT") {
          if (limit.unit === 3) {
            limit5h = limit;
          } else if (limit.unit === 6) {
            limitWeekly = limit;
          } else {
            // Fallback: if only one TOKENS_LIMIT is present and unit is not specified/matched, use it as 5h limit
            if (!limit5h) {
              limit5h = limit;
            }
          }
        } else if (limit.type === "TIME_LIMIT") {
          limitMcp = limit;
        }
      }

      const result: ProviderQuotaResult = {};

      if (limit5h) {
        const current = parseOptionalNumber(limit5h.currentValue);
        const usage = parseOptionalNumber(limit5h.usage);
        const remaining = parseOptionalNumber(limit5h.remaining);
        const percentage = parseOptionalNumber(limit5h.percentage);

        if (current !== undefined) {
          result.usedDailyBalance = current;
        } else if (percentage !== undefined) {
          result.usedDailyBalance = percentage;
          result.limitDaily = 100;
        }
        if (usage !== undefined) {
          result.limitDaily = usage;
        } else if (current !== undefined && remaining !== undefined) {
          result.limitDaily = current + remaining;
        }
        if (limit5h.nextResetTime) {
          result.resetTime = new Date(limit5h.nextResetTime).toISOString();
        }
      }

      if (limitWeekly) {
        const current = parseOptionalNumber(limitWeekly.currentValue);
        const usage = parseOptionalNumber(limitWeekly.usage);
        const remaining = parseOptionalNumber(limitWeekly.remaining);
        const percentage = parseOptionalNumber(limitWeekly.percentage);

        if (current !== undefined) {
          result.usedBalance = current;
        } else if (percentage !== undefined) {
          result.usedBalance = percentage;
          result.totalBalance = 100;
        }
        if (usage !== undefined) {
          result.totalBalance = usage;
        } else if (current !== undefined && remaining !== undefined) {
          result.totalBalance = current + remaining;
        }
        // If 5h resetTime is not set, set it from weekly nextResetTime
        if (limitWeekly.nextResetTime && !result.resetTime) {
          result.resetTime = new Date(limitWeekly.nextResetTime).toISOString();
        }
      }

      if (limitMcp) {
        // Fallback to TIME_LIMIT for daily limits if 5h token quota was not provided
        if (result.usedDailyBalance === undefined) {
          const current = parseOptionalNumber(limitMcp.currentValue);
          if (current !== undefined) {
            result.usedDailyBalance = current;
          }
        }
        if (result.limitDaily === undefined) {
          const usage = parseOptionalNumber(limitMcp.usage);
          const current = parseOptionalNumber(limitMcp.currentValue);
          const remaining = parseOptionalNumber(limitMcp.remaining);
          if (usage !== undefined) {
            result.limitDaily = usage;
          } else if (current !== undefined && remaining !== undefined) {
            result.limitDaily = current + remaining;
          }
        }
        if (limitMcp.nextResetTime && !result.resetTime) {
          result.resetTime = new Date(limitMcp.nextResetTime).toISOString();
        }
      }

      return this.hasQuotaData(result) ? result : null;
    } catch {
      return null;
    }
  }
}

class AliyunCodingPlanQuotaAdapter extends BaseQuotaAdapter {
  async queryQuota(
    provider: LLMProvider,
    timeoutMs: number,
    proxyUrl?: string
  ): Promise<ProviderQuotaResult | null> {
    // quotaToken should contain the Alibaba Cloud console cookie string
    if (!provider.quotaToken) return null;

    const fetchOptions: RequestInit & { dispatcher?: unknown } = {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)",
        "Origin": "https://bailian.console.aliyun.com",
        "Referer": "https://bailian.console.aliyun.com/cn-beijing",
        Cookie: provider.quotaToken,
      },
      signal: AbortSignal.timeout(timeoutMs),
    };

    const params = JSON.stringify({
      Api: "zeldaEasy.broadscope-bailian.codingPlan.queryCodingPlanInstanceInfoV2",
      V: "1.0",
      Data: {
        queryCodingPlanInstanceInfoRequest: {
          commodityCode: "sfm_codingplan_public_cn",
          onlyLatestOne: true,
        },
        cornerstoneParam: {
          feTraceId: `ccr-${Date.now()}`,
          feURL: "https://bailian.console.aliyun.com/cn-beijing",
          protocol: "V2",
          console: "ONE_CONSOLE",
          productCode: "p_efm",
          switchAgent: 10736808,
          switchUserType: 3,
          domain: "bailian.console.aliyun.com",
          consoleSite: "BAILIAN_ALIYUN",
          userNickName: "",
          userPrincipalName: "",
          xsp_lang: "zh-CN",
        },
      },
    });

    const body = new URLSearchParams({
      params,
      region: "cn-beijing",
    }).toString();

    try {
      if (proxyUrl) {
        fetchOptions.dispatcher = getProxyDispatcher(proxyUrl);
      }
      const response = await fetch(
        "https://bailian-cs.console.aliyun.com/data/api.json?action=BroadScopeAspnGateway&product=sfm_bailian&api=zeldaEasy.broadscope-bailian.codingPlan.queryCodingPlanInstanceInfoV2",
        {
          ...fetchOptions,
          body,
        }
      );
      if (!response.ok) return null;

      const payload = await response.json();
      const codingPlanInfos =
        payload?.data?.DataV2?.data?.data?.codingPlanInstanceInfos;
      if (!Array.isArray(codingPlanInfos) || codingPlanInfos.length === 0)
        return null;

      const quotaInfo = codingPlanInfos[0]?.codingPlanQuotaInfo;
      if (!quotaInfo) return null;

      const result: ProviderQuotaResult = {};

      // 5-hour window quota
      const used5h = parseOptionalNumber(quotaInfo.per5HourUsedQuota);
      const total5h = parseOptionalNumber(quotaInfo.per5HourTotalQuota);
      if (used5h !== undefined) result.usedDailyBalance = used5h;
      if (total5h !== undefined) result.limitDaily = total5h;

      // 7-day/week quota - stored in usedBalance/totalBalance for balance display
      const usedWeek = parseOptionalNumber(quotaInfo.perWeekUsedQuota);
      const totalWeek = parseOptionalNumber(quotaInfo.perWeekTotalQuota);
      if (usedWeek !== undefined) result.usedBalance = usedWeek;
      if (totalWeek !== undefined) result.totalBalance = totalWeek;

      return this.hasQuotaData(result) ? result : null;
    } catch {
      return null;
    }
  }
}

class XfyunCodingPlanQuotaAdapter extends BaseQuotaAdapter {
  async queryQuota(
    provider: LLMProvider,
    timeoutMs: number,
    proxyUrl?: string
  ): Promise<ProviderQuotaResult | null> {
    // quotaToken should contain the iFlytek MaaS console cookie string.
    if (!provider.quotaToken) return null;

    const authorization = extractCookieValue(provider.quotaToken, "atp-auth-token") ||
      extractCookieValue(provider.quotaToken, "tenantToken") ||
      provider.quotaToken;

    const fetchOptions: RequestInit & { dispatcher?: unknown } = {
      method: "GET",
      headers: {
        Accept: "application/json",
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)",
        Origin: "https://maas.xfyun.cn",
        Referer: "https://maas.xfyun.cn/packageSubscription",
        Authorization: authorization.trim(),
        Cookie: provider.quotaToken,
      },
      signal: AbortSignal.timeout(timeoutMs),
    };

    try {
      if (proxyUrl) {
        fetchOptions.dispatcher = getProxyDispatcher(proxyUrl);
      }
      const response = await fetch(
        "https://maas.xfyun.cn/api/v1/gpt-finetune/coding-plan/list?page=1&size=10",
        fetchOptions
      );
      if (!response.ok) return null;

      const payload = await response.json();
      if (payload?.succeed === false || payload?.failed === true) return null;

      const plan = findXfyunCodingPlan(payload, provider.apiKey);
      const usage = plan?.codingPlanUsageDTO || plan?.usage || plan;
      if (!usage || typeof usage !== "object") return null;

      const result: ProviderQuotaResult = {};

      const used5h = parseOptionalNumber(usage.rp5hUsage);
      const total5h = parseOptionalNumber(usage.rp5hLimit);
      if (used5h !== undefined) result.usedDailyBalance = used5h;
      if (total5h !== undefined) result.limitDaily = total5h;

      const usedWeek = parseOptionalNumber(usage.rpwUsage);
      const totalWeek = parseOptionalNumber(usage.rpwLimit);
      if (usedWeek !== undefined) result.usedBalance = usedWeek;
      if (totalWeek !== undefined) result.totalBalance = totalWeek;

      if (result.remainingBalance === undefined && totalWeek !== undefined && usedWeek !== undefined) {
        result.remainingBalance = Math.max(0, totalWeek - usedWeek);
      }

      return this.hasQuotaData(result) ? result : null;
    } catch {
      return null;
    }
  }
}

class KimiCodingPlanQuotaAdapter extends BaseQuotaAdapter {
  async queryQuota(
    provider: LLMProvider,
    timeoutMs: number,
    proxyUrl?: string
  ): Promise<ProviderQuotaResult | null> {
    const authToken = provider.quotaToken || provider.apiKey;
    if (!authToken) return null;

    const fetchOptions: RequestInit & { dispatcher?: unknown } = {
      method: "GET",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${authToken.trim()}`,
      },
      signal: AbortSignal.timeout(timeoutMs),
    };

    try {
      if (proxyUrl) {
        fetchOptions.dispatcher = getProxyDispatcher(proxyUrl);
      }
      const response = await fetch(
        "https://api.kimi.com/coding/v1/usages",
        fetchOptions
      );
      if (!response.ok) return null;

      const payload = await response.json();
      const result: ProviderQuotaResult = {};

      // 5-hour window limit
      const limits = Array.isArray(payload?.limits) ? payload.limits : [];
      if (limits.length > 0 && limits[0]?.detail) {
        const detail = limits[0].detail;
        const limit = parseOptionalNumber(detail.limit);
        const remaining = parseOptionalNumber(detail.remaining);
        const resetTime = detail.resetTime;

        if (limit !== undefined && remaining !== undefined) {
          result.usedDailyBalance = Math.max(0, limit - remaining);
          result.limitDaily = limit;
        }
        if (resetTime) {
          result.resetTime = new Date(resetTime).toISOString();
        }
      }

      // Weekly limit — Kimi API returns `used` (not `remaining`) for the 7d window
      const usage = payload?.usage;
      if (usage) {
        const limit = parseOptionalNumber(usage.limit);
        const remaining = parseOptionalNumber(usage.remaining);
        const used = parseOptionalNumber(usage.used);
        const resetTime = usage.resetTime;

        if (limit !== undefined) {
          result.totalBalance = limit;
          if (used !== undefined) {
            result.usedBalance = used;
          } else if (remaining !== undefined) {
            result.usedBalance = Math.max(0, limit - remaining);
            result.remainingBalance = remaining;
          }
        }
        if (resetTime) {
          result.resetTime7d = new Date(resetTime).toISOString();
          if (!result.resetTime) {
            result.resetTime = result.resetTime7d;
          }
        }
      }

      return this.hasQuotaData(result) ? result : null;
    } catch {
      return null;
    }
  }
}

class MiniMaxCodingPlanQuotaAdapter extends BaseQuotaAdapter {
  async queryQuota(
    provider: LLMProvider,
    timeoutMs: number,
    proxyUrl?: string
  ): Promise<ProviderQuotaResult | null> {
    const authToken = provider.quotaToken || provider.apiKey;
    if (!authToken) return null;

    const hostname = getHostname(provider.baseUrl) || "api.minimaxi.com";
    const apiDomain = hostname.endsWith(".minimax.io") || hostname === "minimax.io"
      ? "api.minimax.io"
      : "api.minimaxi.com";

    try {
      const endpoints = [
        `https://${apiDomain}/v1/token_plan/remains`,
        `https://${apiDomain}/v1/api/openplatform/coding_plan/remains`,
      ];

      let payload: any | null = null;
      for (const endpoint of endpoints) {
        payload = await this.fetchJson(endpoint, provider, timeoutMs, proxyUrl, authToken.trim());
        if (payload) break;
      }
      if (!payload) return null;
      
      // Check business level error
      if (payload?.base_resp) {
        const statusCode = payload.base_resp.status_code;
        if (statusCode !== undefined && statusCode !== 0) {
          return null;
        }
      }

      const modelRemains = Array.isArray(payload?.model_remains) ? payload.model_remains : [];
      if (modelRemains.length === 0) return null;

      const item = modelRemains[0];
      const result: ProviderQuotaResult = {};

      // 5-hour window limit
      const intervalTotal = parseOptionalNumber(item.current_interval_total_count);
      const intervalRemaining = parseOptionalNumber(item.current_interval_usage_count);
      const intervalRemainingPercent = parseOptionalNumber(item.current_interval_remaining_percent);
      const endTime = parseOptionalNumber(item.end_time); // Unix milliseconds

      if (intervalTotal !== undefined && intervalRemaining !== undefined && intervalTotal > 0) {
        result.usedDailyBalance = Math.max(0, intervalTotal - intervalRemaining);
        result.limitDaily = intervalTotal;
      } else if (intervalRemainingPercent !== undefined) {
        result.limitDaily = 100;
        result.usedDailyBalance = Math.max(0, 100 - intervalRemainingPercent);
      }
      if (endTime) {
        result.resetTime = new Date(endTime).toISOString();
      }

      // Weekly limit
      const weeklyTotal = parseOptionalNumber(item.current_weekly_total_count);
      const weeklyRemaining = parseOptionalNumber(item.current_weekly_usage_count);
      const weeklyRemainingPercent = parseOptionalNumber(item.current_weekly_remaining_percent);
      const weeklyEndTime = parseOptionalNumber(item.weekly_end_time); // Unix milliseconds

      if (weeklyTotal !== undefined && weeklyRemaining !== undefined && weeklyTotal > 0) {
        result.usedBalance = Math.max(0, weeklyTotal - weeklyRemaining);
        result.remainingBalance = weeklyRemaining;
        result.totalBalance = weeklyTotal;
      } else if (weeklyRemainingPercent !== undefined) {
        result.totalBalance = 100;
        result.usedBalance = Math.max(0, 100 - weeklyRemainingPercent);
        result.remainingBalance = weeklyRemainingPercent;
      }
      if (weeklyEndTime && !result.resetTime) {
        result.resetTime = new Date(weeklyEndTime).toISOString();
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
const aliyunCodingPlanQuotaAdapter = new AliyunCodingPlanQuotaAdapter();
const xfyunCodingPlanQuotaAdapter = new XfyunCodingPlanQuotaAdapter();
const kimiCodingPlanQuotaAdapter = new KimiCodingPlanQuotaAdapter();
const miniMaxCodingPlanQuotaAdapter = new MiniMaxCodingPlanQuotaAdapter();

export function getQuotaAdapter(baseUrl: string): QuotaAdapter | null {
  const hostname = getHostname(baseUrl);
  if (!hostname) return null;

  if (
    hostname === "kimi.com" ||
    hostname.endsWith(".kimi.com") ||
    hostname === "moonshot.cn" ||
    hostname.endsWith(".moonshot.cn")
  ) {
    return kimiCodingPlanQuotaAdapter;
  }

  if (
    hostname === "minimaxi.com" ||
    hostname.endsWith(".minimaxi.com") ||
    hostname === "minimax.io" ||
    hostname.endsWith(".minimax.io")
  ) {
    return miniMaxCodingPlanQuotaAdapter;
  }

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

  // Aliyun Coding Plan quota adapter - matches dashscope.aliyuncs.com or coding.dashscope.aliyuncs.com
  if (
    hostname === "dashscope.aliyuncs.com" ||
    hostname.endsWith(".dashscope.aliyuncs.com")
  ) {
    return aliyunCodingPlanQuotaAdapter;
  }

  // iFlytek Coding Plan quota adapter - model API hosts use xf-yun.com,
  // while the quota endpoint lives under maas.xfyun.cn.
  if (
    hostname === "xf-yun.com" ||
    hostname.endsWith(".xf-yun.com") ||
    hostname === "xfyun.cn" ||
    hostname.endsWith(".xfyun.cn") ||
    hostname === "xfyun.com" ||
    hostname.endsWith(".xfyun.com")
  ) {
    return xfyunCodingPlanQuotaAdapter;
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

function findXfyunCodingPlan(payload: any, providerApiKey?: string): any | null {
  const plans = collectXfyunCodingPlans(payload);
  if (plans.length === 0) return null;

  const providerKeyParts = String(providerApiKey || "")
    .split(":")
    .map((part) => part.trim())
    .filter(Boolean);

  const matched = plans.find((plan) => {
    const credential = plan?.codingPlanAppCredentialDTO || plan?.appCredential || plan;
    const planApiKey = String(credential?.apiKey || credential?.api_key || "").trim();
    return planApiKey && providerKeyParts.some((part) => part.includes(planApiKey) || planApiKey.includes(part));
  });

  return matched || plans[0];
}

function collectXfyunCodingPlans(value: any): any[] {
  if (!value || typeof value !== "object") return [];

  if (!Array.isArray(value) && value.codingPlanUsageDTO) {
    return [value];
  }

  if (Array.isArray(value)) {
    return value.flatMap((item) => collectXfyunCodingPlans(item));
  }

  return Object.values(value).flatMap((item) => collectXfyunCodingPlans(item));
}

function extractCookieValue(cookie: string, name: string): string | undefined {
  const match = cookie.match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
  return match ? decodeURIComponent(match[1]) : undefined;
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
