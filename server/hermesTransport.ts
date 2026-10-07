import { delayWithAbort } from "./execution/cancellation.js";
import { hermesRetryAttempts, hermesRetryInitialDelayMs, hermesRetryMaxDelayMs } from "./config.js";

const retryableSocketCodes = new Set([
  "ECONNABORTED",
  "ECONNREFUSED",
  "ECONNRESET",
  "EPIPE",
  "ETIMEDOUT",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_SOCKET",
]);
const transientHermesStatuses = new Set([502, 503, 504]);

export interface HermesRetryOptions {
  /** HTTP retries are enabled for safe probes; leave empty for non-idempotent chat completions. */
  retryHttpStatuses?: readonly number[];
  /** Disable transport retries for a caller that cannot tolerate an ambiguous replay. */
  retryNetworkErrors?: boolean;
  /** Retry a TypeError without a platform-specific `cause.code` when the request is idempotent. */
  retryUnknownNetworkErrors?: boolean;
  /** Number of retries after the initial request. Defaults to HERMES_RETRY_ATTEMPTS. */
  retryAttempts?: number;
  /** Initial exponential-backoff delay. Defaults to HERMES_RETRY_INITIAL_DELAY_MS. */
  retryInitialDelayMs?: number;
  /** Upper bound for one exponential-backoff delay. Defaults to HERMES_RETRY_MAX_DELAY_MS. */
  retryMaxDelayMs?: number;
}

function requestSignal(init: RequestInit) {
  return init.signal ?? undefined;
}

function isAbortError(error: unknown) {
  return error instanceof Error && error.name === "AbortError";
}

/**
 * Node's fetch reports a dropped keep-alive socket as a TypeError. Hermes can
 * briefly close the API listener while the gateway supervisor reloads it, so
 * retry only that transport-level failure instead of turning a short reload
 * into a failed workflow.
 */
export function isRetryableHermesNetworkError(error: unknown) {
  if (!(error instanceof TypeError) || isAbortError(error)) return false;
  let cause = (error as TypeError & { cause?: unknown }).cause;
  while (cause && typeof cause === "object") {
    const details = cause as { code?: unknown; cause?: unknown };
    if (typeof details.code === "string" && retryableSocketCodes.has(details.code)) return true;
    cause = details.cause;
  }
  return false;
}

export function describeHermesError(error: unknown) {
  const name = error instanceof Error ? error.name : typeof error;
  const message = error instanceof Error ? error.message : String(error);
  let cause: unknown = error instanceof Error ? (error as Error & { cause?: unknown }).cause : undefined;
  let code: string | undefined;
  let causeMessage: string | undefined;
  const seen = new Set<unknown>();
  while (cause && typeof cause === "object" && !seen.has(cause)) {
    seen.add(cause);
    const details = cause as { code?: unknown; message?: unknown; cause?: unknown };
    if (!code && typeof details.code === "string") code = details.code;
    if (!causeMessage && typeof details.message === "string") causeMessage = details.message;
    cause = details.cause;
  }
  return { name, message, code, causeMessage };
}

export function isRetryableHermesResponse(response: Response) {
  return transientHermesStatuses.has(response.status);
}

function retryDelayMs(attempt: number, options: HermesRetryOptions) {
  const initial = Math.max(0, options.retryInitialDelayMs ?? hermesRetryInitialDelayMs);
  const maximum = Math.max(initial, options.retryMaxDelayMs ?? hermesRetryMaxDelayMs);
  return Math.min(maximum, initial * (2 ** attempt));
}

/**
 * Reuse the caller's timeout/cancellation signal, but make transient gateway
 * restarts invisible to callers. Response bodies are drained before a retry
 * so undici does not retain a half-open connection in its pool.
 */
export async function fetchHermesWithRetry(input: RequestInfo | URL, init: RequestInit = {}, options: HermesRetryOptions = {}) {
  const signal = requestSignal(init);
  const retryStatuses = options.retryHttpStatuses === undefined
    ? transientHermesStatuses
    : new Set(options.retryHttpStatuses);
  const configuredAttempts = options.retryAttempts ?? hermesRetryAttempts;
  const retryAttempts = Number.isFinite(configuredAttempts)
    ? Math.max(0, Math.min(20, Math.floor(configuredAttempts)))
    : hermesRetryAttempts;
  let lastError: unknown;

  for (let attempt = 0; attempt <= retryAttempts; attempt += 1) {
    const lastAttempt = attempt === retryAttempts;
    try {
      const response = await fetch(input, init);
      if (!retryStatuses.has(response.status) || lastAttempt) return response;
      await response.arrayBuffer().catch(() => undefined);
      await delayWithAbort(retryDelayMs(attempt, options), signal);
    } catch (error) {
      const retryable = isRetryableHermesNetworkError(error)
        || (options.retryUnknownNetworkErrors === true && error instanceof TypeError && !isAbortError(error));
      if (options.retryNetworkErrors === false || !retryable || lastAttempt) throw error;
      lastError = error;
      await delayWithAbort(retryDelayMs(attempt, options), signal);
    }
  }

  throw lastError ?? new Error("Hermes API 请求失败");
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function responseMessage(body: unknown, fallback: string) {
  const root = asRecord(body);
  const error = asRecord(root?.error);
  const candidates = [
    typeof root?.message === "string" ? root.message : undefined,
    typeof root?.error === "string" ? root.error : undefined,
    typeof error?.message === "string" ? error.message : undefined,
    typeof error?.detail === "string" ? error.detail : undefined,
  ].filter((item): item is string => Boolean(item && item.trim()));
  return candidates[0] ?? fallback;
}

export class HermesHttpError extends Error {
  readonly status: number;
  readonly body: unknown;

  constructor(status: number, message: string, body: unknown = undefined) {
    super(message);
    this.name = "HermesHttpError";
    this.status = status;
    this.body = body;
  }
}

export class HermesRunEndpointUnavailableError extends HermesHttpError {
  constructor(status: number, message: string, body: unknown = undefined) {
    super(status, message, body);
    this.name = "HermesRunEndpointUnavailableError";
  }
}

export interface HermesRunRequestOptions {
  startUrl: string;
  statusUrl: (runId: string) => string;
  stopUrl?: (runId: string) => string;
  headers: HeadersInit;
  body: unknown;
  idempotencyKey: string;
  timeoutMs: number;
  signal?: AbortSignal;
  pollIntervalMs?: number;
}

const runTerminalStatuses = new Set(["completed", "failed", "cancelled", "interrupted"]);

async function stopHermesRun(options: HermesRunRequestOptions, runId: string) {
  if (!options.stopUrl) return;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 2_000);
  try {
    const response = await fetchHermesWithRetry(options.stopUrl(runId), {
      method: "POST",
      headers: options.headers,
      signal: controller.signal,
    }, { retryHttpStatuses: [], retryUnknownNetworkErrors: true });
    await response.arrayBuffer().catch(() => undefined);
  } catch {
    // Stopping is best effort. Never hide the timeout/cancellation or the original
    // Hermes error just because the gateway is already unavailable.
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Use Hermes' durable run API for long agent turns. Admission returns quickly and
 * the following GETs are short, idempotent requests instead of holding one HTTP
 * connection open for the entire agent/tool execution.
 */
export async function requestHermesRun(options: HermesRunRequestOptions) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Math.max(1, options.timeoutMs));
  const abortFromParent = () => controller.abort();
  if (options.signal) {
    if (options.signal.aborted) controller.abort();
    else options.signal.addEventListener("abort", abortFromParent, { once: true });
  }

  let runId: string | undefined;
  let settled = false;
  const requestHeaders = new Headers(options.headers);
  requestHeaders.set("Idempotency-Key", options.idempotencyKey);
  try {
    const admitted = await fetchHermesWithRetry(options.startUrl, {
      method: "POST",
      headers: requestHeaders,
      body: JSON.stringify(options.body),
      signal: controller.signal,
    }, {
      // The idempotency key makes replay after an ambiguous response safe.
      retryHttpStatuses: [502, 503, 504],
      retryUnknownNetworkErrors: true,
    });
    const admittedBody = await admitted.json().catch(() => null) as unknown;
    if (!admitted.ok) {
      const message = responseMessage(admittedBody, `HTTP ${admitted.status}`);
      if (admitted.status === 404 || admitted.status === 405) {
        throw new HermesRunEndpointUnavailableError(admitted.status, `Hermes Runs API 不可用：${message}`, admittedBody);
      }
      throw new HermesHttpError(admitted.status, `Hermes API 请求失败：${message}`, admittedBody);
    }
    const admittedRecord = asRecord(admittedBody);
    runId = typeof admittedRecord?.run_id === "string" ? admittedRecord.run_id : undefined;
    if (!runId) throw new Error("Hermes Runs API 未返回 run_id");

    for (;;) {
      const statusResponse = await fetchHermesWithRetry(options.statusUrl(runId), {
        headers: options.headers,
        signal: controller.signal,
      }, { retryUnknownNetworkErrors: true });
      const statusBody = await statusResponse.json().catch(() => null) as unknown;
      if (!statusResponse.ok) {
        const message = responseMessage(statusBody, `HTTP ${statusResponse.status}`);
        throw new HermesHttpError(statusResponse.status, `Hermes Runs 状态查询失败：${message}`, statusBody);
      }

      const statusRecord = asRecord(statusBody) ?? {};
      const status = typeof statusRecord?.status === "string" ? statusRecord.status : "";
      if (status === "completed") {
        settled = true;
        const output = typeof statusRecord.output === "string"
          ? statusRecord.output
          : typeof statusRecord.final_response === "string"
            ? statusRecord.final_response
            : undefined;
        if (output === undefined) throw new Error("Hermes Runs API 完成时没有返回文本输出");
        return output;
      }
      if (runTerminalStatuses.has(status)) {
        settled = true;
        const message = responseMessage(statusBody, `状态为 ${status || "未知"}`);
        throw new Error(`Hermes 运行${status === "failed" ? "失败" : "已结束"}：${message}`);
      }
      if (!status) throw new Error("Hermes Runs API 返回了无效状态");
      await delayWithAbort(options.pollIntervalMs ?? 1_000, controller.signal);
    }
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener("abort", abortFromParent);
    if (runId && !settled) await stopHermesRun(options, runId);
  }
}



