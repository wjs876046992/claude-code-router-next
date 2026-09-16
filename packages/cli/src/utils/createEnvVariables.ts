import { readConfigFile } from ".";
import {
  buildProjectTakeoverConfig,
  CLAUDE_AUTO_COMPACT_PCT_OVERRIDE,
  getActiveProfile,
  getClaudeFamilyEnv,
  getClaudeTakeoverContextWindow,
  getProfileConfigPath,
  readProjectConfig,
} from "@wengine-ai/claude-code-router-shared";
import fs from "node:fs/promises";
import JSON5 from "json5";

const CLAUDE_AUTO_COMPACT_ENV = {
  CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: CLAUDE_AUTO_COMPACT_PCT_OVERRIDE,
  CLAUDE_CODE_SIMPLE: "1",
};

/**
 * Resolve the config that applies to the project `ccr code` is launched in:
 * global connection/UI settings with the project's Router overlaid. Mirrors the
 * settings-file takeover (buildProjectTakeoverConfig) so both paths cap the
 * auto-compact window identically. Falls back to the global config when the
 * project has no Router of its own, or when the project config can't be read.
 */
async function resolveEffectiveConfig(
  config: Record<string, any>,
  projectPath: string,
): Promise<Record<string, any>> {
  try {
    const projectConfig = await readProjectConfig(projectPath);
    if (!projectConfig?.Router) return config;
    return buildProjectTakeoverConfig(config, projectConfig.Router);
  } catch {
    // A malformed project config must not break `ccr code`; the server still
    // resolves (and reports) project routing errors on the request path.
    return config;
  }
}

/**
 * Get environment variables for Agent SDK/Claude Code integration
 * This function is shared between `ccr env` and `ccr code` commands
 */
export const createEnvVariables = async (): Promise<Record<string, string | undefined>> => {
  // Read config from the active profile's directory
  const activeProfile = await getActiveProfile();
  let config;

  if (activeProfile === "default") {
    config = await readConfigFile();
  } else {
    const configPath = getProfileConfigPath(activeProfile);
    try {
      const content = await fs.readFile(configPath, "utf-8");
      config = JSON5.parse(content);
    } catch {
      // Fallback to default config if profile config is missing
      config = await readConfigFile();
    }
  }

  // `ccr code` is launched inside the project it should route, so derive the
  // family aliases and the auto-compact window from the project's effective
  // config — not the global one. Claude Code passes these as both `--settings`
  // and process env, and its env layer outranks every settings file, so a
  // global-only value here would override (and defeat) the project takeover's
  // 200k cap for projects whose Router has no extended context.
  const effectiveConfig = await resolveEffectiveConfig(config, process.cwd());

  const port = config.PORT || 3456;
  const apiKey = config.APIKEY || "test";

  return {
    ANTHROPIC_AUTH_TOKEN: apiKey,
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`,
    NO_PROXY: "127.0.0.1",
    DISABLE_TELEMETRY: "true",
    DISABLE_COST_WARNINGS: "true",
    API_TIMEOUT_MS: String(config.API_TIMEOUT_MS ?? 600000),
    // Strip the dynamic attribution header (client version + prompt fingerprint)
    // from the start of the system prompt. It changes between requests and breaks
    // the upstream prompt-cache prefix when routing through CCR (an LLM gateway).
    // Enabled by default; users can opt out via `disableAttributionHeader: false`.
    CLAUDE_CODE_ATTRIBUTION_HEADER:
      config.disableAttributionHeader === false ? undefined : "0",
    ...CLAUDE_AUTO_COMPACT_ENV,
    // Same value the settings-file takeover writes: the configured
    // `ContextWindow`, capped at 200000 unless the default family has extended
    // context. Sharing the helper keeps `ccr code` and the takeover from
    // disagreeing about where auto-compact fires.
    CLAUDE_CODE_AUTO_COMPACT_WINDOW: String(getClaudeTakeoverContextWindow(effectiveConfig)),
    // Reset CLAUDE_CODE_USE_BEDROCK when running with ccr
    CLAUDE_CODE_USE_BEDROCK: undefined,
    // Shared with the takeover, so `enableFamilyRouting: false` suppresses the
    // `ccr-*[1m]` aliases on both paths.
    ...getClaudeFamilyEnv(effectiveConfig),
  };
}
