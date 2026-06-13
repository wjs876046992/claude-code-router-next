// Shared helpers for extracting the Claude Code session id from a request.
//
// Claude Code historically encoded the session id inside metadata.user_id as
// `user_..._session_<sessionId>`. Newer versions send it as a JSON string
// (`{"session_id":"..."}`) or, in some flows, as a structured object. The
// session id is later used to build filesystem paths (e.g. `<sessionId>.jsonl`),
// so the value must be validated to avoid path traversal.

const SAFE_SESSION_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

export function normalizeSessionId(sessionId: unknown): string | undefined {
  if (typeof sessionId !== "string") {
    return undefined;
  }

  const value = sessionId.trim();
  if (!value || !SAFE_SESSION_ID_PATTERN.test(value)) {
    return undefined;
  }

  return value;
}

export function extractSessionIdFromUserId(userId: unknown): string | undefined {
  if (!userId) {
    return undefined;
  }

  if (typeof userId === "object") {
    return normalizeSessionId((userId as any).session_id ?? (userId as any).sessionId);
  }

  if (typeof userId !== "string") {
    return undefined;
  }

  const value = userId.trim();
  if (!value) {
    return undefined;
  }

  // Claude Code may send metadata.user_id as a JSON string: {"session_id":"..."}
  try {
    const parsed = JSON.parse(value);
    const sessionId = normalizeSessionId(parsed?.session_id ?? parsed?.sessionId);
    if (sessionId) {
      return sessionId;
    }
  } catch {
    // Not JSON; fall back to the legacy metadata.user_id format.
  }

  // Legacy format: user_..._session_<sessionId>
  const marker = "_session_";
  const markerIndex = value.lastIndexOf(marker);
  if (markerIndex !== -1) {
    return normalizeSessionId(value.slice(markerIndex + marker.length));
  }

  return undefined;
}
