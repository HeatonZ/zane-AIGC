import { HttpError } from "../errors.js";
import type { JsonValue, RunStep } from "./types.js";
import { resolveWorkflowReference } from "./workflowValues.js";

/** Schema cap for one step's for_each concurrency, also the value used for "no configured limit". */
export const MAX_ITERATION_CONCURRENCY = 32;

export interface ResolvedIterationConcurrency {
  /** Effective worker count for this step, always 1..MAX_ITERATION_CONCURRENCY. */
  value: number;
  /** True when the referenced input was left empty: no configured limit, global budgets still apply. */
  unlimited: boolean;
  source: "default" | "carry" | "literal" | "reference";
}

const invalid = (step: RunStep, reference: string, resolved: unknown): never => {
  throw new HttpError(
    400,
    `${step.name} 的并发引用 ${reference} 必须是 1–${MAX_ITERATION_CONCURRENCY} 的整数，留空表示不限制；当前为 ${JSON.stringify(resolved)}`,
    "INVALID_ITERATION_CONCURRENCY",
    { stepId: step.id, inputKey: reference.replace(/^input\./, ""), nextAction: "correct_input_values" },
  );
};

/**
 * Effective for_each concurrency for a step.
 * - `execution.maxConcurrencyRef` resolves a declared numeric input; empty means "unlimited"
 *   (capped at MAX_ITERATION_CONCURRENCY, then throttled by the global ComfyUI budget and the
 *   task-level active-run limit). 0, negative, fractional and out-of-range values are rejected.
 * - `carry` is always serial, and a plain `maxConcurrency` stays a bounded literal.
 * Static values must already have passed validateWorkflowShape.
 */
export function resolveIterationConcurrency(step: RunStep, inputValues: Record<string, JsonValue>): ResolvedIterationConcurrency {
  const execution = step.execution;
  if (!execution || execution.mode !== "for_each") return { value: 1, unlimited: false, source: "default" };
  if (execution.carry) return { value: 1, unlimited: false, source: "carry" };
  if (execution.maxConcurrencyRef !== undefined) {
    const reference = execution.maxConcurrencyRef.trim();
    if (!reference) throw new HttpError(400, `${step.name} 的并发引用不能为空`, "INVALID_ITERATION_CONCURRENCY", { stepId: step.id });
    let resolved: JsonValue | undefined;
    try {
      resolved = resolveWorkflowReference(reference, inputValues, new Map()) as JsonValue;
    } catch {
      throw new HttpError(400, `${step.name} 的并发引用无法解析：${reference}`, "INVALID_ITERATION_CONCURRENCY", { stepId: step.id, reference });
    }
    if (resolved === undefined || resolved === null || resolved === "") return { value: MAX_ITERATION_CONCURRENCY, unlimited: true, source: "reference" };
    if (typeof resolved !== "number" || !Number.isSafeInteger(resolved) || resolved < 1 || resolved > MAX_ITERATION_CONCURRENCY) invalid(step, reference, resolved);
    return { value: resolved as number, unlimited: false, source: "reference" };
  }
  const configured = execution.maxConcurrency;
  if (typeof configured === "number" && Number.isSafeInteger(configured)) {
    return { value: Math.min(MAX_ITERATION_CONCURRENCY, Math.max(1, configured)), unlimited: false, source: "literal" };
  }
  return { value: 1, unlimited: false, source: "default" };
}
