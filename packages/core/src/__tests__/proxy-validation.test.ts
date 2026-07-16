import { describe, expect, it } from "vitest";
import {
  validateProxyUrl,
  findInvalidProxyUrls,
  PROXY_URL_KEYS,
} from "../services/proxy";

describe("validateProxyUrl", () => {
  it("accepts empty / nullish values as 'no proxy'", () => {
    expect(validateProxyUrl("")).toEqual({ ok: true });
    expect(validateProxyUrl("   ")).toEqual({ ok: true });
    expect(validateProxyUrl(undefined)).toEqual({ ok: true });
    expect(validateProxyUrl(null)).toEqual({ ok: true });
  });

  it("accepts http:// and https:// URLs", () => {
    expect(validateProxyUrl("http://127.0.0.1:7890")).toEqual({ ok: true });
    expect(validateProxyUrl("https://proxy.example:8443")).toEqual({ ok: true });
    expect(validateProxyUrl("  http://localhost:18080  ")).toEqual({ ok: true });
  });

  it("accepts values containing $VAR / ${VAR} placeholders (raw config)", () => {
    expect(validateProxyUrl("$PROXY_URL")).toEqual({ ok: true });
    expect(validateProxyUrl("${PROXY_URL}")).toEqual({ ok: true });
    expect(validateProxyUrl("http://${PROXY_HOST}:8080")).toEqual({ ok: true });
    expect(validateProxyUrl("$HTTPS_PROXY")).toEqual({ ok: true });
  });

  it("rejects unsupported protocols", () => {
    const result = validateProxyUrl("socks5://localhost:1080");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("socks5:");
      expect(result.error).toContain("http");
    }
  });

  it("rejects malformed URLs", () => {
    const result = validateProxyUrl("not a url");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("Invalid proxy URL");
    }
  });

  it("does not accept placeholders that are not env-var shaped", () => {
    // "$$" is not a valid $VAR pattern; URL parser will reject it.
    const result = validateProxyUrl("$$://broken");
    expect(result.ok).toBe(false);
  });
});

describe("findInvalidProxyUrls", () => {
  it("returns no errors when the config has no proxy keys", () => {
    expect(findInvalidProxyUrls({ HOST: "0.0.0.0", PORT: 3456 })).toEqual([]);
  });

  it("returns no errors when every proxy URL is valid", () => {
    expect(
      findInvalidProxyUrls({
        PROXY_URL: "http://127.0.0.1:7890",
        HTTPS_PROXY: "${PROXY_URL}",
      })
    ).toEqual([]);
  });

  it("collects an error per invalid key, including compatibility aliases", () => {
    const errors = findInvalidProxyUrls({
      PROXY_URL: "socks5://localhost:1080",
      https_proxy: "ftp://example",
      httpsProxy: "not a url",
    });
    expect(errors).toHaveLength(3);
    const keys = errors.map((e) => e.key).sort();
    expect(keys).toEqual(["PROXY_URL", "https_proxy", "httpsProxy"].sort());
  });

  it("skips nullish and empty values", () => {
    expect(
      findInvalidProxyUrls({
        PROXY_URL: "",
        HTTPS_PROXY: null,
        httpsProxy: undefined,
      })
    ).toEqual([]);
  });

  it("PROXY_URL_KEYS includes the documented compatibility aliases", () => {
    expect(PROXY_URL_KEYS).toContain("PROXY_URL");
    expect(PROXY_URL_KEYS).toContain("HTTPS_PROXY");
    expect(PROXY_URL_KEYS).toContain("https_proxy");
    expect(PROXY_URL_KEYS).toContain("httpsProxy");
  });
});
