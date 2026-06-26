import { describe, it, expect } from "vitest";
import { collectReachableModelKeys } from "../utils/health-reconcile";

// Must match the NUL separator used internally by health-reconcile.
const SEP = String.fromCharCode(0);
const key = (provider: string, model: string) => `${provider}${SEP}${model}`;

describe("collectReachableModelKeys", () => {
  it("includes every model listed under a provider", () => {
    const keys = collectReachableModelKeys({
      Providers: [{ name: "ollama", models: ["glm-5.2:cloud", "qwen3:8b"] }],
    });
    expect(keys.has(key("ollama", "glm-5.2:cloud"))).toBe(true);
    expect(keys.has(key("ollama", "qwen3:8b"))).toBe(true);
  });

  it("does NOT include a renamed/removed model that is no longer configured", () => {
    const keys = collectReachableModelKeys({
      Providers: [{ name: "ollama", models: ["glm-5.2:cloud"] }],
    });
    // The old name is the classic orphan: configured model was renamed to add ":cloud".
    expect(keys.has(key("ollama", "glm-5.2"))).toBe(false);
  });

  it("treats models referenced via Router as reachable even when provider.models is empty", () => {
    const keys = collectReachableModelKeys({
      Providers: [{ name: "aliyun", models: [] }],
      Router: { background: "aliyun,glm-5" },
    });
    expect(keys.has(key("aliyun", "glm-5"))).toBe(true);
  });

  it("collects targets from nested Router structures and fallback arrays", () => {
    const keys = collectReachableModelKeys({
      Providers: [
        { name: "p1", models: [] },
        { name: "p2", models: [] },
        { name: "p3", models: [] },
      ],
      Router: {
        families: { opus: { default: "p1,m1", fallback: { default: ["p2,m2"] } } },
      },
      fallback: { default: ["p3,m3"] },
    });
    expect(keys.has(key("p1", "m1"))).toBe(true);
    expect(keys.has(key("p2", "m2"))).toBe(true);
    expect(keys.has(key("p3", "m3"))).toBe(true);
  });

  it("ignores routing targets whose provider is not configured", () => {
    const keys = collectReachableModelKeys({
      Providers: [{ name: "known", models: [] }],
      Router: { default: "ghost,model" },
    });
    expect(keys.has(key("ghost", "model"))).toBe(false);
  });

  it("supports provider names containing spaces without key collisions", () => {
    const keys = collectReachableModelKeys({
      Providers: [{ name: "阿里云 Coding Plan", models: [] }],
      Router: { background: "阿里云 Coding Plan,glm-5" },
    });
    expect(keys.has(key("阿里云 Coding Plan", "glm-5"))).toBe(true);
  });

  it("handles missing/empty config without throwing", () => {
    expect(collectReachableModelKeys(undefined).size).toBe(0);
    expect(collectReachableModelKeys({}).size).toBe(0);
    expect(collectReachableModelKeys({ Providers: [] }).size).toBe(0);
  });
});
