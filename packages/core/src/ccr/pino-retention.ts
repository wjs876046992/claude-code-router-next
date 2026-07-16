/**
 * Pino log retention — prunes ccr-*.log files older than 7 days by mtime.
 *
 * Extracted from the legacy server's index.ts.
 */
import { existsSync, readdirSync, statSync, unlinkSync } from "fs";
import { join } from "path";
import { HOME_DIR } from "@wengine-ai/claude-code-router-shared";

const LOG_RETENTION_DAYS = 7;
const LOG_RETENTION_MS = LOG_RETENTION_DAYS * 24 * 60 * 60 * 1000;
const LOG_RETENTION_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
let pinoLogRetentionStarted = false;

function pruneOldPinoLogs(logDir = join(HOME_DIR, "logs")): void {
  try {
    if (!existsSync(logDir)) return;

    const cutoff = Date.now() - LOG_RETENTION_MS;
    for (const file of readdirSync(logDir)) {
      if (!/^ccr-.*\.log$/.test(file)) continue;

      const filePath = join(logDir, file);
      const stats = statSync(filePath);
      if (stats.isFile() && stats.mtime.getTime() < cutoff) {
        unlinkSync(filePath);
      }
    }
  } catch (error) {
    console.warn("Failed to prune old server log files:", error);
  }
}

export function startPinoLogRetention(): void {
  if (pinoLogRetentionStarted) return;
  pinoLogRetentionStarted = true;
  pruneOldPinoLogs();
  setInterval(pruneOldPinoLogs, LOG_RETENTION_CHECK_INTERVAL_MS).unref();
}