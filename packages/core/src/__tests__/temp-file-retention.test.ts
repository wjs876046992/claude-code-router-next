import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import * as fs from 'node:fs';
import * as fsPromises from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { pruneLegacyTokenSpeedFiles, pruneTempFileOutputFiles, startLegacyTokenSpeedCleanup } from '../plugins/output/temp-file-retention';

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, readdirSync: vi.fn(actual.readdirSync) };
});
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, lstat: vi.fn(actual.lstat), opendir: vi.fn(actual.opendir),
    unlink: vi.fn(actual.unlink), readdir: vi.fn(actual.readdir) };
});

const testRoot = mkdtempSync(join(tmpdir(), 'ccr-retention-test-'));
const disposers: (() => void)[] = [];
let index = 0;
const HOUR = 3600000;
function directory() {
  const path = join(testRoot, String(index++));
  mkdirSync(path);
  return path;
}
function file(baseDir: string, name: string, age = 2 * HOUR) {
  const path = join(baseDir, name);
  writeFileSync(path, 'metric');
  const time = new Date(Date.now() - age);
  utimesSync(path, time, time);
  return path;
}
function legacy(key: string, age = 2 * HOUR) {
  return `session-${key}-${Date.now() - age}.json`;
}
function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}
beforeEach(async () => {
  const actual = await vi.importActual<typeof fsPromises>('node:fs/promises');
  for (const name of ['lstat', 'opendir', 'unlink', 'readdir'] as const) {
    vi.mocked(fsPromises[name]).mockReset().mockImplementation(actual[name] as any);
  }
});
afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose();
  vi.restoreAllMocks();
  vi.useRealTimers();
});
afterAll(() => rmSync(testRoot, { recursive: true, force: true }));

describe('legacy streaming migration', () => {
  it('requires old filename timestamp AND old mtime and preserves everything else', async () => {
    const dir = directory();
    const expired = file(dir, legacy('pi-key._-'));
    const preserved = [
      file(dir, legacy('recent-name', 1000)),
      file(dir, legacy('recent-mtime'), 1000),
      file(dir, 'session-key.json'),
      file(dir, 'session-key-123.json'),
      file(dir, `session-key:-${Date.now() - 2 * HOUR}.json`),
      file(dir, 'config.json'), file(dir, 'usage.db'), file(dir, 'ccr.log'),
      file(dir, legacy('future', -HOUR)),
      file(dir, '.ccr-tmp-12-00000000-0000-4000-8000-000000000000.tmp'),
    ];
    const nested = join(dir, legacy('directory')); mkdirSync(nested);
    const nestedMetric = file(nested, legacy('nested'));
    const target = file(dir, 'outside-target');
    const link = join(dir, legacy('link')); symlinkSync(target, link);
    expect(await pruneLegacyTokenSpeedFiles(dir)).toBe(1);
    expect(existsSync(expired)).toBe(false);
    for (const path of [...preserved, nested, nestedMetric, target, link]) expect(existsSync(path)).toBe(true);
    expect(await pruneLegacyTokenSpeedFiles(dir)).toBe(0);
    expect(existsSync(dir)).toBe(true);
  });

  it('retains strict one-hour boundaries for both timestamps and mtime', async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-01-01T12:00:00Z'));
    const dir = directory();
    const timestampBoundary = file(dir, legacy('name-boundary', HOUR));
    const mtimeBoundary = file(dir, legacy('mtime-boundary'), HOUR);
    file(dir, legacy('old'));
    expect(await pruneLegacyTokenSpeedFiles(dir)).toBe(1);
    expect(existsSync(timestampBoundary)).toBe(true);
    expect(existsSync(mtimeBoundary)).toBe(true);
  });

  it('rejects symlink roots without enumeration', async () => {
    const target = directory(); file(target, legacy('keep'));
    const dir = join(testRoot, `link-${index++}`); symlinkSync(target, dir);
    vi.mocked(fsPromises.opendir).mockClear();
    expect(await pruneLegacyTokenSpeedFiles(dir)).toBe(0);
    expect(fsPromises.opendir).not.toHaveBeenCalled();
    expect(readdirSync(target)).toHaveLength(1);
  });

  it.each(['ENOENT', 'EACCES', 'EPERM'])('continues after %s for one entry', async (code) => {
    const dir = directory();
    file(dir, legacy('blocked')); file(dir, legacy('good'));
    vi.mocked(fsPromises.unlink).mockRejectedValueOnce(Object.assign(new Error(code), { code }));
    expect(await pruneLegacyTokenSpeedFiles(dir)).toBe(1);
    expect(await pruneLegacyTokenSpeedFiles(dir)).toBe(1);
  });

  it('continues after an entry disappears or cannot be inspected', async () => {
    const dir = directory();
    const failed = file(dir, legacy('bad')); file(dir, legacy('good'));
    const actual = await vi.importActual<typeof fsPromises>('node:fs/promises');
    vi.mocked(fsPromises.lstat).mockImplementation(async (path, options?: any) => {
      if (path === failed) throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
      return actual.lstat(path, options) as any;
    });
    expect(await pruneLegacyTokenSpeedFiles(dir)).toBe(1);
    expect(existsSync(failed)).toBe(true);
  });

  it('rechecks mtime and inode before unlink so refreshed or replaced metrics survive', async () => {
    const dir = directory();
    const refreshed = file(dir, legacy('refreshed'));
    const replaced = file(dir, legacy('replaced'));
    const actual = await vi.importActual<typeof fsPromises>('node:fs/promises');
    const calls = new Map<string, number>();
    vi.mocked(fsPromises.lstat).mockImplementation(async (path, options?: any) => {
      const key = String(path); const count = (calls.get(key) || 0) + 1; calls.set(key, count);
      const result = await actual.lstat(path, options);
      if (key === refreshed && count === 1) utimesSync(key, new Date(), new Date());
      if (key === replaced && count === 2) return { ...result, ino: Number(result.ino) + 1,
        isFile: () => true, isSymbolicLink: () => false } as any;
      return result as any;
    });
    expect(await pruneLegacyTokenSpeedFiles(dir)).toBe(0);
    expect(existsSync(refreshed)).toBe(true);
    expect(existsSync(replaced)).toBe(true);
  });

  it('rejects an entry changed into a symlink after enumeration', async () => {
    const dir = directory(); const candidate = file(dir, legacy('candidate'));
    const target = file(dir, 'target');
    const actual = await vi.importActual<typeof fsPromises>('node:fs/promises');
    let checked = false;
    vi.mocked(fsPromises.lstat).mockImplementation(async (path, options?: any) => {
      if (path === candidate && !checked) { checked = true; rmSync(candidate); symlinkSync(target, candidate); }
      return actual.lstat(path, options) as any;
    });
    expect(await pruneLegacyTokenSpeedFiles(dir)).toBe(0);
    expect(lstatSync(candidate).isSymbolicLink()).toBe(true);
    expect(existsSync(target)).toBe(true);
  });

  it('rejects a root replaced with a symlink before unlink', async () => {
    const dir = directory(); file(dir, legacy('candidate'));
    const target = directory(); const protectedFile = file(target, legacy('candidate'));
    const actual = await vi.importActual<typeof fsPromises>('node:fs/promises');
    let rootChecks = 0;
    vi.mocked(fsPromises.lstat).mockImplementation(async (path, options?: any) => {
      if (path === dir && ++rootChecks === 2) { rmSync(dir, { recursive: true }); symlinkSync(target, dir); }
      return actual.lstat(path, options) as any;
    });
    expect(await pruneLegacyTokenSpeedFiles(dir)).toBe(0);
    expect(existsSync(protectedFile)).toBe(true);
  });

  it('retries after missing/inaccessible root and interrupted iterator, always closing handles', async () => {
    const dir = directory(); file(dir, legacy('candidate'));
    vi.mocked(fsPromises.opendir).mockRejectedValueOnce(Object.assign(new Error('EPERM'), { code: 'EPERM' }));
    expect(await pruneLegacyTokenSpeedFiles(dir)).toBe(0);
    const close = vi.fn(async () => {});
    vi.mocked(fsPromises.opendir).mockResolvedValueOnce({
      close, async *[Symbol.asyncIterator]() { throw new Error('interrupted'); },
    } as any);
    expect(await pruneLegacyTokenSpeedFiles(dir)).toBe(0);
    expect(close).toHaveBeenCalledTimes(1);
    expect(await pruneLegacyTokenSpeedFiles(dir)).toBe(1);
    const missing = join(testRoot, `missing-${index++}`);
    expect(await pruneLegacyTokenSpeedFiles(missing)).toBe(0);
    mkdirSync(missing); file(missing, legacy('later'));
    expect(await pruneLegacyTokenSpeedFiles(missing)).toBe(1);
  });

  it('streams a lazy 3-million logical fixture, bounded work/concurrency, including skipped names', async () => {
    const dir = directory();
    const rootInfo = lstatSync(dir);
    const controller = new AbortController();
    let produced = 0; let activeIO = 0; let maximumIO = 0;
    let timerServiced = false;
    const close = vi.fn(async () => {});
    const returned = vi.fn();
    // No array of names: the iterator could produce 3M, but cancellation limits this test's runtime.
    vi.mocked(fsPromises.opendir).mockResolvedValueOnce({
      close,
      async *[Symbol.asyncIterator]() {
        try {
          for (let n = 0; n < 3000000; n++) {
            produced++;
            yield { name: `unrelated-${n}.json`, isFile: () => true, isSymbolicLink: () => false };
          }
        } finally { returned(); }
      },
    } as any);
    vi.mocked(fsPromises.lstat).mockImplementation(async () => {
      activeIO++; maximumIO = Math.max(maximumIO, activeIO);
      await Promise.resolve(); activeIO--; return rootInfo;
    });
    vi.mocked(fsPromises.readdir).mockClear(); vi.mocked(fs.readdirSync).mockClear();
    vi.mocked(fsPromises.opendir).mockClear();
    const timer = setTimeout(() => { timerServiced = true; controller.abort(); }, 25);
    try {
      expect(await pruneLegacyTokenSpeedFiles(dir, controller.signal)).toBe(0);
    } finally { clearTimeout(timer); }
    expect(timerServiced).toBe(true);
    expect(produced).toBeGreaterThanOrEqual(64);
    expect(produced).toBeLessThanOrEqual(256);
    expect(maximumIO).toBe(1);
    expect(returned).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
    expect(fsPromises.opendir).toHaveBeenCalledWith(dir, { bufferSize: 32 });
    expect(fsPromises.readdir).not.toHaveBeenCalled();
    expect(fs.readdirSync).not.toHaveBeenCalled();
  });

  it('aborts a real for-await scan and closes its fs.Dir handle', async () => {
    const dir = directory();
    for (let n = 0; n < 128; n++) file(dir, `unrelated-${n}.json`);
    const actual = await vi.importActual<typeof fsPromises>('node:fs/promises');
    let handle!: Awaited<ReturnType<typeof fsPromises.opendir>>;
    vi.mocked(fsPromises.opendir).mockImplementationOnce(async (...args: any[]) => {
      handle = await (actual.opendir as any)(...args); return handle;
    });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5);
    try { expect(await pruneLegacyTokenSpeedFiles(dir, controller.signal)).toBe(0); }
    finally { clearTimeout(timer); }
    await expect(handle.read()).rejects.toMatchObject({ code: 'ERR_DIR_CLOSED' });
  });

  it('keeps deletion I/O sequential even for many matching entries', async () => {
    const dir = directory();
    for (let n = 0; n < 70; n++) file(dir, legacy(`key-${n}`));
    const actual = await vi.importActual<typeof fsPromises>('node:fs/promises');
    let active = 0; let maximum = 0;
    vi.mocked(fsPromises.unlink).mockImplementation(async (path) => {
      active++; maximum = Math.max(maximum, active);
      await new Promise((done) => setTimeout(done, 1));
      try { return await actual.unlink(path); } finally { active--; }
    });
    expect(await pruneLegacyTokenSpeedFiles(dir)).toBe(70);
    expect(maximum).toBe(1);
  });

  it('deduplicates simultaneous directory passes across legacy and owned cleanup', async () => {
    const dir = directory(); file(dir, legacy('candidate'));
    const actual = await vi.importActual<typeof fsPromises>('node:fs/promises');
    const started = gate(); const resume = gate();
    vi.mocked(fsPromises.opendir).mockImplementationOnce(async (...args: any[]) => {
      started.resolve(); await resume.promise; return (actual.opendir as any)(...args);
    });
    const scan = pruneLegacyTokenSpeedFiles(dir); await started.promise;
    expect(await pruneLegacyTokenSpeedFiles(dir)).toBe(0);
    expect(await pruneTempFileOutputFiles(dir, 'session', 'json', HOUR)).toBe(0);
    resume.resolve(); expect(await scan).toBe(1);
  });
});

describe('owned stale publication retention', () => {
  it('only recognizes exact generated .tmp names in the supplied owned directory', async () => {
    const dir = directory();
    const expired = file(dir, '.ccr-tmp-123-00000000-0000-4000-8000-000000000000.tmp');
    const preserved = [
      file(dir, '.ccr-tmp-123-00000000-0000-4000-8000-000000000001.tmp', 1000),
      file(dir, '.ccr-tmp-123-not-a-uuid.tmp'), file(dir, 'session-key.json.tmp'),
      file(dir, 'random.tmp'), file(dir, '.ccr-tmp-0-00000000-0000-4000-8000-000000000000.tmp'),
    ];
    const nested = join(dir, 'nested'); mkdirSync(nested);
    const nestedFile = file(nested, '.ccr-tmp-123-00000000-0000-4000-8000-000000000000.tmp');
    expect(await pruneTempFileOutputFiles(dir, 'session', 'json', HOUR)).toBe(1);
    expect(existsSync(expired)).toBe(false);
    for (const path of [...preserved, nestedFile]) expect(existsSync(path)).toBe(true);
    expect(await pruneTempFileOutputFiles(dir, 'session', 'json', HOUR)).toBe(0);
  });

  it('matches custom prefixes literally and preserves generic .tmp for empty extensions', async () => {
    const dir = directory(); file(dir, 'tokens.[x]-key'); file(dir, 'tokens.[x]-key.json');
    const unrelated = file(dir, 'tokens.x-key'); const tmp = file(dir, 'tokens.[x]-key.tmp');
    expect(await pruneTempFileOutputFiles(dir, 'tokens.[x]', '', HOUR)).toBe(2);
    expect(existsSync(unrelated)).toBe(true); expect(existsSync(tmp)).toBe(true);
  });
});

describe('independent legacy scheduler', () => {
  it('deduplicates delayed unrefed schedules and periodically retries without migration markers', async () => {
    vi.useFakeTimers();
    const dir = directory();
    const timeout = vi.spyOn(globalThis, 'setTimeout');
    const interval = vi.spyOn(globalThis, 'setInterval');
    const stopOne = startLegacyTokenSpeedCleanup(dir);
    const stopTwo = startLegacyTokenSpeedCleanup(dir);
    disposers.push(stopOne, stopTwo);
    expect(timeout).toHaveBeenCalledExactlyOnceWith(expect.any(Function), 1000);
    expect(timeout.mock.results[0].value.hasRef()).toBe(false);
    const root = lstatSync(dir);
    const scanned = gate();
    vi.mocked(fsPromises.lstat).mockImplementation(async () => { scanned.resolve(); return root; });
    vi.mocked(fsPromises.opendir).mockRejectedValue(Object.assign(new Error('EACCES'), { code: 'EACCES' }));
    vi.mocked(fsPromises.opendir).mockClear();
    await vi.advanceTimersByTimeAsync(999);
    expect(fsPromises.opendir).not.toHaveBeenCalled();
    stopOne(); stopOne();
    await vi.advanceTimersByTimeAsync(1); await scanned.promise;
    expect(fsPromises.opendir).toHaveBeenCalledTimes(1);
    expect(interval).toHaveBeenCalledWith(expect.any(Function), 600000);
    expect(interval.mock.results[0].value.hasRef()).toBe(false);
    await vi.advanceTimersByTimeAsync(600000);
    expect(fsPromises.opendir).toHaveBeenCalledTimes(2);
    expect(readdirSync(dir)).toEqual([]);
    stopTwo();
    await vi.advanceTimersByTimeAsync(600000);
    expect(fsPromises.opendir).toHaveBeenCalledTimes(2);
  });
});
