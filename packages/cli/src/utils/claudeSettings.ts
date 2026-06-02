import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { HOME_DIR } from "@wengine-ai/claude-code-router-shared";

const CLAUDE_SETTINGS_PATH = path.join(os.homedir(), ".claude", "settings.json");
const BACKUP_PATH = path.join(HOME_DIR, ".statusline-backup.json");
const MODEL_BACKUP_PATH = path.join(HOME_DIR, ".model-env-backup.json");
const CLAUDE_AUTO_COMPACT_ENV = {
  CLAUDE_CODE_AUTO_COMPACT_WINDOW: "200000",
  CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: "90",
  CLAUDE_CODE_SIMPLE: "1",
};

function readClaudeSettings(): Record<string, any> {
  try {
    const content = fs.readFileSync(CLAUDE_SETTINGS_PATH, "utf-8");
    return JSON.parse(content);
  } catch {
    return {};
  }
}

function writeClaudeSettings(settings: Record<string, any>): void {
  const dir = path.dirname(CLAUDE_SETTINGS_PATH);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(CLAUDE_SETTINGS_PATH, JSON.stringify(settings, null, 2), "utf-8");
}

export function injectStatusLine(config: any): void {
  if (!config?.StatusLine?.enabled) return;

  const settings = readClaudeSettings();

  // Backup existing statusLine if present and not already a ccr one
  if (settings.statusLine && settings.statusLine.command !== "ccr statusline") {
    fs.writeFileSync(BACKUP_PATH, JSON.stringify(settings.statusLine), "utf-8");
  }

  settings.statusLine = {
    type: "command",
    command: "ccr statusline",
    padding: 0,
  };

  writeClaudeSettings(settings);
}

export function removeStatusLine(): void {
  const settings = readClaudeSettings();

  // Only remove if it's ours
  if (settings.statusLine?.command !== "ccr statusline") return;

  // Restore backup if exists
  try {
    const backup = fs.readFileSync(BACKUP_PATH, "utf-8");
    settings.statusLine = JSON.parse(backup);
    fs.unlinkSync(BACKUP_PATH);
  } catch {
    delete settings.statusLine;
  }

  writeClaudeSettings(settings);
}

/**
 * Check if families are configured and need model name injection
 */
function hasFamiliesConfig(config: any): boolean {
  const families = config?.Router?.families;
  if (!families || typeof families !== "object") return false;
  return Object.keys(families).length > 0;
}

/**
 * Check if a family has extendedContext (1M) enabled
 */
function hasExtendedContext(familyConfig: any): boolean {
  return familyConfig?.enableExtendedContext === true;
}

/**
 * Inject model family names into Claude Code settings.
 * When families are configured, set model env vars to ccr-opus/ccr-sonnet/ccr-haiku
 * Optionally append [1m] for extended context (1M window) support.
 */
export function injectModelFamilies(config: any): void {
  if (!hasFamiliesConfig(config)) return;

  const families = config.Router.families;
  const settings = readClaudeSettings();
  if (!settings.env) settings.env = {};

  // Set proxy base URL and API key so plain `claude` commands route through CCR
  const port = config.PORT || 3456;
  const apiKey = config.APIKEY || "test";
  settings.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${port}`;
  settings.env.ANTHROPIC_AUTH_TOKEN = apiKey;
  settings.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW = CLAUDE_AUTO_COMPACT_ENV.CLAUDE_CODE_AUTO_COMPACT_WINDOW;
  settings.env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE = CLAUDE_AUTO_COMPACT_ENV.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE;
  settings.autoCompactEnabled = true;

  // Backup original model env vars
  const backup: Record<string, string> = {};
  const envKeys = [
    "ANTHROPIC_MODEL",
    "ANTHROPIC_DEFAULT_SONNET_MODEL",
    "ANTHROPIC_DEFAULT_OPUS_MODEL",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL",
    "ANTHROPIC_REASONING_MODEL",
  ];

  let hasExisting = false;
  for (const key of envKeys) {
    if (settings.env[key] && !settings.env[key].startsWith("ccr-")) {
      backup[key] = settings.env[key];
      hasExisting = true;
    }
  }

  if (hasExisting) {
    fs.writeFileSync(MODEL_BACKUP_PATH, JSON.stringify(backup), "utf-8");
  }

  // Set model env vars to ccr-family format with optional [1m] suffix
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

  // Set main model to opus, fallback to first configured family
  const defaultFamily = families["opus"] ? "opus" : primaryFamily;
  if (defaultFamily) {
    const defaultConfig = families[defaultFamily];
    const extendedSuffix = hasExtendedContext(defaultConfig) ? "[1m]" : "";
    settings.env.ANTHROPIC_MODEL = `ccr-${defaultFamily}${extendedSuffix}`;
  }

  // Set reasoning model to first family with think config, or first family
  const thinkFamily = familyNames.find((f: string) => families[f]?.think);
  if (thinkFamily) {
    const thinkConfig = families[thinkFamily];
    const extendedSuffix = hasExtendedContext(thinkConfig) ? "[1m]" : "";
    settings.env.ANTHROPIC_REASONING_MODEL = `ccr-${thinkFamily}${extendedSuffix}`;
  } else if (primaryFamily) {
    const primaryConfig = families[primaryFamily];
    const extendedSuffix = hasExtendedContext(primaryConfig) ? "[1m]" : "";
    settings.env.ANTHROPIC_REASONING_MODEL = `ccr-${primaryFamily}${extendedSuffix}`;
  }

  writeClaudeSettings(settings);
}

/**
 * Restore original model env vars in Claude Code settings.
 */
export function removeModelFamilies(): void {
  const settings = readClaudeSettings();

  // Restore backup if exists
  try {
    const backup = JSON.parse(fs.readFileSync(MODEL_BACKUP_PATH, "utf-8"));
    if (!settings.env) settings.env = {};
    for (const [key, value] of Object.entries(backup)) {
      settings.env[key] = value as string;
    }
    fs.unlinkSync(MODEL_BACKUP_PATH);
  } catch {
    // No backup, remove ccr- prefixed values
    if (settings.env) {
      for (const key of Object.keys(settings.env)) {
        if (typeof settings.env[key] === "string" && settings.env[key].startsWith("ccr-")) {
          delete settings.env[key];
        }
      }
    }
  }

  writeClaudeSettings(settings);
}
