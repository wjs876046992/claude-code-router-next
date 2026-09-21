import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { homedir } from "node:os";
import {
  BASE_DIR,
  HOME_DIR,
  PROFILES_DIR,
  ACTIVE_PROFILE_FILE,
} from "../constants";
import { getProfileDir, getProfileConfigPath } from "../profile";

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
});
