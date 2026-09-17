import { describe, it, expect } from "vitest";
import { compareVersions, cleanVersionBase } from "../utils/update";

describe("Version comparison with prerelease support", () => {
  it("strips prerelease suffixes correctly", () => {
    expect(cleanVersionBase("2.3.2407-alpha.1")).toBe("2.3.2407");
    expect(cleanVersionBase("2.3.2407")).toBe("2.3.2407");
    expect(cleanVersionBase("3.0.0-beta.2")).toBe("3.0.0");
  });

  it("does not report update when local has -alpha.x matching upstream release", () => {
    // Upstream on npm: 2.3.2407, Local fork: 2.3.2407-alpha.1
    expect(compareVersions("2.3.2407", "2.3.2407-alpha.1")).toBe(0);
    expect(compareVersions("2.3.2407", "2.3.2407-alpha.2")).toBe(0);
  });

  it("reports update when upstream has a genuinely newer base release", () => {
    // Upstream releases 2.3.2408 or 2.4.0
    expect(compareVersions("2.3.2408", "2.3.2407-alpha.1")).toBe(1);
    expect(compareVersions("2.4.0", "2.3.2407-alpha.1")).toBe(1);
  });

  it("reports older when upstream is behind", () => {
    expect(compareVersions("2.3.2406", "2.3.2407-alpha.1")).toBe(-1);
  });
});
