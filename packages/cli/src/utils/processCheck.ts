import { existsSync, readFileSync, writeFileSync, readdirSync } from 'fs';
import { PID_FILE, REFERENCE_COUNT_FILE } from '@wengine-ai/claude-code-router-shared';
import { readConfigFile } from '.';
import find from 'find-process';
import { execSync } from 'child_process';
import { join } from 'path';
import { homedir } from 'os';

// Compute profile PID file paths directly (not via shared constants)
const HOME_DIR = join(homedir(), '.claude-code-router');
const PROFILES_DIR = join(HOME_DIR, 'profiles');

function getProfilePidFiles(): { name: string; path: string }[] {
  const files: { name: string; path: string }[] = [];
  // Default profile PID
  files.push({ name: 'default', path: PID_FILE });
  // Named profile PIDs
  try {
    const entries = readdirSync(PROFILES_DIR, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory() && !entry.name.startsWith('.')) {
        const pidFile = join(PROFILES_DIR, entry.name, '.claude-code-router.pid');
        files.push({ name: entry.name, path: pidFile });
      }
    }
  } catch {}
  return files;
}

function findActivePidFile(): { name: string; path: string; pid: number } | null {
  for (const pf of getProfilePidFiles()) {
    try {
      const pid = parseInt(readFileSync(pf.path, 'utf-8').trim());
      if (!isNaN(pid)) {
        // Check if process exists
        try {
          process.kill(pid, 0);
          return { name: pf.name, path: pf.path, pid };
        } catch {}
      }
    } catch {}
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

export function isServiceRunning(): boolean {
    return findActivePidFile() !== null;
}

export function savePid(pid: number) {
    writeFileSync(PID_FILE, pid.toString());
}

export function cleanupPidFile() {
    // Clean up all profile PID files
    for (const pf of getProfilePidFiles()) {
        try {
            if (existsSync(pf.path)) {
                const fs = require('fs');
                fs.unlinkSync(pf.path);
            }
        } catch {}
    }
}

export function getServicePid(): number | null {
    const active = findActivePidFile();
    return active ? active.pid : null;
}

export async function getServiceInfo() {
    const active = findActivePidFile();
    const running = active !== null;
    const pid = active ? active.pid : null;
    const profileName = active ? active.name : 'default';
    const pidFile = active ? active.path : PID_FILE;
    const config = await readConfigFile();
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
