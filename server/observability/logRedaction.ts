/**
 * Redaction for the admin-only structured log surface.
 *
 * This is deliberately *not* `redactErrorText` from `security/errorHandler.ts`. That function
 * guards client-facing error bodies, where any URL or absolute path is a leak to an untrusted
 * caller. The log viewer is the opposite audience: an authenticated administrator whose whole
 * purpose is diagnosing local services, so blanking `http://127.0.0.1:8188` or a project path
 * would destroy the feature's only value. Credentials are still masked unconditionally — the
 * operator credential, upstream API keys and webhook secrets must never be readable, and
 * `docs/admin-user-design.md` requires sensitive parameters never to reach logs.
 */

export const logFieldLimit = 2000;
export const logEntryLimit = 8000;
export const logDepthLimit = 4;
export const logCollectionLimit = 50;

/** 归一化（去 -/_、小写）后完全匹配即整值替换：`{password:"..."}` 这类没有 key=value 文本形态的泄露。
 *  `apiKey` 已在此列；提供商现在把明文密钥放在该字段，所以它必须继续被整值替换。 */
const sensitiveKey = /^(?:password|passwd|passwordhash|authorization|cookie|setcookie|apikey|accesskey|apikeytoken|accesstoken|refreshtoken|sessiontoken|token|secret|clientsecret|privatekey|credential|hash)$/;

/**
 * `key<sep>value` secrets. The key and separator are captured so the replacement keeps them:
 * blanking the whole `"apiKey":"sk-…"` token would both malform the surrounding JSON and destroy
 * the useful fact that an apiKey field was present. Quote style is preserved for the same reason —
 * an operator reads these lines as JSON, and a mangled line is a bug in a log viewer. The value may
 * carry an auth scheme (`Authorization: Bearer xyz`), which is consumed in one step so the result
 * is a single clean marker rather than a leftover `Bearer`.
 */
const secretAssignments = /\b(password|passwd|authorization|cookie|api[-_]?key|access[-_]?token|refresh[-_]?token|session[-_]?token|token|secret|client[-_]?secret|private[-_]?key)\b(["']?\s*[:=]\s*)(?:(?:Bearer|Basic)\s+)?("[^"]*"|'[^']*'|[^\s,;"'<>]+)/gi;

function blankSecret(_match: string, key: string, separator: string, value: string) {
  if (value.startsWith("\"")) return key + separator + "\"[REDACTED]\"";
  if (value.startsWith("'")) return key + separator + "'[REDACTED]'";
  return key + separator + "[REDACTED]";
}

/**
 * Text-level redaction. Keeps scheme/host/path so an operator can still see *which* service was
 * involved, while removing inline credentials, `key=value` secrets, URL userinfo and URL
 * query/hash (where bearer-style tokens and signed parameters live).
 */
export function redactLogText(text: string): string {
  return text
    .replace(secretAssignments, blankSecret)
    .replace(/\b(Bearer|Basic)\s+[^\s,;"'<>]+/gi, "$1 [REDACTED]")
    .replace(/(\bhttps?:\/\/)[^\s"'<>]*@/gi, "$1")
    .replace(/(\bhttps?:\/\/[^\s"'<>?#]*)[?#][^\s"'<>]*/gi, "$1[REDACTED_QUERY]");
}

function project(value: unknown, depth: number): { value: unknown; truncated: boolean } {
  if (typeof value === "string") return { value: redactLogText(value), truncated: false };
  if (typeof value === "bigint") return { value: redactLogText(String(value)), truncated: false };
  if (typeof value === "function" || typeof value === "symbol") return { value: "[UNSERIALIZABLE]", truncated: true };
  if (typeof value !== "object" || value === null) return { value, truncated: false };
  if (depth >= logDepthLimit) return { value: "[TRUNCATED_DEPTH]", truncated: true };
  if (Array.isArray(value)) {
    const items = value.slice(0, logCollectionLimit).map((item) => project(item, depth + 1));
    return { value: items.map((item) => item.value), truncated: value.length > logCollectionLimit || items.some((item) => item.truncated) };
  }
  const entries = Object.entries(value as Record<string, unknown>);
  let truncated = entries.length > logCollectionLimit;
  const result: Record<string, unknown> = {};
  for (const [key, entry] of entries.slice(0, logCollectionLimit)) {
    if (sensitiveKey.test(key.replace(/[-_]/g, "").toLowerCase())) { result[key] = "[REDACTED]"; continue; }
    const projected = project(entry, depth + 1);
    if (projected.truncated) truncated = true;
    result[key] = projected.value;
  }
  return { value: result, truncated };
}

function serialize(value: unknown): string {
  try { return JSON.stringify(value) ?? "null"; }
  catch { return JSON.stringify("[UNSERIALIZABLE]"); }
}

export interface RedactedFields { fields: Record<string, unknown>; truncated: boolean }

/**
 * Redacted projection stored in the in-memory buffer. Returns `truncated:true` whenever a field
 * or the whole-entry budget forced a visible cut, so a reader can never mistake a clipped entry
 * for a complete one.
 */
export function redactLogFields(fields: Record<string, unknown>): RedactedFields {
  const result: Record<string, unknown> = {};
  let bytes = 0;
  let truncated = false;
  for (const [key, value] of Object.entries(fields)) {
    if (bytes >= logEntryLimit) { truncated = true; break; }
    const projected = sensitiveKey.test(key.replace(/[-_]/g, "").toLowerCase())
      ? { value: "[REDACTED]", truncated: false }
      : project(value, 0);
    let json = serialize(projected.value);
    if (json.length > logFieldLimit) { json = serialize(json.slice(0, logFieldLimit) + "…[truncated]"); truncated = true; }
    if (projected.truncated) truncated = true;
    bytes += key.length + json.length;
    result[key] = JSON.parse(json) as unknown;
  }
  return { fields: result, truncated };
}
