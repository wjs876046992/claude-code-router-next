import { describe, expect, it } from "vitest";
import {
  isEventStreamResponse,
  parseJsonText,
  parseResponseJson,
  peekBodyForSSE,
  readBodyForSSE,
} from "../transformer/response-body";

function bodyFromChunks(chunks: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const ch of chunks) controller.enqueue(enc.encode(ch));
      controller.close();
    },
  });
}

function jsonStreamResponse(chunks: string[]): Response {
  return new Response(bodyFromChunks(chunks), {
    headers: { "Content-Type": "application/json" },
  });
}

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

  it("peekBodyForSSE detects a normal SSE body labeled as JSON", async () => {
    const sse = 'event: message_start\ndata: {"type":"message_start"}\n\n';
    const res = jsonStreamResponse([sse]);
    const peeked = await peekBodyForSSE(res);
    expect(peeked?.isSSE).toBe(true);
    // Body still readable (tee'd branch keeps all bytes).
    const reader = peeked!.body.getReader();
    const { value } = await reader.read();
    expect(new TextDecoder().decode(value)).toBe(sse);
    reader.releaseLock();
  });

  it("peekBodyForSSE detects SSE when the first chunk is an empty buffer", async () => {
    const sse = 'event: message_start\ndata: {"type":"message_start"}\n\n';
    const res = jsonStreamResponse(["", sse]);
    const peeked = await peekBodyForSSE(res);
    expect(peeked?.isSSE).toBe(true);
  });

  it("peekBodyForSSE detects SSE preceded by a comment heartbeat", async () => {
    const sse = 'event: message_start\ndata: {"type":"message_start"}\n\n';
    const res = jsonStreamResponse([": ping\n\n", sse]);
    const peeked = await peekBodyForSSE(res);
    expect(peeked?.isSSE).toBe(true);
  });

  it("peekBodyForSSE detects SSE split across multiple partial chunks", async () => {
    const sse = 'event: message_start\ndata: {"type":"message_start"}\n\n';
    const res = jsonStreamResponse(["ev", "ent: message_start\ndata: {}\n\n"]);
    const peeked = await peekBodyForSSE(res);
    expect(peeked?.isSSE).toBe(true);
  });

  it("peekBodyForSSE detects SSE after several empty leading buffers", async () => {
    const sse = 'event: message_start\ndata: {"type":"message_start"}\n\n';
    const res = jsonStreamResponse(["", "", "", sse]);
    const peeked = await peekBodyForSSE(res);
    expect(peeked?.isSSE).toBe(true);
  });

  it("peekBodyForSSE classifies a genuine JSON body as not-SSE", async () => {
    const res = jsonStreamResponse([JSON.stringify({ ok: true })]);
    const peeked = await peekBodyForSSE(res);
    expect(peeked?.isSSE).toBe(false);
    // Body still readable for downstream JSON parse.
    const text = await new Response(peeked!.body).text();
    expect(JSON.parse(text)).toEqual({ ok: true });
  });

  it("peekBodyForSSE returns null for a locked body", async () => {
    const res = jsonStreamResponse(['{"ok":true}']);
    const reader = res.body!.getReader(); // lock it
    const peeked = await peekBodyForSSE(res);
    expect(peeked).toBeNull();
    reader.releaseLock();
  });

  it("readBodyForSSE converts a mislabeled SSE body into a stream response", async () => {
    const sse = 'event: message_start\ndata: {"type":"message_start"}\n\n';
    const res = jsonStreamResponse([sse]);
    const drained = await readBodyForSSE(res);
    expect(drained.isSSE).toBe(true);
    expect(drained.response.headers.get("Content-Type")).toContain(
      "text/event-stream"
    );
    const text = await drained.response.text();
    expect(text).toBe(sse);
  });

  it("readBodyForSSE passes through genuine JSON text for parsing", async () => {
    const res = jsonStreamResponse([JSON.stringify({ ok: true })]);
    const drained = await readBodyForSSE(res);
    expect(drained.isSSE).toBe(false);
    const json = await parseResponseJson(drained.response);
    expect(json).toEqual({ ok: true });
  });

  it("readBodyForSSE falls back to the original response when the body cannot be consumed", async () => {
    const sse = 'event: message_start\ndata: {"type":"message_start"}\n\n';
    const res = jsonStreamResponse([sse]);
    const reader = res.body!.getReader(); // lock it — text() will now throw
    const peeked = await peekBodyForSSE(res);
    expect(peeked).toBeNull();
    const drained = await readBodyForSSE(res);
    // Locked body cannot be read, so it degrades gracefully (no crash, no
    // false positive) and returns the original response for the caller's
    // JSON-parse error path.
    expect(drained.isSSE).toBe(false);
    expect(drained.response).toBe(res);
    reader.releaseLock();
  });
});
