import { carryValue } from "../domain/iterationCarry.js";
import { validateStepFeedback } from "../domain/stepFeedback.js";
import { isDeepStrictEqual } from "node:util";
import { HttpError } from "../errors.js";
import { isActiveRunStatus } from "../domain/types.js";
import type { JsonValue, RunRecord, RunStep, RunStepRecord, RunWorkflowDefinition } from "../domain/types.js";
import type { RerunPlan, RerunRequest, StepEdit } from "../domain/rerunContracts.js";
import { asRecord, canonicalWorkflowType, externalizeRuntimeValue, isReadableMediaItem, normalizeMediaList, resolveWorkflowReference, splitWorkflowReference, parseWorkflowLiteral } from "../domain/workflowValues.js";
import { capabilityForStep, readCapabilityConfig } from "../capabilities/contracts.js";
import type { CapabilityDefinition } from "../capabilities/contracts.js";
export interface ItemStepOverride { stepId: string; itemIndex: number; step: RunStep; sourceValue?: JsonValue }
export interface PlannedRerun {
  workflow: RunWorkflowDefinition; inputValues: Record<string, JsonValue>; plan: RerunPlan;
  reusedSteps: RunStepRecord[]; itemSources: RunStepRecord[]; itemStepOverrides: ItemStepOverride[]; request: RerunRequest;
}
function invalid(message: string): never { throw new HttpError(400, message, "INVALID_RERUN"); }
function array(value: unknown, label: string): Record<string, unknown>[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((item) => !asRecord(item))) invalid(label + "格式无效");
  return value as Record<string, unknown>[];
}
export function applyStepEdit(step: RunStep, edit: StepEdit): RunStep {
  const { stepId: _stepId, itemIndex: _itemIndex, ...changes } = edit;
  return { ...structuredClone(step), ...structuredClone(changes) };
}
function references(step: RunStep, catalog: readonly CapabilityDefinition[]) {
  const refs: string[] = [];
  const add = (value: unknown) => { if (typeof value === "string" && splitWorkflowReference(value)) refs.push(value); };
  for (const input of step.inputs ?? []) if (input.valueSource !== "literal") add(input.sourceRef);
  for (const binding of step.comfyui?.bindings ?? []) if (binding.direction === "input" && binding.valueSource !== "literal") add(binding.sourceRef);
  add(step.execution?.sourceRef);
  add(step.execution?.carry?.initialSourceRef);
  for (const rule of step.control?.rules ?? []) { add(rule.leftRef); if (rule.valueSource === "reference") add(rule.rightRef); }
  if (step.runCondition) add("step." + step.runCondition.conditionStepId + ".outputs.result");
  for (const match of step.promptTemplate?.matchAll(/\{\{([^{}]+)\}\}/g) ?? []) add(match[1].trim());
  const definition = capabilityForStep(step, catalog);
  for (const field of definition?.config ?? []) if (field.type === "reference") add(readCapabilityConfig(step, field));
  // Historical H3 snapshots may not yet have a capability identity.
  for (const value of Object.values(step.comfyui?.h3LongVideo ?? {})) add(value);
  return refs.map((ref) => splitWorkflowReference(ref)!.root);
}
function normalizeOutput(value: unknown, type: string, label: string): JsonValue {
  const normalized = canonicalWorkflowType(type);
  if (["image_list", "video_list", "audio_list"].includes(normalized)) {
    const items = normalizeMediaList(value);
    if (!items.every(isReadableMediaItem)) invalid(label + "必须填写媒体路径、URL 或附件对象");
    return items;
  }
  const valid = normalized === "number" ? typeof value === "number" && Number.isFinite(value)
    : normalized === "boolean" ? typeof value === "boolean"
    : normalized === "json" ? value !== undefined
    : typeof value === "string";
  if (!valid) invalid(label + "的数据类型不匹配");
  return structuredClone(value) as JsonValue;
}
function aggregate(step: RunStep, items: NonNullable<RunStepRecord["items"]>) {
  return Object.fromEntries((step.outputs ?? []).map((output) => {
    const values = items.filter((item) => item.status === "completed").sort((a, b) => a.index - b.index).map((item) => item.outputs?.[output.key] ?? null);
    return [output.key, ["image_list", "video_list", "audio_list"].includes(canonicalWorkflowType(output.type)) ? values.flatMap((value) => normalizeMediaList(externalizeRuntimeValue(value))) : values];
  })) as Record<string, JsonValue>;
}
/** Pure preview: no files, database writes, or provider calls. The source snapshot is never mutated. */
export function planRerun(source: RunRecord, body: unknown, catalog: readonly CapabilityDefinition[] = []): PlannedRerun {
  if (source.status === "waiting") throw new HttpError(409, "请先处理人工确认关卡", "REVIEW_REQUIRED");
  if (isActiveRunStatus(source.status)) throw new HttpError(409, "运行中不能修改结果，请等待结束或取消后再操作", "RUN_STILL_ACTIVE");
  if (source.workflow.execution?.mode === "for_each") throw new HttpError(409, "旧式整流程逐项记录暂不支持局部重做，请先迁移为步骤级逐项执行");
  const request = asRecord(body); if (!request) invalid("局部重做请求格式无效");
  const allowed = new Set(["inputOverrides", "stepOverrides", "outputOverrides", "rerunSteps", "feedback"]);
  if (Object.keys(request).some((key) => !allowed.has(key))) invalid("局部重做请求包含不支持的字段");
  const workflow = structuredClone(source.workflow);
  const inputValues = structuredClone(source.inputValues);
  const originals = new Map(source.workflow.steps.map((step) => [step.id, step]));
  const records = new Map(source.steps.map((step) => [step.stepId, structuredClone(step)]));
  const changedInputKeys: string[] = [];
  const full = new Map<string, string>();
  const selected = new Map<string, Set<number>>();
  const replaced = new Set<string>();
  const replacedChainIndexes = new Map<string, number>();
  const itemStepOverrides: ItemStepOverride[] = [];
  const globalEdits = new Set<string>();
  const checkStep = (id: unknown) => {
    if (typeof id !== "string" || !originals.has(id)) invalid("找不到指定步骤：" + String(id));
    return originals.get(id)!;
  };
  const checkItem = (step: RunStep, index: unknown) => {
    if (step.execution?.mode !== "for_each" || !Number.isSafeInteger(index) || (index as number) < 0 || !records.get(step.id)?.items?.some((item) => item.index === index)) invalid(step.name + "没有这个逐项结果");
    return index as number;
  };
  const select = (stepId: string, index: number) => { const indexes = selected.get(stepId) ?? new Set<number>(); indexes.add(index); selected.set(stepId, indexes); };
  if (request.inputOverrides !== undefined) {
    const inputs = asRecord(request.inputOverrides); if (!inputs) invalid("场景输入修改格式无效");
    for (const [key, value] of Object.entries(inputs)) {
      if (!workflow.inputs.some((field) => field.key === key)) invalid("场景输入不存在：" + key);
      if (!isDeepStrictEqual(inputValues[key], value)) { changedInputKeys.push(key); inputValues[key] = structuredClone(value) as JsonValue; }
    }
  }
  const feedback = array(request.feedback, "步骤反馈").map(raw => validateStepFeedback(source, raw));
  const feedbackScopes = new Map<string, Set<number | "all">>();
  for (const entry of feedback) {
    const scopes = feedbackScopes.get(entry.stepId) ?? new Set<number | "all">();
    const scope = entry.itemIndex ?? "all";
    if (scopes.has(scope) || (scopes.size > 0 && (scope === "all" || scopes.has("all")))) invalid("同一步骤不能提交重复或重叠范围的反馈");
    scopes.add(scope); feedbackScopes.set(entry.stepId, scopes);
    if (entry.itemIndex === undefined) full.set(entry.stepId, "根据用户反馈修订结果");
    else select(entry.stepId, entry.itemIndex);
  }
  const editKeys = new Set<string>();
  for (const raw of array(request.stepOverrides, "步骤配置修改")) {
    const step = checkStep(raw.stepId);
    const key = step.id + ":" + (raw.itemIndex ?? "all"); if (editKeys.has(key)) invalid("同一步骤配置被重复修改"); editKeys.add(key);
    const fields = new Set(["stepId", "itemIndex", "promptTemplate", "hermesProfile", "capabilityConfig", "inputs", "comfyui"]);
    if (Object.keys(raw).some((field) => !fields.has(field))) invalid("只允许修改步骤参数，不能修改步骤 ID、执行方式或输出契约");
    if (Object.keys(raw).every((field) => field === "stepId" || field === "itemIndex")) invalid("步骤修改没有参数");
    for (const field of ["promptTemplate", "hermesProfile"]) if (raw[field] !== undefined && typeof raw[field] !== "string") invalid(field + "必须是文本");
    if (raw.capabilityConfig !== undefined && !asRecord(raw.capabilityConfig)) invalid("能力配置格式无效");
    if (raw.inputs !== undefined && (!Array.isArray(raw.inputs) || raw.inputs.some((input) => !asRecord(input)))) invalid("步骤输入格式无效");
    if (raw.comfyui !== undefined && !asRecord(raw.comfyui)) invalid("ComfyUI 配置格式无效");
    const edit = raw as unknown as StepEdit;
    for (const input of edit.inputs ?? []) if (input.valueSource === "literal") {
      try { parseWorkflowLiteral(input.literalValue, input.literalType, input.label ?? input.key); } catch (error) { invalid(error instanceof Error ? error.message : "固定值格式无效"); }
    }
    for (const binding of edit.comfyui?.bindings ?? []) if (binding.direction === "input" && binding.valueSource === "literal") {
      try { parseWorkflowLiteral(binding.literalValue, binding.type, binding.label ?? binding.key); } catch (error) { invalid(error instanceof Error ? error.message : "绑定固定值格式无效"); }
    }
    if (raw.itemIndex !== undefined) {
      const index = checkItem(step, raw.itemIndex);
      const item = records.get(step.id)!.items!.find((item) => item.index === index)!;
      itemStepOverrides.push({ stepId: step.id, itemIndex: index, step: applyStepEdit(item.stepSnapshot ?? step, edit), sourceValue: item.value });
      select(step.id, index);
    } else {
      workflow.steps = workflow.steps.map((item) => item.id === step.id ? applyStepEdit(item, edit) : item);
      full.set(step.id, "步骤配置已修改"); globalEdits.add(step.id);
    }
  }
  for (const raw of array(request.rerunSteps, "重做步骤")) {
    const step = checkStep(raw.stepId);
    if (Object.keys(raw).some((field) => !["stepId", "itemIndexes"].includes(field))) invalid("重做步骤包含不支持的字段；逐项编号请使用 itemIndexes");
    if (raw.itemIndexes === undefined) full.set(step.id, "手动选择重做");
    else {
      if (!Array.isArray(raw.itemIndexes) || !raw.itemIndexes.length || new Set(raw.itemIndexes).size !== raw.itemIndexes.length) invalid("请选择不重复的逐项编号");
      for (const index of raw.itemIndexes) select(step.id, checkItem(step, index));
    }
  }
  const outputKeys = new Set<string>();
  for (const raw of array(request.outputOverrides, "结果替换")) {
    const step = checkStep(raw.stepId);
    if (Object.keys(raw).some((field) => !["stepId", "itemIndex", "outputs"].includes(field))) invalid("结果替换包含不支持的字段");
    const record = records.get(step.id); const outputs = asRecord(raw.outputs);
    if (!outputs || !Object.keys(outputs).length) invalid("替换结果不能为空");
    const key = step.id + ":" + (raw.itemIndex ?? "all"); if (outputKeys.has(key)) invalid("同一个结果被重复替换"); outputKeys.add(key);
    if (full.has(step.id) || selected.has(step.id)) invalid("同一步骤不能同时替换结果和重新生成");
    const index = raw.itemIndex === undefined ? undefined : checkItem(step, raw.itemIndex);
    if (index === undefined && step.execution?.mode === "for_each") invalid("逐项步骤请指定要替换的那一项");
    if (index !== undefined && record?.status !== "completed") invalid("整个逐项步骤尚未完成，请先续跑或重做失败项，再替换结果");
    const target = index === undefined ? record : record?.items?.find((item) => item.index === index);
    if (!target || target.status !== "completed") invalid("只能替换已完成的结果；未完成结果请重做");
    const normalized: Record<string, JsonValue> = {};
    for (const [key, value] of Object.entries(outputs)) {
      const port = step.outputs?.find((output) => output.key === key); if (!port) invalid("步骤输出不存在：" + key);
      normalized[key] = normalizeOutput(value, port.type, step.name + " · " + key);
    }
    target.outputs = { ...target.outputs, ...normalized }; target.replaced = true;
    if (record?.items) record.outputs = aggregate(step, record.items);
    if (feedback.some(entry => entry.stepId === step.id)) invalid("同一步骤不能同时替换结果和反馈重做");
    if (step.execution?.carry && index !== undefined) {
      if (replacedChainIndexes.has(step.id)) invalid("状态传递链一次只能替换一项；请先完成本次后缀重算再替换其它项");
      replacedChainIndexes.set(step.id, index);
    } else replaced.add(step.id);
  }
  if (!changedInputKeys.length && !full.size && !selected.size && !replaced.size && !replacedChainIndexes.size) invalid("请修改一个结果或选择要重做的步骤");
  for (const item of itemStepOverrides) if (globalEdits.has(item.stepId)) invalid("同一步骤不能同时修改全部项和单项参数");
  const dirty = new Set<string>();
  const reusedSteps: RunStepRecord[] = []; const itemSources: RunStepRecord[] = [];
  const plan: RerunPlan = { sourceRunId: source.runId, changedInputKeys, steps: [] };
  for (let position = 0; position < workflow.steps.length; position += 1) {
    const step = workflow.steps[position]; const record = records.get(step.id);
    const definition = capabilityForStep(step, catalog);
    // A previous single-item edit can introduce dependencies absent from the
    // global step. Include its effective snapshot so later revisions cannot
    // silently reuse results whose actual inputs changed.
    const snapshots = globalEdits.has(step.id) ? [] : (record?.items ?? []).flatMap((item) => {
      const effective = itemStepOverrides.find((override) => override.stepId === step.id && override.itemIndex === item.index)?.step ?? item.stepSnapshot;
      return effective ? [effective] : [];
    });
    const roots = [...new Set([step, ...snapshots].flatMap((effective) => references(effective, catalog)))];
    for (const root of roots) {
      const id = /^step\.([a-zA-Z0-9_-]+)\.outputs\./.exec(root)?.[1];
      if (id && !workflow.steps.slice(0, position).some((prior) => prior.id === id)) invalid(step.name + "引用了不存在或尚未执行的步骤，无法规划局部重做");
    }
    const inputDirty = roots.some((ref) => ref.startsWith("input.") && changedInputKeys.includes(ref.slice(6)));
    const stepDirty = roots.some((ref) => { const id = /^step\.([a-zA-Z0-9_-]+)\.outputs\./.exec(ref)?.[1]; return id && dirty.has(id); });
    const opaque = definition && definition.dependencyMode !== "declared";
    const inherited = inputDirty || stepDirty || Boolean(opaque && (changedInputKeys.length || workflow.steps.slice(0, position).some((prior) => dirty.has(prior.id))));
    if (inherited && feedback.some(entry => entry.stepId === step.id && entry.itemIndex !== undefined)) invalid(step.name + "的逐项来源受上游修改影响，请先完成上游重做，再反馈单项结果");
    if (inherited && array(request.stepOverrides, "步骤配置修改").some((edit) => edit.stepId === step.id && edit.itemIndex !== undefined)) invalid(step.name + "的逐项来源受上游修改影响，请先完成上游重做，再修改单项参数");
    if (replaced.has(step.id)) {
      if (inherited) invalid(step.name + "同时受上游修改影响，请先重做上游，再替换此结果");
      dirty.add(step.id); reusedSteps.push({ ...record!, reusedFromRunId: source.runId, replaced: true });
      plan.steps.push({ stepId: step.id, name: step.name, action: "replace", reason: "使用手动替换的结果，不调用此步骤" }); continue;
    }
    let indexes = selected.get(step.id);
    const replacementIndex = replacedChainIndexes.get(step.id);
    if (replacementIndex !== undefined && inherited) invalid(step.name + "同时受上游修改影响，请先重做上游，再替换此结果");
    if (step.execution?.carry && (indexes || replacementIndex !== undefined)) {
      const firstDirty = indexes ? Math.min(...indexes) : replacementIndex! + 1;
      let start = Math.min(firstDirty, replacementIndex === undefined ? Infinity : replacementIndex + 1);
      const sourceValues = new Map([...records].map(([id, saved]) => [id, saved.outputs ?? {}]));
      let sourceItems: JsonValue[];
      try {
        const sourceValue = externalizeRuntimeValue(resolveWorkflowReference(step.execution.sourceRef ?? "", inputValues, sourceValues));
        if (!Array.isArray(sourceValue)) throw new Error("来源不是数组");
        sourceItems = sourceValue as JsonValue[];
      } catch { invalid("无法解析状态传递链的逐项来源，请重做整个步骤"); }
      const carryType = step.outputs?.find(output => output.key === step.execution?.carry?.outputKey)?.type ?? "json";
      for (let index = 0; index < Math.min(start, sourceItems!.length); index += 1) {
        const saved = record?.items?.find(item => item.index === index);
        let valid = Boolean(saved?.status === "completed" && isDeepStrictEqual(externalizeRuntimeValue(saved.value), externalizeRuntimeValue(sourceItems![index])));
        if (valid) try { carryValue(saved!.outputs?.[step.execution.carry.outputKey], carryType, "历史传递状态"); } catch { valid = false; }
        if (!valid) {
          if (replacementIndex !== undefined) invalid("替换项之前的状态链不完整，请先续跑或重做完成前缀");
          start = index; break;
        }
      }
      // Plan includes not-yet-started successors, not just recorded results.
      indexes = new Set(Array.from({ length: Math.max(0, sourceItems!.length - start) }, (_, offset) => start + offset));
      // A last-item replacement needs no execution, but still dirties downstream consumers.
      if (!indexes.size && replacementIndex !== undefined && !inherited && !full.has(step.id)) {
        dirty.add(step.id); reusedSteps.push({ ...record!, reusedFromRunId: source.runId, replaced: true });
        plan.steps.push({ stepId: step.id, name: step.name, action: "replace", reason: "替换链末项结果，后续依赖重新执行" }); continue;
      }
    }
    const mustRun = full.has(step.id) || inherited || Boolean(indexes) || !record || !["completed", "skipped"].includes(record.status);
    if (!mustRun) {
      reusedSteps.push({ ...record!, reusedFromRunId: source.runId });
      plan.steps.push({ stepId: step.id, name: step.name, action: "reuse", reason: "输入和依赖未变化，复用原结果" }); continue;
    }
    dirty.add(step.id);
    const partial = Boolean(indexes && !inherited && !full.has(step.id));
    const reusableItems = partial ? (record?.items ?? []).filter((item) => item.status === "completed" && !indexes!.has(item.index) && (!step.execution?.carry || item.index < Math.min(...indexes!))).map((item) => ({ ...item, reusedFromRunId: source.runId })) : [];
    if (partial && record) itemSources.push({ ...record, items: reusableItems });
    if (!globalEdits.has(step.id)) for (const item of record?.items ?? []) {
      if (item.stepSnapshot && !itemStepOverrides.some((override) => override.stepId === step.id && override.itemIndex === item.index)) itemStepOverrides.push({ stepId: step.id, itemIndex: item.index, step: item.stepSnapshot, sourceValue: item.value });
    }
    plan.steps.push({ stepId: step.id, name: step.name, action: "run", reason: inherited ? "上游数据或依赖已变化" : step.execution?.carry && partial ? "状态传递链已变化，保留完成前缀并重算后续项" : full.get(step.id) ?? (indexes ? feedback.some(entry => entry.stepId === step.id) ? "根据用户反馈修订选定项，复用其他成功项" : "只重做选定项，复用其他成功项" : "原步骤未完成"), ...(partial ? { runItemIndexes: [...indexes!].sort((a, b) => a - b), reuseItemIndexes: reusableItems.map((item) => item.index).sort((a, b) => a - b) } : {}) });
  }
  return { workflow, inputValues, plan, reusedSteps, itemSources, itemStepOverrides, request: { ...structuredClone(request) as RerunRequest, ...(feedback.length ? { feedback } : {}) } };
}
