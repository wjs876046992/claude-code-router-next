/**
 * Shared helpers for safely consuming upstream response bodies.
 *
 * Some providers (e.g. OpenRouter) occasionally return SSE comment lines
 * (like ": OPENROUTER PROCESSING") or plain-text error payloads with an
 * `application/json` Content-Type. A bare `response.json()` then throws an
 * opaque SyntaxError ("Unexpected token ':' ... is not valid JSON") that
 * gives no hint about what the upstream actually said. These helpers parse
 * leniently and surface the raw body in the error instead.
 */

/**
 * Parse a Response body as JSON, tolerating leading/trailing whitespace and
 * BOM. On failure, throw an Error whose message includes a truncated preview
 * of the raw body so logs show what the upstream actually returned.
 */
export async function parseResponseJson(response: Response): Promise<any> {
  const text = await response.text();
  return parseJsonText(text, response.status);
}

/**
 * Parse text as JSON after stripping BOM and surrounding whitespace
 * (some providers pad JSON responses with whitespace keep-alives).
 */
export function parseJsonText(text: string, status?: number): any {
  const cleaned = text.replace(/^﻿/, "").trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    const preview = cleaned.length > 200 ? `${cleaned.slice(0, 200)}...` : cleaned;
    const statusInfo = status !== undefined ? ` (HTTP ${status})` : "";
    throw new Error(
      `Upstream returned a non-JSON response${statusInfo}: ${preview || "(empty body)"}`
    );
  }
}

/**
 * Detect whether a response actually carries an SSE stream, regardless of
 * what the client requested. Used to decide streaming vs JSON handling based
 * on the upstream response rather than the request body.
 */
export function isEventStreamResponse(response: Response): boolean {
  const contentType = response.headers.get("Content-Type") || "";
  return contentType.includes("text/event-stream");
}
