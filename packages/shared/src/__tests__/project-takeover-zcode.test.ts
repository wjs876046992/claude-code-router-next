import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  applyZcodeProjectTakeover,
  isZcodeProjectTakeoverActive,
  removeZcodeProjectTakeover,
} from "../client-integrations";
import { getProjectConfigDir } from "../constants";
import {
  deleteProjectConfig,
  getProjectTakeoverClients,
  setProjectTakeover,
} from "../projectConfig";

const projectPaths: string[] = [];

// Deliberately no writeProjectConfig: the shared test HOME is also scanned by
// listProjectConfigs() in sibling suites, so registering a config here would
// show up as an extra project in their assertions. The takeover state needs no
// project config.
function createProject(): string {
  const projectPath = mkdtempSync(join(tmpdir(), "ccr-project-takeover-zcode-"));
  projectPaths.push(projectPath);
  return projectPath;
}

function config(): Record<string, any> {
  return {
    APIKEY: "key",
    PORT: 4567,
    Router: { default: "provider,model", enableFamilyRouting: false },
  };
}

function statePath(projectPath: string): string {
  return join(getProjectConfigDir(projectPath), "takeover-clients.json");
}

afterEach(async () => {
  while (projectPaths.length > 0) {
    const projectPath = projectPaths.pop()!;
    await deleteProjectConfig(projectPath);
    rmSync(projectPath, { recursive: true, force: true });
  }
});

describe("ZCode project takeover", () => {
  it("records and clears the takeover in ccr's own project directory", () => {
    const projectPath = createProject();

    applyZcodeProjectTakeover(projectPath);

    expect(isZcodeProjectTakeoverActive(projectPath)).toBe(true);
    expect(JSON.parse(readFileSync(statePath(projectPath), "utf8"))).toEqual({
      clients: ["zcode"],
    });

    removeZcodeProjectTakeover(projectPath);

    expect(isZcodeProjectTakeoverActive(projectPath)).toBe(false);
    expect(existsSync(statePath(projectPath))).toBe(false);
  });

  it("is idempotent when applied twice", () => {
    const projectPath = createProject();

    applyZcodeProjectTakeover(projectPath);
    applyZcodeProjectTakeover(projectPath);

    expect(JSON.parse(readFileSync(statePath(projectPath), "utf8"))).toEqual({
      clients: ["zcode"],
    });
  });

  it("is reported and applied through the shared project takeover API", async () => {
    const projectPath = createProject();

    await expect(setProjectTakeover(projectPath, ["zcode"], config())).resolves.toEqual([
      "zcode",
    ]);
    await expect(getProjectTakeoverClients(projectPath)).resolves.toEqual(["zcode"]);

    // An empty set turns every client's takeover off again.
    await expect(setProjectTakeover(projectPath, [], config())).resolves.toEqual([]);
    expect(existsSync(statePath(projectPath))).toBe(false);
  });

  it("keeps the other clients' takeovers when ZCode is toggled", async () => {
    const projectPath = createProject();

    await expect(
      setProjectTakeover(projectPath, ["claudeCode", "zcode"], config())
    ).resolves.toEqual(["claudeCode", "zcode"]);

    await expect(setProjectTakeover(projectPath, ["claudeCode"], config())).resolves.toEqual([
      "claudeCode",
    ]);
    expect(isZcodeProjectTakeoverActive(projectPath)).toBe(false);
  });

  it("ignores clients that cannot take a project over", async () => {
    const projectPath = createProject();

    await expect(
      setProjectTakeover(projectPath, ["codex"] as any, config())
    ).resolves.toEqual([]);
    expect(existsSync(statePath(projectPath))).toBe(false);
  });
});
