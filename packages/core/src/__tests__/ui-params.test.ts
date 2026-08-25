import { describe, expect, it } from "vitest";
// UI util is pure TS with no React deps — test it from the core suite where
// vitest is already configured.
import { parseParamValue, formatParamValue } from "../../../ui/src/utils/params";

describe("parseParamValue", () => {
  it("parses nested JSON objects", () => {
    expect(parseParamValue('{"reasoning":{"enabled":true,"effort":"max"}}')).toEqual({
      reasoning: { enabled: true, effort: "max" },
    });
  });

  it("parses JSON arrays", () => {
    expect(parseParamValue("[1,2,3]")).toEqual([1, 2, 3]);
  });

  it("parses boolean literals", () => {
    expect(parseParamValue("true")).toBe(true);
    expect(parseParamValue("false")).toBe(false);
  });

  it("parses numbers", () => {
    expect(parseParamValue("8192")).toBe(8192);
    expect(parseParamValue("0")).toBe(0);
  });

  it("keeps plain strings as strings", () => {
    expect(parseParamValue("hello")).toBe("hello");
    expect(parseParamValue("sk-abc123")).toBe("sk-abc123");
  });

  it("keeps malformed JSON as the raw string", () => {
    expect(parseParamValue("{placeholder}")).toBe("{placeholder}");
  });

  it("treats empty string as empty string, not zero", () => {
    expect(parseParamValue("")).toBe("");
  });

  it("round-trips nested objects through formatParamValue", () => {
    const v = parseParamValue('{"reasoning":{"enabled":true}}');
    expect(formatParamValue(v)).toBe('{"reasoning":{"enabled":true}}');
    expect(formatParamValue("hello")).toBe("hello");
    expect(formatParamValue(true)).toBe("true");
  });
});
