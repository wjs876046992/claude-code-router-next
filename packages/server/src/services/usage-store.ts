import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync, statSync } from "fs";
import { join } from "path";
import { homedir, tmpdir } from "os";

const DATA_DIR = join(homedir(), ".claude-code-router", "data");
const USAGE_FILE = join(DATA_DIR, "usage.jsonl");

export interface UsageRecord {
  id: string;
  timestamp: string;
  sessionId: string;
  provider: string;
  model: string;
  scenarioType: string;
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
  byDay: Record<string, { count: number; inputTokens: number; outputTokens: number; cacheReadInputTokens: number; cacheCreationInputTokens: number }>;
}

export interface UsageQueryFilters {
  startTime?: string;
  endTime?: string;
  model?: string;
  provider?: string;
  scenario?: string;
  sessionId?: string;
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
      records.push(JSON.parse(trimmed));
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
    byDay: {},
  };

  let ttftSum = 0;
  let ttftCount = 0;
  let speedSum = 0;
  let speedCount = 0;

  for (const r of records) {
    if (r.status === "success") summary.successCount++;
    else summary.errorCount++;

    summary.totalInputTokens += r.inputTokens;
    summary.totalOutputTokens += r.outputTokens;
    summary.totalCacheReadInputTokens += r.cacheReadInputTokens || 0;
    summary.totalCacheCreationInputTokens += r.cacheCreationInputTokens || 0;

    if (r.ttft != null) {
      ttftSum += r.ttft;
      ttftCount++;
    }
    if (r.tokensPerSecond != null) {
      speedSum += r.tokensPerSecond;
      speedCount++;
    }

    const day = r.timestamp.slice(0, 10);

    aggregateInto(summary.byModel, r.model, r.inputTokens, r.outputTokens, r.cacheReadInputTokens || 0, r.cacheCreationInputTokens || 0);
    aggregateInto(summary.byProvider, r.provider, r.inputTokens, r.outputTokens, r.cacheReadInputTokens || 0, r.cacheCreationInputTokens || 0);
    aggregateInto(summary.byScenario, r.scenarioType, r.inputTokens, r.outputTokens, r.cacheReadInputTokens || 0, r.cacheCreationInputTokens || 0);
    aggregateInto(summary.byDay, day, r.inputTokens, r.outputTokens, r.cacheReadInputTokens || 0, r.cacheCreationInputTokens || 0);
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
  appendFileSync(USAGE_FILE, JSON.stringify(record) + "\n", "utf-8");
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
  if (filters.sessionId) {
    records = records.filter((r) => r.sessionId === filters.sessionId);
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

export function querySummary(startTime?: string, endTime?: string): UsageSummary {
  let records = readAllRecords();

  if (startTime) {
    records = records.filter((r) => r.timestamp >= startTime!);
  }
  if (endTime) {
    records = records.filter((r) => r.timestamp <= endTime!);
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

// Read token-speed temp file for a session to get TTFT and speed
export function readTokenSpeedStats(sessionId: string): {
  ttft: number | null;
  tokensPerSecond: number | null;
} {
  const tempFile = join(tmpdir(), "claude-code-router", `session-${sessionId}.json`);
  if (!existsSync(tempFile)) {
    return { ttft: null, tokensPerSecond: null };
  }
  try {
    const content = readFileSync(tempFile, "utf-8");
    const data = JSON.parse(content);
    return {
      ttft: data.timeToFirstToken ?? null,
      tokensPerSecond: data.tokensPerSecond ?? null,
    };
  } catch {
    return { ttft: null, tokensPerSecond: null };
  }
}
