/**
 * Initialize ~/.claude.json if it doesn't exist (Claude Code's local config).
 *
 * Extracted from the legacy server's index.ts.
 */
import { existsSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { writeFile } from "fs/promises";

export async function initializeClaudeConfig() {
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