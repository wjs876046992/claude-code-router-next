import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  applyCcrProjectTakeover,
  removeCcrProjectTakeover,
} from "../client-integrations";
import { getProjectConfigDir } from "../constants";

// These tests exercise the auto-compact window state guard inside
// `applyCcrProjectTakeover` (which calls the internal applyClaudeAutoCompactSettings
// with a per-project ccr-state.json). Each case uses a unique temp projectPath so
// the derived state dir is isolated; we read/clean it via getProjectConfigDir.

const tempProjectPaths: string[] = [];

function createProject(): string {
  const projectPath = mkdtempSync(join(tmpdir(), "ccr-autocompact-"));
  tempProjectPaths.push(projectPath);
  return projectPath;
}

function readState(projectPath: string): Record<string, any> | null {
  const statePath = join(getProjectConfigDir(projectPath), "ccr-state.json");
  if (!existsSync(statePath)) return null;
  return JSON.parse(readFileSync(statePath, "utf8"));
}

function writeState(projectPath: string, value: Record<string, any>): void {
  const dir = getProjectConfigDir(projectPath);
  mkdirSync(dir, { recursive: true });
  const statePath = join(dir, "ccr-state.json");
  writeFileSync(statePath, JSON.stringify(value), "utf8");
}

function deleteState(projectPath: string): void {
  const statePath = join(getProjectConfigDir(projectPath), "ccr-state.json");
  if (existsSync(statePath)) rmSync(statePath, { force: true });
}

function makeSettings(window?: string): { env: Record<string, any> } {
  const env: Record<string, any> = {};
  if (window !== undefined) env.CLAUDE_CODE_AUTO_COMPACT_WINDOW = window;
  return { env };
}

afterEach(() => {
  for (const projectPath of tempProjectPaths.splice(0)) {
    rmSync(getProjectConfigDir(projectPath), { recursive: true, force: true });
    rmSync(projectPath, { recursive: true, force: true });
  }
});

describe("auto-compact window state guard", () => {
  it("refreshes a stale CCR-written value when state is missing (the frozen-window bug)", () => {
    // Simulates a project taken over pre-2.3.22 (window written as 200000, no
    // ccr-state.json) whose global ContextWindow later moved to 400000. The stale
    // 200000 must be re-adopted as managed and updated to 400000.
    const projectPath = createProject();
    const config = { ContextWindow: 400000, APIKEY: "test", PORT: 3456 };
    const settings = makeSettings("200000");

    deleteState(projectPath);
    applyCcrProjectTakeover(settings, config, projectPath);

    expect(settings.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBe("400000");
    const state = readState(projectPath);
    expect(state?.autoCompactWindow).toBe("400000");
    // The displaced old value is recorded for audit/recovery.
    expect(state?.previousAutoCompactWindow).toBe("200000");
  });

  it("writes the global value and builds state when the field is absent", () => {
    const projectPath = createProject();
    const config = { ContextWindow: 400000, APIKEY: "test", PORT: 3456 };
    const settings = makeSettings();

    deleteState(projectPath);
    applyCcrProjectTakeover(settings, config, projectPath);

    expect(settings.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBe("400000");
    const state = readState(projectPath);
    expect(state?.autoCompactWindow).toBe("400000");
    expect(state?.previousAutoCompactWindow).toBeUndefined();
  });

  it("updates normally when the current value matches the last written value", () => {
    const projectPath = createProject();
    const config = { ContextWindow: 420000, APIKEY: "test", PORT: 3456 };
    const settings = makeSettings("400000");

    writeState(projectPath, { autoCompactWindow: "400000" });
    applyCcrProjectTakeover(settings, config, projectPath);

    expect(settings.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBe("420000");
    expect(readState(projectPath)?.autoCompactWindow).toBe("420000");
  });

  it("preserves a genuine user hand-written value when state is present and divergent", () => {
    // The original v2.3.22 guarantee: with a recorded state, a value that differs
    // from what CCR last wrote is treated as a user customization and left alone.
    const projectPath = createProject();
    const config = { ContextWindow: 400000, APIKEY: "test", PORT: 3456 };
    const settings = makeSettings("350000");

    writeState(projectPath, { autoCompactWindow: "200000" });
    applyCcrProjectTakeover(settings, config, projectPath);

    expect(settings.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBe("350000");
    // State is not rebuilt, so the divergence stays detectable next time.
    expect(readState(projectPath)?.autoCompactWindow).toBe("200000");
  });

  it("removes the window on disable when it still matches the managed value, and clears state", () => {
    const projectPath = createProject();
    const config = { ContextWindow: 400000, APIKEY: "test", PORT: 3456 };
    const settings = makeSettings("400000");

    writeState(projectPath, { autoCompactWindow: "400000" });
    removeCcrProjectTakeover(settings, projectPath, config);

    expect(settings.env?.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBeUndefined();
    expect(readState(projectPath)).toBeNull();
  });

  it("keeps a divergent user value on disable", () => {
    const projectPath = createProject();
    const config = { ContextWindow: 400000, APIKEY: "test", PORT: 3456 };
    const settings = makeSettings("350000");

    writeState(projectPath, { autoCompactWindow: "400000" });
    removeCcrProjectTakeover(settings, projectPath, config);

    expect(settings.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBe("350000");
  });
});
