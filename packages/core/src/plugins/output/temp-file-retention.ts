import { lstat, opendir, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import type { Stats } from 'node:fs';

const RETENTION_MS = 60 * 60 * 1000;
const INTERVAL_MS = 10 * 60 * 1000;
const LEGACY_NAME = /^session-[A-Za-z0-9_.-]+-(\d{13})\.json$/;
// This namespace is exclusively used by the atomic publisher. Never match generic .tmp files.
const PUBLICATION_NAME = /^\.ccr-tmp-[1-9]\d*-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.tmp$/;
const activeDirectories = new Set<string>();
const pathLocks = new Map<string, Promise<void>>();
const schedules = new Map<string, { stop: () => void; users: number }>();

/** Serialize publication/pruning of one path across handler instances, not an entire scan. */
export async function withTempFilePathLock<T>(filePath: string, action: () => Promise<T>): Promise<T> {
  const key = resolve(filePath);
  const previous = pathLocks.get(key);
  let release!: () => void;
  const current = new Promise<void>((done) => { release = done; });
  pathLocks.set(key, current);
  try {
    await previous;
    return await action();
  } finally {
    release();
    if (pathLocks.get(key) === current) pathLocks.delete(key);
  }
}

function sameIdentity(a: Stats, b: Stats): boolean {
  return a.dev === b.dev && a.ino === b.ino;
}

async function isSameDirectory(baseDir: string, original: Stats): Promise<boolean> {
  try {
    const current = await lstat(baseDir);
    return current.isDirectory() && !current.isSymbolicLink() && sameIdentity(original, current);
  } catch {
    return false;
  }
}

function pause(): Promise<void> {
  return new Promise((done) => {
    const timer = setTimeout(done, 10);
    timer.unref();
  });
}

/**
 * Bounded-memory, sequential scan. No recursive traversal and no directory-wide request lock.
 * A recheck narrows cross-process races but stat/unlink cannot be made atomic across processes;
 * these files contain disposable metrics, not authoritative user data.
 */
async function pruneDirectory(
  baseDir: string,
  cutoff: number,
  matches: (name: string) => boolean,
  signal?: AbortSignal,
): Promise<number> {
  const directory = resolve(baseDir);
  if (signal?.aborted || activeDirectories.has(directory)) return 0;
  activeDirectories.add(directory);
  let deleted = 0;
  try {
    const root = await lstat(directory);
    if (!root.isDirectory() || root.isSymbolicLink() || signal?.aborted) return 0;
    const dir = await opendir(directory, { bufferSize: 32 });
    try {
      let examined = 0;
      let directorySafe = true;
      // for-await closes fs.Dir on completion, break, abort, or an iterator exception.
      for await (const entry of dir) {
        if (signal?.aborted || !directorySafe) break;
        try {
          if (!entry.isFile() || entry.isSymbolicLink() || !matches(entry.name)) continue;
          const filePath = join(directory, entry.name);
          try {
            const original = await lstat(filePath);
            if (!original.isFile() || original.isSymbolicLink() || original.mtimeMs >= cutoff) continue;
            const removed = await withTempFilePathLock(filePath, async () => {
              if (signal?.aborted || !await isSameDirectory(directory, root)) return false;
              const current = await lstat(filePath);
              if (!current.isFile() || current.isSymbolicLink() || !sameIdentity(original, current)
                || current.mtimeMs !== original.mtimeMs || current.mtimeMs >= cutoff) return false;
              if (signal?.aborted) return false;
              await unlink(filePath);
              return true;
            });
            if (removed) deleted++;
          } catch {
            // ENOENT, EACCES, EPERM, and other per-entry failures are best-effort.
          }
        } finally {
          // Count skipped entries too: millions of unrelated names must not monopolize the loop.
          if (++examined % 64 === 0) {
            await pause();
            directorySafe = !signal?.aborted && await isSameDirectory(directory, root);
          }
        }
      }
    } finally {
      // Also covers an exception before the iterator starts. Ignore ERR_DIR_CLOSED after for-await.
      await dir.close().catch(() => {});
    }
  } catch {
    // Missing/replaced/inaccessible directories or interrupted enumeration retry on the next pass.
  } finally {
    activeDirectories.delete(directory);
  }
  return deleted;
}

/** Prune only files owned by this handler, including abandoned exclusive publication files. */
export function pruneTempFileOutputFiles(
  baseDir: string,
  prefix: string,
  extension: string,
  retentionMs: number,
  signal?: AbortSignal,
): Promise<number> {
  if (!Number.isFinite(retentionMs) || retentionMs <= 0) return Promise.resolve(0);
  const start = `${prefix}-`;
  const suffix = extension ? `.${extension}` : '';
  return pruneDirectory(baseDir, Date.now() - retentionMs, (name) => {
    if (PUBLICATION_NAME.test(name)) return true;
    // Never treat arbitrary .tmp names as output when the custom extension is empty.
    return !name.endsWith('.tmp') && name.startsWith(start) && name.endsWith(suffix);
  }, signal);
}

/** Only legacy timestamped metrics in the old root; never touch new files or descend into v2. */
export function pruneLegacyTokenSpeedFiles(baseDir: string, signal?: AbortSignal): Promise<number> {
  const cutoff = Date.now() - RETENTION_MS;
  return pruneDirectory(baseDir, cutoff, (name) => {
    const match = LEGACY_NAME.exec(name);
    return match !== null && Number(match[1]) < cutoff;
  }, signal);
}

/** Shared unrefed schedules; disposal aborts a running pass when the last owner leaves. */
export function scheduleTempFileCleanup(
  key: string,
  prune: (signal: AbortSignal) => Promise<number>,
  firstDelayMs: number,
): () => void {
  let schedule = schedules.get(key);
  if (!schedule) {
    const controller = new AbortController();
    let interval: ReturnType<typeof setInterval> | undefined;
    const run = () => {
      if (!controller.signal.aborted) {
        // Keep both synchronous and asynchronous failures away from startup/timer callbacks.
        void Promise.resolve().then(() => prune(controller.signal)).catch(() => {});
      }
    };
    const first = setTimeout(() => {
      if (controller.signal.aborted) return;
      run();
      interval = setInterval(run, INTERVAL_MS);
      interval.unref();
    }, firstDelayMs);
    first.unref();
    schedule = {
      users: 0,
      stop: () => {
        controller.abort();
        clearTimeout(first);
        if (interval) clearInterval(interval);
      },
    };
    schedules.set(key, schedule);
  }
  schedule.users++;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (--schedule!.users === 0) {
      schedule!.stop();
      schedules.delete(key);
    }
  };
}

/**
 * Independent of the token-speed plugin's enabled state. No permanent migration marker:
 * concurrently running older versions may keep publishing in the old root.
 * The optional disposer is useful for service shutdown and isolated tests.
 */
export function startLegacyTokenSpeedCleanup(
  baseDir = join(tmpdir(), 'claude-code-router'),
): () => void {
  return scheduleTempFileCleanup(`legacy:${resolve(baseDir)}`,
    (signal) => pruneLegacyTokenSpeedFiles(baseDir, signal), 1000);
}
