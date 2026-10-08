import { contentRevision } from "../domain/sceneContent.js";
import { asRecord, isMediaWorkflowType } from "../domain/workflowValues.js";
import type { RunRecord, RunStepRecord } from "../domain/types.js";
import type { RunInputQuery } from "../ai/accessSchemas.js";
import { resultPage } from "./runResultService.js";
import { HttpError } from "../errors.js";

/** Business values may contain legitimate keys such as workflow/parameters. Redact
 * locators, not arbitrary business keys; never project executor configuration. */
export function scrubBusinessValue(value: unknown): unknown {
  if (typeof value === "string") return /(?:[a-z]:[\\/]|(?:^|\s)\/(?:home|tmp|var|Users)\/)/i.test(value) ? "[内部路径已省略]" : value;
  if (Array.isArray(value)) return value.map(scrubBusinessValue);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, scrubBusinessValue(entry)]));
  return value;
}
const countStatuses = (items: Array<{status: string}>) => ({
  total: items.length,
  completed: items.filter(item => item.status === "completed").length,
  skipped: items.filter(item => item.status === "skipped").length,
  failed: items.filter(item => item.status === "failed").length,
  cancelled: items.filter(item => item.status === "cancelled").length,
  running: items.filter(item => item.status === "running").length,
  pending: items.filter(item => item.status === "pending").length,
});
export function businessRun(run: RunRecord, executionStartedAt?: string) {
  const definitions = run.workflow.steps;
  // Include future steps from the recorded snapshot, not just executed records.
  const ids = [...new Set([...definitions.map(step => step.id), ...run.steps.map(step => step.stepId)])];
  const steps = ids.map((stepId, order) => {
    const record: RunStepRecord | undefined = run.steps.find(step => step.stepId === stepId);
    const definition = definitions.find(step => step.id === stepId);
    const items = record?.items;
    return {
      stepId, order, name: String(scrubBusinessValue(record?.name ?? definition?.name ?? stepId)),
      status: record?.status ?? "pending" as const,
      ...(record?.startedAt ? { startedAt: record.startedAt } : {}),
      ...(record?.durationMs !== undefined ? { durationMs: record.durationMs } : {}),
      inputCount: definition?.inputs?.length ?? Object.keys(record?.inputs ?? {}).length,
      outputCount: Object.keys(record?.outputs ?? {}).length,
      expectedOutputCount: definition?.outputs?.length ?? 0,
      ...((record?.warnings?.length || items?.some(item => item.warnings?.length)) ? { warningCount: (record?.warnings?.length ?? 0) + (items ?? []).reduce((count, item) => count + (item.warnings?.length ?? 0), 0) } : {}),
      ...(items ? { itemProgress: countStatuses(items) } : {}),
      ...(record?.review ? { reviewStatus: record.review.status } : {}),
      reused: Boolean(record?.reusedFromRunId), replaced: Boolean(record?.replaced),
    };
  });
  const counts = countStatuses(steps);
  const pendingReview = run.pendingReview ? {
    id: run.pendingReview.id, stepId: run.pendingReview.stepId,
    name: String(scrubBusinessValue(run.pendingReview.name)), createdAt: run.pendingReview.createdAt,
    ...(run.pendingReview.instruction ? { instruction: String(scrubBusinessValue(run.pendingReview.instruction)) } : {}),
  } : undefined;
  const summary = {
    runId: run.runId, sceneId: run.sceneId,
    workflowName: String(scrubBusinessValue(run.workflowName)),
    ...(run.workflow.publishedScene ? {
      versionId: run.workflow.publishedScene.versionId, version: run.workflow.publishedScene.version,
      publishedAt: run.workflow.publishedScene.publishedAt,
    } : {}),
    ...(run.runTitle ? { runTitle: String(scrubBusinessValue(run.runTitle)) } : {}),
    status: run.status, createdAt: run.createdAt,
    // The queued record's startedAt is a placeholder. Only a persisted run.started
    // event proves execution began; imported historical runs can have no timing.
    ...(executionStartedAt ? { startedAt: executionStartedAt, queueDurationMs: Math.max(0, Date.parse(executionStartedAt) - Date.parse(run.createdAt)) } : {}),
    ...(run.finishedAt ? { finishedAt: run.finishedAt, totalDurationMs: Math.max(0, Date.parse(run.finishedAt) - Date.parse(run.createdAt)) } : {}),
    steps, progress: { ...counts, settled: counts.completed + counts.skipped + counts.failed + counts.cancelled },
    ...(pendingReview ? { pendingReview } : {}),
    ...(run.error ? { error: "任务未完成，请联系管理员查看详情" } : {}),
    inputCount: run.workflow.inputs.length, outputCount: run.outputs.length,
    expectedOutputCount: run.workflow.outputs.length,
    reviewCount: run.reviewHistory?.length ?? 0,
    projection: "business" as const,
    nextAction: run.status === "waiting" ? "review" : ["running", "queued", "cancelling"].includes(run.status) ? "wait" : ["failed", "stale", "cancelled"].includes(run.status) ? "inspect_before_resume" : "read_outputs",
  };
  return { ...summary, revision: contentRevision(summary) };
}
export type BusinessRun = ReturnType<typeof businessRun>;

function mediaInput(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(mediaInput);
  const reference = asRecord(value);
  // Never return a historical media locator, arbitrary URL, or hydrated path.
  if (!reference || typeof reference.assetId !== "string" || !Number.isSafeInteger(reference.assetVersion)) return value === null || value === "" || value === undefined ? value : { locatorOmitted: true };
  return { assetId: reference.assetId, assetVersion: reference.assetVersion, ...(typeof reference.assetName === "string" ? { assetName: scrubBusinessValue(reference.assetName) } : {}) };
}
export interface BusinessInputProjection {
  key: string; label: string; type: string; required: boolean; minimum?: number; maximum?: number; present: boolean; value?: unknown;
  valueOmitted?: boolean; omissionReason?: string; nextAction?: string; valueBytes: number;
  valuePage: { kind: string; total: number; offset: number; count: number; pageSize: number; complete: boolean; hasMore: boolean; nextValueOffset?: number };
}
/** Read the original run's input snapshot. No current scene lookups or generation. */
export function businessRunInputs(run: RunRecord, query: RunInputQuery) {
  const fields = run.workflow.inputs.filter(field => !query.inputKey || field.key === query.inputKey);
  if (query.inputKey && !fields.length) throw new HttpError(404, "输入字段不存在", "INPUT_NOT_AVAILABLE");
  const revision = contentRevision({ fields: run.workflow.inputs, values: run.inputValues });
  const scoped = { kind: "business_inputs", runId: run.runId, inputKey: query.inputKey ?? null,
    valueOffset: query.valueOffset, valueLimit: query.valueLimit, includeValues: query.includeValues, maxValueBytes: query.maxValueBytes };
  const page = resultPage(fields, revision, scoped, query);
  let remaining = query.maxValueBytes;
  const inputs = page.data.map<BusinessInputProjection>(field => {
    const present = Object.hasOwn(run.inputValues, field.key);
    const raw = run.inputValues[field.key];
    const value = isMediaWorkflowType(field.type) ? mediaInput(raw) : scrubBusinessValue(raw);
    const characters = typeof value === "string" ? Array.from(value) : undefined;
    const entries = asRecord(value) ? Object.entries(value as Record<string, unknown>) : undefined;
    const kind = characters ? "string" : Array.isArray(value) ? "array" : entries ? "object" : "scalar";
    const total = characters?.length ?? (Array.isArray(value) ? value.length : entries?.length ?? (present ? 1 : 0));
    const offset = kind === "scalar" ? 0 : Math.min(query.valueOffset, total);
    const end = kind === "scalar" ? total : Math.min(offset + query.valueLimit, total);
    const slice = characters ? characters.slice(offset, end).join("") : Array.isArray(value) ? value.slice(offset, end) : entries ? Object.fromEntries(entries.slice(offset, end)) : value;
    const valueBytes = Buffer.byteLength(JSON.stringify(slice) ?? "null");
    const omitted = !query.includeValues || valueBytes > remaining;
    if (!omitted) remaining -= valueBytes;
    return {
      key: field.key, label: String(scrubBusinessValue(asRecord(field)?.label ?? field.key)), type: field.type, required: Boolean(field.required), ...(field.type === "number" && field.minimum !== undefined ? { minimum: field.minimum } : {}), ...(field.type === "number" && field.maximum !== undefined ? { maximum: field.maximum } : {}), present,
      ...(omitted ? { valueOmitted: true, omissionReason: query.includeValues ? "value_byte_limit" : "metadata_only", nextAction: query.includeValues ? "narrow_value_page_or_increase_maxValueBytes" : "read_with_includeValues" } : present ? { value: slice } : {}),
      valueBytes, valuePage: { kind, total, offset, count: end - offset, pageSize: kind === "scalar" ? 1 : query.valueLimit, complete: !omitted && offset === 0 && end === total, hasMore: end < total, ...(end < total ? { nextValueOffset: end } : {}) },
    };
  });
  return { runId: run.runId, revision, projection: "business" as const, snapshot: "recorded_run" as const, inputs, total: page.total,
    hasMore: page.hasMore, ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}), nextAction: "inspect_inputs" };
}

export const BUSINESS_EVENT_TYPES = [
  "run.queued", "run.recovered_queued", "run.started", "run.completed", "run.failed", "run.cancelled", "run.cancelling", "run.stale", "run.waiting",
  "step.started", "step.completed", "step.failed", "step.skipped", "step.cancelled",
  "step.item.started", "step.item.completed", "step.item.failed", "step.item.skipped", "step.item.cancelled", "review.approve", "review.redo",
] as const;
