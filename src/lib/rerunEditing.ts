import { feedbackMessageMaxLength } from "../../server/domain/feedbackContracts.js";
import type { RerunRequest, StepEdit } from "../../server/domain/rerunContracts.js";
import type { JsonValue, WorkflowRunRecord, WorkflowStepDefinition } from "../types";
export type RerunMode = "rerun" | "replace" | "feedback";
export function canFeedbackStep(run: WorkflowRunRecord, stepId: string, itemIndex?: number): boolean {
  if (["queued", "running", "cancelling", "waiting"].includes(run.status)) return false;
  const definition = run.workflow?.steps.find(step => step.id === stepId);
  const record = run.steps.find(step => step.stepId === stepId);
  if (definition?.kind !== "hermes") return false;
  const target = itemIndex === undefined ? record : record?.items?.find(item => item.index === itemIndex);
  return Boolean(target?.status === "completed" && Object.keys(target.outputs ?? {}).length || itemIndex === undefined && record?.items?.some(item => item.status === "completed" && Object.keys(item.outputs ?? {}).length));
}
export function editableStep(run: WorkflowRunRecord, stepId: string, itemIndex?: number) {
  const base = run.workflow?.steps.find((step) => step.id === stepId);
  if (!base) throw new Error("没有找到步骤快照");
  const selected = structuredClone(itemIndex === undefined ? base : run.steps.find((step) => step.stepId === stepId)?.items?.find((item) => item.index === itemIndex)?.stepSnapshot ?? base);
  return { ...selected, inputs: selected.inputs ?? [], outputs: selected.outputs ?? [], promptTemplate: selected.promptTemplate ?? "" };
}
export function editableOutputs(run: WorkflowRunRecord, stepId: string, itemIndex?: number): Record<string, JsonValue> {
  const record = run.steps.find((step) => step.stepId === stepId);
  return structuredClone((itemIndex === undefined ? record?.outputs : record?.items?.find((item) => item.index === itemIndex)?.outputs) ?? {});
}
export function outputDraft(type: string, value: JsonValue | undefined) { return type === "text" ? String(value ?? "") : JSON.stringify(value ?? null, null, 2); }
export function parseOutputDraft(type: string, draft: string): JsonValue {
  if (type === "text") return draft;
  try { return JSON.parse(draft) as JsonValue; } catch { throw new Error("请填写有效的 JSON；媒体可通过选择本地文件替换"); }
}
export function buildRerunChanges(run: WorkflowRunRecord, stepId: string, itemIndex: number | undefined, mode: RerunMode, draftStep: WorkflowStepDefinition, outputDrafts: Record<string, string>, feedback = ""): RerunRequest {
  const base = editableStep(run, stepId, itemIndex);
  if (mode === "feedback") {
    if (!canFeedbackStep(run, stepId, itemIndex)) throw new Error("此 Hermes 步骤或逐项尚无可反馈的已完成结果");
    const message = feedback.trim();
    if (!message || message.length > feedbackMessageMaxLength) throw new Error("请填写反馈意见，最多 " + feedbackMessageMaxLength + " 字");
    return { feedback: [{ stepId, ...(itemIndex === undefined ? {} : { itemIndex }), message }] };
  }
  if (mode === "replace") {
    if (base.execution?.mode === "for_each" && itemIndex === undefined) throw new Error("逐项步骤请选择具体的一项");
    const original = editableOutputs(run, stepId, itemIndex);
    const outputs: Record<string, JsonValue> = {};
    for (const output of base.outputs) {
      if (!(output.key in outputDrafts)) continue;
      const value = parseOutputDraft(output.type, outputDrafts[output.key]);
      if (JSON.stringify(value) !== JSON.stringify(original[output.key])) outputs[output.key] = value;
    }
    if (!Object.keys(outputs).length) throw new Error("结果尚未修改；如需重新生成，请切换到重做模式");
    return { outputOverrides: [{ stepId, ...(itemIndex === undefined ? {} : { itemIndex }), outputs }] };
  }
  const edit: StepEdit = { stepId, ...(itemIndex === undefined ? {} : { itemIndex }) };
  for (const key of ["promptTemplate", "hermesProfile", "capabilityConfig", "inputs", "comfyui"] as const) {
    if (JSON.stringify(draftStep[key]) !== JSON.stringify(base[key]) && draftStep[key] !== undefined) Object.assign(edit, { [key]: structuredClone(draftStep[key]) });
  }
  return Object.keys(edit).some((key) => key !== "stepId" && key !== "itemIndex") ? { stepOverrides: [edit] } : { rerunSteps: [{ stepId, ...(itemIndex === undefined ? {} : { itemIndexes: [itemIndex] }) }] };
}
