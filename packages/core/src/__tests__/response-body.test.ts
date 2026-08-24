import { describe, expect, it } from "vitest";
import {
  isEventStreamResponse,
  parseJsonText,
  parseResponseJson,
} from "../transformer/response-body";

describe("response-body helpers", () => {
  it("parses a normal JSON body", async () => {
    const res = new Response(JSON.stringify({ ok: true }), {
      headers: { "Content-Type": "application/json" },
    });
    await expect(parseResponseJson(res)).resolves.toEqual({ ok: true });
  });

  it("tolerates whitespace-padded JSON bodies", async () => {
    const res = new Response('\n\n   \n{"id":"gen-1"}\n', {
      headers: { "Content-Type": "application/json" },
    });
    await expect(parseResponseJson(res)).resolves.toEqual({ id: "gen-1" });
  });

  it("throws a descriptive error for SSE text mislabeled as JSON", async () => {
    const body = ': OPENROUTER PROCESSING\n\ndata: {"error": {"message": "upstream timeout"}}\n\n';
    const res = new Response(body, {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
    await expect(parseResponseJson(res)).rejects.toThrow(
      /Upstream returned a non-JSON response \(HTTP 200\): : OPENROUTER PROCESSING/
    );
  });

  it("throws a descriptive error for empty bodies", () => {
    expect(() => parseJsonText("", 502)).toThrow(
      /Upstream returned a non-JSON response \(HTTP 502\): \(empty body\)/
    );
  });

  it("truncates long non-JSON previews", () => {
    const long = "x".repeat(500);
    expect(() => parseJsonText(long)).toThrow(/\.\.\.$/);
  });

  it("detects event streams by Content-Type", () => {
    const sse = new Response("", {
      headers: { "Content-Type": "text/event-stream" },
    });
    const json = new Response("", {
      headers: { "Content-Type": "application/json" },
    });
    expect(isEventStreamResponse(sse)).toBe(true);
    expect(isEventStreamResponse(json)).toBe(false);
    expect(isEventStreamResponse(new Response(""))).toBe(false);
  });
});
