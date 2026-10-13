import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  openSqliteDatabase,
  openSqliteDatabaseWithLoaders,
  type SqliteDatabase,
} from "@wengine-ai/claude-code-router-shared";

// Real ABI failure, matching what a NODE_MODULE_VERSION mismatch produces.
function dlopenError(): Error {
  const error: any = new Error(
    "The module 'better_sqlite3.node' was compiled against a different Node.js version using NODE_MODULE_VERSION 147. This version of Node.js requires NODE_MODULE_VERSION 127."
  );
  error.code = "ERR_DLOPEN_FAILED";
  return error;
}

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ccr-sqlite-driver-"));
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Run the full behavioral matrix against an already-opened database. */
function expectFullSurface(db: SqliteDatabase): void {
  db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT)");
  const insert = db.prepare("INSERT INTO t (name) VALUES (?)");
  expect(insert.run("alice").changes).toBe(1);
  expect(insert.run("bob").changes).toBe(1);

  expect(db.prepare("SELECT name FROM t ORDER BY id").all()).toEqual([
    { name: "alice" },
    { name: "bob" },
  ]);
  expect(db.prepare("SELECT name FROM t WHERE name = ?").get("bob")).toEqual({ name: "bob" });
  expect(db.prepare("SELECT name FROM t WHERE name = ?").get("missing")).toBeUndefined();

  db.pragma("journal_mode = WAL");
  db.pragma("user_version = 7");
  expect(db.pragma("user_version", { simple: true })).toBe(7);
  db.pragma("wal_checkpoint(TRUNCATE)");

  const failing = db.transaction(() => {
    db.prepare("INSERT INTO t (name) VALUES (?)").run("rolled-back");
    throw new Error("boom");
  });
  expect(() => failing()).toThrow("boom");
  expect(db.prepare("SELECT COUNT(*) AS n FROM t").get()).toEqual({ n: 2 });

  const committing = db.transaction(() => db.prepare("INSERT INTO t (name) VALUES (?)").run("ok"));
  expect(committing().changes).toBe(1);
  db.close();
}

describe("sqlite driver", () => {
  it("prefers better-sqlite3 when the native addon loads (repo runtime)", () => {
    const opened = openSqliteDatabase(join(dir, "native.db"));
    expect(opened.driver).toBe("better-sqlite3");
    expect(opened.fallbackReason).toBeUndefined();
    expectFullSurface(opened.db);
  });

  it("falls back to node:sqlite when the native addon fails with an ABI error", () => {
    const opened = openSqliteDatabaseWithLoaders(join(dir, "fallback.db"), undefined, () => {
      throw dlopenError();
    });
    expect(opened.driver).toBe("node:sqlite");
    expect(opened.fallbackReason).toMatch(/NODE_MODULE_VERSION/);
    expectFullSurface(opened.db);
  });

  it("does not fall back on genuine runtime errors (readonly missing file)", () => {
    // SQLITE_CANTOPEN is a runtime error, not a load failure: the driver must
    // surface it instead of silently trying node:sqlite.
    expect(() => openSqliteDatabase(join(dir, "missing.db"), { readonly: true })).toThrow();
  });

  it("supports named parameters and INSERT OR IGNORE change counts", () => {
    const { db } = openSqliteDatabase(join(dir, "named.db"));
    db.exec("CREATE TABLE u (id TEXT PRIMARY KEY, ts TEXT)");
    const insert = db.prepare(
      "INSERT INTO u (id, ts) VALUES (@id, @ts) ON CONFLICT(id) DO NOTHING"
    );
    expect(insert.run({ id: "a", ts: "t1" }).changes).toBe(1);
    // Duplicate key: dedup-counting paths rely on changes === 0.
    expect(insert.run({ id: "a", ts: "t2" }).changes).toBe(0);
    expect(db.prepare("SELECT ts FROM u WHERE id = @id").get({ id: "a" })).toEqual({ ts: "t1" });
    db.close();
  });

});
