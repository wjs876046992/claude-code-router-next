declare module "@wengine-ai/llms" {
  import { FastifyInstance } from "fastify";
  import { FastifyBaseLogger } from "fastify";

  export interface ServerConfig {
    jsonPath?: string;
    initialConfig?: any;
    logger?: any;
  }

  /**
   * Plugin configuration from config file
   */
  export interface PluginConfig {
    name: string;
    enabled?: boolean;
    options?: Record<string, any>;
  }

  export interface Server {
    app: FastifyInstance;
    logger: FastifyBaseLogger;
    start(): Promise<void>;
  }

  const Server: {
    new (config: ServerConfig): Server;
  };

  export default Server;

  // Export cache
  export interface Usage {
    input_tokens: number;
    output_tokens: number;
  }

  export const sessionUsageCache: any;

  // Export router
  export interface RouterContext {
    configService: any;
    event?: any;
  }

  export const router: (req: any, res: any, context: RouterContext) => Promise<void>;

  // Export utilities
  export const calculateTokenCount: (messages: any[], system: any, tools: any[]) => number;
  export const searchProjectBySession: (sessionId: string) => Promise<string | null>;

  // Export rate limit info captured from upstream provider response headers
  export interface RateLimitInfo {
    provider: string;
    remaining: number | null;
    limit: number | null;
    reset: number | null;
    capturedAt: number;
  }

  export const getAllRateLimitInfo: () => RateLimitInfo[];
  export const getRateLimitInfo: (providerName: string) => RateLimitInfo | undefined;

  // Active probe configuration
  export interface ActiveProbeConfig {
    enabled?: boolean;
    quotaProbeIntervalMinutes?: number;
    probeTimeoutMs?: number;
    initialDelayMs?: number;
    excludeProviders?: string[];
  }

  export interface LLMProvider {
    name: string;
    baseUrl: string;
    apiKey: string;
    models: string[];
    transformer?: any;
  }

  export interface ProviderQuotaResult {
    totalBalance?: number;
    usedBalance?: number;
    remainingBalance?: number;
    usedDailyBalance?: number;
    limitDaily?: number;
    currency?: string;
    resetTime?: string;
    resetTime7d?: string;
  }

  export interface StoredQuotaResult extends ProviderQuotaResult {
    provider: string;
    capturedAt: number;
  }

  export interface QuotaAdapter {
    queryQuota(
      provider: LLMProvider,
      timeoutMs: number,
      proxyUrl?: string
    ): Promise<ProviderQuotaResult | null>;
  }

  export const getQuotaAdapter: (baseUrl: string) => QuotaAdapter | null;
  export const storeQuotaResult: (providerName: string, result: ProviderQuotaResult) => void;
  export const getQuotaResult: (providerName: string) => StoredQuotaResult | undefined;
  export const getAllQuotaResults: () => StoredQuotaResult[];

  // Active probe service for health/quota probing
  export class ActiveProbeService {
    start(): void;
    stop(): void;
    probeProviderManually(providerName: string): Promise<boolean>;
  }

  export const getActiveProbeService: (
    getProviders: () => LLMProvider[],
    config?: ActiveProbeConfig,
    getHttpsProxy?: () => string | undefined,
    logger?: any
  ) => ActiveProbeService;

  export const startActiveProbe: (
    getProviders: () => LLMProvider[],
    config?: ActiveProbeConfig,
    getHttpsProxy?: () => string | undefined,
    logger?: any
  ) => ActiveProbeService;

  export const stopActiveProbe: () => void;
  export const resetActiveProbeService: () => void;

  // Runtime debug log toggle
  export const setRuntimeDebugLog: (enabled: boolean) => void;
  export const getRuntimeDebugLog: () => boolean;

  // Export services
  export class ConfigService {
    constructor(options?: any);
    get<T = any>(key: string): T | undefined;
    get<T = any>(key: string, defaultValue: T): T;
    getAll(): any;
    has(key: string): boolean;
    set(key: string, value: any): void;
    reload(): void;
  }

  export class ProviderService {
    constructor(configService: any, transformerService: any, logger: any);
  }

  export class TransformerService {
    constructor(configService: any, logger: any);
    initialize(): Promise<void>;
  }

  // Tokenizer types
  export type TokenizerType = 'tiktoken' | 'huggingface' | 'api';
  export type ApiRequestFormat = 'standard' | 'openai' | 'anthropic' | 'custom';

  export interface TokenizerConfig {
    type: TokenizerType;
    encoding?: string;
    model?: string;
    url?: string;
    apiKey?: string;
    requestFormat?: ApiRequestFormat;
    responseField?: string;
    headers?: Record<string, string>;
    fallback?: TokenizerType;
  }

  export interface TokenizeRequest {
    messages: Array<{
      role: string;
      content: string | Array<{
        type: string;
        text?: string;
        input?: any;
        content?: string | any;
      }>;
    }>;
    system?: string | Array<{
      type: string;
      text?: string | string[];
    }>;
    tools?: Array<{
      name: string;
      description?: string;
      input_schema: object;
    }>;
  }

  export interface TokenizerResult {
    tokenCount: number;
    tokenizerUsed: string;
    cached: boolean;
  }

  export class TokenizerService {
    countTokens(request: TokenizeRequest, config?: TokenizerConfig): Promise<TokenizerResult>;
    getTokenizerConfigForModel(providerName: string, modelName: string): TokenizerConfig | undefined;
    clearCache(): void;
    dispose(): void;
  }

  // Token speed statistics types
  export interface TokenStats {
    requestId: string;
    startTime: number;
    firstTokenTime?: number;
    lastTokenTime: number;
    tokenCount: number;
    tokensPerSecond: number;
    timeToFirstToken?: number;
    contentBlocks: {
      index: number;
      tokenCount: number;
      speed: number;
    }[];
  }

  export function getTokenSpeedStats(): {
    current: TokenStats | null;
    global: {
      totalRequests: number;
      totalTokens: number;
      totalTime: number;
      avgTokensPerSecond: number;
      minTokensPerSecond: number;
      maxTokensPerSecond: number;
      avgTimeToFirstToken: number;
      allSpeeds: number[];
    };
    lastUpdate: number;
  };

  export function getGlobalTokenSpeedStats(): {
    totalRequests: number;
    totalTokens: number;
    totalTime: number;
    avgTokensPerSecond: number;
    minTokensPerSecond: number;
    maxTokensPerSecond: number;
    avgTimeToFirstToken: number;
    allSpeeds: number[];
  };
}
