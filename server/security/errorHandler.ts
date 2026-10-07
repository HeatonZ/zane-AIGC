import type { ErrorRequestHandler } from "express";
import { HttpError } from "../errors.js";

/** Client responses are not a diagnostic/log channel. Preserve actionable domain codes, not infrastructure secrets. */
export function redactErrorText(text: string): string {
  return text
    .replace(/\b(Bearer|Basic)\s+[^\s,;"'<>]+/gi, "$1 [REDACTED]")
    .replace(/\b(authorization|cookie|set-cookie|password|passwd|api[-_]?key|access[-_]?token|refresh[-_]?token|token|secret)\b["']?\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;"'<>]+)/gi, "$1=[REDACTED]")
    .replace(/https?:\/\/[^\s"'<>]+/gi, "[REDACTED_URL]")
    .replace(/(?:[A-Za-z]:[\\/]|\\\\)[^\s"'<>]+/g, "[REDACTED_PATH]")
    .replace(/\/(?:home|Users|tmp|var|etc|opt|root|mnt|srv|data|proc|sys)\/[^\s"'<>]+/g, "[REDACTED_PATH]");
}
function redactDetails(value: unknown): unknown {
  if (typeof value === "string") return redactErrorText(value);
  if (Array.isArray(value)) return value.map(redactDetails);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, /^(?:password|passwordHash|authorization|cookie|apiKey|accessToken|refreshToken|token|secret|stack|filePath|path|projectDirectory|comfyuiBaseUrl)$/i.test(key.replace(/[-_]/g, "")) ? "[REDACTED]" : redactDetails(entry)]));
  return value;
}
export function errorResponse(error: unknown, redact: boolean, requestId?: string) {
  const suppliedStatus = error instanceof HttpError ? error.status : (error as { status?: unknown } | null)?.status;
  const status = typeof suppliedStatus === "number" && Number.isInteger(suppliedStatus) && suppliedStatus >= 400 && suppliedStatus <= 599 ? suppliedStatus : 500;
  const domainError = error instanceof HttpError;
  const visible = !redact || (domainError && status < 500);
  const parserType = (error as { type?: unknown } | null)?.type;
  const code = domainError ? error.code : parserType === "entity.parse.failed" ? "INVALID_JSON" : status === 413 ? "REQUEST_TOO_LARGE" : "INTERNAL_ERROR";
  const message = visible && error instanceof Error ? (redact ? redactErrorText(error.message) : error.message) : status === 413 ? "请求内容过大，请缩小后重试" : status === 400 ? "请求参数或JSON格式无效" : "服务暂时无法处理请求，请联系管理员并提供请求ID";
  const retry = domainError && typeof error.details?.retryAfterSeconds === "number" ? error.details.retryAfterSeconds : undefined;
  return { status, retryAfterSeconds: retry && Number.isSafeInteger(retry) && retry >= 1 && retry <= 86400 ? retry : undefined,
    body: { error: message, code, ...(requestId ? { requestId } : {}), ...(visible && domainError && error.details ? { details: redact ? redactDetails(error.details) : error.details } : {}) } };
}
export function createErrorHandler(production: boolean, report?: (error: unknown, status: number, requestId?: string) => void): ErrorRequestHandler {
  return (error: unknown, _req, res, next) => {
    if (res.headersSent) { next(error); return; }
    const requestId = res.get("X-Request-ID");
    const result = errorResponse(error, production || Boolean(res.locals.publicUserOnly), requestId);
    report?.(error, result.status, requestId);
    if (result.retryAfterSeconds) res.set("Retry-After", String(result.retryAfterSeconds));
    res.status(result.status).json(result.body);
  };
}
