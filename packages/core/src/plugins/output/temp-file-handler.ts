import { OutputHandler, OutputOptions } from './types';
import { writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

/**
 * Temp file output handler configuration
 */
export interface TempFileOutputConfig {
  /**
   * Subdirectory under system temp directory (default: 'claude-code-router')
   */
  subdirectory?: string;

  /**
   * File extension (default: 'json')
   */
  extension?: string;

  /**
   * Whether to include timestamp in filename (default: true)
   */
  includeTimestamp?: boolean;

  /**
   * Custom prefix for temp files (default: 'session')
   */
  prefix?: string;
}

/**
 * Temp file output handler
 * Writes data to temporary files in system temp directory
 */
export class TempFileOutputHandler implements OutputHandler {
  type = 'temp-file' as const;
  private config: TempFileOutputConfig;
  private baseDir: string;

  constructor(config: TempFileOutputConfig = {}) {
    this.config = {
      subdirectory: 'claude-code-router',
      extension: 'json',
      includeTimestamp: false,
      prefix: 'session',
      ...config
    };

    // Use system temp directory
    const systemTempDir = tmpdir();
    this.baseDir = join(systemTempDir, this.config.subdirectory!);

    // Ensure directory exists
    this.ensureDir();
  }

  /**
   * Ensure directory exists
   */
  private ensureDir(): void {
    try {
      if (!existsSync(this.baseDir)) {
        mkdirSync(this.baseDir, { recursive: true });
      }
    } catch (error) {
      // Silently fail
    }
  }

  /**
   * Get file path for temp file
   */
  private getFilePath(sessionId: string): string {
    const prefix = this.config.prefix || 'session';
    const ext = this.config.extension ? `.${this.config.extension}` : '';

    let filename: string;
    if (this.config.includeTimestamp) {
      // Include timestamp in filename: prefix-sessionId-timestamp.ext
      const timestamp = Date.now();
      filename = `${prefix}-${sessionId}-${timestamp}${ext}`;
    } else {
      // Simple filename: prefix-sessionId.ext
      filename = `${prefix}-${sessionId}${ext}`;
    }

    return join(this.baseDir, filename);
  }

  /**
   * Output data to temp file
   *
   * The file key is `options.metadata?.statsKey` when provided (per-request:
   * parallel requests inside one conversation each get their own file, and the
   * usage pipeline reads the exact same key back with readTokenSpeedStats(),
   * so joins stay correct under concurrency). `options.metadata?.sessionId` is
   * display/grouping metadata only and never names the file.
   */
  async output(data: any, options: OutputOptions = {}): Promise<boolean> {
    try {
      const sessionId = options.metadata?.sessionId;
      const fileKey =
        typeof options.metadata?.statsKey === 'string' && options.metadata.statsKey
          ? options.metadata.statsKey
          : sessionId;

      if (!fileKey) {
        // No file key, skip output
        return false;
      }
      // Defense in depth: the key lands in a filesystem path, so strip path
      // separators and traversal sequences even though adapter-validated ids
      // already exclude them (custom outputOptions may supply arbitrary keys).
      const safeKey = fileKey.replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 200);

      // Prepare output data
      const outputData = {
        ...data,
        timestamp: Date.now(),
        sessionId
      };

      // Write to file
      const filePath = this.getFilePath(safeKey);
      writeFileSync(filePath, JSON.stringify(outputData, null, 2), 'utf-8');

      return true;
    } catch (error) {
      // Silently fail to avoid disrupting main flow
      return false;
    }
  }

  /**
   * Get the base directory where temp files are stored
   */
  getBaseDir(): string {
    return this.baseDir;
  }
}
