import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { findZcodeWorkspacePath } from "../utils/zcode-session-project";

// ZCode's own store: <dir>/v2/tasks-index.sqlite plus <dir>/v2/sessions/<key>/<id>.json.
function writeTaskIndex(zcodeDir: string, rows: Array<Record<string, unknown>>) {
  const storeDir = join(zcodeDir, "v2");
  mkdirSync(storeDir, { recursive: true });
  const db = new Database(join(storeDir, "tasks-index.sqlite"));
  db.exec(`
    CREATE TABLE tasks (
      workspace_key TEXT NOT NULL,
      workspace_path TEXT NOT NULL,
      task_id TEXT NOT NULL,
      acp_session_id TEXT,
      updated_at INTEGER NOT NULL
    );
  `);
  const insert = db.prepare(
    "INSERT INTO tasks (workspace_key, workspace_path, task_id, acp_session_id, updated_at) VALUES (?, ?, ?, ?, ?)"
  );
  for (const row of rows) {
    insert.run(
      row.workspace_key ?? "key",
      row.workspace_path,
      row.task_id,
      row.acp_session_id ?? null,
      row.updated_at ?? 1
    );
  }
  db.close();
}

function writeSessionFile(
  zcodeDir: string,
  workspaceKey: string,
  sessionId: string,
  workspacePath: unknown
) {
  const dir = join(zcodeDir, "v2", "sessions", workspaceKey);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `${sessionId}.json`),
    JSON.stringify({ meta: { workspacePath } })
  );
}

let zcodeDir: string;
const previousZcodeDir = process.env.CCR_ZCODE_DIR;

beforeEach(() => {
  zcodeDir = mkdtempSync(join(tmpdir(), "ccr-zcode-store-"));
  process.env.CCR_ZCODE_DIR = zcodeDir;
});

afterEach(() => {
  if (previousZcodeDir === undefined) {
    delete process.env.CCR_ZCODE_DIR;
  } else {
    process.env.CCR_ZCODE_DIR = previousZcodeDir;
  }
  rmSync(zcodeDir, { recursive: true, force: true });
});

describe("findZcodeWorkspacePath", () => {
  it("reads the workspace from ZCode's task index", async () => {
    const workspace = "/Users/someone/work/personal-project";
    writeTaskIndex(zcodeDir, [
      {
        workspace_path: workspace,
        task_id: "sess_11111111-1111-1111-1111-111111111111",
        updated_at: 100,
      },
    ]);

    // The id a request carries may arrive with or without ZCode's `sess_` prefix.
    await expect(
      findZcodeWorkspacePath("11111111-1111-1111-1111-111111111111")
    ).resolves.toBe(workspace);
    await expect(
      findZcodeWorkspacePath("sess_11111111-1111-1111-1111-111111111111")
    ).resolves.toBe(workspace);
  });

  it("matches on the ACP session id as well as the task id", async () => {
    const workspace = "/Users/someone/work/acp-project";
    writeTaskIndex(zcodeDir, [
      {
        workspace_path: workspace,
        task_id: "sess_22222222-2222-2222-2222-222222222222",
        acp_session_id: "33333333-3333-3333-3333-333333333333",
        updated_at: 100,
      },
    ]);

    await expect(
      findZcodeWorkspacePath("33333333-3333-3333-3333-333333333333")
    ).resolves.toBe(workspace);
  });

  it("prefers the most recently updated task", async () => {
    writeTaskIndex(zcodeDir, [
      {
        workspace_path: "/old/workspace",
        task_id: "sess_44444444-4444-4444-4444-444444444444",
        updated_at: 1,
      },
      {
        workspace_path: "/new/workspace",
        task_id: "sess_44444444-4444-4444-4444-444444444444",
        updated_at: 2,
      },
    ]);

    await expect(
      findZcodeWorkspacePath("44444444-4444-4444-4444-444444444444")
    ).resolves.toBe("/new/workspace");
  });

  it("falls back to the per-session JSON files", async () => {
    const workspace = "/Users/someone/work/from-json";
    writeSessionFile(
      zcodeDir,
      "workspace-key",
      "55555555-5555-5555-5555-555555555555",
      workspace
    );

    await expect(
      findZcodeWorkspacePath("55555555-5555-5555-5555-555555555555")
    ).resolves.toBe(workspace);
  });

  it("falls back to the session files when the index is unreadable", async () => {
    const storeDir = join(zcodeDir, "v2");
    mkdirSync(storeDir, { recursive: true });
    // Not a SQLite database at all: the query must not throw.
    writeFileSync(join(storeDir, "tasks-index.sqlite"), "not a database");
    writeSessionFile(
      zcodeDir,
      "workspace-key",
      "66666666-6666-6666-6666-666666666666",
      "/Users/someone/work/salvaged"
    );

    await expect(
      findZcodeWorkspacePath("66666666-6666-6666-6666-666666666666")
    ).resolves.toBe("/Users/someone/work/salvaged");
  });

  it("returns null for unknown sessions, absent stores, and unsafe ids", async () => {
    writeTaskIndex(zcodeDir, [
      {
        workspace_path: "/Users/someone/work/known",
        task_id: "sess_77777777-7777-7777-7777-777777777777",
      },
    ]);

    await expect(
      findZcodeWorkspacePath("88888888-8888-8888-8888-888888888888")
    ).resolves.toBeNull();
    // Session ids become file paths, so separators and traversal never resolve.
    await expect(findZcodeWorkspacePath("../../etc/passwd")).resolves.toBeNull();
    await expect(findZcodeWorkspacePath("..")).resolves.toBeNull();
    await expect(findZcodeWorkspacePath("")).resolves.toBeNull();

    rmSync(zcodeDir, { recursive: true, force: true });
    await expect(
      findZcodeWorkspacePath("77777777-7777-7777-7777-777777777777")
    ).resolves.toBeNull();
  });
  it("rejects workspaces that are not absolute paths", async () => {
    writeTaskIndex(zcodeDir, [
      {
        workspace_path: "relative/workspace",
        task_id: "sess_aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
      },
    ]);

    await expect(
      findZcodeWorkspacePath("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa")
    ).resolves.toBeNull();
  });

  it("returns null instead of throwing when the store is malformed", async () => {
    writeSessionFile(
      zcodeDir,
      "workspace-key",
      "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
      { unexpected: true }
    );

    await expect(
      findZcodeWorkspacePath("bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb")
    ).resolves.toBeNull();
  });
});
