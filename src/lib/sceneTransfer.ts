import { createScene } from "./sceneStorage";
import { createId } from "./ids";
import { canonicalWorkflowType, migrateLegacyComfyInputFormats, normalizeWorkflowMediaTypes } from "./workflowMigration";
import { validWorkflowMediaRole } from "../../server/domain/workflowMediaRoles.js";
import type {
  JsonValue,
  SceneModule,
  WorkflowDefinition,
  WorkflowFieldType,
  WorkflowObjectArrayItemField,
  WorkflowOptionPreset,
  WorkflowStepDefinition,
  WorkflowValueSource,
  WorkflowVariableType,
  WorkflowMediaSelection,
} from "../types";

const packageFormat = "zane-studio-scene";
const packageVersion = 1;

export interface ScenePackage {
  format: typeof packageFormat;
  version: typeof packageVersion;
  exportedAt: string;
  scene: SceneModule;
  workflow: WorkflowDefinition;
  optionPresets: WorkflowOptionPreset[];
}

export interface ImportedScene {
  scene: SceneModule;
  workflow: WorkflowDefinition;
  optionPresets: WorkflowOptionPreset[];
}

const workflowFieldTypes: WorkflowFieldType[] = ["text", "textarea", "number", "boolean", "select", "image_list", "video_list", "audio_list", "json"];
const workflowVariableTypes: WorkflowVariableType[] = ["text", "number", "boolean", "image_list", "video_list", "audio_list", "json"];
const workflowExecutionModes = ["once", "for_each"] as const;
const workflowIterationErrorPolicies = ["continue", "stop"] as const;
const workflowStepKinds: WorkflowStepDefinition["kind"][] = ["hermes", "comfyui", "manual", "control", "capability"];
const workflowConditionOperators: NonNullable<WorkflowStepDefinition["control"]>["rules"][number]["operator"][] = [
  "equals", "not_equals", "greater_than", "greater_or_equal", "less_than", "less_or_equal",
  "contains", "not_contains", "is_empty", "is_not_empty",
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  return isRecord(value) && Object.values(value).every(isJsonValue);
}
function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`场景包中的${label}无效`);
  return value;
}

function optionalString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function enumValue<T extends string>(value: unknown, values: T[], label: string): T {
  if (typeof value !== "string" || !values.includes(value as T)) throw new Error(`场景包中的${label}无效`);
  return value as T;
}

function normalizeMaxConcurrency(value: unknown, label: string) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > 32) {
    throw new Error(`场景包中的${label}无效`);
  }
  return value;
}

function normalizeMediaSelection(value: unknown, label: string): WorkflowMediaSelection | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new Error(`场景包中的${label}媒体选择无效`);
  const mode = enumValue(value.mode, ["all", "item", "for_each"] as const, `${label}媒体选择方式`);
  if (mode !== "item") return { mode };
  if (typeof value.index !== "number" || !Number.isSafeInteger(value.index) || value.index < 0) {
    throw new Error(`场景包中的${label}媒体序号无效`);
  }
  return { mode, index: value.index };
}

function normalizeScene(value: unknown): SceneModule {
  if (!isRecord(value)) throw new Error("场景包缺少有效的场景信息");
  const accent = value.accent === "coral" ? "coral" : value.accent === "green" ? "green" : undefined;
  if (!accent) throw new Error("场景包中的强调色无效");
  if (!Array.isArray(value.stages) || value.stages.some((stage) => typeof stage !== "string")) {
    throw new Error("场景包中的流程阶段无效");
  }
  return {
    id: requiredString(value.id, "场景 ID"),
    title: requiredString(value.title, "场景名称"),
    shortTitle: optionalString(value.shortTitle, optionalString(value.title)),
    summary: optionalString(value.summary),
    description: optionalString(value.description),
    cover: optionalString(value.cover),
    coverPosition: optionalString(value.coverPosition, "center"),
    accent,
    stages: value.stages.map((stage) => stage.trim()).filter(Boolean),
  };
}

function normalizeStepReference(value: unknown, label: string) {
  if (!isRecord(value)) throw new Error(`场景包中的${label}无效`);
  const result: WorkflowDefinition["steps"][number]["inputs"][number] = {
    key: requiredString(value.key, `${label} key`),
    label: requiredString(value.label, `${label}名称`),
    sourceRef: optionalString(value.sourceRef),
  };
  if (value.valueSource !== undefined) result.valueSource = enumValue(value.valueSource, ["literal", "reference"] as WorkflowValueSource[], `${label}取值来源`);
  if (typeof value.literalValue === "string") result.literalValue = value.literalValue;
  if (value.literalType !== undefined) result.literalType = enumValue(value.literalType, workflowVariableTypes, `${label}固定值类型`);
  if (value.referenceType !== undefined) result.referenceType = enumValue(value.referenceType, ["image_list", "video_list", "audio_list"] as const, `${label}引用媒体类型`);
  const selection = normalizeMediaSelection(value.selection, label);
  if (selection) result.selection = selection;
  if (result.valueSource === "literal" && result.literalValue === undefined) result.literalValue = "";
  return result;
}

function normalizeWorkflowInput(value: unknown, index: number) {
  if (!isRecord(value)) throw new Error(`场景包中的第 ${index + 1} 个场景输入无效`);
  if (typeof value.required !== "boolean") throw new Error(`场景包中的场景输入“${String(value.label ?? index + 1)}”缺少必填设置`);
  const input: WorkflowDefinition["inputs"][number] = {
    key: requiredString(value.key, `第 ${index + 1} 个场景输入 key`),
    label: requiredString(value.label, `第 ${index + 1} 个场景输入名称`),
    type: enumValue(canonicalWorkflowType(value.type), workflowFieldTypes, `第 ${index + 1} 个场景输入类型`),
    required: value.required,
  };
  if (value.hidden !== undefined && typeof value.hidden !== "boolean") throw new Error(`场景包中的场景输入“${input.label}”隐藏设置无效`);
  if (value.hidden !== undefined) input.hidden = value.hidden;
  if (!validWorkflowMediaRole(value.mediaRole, input.type)) throw new Error("场景包中的素材用途与场景输入类型不兼容");
  if (value.mediaRole !== undefined) input.mediaRole = value.mediaRole;
  if (value.minimum !== undefined || value.maximum !== undefined) {
    if (input.type !== "number" || (value.minimum !== undefined && (typeof value.minimum !== "number" || !Number.isFinite(value.minimum))) || (value.maximum !== undefined && (typeof value.maximum !== "number" || !Number.isFinite(value.maximum))) || (typeof value.minimum === "number" && typeof value.maximum === "number" && value.minimum > value.maximum)) throw new Error(`场景包中的场景输入“${input.label}”数字范围无效`);
    if (typeof value.minimum === "number") input.minimum = value.minimum;
    if (typeof value.maximum === "number") input.maximum = value.maximum;
  }
  if (value.defaultValue !== undefined) {
    if (!isJsonValue(value.defaultValue)) throw new Error(`场景包中的场景输入“${input.label}”默认值不是有效 JSON`);
    input.defaultValue = structuredClone(value.defaultValue);
  }
  if (typeof value.placeholder === "string") input.placeholder = value.placeholder;
  if (Array.isArray(value.options)) {
    if (value.options.some((option) => typeof option !== "string")) throw new Error(`场景包中的场景输入“${input.label}”选项无效`);
    input.options = value.options.map((option) => option.trim()).filter(Boolean);
  }
  if (typeof value.optionPresetId === "string" && value.optionPresetId) input.optionPresetId = value.optionPresetId;
  if (value.inputMode !== undefined || value.itemFields !== undefined) {
    if (value.inputMode !== "object_array" || input.type !== "json" || !Array.isArray(value.itemFields) || value.itemFields.length === 0 || value.itemFields.length > 50) throw new Error(`场景包中的场景输入“${input.label}”对象数组表单配置无效`);
    const seen = new Set<string>();
    input.inputMode = "object_array";
    input.itemFields = value.itemFields.map((raw, itemIndex) => {
      if (!isRecord(raw)) throw new Error(`场景包中的对象数组第 ${itemIndex + 1} 个子字段无效`);
      const key = requiredString(raw.key, "对象数组子字段 key");
      const label = requiredString(raw.label, "对象数组子字段名称");
      if (seen.has(key)) throw new Error("对象数组子字段 key 不能重复");
      seen.add(key);
      if (!["text", "number", "boolean", "select"].includes(String(raw.type)) || typeof raw.required !== "boolean") throw new Error(`对象数组子字段“${label}”类型或必填配置无效`);
      const item: WorkflowObjectArrayItemField = { key, label, type: raw.type as WorkflowObjectArrayItemField["type"], required: raw.required };
      if (raw.minimum !== undefined || raw.maximum !== undefined) {
        if (item.type !== "number" || (raw.minimum !== undefined && (typeof raw.minimum !== "number" || !Number.isFinite(raw.minimum))) || (raw.maximum !== undefined && (typeof raw.maximum !== "number" || !Number.isFinite(raw.maximum))) || (typeof raw.minimum === "number" && typeof raw.maximum === "number" && raw.minimum > raw.maximum)) throw new Error(`场景包中的对象数组字段“${label}”数字范围无效`);
        if (typeof raw.minimum === "number") item.minimum = raw.minimum;
        if (typeof raw.maximum === "number") item.maximum = raw.maximum;
      }
      if (typeof raw.placeholder === "string") item.placeholder = raw.placeholder;
      if (Array.isArray(raw.options)) {
        if (raw.options.some(option => typeof option !== "string")) throw new Error(`对象数组子字段“${label}”选项无效`);
        item.options = raw.options.map(option => option.trim()).filter(Boolean);
      }
      if (item.type === "select" && !item.options?.length) throw new Error(`对象数组下拉字段“${label}”至少需要一个选项`);
      return item;
    });
  }
  return input;
}

function normalizeStepOutput(value: unknown, index: number) {
  if (!isRecord(value)) throw new Error(`场景包中的第 ${index + 1} 个步骤输出无效`);
  const output: WorkflowStepDefinition["outputs"][number] = {
    key: requiredString(value.key, `第 ${index + 1} 个步骤输出 key`),
    label: requiredString(value.label, `第 ${index + 1} 个步骤输出名称`),
    type: enumValue(canonicalWorkflowType(value.type), workflowVariableTypes, `第 ${index + 1} 个步骤输出类型`),
  };
  if (typeof value.description === "string") output.description = value.description;
  return output;
}

function normalizeControlConfig(value: unknown, index: number): NonNullable<WorkflowStepDefinition["control"]> {
  if (!isRecord(value) || value.type !== "condition" || !Array.isArray(value.rules)) {
    throw new Error(`场景包中的第 ${index + 1} 个条件步骤配置无效`);
  }
  return {
    type: "condition",
    match: enumValue(value.match, ["all", "any"], `第 ${index + 1} 个条件步骤匹配方式`),
    rules: value.rules.map((rule) => {
      if (!isRecord(rule)) throw new Error(`场景包中的第 ${index + 1} 个条件规则无效`);
      return {
        id: requiredString(rule.id, `第 ${index + 1} 个条件规则 ID`),
        leftRef: requiredString(rule.leftRef, `第 ${index + 1} 个条件规则引用`),
        operator: enumValue(rule.operator, workflowConditionOperators, `第 ${index + 1} 个条件规则运算符`),
        valueSource: enumValue(rule.valueSource, ["literal", "reference"], `第 ${index + 1} 个条件规则取值来源`),
        rightValue: optionalString(rule.rightValue),
        rightRef: optionalString(rule.rightRef),
      };
    }),
  };
}

function normalizeRunCondition(value: unknown, index: number): NonNullable<WorkflowStepDefinition["runCondition"]> {
  if (!isRecord(value) || typeof value.expectedResult !== "boolean") {
    throw new Error(`场景包中的第 ${index + 1} 个步骤运行条件无效`);
  }
  return {
    conditionStepId: requiredString(value.conditionStepId, `第 ${index + 1} 个步骤的条件步骤引用`),
    expectedResult: value.expectedResult,
  };
}

function normalizeComfyBinding(value: unknown, index: number) {
  if (!isRecord(value)) throw new Error(`场景包中的第 ${index + 1} 个 ComfyUI 绑定无效`);
  const direction = enumValue(value.direction, ["input", "output"], `第 ${index + 1} 个 ComfyUI 绑定方向`);
  const binding: NonNullable<NonNullable<WorkflowStepDefinition["comfyui"]>["bindings"]>[number] = {
    key: requiredString(value.key, `第 ${index + 1} 个 ComfyUI 绑定 key`),
    label: requiredString(value.label, `第 ${index + 1} 个 ComfyUI 绑定名称`),
    direction,
    nodeId: requiredString(value.nodeId, `第 ${index + 1} 个 ComfyUI 绑定节点`),
    property: requiredString(value.property, `第 ${index + 1} 个 ComfyUI 绑定属性`),
    type: enumValue(canonicalWorkflowType(value.type), workflowVariableTypes, `第 ${index + 1} 个 ComfyUI 绑定类型`),
  };
  if (!validWorkflowMediaRole(value.mediaRole, binding.type, direction)) throw new Error("场景包中的素材用途与 ComfyUI 绑定类型/方向不兼容");
  if (value.mediaRole !== undefined) binding.mediaRole = value.mediaRole;
  if (typeof value.required === "boolean") binding.required = value.required;
  if (typeof value.sourceRef === "string") binding.sourceRef = value.sourceRef;
  if (value.valueSource !== undefined) binding.valueSource = enumValue(value.valueSource, ["literal", "reference"] as WorkflowValueSource[], `第 ${index + 1} 个 ComfyUI 绑定取值来源`);
  if (typeof value.literalValue === "string") binding.literalValue = value.literalValue;
  const selection = normalizeMediaSelection(value.selection, `第 ${index + 1} 个 ComfyUI 绑定`);
  if (selection) binding.selection = selection;
  if (binding.valueSource === "literal" && binding.literalValue === undefined) binding.literalValue = "";
  if (Array.isArray(value.options)) {
    if (value.options.some((option) => typeof option !== "string")) throw new Error(`场景包中的 ComfyUI 绑定选项无效`);
    binding.options = value.options.map((option) => option.trim()).filter(Boolean);
  }
  if (isRecord(value.sourceInputFormat)) {
    const format = value.sourceInputFormat;
    if (typeof format.required !== "boolean") throw new Error("场景包中的 ComfyUI 输入格式无效");
    binding.sourceInputFormat = {
       type: enumValue(canonicalWorkflowType(format.type), workflowFieldTypes, "ComfyUI 输入格式类型"),
      required: format.required,
      ...(Array.isArray(format.options) ? { options: format.options.filter((option): option is string => typeof option === "string") } : {}),
      ...(typeof format.optionPresetId === "string" && format.optionPresetId ? { optionPresetId: format.optionPresetId } : {}),
    };
  }
  if (isRecord(value.sourceOutputFormat)) {
    binding.sourceOutputFormat = {
      stepId: requiredString(value.sourceOutputFormat.stepId, "ComfyUI 输出格式步骤"),
      outputKey: requiredString(value.sourceOutputFormat.outputKey, "ComfyUI 输出格式 key"),
       type: enumValue(canonicalWorkflowType(value.sourceOutputFormat.type), workflowVariableTypes, "ComfyUI 输出格式类型"),
    };
  }
  return binding;
}

function normalizeWorkflowStep(value: unknown, index: number): WorkflowStepDefinition {
  if (!isRecord(value)) throw new Error(`场景包中的第 ${index + 1} 个步骤无效`);
  const kind = enumValue(value.kind, workflowStepKinds, `第 ${index + 1} 个步骤类型`);
  if (!Array.isArray(value.inputs) || !Array.isArray(value.outputs)) throw new Error(`场景包中的步骤“${String(value.name ?? index + 1)}”缺少输入或输出`);
  const step: WorkflowStepDefinition = {
    id: requiredString(value.id, `第 ${index + 1} 个步骤 ID`),
    name: requiredString(value.name, `第 ${index + 1} 个步骤名称`),
    kind,
    inputs: value.inputs.map((input, inputIndex) => normalizeStepReference(input, `第 ${index + 1} 个步骤的第 ${inputIndex + 1} 个输入`)),
    outputs: value.outputs.map(normalizeStepOutput),
    promptTemplate: optionalString(value.promptTemplate),
  };
  if (value.capabilityId !== undefined) step.capabilityId = requiredString(value.capabilityId, "能力包 ID");
  if (value.capabilityVersion !== undefined) step.capabilityVersion = requiredString(value.capabilityVersion, "能力包版本");
  if (value.capabilityConfig !== undefined) {
    if (!isRecord(value.capabilityConfig)) throw new Error("场景包中的能力包配置无效");
    step.capabilityConfig = structuredClone(value.capabilityConfig) as NonNullable<WorkflowStepDefinition["capabilityConfig"]>;
  }
  if (kind === "capability" && !step.capabilityId) throw new Error("能力步骤缺少能力包 ID");
  const rawExecution = isRecord(value.execution) ? value.execution : undefined;
  if (rawExecution) {
    step.execution = {
      mode: enumValue(rawExecution.mode, [...workflowExecutionModes], `第 ${index + 1} 个步骤执行方式`),
      ...(typeof rawExecution.sourceRef === "string" && rawExecution.sourceRef.trim() ? { sourceRef: rawExecution.sourceRef.trim() } : {}),
      ...(rawExecution.onError === undefined ? {} : { onError: enumValue(rawExecution.onError, [...workflowIterationErrorPolicies], `第 ${index + 1} 个步骤逐项失败策略`) }),
      ...(rawExecution.maxConcurrency === undefined ? {} : { maxConcurrency: normalizeMaxConcurrency(rawExecution.maxConcurrency, `第 ${index + 1} 个步骤最大并行数`) }),
      ...(rawExecution.carry === undefined ? {} : { carry: normalizeCarry(rawExecution.carry) }),
    };
  }
  if (typeof value.hermesProfile === "string") step.hermesProfile = value.hermesProfile;
  if (isRecord(value.comfyui)) {
    if (!Array.isArray(value.comfyui.bindings)) throw new Error(`步骤“${step.name}”的 ComfyUI 绑定无效`);
    step.comfyui = {
      workflowFile: optionalString(value.comfyui.workflowFile),
      bindings: value.comfyui.bindings.map(normalizeComfyBinding),
    };
    if (value.comfyui.adapter !== undefined) {
      step.comfyui.adapter = requiredString(value.comfyui.adapter, "ComfyUI 执行适配器");
      if (step.comfyui.adapter === "h3_long_video") {
        const config = value.comfyui.h3LongVideo;
        if (!isRecord(config)) throw new Error("H3 长视频步骤缺少分段和素材引用");
        step.comfyui.h3LongVideo = {
          planRef: requiredString(config.planRef, "H3 分段方案引用"),
          promptRowsRef: requiredString(config.promptRowsRef, "H3 提示词列表引用"),
          referenceImagesRef: requiredString(config.referenceImagesRef, "H3 参考图引用"),
          ...(typeof config.materialNoteRef === "string" && config.materialNoteRef.trim() ? { materialNoteRef: config.materialNoteRef } : {}),
        };
      }
    }
  }

  if (value.control !== undefined) step.control = normalizeControlConfig(value.control, index);
  if (value.review !== undefined) {
    if (!isRecord(value.review) || typeof value.review.enabled !== "boolean" || (value.review.instruction !== undefined && typeof value.review.instruction !== "string")) throw new Error("场景包中的人工确认配置无效");
    step.review = { enabled: value.review.enabled, ...(typeof value.review.instruction === "string" ? { instruction: value.review.instruction } : {}) };
  }
  if (value.runCondition !== undefined) step.runCondition = normalizeRunCondition(value.runCondition, index);
  return step;
}

function normalizeWorkflow(value: unknown, sceneId: string): WorkflowDefinition {
  if (!isRecord(value)) throw new Error("场景包缺少有效的流程配置");
  if (!Array.isArray(value.inputs) || !Array.isArray(value.steps) || !Array.isArray(value.outputs)) throw new Error("场景包中的流程配置不完整");
  const outputs = value.outputs.map((output, index) => {
    if (!isRecord(output)) throw new Error(`场景包中的第 ${index + 1} 个最终输出无效`);
    const selection = normalizeMediaSelection(output.selection, `第 ${index + 1} 个最终输出`);
    return {
      key: requiredString(output.key, `第 ${index + 1} 个最终输出 key`),
      label: requiredString(output.label, `第 ${index + 1} 个最终输出名称`),
      type: enumValue(canonicalWorkflowType(output.type), workflowVariableTypes, `第 ${index + 1} 个最终输出类型`),
      sourceRef: requiredString(output.sourceRef, `第 ${index + 1} 个最终输出引用`),
      ...(selection ? { selection } : {}),
    };
  });
  const rawExecution = isRecord(value.execution) ? value.execution : undefined;
  if (rawExecution?.carry !== undefined) throw new Error("状态传递仅支持步骤级for_each");
  const execution = rawExecution
    ? {
      mode: enumValue(rawExecution.mode, [...workflowExecutionModes], "流程执行方式"),
      ...(typeof rawExecution.sourceRef === "string" && rawExecution.sourceRef.trim() ? { sourceRef: rawExecution.sourceRef.trim() } : {}),
      ...(rawExecution.onError === undefined ? {} : { onError: enumValue(rawExecution.onError, [...workflowIterationErrorPolicies], "逐项失败策略") }),
      ...(rawExecution.maxConcurrency === undefined ? {} : { maxConcurrency: normalizeMaxConcurrency(rawExecution.maxConcurrency, "流程最大并行数") }),
    }
    : undefined;
  return normalizeWorkflowMediaTypes(migrateLegacyComfyInputFormats({
    sceneId,
    name: requiredString(value.name, "流程名称"),
    inputs: value.inputs.map(normalizeWorkflowInput),
    steps: value.steps.map(normalizeWorkflowStep),
    outputs,
    ...(execution ? { execution } : {}),
  }));
}

function normalizeOptionPresets(value: unknown): WorkflowOptionPreset[] {
  if (!Array.isArray(value)) throw new Error("场景包中的选项预设无效");
  const seen = new Set<string>();
  return value.map((item, index) => {
    if (!isRecord(item)) throw new Error(`场景包中的第 ${index + 1} 个选项预设无效`);
    const id = requiredString(item.id, `第 ${index + 1} 个选项预设 ID`);
    if (seen.has(id)) throw new Error(`场景包中的选项预设 ID 重复：${id}`);
    seen.add(id);
    if (!Array.isArray(item.options) || item.options.some((option) => typeof option !== "string")) throw new Error(`选项预设“${String(item.name ?? id)}”的选项无效`);
    return {
      id,
      name: requiredString(item.name, `第 ${index + 1} 个选项预设名称`),
      options: [...new Set(item.options.map((option) => option.trim()).filter(Boolean))],
    };
  });
}

function referencedPresetIds(workflow: WorkflowDefinition) {
  const ids = new Set<string>();
  workflow.inputs.forEach((input) => {
    if (input.optionPresetId) ids.add(input.optionPresetId);
  });
  workflow.steps.forEach((step) => step.comfyui?.bindings.forEach((binding) => {
    if (binding.sourceInputFormat?.optionPresetId) ids.add(binding.sourceInputFormat.optionPresetId);
  }));
  return ids;
}

export function createScenePackage(scene: SceneModule, workflow: WorkflowDefinition, optionPresets: WorkflowOptionPreset[]): ScenePackage {
  const presetIds = referencedPresetIds(workflow);
  return {
    format: packageFormat,
    version: packageVersion,
    exportedAt: new Date().toISOString(),
    scene: structuredClone(scene),
    workflow: { ...structuredClone(workflow), sceneId: scene.id },
    optionPresets: structuredClone(optionPresets.filter((preset) => presetIds.has(preset.id))),
  };
}

export function serializeScenePackage(scene: SceneModule, workflow: WorkflowDefinition, optionPresets: WorkflowOptionPreset[]) {
  return JSON.stringify(createScenePackage(scene, workflow, optionPresets), null, 2);
}

export function parseScenePackage(value: unknown): ScenePackage {
  if (!isRecord(value) || value.format !== packageFormat || value.version !== packageVersion) {
    throw new Error("无法识别这个场景文件，请使用 Zane Studio 导出的 JSON 文件");
  }
  const scene = normalizeScene(value.scene);
  const workflow = normalizeWorkflow(value.workflow, scene.id);
  const optionPresets = normalizeOptionPresets(value.optionPresets ?? []);
  return { format: packageFormat, version: packageVersion, exportedAt: optionalString(value.exportedAt), scene, workflow, optionPresets };
}

function sameOptions(left: string[], right: string[]) {
  return left.length === right.length && left.every((option, index) => option === right[index]);
}

function remapWorkflowPresetIds(workflow: WorkflowDefinition, presetIds: Map<string, string>, sceneId: string): WorkflowDefinition {
  const mapPresetId = (id: string | undefined) => id ? presetIds.get(id) ?? id : undefined;
  return {
    ...workflow,
    sceneId,
    inputs: workflow.inputs.map((input) => ({ ...input, optionPresetId: mapPresetId(input.optionPresetId) })),
    steps: workflow.steps.map((step) => ({
      ...step,
      comfyui: step.comfyui ? {
        ...step.comfyui,
        bindings: step.comfyui.bindings.map((binding) => ({
          ...binding,
          sourceInputFormat: binding.sourceInputFormat ? {
            ...binding.sourceInputFormat,
            optionPresetId: mapPresetId(binding.sourceInputFormat.optionPresetId),
          } : binding.sourceInputFormat,
        })),
      } : step.comfyui,
    })),
  };
}

export function prepareImportedScene(scenePackage: ScenePackage, existingOptionPresets: WorkflowOptionPreset[]): ImportedScene {
  const scene = createScene(scenePackage.scene);
  const existingById = new Map(existingOptionPresets.map((preset) => [preset.id, preset]));
  const presetIds = new Map<string, string>();
  const importedPresets = scenePackage.optionPresets.map((preset) => {
    const existing = existingById.get(preset.id);
    if (!existing) {
      presetIds.set(preset.id, preset.id);
      return structuredClone(preset);
    }
    if (existing.name === preset.name && sameOptions(existing.options, preset.options)) {
      presetIds.set(preset.id, preset.id);
      return undefined;
    }
    const nextId = `option_preset_${createId()}`;
    presetIds.set(preset.id, nextId);
    return { ...structuredClone(preset), id: nextId };
  }).filter((preset): preset is WorkflowOptionPreset => Boolean(preset));
  return {
    scene,
    workflow: remapWorkflowPresetIds(scenePackage.workflow, presetIds, scene.id),
    optionPresets: importedPresets,
  };
}

export function downloadScenePackage(scene: SceneModule, workflow: WorkflowDefinition, optionPresets: WorkflowOptionPreset[]) {
  const safeName = scene.title.trim().replace(/[^a-zA-Z0-9\u4e00-\u9fff_-]+/g, "-").replace(/^-+|-+$/g, "") || scene.id;
  const blob = new Blob([serializeScenePackage(scene, workflow, optionPresets)], { type: "application/json;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `zane-scene-${safeName}.json`;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function normalizeCarry(value: unknown): NonNullable<WorkflowStepDefinition["execution"]>["carry"] {
  if (!isRecord(value) || typeof value.outputKey !== "string" || !/^[a-zA-Z0-9_]+$/.test(value.outputKey)
    || Object.keys(value).some(key => !["outputKey", "initialSourceRef"].includes(key))
    || (value.initialSourceRef !== undefined && (typeof value.initialSourceRef !== "string" || !value.initialSourceRef.trim()))) throw new Error("状态传递配置无效");
  return { outputKey: value.outputKey, ...(typeof value.initialSourceRef === "string" ? { initialSourceRef: value.initialSourceRef } : {}) };
}
