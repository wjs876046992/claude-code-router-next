/**
 * Subdirectory (relative to the OS temp root) where token-speed statusline
 * metrics live since v2.3.x: <tmpdir>/claude-code-router/token-speed-v2.
 *
 * Writers (plugin-registration / token-speed plugin) and readers (usage-store,
 * CLI statusline) must both build paths from this constant. Keeping new
 * exact-name files in their own subdirectory guarantees that old CCR
 * processes — which still write timestamped files into the legacy flat root
 * <tmpdir>/claude-code-router — can never collide with, or be mistaken for,
 * the exact-name files the new writer publishes and the reader consumes.
 */
export const TOKEN_SPEED_TEMP_SUBDIRECTORY = "claude-code-router/token-speed-v2";

/**
 * Sanitize a session/stats key before it lands in a temp-file name.
 *
 * Both the writer (plugins/output TempFileOutputHandler) and the reader
 * (ccr/usage-store readTokenSpeedStats) MUST route keys through this helper so
 * the reader can reconstruct the exact file name the writer produced:
 * - path separators and traversal sequences are replaced (defense in depth —
 *   keys normally come from validated request/session ids);
 * - the length is capped so long ids cannot hit filesystem name limits.
 */
export function sanitizeTempFileKey(key: string): string {
  return key.replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 200);
}
