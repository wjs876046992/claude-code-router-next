import { describe, it, expect } from "vitest";
import { join } from "node:path";
import {
  BASE_DIR,
  HOME_DIR,
  PROFILES_DIR,
  ACTIVE_PROFILE_FILE,
} from "../constants";
import { getProfileDir, getProfileConfigPath } from "../profile";
import { getProfileDirPath, pickProfileHomeDir } from "../constants";

// When a profile is active, CCR_CONFIG_DIR points *inside* that profile's
// directory (HOME_DIR follows it). Profile management state must still resolve
// against the global BASE_DIR — deriving it from HOME_DIR nested profile dirs
// inside each other (profiles/<active>/profiles/default/…) and made every
// running process see its own private "active-profile" file.
describe("profile management paths are global, not profile-scoped", () => {
  it("PROFILES_DIR lives under BASE_DIR even when CCR_CONFIG_DIR is set", () => {
    expect(PROFILES_DIR).toBe(join(BASE_DIR, "profiles"));
    expect(PROFILES_DIR.startsWith(HOME_DIR)).toBe(
      HOME_DIR === BASE_DIR
    );
  });

  it("ACTIVE_PROFILE_FILE lives under the global PROFILES_DIR", () => {
    expect(ACTIVE_PROFILE_FILE).toBe(join(PROFILES_DIR, "active-profile"));
  });

  it("profile dirs resolve under the global BASE_DIR", () => {
    expect(getProfileDir("work")).toBe(join(BASE_DIR, "profiles", "work"));
    expect(getProfileConfigPath("work")).toBe(
      join(BASE_DIR, "profiles", "work", "config.json")
    );
  });

  it("getProfileDirPath returns BASE_DIR for 'default' profile", () => {
    expect(getProfileDirPath("default")).toBe(BASE_DIR);
  });

  it("getProfileDirPath returns profiles/<name> for named profiles", () => {
    expect(getProfileDirPath("work")).toBe(join(BASE_DIR, "profiles", "work"));
    expect(getProfileDirPath("personal")).toBe(join(BASE_DIR, "profiles", "personal"));
  });
});

// Short-lived helpers (`ccr statusline`, spawned by Claude Code) inherit no
// CCR_CONFIG_DIR, so they must resolve the active profile at call time. Reading
// a module-load-time HOME_DIR made them report the base dir's config and usage
// database even while a profile was active.
//
// These exercise the pure decision table only. The real resolver reads
// ACTIVE_PROFILE_FILE, which always lives under BASE_DIR — i.e. the developer's
// actual ~/.claude-code-router — so a test that manipulated it would clobber
// real configuration.
describe("profile home resolution decision table", () => {
  const BASE = "/home/u/.claude-code-router";
  const PROFILES = join(BASE, "profiles");

  it("prefers an explicit profile-scoped CCR_CONFIG_DIR", () => {
    expect(pickProfileHomeDir(join(PROFILES, "work"), "other", BASE, PROFILES)).toBe(
      join(PROFILES, "work")
    );
  });

  it("honors a custom (non-base) CCR_CONFIG_DIR", () => {
    expect(pickProfileHomeDir("/tmp/custom-ccr", "work", BASE, PROFILES)).toBe(
      "/tmp/custom-ccr"
    );
  });

  it("treats a base-dir CCR_CONFIG_DIR as 'no profile pinned'", () => {
    // A stale export naming the base dir identifies the default profile, so it
    // must not mask the recorded active profile.
    expect(pickProfileHomeDir(BASE, "work", BASE, PROFILES)).toBe(
      join(PROFILES, "work")
    );
  });

  it("falls back to the recorded active profile with no env override", () => {
    expect(pickProfileHomeDir(undefined, "work", BASE, PROFILES)).toBe(
      join(PROFILES, "work")
    );
    expect(pickProfileHomeDir(undefined, "work\n", BASE, PROFILES)).toBe(
      join(PROFILES, "work")
    );
  });

  it("falls back to the base dir for the default profile or no record", () => {
    expect(pickProfileHomeDir(undefined, "default", BASE, PROFILES)).toBe(BASE);
    expect(pickProfileHomeDir(undefined, "", BASE, PROFILES)).toBe(BASE);
    expect(pickProfileHomeDir(undefined, null, BASE, PROFILES)).toBe(BASE);
  });
});
