import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, statSync } from "fs";
import { join } from "path";
import { homedir, tmpdir } from "os";

const DATA_DIR = join(homedir(), ".claude-code-router", "data");
const USAGE_FILE = join(DATA_DIR, "usage.jsonl");
const MIN_DECODE_DURATION_SECONDS = 1;

export interface UsageRecord {
  id: string;
  timestamp: string;
  sessionId: string;
  provider: string;
  originalModel: string; // Original request model before routing
  model: string; // Actual routed model
  modelFamily: string;
  scenarioType: string;
  clientType?: string; // "claude-code" | "codex" | "api" | "unknown"
  stream: boolean;
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  ttft: number | null;
  tokensPerSecond: number | null;
  durationMs: number;
  status: "success" | "error";
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
  status?: "success" | "error";
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

// In-memory cache
let cachedRecords: UsageRecord[] | null = null;
let cachedMtime: number = 0;

function ensureDataDir(): void {
  if (!existsSync(DATA_DIR)) {
    mkdirSync(DATA_DIR, { recursive: true });
  }
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

function readAllRecords(): UsageRecord[] {
  if (!existsSync(USAGE_FILE)) return [];

  const mtime = statSync(USAGE_FILE).mtimeMs;
  if (cachedRecords && mtime === cachedMtime) {
    return cachedRecords;
  }

  const content = readFileSync(USAGE_FILE, "utf-8");
  const records: UsageRecord[] = [];
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      records.push(normalizeUsageRecord(JSON.parse(trimmed)));
    } catch {
      // Skip malformed lines
    }
  }

  cachedRecords = records;
  cachedMtime = mtime;
  return records;
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
  ensureDataDir();
  appendFileSync(USAGE_FILE, JSON.stringify(normalizeUsageRecord(record)) + "\n", "utf-8");
  cachedRecords = null; // Invalidate cache
}

export function query(filters: UsageQueryFilters): UsageQueryResult {
  let records = readAllRecords();

  if (filters.startTime) {
    records = records.filter((r) => r.timestamp >= filters.startTime!);
  }
  if (filters.endTime) {
    records = records.filter((r) => r.timestamp <= filters.endTime!);
  }
  if (filters.model) {
    records = records.filter((r) => r.model === filters.model);
  }
  if (filters.provider) {
    records = records.filter((r) => r.provider === filters.provider);
  }
  if (filters.scenario) {
    records = records.filter((r) => r.scenarioType === filters.scenario);
  }
  if (filters.clientType) {
    records = records.filter((r) => (r.clientType || "unknown") === filters.clientType);
  }
  if (filters.sessionId) {
    records = records.filter((r) => r.sessionId === filters.sessionId);
  }
  if (filters.status) {
    records = records.filter((r) => r.status === filters.status);
  }

  // Sort newest first
  records.sort((a, b) => b.timestamp.localeCompare(a.timestamp));

  const summary = computeSummary(records);
  const page = filters.page || 1;
  const pageSize = filters.pageSize || 50;
  const total = records.length;
  const start = (page - 1) * pageSize;
  const paged = records.slice(start, start + pageSize);

  return { records: paged, summary, total, page, pageSize };
}

export function querySummary(startTime?: string, endTime?: string, status?: "success" | "error"): UsageSummary {
  let records = readAllRecords();

  if (startTime) {
    records = records.filter((r) => r.timestamp >= startTime!);
  }
  if (endTime) {
    records = records.filter((r) => r.timestamp <= endTime!);
  }
  if (status) {
    records = records.filter((r) => r.status === status);
  }

  return computeSummary(records);
}

export function clear(beforeDate?: string): void {
  if (!existsSync(USAGE_FILE)) return;

  if (!beforeDate) {
    writeFileSync(USAGE_FILE, "", "utf-8");
    cachedRecords = [];
    return;
  }

  const records = readAllRecords().filter((r) => r.timestamp >= beforeDate);
  writeFileSync(
    USAGE_FILE,
    records.map((r) => JSON.stringify(r)).join("\n") + (records.length > 0 ? "\n" : ""),
    "utf-8"
  );
  cachedRecords = null;
}

function parseNumericTokenSpeedValue(value: any): number | null {
  if (value == null) return null;
  if (typeof value === 'number') return value;
  const num = parseInt(String(value), 10);
  return isNaN(num) ? null : num;
}

// Read token-speed temp file for a session to get TTFT and speed
export function readTokenSpeedStats(sessionId: string): {
  ttft: number | null;
  tokensPerSecond: number | null;
} {
  const baseDir = join(tmpdir(), "claude-code-router");

  // Try exact filename first (without timestamp)
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
      // Continue to search for timestamped files
    }
  }

  // Search for files matching session-${sessionId}-*.json pattern (with timestamp)
  try {
    const files = readdirSync(baseDir);
    const pattern = new RegExp(`^session-${sessionId}-\\d+\\.json$`);
    const matchingFiles = files.filter(f => pattern.test(f));

    if (matchingFiles.length > 0) {
      // Use the most recent file (highest timestamp)
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
    // Directory doesn't exist or read error
  }

  return { ttft: null, tokensPerSecond: null };
}

export function getOldestRecordTimestamp(provider: string, startTime: string, endTime: string): string | undefined {
  const records = readAllRecords();
  let oldestTime: string | undefined;
  for (const r of records) {
    if (r.provider === provider && r.timestamp >= startTime && r.timestamp <= endTime) {
      if (!oldestTime || r.timestamp < oldestTime) {
        oldestTime = r.timestamp;
      }
    }
  }
  return oldestTime;
}

