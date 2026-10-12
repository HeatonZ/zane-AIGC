/** 流程设计的引用/路径纯函数：不依赖 React 与网络，供设计器与测试直接复用。 */
import type { WorkflowConditionOperator, WorkflowControlConfig, WorkflowDefinition, WorkflowFieldType, WorkflowStartCondition, WorkflowStepDefinition, WorkflowVariableType } from "../types";
import { canonicalWorkflowMediaType, canonicalWorkflowType } from "./workflowMigration";

export type ReferenceOption = { value: string; label: string; type?: WorkflowVariableType; isArray?: boolean; isCollection?: boolean };

const variableTypeLabels: Record<WorkflowVariableType, string> = {
  text: "文本", number: "数字", boolean: "布尔", json: "JSON",
  image: "图像", video: "视频", audio: "音频",
  image_list: "图片列表", video_list: "视频列表", audio_list: "音频列表",
};

export function conditionOperators(type?: WorkflowVariableType): WorkflowConditionOperator[] {
  const operators: WorkflowConditionOperator[] = ["equals", "not_equals", "is_empty", "is_not_empty"];
  if (type === "number") operators.push("greater_than", "greater_or_equal", "less_than", "less_or_equal");
  if (type === "text" || type === "json") operators.push("contains", "not_contains");
  return operators;
}

export function inputValueType(type: WorkflowFieldType): WorkflowVariableType {
  const canonical = canonicalWorkflowType(type) ?? type;
  return canonical === "textarea" || canonical === "select" ? "text" : canonical as WorkflowVariableType;
}

export function isMediaVariableType(type?: WorkflowVariableType) {
  return Boolean(canonicalWorkflowMediaType(type));
}

export function newConditionRule(index: number) {
  return {
    id: `rule_${Date.now().toString(36)}_${index}`,
    leftRef: "",
    operator: "equals" as WorkflowConditionOperator,
    valueSource: "literal" as const,
    rightValue: "",
    rightRef: "",
  };
}

export function defaultControlConfig(): WorkflowControlConfig {
  return { type: "condition", match: "all", rules: [newConditionRule(1)] };
}

export function defaultStartCondition(): WorkflowStartCondition {
  return { match: "all", rules: [newConditionRule(1)] };
}

export function inputReferenceOptions(workflow: WorkflowDefinition): ReferenceOption[] {
  return workflow.inputs.map((field) => ({
    value: `input.${field.key}`,
    label: `场景输入 · ${field.label}`,
    type: inputValueType(field.type),
    isArray: isMediaVariableType(inputValueType(field.type)) || field.type === "json",
    isCollection: isMediaVariableType(inputValueType(field.type)),
  }));
}

export function outputReferenceOptions(workflow: WorkflowDefinition, maxStepIndex = workflow.steps.length): ReferenceOption[] {
  return workflow.steps.slice(0, maxStepIndex).flatMap((step) => stepOutputOptions(step));
}

export function stepOutputOptions(step: WorkflowStepDefinition): ReferenceOption[] {
  return step.outputs.map((field) => ({
    value: `step.${step.id}.outputs.${field.key}`,
    label: `${step.name} · ${field.label}`,
    type: inputValueType(field.type),
    isArray: isMediaVariableType(field.type) || field.type === "json" || step.execution?.mode === "for_each",
    isCollection: isMediaVariableType(field.type) || step.execution?.mode === "for_each",
  }));
}

export function allReferenceOptions(workflow: WorkflowDefinition): ReferenceOption[] {
  return [...inputReferenceOptions(workflow), ...outputReferenceOptions(workflow)];
}

export function splitReferencePath(value: string) {
  const match = /^(iteration\.(?:item|previous|hasPrevious|index)|input\.[a-zA-Z0-9_]+|step\.[a-zA-Z0-9_-]+\.outputs\.[a-zA-Z0-9_]+)([\s\S]*)$/.exec(value);
  if (!match) return undefined;
  return {
    root: match[1],
    path: match[2].startsWith(".") && match[2].length > 1 ? match[2].slice(1) : match[2],
  };
}

export function parseJsonPath(path: string): Array<string | number> {
  let cursor = 0;
  if (path[cursor] === "$" && (path.length === 1 || path[cursor + 1] === "." || path[cursor + 1] === "[")) {
    cursor += 1;
    if (path[cursor] === ".") cursor += 1;
  }
  const segments: Array<string | number> = [];
  while (cursor < path.length) {
    if (path[cursor] === ".") {
      cursor += 1;
      const start = cursor;
      while (cursor < path.length && path[cursor] !== "." && path[cursor] !== "[") cursor += 1;
      const key = path.slice(start, cursor);
      if (!key) throw new Error("字段名为空");
      segments.push(key);
      continue;
    }
    if (path[cursor] === "[") {
      cursor += 1;
      if (path[cursor] === '"') {
        const start = cursor;
        cursor += 1;
        let escaped = false;
        while (cursor < path.length) {
          const character = path[cursor];
          cursor += 1;
          if (escaped) escaped = false;
          else if (character === "\\") escaped = true;
          else if (character === '"') break;
        }
        if (path[cursor] !== "]") throw new Error("括号路径格式无效");
        const key = JSON.parse(path.slice(start, cursor)) as unknown;
        if (typeof key !== "string") throw new Error("字段名格式无效");
        segments.push(key);
        cursor += 1;
        continue;
      }
      const end = path.indexOf("]", cursor);
      if (end < 0) throw new Error("缺少右方括号");
      const index = path.slice(cursor, end);
      if (!/^\d+$/.test(index) || !Number.isSafeInteger(Number(index))) throw new Error("数组下标必须是非负整数");
      segments.push(Number(index));
      cursor = end + 1;
      continue;
    }
    if (segments.length) throw new Error("字段之间需要用点号或方括号分隔");
    const start = cursor;
    while (cursor < path.length && path[cursor] !== "." && path[cursor] !== "[") cursor += 1;
    const key = path.slice(start, cursor);
    if (!key) throw new Error("字段名为空");
    segments.push(key);
  }
  return segments;
}

export function referenceWithJsonPath(root: string, path: string) {
  const normalized = path.trim().replace(/^\$\.?/, "").replace(/^\./, "");
  return normalized ? `${root}${normalized.startsWith("[") ? "" : "."}${normalized}` : root;
}

export function referenceOption(value: string, options: ReferenceOption[]) {
  const parsed = splitReferencePath(value);
  return options.find((option) => option.value === (parsed?.root ?? value));
}

export function referenceTypeLabel(option: ReferenceOption) {
  if (!option.type) return "";
  const mediaType = canonicalWorkflowMediaType(option.type);
  if (mediaType && option.isCollection === false) {
    if (mediaType === "image_list") return "图像";
    if (mediaType === "video_list") return "视频";
    return "音频";
  }
  if (!option.isCollection) return variableTypeLabels[option.type];
  if (mediaType === "image_list") return "图片列表";
  if (mediaType === "video_list") return "视频列表";
  if (mediaType === "audio_list") return "音频列表";
  if (option.type === "json") return "结构化数据列表";
  return `${variableTypeLabels[option.type]}列表`;
}

export function isMediaArrayReference(option: ReferenceOption | undefined) {
  return Boolean(option?.isArray && isMediaVariableType(option.type));
}

export function referencePathError(value: string, options: ReferenceOption[], allowJsonPath: boolean, allowMediaIndex = false) {
  const parsed = splitReferencePath(value);
  const option = referenceOption(value, options);
  if (!option) return "引用无效";
  if (!parsed?.path) return "";
  if (!allowJsonPath) return "字段路径只能用于结构化数据";
  try {
    parseJsonPath(parsed.path);
  } catch {
    return "JSON 字段路径格式无效";
  }
  if (option.type === "json") return "";
  if (allowMediaIndex && isMediaArrayReference(option) && /^\[\d+\]$/.test(parsed.path)) return "";
  return "媒体数组仅支持选择单项序号，例如 [0]";
}

export function isWorkflowArrayReference(workflow: WorkflowDefinition, reference: ReferenceOption) {
  if (isMediaVariableType(reference.type) || reference.type === "json") return true;
  const outputMatch = /^step\.([^.]+)\.outputs\.[^.]+$/.exec(reference.value);
  return outputMatch
    ? workflow.steps.find((step) => step.id === outputMatch[1])?.execution?.mode === "for_each"
    : false;
}

export function iterationItemReferenceOption(workflow: WorkflowDefinition, sourceRef: string, sourceOptions: ReferenceOption[]): ReferenceOption | undefined {
  const source = referenceOption(sourceRef, sourceOptions);
  if (!source || !isWorkflowArrayReference(workflow, source) || referencePathError(sourceRef, sourceOptions, true)) return undefined;
  const type = (canonicalWorkflowType(source.type) ?? source.type ?? "json") as WorkflowVariableType;
  return { value: "iteration.item", label: "当前遍历项", type, ...(isMediaVariableType(type) ? { isCollection: false } : {}) };
}

export function carryReferenceOptions(step: WorkflowStepDefinition): ReferenceOption[] {
  if (step.execution?.mode !== "for_each" || !step.execution.carry) return [];
  const output = step.outputs.find(port => port.key === step.execution?.carry?.outputKey);
  return [
    ...(output ? [{ value: "iteration.previous", label: "上一项输出（首项为初始状态或空）", type: output.type, isArray: isMediaVariableType(output.type) || output.type === "json", isCollection: isMediaVariableType(output.type) }] : []),
    { value: "iteration.hasPrevious", label: "是否有上一项/初始状态", type: "boolean" as const },
    { value: "iteration.index", label: "当前项序号（从0开始）", type: "number" as const },
  ];
}
