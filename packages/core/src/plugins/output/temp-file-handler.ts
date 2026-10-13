import type { OutputHandler, OutputOptions, TempFileOutputConfig } from './types';
import { lstat, mkdir, open, rename, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { sanitizeTempFileKey } from '@wengine-ai/claude-code-router-shared';
import { basename, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pruneTempFileOutputFiles, scheduleTempFileCleanup, withTempFilePathLock } from './temp-file-retention';

// Preserve the existing import location while maintaining one canonical configuration type.
export type { TempFileOutputConfig } from './types';

/** Writes disposable metrics with exclusive, atomic publication and bounded async retention. */
export class TempFileOutputHandler implements OutputHandler {
  type = 'temp-file' as const;
  private config: TempFileOutputConfig;
  private baseDir: string;
  private readonly controller = new AbortController();
  private readonly stopSchedule?: () => void;

  constructor(config: TempFileOutputConfig = {}) {
    this.config = {
      subdirectory: 'claude-code-router',
      extension: 'json',
      includeTimestamp: false,
      prefix: 'session',
      retentionMs: 3600000,
      ...config,
    };
    this.baseDir = resolve(join(tmpdir(), this.config.subdirectory!));
    if (Number.isFinite(this.config.retentionMs) && this.config.retentionMs! > 0) {
      const scheduleKey = JSON.stringify([
        this.baseDir, this.config.prefix, this.config.extension, this.config.retentionMs,
      ]);
      this.stopSchedule = scheduleTempFileCleanup(`handler:${scheduleKey}`,
        (signal) => this.pruneOldFiles(signal), 60000);
    }
  }

  private async ensureDir(): Promise<void> {
    await mkdir(this.baseDir, { recursive: true });
    const info = await lstat(this.baseDir);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Unsafe temp output directory');
  }

  private getFilePath(sessionId: string): string {
    const prefix = this.config.prefix || 'session';
    const extension = this.config.extension ? `.${this.config.extension}` : '';
    const timestamp = this.config.includeTimestamp ? `-${Date.now()}` : '';
    const filename = `${prefix}-${sanitizeTempFileKey(sessionId)}${timestamp}${extension}`;
    if (basename(filename) !== filename || filename.includes('\\')) {
      throw new Error('Temp file configuration must not contain path separators');
    }
    return join(this.baseDir, filename);
  }

  async output(data: any, options: OutputOptions = {}): Promise<boolean> {
    try {
      // The file key MUST match the key readTokenSpeedStats reconstructs for
      // its exact-name lookup. token-speed puts the per-request key in
      // metadata.statsKey (= usageSessionId || requestId) and the stable
      // conversation id in metadata.sessionId; the reader uses usageSessionId.
      // Prefer statsKey so the file lands where the reader looks; fall back to
      // sessionId for callers that only set the display id (issue: #65 statsKey
      // was lost during the #67 merge resolution, making TTFT always null).
      const fileKey =
        typeof options.metadata?.statsKey === 'string' && options.metadata.statsKey
          ? options.metadata.statsKey
          : options.metadata?.sessionId;
      if (!fileKey) return false;
      const sessionId = options.metadata?.sessionId ?? fileKey;
      const serialized = JSON.stringify({ ...data, timestamp: Date.now(), sessionId }, null, 2);
      const filePath = this.getFilePath(fileKey);
      // A writer never waits for an entire cleanup pass, only its destination's short critical section.
      return await withTempFilePathLock(filePath, async () => {
        // Recover directories removed by temp cleanup tools before each publication.
        await this.ensureDir();
        const tempPath = join(this.baseDir, `.ccr-tmp-${process.pid}-${randomUUID()}.tmp`);
        return withTempFilePathLock(tempPath, async () => {
        let created = false;
        try {
          // Exclusive creation: a collision must neither overwrite nor remove another writer's file.
          // Track ownership before writing so a partial-write failure also removes our file.
          const file = await open(tempPath, 'wx');
          created = true;
          try {
            await file.writeFile(serialized, 'utf-8');
          } finally {
            await file.close();
          }
          await rename(tempPath, filePath);
          return true;
        } finally {
          if (created) await unlink(tempPath).catch(() => {});
        }
        });
      });
    } catch {
      // Metrics publication must not disrupt request handling.
      return false;
    }
  }

  pruneOldFiles(signal = this.controller.signal): Promise<number> {
    return pruneTempFileOutputFiles(this.baseDir, this.config.prefix || 'session',
      this.config.extension || '', this.config.retentionMs!, signal);
  }

  /** Stop owned scans and release the shared schedule. Does not remove any directory or files. */
  dispose(): void {
    this.controller.abort();
    this.stopSchedule?.();
  }

  getBaseDir(): string {
    return this.baseDir;
  }
}
