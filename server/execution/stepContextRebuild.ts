import { asRecord, canonicalWorkflowType, parseWorkflowJsonPath, resolveWorkflowReference, resolveWorkflowValue, splitWorkflowReference } from "../domain/workflowValues.js";
import { createRuntimeMediaValue, isRuntimeMediaValue, mediaKindFromWorkflowType } from "../runtimeValue.js";
import type { JsonValue, RunRecord, RunStep, RunStepItemRecord, RunStepRecord } from "../domain/types.js";

/** 把一条已完成运行的执行期上下文重建出来，用于「不重做地把反馈交给该步骤的 Agent」。
 *
 *  为什么必须重建而不是复用持久化值：运行记录里的输入与步骤输出已经 externalize（媒体变成
 *  {path} 或路径字符串），而执行期的引用解析、提示词模板渲染、附件构造都要求 runtime 形态。
 *  重建规则与 workflowExecutor 逐步对齐：
 *  - 输入：外部化值 → 声明为媒体类型的字段包回 runtime 媒体值；
 *  - 步骤值：目标步骤之前的每个有输出的步骤记录，按声明输出类型包回 runtime 媒体值；
 *  - 类型表：按步骤声明的输出类型建立 step.<id>.outputs.<key> 引用类型，供模板把图片/视频
 *    渲染成「已作为附件提供」而不是 JSON 文本；
 *  - 逐项：按 for_each 来源引用取回该项值，并注入同名的 iteration.item 上下文。 */

export interface StepExecutionContextValues {
  inputs: Record<string, JsonValue>;
  values: Map<string, Record<string, JsonValue>>;
  types: Map<string, string>;
  itemIndex?: number;
  iterationItems?: readonly JsonValue[];
  /** 整次运行的原始输入（for_each 替换来源字段前的快照），供需要判断来源范围的适配器只读使用。 */
  runInputValues: Record<string, JsonValue>;
}

function runtimeMediaValue(kind: "image" | "video" | "audio" | undefined, value: JsonValue): JsonValue {
  return kind ? createRuntimeMediaValue(kind, value) : value;
}

function externalizedRunInputs(run: RunRecord): Record<string, JsonValue> {
  const inputs = structuredClone(run.inputValues ?? {}) as Record<string, JsonValue>;
  for (const field of run.workflow.inputs ?? []) {
    const value = inputs[field.key];
    if (value === undefined || value === null || value === "") continue;
    inputs[field.key] = runtimeMediaValue(mediaKindFromWorkflowType(field.type), value);
  }
  return inputs;
}

/** 目标步骤之前、带有输出记录的步骤值。目标步骤自己的旧结果不进引用表：它是被修订的对象，
 *  不是可引用的上游；重做链路也按同一口径失效该项及其下游。 */
function externalizedStepValues(run: RunRecord, targetIndex: number): Map<string, Record<string, JsonValue>> {
  const values = new Map<string, Record<string, JsonValue>>();
  for (const [index, definition] of run.workflow.steps.entries()) {
    if (index >= targetIndex) break;
    const outputs = asRecord(run.steps.find(candidate => candidate.stepId === definition.id)?.outputs);
    if (!outputs) continue;
    values.set(definition.id, Object.fromEntries(Object.entries(outputs).map(([key, value]) => [
      key, runtimeMediaValue(mediaKindFromWorkflowType(definition.outputs?.find(output => output.key === key)?.type), value as JsonValue),
    ])));
  }
  return values;
}

/** 与 workflowExecutor 的 replaceIterationPath 同一规则：来源是 JSON 路径时，只替换路径指向的那一项。 */
function replaceIterationPath(value: JsonValue, segments: Array<string | number>, item: JsonValue): JsonValue {
  if (!segments.length) return item;
  const [segment, ...remaining] = segments;
  if (typeof segment === "number" && Array.isArray(value) && segment < value.length) {
    const next = [...value];
    next[segment] = replaceIterationPath(next[segment]!, remaining, item);
    return next;
  }
  if (typeof segment === "string" && value !== null && typeof value === "object" && !Array.isArray(value) && !isRuntimeMediaValue(value)
    && Object.prototype.hasOwnProperty.call(value, segment)) {
    const recordValue = value as { [key: string]: JsonValue };
    return { ...recordValue, [segment]: replaceIterationPath(recordValue[segment]!, remaining, item) };
  }
  throw new Error(`逐项执行来源路径不存在：${segments.join(".")}`);
}

export function rebuildStepExecutionContext(run: RunRecord, stepId: string, itemIndex?: number): StepExecutionContextValues {
  const targetIndex = run.workflow.steps.findIndex(candidate => candidate.id === stepId);
  const step = run.workflow.steps[targetIndex];
  if (!step) throw new Error("没有找到此步骤");
  const inputs = externalizedRunInputs(run);
  const values = externalizedStepValues(run, targetIndex);
  const runInputValues = structuredClone(inputs);
  const base: StepExecutionContextValues = { inputs, values, types: declareReferenceTypes(run), runInputValues };

  if (itemIndex === undefined) return base;
  if (step.execution?.mode !== "for_each") throw new Error("此步骤不是逐项步骤，不能按项反馈");
  const sourceRef = step.execution.sourceRef?.trim() ?? "";
  if (!sourceRef) throw new Error(`${step.name} 的逐项执行来源为空`);
  const source = resolveWorkflowReference(sourceRef, inputs, values);
  if (!Array.isArray(source)) throw new Error(`${step.name} 的逐项来源必须是数组`);
  const item = source[itemIndex];
  if (item === undefined) throw new Error("逐项编号超出该步骤的来源范围");
  // 执行期把来源字段本身也替换成当前项（JSON 路径只替换该位置），并把 iteration.item 一并注入；
  // 两条都要重建，否则模板里既引用 input.items 又引用 iteration.item 时会看到不一致的上下文。
  const info = iterationSource(step, run);
  const mediaKind = mediaKindFromWorkflowType(info.type);
  const sourceItem = info.path.length ? item : mediaKind ? createRuntimeMediaValue(mediaKind, item) : item;
  const iterationItem = mediaKind ? sourceItem : item;
  if (info.kind === "input") {
    return {
      ...base,
      inputs: {
        ...inputs,
        [info.key]: info.path.length ? replaceIterationPath(inputs[info.key]!, info.path, sourceItem) : sourceItem,
        "iteration.item": iterationItem,
      },
      itemIndex,
      iterationItems: source,
    };
  }
  const sourceOutputs = values.get(info.stepId);
  if (!sourceOutputs || !Object.prototype.hasOwnProperty.call(sourceOutputs, info.key)) throw new Error(`逐项执行来源 ${sourceRef} 没有可用数组`);
  const nextValues = new Map(values);
  nextValues.set(info.stepId, {
    ...sourceOutputs,
    [info.key]: info.path.length ? replaceIterationPath(sourceOutputs[info.key]!, info.path, sourceItem) : sourceItem,
  });
  return { ...base, inputs: { ...inputs, "iteration.item": iterationItem }, values: nextValues, itemIndex, iterationItems: source };
}

/** 来源引用拆成「哪个字段、声明类型、JSON 路径」；与执行期 iterationSourceInfo 同一解析口径。 */
function iterationSource(step: RunStep, run: RunRecord): { kind: "input"; key: string; type?: string; path: Array<string | number> } | { kind: "step"; stepId: string; key: string; type?: string; path: Array<string | number> } {
  const parsed = splitWorkflowReference(step.execution?.sourceRef?.trim() ?? "");
  if (!parsed) throw new Error(`${step.name} 的逐项执行来源无效`);
  const path = parsed.path ? parseWorkflowJsonPath(parsed.path) : [];
  const inputMatch = /^input\.([a-zA-Z0-9_]+)$/.exec(parsed.root);
  if (inputMatch) return { kind: "input", key: inputMatch[1]!, type: run.workflow.inputs.find(field => field.key === inputMatch[1])?.type, path };
  const outputMatch = /^step\.([a-zA-Z0-9_-]+)\.outputs\.([a-zA-Z0-9_]+)$/.exec(parsed.root);
  if (outputMatch) {
    const definition = run.workflow.steps.find(candidate => candidate.id === outputMatch[1]);
    return { kind: "step", stepId: outputMatch[1]!, key: outputMatch[2]!, type: definition?.outputs?.find(output => output.key === outputMatch[2])?.type, path };
  }
  throw new Error(`${step.name} 的逐项执行来源无效：${step.execution?.sourceRef ?? ""}`);
}

/** 声明输出类型 → 引用类型表；模板渲染据此决定媒体占位文案。 */
function declareReferenceTypes(run: RunRecord): Map<string, string> {
  const types = new Map<string, string>();
  for (const definition of run.workflow.steps) {
    for (const output of definition.outputs ?? []) types.set("step." + definition.id + ".outputs." + output.key, canonicalWorkflowType(output.type));
  }
  return types;
}

/** 该步骤在运行记录里的已完成结果；整步与逐项分别取，未完成返回 undefined 而不是空对象。 */
export function completedStepResult(run: RunRecord, stepId: string, itemIndex?: number): { record: RunStepRecord; item?: RunStepItemRecord } | undefined {
  const record = run.steps.find(candidate => candidate.stepId === stepId);
  if (itemIndex === undefined) return record && Object.keys(record.outputs ?? {}).length ? { record } : undefined;
  const item = record?.items?.find(candidate => candidate.index === itemIndex);
  return item && Object.keys(item.outputs ?? {}).length ? { record: record!, item } : undefined;
}

/** 步骤输入解析必须在付费请求之前完成；上游结果缺失或引用路径不存在时明确失败，不静默发空输入。 */
export function resolveStepExecutionContextInputs(step: RunStep, context: StepExecutionContextValues) {
  return Object.fromEntries((step.inputs ?? []).map(input => [input.key, resolveWorkflowValue(input, context.inputs, context.values) ?? null])) as Record<string, JsonValue>;
}
