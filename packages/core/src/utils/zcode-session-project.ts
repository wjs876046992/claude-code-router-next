import { existsSync } from "fs";
import { readFile, readdir } from "fs/promises";
import { homedir } from "os";
import { isAbsolute, join, normalize } from "path";
import Database from "better-sqlite3";

/**
 * ZCode puts no project identity on the wire — its request headers only carry
 * its own version/trace stamps — but it does keep the mapping locally:
 * `<zcode>/v2/tasks-index.sqlite` records the workspace every session ran in,
 * and `<zcode>/v2/sessions/<workspace-key>/<session>.json` carries the same
 * value as `meta.workspacePath`.
 *
 * Reading it here lets a ZCode session resolve to the per-project Router that
 * Claude Code sessions already get from `searchProjectBySession` (see
 * utils/router.ts), so `ccr model --project` works for ZCode projects too.
 * The directory is resolved per call instead of at import time so it follows
 * HOME/CCR_ZCODE_DIR changes and stays steerable from tests.
 */
const zcodeDir = (): string =>
  process.env.CCR_ZCODE_DIR || join(homedir(), ".zcode");

const ZCODE_STORE_DIR = "v2";
const TASK_INDEX_FILE = "tasks-index.sqlite";
const SESSIONS_DIR = "sessions";

// Mirrors the Claude Code session lookup: successful matches are cached, misses
// never are, and a brand-new session gets one short retry because the client may
// write its index row after the session's first request has already left.
const SESSION_CACHE_MAX = 500;
const SESSION_RETRY_ATTEMPTED_MAX = 500;
const SESSION_LOOKUP_RETRY_COUNT = 3;
const SESSION_LOOKUP_RETRY_DELAY_MS = 50;

const sessionWorkspaceCache = new Map<string, string>();
const sessionRetryAttempted = new Set<string>();

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

function trimCache(): void {
  if (sessionWorkspaceCache.size <= SESSION_CACHE_MAX) return;
  const keysToDelete = [...sessionWorkspaceCache.keys()].slice(
    0,
    sessionWorkspaceCache.size - SESSION_CACHE_MAX
  );
  for (const key of keysToDelete) {
    sessionWorkspaceCache.delete(key);
  }
}

function trimRetryAttempted(): void {
  if (sessionRetryAttempted.size <= SESSION_RETRY_ATTEMPTED_MAX) return;
  const keysToDelete = [...sessionRetryAttempted].slice(
    0,
    sessionRetryAttempted.size - SESSION_RETRY_ATTEMPTED_MAX
  );
  for (const key of keysToDelete) {
    sessionRetryAttempted.delete(key);
  }
}

/**
 * ZCode task ids are `sess_<uuid>` and its session files are `<uuid>.json`, but
 * the id a request carries may be either form. Reject anything that could walk
 * out of the store so a crafted session id can never reach another path.
 */
function sessionIdCandidates(rawSessionId: string): string[] {
  const value = rawSessionId.trim();
  if (!value || value === "." || value === ".." || /[/\\\0]/.test(value)) {
    return [];
  }
  const bare = value.replace(/^sess_/, "");
  return [...new Set([value, bare, `sess_${bare}`])].filter(Boolean);
}

/**
 * `tasks` is ZCode's own index table. A schema change would make this query
 * throw, which is treated as "no match" — routing then falls back to the global
 * Router rather than failing the request.
 */
function lookupWorkspaceInTaskIndex(
  taskIndexFile: string,
  candidates: string[]
): string | null {
  let db: Database.Database | undefined;
  try {
    db = new Database(taskIndexFile, { readonly: true, fileMustExist: true });
    const statement = db.prepare(
      "SELECT workspace_path FROM tasks WHERE task_id = ? OR acp_session_id = ? ORDER BY updated_at DESC LIMIT 1"
    );
    for (const candidate of candidates) {
      const row = statement.get(candidate, candidate) as
        | { workspace_path?: unknown }
        | undefined;
      const workspacePath = row?.workspace_path;
      if (typeof workspacePath === "string" && workspacePath.trim()) {
        return workspacePath.trim();
      }
    }
    return null;
  } catch {
    return null;
  } finally {
    try {
      db?.close();
    } catch {
      // A close failure must not affect routing.
    }
  }
}

async function lookupWorkspaceInSessionFiles(
  sessionsDir: string,
  candidates: string[]
): Promise<string | null> {
  let workspaceKeys: string[];
  try {
    workspaceKeys = await readdir(sessionsDir);
  } catch {
    return null;
  }

  for (const workspaceKey of workspaceKeys) {
    for (const candidate of candidates) {
      const sessionFile = join(sessionsDir, workspaceKey, `${candidate}.json`);
      if (!existsSync(sessionFile)) continue;
      try {
        const parsed = JSON.parse(await readFile(sessionFile, "utf8"));
        const workspacePath =
          parsed?.meta?.workspacePath ?? parsed?.workspacePath;
        if (typeof workspacePath === "string" && workspacePath.trim()) {
          return workspacePath.trim();
        }
      } catch {
        // Unreadable or mid-write session file: keep looking.
      }
    }
  }
  return null;
}

/**
 * Resolve the workspace a ZCode session ran in, as an absolute normalized path.
 * Returns null — never throws — when ZCode is not installed, the store predates
 * v2, or the session is unknown, leaving routing to fall back to the global
 * Router.
 */
export async function findZcodeWorkspacePath(
  sessionId: string
): Promise<string | null> {
  const safeSessionId = typeof sessionId === "string" ? sessionId.trim() : "";
  if (!safeSessionId) return null;

  const cached = sessionWorkspaceCache.get(safeSessionId);
  if (cached) return cached;

  const resolve = async (): Promise<string | null> => {
    const candidates = sessionIdCandidates(safeSessionId);
    if (candidates.length === 0) return null;

    const storeDir = join(zcodeDir(), ZCODE_STORE_DIR);
    const taskIndexFile = join(storeDir, TASK_INDEX_FILE);
    if (existsSync(taskIndexFile)) {
      const fromIndex = lookupWorkspaceInTaskIndex(taskIndexFile, candidates);
      if (fromIndex) return fromIndex;
    }

    return lookupWorkspaceInSessionFiles(
      join(storeDir, SESSIONS_DIR),
      candidates
    );
  };

  try {
    let workspacePath = await resolve();

    // Only retry once per session so an unknown session does not pay this delay
    // on every request.
    if (!workspacePath && !sessionRetryAttempted.has(safeSessionId)) {
      sessionRetryAttempted.add(safeSessionId);
      trimRetryAttempted();
      for (let i = 0; i < SESSION_LOOKUP_RETRY_COUNT && !workspacePath; i++) {
        await sleep(SESSION_LOOKUP_RETRY_DELAY_MS);
        workspacePath = await resolve();
      }
    }

    if (!workspacePath || !isAbsolute(workspacePath)) return null;

    const normalized = normalize(workspacePath);
    sessionWorkspaceCache.set(safeSessionId, normalized);
    trimCache();
    return normalized;
  } catch {
    return null;
  }
}
