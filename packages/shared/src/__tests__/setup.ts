/**
 * vitest globalSetup — create an isolated temp HOME before tests run so
 * production code that imports HOME_DIR writes into a per-run temp directory.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function setup(): () => void {
  const dir = mkdtempSync(join(tmpdir(), "ccr-shared-test-"));
  process.env.CCR_CONFIG_DIR = dir;
  return () => {
    rmSync(dir, { recursive: true, force: true });
  };
}
