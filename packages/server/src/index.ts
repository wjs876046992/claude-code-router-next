import { existsSync, readFileSync } from "fs";
import { writeFile } from "fs/promises";
import { homedir } from "os";
import { join } from "path";
import { initConfig, initDir, readConfigFile, writeConfigFile } from "./utils";
import { createServer } from "./server";
import { apiKeyAuth } from "./middleware/auth";
import {
  CONFIG_FILE,
  HOME_DIR,
  getActiveCodexAccount,
  listCodexAccounts,
  listPresets,
  markActiveCodexAccountLimitedAndSwitch,
} from "@wengine-ai/claude-code-router-shared";
import { createStream } from 'rotating-file-stream';
import { sessionUsageCache } from "@wengine-ai/llms";
const _healthModule = require("@wengine-ai/llms") as any;
const getHealthStore: () => any = _healthModule.getHealthStore;
import { SSEParserTransform } from "./utils/SSEParser.transform";
import { SSESerializerTransform } from "./utils/SSESerializer.transform";
import { rewriteStream } from "./utils/rewriteStream";
import JSON5 from "json5";
import { IAgent, ITool } from "./agents/type";
import agentsManager from "./agents";
import { EventEmitter } from "node:events";
import { performance } from "node:perf_hooks";
import { pluginManager, tokenSpeedPlugin } from "@wengine-ai/llms";
import { append as appendUsage, readTokenSpeedStats } from "./services/usage-store";

const event = new EventEmitter()

function getUsageSessionId(req: any): string {
  if (req.usageSessionId) return req.usageSessionId;

  // Try to extract from metadata.user_id first (same as token-speed plugin)
  try {
    const userId = req.body?.metadata?.user_id;
    if (userId && typeof userId === 'string') {
      // Try JSON format first: {"session_id":"xxx"}
      try {
        const parsed = JSON.parse(userId);
        if (parsed.session_id) {
          req.usageSessionId = parsed.session_id;
          return req.usageSessionId;
        }
      } catch {
        // Fallback to legacy format: user_..._session_xxx
        const match = userId.match(/_session_([a-f0-9-]+)/i);
        if (match) {
          req.usageSessionId = match[1];
          return req.usageSessionId;
        }
      }
    }
  } catch {}

  const requestIdHeader = req.headers?.["x-request-id"];
  const requestId = Array.isArray(requestIdHeader) ? requestIdHeader[0] : requestIdHeader;
  req.usageSessionId = req.sessionId || (typeof requestId === "string" ? requestId : undefined) || req.id || `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  return req.usageSessionId;
}

function getRequestModel(req: any): string {
  // Prefer req.body.model (routed model) over req.model (pre-routing model)
  if (req.body?.model) {
    if (Array.isArray(req.body.model)) return req.body.model.join(",");
    return req.body.model;
  }
  if (Array.isArray(req.model)) return req.model.join(",");
  return req.model || "";
}

function detectClientType(req: any): string {
  const pathname: string = req.pathname || "";
  const headers = req.headers || {};

  // Check for explicit client identification headers
  // Claude Code sends "x-anthropic-billing-header" containing "cc_version="
  const billingHeader = headers["x-anthropic-billing-header"];
  if (typeof billingHeader === "string" && billingHeader.includes("cc_version=")) {
    return "claude-code";
  }

  // Check User-Agent for known client signatures
  const userAgent = headers["user-agent"] || "";
  if (typeof userAgent === "string") {
    if (userAgent.includes("claude-cli") || userAgent.includes("Claude-CLI")) return "claude-code";
    if (userAgent.includes("codex") || userAgent.includes("Codex")) return "codex";
  }

  // Fallback: infer from endpoint path and model name
  // Codex uses the Responses API endpoint
  if (pathname.endsWith("/v1/responses")) return "codex";
  const originalModel = (req.originalModel || req.body?.model || "");
  // Claude Code sends ccr-opus/sonnet/haiku model family names
  if (/^ccr-(opus|sonnet|haiku)(\[1m\])?$/i.test(originalModel)) return "claude-code";
  // Legacy Codex installs may still send ccr-codex as their model alias
  if (originalModel.toLowerCase() === "ccr-codex") return "codex";
  // Direct /v1/messages call without ccr- prefix → generic API
  if (pathname.endsWith("/v1/messages")) return "api";
  return "unknown";
}

function isRateLimitMessage(statusCode: number, message?: string): boolean {
  return statusCode === 429 ||
    Boolean(message && /rate[\s_]limit|too many|限流|频率限制|qps_limit|token_limit|quota exhausted|usage limit|limit reached/i.test(message));
}

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

async function switchCodexAccountBeforeUsageLimit(): Promise<void> {
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

async function switchCodexAccountAfterRateLimit(reason?: string): Promise<void> {
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

function extractUsageFromPayload(payload: any): any | undefined {
  if (!payload) return undefined;

  let body = payload;
  if (Buffer.isBuffer(payload)) {
    body = payload.toString("utf8");
  }
  if (typeof body === "string") {
    try {
      body = JSON.parse(body);
    } catch {
      return undefined;
    }
  }

  if (typeof body !== "object") return undefined;

  // Anthropic /v1/messages non-stream response.
  if (body.usage) return body.usage;

  // OpenAI Responses-style non-stream response.
  if (body.response?.usage) {
    const usage = body.response.usage;
    return {
      input_tokens: usage.input_tokens || 0,
      output_tokens: usage.output_tokens || 0,
      cache_read_input_tokens: usage.cache_read_input_tokens || 0,
      cache_creation_input_tokens: usage.cache_creation_input_tokens || 0,
    };
  }

  return undefined;
}

async function initializeClaudeConfig() {
  const homeDir = homedir();
  const configPath = join(homeDir, ".claude.json");
  if (!existsSync(configPath)) {
    const userID = Array.from(
      { length: 64 },
      () => Math.random().toString(16)[2]
    ).join("");
    const configContent = {
      numStartups: 184,
      autoUpdaterStatus: "enabled",
      userID,
      hasCompletedOnboarding: true,
      lastOnboardingVersion: "1.0.17",
      projects: {},
    };
    await writeFile(configPath, JSON.stringify(configContent, null, 2));
  }
}

interface RunOptions {
  port?: number;
  logger?: any;
}

/**
 * Plugin configuration from config file
 */
interface PluginConfig {
  name: string;
  enabled?: boolean;
  options?: Record<string, any>;
}

/**
 * Register plugins from configuration
 * @param serverInstance Server instance
 * @param config Application configuration
 */
async function registerPluginsFromConfig(serverInstance: any, config: any): Promise<void> {
  // Get plugins configuration from config file
  const pluginsConfig: PluginConfig[] = config.plugins || config.Plugins || [];

  for (const pluginConfig of pluginsConfig) {
      const { name, enabled = false, options = {} } = pluginConfig;

      switch (name) {
        case 'token-speed':
          pluginManager.registerPlugin(tokenSpeedPlugin, {
            enabled,
            outputHandlers: [
              {
                type: 'temp-file',
                enabled: true
              }
            ],
            ...options
          });
          break;

        default:
          console.warn(`Unknown plugin: ${name}`);
          break;
      }
    }
  // Enable all registered plugins
  await pluginManager.enablePlugins(serverInstance);
}

async function getServer(options: RunOptions = {}) {
  await initializeClaudeConfig();
  await initDir();
  const config = await initConfig();

  // Check if Providers is configured
  const providers = config.Providers || config.providers || [];
  const hasProviders = providers && providers.length > 0;

  let HOST = config.HOST || "127.0.0.1";

  if (hasProviders) {
    HOST = config.HOST;
    if (!config.APIKEY) {
      HOST = "127.0.0.1";
    }
  } else {
    // When no providers are configured, listen on 0.0.0.0 without authentication
    HOST = "0.0.0.0";
    console.log("ℹ️  No providers configured. Listening on 0.0.0.0 without authentication.");
  }

  const port = config.PORT || 3456;

  // Use port from environment variable if set (for background process)
  const servicePort = process.env.SERVICE_PORT
    ? parseInt(process.env.SERVICE_PORT)
    : port;

  // Configure logger based on config settings or external options
  const pad = (num: number) => (num > 9 ? "" : "0") + num;
  const generator = (time: number | Date | undefined, index: number | undefined) => {
    let date: Date;
    if (!time) {
      date = new Date();
    } else if (typeof time === 'number') {
      date = new Date(time);
    } else {
      date = time;
    }

    const month = date.getFullYear() + "" + pad(date.getMonth() + 1);
    const day = pad(date.getDate());
    const hour = pad(date.getHours());
    const minute = pad(date.getMinutes());

    return `./logs/ccr-${month}${day}${hour}${minute}${pad(date.getSeconds())}${index ? `_${index}` : ''}.log`;
  };

  let loggerConfig: any;

  // Use external logger configuration if provided
  if (options.logger !== undefined) {
    loggerConfig = options.logger;
  } else {
    // Enable logger if not provided and config.LOG !== false
    if (config.LOG !== false) {
      // Set config.LOG to true (if not already set)
      if (config.LOG === undefined) {
        config.LOG = true;
      }
      loggerConfig = {
        level: config.LOG_LEVEL || "debug",
        stream: createStream(generator, {
          path: HOME_DIR,
          maxFiles: 3,
          interval: "1d",
          compress: false,
          maxSize: "50M"
        }),
      };
    } else {
      loggerConfig = false;
    }
  }

  const presets = await listPresets();

  const serverInstance = await createServer({
    jsonPath: CONFIG_FILE,
    initialConfig: {
      // ...config,
      providers: config.Providers || config.providers,
      HOST: HOST,
      PORT: servicePort,
      LOG_FILE: join(
        homedir(),
        ".claude-code-router",
        "claude-code-router.log"
      ),
    },
    logger: loggerConfig,
  });

  // Set up usage recording callback for fallback failures in core
  serverInstance.recordUsage = (data: any) => {
    try {
      const clientType = data.req ? detectClientType(data.req) : "unknown";
      if (clientType === "codex" && isRateLimitMessage(0, data.errorMessage)) {
        void switchCodexAccountAfterRateLimit(data.errorMessage);
      }
      appendUsage({
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        timestamp: new Date().toISOString(),
        sessionId: data.sessionId || "",
        provider: data.provider || "",
        originalModel: data.originalModel || "",
        model: data.model || "",
        modelFamily: data.modelFamily || "",
        scenarioType: data.scenarioType || "default",
        clientType,
        codexAccountId: data.req?.codexAccountId,
        codexAccountEmail: data.req?.codexAccountEmail,
        stream: data.stream ?? false,
        inputTokens: data.inputTokens || 0,
        outputTokens: 0,
        cacheReadInputTokens: data.cacheReadInputTokens || 0,
        cacheCreationInputTokens: data.cacheCreationInputTokens || 0,
        ttft: null,
        tokensPerSecond: null,
        durationMs: 0,
        status: "error",
        errorMessage: data.errorMessage,
        responseBody: undefined,
      });
    } catch (e) {
      // Usage tracking must not affect the response
      console.error("Fallback usage tracking error:", e);
    }
  };

  await Promise.allSettled(
      presets.map(async preset => await serverInstance.registerNamespace(`/preset/${preset.name}`, preset.config))
  )

  // Register and configure plugins from config
  await registerPluginsFromConfig(serverInstance, config);

  serverInstance.addHook("onRequest", async (req: any) => {
    const url = new URL(`http://127.0.0.1${req.url}`);
    if ((url.pathname.endsWith("/v1/messages") || url.pathname.endsWith("/v1/responses")) && !req.requestStartTime) {
      req.requestStartTime = performance.now();
    }
  });

  // Clear stale usage from previous requests in the same session AFTER router runs
  // Router reads lastMessageUsage for longContext threshold, so clearing must happen AFTER that
  // This ensures any usage recorded in onResponse belongs to THIS request, not leaked from previous ones
  serverInstance.addHook("preHandler", async (req: any, reply: any) => {
    const url = new URL(`http://127.0.0.1${req.url}`);
    if (url.pathname.endsWith("/v1/messages") || url.pathname.endsWith("/v1/responses")) {
      const usageSessionId = getUsageSessionId(req);
      sessionUsageCache.put(usageSessionId, { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 });
    }
  });

  // Add async preHandler hook for authentication
  serverInstance.addHook("preHandler", async (req: any, reply: any) => {
    return new Promise<void>((resolve, reject) => {
      const done = (err?: Error) => {
        if (err) reject(err);
        else resolve();
      };
      // Call the async auth function
      apiKeyAuth(config)(req, reply, done).catch(reject);
    });
  });
  serverInstance.addHook("preHandler", async (req: any, reply: any) => {
    const url = new URL(`http://127.0.0.1${req.url}`);
    req.pathname = url.pathname;
    if (req.pathname.endsWith("/v1/messages") && req.pathname !== "/v1/messages") {
      req.preset = req.pathname.replace("/v1/messages", "").replace("/", "");
    }
    if (req.pathname.endsWith("/v1/responses") && req.pathname !== "/v1/responses") {
      req.preset = req.pathname.replace("/v1/responses", "").replace("/", "");
    }
    if ((req.pathname.endsWith("/v1/messages") || req.pathname.endsWith("/v1/responses")) && detectClientType(req) === "codex") {
      await switchCodexAccountBeforeUsageLimit();
      const account = await getCurrentCodexAccountForUsage();
      req.codexAccountId = account.id;
      req.codexAccountEmail = account.email;
    }
  })

  serverInstance.addHook("preHandler", async (req: any, reply: any) => {
    if (req.pathname.endsWith("/v1/messages")) {
      const useAgents = []

      for (const agent of agentsManager.getAllAgents()) {
        if (agent.shouldHandle(req, config)) {
          // Set agent identifier
          useAgents.push(agent.name)

          // change request body
          agent.reqHandler(req, config);

          // append agent tools
          if (agent.tools.size) {
            if (!req.body?.tools?.length) {
              req.body.tools = []
            }
            req.body.tools.unshift(...Array.from(agent.tools.values()).map(item => {
              return {
                name: item.name,
                description: item.description,
                input_schema: item.input_schema
              }
            }))
          }
        }
      }

      if (useAgents.length) {
        req.agents = useAgents;
      }
    }
  });
  serverInstance.addHook("onError", async (request: any, reply: any, error: any) => {
    request.errorMessage = error?.message || error?.toString?.() || "Unknown error";
    event.emit('onError', request, reply, error);
  })
  serverInstance.addHook("onSend", (req: any, reply: any, payload: any, done: any) => {
    const isMessages = req.pathname?.endsWith("/v1/messages");
    const isResponses = req.pathname?.endsWith("/v1/responses");
    if (isMessages || isResponses) {
      const usageSessionId = getUsageSessionId(req);
      if (payload instanceof ReadableStream) {
        // /v1/responses doesn't have agents — skip that branch
        if (isMessages && req.agents) {
          const abortController = new AbortController();
          const eventStream = payload.pipeThrough(new SSEParserTransform())
          let currentAgent: undefined | IAgent;
          let currentToolIndex = -1
          let currentToolName = ''
          let currentToolArgs = ''
          let currentToolId = ''
          const toolMessages: any[] = []
          const assistantMessages: any[] = []
          // Store Anthropic format message body, distinguishing text and tool types
          return done(null, rewriteStream(eventStream, async (data, controller) => {
            try {
              // Detect tool call start
              if (data.event === 'content_block_start' && data?.data?.content_block?.name) {
                const agent = req.agents.find((name: string) => agentsManager.getAgent(name)?.tools.get(data.data.content_block.name))
                if (agent) {
                  currentAgent = agentsManager.getAgent(agent)
                  currentToolIndex = data.data.index
                  currentToolName = data.data.content_block.name
                  currentToolId = data.data.content_block.id
                  return undefined;
                }
              }

              // Collect tool arguments
              if (currentToolIndex > -1 && data.data.index === currentToolIndex && data.data?.delta?.type === 'input_json_delta') {
                currentToolArgs += data.data?.delta?.partial_json;
                return undefined;
              }

              // Tool call completed, handle agent invocation
              if (currentToolIndex > -1 && data.data.index === currentToolIndex && data.data.type === 'content_block_stop') {
                try {
                  const args = JSON5.parse(currentToolArgs);
                  assistantMessages.push({
                    type: "tool_use",
                    id: currentToolId,
                    name: currentToolName,
                    input: args
                  })
                  const toolResult = await currentAgent?.tools.get(currentToolName)?.handler(args, {
                    req,
                    config
                  });
                  toolMessages.push({
                    "tool_use_id": currentToolId,
                    "type": "tool_result",
                    "content": toolResult
                  })
                  currentAgent = undefined
                  currentToolIndex = -1
                  currentToolName = ''
                  currentToolArgs = ''
                  currentToolId = ''
                } catch (e) {
                  console.log(e);
                }
                return undefined;
              }

              if (data.event === 'message_delta' && toolMessages.length) {
                req.body.messages.push({
                  role: 'assistant',
                  content: assistantMessages
                })
                req.body.messages.push({
                  role: 'user',
                  content: toolMessages
                })
                const response = await fetch(`http://127.0.0.1:${config.PORT || 3456}/v1/messages`, {
                  method: "POST",
                  headers: {
                    'x-api-key': config.APIKEY,
                    'content-type': 'application/json',
                  },
                  body: JSON.stringify(req.body),
                })
                if (!response.ok) {
                  return undefined;
                }
                const stream = response.body!.pipeThrough(new SSEParserTransform() as any)
                const reader = stream.getReader()
                while (true) {
                  try {
                    const {value, done} = await reader.read();
                    if (done) {
                      break;
                    }
                    const eventData = value as any;
                    if (['message_start', 'message_stop'].includes(eventData.event)) {
                      continue
                    }

                    // Check if stream is still writable
                    if (!controller.desiredSize) {
                      break;
                    }

                    controller.enqueue(eventData)
                  }catch (readError: any) {
                    if (readError.name === 'AbortError' || readError.code === 'ERR_STREAM_PREMATURE_CLOSE') {
                      abortController.abort(); // Abort all related operations
                      break;
                    }
                    throw readError;
                  }

                }
                return undefined
              }
              return data
            }catch (error: any) {
              console.error('Unexpected error in stream processing:', error);

              // Handle premature stream closure error
              if (error.code === 'ERR_STREAM_PREMATURE_CLOSE') {
                abortController.abort();
                return undefined;
              }

              // Re-throw other errors
              throw error;
            }
          }).pipeThrough(new SSESerializerTransform()))
        }

        const [originalStream, clonedStream] = payload.tee();
        const read = async (stream: ReadableStream) => {
          const eventStream = stream
            .pipeThrough(new TextDecoderStream())
            .pipeThrough(new SSEParserTransform() as any);
          const reader = eventStream.getReader();
          try {
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              const event = (value as any).event;
              const data = (value as any).data;

              // Capture usage from Anthropic SSE (message_delta, message_start)
              if (data?.usage) {
                const existingUsage = sessionUsageCache.get(usageSessionId) || {};
                // Reset cache on message_start to avoid stale fields from previous requests
                // (e.g. cache_creation_input_tokens carried over from a different model)
                const base = event === 'message_start' ? {} : existingUsage;
                const mergedUsage = { ...base, ...data.usage };

                // Belt-and-suspenders: some Anthropic-compatible providers (e.g. GLM)
                // may embed OpenAI-style <= cached_tokens inside the SSE usage
                // object even on the /v1/messages path.
                if (data.usage?.prompt_tokens_details?.cached_tokens && !data.usage.cache_read_input_tokens) {
                  mergedUsage.cache_read_input_tokens = data.usage.prompt_tokens_details.cached_tokens;
                }

                // Debug log for cache tokens
                if (data.usage.cache_read_input_tokens || data.usage.cache_creation_input_tokens) {
                  console.log('[Usage] Cache tokens:', {
                    cache_read: data.usage.cache_read_input_tokens,
                    cache_creation: data.usage.cache_creation_input_tokens
                  });
                }
                sessionUsageCache.put(usageSessionId, mergedUsage);
              }

              // Capture usage from Responses API SSE (response.completed)
              // The Responses API format has usage nested under response.usage
              if (data?.response?.usage) {
                const respUsage = data.response.usage;
                // Reset base on a fresh response.completed to prevent stale fields
                // from a previous request leaking into the new one (same as the
                // message_start sentinel used in the Anthropic path above).
                const existingUsage = event === 'response.completed'
                  ? {} : (sessionUsageCache.get(usageSessionId) || {});
                const mergedUsage = {
                  ...existingUsage,
                  input_tokens: respUsage.input_tokens || 0,
                  output_tokens: respUsage.output_tokens || 0,
                  cache_read_input_tokens: respUsage.cache_read_input_tokens ?? existingUsage.cache_read_input_tokens ?? 0,
                  cache_creation_input_tokens: respUsage.cache_creation_input_tokens ?? existingUsage.cache_creation_input_tokens ?? 0,
                };
                sessionUsageCache.put(usageSessionId, mergedUsage);
              }
            }
          } catch (readError: any) {
            if (readError.name === 'AbortError' || readError.code === 'ERR_STREAM_PREMATURE_CLOSE') {
              console.error('Background read stream closed prematurely');
            } else {
              console.error('Error in background stream reading:', readError);
            }
          } finally {
            reader.releaseLock();
          }
        }
        read(clonedStream);
        return done(null, originalStream)
      }
      const nonStreamUsage = extractUsageFromPayload(payload);
      if (nonStreamUsage) {
        sessionUsageCache.put(usageSessionId, nonStreamUsage);
      }
      if (typeof payload ==='object') {
        if (payload.error) {
          return done(payload.error, null)
        } else {
          return done(payload, null)
        }
      }
    }
    if (typeof payload ==='object' && payload.error) {
      return done(payload.error, null)
    }
    done(null, payload)
  });
  serverInstance.addHook("onSend", async (req: any, reply: any, payload: any) => {
    event.emit('onSend', req, reply, payload);
    // Capture error response body for usage stats
    if (reply.statusCode >= 400 && (req.pathname?.endsWith("/v1/messages") || req.pathname?.endsWith("/v1/responses"))) {
      try {
        if (typeof payload === 'string') {
          req.errorResponseBody = payload;
        } else if (payload && typeof payload === 'object') {
          req.errorResponseBody = JSON.stringify(payload);
        }
      } catch (e) {
        // Ignore serialization errors
      }
    }
    return payload;
  });

  // Track per-request usage statistics
  serverInstance.addHook("onResponse", async (req: any, reply: any) => {
    if (!req.pathname?.endsWith("/v1/messages") && !req.pathname?.endsWith("/v1/responses")) return;

    try {
      const sessionId = getUsageSessionId(req);
      const usage = sessionUsageCache.get(sessionId);
      const speedStats = readTokenSpeedStats(sessionId);
      const healthStore = getHealthStore();

      // Extract error message if request failed
      let errorMessage: string | undefined;
      let errorResponseBody: string | undefined;
      // Check for SSE stream error (errors inside HTTP 200 response)
      const sseError = req.sseError;
      const hasSseError = sseError && (sseError.type || sseError.code || sseError.message);
      const hasOutputTokens = usage?.output_tokens && usage.output_tokens > 0;
      const isFailedRequest = reply.statusCode >= 400 || (hasSseError && !hasOutputTokens);
      if (isFailedRequest) {
        errorMessage = req.errorMessage || reply.errorMessage || (req.error?.message || req.error?.toString?.() || undefined);
        if (hasSseError) {
          errorMessage = errorMessage || JSON.stringify(sseError);
          errorResponseBody = JSON.stringify(sseError);
        }
        errorResponseBody = errorResponseBody || req.errorResponseBody;
        // Record failure to health store
        const model = getRequestModel(req);
        // Classify rate-limit errors — use markRateLimited to immediately isolate
        // (bypasses the 3-failure threshold) with a time-based auto-recover.
        const isRateLimit = isRateLimitMessage(reply.statusCode, errorMessage);
        if (isRateLimit) {
          healthStore.markRateLimited(req.provider || "", model, 120, errorMessage);
          if (detectClientType(req) === "codex") {
            await switchCodexAccountAfterRateLimit(errorMessage);
          }
        } else {
          healthStore.recordFailure(req.provider || "", model, errorMessage);
        }
      } else {
        // Record success to health store
        const model = getRequestModel(req);
        healthStore.recordSuccess(req.provider || "", model);
      }

      // Compute cache read input tokens.
      // Anthropic-compatible providers that don't expose cache_read_input_tokens
      // (e.g. GLM/Zhipu /v1/messages) still report net input_tokens after cache
      // deduction, so we infer the cache hit from the difference between the
      // pre-cache tokenCount (computed by the router) and the reported input_tokens.
      let cacheReadInputTokens = usage?.cache_read_input_tokens ?? 0;
      const rawInputTokens = usage?.input_tokens ?? req.tokenCount ?? 0;
      if (!cacheReadInputTokens && req.tokenCount && usage?.input_tokens && usage.input_tokens < req.tokenCount) {
        cacheReadInputTokens = req.tokenCount - usage.input_tokens;
        if (cacheReadInputTokens) {
          console.log('[Usage] Inferred cache tokens:', {
            tokenCount: req.tokenCount,
            netInput: usage.input_tokens,
            impliedCache: cacheReadInputTokens,
          });
        }
      }

      appendUsage({
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        timestamp: new Date().toISOString(),
        sessionId,
        provider: req.provider || "",
        originalModel: req.originalModel || req.body?.model || "",
        model: getRequestModel(req),
        modelFamily: req.modelFamily || "",
        scenarioType: req.scenarioType || "default",
        clientType: detectClientType(req),
        codexAccountId: req.codexAccountId,
        codexAccountEmail: req.codexAccountEmail,
        stream: req.body?.stream ?? false,
        inputTokens: rawInputTokens,
        outputTokens: isFailedRequest ? 0 : (usage?.output_tokens || 0),
        cacheReadInputTokens,
        cacheCreationInputTokens: usage?.cache_creation_input_tokens || 0,
        ttft: isFailedRequest ? null : speedStats.ttft,
        tokensPerSecond: isFailedRequest ? null : speedStats.tokensPerSecond,
        durationMs: req.requestStartTime
          ? Math.round(performance.now() - req.requestStartTime)
          : 0,
        status: isFailedRequest ? "error" : "success",
        errorMessage,
        responseBody: errorResponseBody,
      });
    } catch (e) {
      // Usage tracking must not affect the response
      console.error("Usage tracking error:", e);
    }
  });

  // Add global error handlers to prevent the service from crashing
  process.on("uncaughtException", (err) => {
    serverInstance.app.log.error("Uncaught exception:", err);
  });

  process.on("unhandledRejection", (reason, promise) => {
    serverInstance.app.log.error("Unhandled rejection at:", promise, "reason:", reason);
  });

  return serverInstance;
}

async function run() {
  const server = await getServer();
  server.app.post("/api/restart", async () => {
    setTimeout(async () => {
      process.exit(0);
    }, 100);

    return { success: true, message: "Service restart initiated" }
  });
  await server.start();
}

export { getServer };
export type { RunOptions };
export type { IAgent, ITool } from "./agents/type";
export { initDir, initConfig, readConfigFile, writeConfigFile, backupConfigFile } from "./utils";
export { pluginManager, tokenSpeedPlugin } from "@wengine-ai/llms";

// Start service if this file is run directly
if (require.main === module) {
  run().catch((error) => {
    console.error('Failed to start server:', error);
    process.exit(1);
  });
}
