import { validateWorkflowShape } from "../domain/workflowValidation.js";
import { stat } from "node:fs/promises";
import path from "node:path";
import { HttpError } from "../errors.js";
import { asRecord, isMediaWorkflowType, isReadableMediaItem, normalizeMediaList, normalizeRunWorkflow, normalizeWorkflowMediaInputs } from "../domain/workflowValues.js";
import type { JsonValue, RunRecord, RunWorkflowDefinition, SavedSettings } from "../domain/types.js";
import type { PreparedRun } from "../execution/workflowExecutor.js";
import { isActiveRunStatus } from "../domain/types.js";
import { prepareRunArtifacts, runArtifactPaths } from "../artifacts/runArtifacts.js";
import { readJsonFile } from "../storage/jsonFileStore.js";

export interface PreparationDependencies {
  getRun(projectDirectory: string, runId: string): Promise<RunRecord | undefined>;
  supportsStep(kind: string): boolean;
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
  if (resumedFromRunId) {
    resumeSource = await dependencies.getRun(settings.projectDirectory, resumedFromRunId);
    if (!resumeSource) throw new HttpError(404, "没有找到断点来源运行记录");
    if (isActiveRunStatus(resumeSource.status) || resumeSource.status === "completed") throw new HttpError(409, "这条运行记录仍在执行或已经完成，不可续跑");
    if (!resumeSource.workflow || resumeSource.sceneId !== value.sceneId) throw new HttpError(409, "断点来源与当前工作流不匹配");
    workflowValue = resumeSource.workflow as unknown as Record<string, unknown>;
    inputValues = structuredClone(resumeSource.inputValues);
    runTitle ||= resumeSource.runTitle ?? "";
    const sourcePaths = runArtifactPaths(settings.projectDirectory, resumedFromRunId);
    const archivedInput = await readJsonFile(sourcePaths.inputs);
    for (const item of Array.isArray(archivedInput?.files) ? archivedInput.files : []) {
      const file = asRecord(item);
      if (typeof file?.key !== "string" || typeof file.path !== "string" || !file.path.startsWith("inputs/files/")) continue;
      const filename = path.resolve(sourcePaths.directory, ...file.path.split(/[\/]/));
      if (!filename.startsWith(`${path.resolve(sourcePaths.directory)}${path.sep}`)) continue;
      try {
        if (!(await stat(filename)).isFile()) continue;
        if (typeof file.index === "number" && Number.isSafeInteger(file.index) && file.index >= 0) {
          const restored = normalizeMediaList(inputValues[file.key]); restored[file.index] = filename; inputValues[file.key] = restored;
        } else inputValues[file.key] = filename;
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
  for (const field of executionWorkflow.inputs) {
    const value = inputValues[field.key];
    const media = isMediaWorkflowType(field.type) ? normalizeMediaList(value) : [];
    const empty = value === undefined || value === null || value === "" || (isMediaWorkflowType(field.type) && media.length === 0);
    if (field.required && empty) throw new HttpError(400, `请填写必填字段：${field.key}`);
    if (empty) continue;
    const correct = isMediaWorkflowType(field.type) ? media.every(isReadableMediaItem) : field.type === "number" ? typeof value === "number" && Number.isFinite(value) : field.type === "boolean" ? typeof value === "boolean" : field.type === "json" ? typeof value === "object" : typeof value === "string";
    if (!correct) throw new HttpError(400, `字段 ${field.key} 的数据类型不匹配`);
    if (field.type === "select" && field.options && !field.options.includes(String(value))) throw new HttpError(400, `字段 ${field.key} 的选项无效`);
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
  const artifacts = await prepareRunArtifacts(settings, runId, executionWorkflow, inputValues, createdAt, runTitle || undefined);
  return { runId, executionWorkflow, inputValues, settings, artifacts, createdAt, ...(runTitle ? { runTitle } : {}), ...(resumedFromRunId ? { resumedFromRunId, resumeSource } : {}) };
}
