import Server, { calculateTokenCount, TokenizerService, getAllRateLimitInfo, getAllQuotaResults, setRuntimeDebugLog, getRuntimeDebugLog } from "@wengine-ai/llms";
const _llmsModule = require("@wengine-ai/llms") as any;
const initRateLimitPersistence: () => void = _llmsModule.initRateLimitPersistence;
const initQuotaStorePersistence: () => void = _llmsModule.initQuotaStorePersistence;
const ProviderService = _llmsModule.ProviderService;
const startActiveProbe = _llmsModule.startActiveProbe;
const resetActiveProbeService = _llmsModule.resetActiveProbeService;
import { getHealthStore } from "@wengine-ai/llms";
import { reconcileHealthStore, clearProviderHealth } from "./utils/health-reconcile";
import { readConfigFile, readConfigFileRaw, writeConfigFile, backupConfigFile } from "./utils";
import { join, isAbsolute, normalize } from "path";
import fastifyStatic from "@fastify/static";
import { readdirSync, statSync, readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync, rmSync } from "fs";
import { homedir } from "os";
import {
  getPresetDir,
  readManifestFromDir,
  manifestToPresetFile,
  saveManifest,
  isPresetInstalled,
  extractPreset,
  HOME_DIR,
  extractMetadata,
  loadConfigFromManifest,
  downloadPresetToTemp,
  getTempDir,
  findMarketPresetByName,
  getMarketPresets,
  applyClientSelection,
  activateCodexAccount,
  deleteCodexAccount,
  disableClient,
  enableClient,
  exportCodexRefreshToken,
  importCodexAccountFromRefreshToken,
  importCurrentCodexAccount,
  isClientId,
  listCodexAccounts,
  listClientStatuses,
  restoreClient,
  type CodexAccountsResult,
  type PresetFile,
  type ManifestFile,
  type PresetMetadata,
  listProjectConfigs,
  readProjectConfigById,
  readProjectConfig,
  writeProjectConfig,
  deleteProjectConfig,
  getClaudeProjectId,
  getProjectConfigPath,
  refreshProjectTakeovers,
  syncGlobalProjectTakeovers,
  getProjectTakeoverClients,
  setProjectTakeover,
  isProjectTakeoverClient,
  type ClientId,
} from "@wengine-ai/claude-code-router-shared";
import fastifyMultipart from "@fastify/multipart";
import AdmZip from "adm-zip";
import { query as queryUsage, querySummary as queryUsageSummary, clear as clearUsage } from "./services/usage-store";

interface ProviderQuotaUsage {
  provider: string;
  used5h: number;
  used7d: number;
  limit5h?: number;
  limit7d?: number;
  reset5h?: string;
  reset7d?: string;
  /** Display type for the 5h slot: 'rateLimit' (限额) or 'balance' (余额) */
  type5h?: 'rateLimit' | 'balance';
  /** Display type for the 7d slot: 'rateLimit' (限额) or 'balance' (余额) */
  type7d?: 'rateLimit' | 'balance';
  /** Currency for balance display (e.g. "CNY", "USD") */
  currency?: string;
}

interface AnthropicModelInfo {
  type: "model";
  id: string;
  display_name: string;
  created_at: string;
  context_window: number;
  contextWindow: number;
  max_input_tokens: number;
  maxInputTokens: number;
  max_tokens: number;
  maxTokens: number;
  max_output_tokens: number;
  maxOutputTokens: number;
  capabilities: {
    context_window: number;
    contextWindow: number;
    max_input_tokens: number;
    maxInputTokens: number;
    max_tokens: number;
    maxTokens: number;
    max_output_tokens: number;
    maxOutputTokens: number;
  };
}

/**
 * Compute provider quota usage for 5-hour and 7-day windows
 */
function computeProviderQuota(providers: any[]): ProviderQuotaUsage[] {
  const now = new Date().toISOString();

  // 5 hours window
  const start5h = new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString();

  // 7 days window
  const start7d = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

  // Query summaries per provider
  const summary5h = queryUsageSummary(start5h, now);
  const summary7d = queryUsageSummary(start7d, now);

  // Build result array
  const result: ProviderQuotaUsage[] = [];

  // Collect unique provider names from config and usage
  const providerNames = new Set<string>();
  for (const p of providers || []) {
    if (p && p.name) providerNames.add(p.name);
  }
  for (const name of Object.keys(summary5h.byProvider || {})) providerNames.add(name);
  for (const name of Object.keys(summary7d.byProvider || {})) providerNames.add(name);

  for (const name of providerNames) {
    const provider5h = summary5h.byProvider[name] || { inputTokens: 0, outputTokens: 0 };
    const provider7d = summary7d.byProvider[name] || { inputTokens: 0, outputTokens: 0 };

    const used5h = (provider5h.inputTokens || 0) + (provider5h.outputTokens || 0);
    const used7d = (provider7d.inputTokens || 0) + (provider7d.outputTokens || 0);

    // Get limits from provider config if present
    let limit5h: number | undefined;
    let limit7d: number | undefined;
    const providerConfig = (providers || []).find((p: any) => p && p.name === name);
    if (providerConfig && providerConfig.quota) {
      limit5h = providerConfig.quota.limit5h;
      limit7d = providerConfig.quota.limit7d;
    }

    result.push({
      provider: name,
      used5h,
      used7d,
      limit5h,
      limit7d,
    });
  }

  return result;
}

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

async function computeCodexAccountUsage(config: Record<string, any>): Promise<CodexAccountsResult> {
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

function getModelContextWindow(modelId: string): number {
  return /\[1m\]/i.test(modelId) ? 1_000_000 : 200_000;
}

function getModelMaxOutputTokens(modelId: string): number {
  const normalized = modelId.toLowerCase();
  if (normalized.includes("haiku") || normalized.includes("mini")) return 8_192;
  return 32_000;
}

function createAnthropicModelInfo(id: string, displayName = id): AnthropicModelInfo {
  const contextWindow = getModelContextWindow(id);
  const maxOutputTokens = getModelMaxOutputTokens(id);
  return {
    type: "model",
    id,
    display_name: displayName,
    created_at: "2024-01-01T00:00:00Z",
    context_window: contextWindow,
    contextWindow,
    max_input_tokens: contextWindow,
    maxInputTokens: contextWindow,
    max_tokens: maxOutputTokens,
    maxTokens: maxOutputTokens,
    max_output_tokens: maxOutputTokens,
    maxOutputTokens: maxOutputTokens,
    capabilities: {
      context_window: contextWindow,
      contextWindow,
      max_input_tokens: contextWindow,
      maxInputTokens: contextWindow,
      max_tokens: maxOutputTokens,
      maxTokens: maxOutputTokens,
      max_output_tokens: maxOutputTokens,
      maxOutputTokens: maxOutputTokens,
    },
  };
}

function listAnthropicCompatibleModels(config: any): AnthropicModelInfo[] {
  const models = new Map<string, AnthropicModelInfo>();
  const addModel = (id: string, displayName = id) => {
    if (!id || models.has(id)) return;
    models.set(id, createAnthropicModelInfo(id, displayName));
  };

  addModel("ccr-opus", "CCR Opus");
  addModel("ccr-sonnet", "CCR Sonnet");
  addModel("ccr-haiku", "CCR Haiku");
  addModel("ccr-opus[1m]", "CCR Opus 1M");
  addModel("ccr-sonnet[1m]", "CCR Sonnet 1M");
  addModel("ccr-haiku[1m]", "CCR Haiku 1M");

  for (const provider of config.Providers || config.providers || []) {
    if (!provider?.name || !Array.isArray(provider.models)) continue;
    for (const model of provider.models) {
      if (typeof model !== "string" || !model) continue;
      addModel(model, model);
      addModel(`${provider.name},${model}`, `${provider.name}/${model}`);
    }
  }

  return Array.from(models.values());
}

export const createServer = async (config: any): Promise<any> => {
  const server = new Server(config);
  const app = server.app;

  // Restore persisted rate-limit and quota data from disk
  initRateLimitPersistence();
  initQuotaStorePersistence();

  app.register(fastifyMultipart, {
    limits: {
      fileSize: 50 * 1024 * 1024, // 50MB
    },
  });

  app.get("/v1/models", async () => {
    const data = listAnthropicCompatibleModels(config);
    return {
      object: "list",
      data,
      first_id: data[0]?.id || null,
      last_id: data[data.length - 1]?.id || null,
      has_more: false,
    };
  });

  app.get("/v1/models/:modelId", async (req: any, reply: any) => {
    const modelId = decodeURIComponent(req.params.modelId);
    const model = listAnthropicCompatibleModels(config).find((item) => item.id === modelId);
    if (!model) {
      reply.status(404);
      return {
        type: "error",
        error: {
          type: "not_found_error",
          message: `Model not found: ${modelId}`,
        },
      };
    }
    return model;
  });

  app.post("/v1/messages/count_tokens", async (req: any, reply: any) => {
    const {messages, tools, system, model} = req.body;
    const tokenizerService = (app as any)._server!.tokenizerService as TokenizerService;

    // If model is specified in "providerName,modelName" format, use the configured tokenizer
    if (model && model.includes(",") && tokenizerService) {
      try {
        const [provider, modelName] = model.split(",");
        req.log?.info(`Looking up tokenizer for provider: ${provider}, model: ${modelName}`);

        const tokenizerConfig = tokenizerService.getTokenizerConfigForModel(provider, modelName);

        if (!tokenizerConfig) {
          req.log?.warn(`No tokenizer config found for ${provider},${modelName}, using default tiktoken`);
        } else {
          req.log?.info(`Using tokenizer config: ${JSON.stringify(tokenizerConfig)}`);
        }

        const result = await tokenizerService.countTokens(
          { messages, system, tools },
          tokenizerConfig
        );

        return {
          "input_tokens": result.tokenCount,
          "tokenizer": result.tokenizerUsed,
        };
      } catch (error: any) {
        req.log?.error(`Error using configured tokenizer: ${error.message}`);
        req.log?.error(error.stack);
        // Fall back to default calculation
      }
    } else {
      if (!model) {
        req.log?.info(`No model specified, using default tiktoken`);
      } else if (!model.includes(",")) {
        req.log?.info(`Model "${model}" does not contain comma, using default tiktoken`);
      } else if (!tokenizerService) {
        req.log?.warn(`TokenizerService not available, using default tiktoken`);
      }
    }

    // Default to tiktoken calculation
    const tokenCount = calculateTokenCount(messages, system, tools);
    return { "input_tokens": tokenCount }
  });

  // Return raw (un-interpolated) config so that $VAR placeholders survive UI round-trips.
  // The runtime path (readConfigFile) still interpolates env vars for actual request processing.
  app.get("/api/config", async (req: any, reply: any) => {
    return await readConfigFileRaw();
  });

  app.get("/api/transformers", async (req: any, reply: any) => {
    const transformers =
      (app as any)._server!.transformerService.getAllTransformers();
    const transformerList = Array.from(transformers.entries()).map(
      ([name, transformer]: any) => ({
        name,
        endpoint: transformer.endPoint || null,
      })
    );
    return { transformers: transformerList };
  });

  // Add endpoint to save config.json with access control
  app.post("/api/config", async (req: any, reply: any) => {
    const newConfig = req.body;

    // Backup existing config file if it exists
    const backupPath = await backupConfigFile();
    if (backupPath) {
      console.log(`Backed up existing configuration file to ${backupPath}`);
    }

    await writeConfigFile(newConfig);
    let projectTakeoverSync: Awaited<ReturnType<typeof syncGlobalProjectTakeovers>> | undefined;
    try {
      projectTakeoverSync = await syncGlobalProjectTakeovers(newConfig);
      if (projectTakeoverSync.failed.length > 0) {
        app.log?.warn?.(
          { projectTakeoverSync },
          "Config saved but some global project takeovers failed to sync"
        );
      }
    } catch (syncError: any) {
      app.log?.warn?.(`Config saved but global project takeover sync failed: ${syncError?.message || syncError}`);
    }
    try {
      const coreServer = (app as any)._server;
      if (coreServer?.configService) {
        coreServer.configService.reload();
        const nextProviders = newConfig?.Providers || newConfig?.providers;
        if (Array.isArray(nextProviders)) {
          coreServer.configService.set('providers', nextProviders);
        }
        if (ProviderService && coreServer.transformerService) {
          coreServer.providerService = new ProviderService(
            coreServer.configService,
            coreServer.transformerService,
            app.log
          );
        }

        // Prune health entries for models/providers removed by this save, so a
        // renamed model can't leave a stale "failed" state behind in the UI.
        reconcileHealthStore(newConfig, app.log);

        if (startActiveProbe && resetActiveProbeService) {
          try {
            resetActiveProbeService();
          } catch {}

          const probeConfig = {
            enabled: coreServer.configService.get('ACTIVE_PROBE_ENABLED') ?? true,
            quotaProbeIntervalMinutes: coreServer.configService.get('QUOTA_PROBE_INTERVAL_MINUTES') ?? 10,
            probeTimeoutMs: coreServer.configService.get('PROBE_TIMEOUT_MS') ?? 15000,
            initialDelayMs: coreServer.configService.get('PROBE_INITIAL_DELAY_MS') ?? 5000,
            excludeProviders: coreServer.configService.get('EXCLUDE_PROBE_PROVIDERS') ?? [],
          };

          coreServer.activeProbeService = startActiveProbe(
            () => coreServer.providerService.getProviders(),
            probeConfig,
            () => coreServer.configService.getHttpsProxy(),
            app.log,
            (key: string) => coreServer.configService.get(key)
          );
        }
      }
    } catch (reloadError: any) {
      app.log?.warn?.(`Config saved but runtime reload failed: ${reloadError?.message || reloadError}`);
    }
    return { success: true, message: "Config saved successfully", projectTakeoverSync };
  });

  // ========== Client Integrations API ==========

  app.get("/api/clients", async (_req: any, reply: any) => {
    try {
      const config = await readConfigFile();
      return { clients: listClientStatuses(config) };
    } catch (error: any) {
      console.error("Failed to get client integrations:", error);
      reply.status(500).send({ error: error.message || "Failed to get client integrations" });
    }
  });

  app.post("/api/clients/apply", async (req: any, reply: any) => {
    try {
      const body = req.body as { enabled?: string[] };
      const enabled = Array.isArray(body?.enabled) ? body.enabled : [];
      const config = await readConfigFile();
      const result = applyClientSelection(config, enabled);
      await writeConfigFile(result.config);
      return result;
    } catch (error: any) {
      console.error("Failed to apply client integrations:", error);
      reply.status(500).send({ error: error.message || "Failed to apply client integrations" });
    }
  });

  async function runClientAction(req: any, reply: any, action: "enable" | "disable" | "restore") {
    try {
      const { id } = req.params as { id: string };
      if (!isClientId(id)) {
        reply.status(404).send({ error: `Unknown client: ${id}` });
        return;
      }

      const config = await readConfigFile();
      const result =
        action === "enable"
          ? enableClient(config, id)
          : action === "restore"
            ? restoreClient(config, id)
            : disableClient(config, id);
      await writeConfigFile(config);

      return {
        success: result.success,
        result,
        results: [result],
        clients: listClientStatuses(config),
        config,
      };
    } catch (error: any) {
      console.error(`Failed to ${action} client integration:`, error);
      reply.status(500).send({ error: error.message || `Failed to ${action} client integration` });
    }
  }

  app.post("/api/clients/:id/enable", async (req: any, reply: any) => {
    return runClientAction(req, reply, "enable");
  });

  app.post("/api/clients/:id/disable", async (req: any, reply: any) => {
    return runClientAction(req, reply, "disable");
  });

  app.post("/api/clients/:id/restore", async (req: any, reply: any) => {
    return runClientAction(req, reply, "restore");
  });

  app.get("/api/clients/codex/accounts", async (_req: any, reply: any) => {
    try {
      const config = await readConfigFile();
      return await computeCodexAccountUsage(config);
    } catch (error: any) {
      console.error("Failed to get Codex accounts:", error);
      reply.status(500).send({ error: error.message || "Failed to get Codex accounts" });
    }
  });

  app.post("/api/clients/codex/accounts/import-current", async (req: any, reply: any) => {
    try {
      const body = req.body as { label?: string };
      const config = await readConfigFile();
      const result = importCurrentCodexAccount(config, body?.label);
      await writeConfigFile(result.config);
      const accounts = await computeCodexAccountUsage(result.config);
      return { ...result, ...accounts };
    } catch (error: any) {
      console.error("Failed to import current Codex account:", error);
      reply.status(500).send({ error: error.message || "Failed to import current Codex account" });
    }
  });

  app.post("/api/clients/codex/accounts/import-rt", async (req: any, reply: any) => {
    try {
      const body = req.body as { label?: string; refreshToken?: string };
      const config = await readConfigFile();
      const result = await importCodexAccountFromRefreshToken(config, body?.refreshToken || "", body?.label);
      await writeConfigFile(result.config);
      const accounts = await computeCodexAccountUsage(result.config);
      return { ...result, ...accounts };
    } catch (error: any) {
      console.error("Failed to import Codex account from refresh token:", error);
      reply.status(500).send({ error: error.message || "Failed to import Codex account from refresh token" });
    }
  });

  app.post("/api/clients/codex/accounts/:accountId/activate", async (req: any, reply: any) => {
    try {
      const { accountId } = req.params as { accountId: string };
      const config = await readConfigFile();
      const result = activateCodexAccount(config, accountId);
      await writeConfigFile(result.config);
      const accounts = await computeCodexAccountUsage(result.config);
      return { ...result, ...accounts };
    } catch (error: any) {
      console.error("Failed to activate Codex account:", error);
      reply.status(500).send({ error: error.message || "Failed to activate Codex account" });
    }
  });

  app.post("/api/clients/codex/accounts/:accountId/export-rt", async (req: any, reply: any) => {
    try {
      const { accountId } = req.params as { accountId: string };
      const config = await readConfigFile();
      return exportCodexRefreshToken(config, accountId);
    } catch (error: any) {
      console.error("Failed to export Codex refresh token:", error);
      reply.status(500).send({ error: error.message || "Failed to export Codex refresh token" });
    }
  });

  app.post("/api/clients/codex/accounts/export-rt", async (_req: any, reply: any) => {
    try {
      const config = await readConfigFile();
      return exportCodexRefreshToken(config);
    } catch (error: any) {
      console.error("Failed to export active Codex refresh token:", error);
      reply.status(500).send({ error: error.message || "Failed to export active Codex refresh token" });
    }
  });

  app.delete("/api/clients/codex/accounts/:accountId", async (req: any, reply: any) => {
    try {
      const { accountId } = req.params as { accountId: string };
      const config = await readConfigFile();
      const result = deleteCodexAccount(config, accountId);
      await writeConfigFile(result.config);
      const accounts = await computeCodexAccountUsage(result.config);
      return { ...result, ...accounts };
    } catch (error: any) {
      console.error("Failed to delete Codex account:", error);
      reply.status(500).send({ error: error.message || "Failed to delete Codex account" });
    }
  });

  // ========== Project-Level Configuration API ==========

  app.get("/api/projects", async (_req: any, reply: any) => {
    try {
      const projects = await listProjectConfigs();
      const projectsWithTakeover = await Promise.all(
        projects.map(async (project) => {
          const ccrTakeoverClients = await getProjectTakeoverClients(project.path);
          return {
            ...project,
            ccrTakeoverClients,
            ccrTakeover: ccrTakeoverClients.length > 0,
          };
        })
      );
      return { projects: projectsWithTakeover };
    } catch (error: any) {
      console.error("Failed to list project configs:", error);
      reply.status(500).send({ error: error.message || "Failed to list project configs" });
    }
  });

  app.post("/api/projects", async (req: any, reply: any) => {
    try {
      const { path: rawPath } = req.body || {};
      if (!rawPath || typeof rawPath !== "string" || !isAbsolute(rawPath)) {
        reply.status(400).send({ error: "A valid absolute project path is required" });
        return;
      }

      const projectPath = normalize(rawPath).replace(/[\\/]+$/, "") || rawPath;

      const existing = await readProjectConfig(projectPath);
      if (existing) {
        reply.status(409).send({ error: "Project is already configured" });
        return;
      }

      await writeProjectConfig(projectPath, { Router: {} });

      // New projects default to "ccr takeover (Claude Code) + follow global
      // router": leave the project Router empty (so routing falls back to the
      // global config) and immediately take over the project's
      // `.claude/settings.local.json`, so its Claude Code CLI works through ccr
      // without `ccr code`. Other clients (e.g. pi) can be added afterwards from
      // the UI. Takeover failures (e.g. an unwritable project path) must not
      // fail the add itself, so the returned set reflects the actual state.
      try {
        const config = await readConfigFile();
        await setProjectTakeover(projectPath, ["claudeCode"], config);
      } catch (takeoverError) {
        console.error("Failed to auto-enable ccr takeover for new project:", takeoverError);
      }

      const ccrTakeoverClients = await getProjectTakeoverClients(projectPath);
      return {
        id: getClaudeProjectId(projectPath),
        path: projectPath,
        configPath: getProjectConfigPath(projectPath),
        Router: {},
        ccrTakeoverClients,
        ccrTakeover: ccrTakeoverClients.length > 0,
      };
    } catch (error: any) {
      console.error("Failed to add project config:", error);
      reply.status(500).send({ error: error.message || "Failed to add project config" });
    }
  });

  app.put("/api/projects/:id", async (req: any, reply: any) => {
    try {
      const { id } = req.params as { id: string };
      const { Router } = req.body || {};
      if (!Router || typeof Router !== "object") {
        reply.status(400).send({ error: "Router must be an object" });
        return;
      }

      const existing = await readProjectConfigById(id);
      if (!existing) {
        reply.status(404).send({ error: "Project config not found" });
        return;
      }

      await writeProjectConfig(existing.path, { Router });
      const usesGlobalRouter = Object.keys(Router).length === 0;
      if (usesGlobalRouter) {
        const config = await readConfigFile();
        await refreshProjectTakeovers(existing.path, config);
      }
      const ccrTakeoverClients = await getProjectTakeoverClients(existing.path);
      return {
        id,
        path: existing.path,
        configPath: existing.configPath,
        Router,
        ccrTakeoverClients,
        ccrTakeover: ccrTakeoverClients.length > 0,
      };
    } catch (error: any) {
      console.error("Failed to update project config:", error);
      reply.status(500).send({ error: error.message || "Failed to update project config" });
    }
  });

  app.put("/api/projects/:id/takeover", async (req: any, reply: any) => {
    try {
      const { id } = req.params as { id: string };
      const body = req.body || {};

      // Preferred: an explicit list of clients to take over. Legacy callers may
      // still send `enabled: boolean` (true = Claude Code only, false = none).
      // Only Claude Code is taken over by default: the other clients write
      // config files into the project root (e.g. opencode.json), which users
      // must opt into explicitly via the clients array.
      let clients: ClientId[];
      if (Array.isArray(body.clients)) {
        clients = body.clients.filter(isProjectTakeoverClient);
      } else if (typeof body.enabled === "boolean") {
        clients = body.enabled ? ["claudeCode"] : [];
      } else {
        reply.status(400).send({ error: "clients (array) or enabled (boolean) is required" });
        return;
      }

      const existing = await readProjectConfigById(id);
      if (!existing) {
        reply.status(404).send({ error: "Project config not found" });
        return;
      }

      const config = await readConfigFile();
      const ccrTakeoverClients = await setProjectTakeover(existing.path, clients, config);

      return {
        id,
        path: existing.path,
        ccrTakeoverClients,
        ccrTakeover: ccrTakeoverClients.length > 0,
      };
    } catch (error: any) {
      console.error("Failed to update ccr takeover status:", error);
      reply.status(500).send({ error: error.message || "Failed to update ccr takeover status" });
    }
  });

  app.delete("/api/projects/:id", async (req: any, reply: any) => {
    try {
      const { id } = req.params as { id: string };
      const existing = await readProjectConfigById(id);
      if (!existing) {
        reply.status(404).send({ error: "Project config not found" });
        return;
      }

      // Adding a project auto-enables ccr takeover, which writes ccr-managed
      // fields into the project's client config files (e.g.
      // `.claude/settings.local.json`, `.pi/settings.json`). Removing the
      // project config dir alone would leave those behind, so disable takeover
      // for every supported client first. Failures must not block the delete.
      try {
        const config = await readConfigFile();
        await setProjectTakeover(existing.path, [], config);
      } catch (takeoverError) {
        console.error("Failed to remove ccr takeover while deleting project:", takeoverError);
      }

      await deleteProjectConfig(existing.path);
      return { success: true };
    } catch (error: any) {
      console.error("Failed to delete project config:", error);
      reply.status(500).send({ error: error.message || "Failed to delete project config" });
    }
  });

  // Register static file serving with caching
  app.register(fastifyStatic, {
    root: join(__dirname, "..", "dist"),
    prefix: "/ui/",
    maxAge: "1h",
  });

  // Redirect /ui to /ui/ for proper static file serving
  app.get("/ui", async (_: any, reply: any) => {
    return reply.redirect("/ui/");
  });

  // Get log file list endpoint
  app.get("/api/logs/files", async (req: any, reply: any) => {
    try {
      const logDir = join(homedir(), ".claude-code-router", "logs");
      const logFiles: Array<{ name: string; path: string; size: number; lastModified: string }> = [];

      if (existsSync(logDir)) {
        const files = readdirSync(logDir);

        for (const file of files) {
          if (file.endsWith('.log')) {
            const filePath = join(logDir, file);
            const stats = statSync(filePath);

            logFiles.push({
              name: file,
              path: filePath,
              size: stats.size,
              lastModified: stats.mtime.toISOString()
            });
          }
        }

        // Sort by modification time in descending order
        logFiles.sort((a, b) => new Date(b.lastModified).getTime() - new Date(a.lastModified).getTime());
      }

      return logFiles;
    } catch (error) {
      console.error("Failed to get log files:", error);
      reply.status(500).send({ error: "Failed to get log files" });
    }
  });

  // Get log content endpoint
  app.get("/api/logs", async (req: any, reply: any) => {
    try {
      const filePath = (req.query as any).file as string;
      let logFilePath: string;

      if (filePath) {
        // If file path is specified, use the specified path
        logFilePath = filePath;
      } else {
        // If file path is not specified, use default log file path
        logFilePath = join(homedir(), ".claude-code-router", "logs", "app.log");
      }

      if (!existsSync(logFilePath)) {
        return [];
      }

      const logContent = readFileSync(logFilePath, 'utf8');
      const logLines = logContent.split('\n').filter(line => line.trim())

      return logLines;
    } catch (error) {
      console.error("Failed to get logs:", error);
      reply.status(500).send({ error: "Failed to get logs" });
    }
  });

  // Clear log content endpoint
  app.delete("/api/logs", async (req: any, reply: any) => {
    try {
      const filePath = (req.query as any).file as string;
      let logFilePath: string;

      if (filePath) {
        // If file path is specified, use the specified path
        logFilePath = filePath;
      } else {
        // If file path is not specified, use default log file path
        logFilePath = join(homedir(), ".claude-code-router", "logs", "app.log");
      }

      if (existsSync(logFilePath)) {
        writeFileSync(logFilePath, '', 'utf8');
      }

      return { success: true, message: "Logs cleared successfully" };
    } catch (error) {
      console.error("Failed to clear logs:", error);
      reply.status(500).send({ error: "Failed to clear logs" });
    }
  });

  // ========== Debug Log Toggle ==========

  // Get debug log status
  app.get("/api/debug-log", async () => {
    return { enabled: getRuntimeDebugLog() };
  });

  // Toggle debug log on/off
  app.put("/api/debug-log", async (req: any) => {
    const { enabled } = req.body as { enabled: boolean };
    setRuntimeDebugLog(enabled);
    return { enabled: getRuntimeDebugLog() };
  });

  // ========== Usage Statistics API ==========

  // Get usage records with summary
  app.get("/api/usage", async (req: any, reply: any) => {
    try {
      const q = req.query as any;
      const result = queryUsage({
        startTime: q.startDate,
        endTime: q.endDate,
        model: q.model,
        provider: q.provider,
        scenario: q.scenario,
        clientType: q.clientType,
        sessionId: q.sessionId,
        status: q.status,
        page: q.page ? parseInt(q.page, 10) : undefined,
        pageSize: q.pageSize ? parseInt(q.pageSize, 10) : undefined,
      });
      return result;
    } catch (error) {
      console.error("Failed to query usage:", error);
      reply.status(500).send({ error: "Failed to query usage" });
    }
  });

  // Get usage summary only
  app.get("/api/usage/summary", async (req: any, reply: any) => {
    try {
      const q = req.query as any;
      return queryUsageSummary(q.startDate, q.endDate, q.status);
    } catch (error) {
      console.error("Failed to query usage summary:", error);
      reply.status(500).send({ error: "Failed to query usage summary" });
    }
  });

  // Clear usage data
  app.delete("/api/usage", async (req: any, reply: any) => {
    try {
      const q = req.query as any;
      clearUsage(q.beforeDate);
      return { success: true, message: q.beforeDate ? "Usage data cleared before " + q.beforeDate : "All usage data cleared" };
    } catch (error) {
      console.error("Failed to clear usage:", error);
      reply.status(500).send({ error: "Failed to clear usage data" });
    }
  });

  // ========== Provider Quota & Health API ==========

  // Get provider health status
  app.get("/api/providers/health", async (req: any, reply: any) => {
    try {
      const healthStore = getHealthStore();
      const states = healthStore.getAllStates();
      return {
        states: states.map((s: any) => ({
          provider: s.provider,
          model: s.model,
          status: s.status,
          failureCount: s.failureCount,
          successCount: s.successCount,
          lastFailureTime: s.lastFailureTime,
          lastError: s.lastError,
          rateLimitUntil: s.rateLimitUntil ?? null,
        })),
        timestamp: new Date().toISOString()
      };
    } catch (error) {
      console.error("Failed to get provider health:", error);
      reply.status(500).send({ error: "Failed to get provider health" });
    }
  });

  app.post("/api/providers/probe", async (req: any, reply: any) => {
    try {
      const { providerName } = req.body as { providerName?: string };
      if (!providerName) {
        reply.status(400);
        return { error: "providerName is required" };
      }

      const coreServer = (app as any)._server;
      const probeService = coreServer?.activeProbeService;
      if (!probeService?.probeProviderManually) {
        reply.status(503);
        return { error: "Active probe service is not available" };
      }

      const success = await probeService.probeProviderManually(providerName);
      if (success) {
        // Endpoint reachable: clear every breaker for this provider, including
        // orphaned entries for renamed/removed model names that a per-model
        // recover would miss (the root cause of stuck "failed" UI states).
        clearProviderHealth(providerName, (req as any).log);
      }

      return {
        provider: providerName,
        success,
        timestamp: new Date().toISOString(),
      };
    } catch (error: any) {
      console.error("Failed to probe provider:", error);
      reply.status(500).send({ error: error.message || "Failed to probe provider" });
    }
  });

  app.post("/api/providers/probe-all", async (_req: any, reply: any) => {
    try {
      const coreServer = (app as any)._server;
      const probeService = coreServer?.activeProbeService;
      if (!probeService?.probeProviderManually) {
        reply.status(503);
        return { error: "Active probe service is not available" };
      }

      const providers = (coreServer?.providerService?.getProviders?.() || [])
        .filter((provider: any) => provider?.name && provider.enabled !== false);
      const results = await Promise.all(providers.map(async (provider: any) => {
        const success = await probeService.probeProviderManually(provider.name);
        if (success) {
          // See single-provider probe above: clear all breakers for a reachable
          // provider, not just its currently-configured models.
          clearProviderHealth(provider.name, (_req as any)?.log);
        }
        return { provider: provider.name, success };
      }));

      return {
        results,
        successCount: results.filter((result: any) => result.success).length,
        total: results.length,
        timestamp: new Date().toISOString(),
      };
    } catch (error: any) {
      console.error("Failed to probe all providers:", error);
      reply.status(500).send({ error: error.message || "Failed to probe all providers" });
    }
  });

  // Get provider quota usage (5h and 7d windows)
  app.get("/api/providers/quota", async (req: any, reply: any) => {
    try {
      const config = await readConfigFile();
      const providers = config.Providers || [];
      const quotas = computeProviderQuota(providers);
      const quotaMap = new Map<string, ProviderQuotaUsage>(
        quotas.map(quota => [quota.provider, quota])
      );

      // Merge rate limit info from upstream response headers (e.g. Kimi/Moonshot, Groq).
      const rateLimits = getAllRateLimitInfo();
      for (const quota of quotas) {
        const rl = rateLimits.find(r => r.provider === quota.provider);
        if (rl && rl.limit != null) {
          quota.limit5h = rl.limit;
          quota.used5h = rl.limit - (rl.remaining ?? 0);
          if (rl.reset) {
            quota.reset5h = new Date(rl.reset * 1000).toISOString();
          }
        }
      }

      // Merge active quota adapter results while preserving the UI response shape.
      const activeQuotaResults = getAllQuotaResults();
      for (const stored of activeQuotaResults) {
        let quota = quotaMap.get(stored.provider);
        if (!quota) {
          quota = {
            provider: stored.provider,
            used5h: 0,
            used7d: 0,
          };
          quotas.push(quota);
          quotaMap.set(stored.provider, quota);
        }

        if (typeof stored.totalBalance === 'number') {
          quota.limit7d = stored.totalBalance;
          // Only treat as currency balance when a currency is explicitly set;
          // otherwise display as percentage (e.g. token-quota weekly limits).
          quota.type7d = stored.currency ? 'balance' : 'rateLimit';
          if (stored.currency) {
            quota.currency = stored.currency;
          }
          // For balance type, used7d represents spending from the balance
          // If no usedBalance/remainingBalance breakdown, set to 0 (all balance available)
          if (typeof stored.usedBalance === 'number') {
            quota.used7d = stored.usedBalance;
          } else if (typeof stored.remainingBalance === 'number') {
            quota.used7d = Math.max(0, stored.totalBalance - stored.remainingBalance);
          } else {
            // Only total balance known — treat it as remaining balance
            quota.used7d = 0;
            quota.limit7d = stored.totalBalance;
          }
        } else if (typeof stored.usedBalance === 'number') {
          quota.used7d = stored.usedBalance;
        }

        if (typeof stored.usedDailyBalance === 'number') {
          quota.used5h = stored.usedDailyBalance;
          quota.type5h = 'rateLimit';
        }

        // limitDaily maps to the 5h slot limit (used by TIME_LIMIT/TOKENS_LIMIT adapters)
        if (typeof stored.limitDaily === 'number') {
          quota.limit5h = stored.limitDaily;
          quota.type5h = 'rateLimit';
        }

        if (typeof stored.resetTime === 'string') {
          if (stored.limitDaily !== undefined) {
            quota.reset5h = stored.resetTime;
          } else {
            quota.reset7d = stored.resetTime;
          }
        }

        if (typeof stored.resetTime7d === 'string') {
          quota.reset7d = stored.resetTime7d;
        }
      }

      return {
        quotas,
        timestamp: new Date().toISOString(),
      };
    } catch (error) {
      console.error("Failed to compute provider quota:", error);
      reply.status(500).send({ error: "Failed to compute provider quota" });
    }
  });

  // Get presets list
  app.get("/api/presets", async (req: any, reply: any) => {
    try {
      const presetsDir = join(HOME_DIR, "presets");

      if (!existsSync(presetsDir)) {
        return { presets: [] };
      }

      const entries = readdirSync(presetsDir, { withFileTypes: true });
      const presetDirs = entries.filter(e => e.isDirectory() && !e.name.startsWith('.')).map(e => e.name);

      const presets: Array<PresetMetadata & { installed: boolean; id: string }> = [];

      for (const dirName of presetDirs) {
        const presetDir = join(presetsDir, dirName);
        try {
          const manifestPath = join(presetDir, "manifest.json");
          const content = readFileSync(manifestPath, 'utf-8');
          const manifest = JSON.parse(content);

          // Extract metadata fields
          const { Providers, Router, PORT, HOST, API_TIMEOUT_MS, PROXY_URL, LOG, LOG_LEVEL, StatusLine, NON_INTERACTIVE_MODE, ...metadata } = manifest;

          presets.push({
            id: dirName,  // Use directory name as unique identifier
            name: metadata.name || dirName,
            version: metadata.version || '1.0.0',
            description: metadata.description,
            author: metadata.author,
            homepage: metadata.homepage,
            repository: metadata.repository,
            license: metadata.license,
            keywords: metadata.keywords,
            ccrVersion: metadata.ccrVersion,
            source: metadata.source,
            sourceType: metadata.sourceType,
            checksum: metadata.checksum,
            installed: true,
          });
        } catch (error) {
          console.error(`Failed to read preset ${dirName}:`, error);
        }
      }

      return { presets };
    } catch (error) {
      console.error("Failed to get presets:", error);
      reply.status(500).send({ error: "Failed to get presets" });
    }
  });

  // Get preset details
  app.get("/api/presets/:name", async (req: any, reply: any) => {
    try {
      const { name } = req.params;
      const presetDir = getPresetDir(name);

      if (!existsSync(presetDir)) {
        reply.status(404).send({ error: "Preset not found" });
        return;
      }

      const manifest = await readManifestFromDir(presetDir);
      const presetFile = manifestToPresetFile(manifest);

      // Return preset info, config uses the applied userValues configuration
      return {
        ...presetFile,
        config: loadConfigFromManifest(manifest, presetDir),
        userValues: manifest.userValues || {},
      };
    } catch (error: any) {
      console.error("Failed to get preset:", error);
      reply.status(500).send({ error: error.message || "Failed to get preset" });
    }
  });

  // Apply preset (configure sensitive information)
  app.post("/api/presets/:name/apply", async (req: any, reply: any) => {
    try {
      const { name } = req.params;
      const { secrets } = req.body;

      const presetDir = getPresetDir(name);

      if (!existsSync(presetDir)) {
        reply.status(404).send({ error: "Preset not found" });
        return;
      }

      // Read existing manifest
      const manifest = await readManifestFromDir(presetDir);

      // Save user input to userValues (keep original config unchanged)
      const updatedManifest: ManifestFile = { ...manifest };

      // Save or update userValues
      if (secrets && Object.keys(secrets).length > 0) {
        updatedManifest.userValues = {
          ...updatedManifest.userValues,
          ...secrets,
        };
      }

      // Save updated manifest
      await saveManifest(name, updatedManifest);

      return { success: true, message: "Preset applied successfully" };
    } catch (error: any) {
      console.error("Failed to apply preset:", error);
      reply.status(500).send({ error: error.message || "Failed to apply preset" });
    }
  });

  // Delete preset
  app.delete("/api/presets/:name", async (req: any, reply: any) => {
    try {
      const { name } = req.params;
      const presetDir = getPresetDir(name);

      if (!existsSync(presetDir)) {
        reply.status(404).send({ error: "Preset not found" });
        return;
      }

      // Recursively delete entire directory
      rmSync(presetDir, { recursive: true, force: true });

      return { success: true, message: "Preset deleted successfully" };
    } catch (error: any) {
      console.error("Failed to delete preset:", error);
      reply.status(500).send({ error: error.message || "Failed to delete preset" });
    }
  });

  // Get preset market list
  app.get("/api/presets/market", async (req: any, reply: any) => {
    try {
      // Use market presets function
      const marketPresets = await getMarketPresets();
      return { presets: marketPresets };
    } catch (error: any) {
      console.error("Failed to get market presets:", error);
      reply.status(500).send({ error: error.message || "Failed to get market presets" });
    }
  });

  // Install preset from GitHub repository by preset name
  app.post("/api/presets/install/github", async (req: any, reply: any) => {
    try {
      const { presetName } = req.body;

      if (!presetName) {
        reply.status(400).send({ error: "Preset name is required" });
        return;
      }

      // Check if preset is in the marketplace
      const marketPreset = await findMarketPresetByName(presetName);
      if (!marketPreset) {
        reply.status(400).send({
          error: "Preset not found in marketplace",
          message: `Preset '${presetName}' is not available in the official marketplace. Please check the available presets.`
        });
        return;
      }

      // Get repository from market preset
      if (!marketPreset.repo) {
        reply.status(400).send({
          error: "Invalid preset data",
          message: `Preset '${presetName}' does not have repository information`
        });
        return;
      }

      // Parse GitHub repository URL
      const githubRepoMatch = marketPreset.repo.match(/(?:github\.com[:/]|^)([^/]+)\/([^/\s#]+?)(?:\.git)?$/);
      if (!githubRepoMatch) {
        reply.status(400).send({ error: "Invalid GitHub repository URL" });
        return;
      }

      const [, owner, repoName] = githubRepoMatch;

      // Use preset name from market
      const installedPresetName = marketPreset.name || presetName;

      // Check if already installed BEFORE downloading
      if (await isPresetInstalled(installedPresetName)) {
        reply.status(409).send({
          error: "Preset already installed",
          message: `Preset '${installedPresetName}' is already installed. To update or reconfigure, please delete it first using the delete button.`,
          presetName: installedPresetName
        });
        return;
      }

      // Download GitHub repository ZIP file
      const downloadUrl = `https://github.com/${owner}/${repoName}/archive/refs/heads/main.zip`;
      const tempFile = await downloadPresetToTemp(downloadUrl);

      // Load preset to validate structure
      const preset = await loadPresetFromZip(tempFile);

      // Double-check if already installed (in case of race condition)
      if (await isPresetInstalled(installedPresetName)) {
        unlinkSync(tempFile);
        reply.status(409).send({
          error: "Preset already installed",
          message: `Preset '${installedPresetName}' was installed while downloading. Please try again.`,
          presetName: installedPresetName
        });
        return;
      }

      // Extract to target directory
      const targetDir = getPresetDir(installedPresetName);
      await extractPreset(tempFile, targetDir);

      // Read manifest and add repo information
      const manifest = await readManifestFromDir(targetDir);

      // Add repo information to manifest from market data
      manifest.repository = marketPreset.repo;
      if (marketPreset.url) {
        manifest.source = marketPreset.url;
      }

      // Save updated manifest
      await saveManifest(installedPresetName, manifest);

      // Clean up temp file
      unlinkSync(tempFile);

      return {
        success: true,
        presetName: installedPresetName,
        preset: {
          ...preset.metadata,
          installed: true,
        }
      };
    } catch (error: any) {
      console.error("Failed to install preset from GitHub:", error);
      reply.status(500).send({ error: error.message || "Failed to install preset from GitHub" });
    }
  });

  // Helper function: Load preset from ZIP
  async function loadPresetFromZip(zipFile: string): Promise<PresetFile> {
    const zip = new AdmZip(zipFile);

    // First try to find manifest.json in root directory
    let entry = zip.getEntry('manifest.json');

    // If not in root, try to find in subdirectories (handle GitHub repo archive structure)
    if (!entry) {
      const entries = zip.getEntries();
      // Find any manifest.json file
      entry = entries.find(e => e.entryName.includes('manifest.json')) || null;
    }

    if (!entry) {
      throw new Error('Invalid preset file: manifest.json not found');
    }

    const manifest = JSON.parse(entry.getData().toString('utf-8')) as ManifestFile;
    return manifestToPresetFile(manifest);
  }

  return server;
};
