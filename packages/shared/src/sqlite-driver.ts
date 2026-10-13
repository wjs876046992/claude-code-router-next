/**
 * ABI-resilient SQLite access for CCR.
 *
 * better-sqlite3 is a native addon compiled against one specific Node.js ABI
 * (NODE_MODULE_VERSION). When the runtime `node` differs from the node that
 * ran `npm install` (e.g. a desktop app injecting its own bundled node into
 * PATH), require("better-sqlite3") fails with ERR_DLOPEN_FAILED and every
 * usage/quota API starts returning 500s.
 *
 * Node.js >= 22.5 ships a built-in `node:sqlite` module (DatabaseSync). This
 * driver tries better-sqlite3 first (existing behavior) and transparently
 * falls back to node:sqlite when the native addon cannot be loaded, so the
 * service keeps working under ANY recent Node regardless of ABI.
 *
 * The exported surface intentionally mirrors the small subset of the
 * better-sqlite3 API that CCR uses: exec / prepare(.run/.get/.all) /
 * pragma(source[, {simple}]) / transaction(fn) / close.
 */

export type SqliteDriverName = "better-sqlite3" | "node:sqlite";

export interface SqliteStatement {
  run(...params: unknown[]): { changes: number | bigint; lastInsertRowid: number | bigint };
  get(...params: unknown[]): any;
  all(...params: unknown[]): any[];
}

export interface SqliteDatabase {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
  pragma(source: string, options?: { simple?: boolean }): any;
  transaction<T extends (...args: any[]) => any>(fn: T): T;
  close(): void;
}

export interface SqliteOpenResult {
  db: SqliteDatabase;
  driver: SqliteDriverName;
  /** Set when better-sqlite3 could not be loaded and node:sqlite took over. */
  fallbackReason?: string;
}

/** Errors that indicate the native addon itself is unusable (ABI/resolution),
 *  as opposed to runtime SQLite errors (missing file, corrupt DB, ...). */
function isLoadFailure(error: unknown): boolean {
  const err = error as { code?: string; message?: string };
  if (!err) return false;
  return (
    err.code === "ERR_DLOPEN_FAILED" ||
    err.code === "MODULE_NOT_FOUND" ||
    /NODE_MODULE_VERSION|was compiled against|Could not locate the bindings file|Dynamic require of/i.test(
      err.message ?? ""
    )
  );
}

function openBetterSqlite3(file: string, readonly: boolean): SqliteDatabase {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const Database = require("better-sqlite3");
  const db = readonly
    ? new Database(file, { readonly: true, fileMustExist: true })
    : new Database(file);
  return db as SqliteDatabase;
}

interface NodeSqliteLike {
  exec(sql: string): void;
  prepare(sql: string): {
    run(...params: unknown[]): unknown;
    get(...params: unknown[]): any;
    all(...params: unknown[]): any[];
  };
  close(): void;
}

function openNodeSqlite(file: string, readonly: boolean): SqliteDatabase {
  // Throws on Node < 22.5 where the builtin module does not exist.
  const { DatabaseSync } = require("node:sqlite") as {
    DatabaseSync: new (file: string, options?: Record<string, unknown>) => NodeSqliteLike;
  };
  const raw: NodeSqliteLike = readonly
    ? new DatabaseSync(file, { readOnly: true })
    : new DatabaseSync(file);

  const db: SqliteDatabase = {
    exec(sql: string) {
      raw.exec(sql);
    },
    prepare(sql: string): SqliteStatement {
      const stmt = raw.prepare(sql);
      return {
        run(...params: unknown[]) {
          const res = stmt.run(...params) as {
            changes: number | bigint;
            lastInsertRowid: number | bigint;
          };
          return { changes: res.changes, lastInsertRowid: res.lastInsertRowid };
        },
        get: (...params: unknown[]) => stmt.get(...params),
        all: (...params: unknown[]) => stmt.all(...params),
      };
    },
    pragma(source: string, options?: { simple?: boolean }) {
      if (options?.simple) {
        // better-sqlite3 semantics: scalar value of the first column of the
        // first row (e.g. pragma("user_version", { simple: true })).
        const row = raw.prepare(`PRAGMA ${source}`).get();
        return row === undefined ? undefined : Object.values(row)[0];
      }
      // Set-style pragmas ("journal_mode = WAL", "wal_checkpoint(TRUNCATE)")
      // and multi-row reads used by CCR go through exec.
      raw.exec(`PRAGMA ${source}`);
      return undefined;
    },
    // Note: unlike better-sqlite3 this wrapper does not support nested
    // transactions via SAVEPOINTs — CCR calls it exactly once, un-nested
    // (usage-store migrateLegacyUsageJsonl).
    transaction<T extends (...args: any[]) => any>(fn: T): T {
      const wrapped = (...args: any[]) => {
        raw.exec("BEGIN");
        try {
          const result = fn(...args);
          raw.exec("COMMIT");
          return result;
        } catch (error) {
          try {
            raw.exec("ROLLBACK");
          } catch {
            // Already rolled back / no active transaction.
          }
          throw error;
        }
      };
      return wrapped as T;
    },
    close() {
      raw.close();
    },
  };
  return db;
}

/**
 * Open a SQLite database, preferring better-sqlite3 and falling back to the
 * built-in node:sqlite when the native addon cannot be loaded in this runtime.
 */
export function openSqliteDatabase(
  file: string,
  options?: { readonly?: boolean }
): SqliteOpenResult {
  return openSqliteDatabaseWithLoaders(file, options, openBetterSqlite3);
}

/**
 * Test seam: same selection logic with an injectable native loader so the
 * ABI-failure fallback can be exercised on runtimes where better-sqlite3
 * actually loads. The fallback is always the real node:sqlite wrapper.
 */
export function openSqliteDatabaseWithLoaders(
  file: string,
  options: { readonly?: boolean } | undefined,
  openNative: (file: string, readonly: boolean) => SqliteDatabase
): SqliteOpenResult {
  const readonly = options?.readonly ?? false;
  try {
    return { db: openNative(file, readonly), driver: "better-sqlite3" };
  } catch (error) {
    if (!isLoadFailure(error)) {
      throw error;
    }
    try {
      return {
        db: openNodeSqlite(file, readonly),
        driver: "node:sqlite",
        fallbackReason: (error as Error)?.message ?? String(error),
      };
    } catch (fallbackError) {
      const err = fallbackError as Error;
      throw new Error(
        `No usable SQLite driver: better-sqlite3 failed to load (${(error as Error)?.message}) ` +
          `and node:sqlite is unavailable (${err?.message}). ` +
          `Fix with: npm rebuild better-sqlite3 --runtime node --target <your node major> ` +
          `inside the claude-code-router package, or run ccr with Node >= 22.5.`
      );
    }
  }
}
