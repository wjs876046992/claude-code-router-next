export interface ProviderTransformer {
  use: (string | (string | Record<string, unknown> | { max_tokens: number })[])[];
  [key: string]: any; // Allow for model-specific transformers
}

export interface Provider {
  name: string;
  api_base_url: string;
  api_key: string;
  models: string[];
  transformer?: ProviderTransformer;
  // Optional quota configuration for rate limiting display
  quota?: ProviderQuotaConfig;
  // Allow for additional custom fields
  [key: string]: any;
}

export const MODEL_FAMILIES = ["opus", "sonnet", "haiku"] as const;
export type ModelFamily = typeof MODEL_FAMILIES[number];

export interface ModelFamilyFallback {
    default?: string[];
    background?: string[];
    think?: string[];
    longContext?: string[];
    extendedContext?: string[];
    webSearch?: string[];
    image?: string[];
    [key: string]: string[] | undefined;
}

export interface ModelFamilyConfig {
    default: string;
    background?: string;
    think?: string;
    longContext?: string;
    longContextThreshold?: number;
    extendedContext?: string;
    enableExtendedContext?: boolean;
    webSearch?: string;
    image?: string;
    fallback?: ModelFamilyFallback;
}

export interface RouterConfig {
    default: string;
    background: string;
    think: string;
    longContext: string;
    longContextThreshold: number;
    extendedContext?: string;
    extendedContextThreshold?: number;
    webSearch: string;
    image: string;
    models?: Record<string, string>;
    families?: Record<string, ModelFamilyConfig>;
    custom?: any;
    [key: string]: any;
}

export interface Transformer {
    name?: string;
    path: string;
    options?: Record<string, any>;
}

export interface StatusLineModuleConfig {
  type: string;
  icon?: string;
  text: string;
  color?: string;
  background?: string;
  scriptPath?: string; // 用于script类型的模块，指定要执行的Node.js脚本文件路径
}

export interface StatusLineThemeConfig {
  modules: StatusLineModuleConfig[];
}

export interface StatusLineConfig {
  enabled: boolean;
  currentStyle: string;
  default: StatusLineThemeConfig;
  powerline: StatusLineThemeConfig;
  fontFamily?: string;
}

export interface FallbackConfig {
  default?: string[];
  background?: string[];
  think?: string[];
  longContext?: string[];
  webSearch?: string[];
  modelMapping?: string[];
  image?: string[];
  [key: string]: string[] | undefined;
}

export interface Config {
  Providers: Provider[];
  Router: RouterConfig;
  transformers: Transformer[];
  StatusLine?: StatusLineConfig;
  forceUseImageAgent?: boolean;
  fallback?: FallbackConfig;
  // Top-level settings
  LOG: boolean;
  LOG_LEVEL: string;
  CLAUDE_PATH: string;
  HOST: string;
  PORT: number;
  APIKEY: string;
  API_TIMEOUT_MS: string;
  PROXY_URL: string;
  CUSTOM_ROUTER_PATH?: string;
  // Allow extra fields from config file
  [key: string]: any;
}

export type AccessLevel = 'restricted' | 'full';

// Provider health status
export interface ProviderHealthState {
  provider: string;
  model: string;
  status: 'closed' | 'open' | 'half-open';
  failureCount: number;
  successCount: number;
  lastFailureTime: number;
  lastError?: string;
}

export interface ProviderHealthResponse {
  states: ProviderHealthState[];
  timestamp: string;
}

// Provider quota configuration (optional)
export interface ProviderQuotaConfig {
  // Token limit for last 5 hours window
  limit5h?: number;
  // Token limit for last 7 days window
  limit7d?: number;
}

// Provider quota usage response from server
export interface ProviderQuotaUsage {
  provider: string;
  used5h: number;
  used7d: number;
  limit5h?: number;
  limit7d?: number;
  reset5h?: string;
  reset7d?: string;
  /** Display type for the 5h slot */
  type5h?: 'rateLimit' | 'balance';
  /** Display type for the 7d slot */
  type7d?: 'rateLimit' | 'balance';
  /** Currency for balance display (e.g. "CNY", "USD") */
  currency?: string;
}

export interface ProviderQuotaResponse {
  quotas: ProviderQuotaUsage[];
  timestamp: string;
}
