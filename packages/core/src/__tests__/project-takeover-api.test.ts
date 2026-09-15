import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getClaudeProjectId,
  getProjectConfigDir,
  writeProjectConfig,
} from "@wengine-ai/claude-code-router-shared";
import Server from "../server";
import { registerAdminRoutes } from "../ccr/admin-routes";

// The takeover route reads the global config to build each client's managed
// settings; keep this test hermetic so it never touches a real
// ~/.claude-code-router/config.json.
const { readConfigFileMock } = vi.hoisted(() => ({
  readConfigFileMock: vi.fn(),
}));

vi.mock("../ccr/config", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../ccr/config")>();
  return { ...actual, readConfigFile: readConfigFileMock };
});

async function buildAdminRuntime() {
  const config = {
    PORT: 0,
    APIKEY: "secret",
    Providers: [],
    Router: {},
  };

  const server = new Server({
    logger: false,
    useJsonFile: false,
    initialConfig: {
      providers: config.Providers,
      Router: config.Router,
      HOST: "127.0.0.1",
      PORT: 0,
    },
  });
  await server.ready();
  await registerAdminRoutes(server, config);
  await server.registerNamespace("/");
  await server.app.ready();
  return { server };
}

describe("project takeover API", () => {
  let server: Server;
  const projectPaths: string[] = [];

  function createProject(): string {
    const projectPath = mkdtempSync(join(tmpdir(), "ccr-takeover-api-"));
    projectPaths.push(projectPath);
    return projectPath;
  }

  afterEach(async () => {
    readConfigFileMock.mockReset();
    for (const projectPath of projectPaths.splice(0)) {
      rmSync(getProjectConfigDir(projectPath), { recursive: true, force: true });
      rmSync(projectPath, { recursive: true, force: true });
    }
    if (server) {
      await server.app.close();
    }
  });

  it("accepts and reports ZCode as a takeover client", async () => {
    readConfigFileMock.mockResolvedValue({ Providers: [], Router: {} });
    ({ server } = await buildAdminRuntime());
    const projectPath = createProject();
    await writeProjectConfig(projectPath, { Router: {} });
    const id = getClaudeProjectId(projectPath);

    const res = await server.app.inject({
      method: "PUT",
      url: `/api/projects/${encodeURIComponent(id)}/takeover`,
      payload: { clients: ["claudeCode", "zcode"] },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().ccrTakeoverClients).toEqual(["claudeCode", "zcode"]);
    expect(res.json().ccrTakeover).toBe(true);

    // The project list feeds the dropdown, so it has to report the same set.
    const listed = await server.app.inject({ method: "GET", url: "/api/projects" });
    expect(listed.statusCode).toBe(200);
    const project = listed.json().projects.find((entry: any) => entry.id === id);
    expect(project?.ccrTakeoverClients).toEqual(["claudeCode", "zcode"]);
  });

  it("drops ZCode again when it is not part of the requested set", async () => {
    readConfigFileMock.mockResolvedValue({ Providers: [], Router: {} });
    ({ server } = await buildAdminRuntime());
    const projectPath = createProject();
    await writeProjectConfig(projectPath, { Router: {} });
    const id = getClaudeProjectId(projectPath);

    await server.app.inject({
      method: "PUT",
      url: `/api/projects/${encodeURIComponent(id)}/takeover`,
      payload: { clients: ["zcode"] },
    });

    const res = await server.app.inject({
      method: "PUT",
      url: `/api/projects/${encodeURIComponent(id)}/takeover`,
      payload: { clients: ["claudeCode"] },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().ccrTakeoverClients).toEqual(["claudeCode"]);
  });

  it("ignores clients that cannot take a project over", async () => {
    readConfigFileMock.mockResolvedValue({ Providers: [], Router: {} });
    ({ server } = await buildAdminRuntime());
    const projectPath = createProject();
    await writeProjectConfig(projectPath, { Router: {} });
    const id = getClaudeProjectId(projectPath);

    const res = await server.app.inject({
      method: "PUT",
      url: `/api/projects/${encodeURIComponent(id)}/takeover`,
      payload: { clients: ["codex"] },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().ccrTakeoverClients).toEqual([]);
    expect(res.json().ccrTakeover).toBe(false);
  });
});
