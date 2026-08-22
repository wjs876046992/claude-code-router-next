/**
 * Parse a transformer parameter value entered in the UI into the type the
 * transformer actually expects. JSON objects/arrays (e.g.
 * `{"reasoning":{"enabled":true,"effort":"max"}}`) become real objects;
 * boolean and number literals become real booleans/numbers; anything else
 * stays a plain string.
 */
export function parseParamValue(value: string): unknown {
  const trimmed = value.trim();

  if (trimmed === "true") return true;
  if (trimmed === "false") return false;

  if (trimmed !== "" && !Number.isNaN(Number(trimmed))) {
    return Number(trimmed);
  }

  // Only treat as JSON when it clearly starts an object/array — otherwise a
  // value like `{placeholder}` would surface a confusing parse error.
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      return JSON.parse(trimmed);
    } catch {
      // Malformed JSON — keep the raw string so the user can fix it and the
      // config never becomes silently invalid.
      return value;
    }
  }

  return value;
}

/**
 * Format a stored parameter value back into the text shown in the UI input.
 */
export function formatParamValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined || value === null) return "";
  return JSON.stringify(value);
}
