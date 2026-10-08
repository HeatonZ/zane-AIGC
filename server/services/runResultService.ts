import { contentRevision } from "../domain/sceneContent.js";
import { isMediaWorkflowType } from "../domain/workflowValues.js";
import { runtimeMediaExternalValue } from "../runtimeValue.js";
import type { RunRecord, RunStepRecord } from "../domain/types.js";
import type { ResultQuery } from "../ai/sceneSchemas.js";
import { HttpError } from "../errors.js";

type Source = { runId: string; stepId?: string; itemIndex?: number; outputKey: string };
type ValueBudget = { remaining: number };
export interface OutputProjection {
  key: string; label: string; type: string; source: Source; value?: unknown;
  valueOmitted?: boolean; omissionReason?: string; valueBytes: number; nextAction?: string;
  valuePage: { kind: string; total: number; offset: number; count: number; pageSize: number; complete: boolean; hasMore: boolean; nextValueOffset?: number };
  mediaReferences?: Array<{ source: Source & { mediaIndex: number }; url: string }>;
}
function output(key: string, value: unknown, type: string, label: string, source: Source, query: ResultQuery, budget: ValueBudget): OutputProjection {
  const external = runtimeMediaExternalValue(value);
  const array = Array.isArray(external);
  const characters = typeof external === "string" && query.textLimit !== undefined && !isMediaWorkflowType(type) ? Array.from(external) : undefined;
  const offset = characters ? Math.min(query.textOffset, characters.length) : array ? Math.min(query.valueOffset, external.length) : 0;
  const slice = characters ? characters.slice(offset, offset + query.textLimit!).join("") : array ? external.slice(offset, offset + query.valueLimit) : external;
  const json = JSON.stringify(slice) ?? "null";
  const valueBytes = Buffer.byteLength(json);
  const omitted = !query.includeValues || valueBytes > budget.remaining;
  if (!omitted) budget.remaining -= valueBytes;
  const total = characters?.length ?? (array ? external.length : 1);
  const end = characters ? Math.min(offset + query.textLimit!, total) : array ? Math.min(offset + query.valueLimit, total) : 1;
  const count = end - offset;
  const mediaReferences = isMediaWorkflowType(type) && query.includeValues ? (array ? slice as unknown[] : external === undefined || external === null || external === "" ? [] : [external]).map((_value, index) => {
    const mediaIndex = (array ? query.valueOffset : 0) + index;
    const parameters = new URLSearchParams({ outputKey: key, mediaIndex: String(mediaIndex), ...(source.stepId ? { stepId: source.stepId } : {}), ...(source.itemIndex !== undefined ? { itemIndex: String(source.itemIndex) } : {}) });
    return { source: { ...source, mediaIndex }, url: "/api/v1/runs/" + source.runId + "/output-media?" + parameters };
  }) : [];
  return { key, label, type, source, ...(omitted ? { valueOmitted: true, omissionReason: query.includeValues ? "value_byte_limit" : "metadata_only", valueBytes, nextAction: query.includeValues ? "narrow_value_page_or_increase_maxValueBytes" : "read_with_includeValues" } : { value: slice, valueBytes }), valuePage: { kind: characters ? "string" : array ? "array" : "scalar", total, offset, count, pageSize: characters ? query.textLimit! : array ? query.valueLimit : 1, complete: !omitted && offset === 0 && end === total, hasMore: end < total, ...(end < total ? { nextValueOffset: end } : {}) }, ...(mediaReferences.length ? { mediaReferences } : {}) };
}
export function resultPage<T>(items: T[], revision: string, scope: unknown, query: Pick<ResultQuery, "cursor" | "limit">) {
  const scopeHash = contentRevision(scope);
  let offset = 0;
  if (query.cursor) {
    try {
      const token = JSON.parse(Buffer.from(query.cursor, "base64url").toString("utf8"));
      if (token.scope !== scopeHash || !Number.isSafeInteger(token.offset) || token.offset < 0) throw new Error();
      if (token.revision !== revision) throw new HttpError(409, "运行结果在分页期间变化，请读取最新第一页", "RESULT_PAGE_CHANGED", { currentRevision: revision, nextAction: "read_first_page" });
      offset = token.offset;
    } catch (error) { if (error instanceof HttpError) throw error; throw new HttpError(400, "结果分页游标无效或不属于当前查询", "INVALID_CURSOR"); }
  }
  const data = items.slice(offset, offset + query.limit); const hasMore = offset + data.length < items.length;
  return { data, total: items.length, hasMore, ...(hasMore ? { nextCursor: Buffer.from(JSON.stringify({ scope: scopeHash, revision, offset: offset + data.length })).toString("base64url") } : {}) };
}
const scope = (run: RunRecord, query: ResultQuery, stepId?: string) => ({ runId: run.runId, stepId: stepId ?? null, outputKey: query.outputKey ?? null, itemIndex: query.itemIndex ?? null, textOffset: query.textOffset, textLimit: query.textLimit ?? null, valueOffset: query.valueOffset, valueLimit: query.valueLimit, includeValues: query.includeValues, maxValueBytes: query.maxValueBytes });
function stepOutputs(run: RunRecord, step: RunStepRecord, values: Record<string, unknown> | undefined, query: ResultQuery, budget: ValueBudget, itemIndex?: number) {
  const declared = run.workflow.steps.find(item => item.id === step.stepId)?.outputs ?? [];
  const keys = Object.keys(values ?? {}).filter(key => !query.outputKey || key === query.outputKey);
  return keys.map(key => output(key, values![key], step.outputTypes?.[key] ?? declared.find(field => field.key === key)?.type ?? "json", step.outputLabels?.[key] ?? declared.find(field => field.key === key)?.label ?? key, { runId: run.runId, stepId: step.stepId, ...(itemIndex !== undefined ? { itemIndex } : {}), outputKey: key }, query, budget));
}
function agentResponsePage(response: string, query: ResultQuery, budget: ValueBudget) {
  const characters = Array.from(response);
  const offset = query.textLimit === undefined ? 0 : Math.min(query.textOffset, characters.length);
  const end = query.textLimit === undefined ? characters.length : Math.min(offset + query.textLimit, characters.length);
  const value = characters.slice(offset, end).join("");
  const valueBytes = Buffer.byteLength(JSON.stringify(value) ?? "null");
  const omitted = !query.includeValues || valueBytes > budget.remaining;
  if (!omitted) budget.remaining -= valueBytes;
  return {
    ...(omitted ? { valueOmitted: true, omissionReason: query.includeValues ? "value_byte_limit" : "metadata_only", nextAction: query.includeValues ? "narrow_value_page_or_increase_maxValueBytes" : "read_with_includeValues" } : { value }),
    valueBytes,
    valuePage: { kind: query.textLimit === undefined ? "scalar" : "string", total: characters.length, offset, count: end - offset, pageSize: query.textLimit ?? characters.length, complete: !omitted && offset === 0 && end === characters.length, hasMore: end < characters.length, ...(end < characters.length ? { nextValueOffset: end } : {}) },
  };
}
export function runOutputs(run: RunRecord, query: ResultQuery) {
  const selected = run.outputs.filter(item => !query.outputKey || item.key === query.outputKey);
  if (query.outputKey && !selected.length) throw new HttpError(404, "没有找到此最终输出；未完成运行可能尚未产出", "OUTPUT_NOT_AVAILABLE", { runId: run.runId, outputKey: query.outputKey, status: run.status });
  const revision = contentRevision({ status: run.status, outputs: run.outputs });
  const selectedPage = resultPage(selected, revision, scope(run, query), query);
  const budget = { remaining: query.maxValueBytes };
  return { runId: run.runId, status: run.status, revision, outputs: selectedPage.data.map(item => output(item.key, item.value, item.type, item.label, { runId: run.runId, outputKey: item.key }, query, budget)), total: selectedPage.total, hasMore: selectedPage.hasMore, ...(selectedPage.nextCursor ? { nextCursor: selectedPage.nextCursor } : {}), nextAction: "inspect_outputs" };
}
export function stepResult(run: RunRecord, stepId: string, query: ResultQuery) {
  const step = run.steps.find(step => step.stepId === stepId);
  if (!step) throw new HttpError(404, "步骤尚未执行或不存在", "STEP_RESULT_NOT_AVAILABLE", { runId: run.runId, stepId, status: run.status });
  const items = step.items ?? [];
  const selected = query.itemIndex !== undefined ? items.filter(item => item.index === query.itemIndex) : items;
  if (query.itemIndex !== undefined && !selected.length) throw new HttpError(404, "没有找到此逐项结果", "ITEM_RESULT_NOT_AVAILABLE", { runId: run.runId, stepId, itemIndex: query.itemIndex });
  const availableKeys = new Set([...Object.keys(step.outputs ?? {}), ...selected.flatMap(item => Object.keys(item.outputs ?? {}))]);
  if (query.outputKey && !availableKeys.has(query.outputKey)) throw new HttpError(404, "没有找到此步骤输出", "OUTPUT_NOT_AVAILABLE", { runId: run.runId, stepId, outputKey: query.outputKey });
  const revision = contentRevision({ status: step.status, message: step.message, warnings: step.warnings, outputs: step.outputs, agentResponse: step.agentResponse, items: items.map(item => ({ index: item.index, status: item.status, warnings: item.warnings, outputs: item.outputs, error: item.error, agentResponse: item.agentResponse })) });
  const selectedPage = resultPage(selected, revision, scope(run, query, stepId), query);
  const budget = { remaining: query.maxValueBytes };
  return { runId: run.runId, runStatus: run.status, stepId, name: step.name, status: step.status, ...(step.startedAt ? { startedAt: step.startedAt } : {}), ...(step.durationMs !== undefined ? { durationMs: step.durationMs } : {}), ...(step.message ? { message: step.message } : {}), ...(step.warnings?.length ? { warnings: step.warnings } : {}), revision, ...(step.agentResponse !== undefined && query.itemIndex === undefined ? { agentResponse: agentResponsePage(step.agentResponse, query, budget) } : {}), ...(query.itemIndex === undefined ? { outputs: stepOutputs(run, step, step.outputs, query, budget) } : {}), items: selectedPage.data.map(item => ({ index: item.index, status: item.status, ...(item.startedAt ? { startedAt: item.startedAt } : {}), ...(item.durationMs !== undefined ? { durationMs: item.durationMs } : {}), ...(item.warnings?.length ? { warnings: item.warnings } : {}), ...(item.error ? { error: item.error } : {}), ...(item.agentResponse !== undefined ? { agentResponse: agentResponsePage(item.agentResponse, query, budget) } : {}), ...(item.reusedFromRunId ? { reusedFromRunId: item.reusedFromRunId } : {}), outputs: stepOutputs(run, step, item.outputs, query, budget, item.index) })), itemCount: items.length, total: selectedPage.total, hasMore: selectedPage.hasMore, ...(selectedPage.nextCursor ? { nextCursor: selectedPage.nextCursor } : {}), nextAction: step.agentResponse !== undefined || items.some(item => item.agentResponse !== undefined) ? "inspect_hermes_response" : "inspect_step_outputs" };
}
