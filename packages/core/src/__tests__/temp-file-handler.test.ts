import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import * as fsPromises from 'node:fs/promises';
import * as crypto from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sanitizeTempFileKey } from '@wengine-ai/claude-code-router-shared';
import { TempFileOutputHandler, type TempFileOutputConfig } from '../plugins/output/temp-file-handler';

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, open: vi.fn(actual.open), rename: vi.fn(actual.rename),
    lstat: vi.fn(actual.lstat), unlink: vi.fn(actual.unlink), opendir: vi.fn(actual.opendir) };
});
vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:crypto')>();
  return { ...actual, randomUUID: vi.fn(actual.randomUUID) };
});

const subdirectory = `ccr-writer-test-${process.pid}-${Date.now()}`;
const testDir = join(tmpdir(), subdirectory);
let index = 0;
const handlers: TempFileOutputHandler[] = [];
function createHandler(config: TempFileOutputConfig = {}) {
  const handler = new TempFileOutputHandler({ subdirectory: join(subdirectory, String(index++)), retentionMs: 0, ...config });
  handlers.push(handler);
  mkdirSync(handler.getBaseDir(), { recursive: true });
  return handler;
}
function createFile(handler: TempFileOutputHandler, name: string, old = true) {
  const path = join(handler.getBaseDir(), name);
  writeFileSync(path, 'old');
  if (old) utimesSync(path, new Date(Date.now() - 7200000), new Date(Date.now() - 7200000));
  return path;
}
function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}
beforeEach(async () => {
  const actual = await vi.importActual<typeof fsPromises>('node:fs/promises');
  for (const name of ['open', 'rename', 'lstat', 'unlink', 'opendir'] as const) {
    vi.mocked(fsPromises[name]).mockReset().mockImplementation(actual[name] as any);
  }
  const actualCrypto = await vi.importActual<typeof crypto>('node:crypto');
  vi.mocked(crypto.randomUUID).mockReset().mockImplementation(actualCrypto.randomUUID);
});
afterEach(() => {
  for (const handler of handlers.splice(0)) handler.dispose();
  vi.restoreAllMocks();
  vi.useRealTimers();
});
afterAll(() => rmSync(testDir, { recursive: true, force: true }));

describe('TempFileOutputHandler atomic output', () => {
  it('uses exclusive pid/UUID temporary names and atomically publishes exact names', async () => {
    const handler = createHandler();
    vi.mocked(fsPromises.open).mockClear();
    vi.mocked(fsPromises.rename).mockClear();
    expect(await handler.output({ tokens: 42 }, { metadata: { sessionId: 'key' } })).toBe(true);
    const temporary = vi.mocked(fsPromises.open).mock.calls[0][0] as string;
    expect(temporary).toMatch(/\.ccr-tmp-\d+-[0-9a-f-]{36}\.tmp$/);
    expect(temporary).toContain(`.ccr-tmp-${process.pid}-`);
    expect(fsPromises.open).toHaveBeenCalledWith(temporary, 'wx');
    expect(fsPromises.rename).toHaveBeenCalledWith(temporary, join(handler.getBaseDir(), 'session-key.json'));
    expect(readdirSync(handler.getBaseDir())).toEqual(['session-key.json']);
    expect(JSON.parse(readFileSync(join(handler.getBaseDir(), 'session-key.json'), 'utf-8'))).toMatchObject({ tokens: 42, sessionId: 'key' });
  });

  it('serializes same-path writers across instances and keeps latest content', async () => {
    const first = createHandler();
    const second = createHandler({ subdirectory: first.getBaseDir().slice(tmpdir().length + 1) });
    expect(await Promise.all([
      first.output({ tokens: 1 }, { metadata: { sessionId: 'latest' } }),
      second.output({ tokens: 2 }, { metadata: { sessionId: 'latest' } }),
    ])).toEqual([true, true]);
    expect(readdirSync(first.getBaseDir())).toEqual(['session-latest.json']);
    expect(JSON.parse(readFileSync(join(first.getBaseDir(), 'session-latest.json'), 'utf-8')).tokens).toBe(2);
  });

  it('generates distinct temporary names for different simultaneous destinations', async () => {
    const handler = createHandler();
    vi.mocked(fsPromises.open).mockClear();
    expect(await Promise.all(Array.from({ length: 16 }, (_, n) =>
      handler.output({ n }, { metadata: { sessionId: `key-${n}` } })))).toEqual(Array(16).fill(true));
    const names = vi.mocked(fsPromises.open).mock.calls.map(([name]) => name);
    expect(new Set(names).size).toBe(16);
    expect(readdirSync(handler.getBaseDir()).length).toBe(16);
  });

  it('never overwrites or removes another writer temporary file on exclusive collision', async () => {
    const handler = createHandler();
    const uuid = '00000000-0000-4000-8000-000000000000';
    vi.mocked(crypto.randomUUID).mockReturnValueOnce(uuid);
    const existing = createFile(handler, `.ccr-tmp-${process.pid}-${uuid}.tmp`, false);
    expect(await handler.output({}, { metadata: { sessionId: 'key' } })).toBe(false);
    expect(readFileSync(existing, 'utf-8')).toBe('old');
  });

  it('supports explicit timestamps, sanitized keys, custom prefix and empty extension', async () => {
    vi.useFakeTimers();
    const handler = createHandler({ prefix: 'tokens', extension: '', includeTimestamp: true });
    const sessionId = '../key\\name: spaces';
    expect(await handler.output({}, { metadata: { sessionId } })).toBe(true);
    expect(readdirSync(handler.getBaseDir())).toEqual([`tokens-${sanitizeTempFileKey(sessionId)}-${Date.now()}`]);
  });

  it('returns false for missing IDs, circular values, unsafe config and symlink roots', async () => {
    const handler = createHandler();
    expect(await handler.output({})).toBe(false);
    expect(await handler.output({}, { metadata: { sessionId: '' } })).toBe(false);
    const circular: any = {}; circular.circular = circular;
    expect(await handler.output(circular, { metadata: { sessionId: 'key' } })).toBe(false);
    const unsafe = createHandler({ prefix: '../outside' });
    expect(await unsafe.output({}, { metadata: { sessionId: 'key' } })).toBe(false);
    const linked = createHandler();
    rmSync(linked.getBaseDir(), { recursive: true });
    symlinkSync(handler.getBaseDir(), linked.getBaseDir());
    expect(await linked.output({}, { metadata: { sessionId: 'key' } })).toBe(false);
    expect(readdirSync(handler.getBaseDir())).toEqual([]);
  });

  it('recovers an externally removed owned directory', async () => {
    const handler = createHandler();
    rmSync(handler.getBaseDir(), { recursive: true });
    expect(await handler.output({}, { metadata: { sessionId: 'key' } })).toBe(true);
    expect(existsSync(join(handler.getBaseDir(), 'session-key.json'))).toBe(true);
  });

  it('cleans owned temporary files after rename failure and preserves final content', async () => {
    const handler = createHandler();
    const destination = createFile(handler, 'session-key.json', false);
    vi.mocked(fsPromises.rename).mockRejectedValueOnce(new Error('EPERM'));
    expect(await handler.output({}, { metadata: { sessionId: 'key' } })).toBe(false);
    expect(readFileSync(destination, 'utf-8')).toBe('old');
    expect(readdirSync(handler.getBaseDir())).toEqual(['session-key.json']);
  });

  it('cleans owned temporary files after a partial write fails', async () => {
    const handler = createHandler();
    const actual = await vi.importActual<typeof fsPromises>('node:fs/promises');
    vi.mocked(fsPromises.open).mockImplementationOnce(async (...args: any[]) => {
      const file = await (actual.open as any)(...args);
      const write = file.writeFile.bind(file);
      file.writeFile = async () => { await write('partial'); throw new Error('ENOSPC'); };
      return file;
    });
    expect(await handler.output({}, { metadata: { sessionId: 'key' } })).toBe(false);
    expect(readdirSync(handler.getBaseDir())).toEqual([]);
  });
});

describe('TempFileOutputHandler retention integration', () => {
  it('keeps unrelated, recent, directory and symlink entries while removing owned expired metrics', async () => {
    const handler = createHandler({ retentionMs: 3600000 });
    createFile(handler, 'session-old.json');
    createFile(handler, 'session-recent.json', false);
    createFile(handler, 'config.json');
    createFile(handler, 'session-other.txt');
    createFile(handler, 'session-key.json.tmp');
    mkdirSync(join(handler.getBaseDir(), 'session-directory.json'));
    symlinkSync(join(handler.getBaseDir(), 'config.json'), join(handler.getBaseDir(), 'session-symlink.json'));
    expect(await handler.pruneOldFiles()).toBe(1);
    expect(await handler.pruneOldFiles()).toBe(0);
    expect(readdirSync(handler.getBaseDir()).sort()).toEqual([
      'config.json', 'session-directory.json', 'session-key.json.tmp', 'session-other.txt', 'session-recent.json', 'session-symlink.json',
    ]);
  });

  it('coordinates pruning with a second instance without making unrelated requests await the pass', async () => {
    const first = createHandler({ retentionMs: 3600000 });
    const second = createHandler({ subdirectory: first.getBaseDir().slice(tmpdir().length + 1), retentionMs: 3600000 });
    const destination = createFile(first, 'session-key.json');
    const started = gate(); const resume = gate();
    const actual = await vi.importActual<typeof fsPromises>('node:fs/promises');
    vi.mocked(fsPromises.unlink).mockImplementationOnce(async (path) => {
      started.resolve(); await resume.promise; return actual.unlink(path);
    });
    const scan = first.pruneOldFiles();
    await started.promise;
    expect(await second.pruneOldFiles()).toBe(0);
    const output = second.output({ tokens: 42 }, { metadata: { sessionId: 'key' } });
    expect(await second.output({}, { metadata: { sessionId: 'other' } })).toBe(true);
    resume.resolve();
    expect(await scan).toBe(1);
    expect(await output).toBe(true);
    expect(JSON.parse(readFileSync(destination, 'utf-8')).tokens).toBe(42);
  });

  it('shares unrefed first-delay/interval schedules and allows idempotent disposal', async () => {
    vi.useFakeTimers();
    const timeout = vi.spyOn(globalThis, 'setTimeout');
    const interval = vi.spyOn(globalThis, 'setInterval');
    const first = createHandler({ retentionMs: 3600000 });
    const second = createHandler({ subdirectory: first.getBaseDir().slice(tmpdir().length + 1), retentionMs: 3600000 });
    const prune = vi.spyOn(first, 'pruneOldFiles').mockResolvedValue(0);
    expect(timeout).toHaveBeenCalledExactlyOnceWith(expect.any(Function), 60000);
    expect(timeout.mock.results[0].value.hasRef()).toBe(false);
    first.dispose(); first.dispose();
    await vi.advanceTimersByTimeAsync(60000);
    expect(prune).toHaveBeenCalledTimes(1);
    expect(interval).toHaveBeenCalledWith(expect.any(Function), 600000);
    expect(interval.mock.results[0].value.hasRef()).toBe(false);
    second.dispose();
    await vi.advanceTimersByTimeAsync(600000);
    expect(prune).toHaveBeenCalledTimes(1);
  });

  it.each([0, -1, NaN, Infinity])('disables pruning and timers for retentionMs %s', async (retentionMs) => {
    const timeout = vi.spyOn(globalThis, 'setTimeout');
    const handler = createHandler({ retentionMs });
    const path = createFile(handler, 'session-key.json');
    expect(await handler.pruneOldFiles()).toBe(0);
    expect(existsSync(path)).toBe(true);
    expect(timeout).not.toHaveBeenCalled();
  });
});
