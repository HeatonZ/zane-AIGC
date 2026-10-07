import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { JsonValue, RunRecord } from "./types.js";
import { asRecord, externalizeRuntimeValue } from "./workflowValues.js";
import { HttpError } from "../errors.js";
import { feedbackMessageMaxLength } from "./feedbackContracts.js";
import type { HermesFeedbackContext, StepFeedback, StepFeedbackRecord } from "./feedbackContracts.js";

export function validateStepFeedback(source: RunRecord, raw: unknown): StepFeedback {
  const feedback = asRecord(raw);
  if (!feedback || Object.keys(feedback).some(key => !["stepId", "itemIndex", "message"].includes(key))) throw new HttpError(400, "步骤反馈格式无效", "INVALID_FEEDBACK");
  const definition = source.workflow.steps.find(step => step.id === feedback.stepId);
  const record = source.steps.find(step => step.stepId === feedback.stepId);
  if (!definition || definition.kind !== "hermes") throw new HttpError(400, "只能对 Hermes 步骤提交反馈", "INVALID_FEEDBACK");
  if (typeof feedback.message !== "string" || !feedback.message.trim() || feedback.message.trim().length > feedbackMessageMaxLength) throw new HttpError(400, "请填写反馈意见，最多 " + feedbackMessageMaxLength + " 字", "INVALID_FEEDBACK");
  if (feedback.itemIndex !== undefined && (definition.execution?.mode !== "for_each" || !Number.isSafeInteger(feedback.itemIndex) || (feedback.itemIndex as number) < 0)) throw new HttpError(400, "反馈的逐项编号无效", "INVALID_FEEDBACK");
  const item = record?.items?.find(item => item.index === feedback.itemIndex);
  const target = feedback.itemIndex === undefined ? record : item;
  const hasOutputs = target?.status === "completed" && Object.keys(target.outputs ?? {}).length > 0;
  const hasCompletedItems = feedback.itemIndex === undefined && record?.items?.some(item => item.status === "completed" && Object.keys(item.outputs ?? {}).length > 0);
  if (!hasOutputs && !hasCompletedItems) throw new HttpError(400, "此步骤或逐项尚无可反馈的已完成结果", "INVALID_FEEDBACK");
  return { stepId: definition.id, ...(feedback.itemIndex === undefined ? {} : { itemIndex: feedback.itemIndex as number }), message: feedback.message.trim() };
}

export function captureStepFeedback(source: RunRecord, feedback: StepFeedback, createdAt: string): StepFeedbackRecord {
  const record = source.steps.find(step => step.stepId === feedback.stepId)!;
  const item = feedback.itemIndex === undefined ? undefined : record.items!.find(item => item.index === feedback.itemIndex)!;
  return structuredClone({
    ...feedback, id: randomUUID(), sourceRunId: source.runId, createdAt,
    originalOutputs: item?.outputs ?? record.outputs ?? {},
    ...(item ? { sourceValue: item.value } : {}),
    ...(!item && record.items ? { originalItems: record.items.filter(item => item.status === "completed").map(item => ({ index: item.index, value: item.value, outputs: item.outputs ?? {} })) } : {}),
  });
}

function comparableSource(value: unknown, aliases: Readonly<Record<string, string>>): unknown {
  const external = externalizeRuntimeValue(value);
  if (typeof external === "string") {
    let locator = external; const visited = new Set<string>();
    while (Object.hasOwn(aliases, locator) && !visited.has(locator)) { visited.add(locator); locator = aliases[locator]; }
    return locator;
  }
  if (Array.isArray(external)) return external.map(item => comparableSource(item, aliases));
  if (external && typeof external === "object") return Object.fromEntries(Object.entries(external).map(([key, item]) => [key, comparableSource(item, aliases)]));
  return external;
}

/** Keep accumulated corrections scoped to their step/item, never another item's rejected result. */
export function feedbackForStep(history: readonly StepFeedbackRecord[], stepId: string, itemIndex?: number, itemValue?: JsonValue, aliases: Readonly<Record<string, string>> = {}): HermesFeedbackContext | undefined {
  const value = comparableSource(itemValue, aliases);
  const relevant = history.filter(feedback => feedback.stepId === stepId && (feedback.itemIndex === undefined || (feedback.itemIndex === itemIndex && isDeepStrictEqual(comparableSource(feedback.sourceValue, aliases), value))));
  if (!relevant.length) return undefined;
  const latest = relevant.at(-1)!;
  const originalOutputs = itemIndex === undefined ? latest.originalOutputs : latest.itemIndex === undefined
    ? latest.originalItems?.find(item => item.index === itemIndex && isDeepStrictEqual(comparableSource(item.value, aliases), value))?.outputs
    : latest.originalOutputs;
  return { notes: relevant.map(({ message, sourceRunId, createdAt }) => ({ message, sourceRunId, createdAt })), ...(originalOutputs ? { originalOutputs: structuredClone(originalOutputs) } : {}) };
}
