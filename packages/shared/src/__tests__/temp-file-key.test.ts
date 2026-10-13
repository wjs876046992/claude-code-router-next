import { describe, it, expect } from "vitest";
import { sanitizeTempFileKey } from "../temp-file-key";

describe("sanitizeTempFileKey", () => {
  it("keeps safe characters untouched", () => {
    expect(sanitizeTempFileKey("req-abc_123.session")).toBe("req-abc_123.session");
  });

  it("replaces path separators so traversal cannot escape the directory", () => {
    // '.' stays (safe inside a single name component); '/' and '\\' become '_'
    // so the result can never traverse out of the temp directory.
    const name = sanitizeTempFileKey("../../etc/passwd");
    expect(name).not.toContain("/");
    expect(name).not.toContain("\\");
    expect(name).toBe(".._.._etc_passwd");
    expect(sanitizeTempFileKey("a/b\\c:d*e?f\"g<h>i|j")).toBe("a_b_c_d_e_f_g_h_i_j");
  });

  it("caps the key length at 200 chars", () => {
    const long = "k".repeat(500);
    expect(sanitizeTempFileKey(long)).toHaveLength(200);
    expect(sanitizeTempFileKey(long)).toBe("k".repeat(200));
  });

  it("is deterministic so writer and reader agree on the same file name", () => {
    const key = "session/weird id:1";
    expect(sanitizeTempFileKey(key)).toBe(sanitizeTempFileKey(key));
  });
});
