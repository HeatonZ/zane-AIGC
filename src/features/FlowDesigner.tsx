import {
  ArrowDown,
  ArrowRight,
  ArrowUp,
  Blocks,
  Braces,
  Check,
  ChevronDown,
  CircleHelp,
  FileInput,
  FileOutput,
  History as HistoryIcon,
  ListPlus,
  Plus,
  RefreshCw,
  Rocket,
  Sparkles,
  Trash2,
} from "lucide-react";
import { forwardRef, useEffect, useMemo, useRef, useState } from "react";
import type { InputHTMLAttributes, TextareaHTMLAttributes } from "react";
import { loadComfyUINodeInfo, loadComfyUIWorkflow, loadComfyUIWorkflows, loadConnectionSettings, loadHermesProfiles } from "../lib/api";
import type {
  ComfyUIBinding,
  ComfyUINodeInfo,
  ComfyUIPropertyInfo,
  ComfyUIWorkflowDetail,
  ComfyUIWorkflowNode,
  ComfyUIWorkflowSummary,
  HermesProfile,
  SceneId,
  SceneModule,
  SceneVersion,
  SceneVersionRecord,
  WorkflowDefinition,
  WorkflowConditionOperator,
  WorkflowConditionRule,
  WorkflowControlConfig,
  WorkflowFieldType,
  WorkflowInputField,
  WorkflowOptionPreset,
  WorkflowOutputField,
  WorkflowStepDefinition,
  WorkflowStepKind,
  WorkflowStepOutput,
  WorkflowValueSource,
  WorkflowVariableType,
} from "../types";
import SceneVersionsDialog from "./SceneVersionsDialog";
import { publishedSceneVersion, sceneDraftMatchesVersion } from "../lib/sceneVersions";

interface FlowDesignerProps {
  sceneId: SceneId;
  scenes: SceneModule[];
  scene: SceneModule;
  workflow: WorkflowDefinition;
  optionPresets: WorkflowOptionPreset[];
  versionRecord?: SceneVersionRecord;
  onSceneChange: (sceneId: SceneId) => void;
  onChange: (workflow: WorkflowDefinition) => void;
  onOptionPresetsChange: (optionPresets: WorkflowOptionPreset[]) => void;
  onPublish: () => SceneVersion | undefined;
  onApplyVersion: (version: SceneVersion) => void;
  onOpenConnections: () => void;
}

type Selection = { kind: "inputs" } | { kind: "step"; stepId: string } | { kind: "outputs" };
type ReferenceOption = { value: string; label: string; type?: WorkflowVariableType };

type DeferredInputProps = Omit<InputHTMLAttributes<HTMLInputElement>, "value" | "onChange" | "onBlur"> & {
  value: string;
  onCommit: (value: string) => void;
};

type DeferredTextareaProps = Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, "value" | "onChange" | "onBlur"> & {
  value: string;
  onCommit: (value: string) => void;
};

function useDeferredTextValue(value: string, onCommit: (nextValue: string) => void) {
  const [draft, setDraft] = useState(value);
  const draftRef = useRef(value);
  const focusedRef = useRef(false);
  const lastPropRef = useRef(value);

  useEffect(() => {
    if (value === lastPropRef.current) return;
    lastPropRef.current = value;
    if (!focusedRef.current) {
      draftRef.current = value;
      setDraft(value);
    }
  }, [value]);

  function change(nextValue: string) {
    draftRef.current = nextValue;
    setDraft(nextValue);
  }

  function commit() {
    focusedRef.current = false;
    if (draftRef.current !== value) onCommit(draftRef.current);
  }

  return {
    draft,
    change,
    focus: () => { focusedRef.current = true; },
    commit,
  };
}

function DeferredInput({ value, onCommit, ...props }: DeferredInputProps) {
  const deferred = useDeferredTextValue(value, onCommit);
  return <input {...props} value={deferred.draft} onFocus={deferred.focus} onChange={(event) => deferred.change(event.target.value)} onBlur={deferred.commit} />;
}

const DeferredTextarea = forwardRef<HTMLTextAreaElement, DeferredTextareaProps>(function DeferredTextarea({ value, onCommit, ...props }, ref) {
  const deferred = useDeferredTextValue(value, onCommit);
  return <textarea {...props} ref={ref} value={deferred.draft} onFocus={deferred.focus} onChange={(event) => deferred.change(event.target.value)} onBlur={deferred.commit} />;
});

const fieldTypeLabels: Record<WorkflowFieldType, string> = {
  text: "单行文本",
  textarea: "多行文本",
  number: "数字",
  boolean: "布尔值",
  select: "选项",
  image: "图像",
  image_list: "多图列表",
  audio: "音频",
  video: "视频",
  json: "结构化数据",
};

const outputTypeLabels: Record<WorkflowStepOutput["type"], string> = {
  text: "文本",
  number: "数字",
  boolean: "布尔值",
  image: "图像",
  image_list: "多图列表",
  video: "视频",
  json: "结构化数据",
};

const stepKindLabels: Record<WorkflowStepKind, string> = {
  hermes: "Hermes Agent",
  comfyui: "ComfyUI",
  manual: "人工处理",
  control: "控制节点",
};

const variableTypeLabels: Record<WorkflowVariableType, string> = {
  text: "文本",
  number: "数字",
  boolean: "布尔值",
  image: "图像",
  image_list: "多图列表",
  video: "视频",
  json: "结构化数据",
};

const conditionOperatorLabels: Record<WorkflowConditionOperator, string> = {
  equals: "等于",
  not_equals: "不等于",
  greater_than: "大于",
  greater_or_equal: "大于等于",
  less_than: "小于",
  less_or_equal: "小于等于",
  contains: "包含",
  not_contains: "不包含",
  is_empty: "为空",
  is_not_empty: "不为空",
};

function conditionOperators(type?: WorkflowVariableType): WorkflowConditionOperator[] {
  const operators: WorkflowConditionOperator[] = ["equals", "not_equals", "is_empty", "is_not_empty"];
  if (type === "number") operators.push("greater_than", "greater_or_equal", "less_than", "less_or_equal");
  if (type === "text" || type === "json") operators.push("contains", "not_contains");
  return operators;
}

function inputValueType(type: WorkflowFieldType): WorkflowVariableType {
  return type === "textarea" || type === "select" || type === "audio" ? "text" : type;
}

function newConditionRule(index: number): WorkflowConditionRule {
  return {
    id: `rule_${Date.now().toString(36)}_${index}`,
    leftRef: "",
    operator: "equals",
    valueSource: "literal",
    rightValue: "",
    rightRef: "",
  };
}

function defaultControlConfig(): WorkflowControlConfig {
  return { type: "condition", match: "all", rules: [newConditionRule(1)] };
}

function inputReferenceOptions(workflow: WorkflowDefinition): ReferenceOption[] {
  return workflow.inputs.map((field) => ({ value: `input.${field.key}`, label: `场景输入 · ${field.label}`, type: inputValueType(field.type) }));
}

function outputReferenceOptions(workflow: WorkflowDefinition, maxStepIndex = workflow.steps.length): ReferenceOption[] {
  return workflow.steps.slice(0, maxStepIndex).flatMap((step) =>
    step.outputs.map((field) => ({
      value: `step.${step.id}.outputs.${field.key}`,
      label: `${step.name} · ${field.label}`,
      type: field.type,
    })),
  );
}

function allReferenceOptions(workflow: WorkflowDefinition): ReferenceOption[] {
  return [...inputReferenceOptions(workflow), ...outputReferenceOptions(workflow)];
}

function splitReferencePath(value: string) {
  const match = /^(iteration\.item|input\.[a-zA-Z0-9_]+|step\.[a-zA-Z0-9_-]+\.outputs\.[a-zA-Z0-9_]+)([\s\S]*)$/.exec(value);
  if (!match) return undefined;
  return {
    root: match[1],
    path: match[2].startsWith(".") && match[2].length > 1 ? match[2].slice(1) : match[2],
  };
}

function parseJsonPath(path: string): Array<string | number> {
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

function referenceWithJsonPath(root: string, path: string) {
  const normalized = path.trim().replace(/^\$\.?/, "").replace(/^\./, "");
  return normalized ? `${root}${normalized.startsWith("[") ? "" : "."}${normalized}` : root;
}

function referenceOption(value: string, options: ReferenceOption[]) {
  const parsed = splitReferencePath(value);
  return options.find((option) => option.value === (parsed?.root ?? value));
}

function referencePathError(value: string, options: ReferenceOption[], allowJsonPath: boolean) {
  const parsed = splitReferencePath(value);
  const option = referenceOption(value, options);
  if (!option) return "引用无效";
  if (!parsed?.path) return "";
  if (!allowJsonPath || option.type !== "json") return "字段路径只能用于结构化数据";
  try {
    parseJsonPath(parsed.path);
    return "";
  } catch {
    return "JSON 字段路径格式无效";
  }
}

function isWorkflowArrayReference(workflow: WorkflowDefinition, reference: ReferenceOption) {
  if (reference.type === "image_list" || reference.type === "json") return true;
  const outputMatch = /^step\.([^.]+)\.outputs\.[^.]+$/.exec(reference.value);
  return outputMatch
    ? workflow.steps.find((step) => step.id === outputMatch[1])?.execution?.mode === "for_each"
    : false;
}

function iterationItemReferenceOption(workflow: WorkflowDefinition, sourceRef: string, sourceOptions: ReferenceOption[]): ReferenceOption | undefined {
  const source = referenceOption(sourceRef, sourceOptions);
  if (!source || !isWorkflowArrayReference(workflow, source) || referencePathError(sourceRef, sourceOptions, true)) return undefined;
  const outputMatch = /^step\.([^.]+)\.outputs\.[^.]+$/.exec(source.value);
  const sourceStep = outputMatch ? workflow.steps.find((step) => step.id === outputMatch[1]) : undefined;
  const type = source.type === "image_list" || (source.type === "image" && sourceStep?.execution?.mode === "for_each")
    ? "image"
    : source.type ?? "json";
  return { value: "iteration.item", label: "当前遍历项", type };
}

function ReferenceSelect({ value, options, onChange, allowJsonPath = false }: { value: string; options: ReferenceOption[]; onChange: (value: string) => void; allowJsonPath?: boolean }) {
  const parsed = splitReferencePath(value);
  const root = parsed?.root ?? value;
  const path = parsed?.path ?? "";
  const selected = options.find((option) => option.value === root);
  const pathEnabled = allowJsonPath && selected?.type === "json";
  return <div className="ref-select">
    <div className="select-wrap ref-select-choice"><select value={selected ? root : value} onChange={(event) => onChange(event.target.value)}>
      {!selected && value && <option value={value}>失效引用：{value}</option>}
      <option value="">选择一个输入或上游输出</option>
      {options.map((option) => <option value={option.value} key={option.value}>{option.label}{option.type ? ` · ${variableTypeLabels[option.type]}` : ""}（{option.value}）</option>)}
    </select><ChevronDown size={14} /></div>
    {pathEnabled && <DeferredInput className="text-input json-path-input" value={path} onCommit={(nextPath) => onChange(referenceWithJsonPath(root, nextPath))} placeholder="字段路径，如 [0].prompt" title="数组可写 [0].prompt；对象数组可写 shots[0].prompt" aria-label="结构化数据字段路径" />}
  </div>;
}

function newInputField(index: number): WorkflowInputField {
  return { key: `input_${index}`, label: "新输入", type: "text", required: false };
}

function newOptionPreset(index: number): WorkflowOptionPreset {
  return {
    id: `option_preset_${Date.now().toString(36)}_${index}`,
    name: `选项预设 ${index}`,
    options: [],
  };
}

function sameOptions(left: string[] | undefined, right: string[] | undefined) {
  if (!left || !right || left.length !== right.length) return false;
  return left.every((option, index) => option === right[index]);
}

function matchingOptionPresetId(optionPresets: WorkflowOptionPreset[], options?: string[]) {
  if (!options?.length) return undefined;
  return optionPresets.find((preset) => sameOptions(preset.options, options))?.id;
}

function newOutputField(index: number): WorkflowOutputField {
  return { key: `output_${index}`, label: "新输出", type: "text", sourceRef: "" };
}

function newStep(index: number, profile: string): WorkflowStepDefinition {
  return {
    id: `step_${Date.now().toString(36)}_${index}`,
    name: `新步骤 ${index}`,
    kind: "hermes",
    hermesProfile: profile,
    inputs: [],
    outputs: [{ key: "result", label: "结构化结果", type: "json" }],
    promptTemplate: "",
  };
}

function LiteralValueControl({
  type,
  value,
  options,
  onChange,
  ariaLabel,
}: {
  type: WorkflowVariableType;
  value: string;
  options?: string[];
  onChange: (value: string) => void;
  ariaLabel: string;
}) {
  if (options?.length) {
    return <div className="select-wrap literal-value-control"><select value={value} onChange={(event) => onChange(event.target.value)} aria-label={ariaLabel}><option value="">选择固定值</option>{options.map((option) => <option value={option} key={option}>{option}</option>)}</select><ChevronDown size={13} /></div>;
  }
  if (type === "boolean") {
    return <div className="select-wrap literal-value-control"><select value={value} onChange={(event) => onChange(event.target.value)} aria-label={ariaLabel}><option value="">选择真假</option><option value="true">真</option><option value="false">假</option></select><ChevronDown size={13} /></div>;
  }
  if (type === "json" || type === "image_list") {
    return <DeferredTextarea className="text-input literal-value-control literal-value-textarea" value={value} onCommit={onChange} placeholder={type === "image_list" ? "输入 JSON 数组" : "输入有效 JSON"} aria-label={ariaLabel} />;
  }
  return <DeferredInput className="text-input literal-value-control" type={type === "number" ? "number" : "text"} step={type === "number" ? "any" : undefined} value={value} onCommit={onChange} placeholder={type === "number" ? "输入数字" : "填写固定值"} aria-label={ariaLabel} />;
}

function literalValueError(type: WorkflowVariableType, value: string) {
  if (type === "number") return value.trim() && Number.isFinite(Number(value)) ? "" : "固定值需要填写有效数字";
  if (type === "boolean") return value === "true" || value === "false" ? "" : "固定值需要选择真或假";
  if (type === "json" || type === "image_list") {
    if (!value.trim()) return "固定值需要填写有效 JSON";
    try {
      const parsed = JSON.parse(value) as unknown;
      if (type === "image_list" && !Array.isArray(parsed)) return "多图列表固定值需要是 JSON 数组";
    } catch {
      return "固定值 JSON 格式无效";
    }
  }
  return "";
}

function defaultHermesOutputs(): WorkflowStepOutput[] {
  return [{ key: "result", label: "结构化结果", type: "json" }];
}

function bindingOutputType(type: WorkflowVariableType): WorkflowStepOutput["type"] {
  return type;
}

function inferredComfyBindings(step: WorkflowStepDefinition): ComfyUIBinding[] {
  return [
    ...step.inputs.map((input) => ({
      key: input.key,
      label: input.label,
      direction: "input" as const,
      nodeId: "",
      property: "",
      type: input.literalType ?? "text" as const,
      sourceRef: input.sourceRef,
      ...(input.valueSource ? { valueSource: input.valueSource } : {}),
      ...(input.literalValue !== undefined ? { literalValue: input.literalValue } : {}),
    })),
    ...step.outputs.map((output) => ({
      key: output.key,
      label: output.label,
      direction: "output" as const,
      nodeId: "",
      property: "",
      type: output.type,
    })),
  ];
}

function comfyBindings(step: WorkflowStepDefinition): ComfyUIBinding[] {
  const configured = step.comfyui?.bindings;
  return configured?.length || (!step.inputs.length && !step.outputs.length)
    ? configured ?? []
    : inferredComfyBindings(step);
}

function stepWithComfyBindings(step: WorkflowStepDefinition, bindings: ComfyUIBinding[]): WorkflowStepDefinition {
  return {
    ...step,
    comfyui: { workflowFile: step.comfyui?.workflowFile ?? "", bindings },
    inputs: bindings.filter((binding) => binding.direction === "input").map((binding) => ({
      key: binding.key,
      label: binding.label,
      sourceRef: binding.sourceRef ?? "",
      ...(binding.valueSource ? { valueSource: binding.valueSource } : {}),
      ...(binding.literalValue !== undefined ? { literalValue: binding.literalValue } : {}),
      ...(binding.valueSource === "literal" ? { literalType: binding.type } : {}),
    })),
    outputs: bindings.filter((binding) => binding.direction === "output").map((binding) => ({
      key: binding.key,
      label: binding.label,
      type: bindingOutputType(binding.type),
    })),
  };
}

function comfySourceInputKey(sourceRef: string) {
  const parsed = splitReferencePath(sourceRef);
  if (parsed?.path) return undefined;
  return /^input\.([a-zA-Z0-9_]+)$/.exec(parsed?.root ?? sourceRef)?.[1];
}

function comfySourceOutput(sourceRef: string) {
  const parsed = splitReferencePath(sourceRef);
  if (parsed?.path) return undefined;
  const match = /^step\.([a-zA-Z0-9_-]+)\.outputs\.([a-zA-Z0-9_]+)$/.exec(parsed?.root ?? sourceRef);
  return match ? { stepId: match[1], outputKey: match[2] } : undefined;
}

function bindingValueSource(binding: ComfyUIBinding): WorkflowValueSource {
  return binding.valueSource === "literal" ? "literal" : "reference";
}

function restoreComfySourceInput(workflow: WorkflowDefinition, sourceRef: string, format: ComfyUIBinding["sourceInputFormat"] | undefined, optionPresets: WorkflowOptionPreset[]): WorkflowDefinition {
  const inputKey = comfySourceInputKey(sourceRef);
  if (!inputKey || !format) return workflow;
  const optionPresetId = format.optionPresetId && optionPresets.some((preset) => preset.id === format.optionPresetId)
    ? format.optionPresetId
    : undefined;
  return {
    ...workflow,
    inputs: workflow.inputs.map((field) => {
      if (field.key !== inputKey) return field;
      const { options: _options, optionPresetId: _optionPresetId, ...withoutOptions } = field;
      return { ...withoutOptions, type: format.type, required: format.required, ...(format.options ? { options: format.options } : {}), ...(optionPresetId ? { optionPresetId } : {}) };
    }),
  };
}

function restoreComfySourceOutput(workflow: WorkflowDefinition, sourceRef: string, format?: ComfyUIBinding["sourceOutputFormat"]): WorkflowDefinition {
  const source = comfySourceOutput(sourceRef);
  if (!source || !format) return workflow;
  return {
    ...workflow,
    steps: workflow.steps.map((step) => step.id !== source.stepId ? step : {
      ...step,
      outputs: step.outputs.map((output) => output.key === source.outputKey ? { ...output, type: format.type } : output),
    }),
  };
}

function syncComfySourceFormat(
  workflow: WorkflowDefinition,
  previous: ComfyUIBinding,
  next: ComfyUIBinding,
  property?: ComfyUIPropertyInfo,
  optionPresets: WorkflowOptionPreset[] = [],
): { workflow: WorkflowDefinition; binding: ComfyUIBinding } {
  const previousReference = bindingValueSource(previous) === "reference";
  const nextReference = bindingValueSource(next) === "reference";
  const previousKey = previousReference ? comfySourceInputKey(previous.sourceRef ?? "") : undefined;
  const nextKey = nextReference ? comfySourceInputKey(next.sourceRef ?? "") : undefined;
  const previousOutput = previousReference ? comfySourceOutput(previous.sourceRef ?? "") : undefined;
  const nextOutput = nextReference ? comfySourceOutput(next.sourceRef ?? "") : undefined;
  const sameInput = Boolean(previousKey && previousKey === nextKey);
  const sameOutput = Boolean(previousOutput && nextOutput && previousOutput.stepId === nextOutput.stepId && previousOutput.outputKey === nextOutput.outputKey);
  let updatedWorkflow = workflow;

  if (previousKey && (!sameInput || !property)) {
    updatedWorkflow = restoreComfySourceInput(updatedWorkflow, previous.sourceRef ?? "", previous.sourceInputFormat, optionPresets);
  }
  if (previousOutput && (!sameOutput || !property)) {
    updatedWorkflow = restoreComfySourceOutput(updatedWorkflow, previous.sourceRef ?? "", previous.sourceOutputFormat);
  }
  if (!property || !nextKey) {
    if (!property || !nextOutput) {
      return { workflow: updatedWorkflow, binding: { ...next, sourceInputFormat: undefined, sourceOutputFormat: undefined } };
    }
  }

  if (nextKey) {
    const field = updatedWorkflow.inputs.find((item) => item.key === nextKey);
    if (!field) return { workflow: updatedWorkflow, binding: { ...next, sourceInputFormat: undefined, sourceOutputFormat: undefined } };
    const sourceInputFormat = sameInput && previous.sourceInputFormat
      ? previous.sourceInputFormat
      : { type: field.type, required: field.required, ...(field.options ? { options: field.options } : {}), ...(field.optionPresetId ? { optionPresetId: field.optionPresetId } : {}) };
    const audioInput = sourceInputFormat.type === "audio";
    const inputType: WorkflowFieldType = audioInput
      ? "audio"
      : sourceInputFormat.type === "image_list"
        ? "image_list"
        : property?.options?.length ? "select" : property!.type;
    updatedWorkflow = {
      ...updatedWorkflow,
      inputs: updatedWorkflow.inputs.map((item) => {
        if (item.key !== nextKey) return item;
        const { options: _options, optionPresetId: _optionPresetId, ...withoutOptions } = item;
        const optionPresetId = audioInput ? undefined : matchingOptionPresetId(optionPresets, property?.options);
        return {
          ...withoutOptions,
          type: inputType,
          required: property!.required ?? sourceInputFormat.required,
          ...(!audioInput && property!.options?.length ? { options: property!.options, ...(optionPresetId ? { optionPresetId } : {}) } : {}),
        };
      }),
    };
    return { workflow: updatedWorkflow, binding: { ...next, sourceInputFormat, sourceOutputFormat: undefined } };
  }

  if (nextOutput) {
    const output = updatedWorkflow.steps.find((step) => step.id === nextOutput.stepId)?.outputs.find((item) => item.key === nextOutput.outputKey);
    if (!output) return { workflow: updatedWorkflow, binding: { ...next, sourceInputFormat: undefined, sourceOutputFormat: undefined } };
    const sourceOutputFormat = sameOutput && previous.sourceOutputFormat
      ? previous.sourceOutputFormat
      : { stepId: nextOutput.stepId, outputKey: nextOutput.outputKey, type: output.type };
    updatedWorkflow = {
      ...updatedWorkflow,
      steps: updatedWorkflow.steps.map((step) => step.id !== nextOutput.stepId ? step : {
        ...step,
        outputs: step.outputs.map((item) => item.key === nextOutput.outputKey ? { ...item, type: property!.type } : item),
      }),
    };
    return { workflow: updatedWorkflow, binding: { ...next, sourceInputFormat: undefined, sourceOutputFormat } };
  }

  return { workflow: updatedWorkflow, binding: { ...next, sourceInputFormat: undefined, sourceOutputFormat: undefined } };
}

export default function FlowDesigner({ sceneId, scenes, scene, workflow, optionPresets, versionRecord, onSceneChange, onChange, onOptionPresetsChange, onPublish, onApplyVersion, onOpenConnections }: FlowDesignerProps) {
  const [selection, setSelection] = useState<Selection>({ kind: "inputs" });
  const [profiles, setProfiles] = useState<HermesProfile[]>([]);
  const [enabledProfiles, setEnabledProfiles] = useState<string[]>([]);
  const [profileError, setProfileError] = useState("");
  const [comfyWorkflows, setComfyWorkflows] = useState<ComfyUIWorkflowSummary[]>([]);
  const [comfyNodes, setComfyNodes] = useState<ComfyUIWorkflowNode[]>([]);
  const [comfyFormat, setComfyFormat] = useState<ComfyUIWorkflowDetail["format"] | null>(null);
  const [comfyConverted, setComfyConverted] = useState(false);
  const [comfyLoading, setComfyLoading] = useState(false);
  const [comfyError, setComfyError] = useState("");
  const [comfyNodeError, setComfyNodeError] = useState("");
  const [comfyNodeInfos, setComfyNodeInfos] = useState<Record<string, ComfyUINodeInfo>>({});
  const [comfyNodeLoadingTypes, setComfyNodeLoadingTypes] = useState<string[]>([]);
  const [notice, setNotice] = useState("");
  const [showVersions, setShowVersions] = useState(false);
  const promptRef = useRef<HTMLTextAreaElement>(null);
  const [referenceToInsert, setReferenceToInsert] = useState("");
  const [referencePathToInsert, setReferencePathToInsert] = useState("");

  useEffect(() => {
    Promise.all([loadHermesProfiles(), loadConnectionSettings()])
      .then(([foundProfiles, settings]) => {
        setProfiles(foundProfiles);
        setEnabledProfiles(settings.enabledHermesProfiles);
      })
      .catch(() => setProfileError("无法读取 Hermes Profile，请检查本地 API 服务。"));
  }, []);

  useEffect(() => {
    let active = true;
    loadComfyUIWorkflows()
      .then((workflows) => { if (active) setComfyWorkflows(workflows); })
      .catch((error: unknown) => { if (active) setComfyError(error instanceof Error ? error.message : "无法读取 ComfyUI 工作流"); });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    setSelection({ kind: "inputs" });
    setNotice("");
  }, [sceneId]);

  const selectedStep = selection.kind === "step" ? workflow.steps.find((step) => step.id === selection.stepId) : undefined;
  const selectedStepIndex = selectedStep ? workflow.steps.findIndex((step) => step.id === selectedStep.id) : -1;
  const selectedComfyBindings = selectedStep?.kind === "comfyui" ? comfyBindings(selectedStep) : [];
  const sourceOptions = useMemo(() => allReferenceOptions(workflow), [workflow]);
  const promptSourceOptions = selectedStep
    ? [...inputReferenceOptions(workflow), ...outputReferenceOptions(workflow, selectedStepIndex)]
    : inputReferenceOptions(workflow);
  const priorReferenceOptions = selectedStep
    ? [...inputReferenceOptions(workflow), ...outputReferenceOptions(workflow, selectedStepIndex)]
    : [];
  const stepIterationOptions = priorReferenceOptions.filter((option) => isWorkflowArrayReference(workflow, option));
  const selectedIterationItemOption = selectedStep?.execution?.mode === "for_each"
    ? iterationItemReferenceOption(workflow, selectedStep.execution.sourceRef ?? "", priorReferenceOptions)
    : undefined;
  const selectedStepReferenceOptions = selectedIterationItemOption
    ? [...priorReferenceOptions, selectedIterationItemOption]
    : priorReferenceOptions;
  const selectedStepPromptOptions = selectedIterationItemOption
    ? [...promptSourceOptions, selectedIterationItemOption]
    : promptSourceOptions;
  const promptReferenceType = referenceOption(referenceToInsert, selectedStepPromptOptions)?.type;
  const promptReferencePath = referenceWithJsonPath(referenceToInsert, referencePathToInsert);
  const promptReferencePathError = referencePathError(promptReferencePath, selectedStepPromptOptions, true);
  const priorConditionSteps = selectedStep
    ? workflow.steps.slice(0, selectedStepIndex).filter((step) => step.kind === "control")
    : [];
  const selectedControl = selectedStep?.control ?? defaultControlConfig();

  useEffect(() => {
    setReferenceToInsert("");
    setReferencePathToInsert("");
  }, [selectedStep?.id]);

  useEffect(() => {
    if (!selectedStep || selectedStep.kind !== "comfyui" || !selectedStep.comfyui?.workflowFile) {
      setComfyNodes([]);
      setComfyFormat(null);
      setComfyConverted(false);
      setComfyNodeError("");
      return;
    }
    let active = true;
    setComfyLoading(true);
    setComfyError("");
    setComfyNodeError("");
    setComfyFormat(null);
    setComfyConverted(false);
    loadComfyUIWorkflow(selectedStep.comfyui.workflowFile)
      .then((detail) => { if (active) { setComfyNodes(detail.nodes); setComfyFormat(detail.format); setComfyConverted(Boolean(detail.converted)); } })
      .catch((error: unknown) => { if (active) setComfyError(error instanceof Error ? error.message : "无法读取工作流节点"); })
      .finally(() => { if (active) setComfyLoading(false); });
    return () => { active = false; };
  }, [selectedStep?.id, selectedStep?.kind, selectedStep?.comfyui?.workflowFile]);

  function update(next: WorkflowDefinition) {
    onChange(next);
    setNotice("已暂存");
    window.setTimeout(() => setNotice(""), 1600);
  }

  function updateStep(stepId: string, mutate: (step: WorkflowStepDefinition) => WorkflowStepDefinition) {
    update({ ...workflow, steps: workflow.steps.map((step) => step.id === stepId ? mutate(step) : step) });
  }

  function addStep() {
    const step = newStep(workflow.steps.length + 1, enabledProfiles[0] ?? profiles[0]?.id ?? "default");
    update({ ...workflow, steps: [...workflow.steps, step] });
    setSelection({ kind: "step", stepId: step.id });
  }

  function moveStep(stepId: string, direction: -1 | 1) {
    const index = workflow.steps.findIndex((step) => step.id === stepId);
    const target = index + direction;
    if (index < 0 || target < 0 || target >= workflow.steps.length) return;
    const steps = [...workflow.steps];
    [steps[index], steps[target]] = [steps[target], steps[index]];
    update({ ...workflow, steps });
  }

  function insertReference() {
    const textarea = promptRef.current;
    if (!textarea || !referenceToInsert || !selectedStep) return;
    const token = `{{${promptReferencePath}}}`;
    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    const promptTemplate = `${selectedStep.promptTemplate.slice(0, start)}${token}${selectedStep.promptTemplate.slice(end)}`;
    updateStep(selectedStep.id, (step) => ({ ...step, promptTemplate }));
    requestAnimationFrame(() => {
      textarea.focus();
      textarea.setSelectionRange(start + token.length, start + token.length);
    });
  }

  function setStepInput(index: number, key: string, value: string) {
    if (!selectedStep) return;
    updateStep(selectedStep.id, (step) => ({ ...step, inputs: step.inputs.map((input, itemIndex) => itemIndex === index ? { ...input, [key]: value } : input) }));
  }

  function setStepInputSource(index: number, valueSource: WorkflowValueSource) {
    if (!selectedStep) return;
    updateStep(selectedStep.id, (step) => ({
      ...step,
      inputs: step.inputs.map((input, itemIndex) => itemIndex !== index ? input : {
        ...input,
        valueSource,
        ...(valueSource === "literal" ? { sourceRef: "", literalType: input.literalType ?? "text", literalValue: input.literalValue ?? "" } : { sourceRef: input.sourceRef ?? "" }),
      }),
    }));
  }

  function setStepOutput(index: number, key: string, value: string) {
    if (!selectedStep) return;
    updateStep(selectedStep.id, (step) => ({ ...step, outputs: step.outputs.map((output, itemIndex) => itemIndex === index ? { ...output, [key]: value } : output) }));
  }

  function updateInputField(index: number, changes: Partial<WorkflowInputField>) {
    update({
      ...workflow,
      inputs: workflow.inputs.map((field, fieldIndex) => fieldIndex === index ? { ...field, ...changes } : field),
    });
  }

  function applyOptionPreset(inputIndex: number, presetId: string) {
    const preset = optionPresets.find((item) => item.id === presetId);
    updateInputField(inputIndex, preset
      ? { options: [...preset.options], optionPresetId: preset.id }
      : { optionPresetId: undefined });
  }

  function updateOptionPreset(presetId: string, changes: Partial<WorkflowOptionPreset>) {
    onOptionPresetsChange(optionPresets.map((preset) => preset.id === presetId ? { ...preset, ...changes } : preset));
  }

  function addOptionPreset() {
    onOptionPresetsChange([...optionPresets, newOptionPreset(optionPresets.length + 1)]);
  }

  function removeOptionPreset(presetId: string) {
    onOptionPresetsChange(optionPresets.filter((preset) => preset.id !== presetId));
  }

  function updateComfyBindings(stepId: string, bindings: ComfyUIBinding[]) {
    update({
      ...workflow,
      steps: workflow.steps.map((step) => step.id === stepId ? stepWithComfyBindings(step, bindings) : step),
    });
  }

  function updateComfyBinding(stepId: string, index: number, changes: Partial<ComfyUIBinding>) {
    if (!selectedStep) return;
    const bindings = comfyBindings(selectedStep);
    updateComfyBindings(stepId, bindings.map((binding, itemIndex) => itemIndex === index ? { ...binding, ...changes } : binding));
  }

  function updateComfyBindingNode(index: number, nodeId: string) {
    if (!selectedStep || selectedStep.kind !== "comfyui") return;
    const bindings = comfyBindings(selectedStep);
    const binding = bindings[index];
    if (!binding) return;
    if (binding.nodeId.trim() === nodeId.trim()) {
      updateComfyBinding(selectedStep.id, index, { nodeId });
      return;
    }

    let updated: ComfyUIBinding = { ...binding, nodeId, property: "", options: undefined, required: undefined };
    let nextWorkflow = workflow;
    if (binding.direction === "input") {
      const result = syncComfySourceFormat(workflow, binding, updated, undefined, optionPresets);
      nextWorkflow = result.workflow;
      updated = result.binding;
    }
    const nextBindings = bindings.map((item, itemIndex) => itemIndex === index ? updated : item);
    update({
      ...nextWorkflow,
      steps: nextWorkflow.steps.map((step) => step.id === selectedStep.id ? stepWithComfyBindings(step, nextBindings) : step),
    });
  }

  function removeComfyBinding(index: number) {
    if (!selectedStep || selectedStep.kind !== "comfyui") return;
    const bindings = comfyBindings(selectedStep);
    const binding = bindings[index];
    if (!binding) return;
    const nextWorkflow = binding.direction === "input"
      ? restoreComfySourceInput(workflow, binding.sourceRef ?? "", binding.sourceInputFormat, optionPresets)
      : workflow;
    const nextBindings = bindings.filter((_, itemIndex) => itemIndex !== index);
    update({
      ...nextWorkflow,
      steps: nextWorkflow.steps.map((step) => step.id === selectedStep.id ? stepWithComfyBindings(step, nextBindings) : step),
    });
  }

  function propertyInfoForBinding(binding: ComfyUIBinding): ComfyUIPropertyInfo | undefined {
    const node = comfyNodes.find((item) => item.id === binding.nodeId.trim());
    const nodeInfo = node ? comfyNodeInfos[node.type] : undefined;
    if (!nodeInfo) return undefined;
    const properties = binding.direction === "input" ? nodeInfo.inputs : nodeInfo.outputs;
    return properties.find((property) => property.name === binding.property);
  }

  function updateComfyBindingSource(index: number, sourceRef: string) {
    if (!selectedStep || selectedStep.kind !== "comfyui") return;
    const bindings = comfyBindings(selectedStep);
    const binding = bindings[index];
    if (!binding) return;
    const propertyInfo = propertyInfoForBinding(binding);
    const result = syncComfySourceFormat(workflow, binding, { ...binding, valueSource: "reference", sourceRef, literalValue: undefined }, propertyInfo, optionPresets);
    const nextBindings = bindings.map((item, itemIndex) => itemIndex === index ? result.binding : item);
    update({
      ...result.workflow,
      steps: result.workflow.steps.map((step) => step.id === selectedStep.id ? stepWithComfyBindings(step, nextBindings) : step),
    });
  }

  function updateComfyBindingProperty(index: number, propertyName: string) {
    if (!selectedStep || selectedStep.kind !== "comfyui") return;
    const bindings = comfyBindings(selectedStep);
    const binding = bindings[index];
    if (!binding) return;
    const node = comfyNodes.find((item) => item.id === binding.nodeId.trim());
    const nodeInfo = node ? comfyNodeInfos[node.type] : undefined;
    const properties = binding.direction === "input" ? nodeInfo?.inputs : nodeInfo?.outputs;
    const propertyInfo = properties?.find((property) => property.name === propertyName);
    const isLoadAudioSelector = binding.direction === "input" && node?.type === "LoadAudio" && propertyName === "audio";
    let updated: ComfyUIBinding = propertyInfo
      ? { ...binding, property: propertyName, type: propertyInfo.type, options: isLoadAudioSelector ? undefined : propertyInfo.options, required: propertyInfo.required }
      : { ...binding, property: propertyName, options: undefined, required: undefined };
    let nextWorkflow = workflow;
    if (binding.direction === "input") {
      const result = syncComfySourceFormat(workflow, binding, updated, propertyInfo, optionPresets);
      nextWorkflow = result.workflow;
      updated = result.binding;
    }
    const nextBindings = bindings.map((item, itemIndex) => itemIndex === index ? updated : item);
    update({
      ...nextWorkflow,
      steps: nextWorkflow.steps.map((step) => step.id === selectedStep.id ? stepWithComfyBindings(step, nextBindings) : step),
    });
  }

  function syncComfyBindingsFromVariables(stepId: string, variables: ComfyUIBinding[], direction: "input" | "output") {
    if (!selectedStep) return;
    const currentBindings = comfyBindings(selectedStep);
    const otherBindings = currentBindings.filter((binding) => binding.direction !== direction);
    const variableBindings = variables.map((variable) => {
      const prior = currentBindings.find((binding) => binding.direction === direction && binding.key === variable.key);
      return { ...prior, ...variable, direction } as ComfyUIBinding;
    });
    updateComfyBindings(stepId, [...variableBindings, ...otherBindings]);
  }

  function changeComfyWorkflow(stepId: string, workflowFile: string) {
    updateStep(stepId, (step) => ({
      ...step,
      comfyui: { workflowFile, bindings: comfyBindings(step) },
    }));
  }

  async function loadComfyNodeProperties(nodeId: string) {
    const normalizedId = nodeId.trim();
    if (!normalizedId) {
      setComfyNodeError("请先填写节点 ID，再加载属性。");
      return;
    }
    const node = comfyNodes.find((item) => item.id === normalizedId);
    if (!node) {
      setComfyNodeError(`工作流中没有找到节点 ID：${normalizedId}`);
      return;
    }
    setComfyNodeError("");
    if (comfyNodeInfos[node.type]) {
      setNotice(`已加载节点 ${node.id} 的属性`);
      window.setTimeout(() => setNotice(""), 1600);
      return;
    }
    setComfyNodeLoadingTypes((current) => [...new Set([...current, node.type])]);
    try {
      const info = await loadComfyUINodeInfo(node.type);
      setComfyNodeInfos((current) => ({ ...current, [node.type]: info }));
      setNotice(`已加载 ${node.type} 的类型和选项`);
      window.setTimeout(() => setNotice(""), 1600);
    } catch (error) {
      setComfyNodeError(error instanceof Error ? error.message : `无法读取 ${node.type} 的属性定义`);
    } finally {
      setComfyNodeLoadingTypes((current) => current.filter((type) => type !== node.type));
    }
  }

  function changeStepKind(stepId: string, kind: WorkflowStepKind) {
    updateStep(stepId, (step) => {
      if (kind === "control") {
        return {
          ...step,
          kind,
          inputs: [],
          outputs: [{ key: "result", label: "判断结果", type: "boolean" }],
          promptTemplate: "",
          control: step.control ?? defaultControlConfig(),
          comfyui: undefined,
          hermesProfile: undefined,
        };
      }
      const { control: _control, ...withoutControl } = step;
      const leavingControl = step.kind === "control";
      return {
        ...withoutControl,
        kind,
        outputs: kind === "hermes" && (leavingControl || !step.outputs.length) ? defaultHermesOutputs() : leavingControl ? [] : step.outputs,
        ...(kind === "comfyui" ? { comfyui: step.comfyui ?? { workflowFile: "", bindings: [] }, hermesProfile: undefined } : {}),
        ...(kind === "hermes" ? { hermesProfile: step.hermesProfile ?? enabledProfiles[0] ?? profiles[0]?.id ?? "" } : {}),
      };
    });
  }

  function updateControl(stepId: string, mutate: (control: WorkflowControlConfig) => WorkflowControlConfig) {
    updateStep(stepId, (step) => ({ ...step, control: mutate(step.control ?? defaultControlConfig()) }));
  }

  function updateConditionRule(index: number, changes: Partial<WorkflowConditionRule>) {
    if (!selectedStep) return;
    updateControl(selectedStep.id, (control) => ({
      ...control,
      rules: control.rules.map((rule, ruleIndex) => ruleIndex === index ? { ...rule, ...changes } : rule),
    }));
  }

  function setRunCondition(stepId: string, conditionStepId: string) {
    updateStep(stepId, (step) => ({
      ...step,
      runCondition: conditionStepId
        ? { conditionStepId, expectedResult: step.runCondition?.expectedResult ?? true }
        : undefined,
    }));
  }

  function validationMessages() {
    const messages: string[] = [];
    const inputKeys = workflow.inputs.map((field) => field.key.trim());
    if (inputKeys.some((key) => !key)) messages.push("场景输入需要设置字段 key");
    if (new Set(inputKeys).size !== inputKeys.length) messages.push("场景输入 key 不能重复");
    if (workflow.inputs.some((field) => field.type === "select" && !field.options?.length)) messages.push("下拉选项字段至少需要配置一个选项");
    workflow.steps.forEach((step, index) => {
      const priorOptions = allReferenceOptions({ ...workflow, steps: workflow.steps.slice(0, index) });
      const iterationOption = step.execution?.mode === "for_each"
        ? iterationItemReferenceOption(workflow, step.execution.sourceRef ?? "", priorOptions)
        : undefined;
      const stepOptions = iterationOption ? [...priorOptions, iterationOption] : priorOptions;
      const prior = new Set(stepOptions.map((option) => option.value));
      if (step.execution?.mode === "for_each") {
        const source = referenceOption(step.execution.sourceRef ?? "", priorOptions);
        if (!source) messages.push(`${step.name} 的逐项执行需要选择列表或数组来源`);
        else if (!isWorkflowArrayReference(workflow, source)) messages.push(`${step.name} 的逐项执行来源必须是多图列表、数组或前序逐项步骤的输出`);
        else {
          const error = referencePathError(step.execution.sourceRef ?? "", priorOptions, true);
          if (error) messages.push(`${step.name} 的遍历来源 ${error}`);
        }
      }
      step.inputs.forEach((input) => {
        if ((input.valueSource ?? "reference") === "literal") {
          const type = input.literalType ?? "text";
          const error = literalValueError(type, input.literalValue ?? "");
          if (error) messages.push(`${step.name} 的${input.label || input.key} ${error}`);
        } else {
          const error = referencePathError(input.sourceRef, stepOptions, true);
          if (error === "引用无效") messages.push(`${step.name} 存在未连接或失效的输入引用`);
          else if (error) messages.push(`${step.name} 的${input.label || input.key} ${error}`);
        }
      });
      if (step.kind === "hermes" && !step.hermesProfile) messages.push(`${step.name} 还没有选择 Hermes Profile`);
      if (step.kind === "hermes" && !step.outputs.length) messages.push(`${step.name} 至少需要定义一个步骤输出`);
      if (step.outputs.some((output) => !output.key.trim())) messages.push(`${step.name} 的输出需要设置字段 key`);
      if (new Set(step.outputs.map((output) => output.key.trim())).size !== step.outputs.length) messages.push(`${step.name} 的输出 key 不能重复`);
      if (step.runCondition && !workflow.steps.slice(0, index).some((candidate) => candidate.id === step.runCondition?.conditionStepId && candidate.kind === "control")) {
        messages.push(`${step.name} 的执行条件需要引用前序条件节点`);
      }
      if (step.kind === "control") {
        const control = step.control;
        if (!control || control.type !== "condition" || control.rules.length === 0) {
          messages.push(`${step.name} 至少需要配置一条判断规则`);
        } else {
          control.rules.forEach((rule) => {
            const left = referenceOption(rule.leftRef, stepOptions);
            if (!left) messages.push(`${step.name} 存在未连接或失效的判断变量`);
            if (rule.valueSource === "reference" && !prior.has(splitReferencePath(rule.rightRef)?.root ?? rule.rightRef)) messages.push(`${step.name} 存在未连接或失效的比较变量`);
            const numericOperator = ["greater_than", "greater_or_equal", "less_than", "less_or_equal"].includes(rule.operator);
            const right = referenceOption(rule.rightRef, stepOptions);
            if (rule.valueSource === "reference") {
              const error = referencePathError(rule.rightRef, stepOptions, true);
              if (error) messages.push(`${step.name} 的比较变量 ${error}`);
            }
            const needsRightValue = rule.operator !== "is_empty" && rule.operator !== "is_not_empty";
            if (needsRightValue && rule.valueSource === "literal" && !rule.rightValue.trim()) messages.push(`${step.name} 的判断条件需要填写比较值`);
            if (numericOperator && left?.type !== "number") messages.push(`${step.name} 的大小比较只能用于数字变量`);
            if (numericOperator && rule.valueSource === "reference" && right?.type !== "number") messages.push(`${step.name} 的大小比较需要引用数字变量`);
            if (needsRightValue && rule.valueSource === "reference" && left && right && !numericOperator && left.type !== right.type) messages.push(`${step.name} 的左右引用类型不一致`);
            if (rule.valueSource === "literal" && numericOperator && rule.rightValue.trim() && !Number.isFinite(Number(rule.rightValue))) messages.push(`${step.name} 的比较值需要填写有效数字`);
            if (rule.valueSource === "literal" && left?.type === "boolean" && rule.rightValue !== "true" && rule.rightValue !== "false") messages.push(`${step.name} 需要选择真或假作为比较值`);
            if (rule.valueSource === "literal" && left?.type === "json" && rule.operator !== "is_empty" && rule.operator !== "is_not_empty" && rule.rightValue.trim()) {
              try { JSON.parse(rule.rightValue); } catch { messages.push(`${step.name} 的 JSON 比较值格式无效`); }
            }
          });
        }
      }
      if (step.kind === "comfyui") {
        const bindings = comfyBindings(step);
        if (!step.comfyui?.workflowFile) messages.push(`${step.name} 还没有选择 ComfyUI 工作流`);
        if (bindings.some((binding) => !binding.key.trim() || !binding.nodeId.trim() || !binding.property.trim())) {
          messages.push(`${step.name} 的节点绑定还未完成`);
        }
        bindings.filter((binding) => binding.direction === "input").forEach((binding) => {
          if (bindingValueSource(binding) === "literal") {
            const error = literalValueError(binding.type, binding.literalValue ?? "");
            if (error) messages.push(`${step.name} 的${binding.label || binding.key} ${error}`);
          } else {
            const error = referencePathError(binding.sourceRef ?? "", stepOptions, true);
            if (error === "引用无效") messages.push(`${step.name} 存在未连接或失效的输入引用`);
            else if (error) messages.push(`${step.name} 的${binding.label || binding.key} ${error}`);
          }
        });
        for (const direction of ["input", "output"] as const) {
          const keys = bindings.filter((binding) => binding.direction === direction).map((binding) => binding.key.trim());
          if (new Set(keys).size !== keys.length) messages.push(`${step.name} 的${direction === "input" ? "输入" : "输出"}变量 key 不能重复`);
        }
      }
    });
    const available = new Set(allReferenceOptions(workflow).map((option) => option.value));
    if (workflow.outputs.some((output) => !available.has(output.sourceRef))) messages.push("最终输出存在未连接或失效的引用");
    return [...new Set(messages)];
  }

  const validation = validationMessages();
  const currentPublishedVersion = publishedSceneVersion(versionRecord);
  const hasUnpublishedChanges = !sceneDraftMatchesVersion(scene, workflow, optionPresets, currentPublishedVersion);
  const canPublish = validation.length === 0 && hasUnpublishedChanges;

  function publish() {
    const version = onPublish();
    if (version) {
      setNotice(`已发布 v${version.version}`);
      window.setTimeout(() => setNotice(""), 1800);
    }
  }

  function setComfyBindingSource(index: number, valueSource: WorkflowValueSource) {
    if (!selectedStep || selectedStep.kind !== "comfyui") return;
    const bindings = comfyBindings(selectedStep);
    const binding = bindings[index];
    if (!binding) return;
    const nextWorkflow = valueSource === "literal" && bindingValueSource(binding) === "reference"
      ? restoreComfySourceInput(workflow, binding.sourceRef ?? "", binding.sourceInputFormat, optionPresets)
      : workflow;
    const nextBinding: ComfyUIBinding = valueSource === "literal"
      ? { ...binding, valueSource, sourceRef: "", literalValue: binding.literalValue ?? "", sourceInputFormat: undefined, sourceOutputFormat: undefined }
      : { ...binding, valueSource, sourceRef: "", literalValue: undefined, sourceInputFormat: undefined, sourceOutputFormat: undefined };
    update({
      ...nextWorkflow,
      steps: nextWorkflow.steps.map((step) => step.id === selectedStep.id ? stepWithComfyBindings(step, bindings.map((item, itemIndex) => itemIndex === index ? nextBinding : item)) : step),
    });
  }

  return (
    <div className="designer-page">
      <div className="designer-topline">
        <div>
          <div className="eyebrow"><span className="eyebrow-line" />WORKFLOW DESIGN</div>
          <h1>流程配置</h1>
          <p className="page-subtitle">按顺序配置输入、处理步骤与最终输出。</p>
        </div>
        <div className="designer-release-actions">
          <span className={`designer-release-state ${currentPublishedVersion ? hasUnpublishedChanges ? "staged" : "published" : "unpublished"}`}>
            {notice || (currentPublishedVersion ? hasUnpublishedChanges ? `暂存修改 · 当前发布 v${currentPublishedVersion.version}` : `当前发布 v${currentPublishedVersion.version}` : "尚未发布")}
          </span>
          <button className="button button-outline designer-versions-button" onClick={() => setShowVersions(true)}><HistoryIcon size={14} />版本管理</button>
          <button className="button button-dark designer-publish-button" onClick={publish} disabled={!canPublish} title={validation[0] ?? undefined}>
            {currentPublishedVersion && !hasUnpublishedChanges ? <Check size={14} /> : <Rocket size={14} />}
            {currentPublishedVersion && !hasUnpublishedChanges ? `已发布 v${currentPublishedVersion.version}` : currentPublishedVersion ? "发布更新" : "发布场景"}
          </button>
        </div>
      </div>

      <div className="designer-scene-switch" role="tablist" aria-label="创作场景">
        {scenes.map((item) => <button role="tab" aria-selected={sceneId === item.id} className={`designer-scene-tab ${sceneId === item.id ? "active" : ""}`} key={item.id} onClick={() => onSceneChange(item.id)}>
          <span className={`scene-icon-box ${item.accent}`}><Sparkles size={15} /></span><span><strong>{item.title}</strong><small>{item.summary}</small></span>
        </button>)}
      </div>

      <div className="designer-layout">
        <aside className="designer-index">
          <div className="designer-index-heading"><span>流程结构</span><span>{workflow.steps.length} 步</span></div>
          <button className={`designer-index-item ${selection.kind === "inputs" ? "active" : ""}`} onClick={() => setSelection({ kind: "inputs" })}>
            <span className="designer-index-icon input-index-icon"><FileInput size={16} /></span><span className="designer-index-copy"><strong>场景输入</strong><small>{workflow.inputs.length} 个字段</small></span>
          </button>
          <div className="designer-index-divider" />
          <div className="designer-step-index-list">
            {workflow.steps.map((step, index) => <button className={`designer-index-item designer-step-index ${selection.kind === "step" && selection.stepId === step.id ? "active" : ""}`} key={step.id} onClick={() => setSelection({ kind: "step", stepId: step.id })}>
              <span className="designer-step-number">{String(index + 1).padStart(2, "0")}</span><span className="designer-index-copy"><strong>{step.name || "未命名步骤"}</strong><small>{stepKindLabels[step.kind]}</small></span><ArrowRight size={13} className="designer-index-arrow" />
            </button>)}
          </div>
          <button className="designer-add-step" onClick={addStep}><Plus size={15} />添加步骤</button>
          <div className="designer-index-divider" />
          <button className={`designer-index-item ${selection.kind === "outputs" ? "active" : ""}`} onClick={() => setSelection({ kind: "outputs" })}>
            <span className="designer-index-icon output-index-icon"><FileOutput size={16} /></span><span className="designer-index-copy"><strong>最终输出</strong><small>{workflow.outputs.length} 个字段</small></span>
          </button>
           <div className="designer-index-footer"><CircleHelp size={14} /><span>步骤按列表顺序执行；输入可引用变量或使用固定值。</span></div>
        </aside>

        <main className="designer-panel">
          <div className="designer-panel-heading">
            <div className="designer-panel-title">
              <span className="designer-panel-icon">{selection.kind === "inputs" ? <FileInput size={17} /> : selection.kind === "outputs" ? <FileOutput size={17} /> : <Blocks size={17} />}</span>
              <div><h2>{selection.kind === "inputs" ? "场景输入" : selection.kind === "outputs" ? "最终输出" : selectedStep?.name ?? "步骤设置"}</h2><p>{selection.kind === "inputs" ? "定义启动场景时需要填写的数据" : selection.kind === "outputs" ? "把流程中的数据映射为场景最终结果" : `第 ${String(selectedStepIndex + 1).padStart(2, "0")} 步 · ${selectedStep ? stepKindLabels[selectedStep.kind] : ""}`}</p></div>
            </div>
            {selection.kind === "step" && selectedStep && <div className="step-move-actions">
              <button className="icon-button" onClick={() => moveStep(selectedStep.id, -1)} title="上移" aria-label="上移" disabled={selectedStepIndex === 0}><ArrowUp size={15} /></button>
              <button className="icon-button" onClick={() => moveStep(selectedStep.id, 1)} title="下移" aria-label="下移" disabled={selectedStepIndex === workflow.steps.length - 1}><ArrowDown size={15} /></button>
              <button className="icon-button delete-icon-button" onClick={() => { const steps = workflow.steps.filter((step) => step.id !== selectedStep.id); update({ ...workflow, steps }); setSelection({ kind: "inputs" }); }} title="删除步骤" aria-label="删除步骤"><Trash2 size={15} /></button>
            </div>}
          </div>

          {selection.kind === "inputs" && <section className="schema-editor">
            <div className="designer-field-explainer"><Braces size={15} /><span>每个输入都会成为可引用变量，例如 <code>input.story_seed</code>。</span></div>
            {workflow.inputs.map((field, index) => <div className="schema-row" key={`schema-input-${index}`}>
              <span className="schema-row-index">{String(index + 1).padStart(2, "0")}</span>
              <div className="schema-row-main">
                <DeferredInput className="text-input schema-label-input" value={field.label} onCommit={(value) => updateInputField(index, { label: value })} aria-label="输入名称" placeholder="输入名称" />
                <DeferredInput className="text-input schema-key-input" value={field.key} onCommit={(value) => updateInputField(index, { key: value.replace(/[^a-zA-Z0-9_]/g, "_") })} aria-label="输入 key" placeholder="field_key" />
                <div className="select-wrap schema-type-select"><select value={field.type} onChange={(event) => updateInputField(index, { type: event.target.value as WorkflowFieldType, ...(event.target.value === "select" ? {} : { optionPresetId: undefined }) })} aria-label="输入类型">{Object.entries(fieldTypeLabels).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select><ChevronDown size={13} /></div>
                <label className="required-toggle"><input type="checkbox" checked={field.required} onChange={(event) => updateInputField(index, { required: event.target.checked })} /><span>必填</span></label>
                <button className="icon-button schema-delete" onClick={() => update({ ...workflow, inputs: workflow.inputs.filter((_, itemIndex) => itemIndex !== index) })} title="删除输入" aria-label={`删除${field.label}`}><Trash2 size={14} /></button>
              </div>
              {field.type === "select" && <div className="schema-options-controls">
                <DeferredInput className="text-input schema-options-input" value={(field.options ?? []).join(", ")} onCommit={(value) => updateInputField(index, { options: value.split(",").map((option) => option.trim()).filter(Boolean), optionPresetId: undefined })} placeholder="选项用逗号分隔" aria-label={`${field.label} 的选项`} />
                <div className="select-wrap schema-option-preset-select"><select value={field.optionPresetId ?? ""} onChange={(event) => applyOptionPreset(index, event.target.value)} aria-label={`${field.label} 的选项预设`}><option value="">自定义选项</option>{optionPresets.map((preset) => <option value={preset.id} key={preset.id}>{preset.name}</option>)}</select><ChevronDown size={13} /></div>
              </div>}
              <DeferredInput className="text-input schema-placeholder-input" value={field.placeholder ?? ""} onCommit={(value) => update({ ...workflow, inputs: workflow.inputs.map((item, itemIndex) => itemIndex === index ? { ...item, placeholder: value } : item) })} placeholder="填写提示（可选）" aria-label={`${field.label} 的填写提示`} />
            </div>)}
            <button className="designer-add-field" onClick={() => update({ ...workflow, inputs: [...workflow.inputs, newInputField(workflow.inputs.length + 1)] })}><ListPlus size={15} />添加场景输入</button>
            <div className="designer-subsection option-presets-section">
              <div className="designer-subsection-heading"><div><h3>工作区选项预设</h3><p>把固定的 ComfyUI 选项保存一次，所有场景的选项输入都能套用</p></div><span>{optionPresets.length} 组</span></div>
              {optionPresets.map((preset) => <div className="option-preset-row" key={preset.id}>
                <DeferredInput className="text-input option-preset-name" value={preset.name} onCommit={(name) => updateOptionPreset(preset.id, { name })} placeholder="预设名称" aria-label="选项预设名称" />
                <DeferredInput className="text-input option-preset-values" value={preset.options.join(", ")} onCommit={(value) => updateOptionPreset(preset.id, { options: value.split(",").map((option) => option.trim()).filter(Boolean) })} placeholder="选项用逗号分隔，例如：SDXL, SD1.5" aria-label="预设选项" />
                <button className="icon-button schema-delete" onClick={() => removeOptionPreset(preset.id)} title="删除选项预设" aria-label={`删除${preset.name}`}><Trash2 size={14} /></button>
              </div>)}
              {!optionPresets.length && <div className="option-preset-empty">还没有预设。新建后可以在上方或其他场景的“选项”输入中直接选择。</div>}
              <button className="designer-add-field" onClick={addOptionPreset}><Plus size={15} />新建选项预设</button>
            </div>
          </section>}

          {selection.kind === "outputs" && <section className="schema-editor">
            <div className="designer-field-explainer output-explainer"><Braces size={15} /><span>最终结果可引用场景输入或任意步骤的输出。</span></div>
            {workflow.outputs.map((field, index) => <div className="final-output-row" key={`schema-output-${index}`}>
              <span className="schema-row-index">{String(index + 1).padStart(2, "0")}</span>
              <DeferredInput className="text-input" value={field.label} onCommit={(value) => update({ ...workflow, outputs: workflow.outputs.map((item, itemIndex) => itemIndex === index ? { ...item, label: value } : item) })} placeholder="结果名称" aria-label="最终输出名称" />
              <DeferredInput className="text-input output-key-input" value={field.key} onCommit={(value) => update({ ...workflow, outputs: workflow.outputs.map((item, itemIndex) => itemIndex === index ? { ...item, key: value.replace(/[^a-zA-Z0-9_]/g, "_") } : item) })} placeholder="output_key" aria-label="最终输出 key" />
              <div className="select-wrap schema-type-select"><select value={field.type} onChange={(event) => update({ ...workflow, outputs: workflow.outputs.map((item, itemIndex) => itemIndex === index ? { ...item, type: event.target.value as WorkflowOutputField["type"] } : item) })} aria-label="输出类型">{Object.entries(outputTypeLabels).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select><ChevronDown size={13} /></div>
              <button className="icon-button schema-delete" onClick={() => update({ ...workflow, outputs: workflow.outputs.filter((_, itemIndex) => itemIndex !== index) })} title="删除输出" aria-label={`删除${field.label}`}><Trash2 size={14} /></button>
              <ReferenceSelect value={field.sourceRef} options={sourceOptions} onChange={(sourceRef) => update({ ...workflow, outputs: workflow.outputs.map((item, itemIndex) => itemIndex === index ? { ...item, sourceRef } : item) })} />
            </div>)}
            <button className="designer-add-field" onClick={() => update({ ...workflow, outputs: [...workflow.outputs, newOutputField(workflow.outputs.length + 1)] })}><ListPlus size={15} />添加最终输出</button>
          </section>}

          {selection.kind === "step" && selectedStep && <section className="step-editor">
            <div className="designer-form-row">
              <div className="field-group"><label className="field-label">步骤名称</label><DeferredInput className="text-input" value={selectedStep.name} onCommit={(value) => updateStep(selectedStep.id, (step) => ({ ...step, name: value }))} /></div>
              <div className="field-group"><label className="field-label">执行方式</label><div className="select-wrap"><select value={selectedStep.kind} onChange={(event) => changeStepKind(selectedStep.id, event.target.value as WorkflowStepKind)}><option value="hermes">Hermes Agent</option><option value="comfyui">ComfyUI</option><option value="manual">人工处理</option><option value="control">控制节点 · 条件判断</option></select><ChevronDown size={14} /></div></div>
            </div>
            <div className="designer-subsection execution-config-section step-execution-section">
              <div className="designer-subsection-heading"><div><h3>步骤执行</h3><p>只让当前步骤按列表逐项运行，前后步骤仍按一次执行</p></div></div>
              <div className="execution-config-row">
                <label className="field-group"><span className="field-label">列表处理</span><div className="select-wrap"><select value={selectedStep.execution?.mode ?? "once"} onChange={(event) => {
                  if (event.target.value === "for_each") {
                    const currentSource = selectedStep.execution?.sourceRef && referenceOption(selectedStep.execution.sourceRef, stepIterationOptions)
                      && !referencePathError(selectedStep.execution.sourceRef, stepIterationOptions, true)
                      ? selectedStep.execution.sourceRef
                      : stepIterationOptions[0]?.value ?? "";
                    updateStep(selectedStep.id, (step) => ({ ...step, execution: { mode: "for_each", sourceRef: currentSource, onError: step.execution?.onError ?? "continue" } }));
                  } else updateStep(selectedStep.id, (step) => { const { execution: _execution, ...withoutExecution } = step; return withoutExecution; });
                }} aria-label="步骤列表处理方式"><option value="once">执行一次</option><option value="for_each">按列表逐项执行</option></select><ChevronDown size={13} /></div></label>
                {selectedStep.execution?.mode === "for_each" && <>
                  <label className="field-group"><span className="field-label">遍历来源</span><ReferenceSelect value={selectedStep.execution.sourceRef ?? ""} options={stepIterationOptions} onChange={(sourceRef) => updateStep(selectedStep.id, (step) => ({ ...step, execution: step.execution ? { ...step.execution, sourceRef } : undefined }))} allowJsonPath /></label>
                  <label className="field-group"><span className="field-label">单项失败时</span><div className="select-wrap"><select value={selectedStep.execution.onError ?? "continue"} onChange={(event) => updateStep(selectedStep.id, (step) => ({ ...step, execution: step.execution ? { ...step.execution, onError: event.target.value as "continue" | "stop" } : undefined }))} aria-label="步骤单项失败时的处理方式"><option value="continue">继续下一项</option><option value="stop">停止整个流程</option></select><ChevronDown size={13} /></div></label>
                </>}
              </div>
              {selectedStep.execution?.mode === "for_each" && <div className="designer-field-explainer execution-config-note"><Braces size={14} /><span>下方输入可引用“当前遍历项”；步骤输出会聚合成列表，后续步骤可以继续引用。</span></div>}
            </div>
            {(priorConditionSteps.length > 0 || selectedStep.runCondition) && <div className="designer-subsection run-condition-section">
              <div className="designer-subsection-heading"><div><h3>执行条件</h3><p>此步骤仅在指定条件节点返回对应结果时执行</p></div></div>
              <div className="run-condition-row">
                <div className="select-wrap"><select value={selectedStep.runCondition?.conditionStepId ?? ""} onChange={(event) => setRunCondition(selectedStep.id, event.target.value)} aria-label="选择执行条件"><option value="">始终执行</option>{selectedStep.runCondition && !priorConditionSteps.some((step) => step.id === selectedStep.runCondition?.conditionStepId) && <option value={selectedStep.runCondition.conditionStepId}>失效条件：{selectedStep.runCondition.conditionStepId}</option>}{priorConditionSteps.map((step) => <option value={step.id} key={step.id}>{step.name} · 判断结果</option>)}</select><ChevronDown size={14} /></div>
                {selectedStep.runCondition && <div className="select-wrap"><select value={String(selectedStep.runCondition.expectedResult)} onChange={(event) => updateStep(selectedStep.id, (step) => ({ ...step, runCondition: step.runCondition ? { ...step.runCondition, expectedResult: event.target.value === "true" } : undefined }))} aria-label="条件期望结果"><option value="true">结果为真时执行</option><option value="false">结果为假时执行</option></select><ChevronDown size={14} /></div>}
              </div>
            </div>}
            {selectedStep.kind === "hermes" && <div className="step-profile-row"><div className="field-group"><label className="field-label">Hermes Profile</label><div className="select-wrap"><select value={selectedStep.hermesProfile ?? ""} onChange={(event) => updateStep(selectedStep.id, (step) => ({ ...step, hermesProfile: event.target.value }))}><option value="">选择 Profile</option>{profiles.map((profile) => <option value={profile.id} key={profile.id}>{profile.id}{profile.isDefault ? "（默认）" : enabledProfiles.includes(profile.id) ? "（已启用）" : "（未启用）"}</option>)}</select><ChevronDown size={14} /></div></div><button className="text-button" onClick={onOpenConnections}>管理 Profile <ArrowRight size={13} /></button></div>}
            {profileError && <div className="designer-profile-error">{profileError}</div>}

            {selectedStep.kind === "control" && <div className="designer-subsection condition-editor">
              <div className="designer-subsection-heading"><div><h3>条件判断</h3><p>比较前序数据，按全部或任一规则输出真假结果</p></div><span>输出：result · 布尔值</span></div>
              <div className="condition-match-row"><span>规则关系</span><div className="select-wrap"><select value={selectedControl.match} onChange={(event) => updateControl(selectedStep.id, (control) => ({ ...control, match: event.target.value as WorkflowControlConfig["match"] }))} aria-label="规则关系"><option value="all">满足全部条件（AND）</option><option value="any">满足任一条件（OR）</option></select><ChevronDown size={14} /></div></div>
              {selectedControl.rules.map((rule, index) => {
                const leftType = referenceOption(rule.leftRef, selectedStepReferenceOptions)?.type;
                const operators = conditionOperators(leftType);
                const availableOperators = operators.includes(rule.operator) ? operators : [rule.operator, ...operators];
                const needsRightValue = rule.operator !== "is_empty" && rule.operator !== "is_not_empty";
                return <div className="condition-rule-row" key={rule.id || index}>
                  <div className="condition-rule-main">
                    <ReferenceSelect value={rule.leftRef} options={selectedStepReferenceOptions} onChange={(leftRef) => updateConditionRule(index, { leftRef, operator: "equals", valueSource: "literal", rightValue: "", rightRef: "" })} allowJsonPath />
                    <div className="select-wrap"><select value={rule.operator} onChange={(event) => updateConditionRule(index, { operator: event.target.value as WorkflowConditionOperator })} aria-label="判断运算符">{availableOperators.map((operator) => <option value={operator} key={operator}>{conditionOperatorLabels[operator]}</option>)}</select><ChevronDown size={14} /></div>
                    <button className="icon-button schema-delete" onClick={() => updateControl(selectedStep.id, (control) => ({ ...control, rules: control.rules.filter((_, ruleIndex) => ruleIndex !== index) }))} title="删除判断规则" aria-label="删除判断规则"><Trash2 size={14} /></button>
                  </div>
                  {needsRightValue ? <div className="condition-rule-value">
                    <div className="select-wrap condition-value-source"><select value={rule.valueSource} onChange={(event) => updateConditionRule(index, { valueSource: event.target.value as WorkflowConditionRule["valueSource"] })} aria-label="比较值来源"><option value="literal">常量</option><option value="reference">引用变量</option></select><ChevronDown size={13} /></div>
                    {rule.valueSource === "reference" ? <ReferenceSelect value={rule.rightRef} options={selectedStepReferenceOptions} onChange={(rightRef) => updateConditionRule(index, { rightRef })} allowJsonPath /> : leftType === "boolean" ? <div className="select-wrap"><select value={rule.rightValue} onChange={(event) => updateConditionRule(index, { rightValue: event.target.value })} aria-label="比较布尔值"><option value="">选择真假</option><option value="true">真</option><option value="false">假</option></select><ChevronDown size={14} /></div> : leftType === "json" ? <DeferredTextarea className="text-input condition-literal-textarea" value={rule.rightValue} onCommit={(value) => updateConditionRule(index, { rightValue: value })} placeholder="输入有效 JSON" aria-label="比较常量" /> : <DeferredInput className="text-input condition-literal-input" type={leftType === "number" ? "number" : "text"} step={leftType === "number" ? "any" : undefined} value={rule.rightValue} onCommit={(value) => updateConditionRule(index, { rightValue: value })} placeholder={leftType === "number" ? "输入数字" : "输入比较值"} aria-label="比较常量" />}
                  </div> : <div className="condition-no-value">无需比较值</div>}
                </div>;
              })}
              <button className="designer-add-field" onClick={() => updateControl(selectedStep.id, (control) => ({ ...control, rules: [...control.rules, newConditionRule(control.rules.length + 1)] }))}><Plus size={14} />添加判断条件</button>
            </div>}

            {selectedStep.kind === "comfyui" && <div className="designer-subsection comfyui-subsection">
              <div className="designer-subsection-heading"><div><h3>ComfyUI 工作流</h3><p>选择本机工作流，再把变量映射到节点 ID 和属性</p></div><span>{comfyLoading ? "读取中" : comfyNodes.length ? `${comfyNodes.length} 个节点` : "节点绑定"}</span></div>
              <div className="field-group comfy-workflow-picker"><label className="field-label" htmlFor="comfy-workflow-select">工作流文件</label><div className="select-wrap"><select id="comfy-workflow-select" value={selectedStep.comfyui?.workflowFile ?? ""} onChange={(event) => changeComfyWorkflow(selectedStep.id, event.target.value)}><option value="">选择 ComfyUI 工作流</option>{comfyWorkflows.map((item) => <option value={item.filename} key={item.filename}>{item.filename}</option>)}</select><ChevronDown size={14} /></div></div>
              {comfyError && <div className="designer-profile-error">{comfyError}</div>}
              {comfyNodeError && <div className="designer-profile-error">{comfyNodeError}</div>}
              {comfyConverted && <div className="notice success-notice" role="status">已自动转换为 ComfyUI API 格式，运行时会实时使用转换结果。</div>}
              {comfyFormat === "ui" && <div className="notice success-notice" role="status">已读取 ComfyUI 画布工作流，运行时会自动转换为 API 格式。</div>}
              {comfyFormat === "unknown" && <div className="designer-profile-error" role="status">无法识别此工作流格式，请选择 ComfyUI API 格式 JSON。</div>}
              {!comfyWorkflows.length && !comfyError && <div className="comfy-workflow-empty">ComfyUI 暂无可读取的 JSON 工作流</div>}
              {selectedStep.comfyui?.workflowFile && <div className="comfy-binding-groups">
                {(["input", "output"] as const).map((direction) => {
                  const bindings = selectedComfyBindings.filter((binding) => binding.direction === direction);
                  const inputDirection = direction === "input";
                  const importableInputs = inputDirection ? workflow.inputs.filter((field) => !bindings.some((binding) => binding.key === field.key)) : [];
                  return <section className="comfy-binding-group" key={direction}>
                     <div className="comfy-binding-heading"><div><strong>{inputDirection ? "输入变量" : "输出变量"}</strong><small>{inputDirection ? "引用变量或固定值写入节点属性" : "从节点属性读取，供后续步骤和最终结果引用"}</small></div><div className="comfy-binding-actions">{inputDirection && <button className="text-button comfy-import-button" onClick={() => {
                      const additions: ComfyUIBinding[] = importableInputs.map((field) => ({
                        key: field.key,
                        label: field.label,
                        direction: "input" as const,
                        nodeId: "",
                        property: "",
                        type: inputValueType(field.type),
                        sourceRef: `input.${field.key}`,
                      }));
                      updateComfyBindings(selectedStep.id, [...selectedComfyBindings, ...additions]);
                    }} disabled={!importableInputs.length}>导入场景输入{importableInputs.length ? `（${importableInputs.length}）` : ""}</button>}<button className="icon-button" onClick={() => {
                      const nextBinding: ComfyUIBinding = {
                        key: `${inputDirection ? "input" : "output"}_${bindings.length + 1}`,
                        label: inputDirection ? "新输入变量" : "新输出变量",
                        direction,
                        nodeId: "",
                        property: "",
                        type: inputDirection ? "text" : "image",
                        ...(inputDirection ? { sourceRef: "" } : {}),
                      };
                      syncComfyBindingsFromVariables(selectedStep.id, [...bindings, nextBinding], direction);
                    }} title={`添加${inputDirection ? "输入" : "输出"}绑定`} aria-label={`添加${inputDirection ? "输入" : "输出"}绑定`}><Plus size={15} /></button></div></div>
                    {bindings.map((binding) => {
                      const index = selectedComfyBindings.indexOf(binding);
                      const normalizedNodeId = binding.nodeId.trim();
                      const node = comfyNodes.find((item) => item.id === normalizedNodeId);
                      const nodeInfo = node ? comfyNodeInfos[node.type] : undefined;
                      const suffix = `${selectedStep.id}-${direction}-${index}`.replace(/[^a-zA-Z0-9_-]/g, "-");
                      const nodeListId = `comfy-node-options-${suffix}`;
                      const propertyListId = `comfy-property-options-${suffix}`;
                      const propertyInfos = inputDirection ? nodeInfo?.inputs ?? [] : nodeInfo?.outputs ?? [];
                      const workflowProperties = inputDirection ? node?.inputProperties ?? [] : node?.outputProperties ?? [];
                      const propertyOptions = [...new Set([...propertyInfos.map((property) => property.name), ...workflowProperties])];
                      const nodePropertiesLoaded = Boolean(nodeInfo);
                      const nodeLoading = Boolean(node && comfyNodeLoadingTypes.includes(node.type));
                      const selectedPropertyInfo = propertyInfos.find((property) => property.name === binding.property);
                      const valueSource = bindingValueSource(binding);
                      const sourceOptions = outputReferenceOptions(workflow, Math.max(0, selectedStepIndex)).concat(inputReferenceOptions(workflow));
                      const hasJsonPath = inputDirection && valueSource === "reference" && referenceOption(binding.sourceRef ?? "", sourceOptions)?.type === "json";
                      return <div className={`comfy-binding-row ${inputDirection ? "input-binding" : "output-binding"} ${hasJsonPath ? "has-json-path" : ""}`} key={`comfy-binding-${direction}-${index}`}>
                         <div className="comfy-binding-variable"><DeferredInput className="text-input" value={binding.label} onCommit={(value) => updateComfyBinding(selectedStep.id, index, { label: value })} placeholder="变量名称" aria-label="变量名称" /><DeferredInput className="text-input output-key-input" value={binding.key} onCommit={(value) => updateComfyBinding(selectedStep.id, index, { key: value.replace(/[^a-zA-Z0-9_]/g, "_") })} placeholder="variable_key" aria-label="变量 key" /></div>
                         {inputDirection && <div className="comfy-binding-source"><div className="select-wrap comfy-source-mode"><select value={valueSource} onChange={(event) => setComfyBindingSource(index, event.target.value as WorkflowValueSource)} aria-label="输入取值来源"><option value="reference">引用变量</option><option value="literal">固定值</option></select><ChevronDown size={13} /></div>{valueSource === "literal" ? <LiteralValueControl type={binding.type} value={binding.literalValue ?? ""} options={binding.options} onChange={(literalValue) => updateComfyBinding(selectedStep.id, index, { literalValue })} ariaLabel="输入固定值" /> : <ReferenceSelect value={binding.sourceRef ?? ""} options={selectedStepReferenceOptions} onChange={(sourceRef) => updateComfyBindingSource(index, sourceRef)} allowJsonPath />}</div>}
                        <div className="comfy-node-loader"><DeferredInput className="text-input comfy-node-input" value={binding.nodeId} onCommit={(value) => { updateComfyBindingNode(index, value); setComfyNodeError(""); }} list={nodeListId} placeholder="节点 ID" aria-label="ComfyUI 节点 ID" /><button className="icon-button comfy-node-load-button" onClick={() => loadComfyNodeProperties(binding.nodeId)} title="加载节点属性" aria-label={`加载节点 ${binding.nodeId || ""} 的属性`} disabled={comfyLoading || nodeLoading}><RefreshCw className={nodeLoading ? "spin" : undefined} size={13} /></button></div>
                        <datalist id={nodeListId}>{comfyNodes.map((item) => <option value={item.id} key={item.id}>{item.type}</option>)}</datalist>
                        <DeferredInput className="text-input comfy-property-input" value={binding.property} onCommit={(value) => updateComfyBindingProperty(index, value)} list={propertyListId} placeholder={inputDirection ? "节点输入属性" : "输出属性，如 images"} aria-label="ComfyUI 节点属性" />
                        <datalist id={propertyListId}>{nodePropertiesLoaded && propertyOptions.map((property) => <option value={property} key={property} />)}</datalist>
                        <div className="select-wrap schema-type-select"><select value={binding.type} onChange={(event) => updateComfyBinding(selectedStep.id, index, { type: event.target.value as WorkflowVariableType })} aria-label="变量类型">{Object.entries(inputDirection ? variableTypeLabels : outputTypeLabels).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select><ChevronDown size={13} /></div>
                        <button className="icon-button schema-delete" onClick={() => removeComfyBinding(index)} title="删除绑定" aria-label={`删除${binding.label}绑定`}><Trash2 size={14} /></button>
                        {node && <small className="comfy-node-type">{node.type}{nodePropertiesLoaded ? ` · 已加载 ${propertyInfos.length} 个${inputDirection ? "输入" : "输出"}属性` : " · 点击加载属性"}{selectedPropertyInfo?.options?.length ? ` · 选项 ${selectedPropertyInfo.options.length} 个` : ""}</small>}
                      </div>;
                    })}
                    {!bindings.length && <div className="comfy-workflow-empty">还没有定义变量绑定</div>}
                  </section>;
                })}
              </div>}
            </div>}

            {(selectedStep.kind === "manual" || selectedStep.kind === "hermes") && <div className="designer-subsection">
               <div className="designer-subsection-heading"><div><h3>步骤输入</h3><p>{selectedStep.kind === "hermes" ? "把文本和结构化数据映射给 Hermes；媒体会作为附件发送，JSON 可填写字段路径" : "选择变量引用，或为当前步骤填写固定值"}</p></div><span>{selectedStep.inputs.length} 项映射</span></div>
              {selectedStep.inputs.map((input, index) => {
                const valueSource = input.valueSource ?? "reference";
                const referenceOptions = selectedStepReferenceOptions;
                const referenceType = referenceOption(input.sourceRef, referenceOptions)?.type;
                const literalType = input.literalType ?? referenceType ?? "text";
                return <div className="step-input-row" key={`step-input-${index}`}>
                  <div className="step-input-labels"><DeferredInput className="text-input" value={input.label} onCommit={(value) => setStepInput(index, "label", value)} aria-label="输入标签" placeholder="输入名称" /><DeferredInput className="text-input" value={input.key} onCommit={(value) => setStepInput(index, "key", value.replace(/[^a-zA-Z0-9_]/g, "_") )} aria-label="输入 key" placeholder="step_input" /></div>
                  <div className="step-input-source"><div className="select-wrap step-input-source-mode"><select value={valueSource} onChange={(event) => setStepInputSource(index, event.target.value as WorkflowValueSource)} aria-label="输入取值来源"><option value="reference">引用变量</option><option value="literal">固定值</option></select><ChevronDown size={13} /></div>{valueSource === "literal" ? <div className="step-input-literal"><div className="select-wrap step-input-literal-type"><select value={literalType} onChange={(event) => setStepInput(index, "literalType", event.target.value)} aria-label="固定值类型">{Object.entries(variableTypeLabels).map(([type, label]) => <option value={type} key={type}>{label}</option>)}</select><ChevronDown size={13} /></div><LiteralValueControl type={literalType} value={input.literalValue ?? ""} onChange={(literalValue) => setStepInput(index, "literalValue", literalValue)} ariaLabel="输入固定值" /></div> : <ReferenceSelect value={input.sourceRef} options={referenceOptions} onChange={(value) => setStepInput(index, "sourceRef", value)} allowJsonPath />}</div>
                  <button className="icon-button schema-delete" onClick={() => updateStep(selectedStep.id, (step) => ({ ...step, inputs: step.inputs.filter((_, itemIndex) => itemIndex !== index) }))} title="删除输入映射" aria-label={`删除${input.label}映射`}><Trash2 size={14} /></button>
                </div>;
              })}
              <button className="designer-add-field" onClick={() => updateStep(selectedStep.id, (step) => ({ ...step, inputs: [...step.inputs, { key: `input_${step.inputs.length + 1}`, label: "新输入", sourceRef: "" }] }))}><Plus size={14} />添加步骤输入</button>
            </div>}

            {selectedStep.kind !== "comfyui" && selectedStep.kind !== "control" && <div className="designer-subsection">
              <div className="designer-subsection-heading"><div><h3>步骤输出</h3><p>声明此步骤提供给后续步骤的结果</p></div><span>{selectedStep.outputs.length} 项结果</span></div>
              {selectedStep.outputs.map((output, index) => <div className="step-output-row" key={`step-output-${index}`}>
                <DeferredInput className="text-input" value={output.label} onCommit={(value) => setStepOutput(index, "label", value)} aria-label="输出标签" placeholder="输出名称" />
                <DeferredInput className="text-input output-key-input" value={output.key} onCommit={(value) => setStepOutput(index, "key", value.replace(/[^a-zA-Z0-9_]/g, "_") )} aria-label="输出 key" placeholder="output_key" />
                <div className="select-wrap schema-type-select"><select value={output.type} onChange={(event) => setStepOutput(index, "type", event.target.value)} aria-label="步骤输出类型">{Object.entries(outputTypeLabels).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select><ChevronDown size={13} /></div>
                <button className="icon-button schema-delete" onClick={() => updateStep(selectedStep.id, (step) => ({ ...step, outputs: step.outputs.filter((_, itemIndex) => itemIndex !== index) }))} title="删除步骤输出" aria-label={`删除${output.label}`}><Trash2 size={14} /></button>
                <DeferredInput className="text-input step-output-description" value={output.description ?? ""} onCommit={(value) => setStepOutput(index, "description", value)} aria-label="步骤输出字段描述" placeholder="字段描述：说明这里应该输出什么内容" />
              </div>)}
              <button className="designer-add-field" onClick={() => updateStep(selectedStep.id, (step) => ({ ...step, outputs: [...step.outputs, { key: `output_${step.outputs.length + 1}`, label: "新输出", type: "text" }] }))}><Plus size={14} />添加步骤输出</button>
            </div>}

            {selectedStep.kind === "hermes" && <div className="designer-subsection prompt-subsection">
              <div className="designer-subsection-heading"><div><h3>提示词模板</h3><p>使用上方步骤输入，也可直接插入场景变量引用</p></div><span><Braces size={13} />变量引用</span></div>
              <div className={`prompt-reference-tools ${promptReferenceType === "json" ? "has-json-path" : ""}`}><div className="select-wrap"><select value={referenceToInsert} onChange={(event) => { setReferenceToInsert(event.target.value); setReferencePathToInsert(""); }} aria-label="选择要插入的引用"><option value="">选择输入或前序输出</option>{selectedStepPromptOptions.map((option) => <option key={option.value} value={option.value}>{option.label}（{option.value}）</option>)}</select><ChevronDown size={14} /></div>{promptReferenceType === "json" && <><input className="text-input json-path-input" value={referencePathToInsert} onChange={(event) => setReferencePathToInsert(event.target.value)} placeholder="字段路径，如 [0].prompt" title="数组可写 [0].prompt；对象数组可写 shots[0].prompt" aria-label="插入引用的 JSON 字段路径" aria-invalid={Boolean(referencePathToInsert.trim() && promptReferencePathError)} />{referencePathToInsert.trim() && promptReferencePathError && <small className="json-path-error">{promptReferencePathError}</small>}</>}<button type="button" className="button button-outline" onClick={insertReference} disabled={!referenceToInsert || Boolean(promptReferencePathError)}>插入引用</button></div>
              <DeferredTextarea ref={promptRef} className="text-input prompt-textarea" value={selectedStep.promptTemplate} onCommit={(value) => updateStep(selectedStep.id, (step) => ({ ...step, promptTemplate: value }))} placeholder="编写此步骤交给 Hermes 的任务描述……" />
            </div>}
          </section>}

           <div className={`designer-validation ${validation.length ? "has-errors" : ""}`}><span className="validation-mark">{validation.length ? "!" : <Check size={12} />}</span><span>{validation.length ? validation[0] : "输入配置完整"}</span><span>{validation.length ? `${validation.length} 个待处理` : "暂存已保存"}</span></div>
        </main>
      </div>
      {showVersions && <SceneVersionsDialog sceneTitle={scene.title} record={versionRecord} onClose={() => setShowVersions(false)} onApply={onApplyVersion} />}
    </div>
  );
}
