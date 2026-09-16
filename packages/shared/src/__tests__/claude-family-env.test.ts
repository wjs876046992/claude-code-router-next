import { describe, expect, it } from "vitest";
import {
  CLAUDE_AUTO_COMPACT_PCT_OVERRIDE,
  getClaudeFamilyEnv,
  getClaudeTakeoverContextWindow,
} from "../client-integrations";

// These lock the contract shared by the two Claude Code write paths: the
// settings-file takeover (applyClaudeModelFamilies / applyClaudeAutoCompactSettings)
// and `ccr code`'s command env (createEnvVariables). They used to compute these
// independently, which let the aliases, the extended-context gating, and the
// auto-compact window drift apart between the two.

function makeConfig(router: Record<string, any> = {}, contextWindow = 1000000) {
  return { ContextWindow: contextWindow, PORT: 3456, APIKEY: "test", Router: router };
}

describe("getClaudeFamilyEnv", () => {
  it("emits ccr-<family>[1m] aliases when the family has extended context", () => {
    const env = getClaudeFamilyEnv(
      makeConfig({
        families: {
          opus: { default: "p,m", enableExtendedContext: true },
          sonnet: { default: "p,m" },
        },
      })
    );

    expect(env.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe("ccr-opus[1m]");
    expect(env.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe("ccr-sonnet");
    expect(env.ANTHROPIC_MODEL).toBe("ccr-opus[1m]");
    expect(env.ANTHROPIC_REASONING_MODEL).toBe("ccr-opus[1m]");
  });

  it("prefers a family with a think route for the reasoning alias", () => {
    const env = getClaudeFamilyEnv(
      makeConfig({
        families: {
          opus: { default: "p,m" },
          haiku: { default: "p,m", think: "p,think" },
        },
      })
    );

    expect(env.ANTHROPIC_REASONING_MODEL).toBe("ccr-haiku");
  });

  it("drops every alias when family routing is explicitly disabled", () => {
    // A stale enableExtendedContext must not survive an explicit opt-out: the
    // emitted ccr-*[1m] alias would have no family route to resolve to.
    const env = getClaudeFamilyEnv(
      makeConfig({
        enableFamilyRouting: false,
        families: { opus: { default: "p,m", enableExtendedContext: true } },
      })
    );

    expect(env).toEqual({});
  });

  it("returns nothing when no families are configured", () => {
    expect(getClaudeFamilyEnv(makeConfig({}))).toEqual({});
  });
});

describe("getClaudeTakeoverContextWindow", () => {
  it("keeps the configured window when the default family has extended context", () => {
    expect(
      getClaudeTakeoverContextWindow(
        makeConfig({ families: { opus: { enableExtendedContext: true } } })
      )
    ).toBe(1000000);
  });

  it("caps at 200000 when the default family lacks extended context", () => {
    expect(
      getClaudeTakeoverContextWindow(makeConfig({ families: { opus: { default: "p,m" } } }))
    ).toBe(200000);
  });

  it("ignores a stale family extended-context flag when routing is disabled", () => {
    // Mirrors the alias rule above: window and alias must agree, or the session
    // keeps a 1M window while routing to a non-extended model.
    expect(
      getClaudeTakeoverContextWindow(
        makeConfig({
          enableFamilyRouting: false,
          families: { opus: { enableExtendedContext: true } },
        })
      )
    ).toBe(200000);
  });
});

describe("CLAUDE_AUTO_COMPACT_PCT_OVERRIDE", () => {
  it("is a single shared constant so both write paths agree", () => {
    // Was "85" in the CLI and "90" in the takeover; Claude Code only lowers the
    // threshold with this, and its env layer wins, so the CLI value dominated.
    expect(CLAUDE_AUTO_COMPACT_PCT_OVERRIDE).toBe("90");
  });
});
