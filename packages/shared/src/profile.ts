import fs from "node:fs/promises";
import path from "node:path";
import {
  HOME_DIR,
  CONFIG_FILE,
  PROFILES_DIR,
  ACTIVE_PROFILE_FILE,
} from "./constants";

export interface ProfileInfo {
  name: string;
  configPath: string;
  isActive: boolean;
  port?: number;
}

/**
 * Validate profile name: alphanumeric, hyphens, underscores only.
 */
export function validateProfileName(name: string): void {
  if (!name || !/^[a-zA-Z0-9_-]+$/.test(name)) {
    throw new Error(
      "Profile name must contain only letters, numbers, hyphens, and underscores"
    );
  }
  if (name.length > 64) {
    throw new Error("Profile name must be 64 characters or less");
  }
}

/**
 * Get the directory path for a profile.
 */
export function getProfileDir(name: string): string {
  validateProfileName(name);
  return path.join(PROFILES_DIR, name);
}

/**
 * Get the config file path for a profile.
 */
export function getProfileConfigPath(name: string): string {
  return path.join(getProfileDir(name), "config.json");
}

/**
 * Get the PID file path for a profile.
 */
export function getProfilePidFile(name: string): string {
  return path.join(getProfileDir(name), ".claude-code-router.pid");
}

/**
 * Read the active profile name. Returns "default" if none set.
 */
export async function getActiveProfile(): Promise<string> {
  try {
    const name = (await fs.readFile(ACTIVE_PROFILE_FILE, "utf-8")).trim();
    return name || "default";
  } catch {
    return "default";
  }
}

/**
 * Set the active profile name.
 */
export async function setActiveProfile(name: string): Promise<void> {
  validateProfileName(name);
  await fs.mkdir(PROFILES_DIR, { recursive: true });
  await fs.writeFile(ACTIVE_PROFILE_FILE, name);
}

/**
 * List all profiles. Marks the active one.
 */
export async function listProfiles(): Promise<ProfileInfo[]> {
  const profiles: ProfileInfo[] = [];
  const activeName = await getActiveProfile();

  try {
    await fs.access(PROFILES_DIR);
  } catch {
    return [
      {
        name: "default",
        configPath: CONFIG_FILE,
        isActive: activeName === "default",
      },
    ];
  }

  const entries = await fs.readdir(PROFILES_DIR, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isDirectory() && !entry.name.startsWith(".")) {
      const configPath = path.join(PROFILES_DIR, entry.name, "config.json");
      try {
        await fs.access(configPath);
        const raw = await fs.readFile(configPath, "utf-8");
        const config = JSON.parse(raw);
        profiles.push({
          name: entry.name,
          configPath,
          isActive: entry.name === activeName,
          port: config.PORT,
        });
      } catch {
        // Skip directories without valid config
      }
    }
  }

  // Always include "default" if it doesn't exist as a profile dir
  if (!profiles.find((p) => p.name === "default")) {
    try {
      await fs.access(CONFIG_FILE);
      profiles.unshift({
        name: "default",
        configPath: CONFIG_FILE,
        isActive: activeName === "default",
      });
    } catch {}
  }

  return profiles;
}

/**
 * Ensure the "default" profile exists (copy from root config.json).
 */
export async function ensureDefaultProfile(): Promise<void> {
  const defaultDir = getProfileDir("default");
  const defaultConfig = getProfileConfigPath("default");

  try {
    await fs.access(defaultConfig);
    return; // Already exists
  } catch {}

  // Copy root config.json to default profile
  try {
    await fs.access(CONFIG_FILE);
    await fs.mkdir(defaultDir, { recursive: true });
    await fs.copyFile(CONFIG_FILE, defaultConfig);
  } catch {
    // No root config yet; will be created on first start
  }
}

/**
 * Create a new profile by copying the active profile's config.
 */
export async function createProfile(name: string): Promise<void> {
  validateProfileName(name);
  const targetDir = getProfileDir(name);
  const targetConfig = getProfileConfigPath(name);

  try {
    await fs.access(targetConfig);
    throw new Error(`Profile "${name}" already exists`);
  } catch (e: any) {
    if (e.code !== "ENOENT" && !e.message.includes("already exists")) throw e;
    if (e.message.includes("already exists")) throw e;
  }

  // Copy from active profile
  const activeName = await getActiveProfile();
  const sourceConfig =
    activeName === "default"
      ? CONFIG_FILE
      : getProfileConfigPath(activeName);

  await fs.mkdir(targetDir, { recursive: true });
  try {
    await fs.access(sourceConfig);
    await fs.copyFile(sourceConfig, targetConfig);
  } catch {
    // No source config; create minimal default
    await fs.writeFile(
      targetConfig,
      JSON.stringify({ PORT: 3456, Providers: [], Router: {} }, null, 2)
    );
  }
}

/**
 * Delete a profile. Cannot delete the active or default profile.
 */
export async function deleteProfile(name: string): Promise<void> {
  if (name === "default") {
    throw new Error('Cannot delete the "default" profile');
  }
  const active = await getActiveProfile();
  if (name === active) {
    throw new Error(
      `Cannot delete the active profile "${name}". Switch to another profile first.`
    );
  }
  const dir = getProfileDir(name);
  await fs.rm(dir, { recursive: true, force: true });
}
