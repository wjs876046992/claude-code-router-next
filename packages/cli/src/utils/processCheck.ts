import { existsSync, readFileSync, writeFileSync, readdirSync, unlinkSync } from 'fs';
import { PID_FILE, REFERENCE_COUNT_FILE } from '@wengine-ai/claude-code-router-shared';
import find from 'find-process';
import { execSync } from 'child_process';
import { basename, dirname, join, resolve } from 'path';
import { homedir } from 'os';
import JSON5 from 'json5';

// Compute profile PID file paths directly (not via shared constants).
// These are always resolved against the global base dir, *not* HOME_DIR —
// HOME_DIR follows CCR_CONFIG_DIR (i.e. points inside the active profile), so
// deriving the profiles root from it would nest profile dirs into each other.
const HOME_DIR = join(homedir(), '.claude-code-router');
const PROFILES_DIR = join(HOME_DIR, 'profiles');
const ACTIVE_PROFILE_FILE = join(PROFILES_DIR, 'active-profile');

// Mirrors shared PID_FILE: the server always writes its PID inside its own CCR
// config dir, i.e. join(CCR_CONFIG_DIR, PID_FILE_NAME) — which for the default
// profile (no CCR_CONFIG_DIR) is join(HOME_DIR, PID_FILE_NAME).
const PID_FILE_NAME = '.claude-code-router.pid';

/** CCR config dir for a profile name: the base dir for "default". */
function configDirForProfile(name: string): string {
  return name === 'default' ? HOME_DIR : join(PROFILES_DIR, name);
}

function readActiveProfileName(): string {
  try {
    return readFileSync(ACTIVE_PROFILE_FILE, 'utf-8').trim() || 'default';
  } catch {
    return 'default';
  }
}

/**
 * CCR config dir the current CLI invocation targets.
 *
 * An explicit non-base CCR_CONFIG_DIR wins (it may be an arbitrary path, not
 * just profiles/<name>); otherwise the recorded active profile decides.
 */
export function getTargetConfigDir(): string {
  const fromEnv = process.env.CCR_CONFIG_DIR;
  if (fromEnv && resolve(fromEnv) !== resolve(HOME_DIR)) return resolve(fromEnv);
  const profile = readActiveProfileName();
  return profile === 'default' ? HOME_DIR : join(PROFILES_DIR, profile);
}

/** CCR config dir this *server* process is running with. */
export function getOwnConfigDir(): string {
  const fromEnv = process.env.CCR_CONFIG_DIR;
  return fromEnv ? resolve(fromEnv) : HOME_DIR;
}

/**
 * PID file for the dir this invocation targets.
 *
 * Safe for an arbitrary CCR_CONFIG_DIR, unlike {@link getProfilePidFile} which
 * only resolves names under the profiles root.
 */
export function getTargetPidFile(): string {
  return join(getTargetConfigDir(), PID_FILE_NAME);
}

/**
 * Profile label for a config dir, matching the labels derived from a running
 * server's own CCR_CONFIG_DIR (the base dir is the default profile).
 */
function profileLabelForConfigDir(dir: string): string {
  return resolve(dir) === resolve(HOME_DIR) ? 'default' : basename(resolve(dir));
}

/**
 * PID file for a given profile. "default" lives in the base dir, named
 * profiles live in their own directory.
 *
 * Only valid for profiles that live under the profiles root; use
 * {@link getTargetPidFile} for an invocation that may point CCR_CONFIG_DIR at
 * an arbitrary directory.
 */
export function getProfilePidFile(name: string): string {
  return join(configDirForProfile(name), PID_FILE_NAME);
}

/**
 * Profile encoded in this process's own environment, if any.
 *
 * A running server always has CCR_CONFIG_DIR pointing inside its profile
 * directory; its absence means the process belongs to the default profile.
 * A CCR_CONFIG_DIR naming the *base* dir is treated as "no profile pinned":
 * that dir is the default profile's home, so it identifies nothing, and
 * honoring it would let a stale export silently override the active profile.
 */
export function getEnvProfileName(): string | null {
  const fromEnv = process.env.CCR_CONFIG_DIR;
  if (!fromEnv) return null;
  // The base dir is the default profile's home, so it pins nothing.
  if (resolve(fromEnv) === resolve(HOME_DIR)) return null;
  return basename(resolve(fromEnv));
}

/**
 * The profile a *CLI invocation* should act on.
 *
 * CCR_CONFIG_DIR wins when present (e.g. children re-spawned by a profile
 * server). Otherwise fall back to the globally recorded active profile.
 */
export function getCurrentProfileName(): string {
  return getEnvProfileName() ?? (() => {
    try {
      const active = readFileSync(ACTIVE_PROFILE_FILE, 'utf-8').trim();
      return active || 'default';
    } catch {
      return 'default';
    }
  })();
}

/** Resolved CCR_CONFIG_DIR from a /proc/<pid>/environ file, or null if unset. */
function parseConfigDirFromEnvFile(envFile: string): string | null {
  // /proc/<pid>/environ is NUL-separated KEY=VALUE pairs.
  for (const entry of readFileSync(envFile, 'utf-8').split('\0')) {
    if (entry.startsWith('CCR_CONFIG_DIR=')) {
      const value = entry.slice('CCR_CONFIG_DIR='.length);
      return value ? resolve(value) : null;
    }
  }
  return null;
}

/**
 * Whether `pid` is a live server whose CCR_CONFIG_DIR is exactly `configDir`.
 *
 * Liveness alone is not enough after a reboot: PID files survive, and the PIDs
 * they recorded get reused by unrelated processes. Treating such a process as
 * "our server" made `ccr start` print "server is running" and skip starting the
 * profile at all. On Linux we confirm the process really serves this dir by
 * inspecting its environment and command line; elsewhere we fall back to the
 * liveness check alone.
 *
 * Compares the full resolved path rather than a basename, so two config dirs
 * that merely share a last path segment (e.g. /a/work and /b/work) are not
 * conflated. The default profile is the case where CCR_CONFIG_DIR is unset.
 */
function isServerForConfigDir(pid: number, configDir: string): boolean {
  try {
    process.kill(pid, 0);
  } catch {
    return false; // Not running.
  }

  if (process.platform !== 'linux') return true;

  const procDir = `/proc/${pid}`;
  try {
    const cmdline = readFileSync(join(procDir, 'cmdline'), 'utf-8');
    if (!cmdline.includes('cli.js') && !cmdline.includes('claude-code-router')) {
      return false; // Some unrelated process reused this PID.
    }

    // The process env is authoritative for which dir it serves: a
    // default-profile server carries no CCR_CONFIG_DIR.
    const envDir = parseConfigDirFromEnvFile(join(procDir, 'environ'));
    const expectedDir = resolve(configDir);
    if (expectedDir === resolve(HOME_DIR)) return envDir === null;
    return envDir === expectedDir;
  } catch {
    // /proc is unreadable (permissions, or a non-Linux /proc layout). Keep the
    // liveness result rather than wrongly reporting the server as stopped.
    return true;
  }
}

/**
 * Read a PID file, returning the PID only if it is still a live server for the
 * config dir that owns the file (the file always sits inside its config dir).
 */
function readPidFile(path: string): number | null {
  try {
    const pid = parseInt(readFileSync(path, 'utf-8').trim());
    if (isNaN(pid)) return null;
    if (!isServerForConfigDir(pid, dirname(path))) return null;
    return pid;
  } catch {
    return null;
  }
}

function getProfilePidFiles(): { name: string; path: string }[] {
  const files: { name: string; path: string }[] = [];
  // Default profile PID
  files.push({ name: 'default', path: getProfilePidFile('default') });
  // Named profile PIDs
  try {
    const entries = readdirSync(PROFILES_DIR, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory() && !entry.name.startsWith('.')) {
        files.push({ name: entry.name, path: getProfilePidFile(entry.name) });
      }
    }
  } catch {}
  return files;
}

/**
 * Find a running server, preferring the current profile.
 *
 * Multiple profiles can run at once (each with its own PORT), so this must not
 * blindly return whichever PID file happens to come first: `ccr status` and the
 * UI should report the *current* profile's server whenever one is running.
 */
function findActivePidFile(): { name: string; path: string; pid: number } | null {
  const candidates = getProfilePidFiles();
  const current = getCurrentProfileName();

  // The invocation's own target dir first (covers a custom CCR_CONFIG_DIR that
  // lives outside the profiles root), then the recorded active profile, then
  // any other profile — so status/stop report the caller's own server.
  const targetDir = getTargetConfigDir();
  const targetPidFile = join(targetDir, PID_FILE_NAME);
  if (!candidates.some((c) => c.path === targetPidFile)) {
    candidates.unshift({ name: profileLabelForConfigDir(targetDir), path: targetPidFile });
  }

  candidates.sort((a, b) => {
    if (a.path === targetPidFile) return -1;
    if (b.path === targetPidFile) return 1;
    if (a.name === current) return -1;
    if (b.name === current) return 1;
    return 0;
  });

  for (const pf of candidates) {
    const pid = readPidFile(pf.path);
    if (pid !== null) return { name: pf.name, path: pf.path, pid };
  }
  return null;
}

export async function isProcessRunning(pid: number): Promise<boolean> {
    try {
        const processes = await find('pid', pid);
        return processes.length > 0;
    } catch (error) {
        return false;
    }
}

export function incrementReferenceCount() {
    let count = 0;
    if (existsSync(REFERENCE_COUNT_FILE)) {
        count = parseInt(readFileSync(REFERENCE_COUNT_FILE, 'utf-8')) || 0;
    }
    count++;
    writeFileSync(REFERENCE_COUNT_FILE, count.toString());
}

export function decrementReferenceCount() {
    let count = 0;
    if (existsSync(REFERENCE_COUNT_FILE)) {
        count = parseInt(readFileSync(REFERENCE_COUNT_FILE, 'utf-8')) || 0;
    }
    count = Math.max(0, count - 1);
    writeFileSync(REFERENCE_COUNT_FILE, count.toString());
}

export function getReferenceCount(): number {
    if (!existsSync(REFERENCE_COUNT_FILE)) {
        return 0;
    }
    return parseInt(readFileSync(REFERENCE_COUNT_FILE, 'utf-8')) || 0;
}

/**
 * Whether *this profile's* server is running.
 *
 * Deliberately profile-scoped: several profiles may run concurrently, so a
 * server belonging to another profile must not make `ccr start`/`run()` believe
 * the current profile is already up. That mistake made a freshly spawned
 * profile child print "server is running" and exit, leaving the profile without
 * a server (and its usage/stats accumulating in the other profile's dir).
 */
export function isServiceRunning(): boolean {
    return readPidFile(join(getTargetConfigDir(), PID_FILE_NAME)) !== null;
}

/**
 * Whether the profile *this process serves* is already up.
 *
 * Used by `run()` as its own re-entry guard. It must resolve the profile from
 * the process environment only: a default-profile server starting while the
 * global active-profile file names another profile would otherwise inspect that
 * other profile's PID file and refuse to start.
 */
export function isOwnServiceRunning(): boolean {
    return readPidFile(join(getOwnConfigDir(), PID_FILE_NAME)) !== null;
}

export function savePid(pid: number) {
    writeFileSync(PID_FILE, pid.toString());
}

/**
 * Remove this profile's PID file. Other profiles keep theirs so their running
 * servers stay discoverable.
 */
export function cleanupPidFile() {
    try {
        // Remove the PID file of the dir this invocation targets, so a custom
        // CCR_CONFIG_DIR cleans up its own file rather than a namesake under
        // the profiles root.
        const pidFile = join(getTargetConfigDir(), PID_FILE_NAME);
        if (existsSync(pidFile)) {
            const fs = require('fs');
            fs.unlinkSync(pidFile);
        }
    } catch {}
}

export function getServicePid(): number | null {
    const active = findActivePidFile();
    return active ? active.pid : null;
}

/**
 * Stop the server recorded in `pidFile`, but only after confirming the PID
 * really belongs to a ccr server whose config dir owns that file.
 *
 * A blind `kill(readPidFile())` is unsafe: PID files survive a reboot, and the
 * PIDs they hold get reused, so stopping could signal an unrelated process.
 * Returns true only when a verified server was signalled.
 *
 * The expected config dir comes from the file's own location (a PID file always
 * sits inside its config dir), so callers cannot pair a file with the wrong
 * profile.
 */
export function stopServiceAtPidFile(pidFile: string): boolean {
    const pid = readPidFile(pidFile);
    if (pid === null) return false;
    try {
        process.kill(pid);
    } catch {
        return false;
    }
    try {
        unlinkSync(pidFile);
    } catch {}
    return true;
}

/**
 * Read config.json from an explicit config dir.
 *
 * Deliberately does NOT fall back to `readConfigFile()`: that resolves
 * CONFIG_FILE through the shared HOME_DIR, which follows CCR_CONFIG_DIR — so
 * asking it for the *default* profile's config while CCR_CONFIG_DIR names
 * another profile returns that other profile's file. Read the requested path
 * directly and fall back to defaults only when the file is genuinely absent.
 */
async function readRunningProfileConfig(configDir: string): Promise<Record<string, any>> {
    try {
        const raw = readFileSync(join(configDir, 'config.json'), 'utf-8');
        return JSON5.parse(raw);
    } catch {
        return {};
    }
}

export async function getServiceInfo() {
    const active = findActivePidFile();
    const running = active !== null;
    const pid = active ? active.pid : null;
    const profileName = active ? active.name : 'default';
    const pidFile = active ? active.path : join(getTargetConfigDir(), PID_FILE_NAME);
    // Read the config from the dir that holds the PID file, so a custom
    // CCR_CONFIG_DIR reports its own PORT and endpoint.
    const configDir = active ? dirname(active.path) : getTargetConfigDir();
    const config = await readRunningProfileConfig(configDir);
    const port = config.PORT || 3456;

    return {
        running,
        pid,
        port,
        endpoint: `http://127.0.0.1:${port}`,
        pidFile,
        profile: profileName,
        referenceCount: getReferenceCount()
    };
}

export async function closeService() {
    // Check reference count
    const referenceCount = getReferenceCount();

    // Only stop the service if reference count is 0
    if (referenceCount === 0) {
        const pid = getServicePid();
        if (pid && await isServiceRunning()) {
            try {
                // Kill the service process
                process.kill(pid, 'SIGTERM');
            } catch (e) {
                // Ignore kill errors
            }
        }
    }
}
