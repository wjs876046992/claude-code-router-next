/**
 * vitest globalSetup — create an isolated temp HOME before tests run so
 * production code that imports HOME_DIR (from @wengine-ai/claude-code-router-shared)
 * writes into a per-run temp directory, never to the user's real
 * ~/.claude-code-router. The directory is cleaned up on teardown.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function setup(): () => void {
  const dir = mkdtempSync(join(tmpdir(), "ccr-test-"));
  process.env.CCR_CONFIG_DIR = dir;
  return () => {
    rmSync(dir, { recursive: true, force: true });
  };
}
