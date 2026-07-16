import {
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_CONTEXT_WINDOW,
  applyPiProjectTakeover,
  enableClient,
  getContextWindow,
} from "../client-integrations";

const tempDirs: string[] = [];

function createFixture(): { piDir: string; projectDir: string } {
  const root = mkdtempSync(join(tmpdir(), "ccr-pi-models-"));
  tempDirs.push(root);
  return {
    piDir: join(root, "pi"),
    projectDir: join(root, "project"),
  };
}

function readJson(filePath: string): any {
  return JSON.parse(readFileSync(filePath, "utf8"));
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("Pi managed models", () => {
  it("exports the shared context window resolver", () => {
    expect(DEFAULT_CONTEXT_WINDOW).toBe(200000);
    expect(getContextWindow({})).toBe(DEFAULT_CONTEXT_WINDOW);
    expect(getContextWindow({ ContextWindow: "350000" })).toBe(350000);
  });

  it("removes [1m] from family aliases while preserving contextWindow", () => {
    const { piDir } = createFixture();
    const config = {
      APIKEY: "test-key",
      PORT: 3456,
      ContextWindow: 420000,
      Router: {
        families: {
          opus: { default: "provider,opus", enableExtendedContext: true },
          sonnet: { default: "provider,sonnet", enableExtendedContext: false },
        },
      },
      Clients: {
        pi: {
          configPath: piDir,
          modelAlias: "ccr-opus[1m]",
        },
      },
    };

    enableClient(config, "pi");

    const models = readJson(join(piDir, "models.json")).providers.ccr.models;
    expect(models.map((model: any) => model.id)).toEqual(["ccr-opus", "ccr-sonnet"]);
    expect(models.every((model: any) => model.contextWindow === 420000)).toBe(true);
    expect(readJson(join(piDir, "settings.json")).defaultModel).toBe("ccr-opus");
  });

  it("removes [1m] from the fallback alias", () => {
    const { piDir } = createFixture();
    const config = {
      ContextWindow: 260000,
      Clients: {
        pi: {
          configPath: piDir,
          modelAlias: "ccr-sonnet[1m]",
        },
      },
    };

    enableClient(config, "pi");

    const provider = readJson(join(piDir, "models.json")).providers.ccr;
    expect(provider.models).toHaveLength(1);
    expect(provider.models[0]).toMatchObject({
      id: "ccr-sonnet",
      contextWindow: 260000,
    });
    expect(readJson(join(piDir, "settings.json")).defaultModel).toBe("ccr-sonnet");
  });

  it("keeps managed refresh idempotent when generated content is unchanged", async () => {
    const { piDir, projectDir } = createFixture();
    const config = {
      APIKEY: "test-key",
      PORT: 3456,
      ContextWindow: 300000,
      Router: {
        families: {
          opus: { default: "provider,opus", enableExtendedContext: true },
        },
      },
      Clients: {
        pi: { configPath: piDir },
      },
    };

    applyPiProjectTakeover(projectDir, config);
    const modelsPath = join(piDir, "models.json");
    const settingsPath = join(projectDir, ".pi", "settings.json");
    const initialModelsMtime = statSync(modelsPath).mtimeMs;
    const initialSettingsMtime = statSync(settingsPath).mtimeMs;

    await new Promise((resolve) => setTimeout(resolve, 20));
    applyPiProjectTakeover(projectDir, config);

    expect(statSync(modelsPath).mtimeMs).toBe(initialModelsMtime);
    expect(statSync(settingsPath).mtimeMs).toBe(initialSettingsMtime);
  });
});
