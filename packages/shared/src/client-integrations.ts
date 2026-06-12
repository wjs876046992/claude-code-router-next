import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { HOME_DIR } from "./constants";

export const CLIENT_IDS = ["claudeCode", "codex"] as const;
export type ClientId = (typeof CLIENT_IDS)[number];
export type ClientAction = "enable" | "disable" | "restore";

export interface ClientConfig {
  enabled?: boolean;
  managed?: boolean;
  configPath?: string;
  modelAlias?: string;
  activeAccountId?: string;
  autoSwitchAccounts?: boolean;
  quota?: {
    limit5h?: number;
    limit7d?: number;
  };
}

export type ClientsConfig = Partial<Record<ClientId, ClientConfig>>;

export interface ClientStatus {
  id: ClientId;
  name: string;
  enabled: boolean;
  managed: boolean;
  configPath: string;
  exists: boolean;
  activeModel?: string;
  modelAlias?: string;
  details?: string;
}

export interface ClientOperationResult {
  id: ClientId;
  action: ClientAction;
  success: boolean;
  status?: ClientStatus;
  error?: string;
}

export interface ClientApplyResult {
  success: boolean;
  results: ClientOperationResult[];
  clients: ClientStatus[];
  config: Record<string, any>;
}

export interface CodexAccount {
  id: string;
  label: string;
  email?: string;
  plan?: string;
  accountId?: string;
  authMode?: string;
  active: boolean;
  createdAt: string;
  updatedAt: string;
  lastUsedAt?: string;
  limitedUntil?: string;
  limitedWindow?: "5h" | "7d" | "unknown";
  limitedReason?: string;
  lastLimitedAt?: string;
  usage?: {
    used5h: number;
    used7d: number;
    limit5h?: number;
    limit7d?: number;
    reset5h?: string;
    reset7d?: string;
  };
}

export interface CodexAccountsResult {
  accounts: CodexAccount[];
  activeAccountId?: string;
  authPath: string;
}

export interface CodexAccountOperationResult extends CodexAccountsResult {
  success: boolean;
  account?: CodexAccount;
  switchedAccount?: CodexAccount;
  config: Record<string, any>;
}

export interface CodexRefreshTokenExportResult {
  success: boolean;
  account: CodexAccount;
  refreshToken: string;
  refreshedAt?: string;
  source: "managed" | "current";
}

interface ClientDefinition {
  id: ClientId;
  name: string;
  defaultConfig: Required<ClientConfig>;
}

interface ClientOperationOptions {
  updateEnabled?: boolean;
}

interface ClientAdapter {
  status(config: Record<string, any>): ClientStatus;
  enable(config: Record<string, any>): ClientStatus;
  disable(config: Record<string, any>): ClientStatus;
  restore(config: Record<string, any>): ClientStatus;
}

const CLIENT_DEFINITIONS: Record<ClientId, ClientDefinition> = {
  claudeCode: {
    id: "claudeCode",
    name: "Claude Code",
    defaultConfig: {
      enabled: false,
      managed: false,
      configPath: "~/.claude/settings.json",
      modelAlias: "",
      activeAccountId: "",
      autoSwitchAccounts: true,
      quota: {},
    },
  },
  codex: {
    id: "codex",
    name: "Codex",
    defaultConfig: {
      enabled: false,
      managed: false,
      configPath: "~/.codex/config.toml",
      modelAlias: "ccr-opus",
      activeAccountId: "",
      autoSwitchAccounts: true,
      quota: {},
    },
  },
};

const CLIENT_BACKUP_DIR = path.join(HOME_DIR, "backups", "clients");
const CODEX_ACCOUNTS_DIR = path.join(HOME_DIR, "codex-accounts");
const CODEX_ACCOUNTS_INDEX_PATH = path.join(CODEX_ACCOUNTS_DIR, "accounts.json");
const CODEX_OAUTH_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const CODEX_OAUTH_TOKEN_URL = "https://auth.openai.com/oauth/token";
const LEGACY_STATUSLINE_BACKUP_PATH = path.join(HOME_DIR, ".statusline-backup.json");
const LEGACY_MODEL_BACKUP_PATH = path.join(HOME_DIR, ".model-env-backup.json");
const CLAUDE_MODEL_ENV_KEYS = [
  "ANTHROPIC_MODEL",
  "ANTHROPIC_DEFAULT_SONNET_MODEL",
  "ANTHROPIC_DEFAULT_OPUS_MODEL",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL",
  "ANTHROPIC_REASONING_MODEL",
];
const CLAUDE_AUTO_COMPACT_ENV = {
  CLAUDE_CODE_AUTO_COMPACT_WINDOW: "200000",
  CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: "90",
  CLAUDE_CODE_SIMPLE: "1",
};

function isObject(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function expandHome(filePath: string): string {
  if (filePath === "~") return os.homedir();
  if (filePath.startsWith("~/")) {
    return path.join(os.homedir(), filePath.slice(2));
  }
  return filePath;
}

function getClientDefinition(id: ClientId): ClientDefinition {
  return CLIENT_DEFINITIONS[id];
}

function getRawClientConfig(config: Record<string, any>, id: ClientId): ClientConfig {
  const clients = isObject(config.Clients) ? config.Clients : {};
  const value = clients[id];
  return isObject(value) ? value : {};
}

function hasFamiliesConfig(config: Record<string, any>): boolean {
  const families = config?.Router?.families;
  return isObject(families) && Object.keys(families).length > 0;
}

function getLegacyClaudeEnabled(config: Record<string, any>): boolean {
  return Boolean(config?.StatusLine?.enabled || hasFamiliesConfig(config));
}

export function getDefaultClientsConfig(): ClientsConfig {
  return {
    claudeCode: { ...CLIENT_DEFINITIONS.claudeCode.defaultConfig },
    codex: { ...CLIENT_DEFINITIONS.codex.defaultConfig },
  };
}

export function getClientConfig(config: Record<string, any>, id: ClientId): Required<ClientConfig> {
  const definition = getClientDefinition(id);
  const rawConfig = getRawClientConfig(config, id);
  const hasExplicitEnabled = typeof rawConfig.enabled === "boolean";
  const enabled =
    hasExplicitEnabled
      ? Boolean(rawConfig.enabled)
      : id === "claudeCode" && !isObject(config.Clients)
        ? getLegacyClaudeEnabled(config)
        : definition.defaultConfig.enabled;

  return {
    ...definition.defaultConfig,
    ...rawConfig,
    enabled,
    managed: Boolean(rawConfig.managed),
    configPath: rawConfig.configPath || definition.defaultConfig.configPath,
    modelAlias: rawConfig.modelAlias || definition.defaultConfig.modelAlias,
    activeAccountId: rawConfig.activeAccountId || definition.defaultConfig.activeAccountId,
  };
}

export function isClientId(value: string): value is ClientId {
  return (CLIENT_IDS as readonly string[]).includes(value);
}

export function isClientEnabled(config: Record<string, any>, id: ClientId): boolean {
  return getClientConfig(config, id).enabled;
}

function setClientConfig(
  config: Record<string, any>,
  id: ClientId,
  patch: Partial<ClientConfig>
): Required<ClientConfig> {
  const clients = isObject(config.Clients) ? { ...config.Clients } : {};
  const current = getClientConfig(config, id);
  const next = {
    ...current,
    ...patch,
  };
  clients[id] = next;
  config.Clients = clients;
  return next;
}

function getResolvedConfigPath(config: Record<string, any>, id: ClientId): string {
  return expandHome(getClientConfig(config, id).configPath);
}

function ensureParentDir(filePath: string): void {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function createBackup(clientId: string, filePath: string): string | null {
  if (!fs.existsSync(filePath)) return null;

  const backupDir = path.join(CLIENT_BACKUP_DIR, clientId);
  fs.mkdirSync(backupDir, { recursive: true });

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const ext = path.extname(filePath) || ".bak";
  const backupPath = path.join(backupDir, `${timestamp}${ext}`);
  fs.copyFileSync(filePath, backupPath);
  return backupPath;
}

function getLatestBackupPath(clientId: string): string | null {
  const backupDir = path.join(CLIENT_BACKUP_DIR, clientId);
  if (!fs.existsSync(backupDir)) return null;

  const files = fs
    .readdirSync(backupDir)
    .filter((file) => !file.startsWith("."))
    .sort();

  if (files.length === 0) return null;
  return path.join(backupDir, files[files.length - 1]);
}

function restoreLatestBackup(clientId: string, filePath: string): string | null {
  const backupPath = getLatestBackupPath(clientId);
  if (!backupPath) return null;

  ensureParentDir(filePath);
  fs.copyFileSync(backupPath, filePath);
  return backupPath;
}

function readJsonObject(filePath: string): Record<string, any> {
  if (!fs.existsSync(filePath)) return {};

  const raw = fs.readFileSync(filePath, "utf-8");
  if (!raw.trim()) return {};

  const parsed = JSON.parse(raw);
  return isObject(parsed) ? parsed : {};
}

function writeJsonObject(filePath: string, value: Record<string, any>): void {
  ensureParentDir(filePath);
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
}

function getCcrBaseUrl(config: Record<string, any>, suffix = ""): string {
  const port = config.PORT || 3456;
  return `http://127.0.0.1:${port}${suffix}`;
}

function isCcrBaseUrl(value: unknown): boolean {
  if (typeof value !== "string") return false;
  return /^https?:\/\/(127\.0\.0\.1|localhost):\d+(?:\/.*)?$/i.test(value.trim());
}

function hasExtendedContext(familyConfig: any): boolean {
  return familyConfig?.enableExtendedContext === true;
}

function applyClaudeModelFamilies(settings: Record<string, any>, config: Record<string, any>): void {
  if (!isObject(settings.env)) settings.env = {};

  for (const key of CLAUDE_MODEL_ENV_KEYS) {
    if (typeof settings.env[key] === "string" && settings.env[key].startsWith("ccr-")) {
      delete settings.env[key];
    }
  }

  if (!hasFamiliesConfig(config)) return;

  const families = config.Router.families;
  const familyNames = Object.keys(families);
  let primaryFamily: string | null = null;

  for (const family of familyNames) {
    const familyConfig = families[family];
    const extendedSuffix = hasExtendedContext(familyConfig) ? "[1m]" : "";
    const ccrModel = `ccr-${family}${extendedSuffix}`;

    switch (family) {
      case "opus":
        settings.env.ANTHROPIC_DEFAULT_OPUS_MODEL = ccrModel;
        if (!primaryFamily) primaryFamily = "opus";
        break;
      case "sonnet":
        settings.env.ANTHROPIC_DEFAULT_SONNET_MODEL = ccrModel;
        if (!primaryFamily) primaryFamily = "sonnet";
        break;
      case "haiku":
        settings.env.ANTHROPIC_DEFAULT_HAIKU_MODEL = ccrModel;
        if (!primaryFamily) primaryFamily = "haiku";
        break;
    }
  }

  const defaultFamily = families.opus ? "opus" : primaryFamily;
  if (defaultFamily) {
    const defaultConfig = families[defaultFamily];
    const extendedSuffix = hasExtendedContext(defaultConfig) ? "[1m]" : "";
    settings.env.ANTHROPIC_MODEL = `ccr-${defaultFamily}${extendedSuffix}`;
  }

  const thinkFamily = familyNames.find((family) => families[family]?.think);
  if (thinkFamily) {
    const thinkConfig = families[thinkFamily];
    const extendedSuffix = hasExtendedContext(thinkConfig) ? "[1m]" : "";
    settings.env.ANTHROPIC_REASONING_MODEL = `ccr-${thinkFamily}${extendedSuffix}`;
  } else if (primaryFamily) {
    const primaryConfig = families[primaryFamily];
    const extendedSuffix = hasExtendedContext(primaryConfig) ? "[1m]" : "";
    settings.env.ANTHROPIC_REASONING_MODEL = `ccr-${primaryFamily}${extendedSuffix}`;
  }
}

function applyClaudeAutoCompactSettings(settings: Record<string, any>): void {
  settings.autoCompactEnabled = true;
  if (!isObject(settings.env)) settings.env = {};
  if (settings.env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE === "0.8") {
    delete settings.env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE;
  }
  settings.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW = CLAUDE_AUTO_COMPACT_ENV.CLAUDE_CODE_AUTO_COMPACT_WINDOW;
  settings.env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE = CLAUDE_AUTO_COMPACT_ENV.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE;
}

function restoreLegacyClaudeBackups(settings: Record<string, any>): void {
  if (settings.statusLine?.command === "ccr statusline" && fs.existsSync(LEGACY_STATUSLINE_BACKUP_PATH)) {
    try {
      const backup = JSON.parse(fs.readFileSync(LEGACY_STATUSLINE_BACKUP_PATH, "utf-8"));
      settings.statusLine = backup;
      fs.unlinkSync(LEGACY_STATUSLINE_BACKUP_PATH);
    } catch {
      delete settings.statusLine;
    }
  }

  if (fs.existsSync(LEGACY_MODEL_BACKUP_PATH)) {
    try {
      const backup = JSON.parse(fs.readFileSync(LEGACY_MODEL_BACKUP_PATH, "utf-8"));
      if (!isObject(settings.env)) settings.env = {};
      for (const [key, value] of Object.entries(backup)) {
        settings.env[key] = value;
      }
      fs.unlinkSync(LEGACY_MODEL_BACKUP_PATH);
    } catch {
      // Fall through to managed field cleanup below.
    }
  }
}

function removeClaudeManagedFields(settings: Record<string, any>): void {
  restoreLegacyClaudeBackups(settings);

  if (isObject(settings.env)) {
    const baseUrlWasManaged = isCcrBaseUrl(settings.env.ANTHROPIC_BASE_URL);
    if (baseUrlWasManaged) {
      delete settings.env.ANTHROPIC_BASE_URL;
      delete settings.env.ANTHROPIC_AUTH_TOKEN;
    }

    for (const key of CLAUDE_MODEL_ENV_KEYS) {
      if (typeof settings.env[key] === "string" && settings.env[key].startsWith("ccr-")) {
        delete settings.env[key];
      }
    }

    if (Object.keys(settings.env).length === 0) {
      delete settings.env;
    }
  }

  if (settings.statusLine?.command === "ccr statusline") {
    delete settings.statusLine;
  }
}

function getClaudeActiveModel(settings: Record<string, any>): string | undefined {
  const env = isObject(settings.env) ? settings.env : {};
  return (
    env.ANTHROPIC_MODEL ||
    env.ANTHROPIC_DEFAULT_SONNET_MODEL ||
    env.ANTHROPIC_DEFAULT_OPUS_MODEL ||
    env.ANTHROPIC_DEFAULT_HAIKU_MODEL
  );
}

function isClaudeManaged(settings: Record<string, any>): boolean {
  const env = isObject(settings.env) ? settings.env : {};
  return Boolean(
    isCcrBaseUrl(env.ANTHROPIC_BASE_URL) ||
    CLAUDE_MODEL_ENV_KEYS.some((key) => typeof env[key] === "string" && env[key].startsWith("ccr-")) ||
    settings.statusLine?.command === "ccr statusline"
  );
}

function createClaudeStatus(config: Record<string, any>, settings?: Record<string, any>, details?: string): ClientStatus {
  const clientConfig = getClientConfig(config, "claudeCode");
  const filePath = getResolvedConfigPath(config, "claudeCode");
  const safeSettings = settings || {};

  return {
    id: "claudeCode",
    name: CLIENT_DEFINITIONS.claudeCode.name,
    enabled: clientConfig.enabled,
    managed: isClaudeManaged(safeSettings),
    configPath: clientConfig.configPath,
    exists: fs.existsSync(filePath),
    activeModel: getClaudeActiveModel(safeSettings),
    details,
  };
}

const claudeCodeAdapter: ClientAdapter = {
  status(config) {
    const filePath = getResolvedConfigPath(config, "claudeCode");
    try {
      return createClaudeStatus(config, readJsonObject(filePath));
    } catch (error) {
      return createClaudeStatus(config, {}, errorMessage(error));
    }
  },

  enable(config) {
    const filePath = getResolvedConfigPath(config, "claudeCode");
    const currentStatus = this.status(config);
    if (!currentStatus.managed) {
      createBackup("claudeCode", filePath);
    }

    const settings = readJsonObject(filePath);
    if (!isObject(settings.env)) settings.env = {};

    settings.env.ANTHROPIC_BASE_URL = getCcrBaseUrl(config);
    settings.env.ANTHROPIC_AUTH_TOKEN = config.APIKEY || "test";
    applyClaudeModelFamilies(settings, config);
    applyClaudeAutoCompactSettings(settings);

    if (config?.StatusLine?.enabled) {
      settings.statusLine = {
        type: "command",
        command: "ccr statusline",
        padding: 0,
      };
    } else if (settings.statusLine?.command === "ccr statusline") {
      delete settings.statusLine;
    }

    writeJsonObject(filePath, settings);
    return createClaudeStatus(config, settings);
  },

  disable(config) {
    const filePath = getResolvedConfigPath(config, "claudeCode");
    if (restoreLatestBackup("claudeCode", filePath)) {
      return this.status(config);
    }
    if (!fs.existsSync(filePath)) {
      return this.status(config);
    }

    const settings = readJsonObject(filePath);
    removeClaudeManagedFields(settings);
    writeJsonObject(filePath, settings);
    return createClaudeStatus(config, settings);
  },

  restore(config) {
    return this.disable(config);
  },
};

/**
 * Apply ccr takeover settings (base URL, auth token, model family routing,
 * auto-compact, status line) to a project's `.claude/settings.local.json`,
 * mirroring what `claudeCodeAdapter.enable` does for `~/.claude/settings.json`.
 */
export function applyCcrProjectTakeover(settings: Record<string, any>, config: Record<string, any>): void {
  if (!isObject(settings.env)) settings.env = {};

  settings.env.ANTHROPIC_BASE_URL = getCcrBaseUrl(config);
  settings.env.ANTHROPIC_AUTH_TOKEN = config.APIKEY || "test";
  applyClaudeModelFamilies(settings, config);
  applyClaudeAutoCompactSettings(settings);

  if (config?.StatusLine?.enabled) {
    settings.statusLine = {
      type: "command",
      command: "ccr statusline",
      padding: 0,
    };
  } else if (settings.statusLine?.command === "ccr statusline") {
    delete settings.statusLine;
  }
}

/**
 * Remove ccr-managed fields from a project's `.claude/settings.local.json`,
 * preserving any unrelated settings (permissions, hooks, etc.).
 */
export function removeCcrProjectTakeover(settings: Record<string, any>): void {
  if (isObject(settings.env)) {
    if (isCcrBaseUrl(settings.env.ANTHROPIC_BASE_URL)) {
      delete settings.env.ANTHROPIC_BASE_URL;
      delete settings.env.ANTHROPIC_AUTH_TOKEN;
    }

    for (const key of CLAUDE_MODEL_ENV_KEYS) {
      if (typeof settings.env[key] === "string" && settings.env[key].startsWith("ccr-")) {
        delete settings.env[key];
      }
    }

    for (const [key, value] of Object.entries(CLAUDE_AUTO_COMPACT_ENV)) {
      if (settings.env[key] === value) {
        delete settings.env[key];
      }
    }

    if (Object.keys(settings.env).length === 0) {
      delete settings.env;
    }
  }

  if (settings.statusLine?.command === "ccr statusline") {
    delete settings.statusLine;
  }

  if (settings.autoCompactEnabled === true) {
    delete settings.autoCompactEnabled;
  }
}

/**
 * Whether a project's `.claude/settings.local.json` is currently taken over by ccr.
 */
export function isCcrProjectTakeoverActive(settings: Record<string, any>): boolean {
  return isClaudeManaged(settings);
}

function parseTomlString(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const trimmed = raw.trim();
  const quoted = trimmed.match(/^"((?:\\.|[^"\\])*)"/);
  if (quoted) {
    return quoted[1].replace(/\\"/g, '"').replace(/\\\\/g, "\\");
  }
  const singleQuoted = trimmed.match(/^'([^']*)'/);
  if (singleQuoted) return singleQuoted[1];
  const bare = trimmed.match(/^([^#\s]+)/);
  return bare?.[1];
}

function stripTomlComment(line: string): string {
  let inSingle = false;
  let inDouble = false;
  let escaped = false;

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\" && inDouble) {
      escaped = true;
      continue;
    }
    if (char === '"' && !inSingle) {
      inDouble = !inDouble;
      continue;
    }
    if (char === "'" && !inDouble) {
      inSingle = !inSingle;
      continue;
    }
    if (char === "#" && !inSingle && !inDouble) {
      return line.slice(0, index);
    }
  }

  return line;
}

function getTopLevelTomlValue(content: string, key: string): string | undefined {
  let inSection = false;
  for (const line of content.split(/\r?\n/)) {
    const trimmed = stripTomlComment(line).trim();
    if (!trimmed) continue;
    if (/^\[[^\]]+\]$/.test(trimmed)) {
      inSection = true;
      continue;
    }
    if (inSection) continue;

    const match = trimmed.match(/^([A-Za-z0-9_.-]+)\s*=\s*(.+)$/);
    if (match?.[1] === key) {
      return parseTomlString(match[2]);
    }
  }
  return undefined;
}

function hasTomlSection(content: string, sectionName: string): boolean {
  return content
    .split(/\r?\n/)
    .some((line) => stripTomlComment(line).trim() === `[${sectionName}]`);
}

function quoteTomlString(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function setTopLevelTomlValues(content: string, values: Record<string, string>): string {
  const lines = content ? content.split(/\r?\n/) : [];
  const replaced = new Set<string>();
  const firstSectionIndex = lines.findIndex((line) => /^\s*\[[^\]]+\]\s*(?:#.*)?$/.test(line));
  const topLevelEnd = firstSectionIndex === -1 ? lines.length : firstSectionIndex;

  for (let index = 0; index < topLevelEnd; index += 1) {
    const match = stripTomlComment(lines[index]).trim().match(/^([A-Za-z0-9_.-]+)\s*=/);
    if (match && Object.prototype.hasOwnProperty.call(values, match[1])) {
      lines[index] = `${match[1]} = ${quoteTomlString(values[match[1]])}`;
      replaced.add(match[1]);
    }
  }

  const missing = Object.entries(values)
    .filter(([key]) => !replaced.has(key))
    .map(([key, value]) => `${key} = ${quoteTomlString(value)}`);

  if (missing.length > 0) {
    lines.splice(topLevelEnd, 0, ...missing, topLevelEnd === 0 ? "" : "");
  }

  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd();
}

function removeTomlSection(content: string, sectionName: string): string {
  const lines = content ? content.split(/\r?\n/) : [];
  const output: string[] = [];
  let inTargetSection = false;

  for (const line of lines) {
    const sectionMatch = stripTomlComment(line).trim().match(/^\[([^\]]+)\]$/);
    if (sectionMatch) {
      const currentSection = sectionMatch[1];
      inTargetSection =
        currentSection === sectionName || currentSection.startsWith(`${sectionName}.`);
      if (inTargetSection) continue;
    }

    if (!inTargetSection) {
      output.push(line);
    }
  }

  return output.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd();
}

function removeTopLevelTomlKeys(content: string, keys: Set<string>): string {
  const lines = content ? content.split(/\r?\n/) : [];
  const output: string[] = [];
  let inSection = false;

  for (const line of lines) {
    const trimmed = stripTomlComment(line).trim();
    if (/^\[[^\]]+\]$/.test(trimmed)) {
      inSection = true;
      output.push(line);
      continue;
    }

    const match = !inSection ? trimmed.match(/^([A-Za-z0-9_.-]+)\s*=/) : null;
    if (match && keys.has(match[1])) {
      continue;
    }

    output.push(line);
  }

  return output.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd();
}

function getCodexContent(filePath: string): string {
  return fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf-8") : "";
}

function writeCodexContent(filePath: string, content: string): void {
  ensureParentDir(filePath);
  fs.writeFileSync(filePath, `${content.trimEnd()}\n`, "utf-8");
}

function getCodexAuthPath(config: Record<string, any>): string {
  return path.join(path.dirname(getResolvedConfigPath(config, "codex")), "auth.json");
}

function safeAccountId(value: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 72);
  return normalized || `account-${Date.now()}`;
}

function readCodexAccountsIndex(): Omit<CodexAccount, "active">[] {
  if (!fs.existsSync(CODEX_ACCOUNTS_INDEX_PATH)) return [];
  const parsed = JSON.parse(fs.readFileSync(CODEX_ACCOUNTS_INDEX_PATH, "utf-8"));
  if (!Array.isArray(parsed?.accounts)) return [];
  return parsed.accounts.filter(isObject).map((account: any) => ({
    id: String(account.id || ""),
    label: String(account.label || account.email || account.accountId || "Codex Account"),
    email: typeof account.email === "string" ? account.email : undefined,
    plan: typeof account.plan === "string" ? account.plan : undefined,
    accountId: typeof account.accountId === "string" ? account.accountId : undefined,
    authMode: typeof account.authMode === "string" ? account.authMode : undefined,
    createdAt: typeof account.createdAt === "string" ? account.createdAt : new Date().toISOString(),
    updatedAt: typeof account.updatedAt === "string" ? account.updatedAt : new Date().toISOString(),
    lastUsedAt: typeof account.lastUsedAt === "string" ? account.lastUsedAt : undefined,
    limitedUntil: typeof account.limitedUntil === "string" ? account.limitedUntil : undefined,
    limitedWindow: ["5h", "7d", "unknown"].includes(account.limitedWindow) ? account.limitedWindow : undefined,
    limitedReason: typeof account.limitedReason === "string" ? account.limitedReason : undefined,
    lastLimitedAt: typeof account.lastLimitedAt === "string" ? account.lastLimitedAt : undefined,
  })).filter((account: Omit<CodexAccount, "active">) => account.id);
}

function writeCodexAccountsIndex(accounts: Omit<CodexAccount, "active">[]): void {
  fs.mkdirSync(CODEX_ACCOUNTS_DIR, { recursive: true });
  fs.writeFileSync(
    CODEX_ACCOUNTS_INDEX_PATH,
    `${JSON.stringify({ accounts }, null, 2)}\n`,
    "utf-8"
  );
  try {
    fs.chmodSync(CODEX_ACCOUNTS_INDEX_PATH, 0o600);
  } catch {
    // Best effort on platforms that support POSIX permissions.
  }
}

function getCodexAccountAuthPath(accountId: string): string {
  return path.join(CODEX_ACCOUNTS_DIR, `${accountId}.auth.json`);
}

function decodeJwtPayload(token: unknown): Record<string, any> {
  if (typeof token !== "string") return {};
  const [, payload] = token.split(".");
  if (!payload) return {};
  try {
    const normalized = payload.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
    const parsed = JSON.parse(Buffer.from(padded, "base64").toString("utf-8"));
    return isObject(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function getOpenAiAuthClaims(payload: Record<string, any>): Record<string, any> {
  const claims = payload["https://api.openai.com/auth"];
  return isObject(claims) ? claims : {};
}

function getOpenAiProfileClaims(payload: Record<string, any>): Record<string, any> {
  const claims = payload["https://api.openai.com/profile"];
  return isObject(claims) ? claims : {};
}

function extractCodexAuthMetadata(auth: Record<string, any>): {
  email?: string;
  plan?: string;
  accountId?: string;
  authMode?: string;
} {
  const tokens = isObject(auth.tokens) ? auth.tokens : {};
  const idPayload = decodeJwtPayload(tokens.id_token);
  const accessPayload = decodeJwtPayload(tokens.access_token);
  const idAuth = getOpenAiAuthClaims(idPayload);
  const accessAuth = getOpenAiAuthClaims(accessPayload);
  const profile = getOpenAiProfileClaims(accessPayload);

  return {
    email:
      (typeof profile.email === "string" && profile.email) ||
      (typeof idPayload.email === "string" && idPayload.email) ||
      undefined,
    plan:
      (typeof accessAuth.chatgpt_plan_type === "string" && accessAuth.chatgpt_plan_type) ||
      (typeof idAuth.chatgpt_plan_type === "string" && idAuth.chatgpt_plan_type) ||
      undefined,
    accountId:
      (typeof tokens.account_id === "string" && tokens.account_id) ||
      (typeof accessAuth.chatgpt_account_id === "string" && accessAuth.chatgpt_account_id) ||
      (typeof idAuth.chatgpt_account_id === "string" && idAuth.chatgpt_account_id) ||
      undefined,
    authMode: typeof auth.auth_mode === "string" ? auth.auth_mode : undefined,
  };
}

function readCodexAuthObject(authPath: string): Record<string, any> {
  if (!fs.existsSync(authPath)) {
    throw new Error(`Codex auth file not found: ${authPath}`);
  }
  const parsed = JSON.parse(fs.readFileSync(authPath, "utf-8"));
  if (!isObject(parsed)) {
    throw new Error(`Codex auth file is not a JSON object: ${authPath}`);
  }
  return parsed;
}

function writeCodexAuthObject(authPath: string, auth: Record<string, any>): void {
  ensureParentDir(authPath);
  fs.writeFileSync(authPath, `${JSON.stringify(auth, null, 2)}\n`, "utf-8");
  try {
    fs.chmodSync(authPath, 0o600);
  } catch {
    // Best effort on platforms that support POSIX permissions.
  }
}

function getCodexAuthRefreshToken(auth: Record<string, any>): string | undefined {
  const tokens = isObject(auth.tokens) ? auth.tokens : {};
  return typeof tokens.refresh_token === "string" && tokens.refresh_token.trim()
    ? tokens.refresh_token.trim()
    : undefined;
}

function getCodexAuthRefreshTime(auth: Record<string, any>): number {
  const raw = typeof auth.last_refresh === "string" ? auth.last_refresh : "";
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : 0;
}

function isSameCodexAccount(auth: Record<string, any>, account: Omit<CodexAccount, "active">): boolean {
  const metadata = extractCodexAuthMetadata(auth);
  if (metadata.accountId && account.accountId && metadata.accountId === account.accountId) return true;
  if (metadata.email && account.email && metadata.email === account.email) return true;
  return safeAccountId(metadata.accountId || metadata.email || "") === account.id;
}

function getActiveCodexAccountId(config: Record<string, any>): string | undefined {
  const active = getRawClientConfig(config, "codex").activeAccountId;
  return typeof active === "string" && active ? active : undefined;
}

function setActiveCodexAccountId(config: Record<string, any>, accountId: string | undefined): void {
  setClientConfig(config, "codex", { activeAccountId: accountId } as Partial<ClientConfig>);
}

function isCodexAccountCoolingDown(account: Pick<CodexAccount, "limitedUntil">, now = Date.now()): boolean {
  if (!account.limitedUntil) return false;
  const limitedUntil = Date.parse(account.limitedUntil);
  return Number.isFinite(limitedUntil) && limitedUntil > now;
}

function withExpiredCodexLimitsCleared(
  accounts: Omit<CodexAccount, "active">[],
  now = Date.now()
): Omit<CodexAccount, "active">[] {
  let changed = false;
  const next = accounts.map((account) => {
    if (!account.limitedUntil || isCodexAccountCoolingDown(account, now)) {
      return account;
    }
    changed = true;
    const { limitedUntil, limitedWindow, limitedReason, ...rest } = account;
    return rest;
  });
  if (changed) writeCodexAccountsIndex(next);
  return next;
}

function toCodexAccountsResult(config: Record<string, any>): CodexAccountsResult {
  const activeAccountId = getActiveCodexAccountId(config);
  const accounts = withExpiredCodexLimitsCleared(readCodexAccountsIndex());
  return {
    accounts: accounts.map((account) => ({
      ...account,
      active: account.id === activeAccountId,
    })),
    activeAccountId,
    authPath: getCodexAuthPath(config),
  };
}

export function listCodexAccounts(config: Record<string, any>): CodexAccountsResult {
  return toCodexAccountsResult(config);
}

export function getActiveCodexAccount(config: Record<string, any>): CodexAccount | undefined {
  const activeAccountId = getActiveCodexAccountId(config);
  return toCodexAccountsResult(config).accounts.find((account) => account.id === activeAccountId);
}

function inferCodexLimitWindow(reason?: string): "5h" | "7d" | "unknown" {
  const text = (reason || "").toLowerCase();
  if (/(5\s*h|5\s*hour|five\s*hour|5小时|5 小时)/i.test(text)) return "5h";
  if (/(7\s*d|7\s*day|seven\s*day|weekly|week|7天|7 天|一周)/i.test(text)) return "7d";
  return "unknown";
}

function inferCodexRetryAfterSeconds(reason?: string): number {
  const window = inferCodexLimitWindow(reason);
  if (window === "7d") return 7 * 24 * 60 * 60;
  if (window === "5h") return 5 * 60 * 60;
  return 5 * 60 * 60;
}

export function markActiveCodexAccountLimitedAndSwitch(
  config: Record<string, any>,
  reason?: string,
  retryAfterSeconds?: number
): CodexAccountOperationResult {
  const activeAccountId = getActiveCodexAccountId(config);
  const rawAccounts = withExpiredCodexLimitsCleared(readCodexAccountsIndex());
  const activeIndex = rawAccounts.findIndex((account) => account.id === activeAccountId);
  const now = new Date();
  const limitedUntil = new Date(
    now.getTime() + Math.max(60, retryAfterSeconds || inferCodexRetryAfterSeconds(reason)) * 1000
  ).toISOString();

  const accounts = rawAccounts.map((account, index) => (
    index === activeIndex
      ? {
          ...account,
          limitedUntil,
          limitedWindow: inferCodexLimitWindow(reason),
          limitedReason: reason,
          lastLimitedAt: now.toISOString(),
          updatedAt: now.toISOString(),
        }
      : account
  ));

  let switchedAccount: Omit<CodexAccount, "active"> | undefined;
  if (activeIndex >= 0) {
    const ordered = [
      ...accounts.slice(activeIndex + 1),
      ...accounts.slice(0, activeIndex),
    ];
    switchedAccount = ordered.find((account) => !isCodexAccountCoolingDown(account, now.getTime()));
  } else {
    switchedAccount = accounts.find((account) => !isCodexAccountCoolingDown(account, now.getTime()));
  }

  writeCodexAccountsIndex(accounts);

  if (switchedAccount) {
    const storedAuthPath = getCodexAccountAuthPath(switchedAccount.id);
    if (fs.existsSync(storedAuthPath)) {
      const authPath = getCodexAuthPath(config);
      createBackup("codex-auth", authPath);
      writeCodexAuthObject(authPath, readCodexAuthObject(storedAuthPath));
      setActiveCodexAccountId(config, switchedAccount.id);
    }
  }

  const result = toCodexAccountsResult(config);
  return {
    ...result,
    success: Boolean(switchedAccount),
    account: activeAccountId ? result.accounts.find((item) => item.id === activeAccountId) : undefined,
    switchedAccount: switchedAccount ? result.accounts.find((item) => item.id === switchedAccount.id) : undefined,
    config,
  };
}

function persistCodexAccountAuth(
  config: Record<string, any>,
  auth: Record<string, any>,
  label?: string
): CodexAccountOperationResult {
  const metadata = extractCodexAuthMetadata(auth);
  const hash = crypto.createHash("sha256").update(JSON.stringify(auth)).digest("hex").slice(0, 12);
  const id = safeAccountId(metadata.accountId || metadata.email || hash);
  const now = new Date().toISOString();
  const accounts = readCodexAccountsIndex();
  const existingIndex = accounts.findIndex((account) => account.id === id);
  const existing = existingIndex >= 0 ? accounts[existingIndex] : undefined;
  const account: Omit<CodexAccount, "active"> = {
    id,
    label: label?.trim() || existing?.label || metadata.email || metadata.accountId || "Codex Account",
    email: metadata.email,
    plan: metadata.plan,
    accountId: metadata.accountId,
    authMode: metadata.authMode,
    createdAt: existing?.createdAt || now,
    updatedAt: now,
    lastUsedAt: now,
  };

  if (existingIndex >= 0) {
    accounts[existingIndex] = account;
  } else {
    accounts.push(account);
  }

  fs.mkdirSync(CODEX_ACCOUNTS_DIR, { recursive: true });
  writeCodexAuthObject(getCodexAccountAuthPath(id), auth);
  writeCodexAccountsIndex(accounts);

  const authPath = getCodexAuthPath(config);
  const nextAuthContent = `${JSON.stringify(auth, null, 2)}\n`;
  const currentAuthContent = fs.existsSync(authPath) ? fs.readFileSync(authPath, "utf-8") : "";
  if (currentAuthContent !== nextAuthContent) {
    createBackup("codex-auth", authPath);
    writeCodexAuthObject(authPath, auth);
  }
  setActiveCodexAccountId(config, id);

  const result = toCodexAccountsResult(config);
  return {
    ...result,
    success: true,
    account: result.accounts.find((item) => item.id === id),
    config,
  };
}

export function importCurrentCodexAccount(
  config: Record<string, any>,
  label?: string
): CodexAccountOperationResult {
  const auth = readCodexAuthObject(getCodexAuthPath(config));
  return persistCodexAccountAuth(config, auth, label);
}

export function exportCodexRefreshToken(
  config: Record<string, any>,
  accountId?: string
): CodexRefreshTokenExportResult {
  const targetAccountId = accountId || getActiveCodexAccountId(config);
  if (!targetAccountId) {
    throw new Error("No active Codex account. Specify an account id or activate one first.");
  }

  const accounts = readCodexAccountsIndex();
  const account = accounts.find((item) => item.id === targetAccountId);
  if (!account) {
    throw new Error(`Unknown Codex account: ${targetAccountId}`);
  }

  const storedAuthPath = getCodexAccountAuthPath(targetAccountId);
  if (!fs.existsSync(storedAuthPath)) {
    throw new Error(`Stored Codex auth file not found: ${storedAuthPath}`);
  }

  const candidates: Array<{ auth: Record<string, any>; source: "managed" | "current"; refreshedAt: number }> = [
    {
      auth: readCodexAuthObject(storedAuthPath),
      source: "managed",
      refreshedAt: 0,
    },
  ];
  candidates[0].refreshedAt = getCodexAuthRefreshTime(candidates[0].auth);

  const currentAuthPath = getCodexAuthPath(config);
  if (getActiveCodexAccountId(config) === targetAccountId && fs.existsSync(currentAuthPath)) {
    try {
      const currentAuth = readCodexAuthObject(currentAuthPath);
      if (isSameCodexAccount(currentAuth, account)) {
        candidates.push({
          auth: currentAuth,
          source: "current",
          refreshedAt: getCodexAuthRefreshTime(currentAuth),
        });
      }
    } catch {
      // Ignore malformed current auth and fall back to the managed snapshot.
    }
  }

  const latest = candidates
    .filter((candidate) => getCodexAuthRefreshToken(candidate.auth))
    .sort((a, b) => b.refreshedAt - a.refreshedAt)[0];

  if (!latest) {
    throw new Error(`No refresh token found for Codex account: ${targetAccountId}`);
  }

  if (latest.source === "current") {
    const storedRefreshTime = getCodexAuthRefreshTime(candidates[0].auth);
    if (latest.refreshedAt > storedRefreshTime) {
      writeCodexAuthObject(storedAuthPath, latest.auth);
      const now = new Date().toISOString();
      writeCodexAccountsIndex(accounts.map((item) => (
        item.id === targetAccountId
          ? { ...item, lastUsedAt: now, updatedAt: now }
          : item
      )));
    }
  }

  const result = toCodexAccountsResult(config);
  const resultAccount = result.accounts.find((item) => item.id === targetAccountId);
  if (!resultAccount) {
    throw new Error(`Unknown Codex account: ${targetAccountId}`);
  }

  return {
    success: true,
    account: resultAccount,
    refreshToken: getCodexAuthRefreshToken(latest.auth)!,
    refreshedAt: typeof latest.auth.last_refresh === "string" ? latest.auth.last_refresh : undefined,
    source: latest.source,
  };
}

async function exchangeCodexRefreshToken(refreshToken: string): Promise<Record<string, any>> {
  const token = refreshToken.trim();
  if (!token) {
    throw new Error("Refresh token is required");
  }

  const response = await fetch(CODEX_OAUTH_TOKEN_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "accept": "application/json",
    },
    body: JSON.stringify({
      grant_type: "refresh_token",
      refresh_token: token,
      client_id: CODEX_OAUTH_CLIENT_ID,
    }),
  });

  const text = await response.text();
  let data: Record<string, any> = {};
  try {
    const parsed = text ? JSON.parse(text) : {};
    data = isObject(parsed) ? parsed : {};
  } catch {
    data = {};
  }

  if (!response.ok) {
    const message =
      (typeof data.error_description === "string" && data.error_description) ||
      (typeof data.error === "string" && data.error) ||
      text ||
      `HTTP ${response.status}`;
    throw new Error(`Failed to exchange Codex refresh token: ${message}`);
  }

  if (typeof data.access_token !== "string" || typeof data.id_token !== "string") {
    throw new Error("Refresh token exchange did not return Codex access and ID tokens");
  }

  const auth = {
    auth_mode: "chatgpt",
    OPENAI_API_KEY: null,
    tokens: {
      id_token: data.id_token,
      access_token: data.access_token,
      refresh_token: typeof data.refresh_token === "string" ? data.refresh_token : token,
      account_id: undefined as string | undefined,
    },
    last_refresh: new Date().toISOString(),
  };
  const metadata = extractCodexAuthMetadata(auth);
  auth.tokens.account_id = metadata.accountId;
  return auth;
}

export async function importCodexAccountFromRefreshToken(
  config: Record<string, any>,
  refreshToken: string,
  label?: string
): Promise<CodexAccountOperationResult> {
  const auth = await exchangeCodexRefreshToken(refreshToken);
  return persistCodexAccountAuth(config, auth, label);
}

export function activateCodexAccount(
  config: Record<string, any>,
  accountId: string
): CodexAccountOperationResult {
  const accounts = readCodexAccountsIndex();
  const accountIndex = accounts.findIndex((account) => account.id === accountId);
  if (accountIndex < 0) {
    throw new Error(`Unknown Codex account: ${accountId}`);
  }

  const storedAuthPath = getCodexAccountAuthPath(accountId);
  if (!fs.existsSync(storedAuthPath)) {
    throw new Error(`Stored Codex auth file not found: ${storedAuthPath}`);
  }

  const authPath = getCodexAuthPath(config);
  createBackup("codex-auth", authPath);
  writeCodexAuthObject(authPath, readCodexAuthObject(storedAuthPath));

  accounts[accountIndex] = {
    ...accounts[accountIndex],
    lastUsedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  writeCodexAccountsIndex(accounts);
  setActiveCodexAccountId(config, accountId);

  const result = toCodexAccountsResult(config);
  return {
    ...result,
    success: true,
    account: result.accounts.find((item) => item.id === accountId),
    config,
  };
}

export function deleteCodexAccount(
  config: Record<string, any>,
  accountId: string
): CodexAccountOperationResult {
  const accounts = readCodexAccountsIndex();
  const nextAccounts = accounts.filter((account) => account.id !== accountId);
  if (nextAccounts.length === accounts.length) {
    throw new Error(`Unknown Codex account: ${accountId}`);
  }

  const storedAuthPath = getCodexAccountAuthPath(accountId);
  if (fs.existsSync(storedAuthPath)) {
    fs.unlinkSync(storedAuthPath);
  }

  writeCodexAccountsIndex(nextAccounts);
  if (getActiveCodexAccountId(config) === accountId) {
    setActiveCodexAccountId(config, undefined);
  }

  return {
    ...toCodexAccountsResult(config),
    success: true,
    config,
  };
}

function isCodexManaged(content: string): boolean {
  const provider = getTopLevelTomlValue(content, "model_provider");
  const hasCcrProvider = hasTomlSection(content, "model_providers.ccr");
  return provider === "ccr" || hasCcrProvider;
}

function ensureCodexRouterMapping(config: Record<string, any>, alias: string): void {
  if (!isObject(config.Router)) {
    config.Router = {};
  }
  if (!isObject(config.Router.models)) {
    config.Router.models = {};
  }
  if (!config.Router.models[alias] && typeof config.Router.default === "string" && config.Router.default) {
    config.Router.models[alias] = config.Router.default;
  }
}

// Remove CCR-related keys from the [shell_environment_policy.set] section
function cleanShellEnvVars(content: string): string {
  const ccrEnvKeys = new Set([
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_BASE_URL",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL",
    "ANTHROPIC_DEFAULT_OPUS_MODEL",
    "ANTHROPIC_DEFAULT_SONNET_MODEL",
    "ANTHROPIC_MODEL",
    "ANTHROPIC_REASONING_MODEL",
    "CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS",
  ]);

  const lines = content ? content.split(/\r?\n/) : [];
  const output: string[] = [];
  let inShellSet = false;

  for (const line of lines) {
    const trimmed = stripTomlComment(line).trim();
    if (trimmed === "[shell_environment_policy.set]") {
      inShellSet = true;
      output.push(line);
      continue;
    }
    if (inShellSet && /^\[[^\]]+\]$/.test(trimmed)) {
      inShellSet = false;
    }
    if (inShellSet) {
      const kvMatch = trimmed.match(/^([A-Za-z0-9_.-]+)\s*=/);
      if (kvMatch && ccrEnvKeys.has(kvMatch[1])) {
        continue; // skip CCR env vars
      }
    }
    output.push(line);
  }

  return output.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd();
}

function createCodexStatus(config: Record<string, any>, content?: string, details?: string): ClientStatus {
  const clientConfig = getClientConfig(config, "codex");
  const filePath = getResolvedConfigPath(config, "codex");
  const safeContent = content ?? "";
  const model = getTopLevelTomlValue(safeContent, "model");

  return {
    id: "codex",
    name: CLIENT_DEFINITIONS.codex.name,
    enabled: clientConfig.enabled,
    managed: isCodexManaged(safeContent),
    configPath: clientConfig.configPath,
    exists: fs.existsSync(filePath),
    activeModel: model,
    modelAlias: clientConfig.modelAlias,
    details,
  };
}

const codexAdapter: ClientAdapter = {
  status(config) {
    const filePath = getResolvedConfigPath(config, "codex");
    try {
      return createCodexStatus(config, getCodexContent(filePath));
    } catch (error) {
      return createCodexStatus(config, "", errorMessage(error));
    }
  },

  enable(config) {
    const filePath = getResolvedConfigPath(config, "codex");
    const clientConfig = getClientConfig(config, "codex");
    const alias = clientConfig.modelAlias || CLIENT_DEFINITIONS.codex.defaultConfig.modelAlias;
    const currentStatus = this.status(config);
    if (!currentStatus.managed) {
      createBackup("codex", filePath);
    }

    ensureCodexRouterMapping(config, alias);

    let content = getCodexContent(filePath);
    content = removeTomlSection(content, "model_providers.ccr");
    content = setTopLevelTomlValues(content, {
      model: alias,
      model_provider: "ccr",
    });
    const apiKey = typeof config.APIKEY === "string" ? config.APIKEY : "";
    const authSection = apiKey
      ? `\n\n[model_providers.ccr.http_headers]\nAuthorization = ${quoteTomlString(`Bearer ${apiKey}`)}`
      : "";
    content = `${content.trimEnd()}\n\n[model_providers.ccr]\nname = "Claude Code Router"\nbase_url = "${getCcrBaseUrl(config, "/v1")}"\nwire_api = "responses"${authSection}`;

    writeCodexContent(filePath, content);
    return createCodexStatus(config, content);
  },

  disable(config) {
    const filePath = getResolvedConfigPath(config, "codex");
    if (restoreLatestBackup("codex", filePath)) {
      // Also clean up shell env vars that may have been added outside of CCR
      let content = getCodexContent(filePath);
      content = cleanShellEnvVars(content);
      writeCodexContent(filePath, content);
      return this.status(config);
    }
    if (!fs.existsSync(filePath)) {
      return this.status(config);
    }

    const clientConfig = getClientConfig(config, "codex");
    const alias = clientConfig.modelAlias || CLIENT_DEFINITIONS.codex.defaultConfig.modelAlias;
    let content = getCodexContent(filePath);
    const keysToRemove = new Set<string>();

    if (getTopLevelTomlValue(content, "model_provider") === "ccr") {
      keysToRemove.add("model_provider");
    }

    const activeModel = getTopLevelTomlValue(content, "model");
    if (activeModel === alias || activeModel?.startsWith("ccr-")) {
      keysToRemove.add("model");
    }

    content = removeTopLevelTomlKeys(content, keysToRemove);
    content = removeTomlSection(content, "model_providers.ccr");
    // Also remove CCR-related shell environment variables
    content = cleanShellEnvVars(content);
    writeCodexContent(filePath, content);
    return createCodexStatus(config, content);
  },

  restore(config) {
    return this.disable(config);
  },
};

const CLIENT_ADAPTERS: Record<ClientId, ClientAdapter> = {
  claudeCode: claudeCodeAdapter,
  codex: codexAdapter,
};

export function listClientStatuses(config: Record<string, any>): ClientStatus[] {
  return CLIENT_IDS.map((id) => CLIENT_ADAPTERS[id].status(config));
}

function runClientOperation(
  config: Record<string, any>,
  id: ClientId,
  action: ClientAction,
  options: ClientOperationOptions = {}
): ClientOperationResult {
  const updateEnabled = options.updateEnabled !== false;
  const adapter = CLIENT_ADAPTERS[id];
  const status = adapter[action](config);
  const patch: Partial<ClientConfig> = {
    managed: action === "enable",
    configPath: status.configPath,
  };

  if (status.modelAlias) {
    patch.modelAlias = status.modelAlias;
  }

  if (updateEnabled) {
    patch.enabled = action === "enable";
  } else {
    patch.enabled = getClientConfig(config, id).enabled;
  }

  setClientConfig(config, id, patch);
  const updatedStatus = adapter.status(config);

  return {
    id,
    action,
    success: true,
    status: updatedStatus,
  };
}

export function enableClient(
  config: Record<string, any>,
  id: ClientId,
  options?: ClientOperationOptions
): ClientOperationResult {
  return runClientOperation(config, id, "enable", options);
}

export function disableClient(
  config: Record<string, any>,
  id: ClientId,
  options?: ClientOperationOptions
): ClientOperationResult {
  return runClientOperation(config, id, "disable", options);
}

export function restoreClient(
  config: Record<string, any>,
  id: ClientId,
  options?: ClientOperationOptions
): ClientOperationResult {
  return runClientOperation(config, id, "restore", options);
}

export function applyClientSelection(
  config: Record<string, any>,
  enabledIds: string[]
): ClientApplyResult {
  const selected = new Set(enabledIds);
  const results: ClientOperationResult[] = [];

  for (const id of selected) {
    if (!isClientId(id)) {
      results.push({
        id: id as ClientId,
        action: "enable",
        success: false,
        error: `Unknown client: ${id}`,
      });
    }
  }

  for (const id of CLIENT_IDS) {
    try {
      results.push(
        selected.has(id)
          ? enableClient(config, id, { updateEnabled: true })
          : disableClient(config, id, { updateEnabled: true })
      );
    } catch (error) {
      results.push({
        id,
        action: selected.has(id) ? "enable" : "disable",
        success: false,
        error: errorMessage(error),
      });
    }
  }

  return {
    success: results.every((result) => result.success),
    results,
    clients: listClientStatuses(config),
    config,
  };
}

export function enableConfiguredClients(config: Record<string, any>): ClientApplyResult {
  const results: ClientOperationResult[] = [];

  for (const id of CLIENT_IDS) {
    if (!isClientEnabled(config, id)) continue;

    try {
      results.push(enableClient(config, id, { updateEnabled: false }));
    } catch (error) {
      results.push({
        id,
        action: "enable",
        success: false,
        error: errorMessage(error),
      });
    }
  }

  return {
    success: results.every((result) => result.success),
    results,
    clients: listClientStatuses(config),
    config,
  };
}

export function disableConfiguredClients(config: Record<string, any>): ClientApplyResult {
  const results: ClientOperationResult[] = [];

  for (const id of CLIENT_IDS) {
    if (!isClientEnabled(config, id)) continue;

    try {
      results.push(disableClient(config, id, { updateEnabled: false }));
    } catch (error) {
      results.push({
        id,
        action: "disable",
        success: false,
        error: errorMessage(error),
      });
    }
  }

  return {
    success: results.every((result) => result.success),
    results,
    clients: listClientStatuses(config),
    config,
  };
}
