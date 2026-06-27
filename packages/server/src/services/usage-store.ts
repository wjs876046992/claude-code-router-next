import { existsSync, mkdirSync, readFileSync, readdirSync } from "fs";
import { join } from "path";
import { homedir, tmpdir } from "os";
import Database = require("better-sqlite3");

const DATA_DIR = join(homedir(), ".claude-code-router", "data");
const USAGE_DB_FILE = join(DATA_DIR, "usage.sqlite");
const LEGACY_USAGE_FILE = join(DATA_DIR, "usage.jsonl");
const MIN_DECODE_DURATION_SECONDS = 1;
const USAGE_RETENTION_DAYS = 180;
const RETENTION_PRUNE_INTERVAL_MS = 60 * 60 * 1000;
const LEGACY_MIGRATION_META_KEY = "legacy_usage_jsonl_migrated_at";

type UsageStatus = "success" | "error";

type UsageRecordRow = {
  id: string;
  timestamp: string;
  session_id: string;
  provider: string;
  original_model: string;
  model: string;
  upstream_model: string | null;
  model_family: string;
  scenario_type: string;
  client_type: string | null;
  codex_account_id: string | null;
  codex_account_email: string | null;
  stream: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
  ttft: number | null;
  tokens_per_second: number | null;
  duration_ms: number;
  status: UsageStatus;
  error_message: string | null;
  response_body: string | null;
};

interface QueryWhereClause {
  sql: string;
  params: Array<string | number>;
}

export interface UsageRecord {
  id: string;
  timestamp: string;
  sessionId: string;
  provider: string;
  originalModel: string; // Original request model before routing
  model: string; // Actual routed model
  upstreamModel?: string; // Model returned by the upstream provider (may differ from routed model)
  modelFamily: string;
  scenarioType: string;
  clientType?: string; // "claude-code" | "codex" | "pi" | "qwen-code" | "opencode" | "api" | "unknown"
  codexAccountId?: string;
  codexAccountEmail?: string;
  stream: boolean;
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  ttft: number | null;
  tokensPerSecond: number | null;
  durationMs: number;
  status: UsageStatus;
  errorMessage?: string;
  responseBody?: string; // Full response body for error cases
}

export interface UsageSummary {
  totalRequests: number;
  successCount: number;
  errorCount: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheReadInputTokens: number;
  totalCacheCreationInputTokens: number;
  avgTtft: number | null;
  avgTokensPerSecond: number | null;
  byModel: Record<string, { count: number; inputTokens: number; outputTokens: number; cacheReadInputTokens: number; cacheCreationInputTokens: number }>;
  byProvider: Record<string, { count: number; inputTokens: number; outputTokens: number; cacheReadInputTokens: number; cacheCreationInputTokens: number }>;
  byScenario: Record<string, { count: number; inputTokens: number; outputTokens: number; cacheReadInputTokens: number; cacheCreationInputTokens: number }>;
  byFamily: Record<string, { count: number; inputTokens: number; outputTokens: number; cacheReadInputTokens: number; cacheCreationInputTokens: number }>;
  byDay: Record<string, { count: number; inputTokens: number; outputTokens: number; cacheReadInputTokens: number; cacheCreationInputTokens: number }>;
  byClient: Record<string, { count: number; inputTokens: number; outputTokens: number; cacheReadInputTokens: number; cacheCreationInputTokens: number }>;
}

export interface UsageQueryFilters {
  startTime?: string;
  endTime?: string;
  model?: string;
  provider?: string;
  scenario?: string;
  clientType?: string;
  sessionId?: string;
  status?: UsageStatus;
  page?: number;
  pageSize?: number;
}

export interface UsageQueryResult {
  records: UsageRecord[];
  summary: UsageSummary;
  total: number;
  page: number;
  pageSize: number;
}

let dbInstance: Database.Database | null = null;
let insertStatement: Database.Statement | null = null;
let lastRetentionPruneAt = 0;

function ensureDataDir(): void {
  if (!existsSync(DATA_DIR)) {
    mkdirSync(DATA_DIR, { recursive: true });
  }
}

function getDb(): Database.Database {
  if (dbInstance) return dbInstance;

  ensureDataDir();
  const db = new Database(USAGE_DB_FILE);
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.pragma("busy_timeout = 5000");
  // Schema versioning: only run DDL when initializing a fresh database.
  // Future migrations should check the current version and apply incremental changes.
  const currentVersion = (db.pragma("user_version", { simple: true }) as number) || 0;
  if (currentVersion < 1) {
    initializeSchema(db);
    db.pragma("user_version = 1");
  }
  if (currentVersion < 2) {
    // v2: track the model the upstream provider actually returned, so gateway
    // model swaps (e.g. silently routing glm-5 to a MiniMax backend) are visible.
    const columns = db.prepare("PRAGMA table_info(usage_records)").all() as { name: string }[];
    if (!columns.some((c) => c.name === "upstream_model")) {
      db.exec("ALTER TABLE usage_records ADD COLUMN upstream_model TEXT");
    }
    db.pragma("user_version = 2");
  }
  migrateLegacyUsageJsonl(db);
  pruneExpiredRecords(db, true);

  insertStatement = db.prepare(`
    INSERT INTO usage_records (
      id, timestamp, session_id, provider, original_model, model, upstream_model, model_family,
      scenario_type, client_type, codex_account_id, codex_account_email,
      stream, input_tokens, output_tokens, cache_read_input_tokens,
      cache_creation_input_tokens, ttft, tokens_per_second, duration_ms,
      status, error_message, response_body
    ) VALUES (
      @id, @timestamp, @session_id, @provider, @original_model, @model, @upstream_model,
      @model_family, @scenario_type, @client_type, @codex_account_id,
      @codex_account_email, @stream, @input_tokens, @output_tokens,
      @cache_read_input_tokens, @cache_creation_input_tokens, @ttft,
      @tokens_per_second, @duration_ms, @status, @error_message, @response_body
    )
  `);

  dbInstance = db;
  return dbInstance;
}

function initializeSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS usage_records (
      id TEXT PRIMARY KEY,
      timestamp TEXT NOT NULL,
      session_id TEXT NOT NULL,
      provider TEXT NOT NULL,
      original_model TEXT NOT NULL,
      model TEXT NOT NULL,
      upstream_model TEXT,
      model_family TEXT NOT NULL,
      scenario_type TEXT NOT NULL,
      client_type TEXT,
      codex_account_id TEXT,
      codex_account_email TEXT,
      stream INTEGER NOT NULL,
      input_tokens INTEGER NOT NULL,
      output_tokens INTEGER NOT NULL,
      cache_read_input_tokens INTEGER NOT NULL,
      cache_creation_input_tokens INTEGER NOT NULL,
      ttft REAL,
      tokens_per_second REAL,
      duration_ms INTEGER NOT NULL,
      status TEXT NOT NULL,
      error_message TEXT,
      response_body TEXT
    );

    CREATE TABLE IF NOT EXISTS usage_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_usage_records_timestamp ON usage_records(timestamp);
    CREATE INDEX IF NOT EXISTS idx_usage_records_status_timestamp ON usage_records(status, timestamp);
    CREATE INDEX IF NOT EXISTS idx_usage_records_provider_timestamp ON usage_records(provider, timestamp);
    CREATE INDEX IF NOT EXISTS idx_usage_records_model_timestamp ON usage_records(model, timestamp);
    CREATE INDEX IF NOT EXISTS idx_usage_records_scenario_timestamp ON usage_records(scenario_type, timestamp);
    CREATE INDEX IF NOT EXISTS idx_usage_records_client_timestamp ON usage_records(client_type, timestamp);
    CREATE INDEX IF NOT EXISTS idx_usage_records_session_timestamp ON usage_records(session_id, timestamp);
  `);
}

function getMeta(db: Database.Database, key: string): string | undefined {
  const row = db
    .prepare("SELECT value FROM usage_meta WHERE key = ?")
    .get(key) as { value: string } | undefined;
  return row?.value;
}

function setMeta(db: Database.Database, key: string, value: string): void {
  db.prepare(`
    INSERT INTO usage_meta (key, value)
    VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(key, value);
}

function migrateLegacyUsageJsonl(db: Database.Database): void {
  if (getMeta(db, LEGACY_MIGRATION_META_KEY) || !existsSync(LEGACY_USAGE_FILE)) {
    return;
  }

  const insertStatement = getInsertStatement(db, "INSERT OR IGNORE");
  const content = readFileSync(LEGACY_USAGE_FILE, "utf-8");
  let imported = 0;
  let skipped = 0;
  let duplicates = 0;

  const migrate = db.transaction(() => {
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      try {
        const parsed = JSON.parse(trimmed);
        if (!isMigrationCandidate(parsed)) {
          skipped++;
          continue;
        }

        const result = insertStatement.run(toDbRow(normalizeUsageRecord(parsed)));
        if (result.changes > 0) {
          imported++;
        } else {
          duplicates++;
        }
      } catch {
        skipped++;
      }
    }

    setMeta(db, LEGACY_MIGRATION_META_KEY, new Date().toISOString());
    setMeta(db, "legacy_usage_jsonl_migrated_path", LEGACY_USAGE_FILE);
    setMeta(db, "legacy_usage_jsonl_imported_count", String(imported));
    setMeta(db, "legacy_usage_jsonl_skipped_count", String(skipped));
    setMeta(db, "legacy_usage_jsonl_duplicate_count", String(duplicates));
  });

  migrate();
}

function isMigrationCandidate(value: unknown): value is UsageRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<UsageRecord>;
  return typeof record.id === "string" && record.id.length > 0 &&
    typeof record.timestamp === "string" && record.timestamp.length > 0;
}

function getInsertStatement(db: Database.Database, insertMode = "INSERT"): Database.Statement {
  return db.prepare(`
    ${insertMode} INTO usage_records (
      id, timestamp, session_id, provider, original_model, model, upstream_model, model_family,
      scenario_type, client_type, codex_account_id, codex_account_email,
      stream, input_tokens, output_tokens, cache_read_input_tokens,
      cache_creation_input_tokens, ttft, tokens_per_second, duration_ms,
      status, error_message, response_body
    ) VALUES (
      @id, @timestamp, @session_id, @provider, @original_model, @model, @upstream_model,
      @model_family, @scenario_type, @client_type, @codex_account_id,
      @codex_account_email, @stream, @input_tokens, @output_tokens,
      @cache_read_input_tokens, @cache_creation_input_tokens, @ttft,
      @tokens_per_second, @duration_ms, @status, @error_message, @response_body
    )
  `);
}

function calculateUsageTokensPerSecond(outputTokens: number, durationMs: number | null, ttft: number | null): number | null {
  if (outputTokens <= 0 || durationMs == null || !Number.isFinite(durationMs)) return null;

  const timeToFirstToken = ttft != null && Number.isFinite(ttft) ? ttft : 0;
  const decodeDurationSeconds = Math.max(
    (durationMs - timeToFirstToken) / 1000,
    MIN_DECODE_DURATION_SECONDS
  );
  return Math.round(outputTokens / decodeDurationSeconds);
}

function normalizeUsageRecord(record: UsageRecord): UsageRecord {
  const outputTokens = Number(record.outputTokens) || 0;
  const rawDurationMs = Number(record.durationMs);
  const durationMs = Number.isFinite(rawDurationMs) ? rawDurationMs : null;
  const ttft = parseNumericTokenSpeedValue(record.ttft);

  return {
    ...record,
    ttft,
    tokensPerSecond: calculateUsageTokensPerSecond(outputTokens, durationMs, ttft),
  };
}

function normalizeString(value: unknown): string {
  return typeof value === "string" ? value : value == null ? "" : String(value);
}

function normalizeOptionalString(value: unknown): string | undefined {
  if (value == null) return undefined;
  const normalized = String(value);
  return normalized.length > 0 ? normalized : undefined;
}

function normalizeNumber(value: unknown): number {
  const normalized = Number(value);
  return Number.isFinite(normalized) ? normalized : 0;
}

function normalizeStatus(value: unknown): UsageStatus {
  return value === "success" ? "success" : "error";
}

function toDbRow(record: UsageRecord): UsageRecordRow {
  const normalized = normalizeUsageRecord(record);
  return {
    id: normalizeString(normalized.id),
    timestamp: normalizeString(normalized.timestamp),
    session_id: normalizeString(normalized.sessionId),
    provider: normalizeString(normalized.provider),
    original_model: normalizeString(normalized.originalModel),
    model: normalizeString(normalized.model),
    upstream_model: normalizeOptionalString(normalized.upstreamModel) ?? null,
    model_family: normalizeString(normalized.modelFamily),
    scenario_type: normalizeString(normalized.scenarioType),
    client_type: normalizeOptionalString(normalized.clientType) ?? null,
    codex_account_id: normalizeOptionalString(normalized.codexAccountId) ?? null,
    codex_account_email: normalizeOptionalString(normalized.codexAccountEmail) ?? null,
    stream: normalized.stream ? 1 : 0,
    input_tokens: Math.trunc(normalizeNumber(normalized.inputTokens)),
    output_tokens: Math.trunc(normalizeNumber(normalized.outputTokens)),
    cache_read_input_tokens: Math.trunc(normalizeNumber(normalized.cacheReadInputTokens)),
    cache_creation_input_tokens: Math.trunc(normalizeNumber(normalized.cacheCreationInputTokens)),
    ttft: parseNumericTokenSpeedValue(normalized.ttft),
    tokens_per_second: parseNumericTokenSpeedValue(normalized.tokensPerSecond),
    duration_ms: Math.trunc(normalizeNumber(normalized.durationMs)),
    status: normalizeStatus(normalized.status),
    error_message: normalizeOptionalString(normalized.errorMessage) ?? null,
    response_body: normalizeOptionalString(normalized.responseBody) ?? null,
  };
}

function toUsageRecord(row: UsageRecordRow): UsageRecord {
  return normalizeUsageRecord({
    id: row.id,
    timestamp: row.timestamp,
    sessionId: row.session_id,
    provider: row.provider,
    originalModel: row.original_model,
    model: row.model,
    upstreamModel: row.upstream_model ?? undefined,
    modelFamily: row.model_family,
    scenarioType: row.scenario_type,
    clientType: row.client_type ?? undefined,
    codexAccountId: row.codex_account_id ?? undefined,
    codexAccountEmail: row.codex_account_email ?? undefined,
    stream: row.stream === 1,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    cacheReadInputTokens: row.cache_read_input_tokens,
    cacheCreationInputTokens: row.cache_creation_input_tokens,
    ttft: row.ttft,
    tokensPerSecond: row.tokens_per_second,
    durationMs: row.duration_ms,
    status: normalizeStatus(row.status),
    errorMessage: row.error_message ?? undefined,
    responseBody: row.response_body ?? undefined,
  });
}

function retentionCutoffTimestamp(): string {
  return new Date(Date.now() - USAGE_RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString();
}

function pruneExpiredRecords(db: Database.Database, force = false): void {
  const now = Date.now();
  if (!force && now - lastRetentionPruneAt < RETENTION_PRUNE_INTERVAL_MS) return;

  db.prepare("DELETE FROM usage_records WHERE timestamp < ?").run(retentionCutoffTimestamp());
  lastRetentionPruneAt = now;
}

function buildWhereClause(filters: UsageQueryFilters): QueryWhereClause {
  const clauses: string[] = [];
  const params: Array<string | number> = [];

  if (filters.startTime) {
    clauses.push("timestamp >= ?");
    params.push(filters.startTime);
  }
  if (filters.endTime) {
    clauses.push("timestamp <= ?");
    params.push(filters.endTime);
  }
  if (filters.model) {
    clauses.push("model = ?");
    params.push(filters.model);
  }
  if (filters.provider) {
    clauses.push("provider = ?");
    params.push(filters.provider);
  }
  if (filters.scenario) {
    clauses.push("scenario_type = ?");
    params.push(filters.scenario);
  }
  if (filters.clientType) {
    if (filters.clientType === "unknown") {
      clauses.push("(client_type IS NULL OR client_type = '' OR client_type = ?)");
      params.push(filters.clientType);
    } else {
      clauses.push("client_type = ?");
      params.push(filters.clientType);
    }
  }
  if (filters.sessionId) {
    clauses.push("session_id = ?");
    params.push(filters.sessionId);
  }
  if (filters.status) {
    clauses.push("status = ?");
    params.push(filters.status);
  }

  return {
    sql: clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "",
    params,
  };
}

// TODO(perf): This materializes all matching rows into JS memory to compute the summary.
// With 180-day retention and high throughput this can be large. A future improvement should
// push aggregation (SUM, COUNT, AVG, GROUP BY) into SQL and only fall back to in-memory
// computeSummary for the byModel/byProvider/byScenario/byFamily/byDay/byClient breakdowns
// if a single-pass SQL approach proves insufficient.
function readFilteredRecords(db: Database.Database, filters: UsageQueryFilters): UsageRecord[] {
  const where = buildWhereClause(filters);
  const rows = db
    .prepare(`SELECT * FROM usage_records ${where.sql}`)
    .all(...where.params) as UsageRecordRow[];
  return rows.map(toUsageRecord);
}

function computeSummary(records: UsageRecord[]): UsageSummary {
  const summary: UsageSummary = {
    totalRequests: records.length,
    successCount: 0,
    errorCount: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCacheReadInputTokens: 0,
    totalCacheCreationInputTokens: 0,
    avgTtft: null,
    avgTokensPerSecond: null,
    byModel: {},
    byProvider: {},
    byScenario: {},
    byFamily: {},
    byDay: {},
    byClient: {},
  };

  let ttftSum = 0;
  let ttftCount = 0;
  let speedSum = 0;
  let speedCount = 0;

  for (const r of records) {
    const isSuccess = r.status === "success";
    if (isSuccess) {
      summary.successCount++;
    } else {
      summary.errorCount++;
    }

    const inputTokens = isSuccess ? (r.inputTokens || 0) : 0;
    const outputTokens = isSuccess ? (r.outputTokens || 0) : 0;
    const cacheReadInputTokens = isSuccess ? (r.cacheReadInputTokens || 0) : 0;
    const cacheCreationInputTokens = isSuccess ? (r.cacheCreationInputTokens || 0) : 0;

    summary.totalInputTokens += inputTokens;
    summary.totalOutputTokens += outputTokens;
    summary.totalCacheReadInputTokens += cacheReadInputTokens;
    summary.totalCacheCreationInputTokens += cacheCreationInputTokens;

    if (isSuccess && r.ttft != null) {
      ttftSum += r.ttft;
      ttftCount++;
    }
    if (isSuccess && r.tokensPerSecond != null) {
      speedSum += r.tokensPerSecond;
      speedCount++;
    }

    const day = r.timestamp.slice(0, 10);

    aggregateInto(summary.byModel, r.model, inputTokens, outputTokens, cacheReadInputTokens, cacheCreationInputTokens);
    aggregateInto(summary.byProvider, r.provider, inputTokens, outputTokens, cacheReadInputTokens, cacheCreationInputTokens);
    aggregateInto(summary.byScenario, r.scenarioType, inputTokens, outputTokens, cacheReadInputTokens, cacheCreationInputTokens);
    if (r.modelFamily) {
      const familyScenario = `${r.modelFamily}/${r.scenarioType}`;
      aggregateInto(summary.byFamily, familyScenario, inputTokens, outputTokens, cacheReadInputTokens, cacheCreationInputTokens);
    }
    aggregateInto(summary.byDay, day, inputTokens, outputTokens, cacheReadInputTokens, cacheCreationInputTokens);
    aggregateInto(summary.byClient, r.clientType || "unknown", inputTokens, outputTokens, cacheReadInputTokens, cacheCreationInputTokens);
  }

  if (ttftCount > 0) summary.avgTtft = Math.round(ttftSum / ttftCount);
  if (speedCount > 0) summary.avgTokensPerSecond = Math.round(speedSum / speedCount);

  return summary;
}

function aggregateInto(
  map: Record<string, { count: number; inputTokens: number; outputTokens: number; cacheReadInputTokens: number; cacheCreationInputTokens: number }>,
  key: string,
  inputTokens: number,
  outputTokens: number,
  cacheReadInputTokens: number,
  cacheCreationInputTokens: number
): void {
  if (!map[key]) {
    map[key] = { count: 0, inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 };
  }
  map[key].count++;
  map[key].inputTokens += inputTokens;
  map[key].outputTokens += outputTokens;
  map[key].cacheReadInputTokens += cacheReadInputTokens;
  map[key].cacheCreationInputTokens += cacheCreationInputTokens;
}

export function append(record: UsageRecord): void {
  const db = getDb();
  const normalized = normalizeUsageRecord(record);
  // Use the cached prepared statement for hot-path performance.
  insertStatement!.run(toDbRow(normalized));
  pruneExpiredRecords(db);
}

export function query(filters: UsageQueryFilters): UsageQueryResult {
  const db = getDb();
  const where = buildWhereClause(filters);
  const page = Number.isFinite(filters.page) && filters.page! > 0 ? Math.floor(filters.page!) : 1;
  const pageSize = Number.isFinite(filters.pageSize) && filters.pageSize! > 0 ? Math.floor(filters.pageSize!) : 50;
  const offset = (page - 1) * pageSize;

  const totalRow = db
    .prepare(`SELECT COUNT(*) AS count FROM usage_records ${where.sql}`)
    .get(...where.params) as { count: number };
  const rows = db
    .prepare(`SELECT * FROM usage_records ${where.sql} ORDER BY timestamp DESC LIMIT ? OFFSET ?`)
    .all(...where.params, pageSize, offset) as UsageRecordRow[];

  const summary = computeSummary(readFilteredRecords(db, filters));

  return {
    records: rows.map(toUsageRecord),
    summary,
    total: totalRow.count,
    page,
    pageSize,
  };
}

export function querySummary(startTime?: string, endTime?: string, status?: UsageStatus): UsageSummary {
  const db = getDb();
  return computeSummary(readFilteredRecords(db, { startTime, endTime, status }));
}

export function clear(beforeDate?: string): void {
  const db = getDb();
  if (!beforeDate) {
    db.prepare("DELETE FROM usage_records").run();
    return;
  }

  db.prepare("DELETE FROM usage_records WHERE timestamp < ?").run(beforeDate);
}

// Gracefully close the database connection (call on process shutdown).
export function close(): void {
  if (dbInstance) {
    // Run a WAL checkpoint to flush pending writes before closing.
    dbInstance.pragma("wal_checkpoint(TRUNCATE)");
    dbInstance.close();
    dbInstance = null;
    insertStatement = null;
  }
}

function parseNumericTokenSpeedValue(value: any): number | null {
  if (value == null) return null;
  if (typeof value === "number") return value;
  const num = parseFloat(String(value));
  return isNaN(num) ? null : num;
}

// Read token-speed temp file for a session to get TTFT and speed
export function readTokenSpeedStats(sessionId: string): {
  ttft: number | null;
  tokensPerSecond: number | null;
} {
  const baseDir = join(tmpdir(), "claude-code-router");

  // Try exact filename first without timestamp.
  const exactFile = join(baseDir, `session-${sessionId}.json`);
  if (existsSync(exactFile)) {
    try {
      const content = readFileSync(exactFile, "utf-8");
      const data = JSON.parse(content);
      return {
        ttft: parseNumericTokenSpeedValue(data.timeToFirstToken),
        tokensPerSecond: parseNumericTokenSpeedValue(data.tokensPerSecond),
      };
    } catch {
      // Continue to search for timestamped files.
    }
  }

  // Search for timestamped session files and use the most recent match.
  try {
    const files = readdirSync(baseDir);
    const pattern = new RegExp(`^session-${sessionId}-\\d+\\.json$`);
    const matchingFiles = files.filter(f => pattern.test(f));

    if (matchingFiles.length > 0) {
      const sortedFiles = matchingFiles.sort().reverse();
      const latestFile = join(baseDir, sortedFiles[0]);
      try {
        const content = readFileSync(latestFile, "utf-8");
        const data = JSON.parse(content);
        return {
          ttft: parseNumericTokenSpeedValue(data.timeToFirstToken),
          tokensPerSecond: parseNumericTokenSpeedValue(data.tokensPerSecond),
        };
      } catch {
        return { ttft: null, tokensPerSecond: null };
      }
    }
  } catch {
    // Directory does not exist or cannot be read.
  }

  return { ttft: null, tokensPerSecond: null };
}

export function getOldestRecordTimestamp(provider: string, startTime: string, endTime: string): string | undefined {
  const db = getDb();
  const row = db
    .prepare("SELECT MIN(timestamp) AS timestamp FROM usage_records WHERE provider = ? AND timestamp >= ? AND timestamp <= ?")
    .get(provider, startTime, endTime) as { timestamp: string | null } | undefined;
  return row?.timestamp ?? undefined;
}
