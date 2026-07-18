import { copyFileSync, mkdirSync } from "fs";
import { join } from "path";
import { exec } from "child_process";
import { promisify } from "util";
import { CONFIG_FILE, HOME_DIR } from "@wengine-ai/claude-code-router-shared";
import { name as packageName } from "../../package.json";

const execPromise = promisify(exec);
const GITHUB_CHANGELOG_URL = "https://raw.githubusercontent.com/xiaoliu10/claude-code-router-next/main/CHANGELOG.md";
const CHANGELOG_FETCH_TIMEOUT_MS = 5000;

/**
 * Extract the release summary row for a version from a README changelog table.
 */
export function extractVersionSummaryFromReadme(readme: string, targetVersion: string): string {
  const escapedVersion = targetVersion.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const row = readme.match(
    new RegExp(`^\\|\\s*\\*\\*v${escapedVersion}\\*\\*\\s*\\|\\s*(.*?)\\s*\\|\\s*$`, "m"),
  );

  return row ? htmlToText(row[1]) : "";
}

/**
 * Extract a version section from the detailed Markdown changelog.
 */
export function extractChangelogSection(changelog: string, targetVersion: string): string {
  const escapedVersion = targetVersion.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const section = changelog.match(
    new RegExp(`^## \\[${escapedVersion}\\][^\\n]*\\n([\\s\\S]*?)(?=^## \\[|$)`, "m"),
  );

  if (!section) {
    return "";
  }

  return markdownToText(section[1]);
}

/**
 * Check if a new version is available and include its release summary when possible.
 * @param currentVersion Current version
 * @returns Object containing update information
 */
export async function checkForUpdates(currentVersion: string) {
  try {
    // Get latest version info from npm registry
    const { stdout } = await execPromise(`npm view ${packageName} version`);
    const latestVersion = stdout.trim();

    // Compare versions
    const hasUpdate = compareVersions(latestVersion, currentVersion) > 0;

    let changelog = "";
    if (hasUpdate) {
      changelog = await fetchChangelogSummary(latestVersion);
    }

    return { hasUpdate, latestVersion, changelog };
  } catch (error) {
    console.error("Error checking for updates:", error);
    // If check fails, assume no update
    return { hasUpdate: false, latestVersion: currentVersion, changelog: "" };
  }
}

async function fetchChangelogSummary(targetVersion: string): Promise<string> {
  try {
    const { stdout } = await execPromise(
      `npm view ${packageName}@${targetVersion} readme --json`,
      { maxBuffer: 2 * 1024 * 1024 },
    );
    const readme = parseNpmReadme(stdout);
    const summary = extractVersionSummaryFromReadme(readme, targetVersion);
    if (summary) {
      return summary;
    }
  } catch (error) {
    console.warn("Failed to fetch release summary from npm README:", error);
  }

  try {
    const response = await fetchWithTimeout(GITHUB_CHANGELOG_URL, CHANGELOG_FETCH_TIMEOUT_MS);
    return extractChangelogSection(response, targetVersion);
  } catch (error) {
    console.warn("Failed to fetch release summary from GitHub changelog:", error);
    return "";
  }
}

function parseNpmReadme(output: string): string {
  const trimmed = output.trim();
  if (!trimmed) {
    return "";
  }

  try {
    const parsed: unknown = JSON.parse(trimmed);
    return typeof parsed === "string" ? parsed : "";
  } catch {
    return trimmed;
  }
}

async function fetchWithTimeout(url: string, timeoutMs: number): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    return await response.text();
  } finally {
    clearTimeout(timeout);
  }
}

function htmlToText(html: string): string {
  return decodeHtmlEntities(
    html
      .replace(/<li\b[^>]*>/gi, "• ")
      .replace(/<\/li>/gi, "\n")
      .replace(/<br\s*\/?>(?=\s*)/gi, "\n")
      .replace(/<\/?(?:ul|ol)\b[^>]*>/gi, "\n")
      .replace(/<[^>]+>/g, "")
      .replace(/\*\*(.*?)\*\*/g, "$1"),
  );
}

function markdownToText(markdown: string): string {
  return markdown
    .replace(/^###\s*/gm, "")
    .replace(/\*\*(.*?)\*\*/g, "$1")
    .replace(/^\s*\n/, "")
    .trim();
}

function decodeHtmlEntities(value: string): string {
  const namedEntities: Record<string, string> = {
    "&amp;": "&",
    "&apos;": "'",
    "&gt;": ">",
    "&lt;": "<",
    "&nbsp;": " ",
    "&quot;": '"',
    "&#39;": "'",
  };

  return value
    .replace(/&(?:amp|apos|gt|lt|nbsp|quot|#39);/g, (entity) => namedEntities[entity])
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n");
}

/**
 * Perform update operation
 * @returns Update result
 */
export async function performUpdate() {
  try {
    // Take a durable pre-upgrade backup of config.json before the npm install.
    // Standard rolling backups can be overwritten by the new version's first save;
    // this separate non-rotating snapshot survives the upgrade.
    try {
      const backupDir = join(HOME_DIR, "pre-upgrade-backups");
      mkdirSync(backupDir, { recursive: true });
      const backupName = `config-pre-upgrade-${Date.now()}.json`;
      copyFileSync(CONFIG_FILE, join(backupDir, backupName));
    } catch (backupError) {
      console.warn("Failed to create pre-upgrade config backup:", backupError);
    }

    // Execute npm update command
    const { stdout, stderr } = await execPromise(`npm install -g ${packageName}@latest`);

    if (stderr) {
      console.error("Update stderr:", stderr);
    }

    console.log("Update stdout:", stdout);

    return {
      success: true,
      message: "Update completed successfully. Please restart the application to apply changes.",
    };
  } catch (error) {
    console.error("Error performing update:", error);
    return {
      success: false,
      message: `Failed to perform update: ${error instanceof Error ? error.message : "Unknown error"}`,
    };
  }
}

/**
 * Compare two version numbers
 * @param v1 Version number 1
 * @param v2 Version number 2
 * @returns 1 if v1 > v2, -1 if v1 < v2, 0 if equal
 */
function compareVersions(v1: string, v2: string): number {
  const parts1 = v1.split(".").map(Number);
  const parts2 = v2.split(".").map(Number);

  for (let i = 0; i < Math.max(parts1.length, parts2.length); i++) {
    const num1 = i < parts1.length ? parts1[i] : 0;
    const num2 = i < parts2.length ? parts2[i] : 0;

    if (num1 > num2) return 1;
    if (num1 < num2) return -1;
  }

  return 0;
}
