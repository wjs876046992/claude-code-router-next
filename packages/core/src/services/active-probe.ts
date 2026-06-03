/**
 * Active health/quota probing service for providers
 * Runs periodic probes to refresh health and quota info without waiting for real traffic
 */

import { getHealthStore, ProviderHealthState } from './provider-health';
import { captureRateLimitHeaders } from './rate-limit';
import { getQuotaAdapter } from './quota-adapters';
import { storeQuotaResult } from './quota-store';
import type { LLMProvider } from '../types/llm';

/**
 * Configuration for active probing behavior
 */
export interface ActiveProbeConfig {
  /** Enable active probing (default: true) */
  enabled?: boolean;
  /** Interval in minutes for periodic quota probes (default: 10) */
  quotaProbeIntervalMinutes?: number;
  /** Timeout in milliseconds for probe requests (default: 15000) */
  probeTimeoutMs?: number;
  /** Initial delay before starting first probe (default: 5000) */
  initialDelayMs?: number;
  /** Providers to exclude from active probing (e.g., providers without models endpoint) */
  excludeProviders?: string[];
}

const DEFAULT_CONFIG: Required<ActiveProbeConfig> = {
  enabled: true,
  quotaProbeIntervalMinutes: 10,
  probeTimeoutMs: 15000,
  initialDelayMs: 5000,
  excludeProviders: [],
};

function isConfigEnabled(value: any): boolean {
  return value === true || value === 'true' || value === 1 || value === '1';
}

function getLocalDateString(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * Derive a models endpoint URL from the provider base URL
 * Prefers lightweight GET requests to /models or /v1/models endpoints
 */
function deriveModelsEndpoint(baseUrl: string): string | null {
  try {
    const url = new URL(baseUrl);
    // Normalize path: remove trailing /v1/messages or similar
    let path = url.pathname;

    // Remove common endpoint suffixes
    if (path.endsWith('/v1/messages')) {
      path = path.slice(0, -'/v1/messages'.length);
    } else if (path.endsWith('/messages')) {
      path = path.slice(0, -'/messages'.length);
    } else if (path.endsWith('/v1/chat/completions')) {
      path = path.slice(0, -'/v1/chat/completions'.length);
    } else if (path.endsWith('/chat/completions')) {
      path = path.slice(0, -'/chat/completions'.length);
    }

    // Ensure path ends with /v1 for OpenAI-compatible endpoints
    if (!path.endsWith('/v1')) {
      path = path.endsWith('/') ? `${path}v1` : `${path}/v1`;
    }

    // Use /models endpoint
    url.pathname = `${path}/models`;
    return url.toString();
  } catch {
    return null;
  }
}

/**
 * Keep the existing active header probe for providers known to expose quota
 * headers on lightweight model-list requests.
 */
function shouldProbeRateLimitHeaders(baseUrl: string): boolean {
  try {
    const hostname = new URL(baseUrl).hostname.toLowerCase();
    return hostname.includes('moonshot') || hostname.includes('kimi');
  } catch {
    return false;
  }
}

/**
 * Perform a single probe against a provider
 * Uses lightweight GET to models endpoint when available
 */
async function probeProvider(
  provider: LLMProvider,
  timeoutMs: number,
  proxyUrl?: string
): Promise<{ success: boolean; error?: string; headers?: Headers }> {
  const modelsUrl = deriveModelsEndpoint(provider.baseUrl);

  if (!modelsUrl) {
    // Cannot derive endpoint, skip probe
    return { success: false, error: 'Cannot derive models endpoint from baseUrl' };
  }

  try {
    const fetchOptions: RequestInit = {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${provider.apiKey}`,
      },
      signal: AbortSignal.timeout(timeoutMs),
    };

    // Add proxy if configured
    if (proxyUrl) {
      try {
        const { ProxyAgent } = await import('undici');
        (fetchOptions as any).dispatcher = new ProxyAgent(new URL(proxyUrl).toString());
      } catch {
        // Proxy agent not available, continue without proxy
      }
    }

    const response = await fetch(modelsUrl, fetchOptions);

    // Capture rate limit headers regardless of success/failure
    if (response.headers) {
      captureRateLimitHeaders(provider.name, provider.baseUrl, response.headers);
    }

    if (response.ok) {
      return { success: true, headers: response.headers };
    }

    if (response.status === 429) {
      const errorText = await response.text().catch(() => '');
      return {
        success: false,
        error: `HTTP 429: ${errorText.slice(0, 100) || 'Rate limited'}`,
        headers: response.headers,
      };
    }

    // Any non-rate-limit HTTP 4xx response means the server is reachable
    // and just rejected the request.
    if (response.status >= 400 && response.status < 500) {
      return { success: true, headers: response.headers };
    }

    const errorText = await response.text().catch(() => '');
    return {
      success: false,
      error: `HTTP ${response.status}: ${errorText.slice(0, 100)}`,
      headers: response.headers,
    };
  } catch (err: any) {
    const errorMessage = err?.message || err?.toString() || 'Unknown probe error';
    return { success: false, error: errorMessage };
  }
}

/**
 * Perform a scheduled wake-up call to a provider to trigger their quota cycle start.
 * Sends a dummy chat completion / messages request.
 */
async function wakeupProvider(
  provider: LLMProvider,
  timeoutMs: number,
  proxyUrl?: string,
  logger?: any
): Promise<{ success: boolean; error?: string }> {
  const modelToWakeup = provider.wakeupModel || (Array.isArray(provider.models) ? provider.models[0] : undefined);
  if (!modelToWakeup) {
    return { success: false, error: 'No models configured for provider' };
  }

  const isAnthropic = provider.baseUrl.includes('anthropic') || modelToWakeup.includes('claude');
  const chatUrl = isAnthropic
    ? (provider.baseUrl.includes('/messages') ? provider.baseUrl : `${provider.baseUrl.replace(/\/$/, '')}/v1/messages`)
    : (provider.baseUrl.includes('/chat/completions') ? provider.baseUrl : `${provider.baseUrl.replace(/\/$/, '')}/chat/completions`);

  try {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };

    if (isAnthropic) {
      headers['x-api-key'] = provider.apiKey;
      headers['anthropic-version'] = '2023-06-01';
    } else {
      headers['Authorization'] = `Bearer ${provider.apiKey}`;
    }

    const fetchOptions: RequestInit = {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: modelToWakeup,
        messages: [{ role: 'user', content: 'ping' }],
        max_tokens: 1,
      }),
      signal: AbortSignal.timeout(timeoutMs),
    };

    // Add proxy if configured
    if (proxyUrl) {
      try {
        const { ProxyAgent } = await import('undici');
        (fetchOptions as any).dispatcher = new ProxyAgent(new URL(proxyUrl).toString());
      } catch {
        // Proxy agent not available, continue without proxy
      }
    }

    logger?.info(`Sending scheduled wake-up call to provider ${provider.name} using model ${modelToWakeup}...`);
    const response = await fetch(chatUrl, fetchOptions);

    if (response.ok) {
      return { success: true };
    }

    const errorText = await response.text().catch(() => '');
    return {
      success: false,
      error: `HTTP ${response.status}: ${errorText.slice(0, 200) || 'Unknown error'}`,
    };
  } catch (err: any) {
    const errorMessage = err?.message || err?.toString() || 'Unknown wake-up error';
    return { success: false, error: errorMessage };
  }
}

/**
 * Perform a scheduled ping to a specific model to check if rate limits have cleared.
 * Sends a dummy chat completion / messages request.
 */
async function pingProviderModel(
  provider: LLMProvider,
  modelName: string,
  timeoutMs: number,
  proxyUrl?: string,
  logger?: any
): Promise<{ success: boolean; error?: string }> {
  const isAnthropic = provider.baseUrl.includes('anthropic') || modelName.includes('claude');
  const chatUrl = isAnthropic
    ? (provider.baseUrl.includes('/messages') ? provider.baseUrl : `${provider.baseUrl.replace(/\/$/, '')}/v1/messages`)
    : (provider.baseUrl.includes('/chat/completions') ? provider.baseUrl : `${provider.baseUrl.replace(/\/$/, '')}/chat/completions`);

  try {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };

    if (isAnthropic) {
      headers['x-api-key'] = provider.apiKey;
      headers['anthropic-version'] = '2023-06-01';
    } else {
      headers['Authorization'] = `Bearer ${provider.apiKey}`;
    }

    const fetchOptions: RequestInit = {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: modelName,
        messages: [{ role: 'user', content: 'ping' }],
        max_tokens: 1,
      }),
      signal: AbortSignal.timeout(timeoutMs),
    };

    // Add proxy if configured
    if (proxyUrl) {
      try {
        const { ProxyAgent } = await import('undici');
        (fetchOptions as any).dispatcher = new ProxyAgent(new URL(proxyUrl).toString());
      } catch {
        // Proxy agent not available, continue without proxy
      }
    }

    logger?.debug?.(`Sending independent ping to rate-limited model ${provider.name} (${modelName})...`);
    const response = await fetch(chatUrl, fetchOptions);

    if (response.ok) {
      return { success: true };
    }

    const errorText = await response.text().catch(() => '');
    return {
      success: false,
      error: `HTTP ${response.status}: ${errorText.slice(0, 200) || 'Unknown error'}`,
    };
  } catch (err: any) {
    const errorMessage = err?.message || err?.toString() || 'Unknown ping error';
    return { success: false, error: errorMessage };
  }
}

/**
 * Active probe scheduler
 */
export class ActiveProbeService {
  private config: Required<ActiveProbeConfig>;
  private quotaProbeTimer?: NodeJS.Timeout;
  private healthProbeTimer?: NodeJS.Timeout;
  private wakeupTimer?: NodeJS.Timeout;
  private rateLimitProbeTimer?: NodeJS.Timeout;
  private lastWakeupDate: Map<string, string> = new Map(); // key: providerName, value: YYYY-MM-DD
  private getProviders: () => LLMProvider[];
  private getHttpsProxy?: () => string | undefined;
  private logger?: any;
  private getConfig?: (key: string) => any;
  private running = false;

  constructor(
    getProviders: () => LLMProvider[],
    config?: ActiveProbeConfig,
    getHttpsProxy?: () => string | undefined,
    logger?: any,
    getConfig?: (key: string) => any
  ) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.getProviders = getProviders;
    this.getHttpsProxy = getHttpsProxy;
    this.logger = logger;
    this.getConfig = getConfig;
  }

  /**
   * Start the active probe loop
   */
  start(): void {
    if (this.running) return;

    const wakeupEnabled = this.isWakeupGloballyEnabled();
    if (!this.config.enabled && !wakeupEnabled) return;

    this.running = true;

    // Initial probe after delay
    setTimeout(() => {
      if (!this.running) return;
      if (this.config.enabled) {
        this.runQuotaProbe();
        this.runHealthProbe();
        this.runRateLimitProbe();
      }
      this.runScheduledWakeup();
    }, this.config.initialDelayMs);

    if (this.config.enabled) {
      // Periodic quota probe
      this.quotaProbeTimer = setInterval(
        () => this.runQuotaProbe(),
        this.config.quotaProbeIntervalMinutes * 60 * 1000
      );

      // Periodic health probe (aligned with ProviderHealthStore probeInterval)
      // Run every 5 minutes to check open states
      this.healthProbeTimer = setInterval(
        () => this.runHealthProbe(),
        5 * 60 * 1000
      );

      // Rate-limit recovery probe: runs every 2 minutes so rate-limited models
      // are tested for recovery more frequently than the health probe.
      this.rateLimitProbeTimer = setInterval(
        () => this.runRateLimitProbe(),
        2 * 60 * 1000
      );
    }

    // Periodic scheduled wake-up check every minute
    this.wakeupTimer = setInterval(
      () => this.runScheduledWakeup(),
      60 * 1000
    );

    this.logger?.info('Active probe service started');
  }

  /**
   * Stop all probe timers
   */
  stop(): void {
    this.running = false;

    if (this.quotaProbeTimer) {
      clearInterval(this.quotaProbeTimer);
      this.quotaProbeTimer = undefined;
    }

    if (this.healthProbeTimer) {
      clearInterval(this.healthProbeTimer);
      this.healthProbeTimer = undefined;
    }

    if (this.rateLimitProbeTimer) {
      clearInterval(this.rateLimitProbeTimer);
      this.rateLimitProbeTimer = undefined;
    }

    if (this.wakeupTimer) {
      clearInterval(this.wakeupTimer);
      this.wakeupTimer = undefined;
    }

    this.logger?.info('Active probe service stopped');
  }

  /**
   * Run quota probes for configured providers.
   * Provider-specific adapters actively query official quota APIs, while the
   * Kimi/Moonshot models probe continues to capture header-based limits.
   * When quota is exhausted, marks provider as unhealthy in health store.
   */
  private async runQuotaProbe(): Promise<void> {
    const providers = this.getProviders().filter(
      p => p?.name && p.enabled !== false && !this.config.excludeProviders.includes(p.name)
    );
    const proxy = this.getHttpsProxy?.();
    const healthStore = getHealthStore();

    if (providers.length === 0) return;

    const tasks: Array<{ provider: string; models: string[]; type: string; promise: Promise<void> }> = [];

    for (const provider of providers) {
      const adapter = getQuotaAdapter(provider.baseUrl);
      const models = Array.isArray(provider.models) ? provider.models : [];

      if (adapter) {
        tasks.push({
          provider: provider.name,
          models,
          type: 'quota-adapter',
          promise: adapter
            .queryQuota(provider, this.config.probeTimeoutMs, proxy)
            .then(result => {
              if (result) {
                storeQuotaResult(provider.name, result);
                this.logger?.debug?.(`Stored quota probe result for ${provider.name}`);

                // Check if quota is exhausted and mark as unhealthy
                const is5hExhausted = result.limitDaily !== undefined &&
                  result.usedDailyBalance !== undefined &&
                  result.usedDailyBalance >= result.limitDaily;
                const is7dExhausted = result.totalBalance !== undefined &&
                  result.usedBalance !== undefined &&
                  result.usedBalance >= result.totalBalance;

                if (is5hExhausted || is7dExhausted) {
                  const errorMsg = is5hExhausted
                    ? `Quota exhausted: 5h limit reached (${result.usedDailyBalance}/${result.limitDaily})`
                    : `Quota exhausted: 7d balance depleted (${result.usedBalance}/${result.totalBalance})`;
                  for (const m of models) {
                    // Skip forceOpen for rate-limited models — markRateLimited already set
                    // status=open with rateLimitUntil; forceOpen would delete the cooldown.
                    const s = healthStore.getState(provider.name, m);
                    if (s?.rateLimitUntil) {
                      this.logger?.debug?.(`Skip forceOpen for ${provider.name} (${m}): already rate-limited with active cooldown`);
                      continue;
                    }
                    healthStore.forceOpen(provider.name, m, errorMsg);
                  }
                  this.logger?.warn?.(`${errorMsg} for ${provider.name}, marked as unhealthy`);
                } else {
                  for (const m of models) {
                    const state = healthStore.getState(provider.name, m);
                    if (state && state.status === 'open' && state.lastError?.includes('Quota exhausted')) {
                      healthStore.recover(provider.name, m);
                      this.logger?.info?.(`Quota recovered for ${provider.name} (${m}), marked as healthy`);
                    }
                  }
                }
              }
            }),
        });
      }

      if (shouldProbeRateLimitHeaders(provider.baseUrl)) {
        tasks.push({
          provider: provider.name,
          models,
          type: 'rate-limit-headers',
          promise: probeProvider(provider, this.config.probeTimeoutMs, proxy).then(() => undefined),
        });
      }
    }

    if (tasks.length === 0) return;

    this.logger?.debug?.(
      `Running quota probe with ${tasks.length} tasks for ${providers.length} providers`
    );

    const results = await Promise.allSettled(tasks.map(task => task.promise));

    for (let i = 0; i < tasks.length; i++) {
      const result = results[i];
      if (result.status === 'rejected') {
        const task = tasks[i];
        this.logger?.warn?.(
          `Quota probe failed for ${task.provider} (${task.type}): ${result.reason}`
        );
      }
    }
  }

  /**
   * Run health probe for all providers
   * Probes every configured provider to detect reachability issues early,
   * not just providers already in the fail pool.
   */
  private async runHealthProbe(): Promise<void> {
    const healthStore = getHealthStore();
    const providers = this.getProviders().filter(
      p => p?.name && p.enabled !== false && !this.config.excludeProviders.includes(p.name)
    );
    const proxy = this.getHttpsProxy?.();

    if (providers.length === 0) return;

    this.logger?.debug?.(`Running health probe for ${providers.length} providers`);

    // Probe all providers concurrently
    const results = await Promise.allSettled(
      providers.map(provider =>
        probeProvider(provider, this.config.probeTimeoutMs, proxy)
      )
    );

    for (let i = 0; i < providers.length; i++) {
      const provider = providers[i];
      const result = results[i];
      const models = Array.isArray(provider.models) ? provider.models : [];

      if (result.status === 'fulfilled') {
        const probeResult = result.value;
        if (probeResult.success) {
          let recoveredCount = 0;
          for (const m of models) {
            const state = healthStore.getState(provider.name, m);
            if (state && state.status === 'open') {
              const isQuotaExhausted = state.lastError?.includes('Quota exhausted');
              const isRateLimit = state.rateLimitUntil || (
                state.lastError && (
                  state.lastError.includes('429') ||
                  state.lastError.toLowerCase().includes('rate limit') ||
                  state.lastError.toLowerCase().includes('rate_limit') ||
                  state.lastError.toLowerCase().includes('too many requests') ||
                  state.lastError.toLowerCase().includes('限流')
                )
              );

              if (isQuotaExhausted) {
                this.logger?.debug?.(`Skipping health probe recovery for ${provider.name} (${m}) because quota is exhausted`);
                continue;
              }

              if (isRateLimit || state.rateLimitUntil) {
                // Rate-limited models are handled by the dedicated runRateLimitProbe()
                // which sends real chat requests. Do NOT recover them via the generic
                // /v1/models endpoint probe.
                this.logger?.debug?.(`Skipping health probe recovery for rate-limited ${provider.name} (${m})`);
                continue;
              }
            }
            healthStore.recordSuccess(provider.name, m);
            recoveredCount++;
          }
          if (recoveredCount > 0) {
            this.logger?.info?.(`Health probe succeeded for ${provider.name}`);
          }
        } else {
          for (const m of models) {
            healthStore.recordFailure(provider.name, m, probeResult.error);
          }
          this.logger?.warn?.(`Health probe failed for ${provider.name}: ${probeResult.error}`);
        }
      } else {
        for (const m of models) {
          healthStore.recordFailure(provider.name, m, result.reason?.message || 'Probe error');
        }
        this.logger?.warn?.(`Health probe error for ${provider.name}: ${result.reason}`);
      }
    }
  }

  /**
   * Run independent probe for rate-limited models.
   * Sends real chat requests (max_tokens:1) to test if the rate limit has cleared.
   * Rate-limited models are NOT probed by runHealthProbe — they have a separate timer
   * so they can be checked more frequently (every 2 minutes) without affecting normal probes.
   */
  private async runRateLimitProbe(): Promise<void> {
    const healthStore = getHealthStore();
    const rateLimitedKeys = healthStore.getRateLimitedModels();
    if (rateLimitedKeys.length === 0) return;

    const providers = this.getProviders();
    const proxy = this.getHttpsProxy?.();
    const pingTimeoutMs = this.config.probeTimeoutMs;

    this.logger?.debug?.(`Running rate-limit recovery probe for ${rateLimitedKeys.length} model(s)`);

    for (const key of rateLimitedKeys) {
      const [providerName, ...modelParts] = key.split(',');
      const modelName = modelParts.join(',');
      if (!providerName || !modelName) continue;

      // Check if cooldown expired (auto-recovered via isAvailable check, but just in case)
      const state = healthStore.getState(providerName, modelName);
      if (!state || !state.rateLimitUntil) continue;
      if (Date.now() >= state.rateLimitUntil) {
        healthStore.recover(providerName, modelName);
        this.logger?.info?.(`Rate-limit cooldown expired, auto-recovered ${key}`);
        continue;
      }

      // Find provider config
      const provider = providers.find(
        p => p?.name === providerName && p.enabled !== false
      );
      if (!provider) {
        this.logger?.warn?.(`Provider ${providerName} not found or disabled for rate-limit probe`);
        continue;
      }

      try {
        const result = await pingProviderModel(provider, modelName, pingTimeoutMs, proxy, this.logger);

        if (result.success) {
          this.logger?.info?.(`Rate-limit probe succeeded for ${key}, recovering model`);
          healthStore.recover(providerName, modelName);
        } else if (result.error && (
          result.error.includes('429') ||
          result.error.toLowerCase().includes('rate limit') ||
          result.error.toLowerCase().includes('rate_limit') ||
          result.error.toLowerCase().includes('too many requests') ||
          result.error.toLowerCase().includes('限流')
        )) {
          // Still rate-limited — extend the cooldown
          const now = Date.now();
          if (state.rateLimitUntil && state.rateLimitUntil > now) {
            state.rateLimitUntil += 120 * 1000;
          } else {
            state.rateLimitUntil = now + 120 * 1000;
          }
          this.logger?.debug?.(`Rate-limit probe for ${key} confirmed still limited, extending cooldown`);
        } else {
          // Non-rate-limit error (e.g. auth failure, 500) — leave in rate-limited state
          // but still meaningful: the model is not usable for real requests either.
          // The cooldown will expire naturally and isAvailable will re-check.
          this.logger?.debug?.(`Rate-limit probe for ${key} returned non-rate-limit error: ${result.error?.slice(0, 100)}`);
        }
      } catch (err: any) {
        this.logger?.warn?.(`Rate-limit probe exception for ${key}: ${err?.message || err}`);
      }
    }
  }

  /**
   * Run scheduled wake-up for configured providers
   */
  private async runScheduledWakeup(): Promise<void> {
    if (!this.isWakeupGloballyEnabled()) {
      return;
    }

    const providers = this.getProviders().filter(
      p => p?.name && p.enabled !== false && p.wakeupEnabled === true
    );
    if (providers.length === 0) return;

    const now = new Date();
    const currentHour = now.getHours();
    const currentMinute = now.getMinutes();
    const currentDateStr = getLocalDateString(now);
    const proxy = this.getHttpsProxy?.();
    const globalWakeupTime = this.getConfig ? this.getConfig('WAKEUP_TIME') || '06:00' : '06:00';

    for (const provider of providers) {
      const wakeupTime = provider.wakeupTime || globalWakeupTime;
      const [targetHourStr, targetMinuteStr] = wakeupTime.split(':');
      const targetHour = parseInt(targetHourStr, 10);
      const targetMinute = parseInt(targetMinuteStr, 10);

      if (isNaN(targetHour) || isNaN(targetMinute)) {
        continue;
      }

      // Use fallback-safe match: trigger if current time is at/past the target,
      // using lastWakeupDate to ensure it fires at most once per day.
      // This survives macOS sleep/wake cycles that skip the exact target minute.
      const isPastTarget = currentHour > targetHour ||
        (currentHour === targetHour && currentMinute >= targetMinute);

      // Also fire if we're within a 5-minute window of the target time,
      // covering short sleep cycles where the timer fires early.
      const msUntilTarget = (targetHour * 60 + targetMinute) * 60000 - (currentHour * 60 + currentMinute) * 60000;
      const isWithinWindow = msUntilTarget > 0 && msUntilTarget <= 5 * 60 * 1000;

      if ((isPastTarget || isWithinWindow) && !this.hasWakeupFiredToday(provider.name, currentDateStr)) {
          this.logger?.info?.(`Scheduled wake-up triggered for provider ${provider.name} at ${wakeupTime}`);

          wakeupProvider(provider, 30000, proxy, this.logger).then(res => {
            if (res.success) {
              this.logger?.info?.(`Successfully woke up provider ${provider.name}`);
            } else {
              this.logger?.error?.(`Failed to wake up provider ${provider.name}: ${res.error}`);
            }
          }).catch(err => {
             this.logger?.error?.(`Error in wake-up task for ${provider.name}: ${err}`);
          });
      }
    }
  }

  private isWakeupGloballyEnabled(): boolean {
    return this.getConfig ? isConfigEnabled(this.getConfig('WAKEUP_ENABLED')) : false;
  }

  /**
   * Check if the wake-up has already fired for this provider today.
   * Returns true if already fired, so the caller can skip.
   * If not yet fired, atomically marks it as fired.
   */
  private hasWakeupFiredToday(providerName: string, currentDateStr: string): boolean {
    if (this.lastWakeupDate.get(providerName) === currentDateStr) {
      return true;
    }
    this.lastWakeupDate.set(providerName, currentDateStr);
    return false;
  }

  /**
   * Trigger a manual probe for a specific provider
   */
  async probeProviderManually(providerName: string): Promise<boolean> {
    const providers = this.getProviders();
    const provider = providers.find(p => p.name === providerName);

    if (!provider) {
      this.logger?.warn?.(`Provider ${providerName} not found for manual probe`);
      return false;
    }

    if (provider.enabled === false) {
      this.logger?.warn?.(`Provider ${providerName} is disabled, skipping manual probe`);
      return false;
    }

    const proxy = this.getHttpsProxy?.();
    const result = await probeProvider(provider, this.config.probeTimeoutMs, proxy);

    const models = Array.isArray(provider.models) ? provider.models : [];

    if (result.success) {
      for (const m of models) {
        getHealthStore().recordSuccess(provider.name, m);
      }
    } else {
      for (const m of models) {
        getHealthStore().recordFailure(provider.name, m, result.error);
      }
    }

    return result.success;
  }
}

// Singleton instance
let activeProbeService: ActiveProbeService | null = null;

/**
 * Initialize and get the active probe service
 */
export function getActiveProbeService(
  getProviders: () => LLMProvider[],
  config?: ActiveProbeConfig,
  getHttpsProxy?: () => string | undefined,
  logger?: any,
  getConfig?: (key: string) => any
): ActiveProbeService {
  if (!activeProbeService) {
    activeProbeService = new ActiveProbeService(getProviders, config, getHttpsProxy, logger, getConfig);
  }
  return activeProbeService;
}

/**
 * Start the active probe service (convenience function)
 */
export function startActiveProbe(
  getProviders: () => LLMProvider[],
  config?: ActiveProbeConfig,
  getHttpsProxy?: () => string | undefined,
  logger?: any,
  getConfig?: (key: string) => any
): ActiveProbeService {
  const service = getActiveProbeService(getProviders, config, getHttpsProxy, logger, getConfig);
  service.start();
  return service;
}

/**
 * Stop the active probe service
 */
export function stopActiveProbe(): void {
  if (activeProbeService) {
    activeProbeService.stop();
  }
}

/**
 * Reset the active probe service (for testing)
 */
export function resetActiveProbeService(): void {
  if (activeProbeService) {
    activeProbeService.stop();
    activeProbeService = null;
  }
}
