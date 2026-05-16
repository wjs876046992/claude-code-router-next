import { existsSync } from "fs";
import { writeFile } from "fs/promises";
import { homedir } from "os";
import { join } from "path";
import { initConfig, initDir } from "./utils";
import { createServer } from "./server";
import { apiKeyAuth } from "./middleware/auth";
import { CONFIG_FILE, HOME_DIR, listPresets } from "@wengine-ai/claude-code-router-shared";
import { createStream } from 'rotating-file-stream';
import { sessionUsageCache } from "@wengine-ai/llms";
// Inline health store to avoid TypeScript declaration issues during build
// TODO: move to @wengine-ai/llms export once type declarations are properly generated
function getHealthStore() {
  // Simple singleton implementation for build-time compatibility
  const { ProviderHealthStore } = require("@wengine-ai/llms");
  const store = new ProviderHealthStore();
  return store;
}
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

  await Promise.allSettled(
      presets.map(async preset => await serverInstance.registerNamespace(`/preset/${preset.name}`, preset.config))
  )

  // Register and configure plugins from config
  await registerPluginsFromConfig(serverInstance, config);

  serverInstance.addHook("onRequest", async (req: any) => {
    const url = new URL(`http://127.0.0.1${req.url}`);
    if (url.pathname.endsWith("/v1/messages") && !req.requestStartTime) {
      req.requestStartTime = performance.now();
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
    if (req.pathname?.endsWith("/v1/messages")) {
      const usageSessionId = getUsageSessionId(req);
      if (payload instanceof ReadableStream) {
        if (req.agents) {
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
              // Capture usage from message_delta, message_start, or any event with usage
              if (data?.usage) {
                const existingUsage = sessionUsageCache.get(usageSessionId) || {};
                // Merge usage data, preserving all fields
                const mergedUsage = { ...existingUsage, ...data.usage };
                // Debug log for cache tokens
                if (data.usage.cache_read_input_tokens || data.usage.cache_creation_input_tokens) {
                  console.log('[Usage] Cache tokens:', {
                    cache_read: data.usage.cache_read_input_tokens,
                    cache_creation: data.usage.cache_creation_input_tokens
                  });
                }
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
      sessionUsageCache.put(usageSessionId, payload.usage);
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
    if (reply.statusCode >= 400 && req.pathname?.endsWith("/v1/messages")) {
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
    if (!req.pathname?.endsWith("/v1/messages")) return;

    try {
      const sessionId = getUsageSessionId(req);
      const usage = sessionUsageCache.get(sessionId);
      const speedStats = readTokenSpeedStats(sessionId);
      const healthStore = getHealthStore();

      // Extract error message if request failed
      let errorMessage: string | undefined;
      let errorResponseBody: string | undefined;
      if (reply.statusCode >= 400) {
        errorMessage = req.errorMessage || reply.errorMessage || (req.error?.message || req.error?.toString?.() || undefined);
        errorResponseBody = req.errorResponseBody;
        // Record failure to health store
        const model = getRequestModel(req);
        healthStore.recordFailure(req.provider || "", model, errorMessage);
      } else {
        // Record success to health store
        const model = getRequestModel(req);
        healthStore.recordSuccess(req.provider || "", model);
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
        stream: req.body?.stream ?? false,
        inputTokens: req.tokenCount || 0,
        outputTokens: usage?.output_tokens || 0,
        cacheReadInputTokens: usage?.cache_read_input_tokens || 0,
        cacheCreationInputTokens: usage?.cache_creation_input_tokens || 0,
        ttft: speedStats.ttft,
        tokensPerSecond: speedStats.tokensPerSecond,
        durationMs: req.requestStartTime
          ? Math.round(performance.now() - req.requestStartTime)
          : 0,
        status: reply.statusCode < 400 ? "success" : "error",
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
