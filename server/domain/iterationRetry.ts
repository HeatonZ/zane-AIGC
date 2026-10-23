/**
 * Per-item retry for `for_each` steps (execution.itemRetries).
 *
 * Scope: only transient upstream failures are retried, only inside one item, and only when
 * the step explicitly opts in. Omitting both fields keeps the historical behavior byte for
 * byte (0 retries), so published snapshots and历史 runs are untouched.
 *
 * Cost: every retry re-invokes the model and may be billed again; that is why the default is 0.
 */
export const MAX_ITEM_RETRIES = 3;
export const DEFAULT_ITEM_RETRY_DELAY_SECONDS = 5;
export const MAX_ITEM_RETRY_DELAY_SECONDS = 60;

export interface IterationRetryConfig {
  itemRetries?: number;
  itemRetryDelaySeconds?: number;
}

export interface ItemRetryPolicy {
  /** Retries after the first attempt; 0 means "fail as before". */
  attempts: number;
  /** Base delay for the first retry; doubles per attempt, capped at MAX_ITEM_RETRY_DELAY_SECONDS. */
  delayMs: number;
}

/** Effective policy for one step. Values must already have passed validateWorkflowShape. */
export function iterationRetryPolicy(execution?: IterationRetryConfig): ItemRetryPolicy {
  const configured = typeof execution?.itemRetries === "number" && Number.isSafeInteger(execution.itemRetries)
    ? Math.min(MAX_ITEM_RETRIES, Math.max(0, execution.itemRetries))
    : 0;
  const seconds = typeof execution?.itemRetryDelaySeconds === "number" && Number.isFinite(execution.itemRetryDelaySeconds)
    ? Math.min(MAX_ITEM_RETRY_DELAY_SECONDS, Math.max(0, execution.itemRetryDelaySeconds))
    : DEFAULT_ITEM_RETRY_DELAY_SECONDS;
  return { attempts: configured, delayMs: seconds * 1000 };
}

/** Exponential backoff for retry number `attempt` (1-based), capped at MAX_ITEM_RETRY_DELAY_SECONDS. */
export function itemRetryDelayMs(attempt: number, baseMs: number) {
  const cap = MAX_ITEM_RETRY_DELAY_SECONDS * 1000;
  const step = Math.max(1, Math.floor(attempt));
  return Math.min(cap, Math.max(0, baseMs) * (2 ** (step - 1)));
}

export const ITERATION_RETRY_CONTRACT = {
  version: "1",
  scope: "step.execution.itemRetries",
  mode: "for_each",
  default: "0 retries; omitting both fields keeps the historical single-attempt behavior",
  bounds: { itemRetries: "0..3", itemRetryDelaySeconds: "0..60; default 5, exponential backoff capped at 60" },
  retryable: [
    "hermes_http_408_429_5xx",
    "hermes_network_socket_failure",
    "hermes_request_timeout",
    "hermes_output_parse_failure_caused_by_an_upstream_cut_off",
  ],
  notRetryable: [
    "authentication_401_403",
    "invalid_parameters_or_schema_or_contract",
    "business_4xx",
    "cancellation",
    "direct_llm_and_comfyui_failures_are_not_classified_as_transient",
  ],
  accounting: "each retry appends one item warning with the attempt number, the reason and the wait; the wait is abortable",
  exhausted: "the last failure takes the unchanged onError/carry failure path",
  cost: "a retry re-invokes the model and may be billed again; the default is 0 for that reason",
  references: "retries happen inside one item; item order, reviewAfterItems barrier and carry prefix reuse are unchanged",
} as const;
