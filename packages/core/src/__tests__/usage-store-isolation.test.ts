import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { HOME_DIR } from "@wengine-ai/claude-code-router-shared";
import * as usageStore from "../ccr/usage-store";

// Regression guard: the usage store used to hard-code
// join(homedir(), ".claude-code-router", "data"), so even though the test
// worker points CCR_CONFIG_DIR at a temp home, every append() wrote into the
// developer's real usage.sqlite (the phantom demo/project/global rows in the
// request log). The store must resolve its database through HOME_DIR, which
// honors CCR_CONFIG_DIR.
describe("usage store config isolation", () => {
  const markerSession = "usage-store-isolation-test";
  const markerProvider = "isolation-marker-provider";
  const realDbPath = join(homedir(), ".claude-code-router", "data", "usage.sqlite");
  const isolatedDbPath = join(HOME_DIR, "data", "usage.sqlite");

  function countInRealDb(): number {
    if (!existsSync(realDbPath)) return 0;
    let db: Database.Database | undefined;
    try {
      db = new Database(realDbPath, { readonly: true, fileMustExist: false });
      const row = db
        .prepare("SELECT count(*) AS n FROM usage_records WHERE provider = ? AND session_id = ?")
        .get(markerProvider, markerSession) as { n: number };
      return row.n;
    } catch {
      return 0;
    } finally {
      db?.close();
    }
  }

  afterEach(() => {
    usageStore
      .query({ sessionId: markerSession, pageSize: 50 })
      .records.forEach((row) => {
        // No delete API exists; the temp home is removed by the global teardown.
        void row;
      });
  });

  it("keeps the usage database inside CCR_CONFIG_DIR, not the real home", () => {
    expect(process.env.CCR_CONFIG_DIR).toBeTruthy();
    expect(resolve(HOME_DIR)).toBe(resolve(process.env.CCR_CONFIG_DIR as string));
    expect(resolve(isolatedDbPath)).not.toBe(resolve(realDbPath));
    expect(countInRealDb()).toBe(0);

    usageStore.append({
      id: `iso-${Date.now()}`,
      timestamp: new Date().toISOString(),
      sessionId: markerSession,
      provider: markerProvider,
      originalModel: "ccr-opus",
      model: "isolation-marker-model",
      modelFamily: "",
      scenarioType: "default",
      clientType: "unknown",
      stream: false,
      inputTokens: 1,
      outputTokens: 1,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      ttft: null,
      tokensPerSecond: null,
      durationMs: 1,
      status: "success",
    });

    // The write landed in the isolated database ...
    expect(existsSync(isolatedDbPath)).toBe(true);
    const result = usageStore.query({ sessionId: markerSession, pageSize: 10 });
    expect(result.records.some((row) => row.provider === markerProvider)).toBe(true);

    // ... and never in the developer's real database.
    expect(countInRealDb()).toBe(0);
  });
});
