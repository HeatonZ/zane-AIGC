import * as z from "zod/v4";
import { createRuntimeMediaValue, isRuntimeMediaValue, mediaKindFromWorkflowType } from "../runtimeValue.js";
import { canonicalWorkflowType, externalizeRuntimeValue, normalizeMediaList, isReadableMediaItem } from "./workflowValues.js";
import type { JsonValue } from "./types.js";

export const iterationCarrySchema = z.object({
  outputKey: z.string().regex(/^[a-zA-Z0-9_]+$/).describe("当前步骤已声明的单次输出键；下一项只继承紧邻上一成功项该输出，不继承聚合输出"),
  initialSourceRef: z.string().min(1).optional().describe("可选input或前序step引用，类型须匹配outputKey；省略时首项previous=null、hasPrevious=false；显式种子缺失/null/空媒体即失败")
}).strict();
export type IterationCarry = z.infer<typeof iterationCarrySchema>;
export const ITERATION_CARRY_CONTRACT = {
  version: "1", scope: "step.execution.carry", mode: "for_each",
  scheduling: { maxConcurrency: 1, onError: "stop", omittedFields: "default to serial/stop when carry enabled", incompatibleFields: "reject" },
  references: { "iteration.previous": "selected output of immediate predecessor; typed as declared output; initialSourceRef or null on first item", "iteration.hasPrevious": "boolean; true for explicit valid seed or successful predecessor", "iteration.index": "zero-based integer" },
  state: "non-null declared value; media must be non-empty readable flat list; false, 0 and empty text are valid",
  resume: "reuse only contiguous completed prefix with matching source values and valid carry output; first gap/change invalidates suffix",
  rerun: "item edits/feedback/rerun invalidate selected item and suffix; replacing an item preserves replacement and invalidates suffix; downstream dependencies rerun; one replacement per chain per request",
  results: "ordinary output aggregation unchanged; item inputs/outputs use existing checkpoints and paginated result APIs; no separate state store",
  errors: { configuration: "INVALID_AI_REQUEST for HTTP request schema errors; INVALID_WORKFLOW for semantic configuration errors", references: "INVALID_WORKFLOW_REFERENCE", execution: "failed item/step with error; no later item scheduled" },
  sideEffects: "draft configuration is not publication or execution; normal execution/resume/rerun may incur provider costs; lost receipt reconciles pre-saved ID"
} as const;
/** Hydrate persisted predecessor media as a typed value, never silently use an empty/sample source. */
export function carryValue(value: unknown, type: string, label: string): JsonValue {
  if (value === undefined || value === null) throw new Error(`${label}缺失或为空`);
  const kind = mediaKindFromWorkflowType(type);
  if (kind) {
    if (isRuntimeMediaValue(value) && value.mediaKind !== kind) throw new Error(`${label}与声明媒体类型不匹配`);
    const items = normalizeMediaList(externalizeRuntimeValue(value));
    if (!items.length || !items.every(isReadableMediaItem)) throw new Error(`${label}必须是非空有效媒体列表`);
    return createRuntimeMediaValue(kind, items);
  }
  const plain = externalizeRuntimeValue(value);
  const normalized = canonicalWorkflowType(type);
  if (normalized === "number" ? typeof plain !== "number" || !Number.isFinite(plain)
    : normalized === "boolean" ? typeof plain !== "boolean"
    : normalized === "json" ? false : typeof plain !== "string") throw new Error(`${label}与声明输出类型不匹配`);
  return structuredClone(plain) as JsonValue;
}
