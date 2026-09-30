import { delayWithAbort } from "./execution/cancellation.js";

const retryDelaysMs = [150, 400] as const;
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

export function isRetryableHermesResponse(response: Response) {
  return transientHermesStatuses.has(response.status);
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
  let lastError: unknown;

  for (let attempt = 0; attempt <= retryDelaysMs.length; attempt += 1) {
    try {
      const response = await fetch(input, init);
      if (!retryStatuses.has(response.status) || attempt === retryDelaysMs.length) return response;
      await response.arrayBuffer().catch(() => undefined);
      await delayWithAbort(retryDelaysMs[attempt], signal);
    } catch (error) {
      if (options.retryNetworkErrors === false || !isRetryableHermesNetworkError(error) || attempt === retryDelaysMs.length) throw error;
      lastError = error;
      await delayWithAbort(retryDelaysMs[attempt], signal);
    }
  }

  throw lastError ?? new Error("Hermes API 请求失败");
}



