import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  sanitizeTempFileKey,
  TOKEN_SPEED_TEMP_SUBDIRECTORY,
} from "@wengine-ai/claude-code-router-shared";
import { TempFileOutputHandler } from "../plugins/output/temp-file-handler";
import { readTokenSpeedStats } from "../ccr/usage-store";

// Isolate from the real user temp directory: redirect os.tmpdir() for this
// test process BEFORE any path is resolved. os.tmpdir() re-reads TMPDIR on
// every call on POSIX, and both sides of the round trip honor it — the writer
// (TempFileOutputHandler) resolves its base directory at construction and the
// reader (readTokenSpeedStats) resolves per call. The original value is
// restored in afterAll so the mutation cannot leak into other test files
// running later on the same vitest worker.
const ORIGINAL_TMPDIR = process.env.TMPDIR;
const TEST_TMP_ROOT = mkdtempSync(join(tmpdir(), "ccr-token-speed-roundtrip-"));
process.env.TMPDIR = TEST_TMP_ROOT;

// Both sides must agree on the v2 subdirectory under the (redirected) temp root.
const BASE_DIR = join(TEST_TMP_ROOT, TOKEN_SPEED_TEMP_SUBDIRECTORY);

const handler = new TempFileOutputHandler({
  subdirectory: TOKEN_SPEED_TEMP_SUBDIRECTORY,
  prefix: "session",
  extension: "json",
  includeTimestamp: false,
});

// Unique keys keep parallel test files/runs from clobbering each other in the
// shared redirected temp root.
const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
const roundtripKey = `ts-roundtrip-${suffix}`;
const badJsonKey = `ts-badjson-${suffix}`;
const specialKey = `req/abc:1-${suffix}`;
const missingKey = `no-such-key-${suffix}`;

afterAll(() => {
  process.env.TMPDIR = ORIGINAL_TMPDIR;
  rmSync(TEST_TMP_ROOT, { recursive: true, force: true });
});

describe("token speed temp file round-trip", () => {
  it("reads back TTFT and tokensPerSecond written by the temp file handler", async () => {
    const written = await handler.output(
      {
        requestId: "req-roundtrip",
        stream: true,
        tokenCount: 100,
        timeToFirstToken: 123,
        tokensPerSecond: 45.6,
      },
      { metadata: { sessionId: roundtripKey } }
    );
    expect(written).toBe(true);

    // The writer must have published into the v2 subdirectory...
    expect(
      existsSync(join(BASE_DIR, `session-${sanitizeTempFileKey(roundtripKey)}.json`))
    ).toBe(true);

    // ...and the reader must resolve the exact same v2 path.
    const stats = readTokenSpeedStats(roundtripKey);
    expect(stats).toEqual({ ttft: 123, tokensPerSecond: 45.6 });
  });

  it("returns nulls when the exact session file does not exist", () => {
    expect(readTokenSpeedStats(missingKey)).toEqual({
      ttft: null,
      tokensPerSecond: null,
    });
  });

  it("returns nulls when the file contains invalid JSON", () => {
    mkdirSync(BASE_DIR, { recursive: true });
    writeFileSync(join(BASE_DIR, `session-${sanitizeTempFileKey(badJsonKey)}.json`), "not-json", "utf-8");

    expect(readTokenSpeedStats(badJsonKey)).toEqual({
      ttft: null,
      tokensPerSecond: null,
    });
  });

  it("sanitizes special characters in the key symmetrically on both sides", async () => {
    const written = await handler.output(
      {
        requestId: "req-special",
        stream: false,
        tokenCount: 10,
        timeToFirstToken: 7,
        tokensPerSecond: 99.5,
      },
      { metadata: { sessionId: specialKey } }
    );
    expect(written).toBe(true);

    // The written file must live at the sanitized, non-traversing location the
    // reader reconstructs from the raw key. The handler sanitizes internally,
    // so writer and reader agree without any wrapper.
    const sanitized = sanitizeTempFileKey(specialKey);
    expect(sanitized).not.toContain("/");
    expect(existsSync(join(BASE_DIR, `session-${sanitized}.json`))).toBe(true);

    expect(readTokenSpeedStats(specialKey)).toEqual({
      ttft: 7,
      tokensPerSecond: 99.5,
    });
  });

  it("uses metadata.statsKey for the file name when provided (matches the reader)", async () => {
    // token-speed puts the per-request key in metadata.statsKey (= usageSessionId ||
    // requestId) and the conversation UUID in metadata.sessionId. The file MUST
    // be named with statsKey so readTokenSpeedStats(speedStatsKey) finds it;
    // naming with sessionId would make TTFT always null (the regression that
    // motivated this test).
    const statsKey = `stats-key-${suffix}`;
    const conversationId = `conv-${suffix}`;
    const written = await handler.output(
      {
        requestId: "req-statskey",
        stream: true,
        tokenCount: 50,
        timeToFirstToken: 999,
        tokensPerSecond: 30.0,
      },
      { metadata: { sessionId: conversationId, statsKey } }
    );
    expect(written).toBe(true);

    // File is named session-<statsKey>.json, NOT session-<conversationId>.json
    expect(existsSync(join(BASE_DIR, `session-${sanitizeTempFileKey(statsKey)}.json`))).toBe(true);
    expect(existsSync(join(BASE_DIR, `session-${sanitizeTempFileKey(conversationId)}.json`))).toBe(false);

    // Reader uses speedStatsKey (= usageSessionId = statsKey) and finds the file
    expect(readTokenSpeedStats(statsKey)).toEqual({ ttft: 999, tokensPerSecond: 30.0 });
  });

  it("resolves the v2 subdirectory and never falls back to the legacy flat path", () => {
    const key = `legacy-layout-${suffix}`;
    const legacyDir = join(TEST_TMP_ROOT, "claude-code-router");
    mkdirSync(legacyDir, { recursive: true });
    // A file at the pre-v2 flat location must be invisible to the reader:
    // old timestamped/flat files belong to legacy processes only.
    writeFileSync(
      join(legacyDir, `session-${sanitizeTempFileKey(key)}.json`),
      JSON.stringify({ timeToFirstToken: 1, tokensPerSecond: 1 }),
      "utf-8"
    );

    expect(readTokenSpeedStats(key)).toEqual({
      ttft: null,
      tokensPerSecond: null,
    });
  });
});
