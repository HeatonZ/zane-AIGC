import { readFeedbackSourceAliases } from "../artifacts/feedbackSources.js";
import { archiveRerunMedia } from "../artifacts/rerunMedia.js";
import { validateWorkflowInputs } from "../domain/inputValidation.js";
import { planRerun, type PlannedRerun } from "./rerunPlanner.js";
import type { CapabilityDefinition } from "../capabilities/contracts.js";
import { validateWorkflowShape, validateCarryReferences, validateStartConditionReferences } from "../domain/workflowValidation.js";
import { stat } from "node:fs/promises";
import path from "node:path";
import { captureStepFeedback } from "../domain/stepFeedback.js";
import { HttpError } from "../errors.js";
import { log } from "../observability/logger.js";
import { asRecord, normalizeRunWorkflow, normalizeWorkflowMediaInputs } from "../domain/workflowValues.js";
import type { JsonValue, RunRecord, RunWorkflowDefinition, SavedSettings } from "../domain/types.js";
import type { PreparedRun } from "../execution/workflowExecutor.js";
import { isActiveRunStatus } from "../domain/types.js";
import { discardRunArtifacts, prepareRunArtifacts, runArtifactPaths } from "../artifacts/runArtifacts.js";
import { readJsonFile } from "../storage/jsonFileStore.js";

export interface PreparationDependencies {
  getRun(projectDirectory: string, runId: string): Promise<RunRecord | undefined>;
  supportsStep(kind: string): boolean;
  capabilities?: CapabilityDefinition[];
  resolveAssets?(project: string, workflow: RunWorkflowDefinition, values: Record<string, JsonValue>): Promise<Record<string, JsonValue>>;
  prepareStep?(step: import("../domain/types.js").RunStep): import("../domain/types.js").RunStep;
}
/** Point a media input back at the ancestor run's archived copy. Keep the fixed asset
 * reference recorded beside the path: a bare locator loses which asset and version the task
 * actually used, and the user-facing input snapshot never shows internal media paths.
 * Legacy records stored plain strings (sometimes several) instead of attachments, so those
 * positions accept the archived locator as-is; the caller passes an index only for a
 * multi-file archive, where every entry must be restorable rather than skipped. */
function restoredArchivedInput(value: JsonValue | undefined, filename: string, index?: number): JsonValue | undefined {
  if (value === undefined || value === null) return value;
  const items = Array.isArray(value) ? [...value] : [value];
  const position = index ?? 0;
  if (position >= items.length) return index === undefined ? filename : value;
  const current = items[position];
  if (typeof current !== "object" || current === null || Array.isArray(current)) {
    // A plain locator still names this position; replace it with the archived copy so a
    // deleted or rewritten original cannot make the new run unreadable.
    if (index === undefined) return filename;
    items[position] = filename;
    return items;
  }
  items[position] = { ...(current as Record<string, JsonValue>), path: filename };
  return index === undefined ? items[0] : items;
}
export async function prepareRun(body: unknown, runId: string, settings: SavedSettings, dependencies: PreparationDependencies): Promise<PreparedRun> {
  const input = asRecord(body);
  const value = asRecord(input?.workflow);
  const rawInputs = asRecord(input?.inputValues);
  if (!value || !Array.isArray(value.inputs) || !Array.isArray(value.steps) || !Array.isArray(value.outputs) || !rawInputs) {
    throw new HttpError(400, "工作流定义或场景输入格式无效", "INVALID_WORKFLOW");
  }
  if (value.steps.length > 100 || value.inputs.length > 200) throw new HttpError(400, "工作流规模超出限制");
  if (!settings.projectDirectory) throw new HttpError(400, "请先在集成连接中配置项目目录");
  let resumedFromRunId: string | undefined;
  let rerunFromRunId: string | undefined;
  let rerun: PlannedRerun | undefined;
  if (input?.rerunFromRunId !== undefined) {
    if (typeof input.rerunFromRunId !== "string" || input.rerunFromRunId === runId || input.resumeFromRunId !== undefined) throw new HttpError(400, "局部重做来源无效，不能同时提交断点续跑");
    rerunFromRunId = input.rerunFromRunId;
  }
  if (input?.resumeFromRunId !== undefined) {
    if (typeof input.resumeFromRunId !== "string") throw new HttpError(400, "断点来源运行记录编号无效");
    resumedFromRunId = input.resumeFromRunId;
    if (resumedFromRunId === runId) throw new HttpError(400, "断点来源不能是新的运行记录本身");
  }
  if (input?.runTitle !== undefined && (typeof input.runTitle !== "string" || input.runTitle.length > 120)) throw new HttpError(400, "运行标题无效，最多可填写 120 个字符");
  let runTitle = typeof input?.runTitle === "string" ? input.runTitle.trim() : "";
  let resumeSource: RunRecord | undefined;
  let workflowValue = value;
  let inputValues = structuredClone(rawInputs) as Record<string, JsonValue>;
  if (resumedFromRunId || rerunFromRunId) {
    const sourceId = resumedFromRunId ?? rerunFromRunId!;
    resumeSource = await dependencies.getRun(settings.projectDirectory, sourceId);
    if (!resumeSource) throw new HttpError(404, "没有找到断点来源运行记录");
    if (resumeSource.status === "waiting") throw new HttpError(409, "请先处理此运行的人工确认关卡", "REVIEW_REQUIRED");
    if (isActiveRunStatus(resumeSource.status) || (!rerunFromRunId && resumeSource.status === "completed")) throw new HttpError(409, "这条运行记录仍在执行或已经完成，不可续跑");
    if (!resumeSource.workflow || resumeSource.sceneId !== value.sceneId) throw new HttpError(409, "断点来源与当前工作流不匹配");
    workflowValue = resumeSource.workflow as unknown as Record<string, unknown>;
    inputValues = structuredClone(resumeSource.inputValues);
    runTitle ||= resumeSource.runTitle ?? "";
    if (rerunFromRunId) {
      rerun = planRerun(resumeSource, input?.rerunRequest, dependencies.capabilities);
      workflowValue = rerun.workflow as unknown as Record<string, unknown>;
      inputValues = structuredClone(rerun.inputValues);
    }
    const sourcePaths = runArtifactPaths(settings.projectDirectory, sourceId);
    const archivedInput = await readJsonFile(sourcePaths.inputs);
    for (const item of Array.isArray(archivedInput?.files) ? archivedInput.files : []) {
      const file = asRecord(item);
      if (typeof file?.key === "string" && rerun?.request.inputOverrides && Object.prototype.hasOwnProperty.call(rerun.request.inputOverrides, file.key)) continue;
      if (typeof file?.key !== "string" || typeof file.path !== "string" || !file.path.startsWith("inputs/files/")) continue;
      const filename = path.resolve(sourcePaths.directory, ...file.path.split(/[\/]/));
      if (!filename.startsWith(`${path.resolve(sourcePaths.directory)}${path.sep}`)) continue;
      try {
        if (!(await stat(filename)).isFile()) continue;
        const index = typeof file.index === "number" && Number.isSafeInteger(file.index) && file.index >= 0 ? file.index : undefined;
        const restored = restoredArchivedInput(inputValues[file.key], filename, index);
        if (restored !== undefined) inputValues[file.key] = restored;
      } catch { /* Archived inputs may not exist in older runs; preserve original locators. */ }
    }
  }
  validateWorkflowShape(workflowValue);
  // Validate the raw shape before normalization; malformed requests must not crash .map().
  for (const field of workflowValue.inputs as unknown[]) {
    const candidate = asRecord(field);
    if (!candidate || typeof candidate.key !== "string" || typeof candidate.type !== "string") throw new HttpError(400, "场景输入字段配置无效");
  }
  const stepIds = new Set<string>();
  for (const rawStep of workflowValue.steps as unknown[]) {
    const step = asRecord(rawStep);
    if (!step || typeof step.id !== "string" || !step.id || typeof step.name !== "string" || typeof step.kind !== "string" || stepIds.has(step.id)) throw new HttpError(400, "步骤配置无效或步骤 ID 重复");
    stepIds.add(step.id);
    if (!dependencies.supportsStep(step.kind)) throw new HttpError(400, `暂不支持执行方式：${step.kind}`, "UNSUPPORTED_STEP");
    if ((step.inputs !== undefined && !Array.isArray(step.inputs)) || (step.outputs !== undefined && !Array.isArray(step.outputs))) throw new HttpError(400, "步骤输入或输出格式无效");
  }
  let executionWorkflow = normalizeRunWorkflow(workflowValue as unknown as RunWorkflowDefinition);
  validateCarryReferences(executionWorkflow);
  validateStartConditionReferences(executionWorkflow);
  if (dependencies.prepareStep) executionWorkflow = { ...executionWorkflow, steps: executionWorkflow.steps.map(dependencies.prepareStep) };
  if (dependencies.resolveAssets) inputValues = await dependencies.resolveAssets(settings.projectDirectory, executionWorkflow, inputValues);
  validateWorkflowInputs(executionWorkflow, inputValues);
  if (rerun) {
    for (const item of rerun.itemStepOverrides) {
      validateWorkflowShape({ ...workflowValue, steps: [item.step] });
      if (dependencies.prepareStep) item.step = dependencies.prepareStep(item.step);
    }
  }
  const legacyExecution = executionWorkflow.execution;
  if (legacyExecution) {
    const { execution: _execution, ...withoutExecution } = executionWorkflow;
    const index = legacyExecution.mode === "for_each" && !executionWorkflow.steps.some((step) => step.execution?.mode === "for_each") ? executionWorkflow.steps.findIndex((step) => step.kind !== "control") : -1;
    executionWorkflow = index < 0 ? withoutExecution : { ...withoutExecution, steps: executionWorkflow.steps.map((step, position) => position === index ? { ...step, execution: legacyExecution } : step) };
  }
  const iterative = executionWorkflow.steps.filter((step) => step.execution?.mode === "for_each");
  for (const step of iterative) if (!step.execution?.sourceRef?.trim()) throw new HttpError(400, `${step.name} 的逐项执行必须选择列表或数组来源`);
  try { await stat(runArtifactPaths(settings.projectDirectory, runId).directory); throw new HttpError(409, "运行记录编号已存在"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  inputValues = normalizeWorkflowMediaInputs(executionWorkflow, inputValues);
  const createdAt = new Date().toISOString();
  const feedbackHistory = [...structuredClone(resumeSource?.feedbackHistory ?? []), ...(rerun?.request.feedback ?? []).map(feedback => captureStepFeedback(resumeSource!, feedback, createdAt))];
  const artifacts = await prepareRunArtifacts(settings, runId, executionWorkflow, inputValues, createdAt, runTitle || undefined);
  let feedbackSourceAliases: Record<string, string> | undefined;
  try {
    if (rerun) await archiveRerunMedia(rerun, artifacts);
    if (feedbackHistory.length) feedbackSourceAliases = await readFeedbackSourceAliases(settings.projectDirectory, runId, feedbackHistory);
  }
  catch (error) {
    await discardRunArtifacts(settings.projectDirectory, runId).catch(failure => log("warn", "run.preparation_cleanup_failed", { runId, error: String(failure) }));
    throw error;
  }
  return { runId, executionWorkflow, inputValues, settings, artifacts, createdAt, ...(feedbackHistory.length ? { feedbackHistory, feedbackSourceAliases } : {}), ...(runTitle ? { runTitle } : {}), ...(resumedFromRunId ? { resumedFromRunId, resumeSource } : {}), ...(rerunFromRunId ? { rerunFromRunId, rerun } : {}) };
}
