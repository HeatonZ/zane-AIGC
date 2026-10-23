import { HermesOutputParseError } from "./hermesOutput.js";
import { HermesTransientError } from "../hermesTransport.js";

/**
 * Classify a failed for_each item without matching message text.
 *
 * Only two error types carry a machine-readable transient mark:
 * - `HermesTransientError` — HTTP 408/429/5xx, a dropped socket or a request timeout.
 * - `HermesOutputParseError` with `transient: true` — the response carried the streamed
 *   residual / re-emission signature, i.e. the upstream cut the answer off mid-flight.
 *
 * Everything else (auth, parameters, schema/contract, business 4xx, direct-LLM and ComfyUI
 * failures, plain errors) is a deterministic failure: resubmitting would reproduce it, so it
 * is never retried. Cancellation is excluded explicitly even if a transport marks it.
 */
export function isTransientItemFailure(error: unknown) {
  if (error instanceof Error && error.name === "AbortError") return false;
  if (error instanceof HermesOutputParseError) return error.transient;
  if (error instanceof HermesTransientError) return true;
  return false;
}

/** Cancellation is never a retryable failure, whatever layer produced it. */
export function isCancellationFailure(error: unknown) {
  return error instanceof Error && error.name === "AbortError";
}
