import {
  ArrowDown,
  ArrowDownUp,
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
  GitCompareArrows,
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
import { clearConfirmedStaleComfyBindings } from "../lib/comfyBindingValidation";
import type {
  ComfyUIBinding,
  ComfyUINodeInfo,
  ComfyUIPropertyInfo,
  ComfyUIWorkflowDetail,
  ComfyUIWorkflowNode,
  ComfyUIWorkflowSummary,
  HermesProfile,
  JsonValue,
  SceneId,
  SceneModule,
  SceneVersion,
  SceneVersionRecord,
  WorkflowDefinition,
  WorkflowConditionOperator,
  WorkflowConditionRule,
  WorkflowControlConfig,
  WorkflowStartCondition,
  WorkflowFieldType,
  WorkflowInputField,
  WorkflowObjectArrayItemField,
  WorkflowOptionPreset,
  WorkflowOutputField,
  WorkflowStepDefinition,
  WorkflowStepKind,
  WorkflowStepOutput,
  WorkflowValueSource,
  WorkflowVariableType,
  WorkflowMediaSelection,
  WorkflowMediaRole,
} from "../types";
import { workflowMediaRoleOptions, workflowMediaRoleLabels, validWorkflowMediaRole } from "../../server/domain/workflowMediaRoles.js";
import SceneVersionsDialog from "./SceneVersionsDialog";
import SceneDiffDialog from "../components/SceneDiffDialog";
import StepCapabilityPicker from "../components/StepCapabilityPicker";
import CapabilityConfigEditor from "../components/CapabilityConfigEditor";
import { useCapabilities } from "../hooks/useCapabilities";
import { applyCapabilityToStep, capabilityForStep, capabilityConfigErrors, type CapabilityDefinition } from "../lib/capabilities";
import { builtinCapabilities } from "../../server/capabilities/definitions.js";
import { publishedSceneVersion, sceneDraftMatchesVersion, sceneVersionHash } from "../lib/sceneVersions";
import { canonicalWorkflowMediaType, canonicalWorkflowType } from "../lib/workflowMigration";
import { isEmptyWorkflowInput } from "../../server/domain/inputValidation.js";

interface FlowDesignerProps {
  sceneId: SceneId;
  scenes: SceneModule[];
  scene: SceneModule;
  workflow: WorkflowDefinition;
  optionPresets: WorkflowOptionPreset[];
  versionRecord?: SceneVersionRecord;
  onSceneChange: (sceneId: SceneId) => void;
  onSortScenes: () => void;
  onChange: (workflow: WorkflowDefinition) => void;
  onOptionPresetsChange: (optionPresets: WorkflowOptionPreset[]) => void;
  saveStatus?: "saving" | "saved" | "failed";
  onPublish: () => Promise<SceneVersion | undefined>;
  onApplyVersion: (version: SceneVersion) => void;
  onOpenConnections: () => void;
}

type Selection = { kind: "inputs" } | { kind: "step"; stepId: string } | { kind: "outputs" };
type ReferenceOption = { value: string; label: string; type?: WorkflowVariableType; isArray?: boolean; isCollection?: boolean };

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

const fieldTypeOptions: Array<[WorkflowFieldType, string]> = [
  ["text", "单行文本"],
  ["textarea", "多行文本"],
  ["number", "数字"],
  ["boolean", "布尔值"],
  ["select", "选项"],
  ["image_list", "图片列表"],
  ["video_list", "视频列表"],
  ["audio_list", "音频列表"],
  ["json", "结构化数据"],
];

const objectArrayItemTypeOptions: Array<[WorkflowObjectArrayItemField["type"], string]> = [
  ["text", "单行文本"], ["number", "数字"], ["select", "下拉选项"], ["boolean", "是/否"],
];

const outputTypeOptions: Array<[WorkflowStepOutput["type"], string]> = [
  ["text", "文本"],
  ["number", "数字"],
  ["boolean", "布尔值"],
  ["image_list", "图片列表"],
  ["video_list", "视频列表"],
  ["audio_list", "音频列表"],
  ["json", "结构化数据"],
];

const stepKindLabels: Record<WorkflowStepKind, string> = {
  hermes: "Hermes Agent",
  comfyui: "ComfyUI",
  manual: "人工处理",
  control: "控制节点",
  capability: "能力包",
};

const MAX_STEP_CONCURRENCY = 32;

const variableTypeLabels: Record<WorkflowVariableType, string> = {
  text: "文本",
  number: "数字",
  boolean: "布尔值",
  image: "图片列表",
  image_list: "图片列表",
  video: "视频列表",
  video_list: "视频列表",
  audio: "音频列表",
  audio_list: "音频列表",
  json: "结构化数据",
};

const variableTypeOptions: Array<[WorkflowVariableType, string]> = [
  ["text", "文本"],
  ["number", "数字"],
  ["boolean", "布尔值"],
  ["image_list", "图片列表"],
  ["video_list", "视频列表"],
  ["audio_list", "音频列表"],
  ["json", "结构化数据"],
];

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
  const canonical = canonicalWorkflowType(type) ?? type;
  return canonical === "textarea" || canonical === "select" ? "text" : canonical as WorkflowVariableType;
}

function isMediaVariableType(type?: WorkflowVariableType) {
  return Boolean(canonicalWorkflowMediaType(type));
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

function defaultStartCondition(): WorkflowStartCondition {
  return { match: "all", rules: [newConditionRule(1)] };
}

function inputReferenceOptions(workflow: WorkflowDefinition): ReferenceOption[] {
  return workflow.inputs.map((field) => ({
    value: `input.${field.key}`,
    label: `场景输入 · ${field.label}`,
    type: inputValueType(field.type),
    isArray: isMediaVariableType(inputValueType(field.type)) || field.type === "json",
    isCollection: isMediaVariableType(inputValueType(field.type)),
  }));
}

function outputReferenceOptions(workflow: WorkflowDefinition, maxStepIndex = workflow.steps.length): ReferenceOption[] {
  return workflow.steps.slice(0, maxStepIndex).flatMap((step) =>
    step.outputs.map((field) => ({
      value: `step.${step.id}.outputs.${field.key}`,
      label: `${step.name} · ${field.label}`,
      type: inputValueType(field.type),
      isArray: isMediaVariableType(field.type) || field.type === "json" || step.execution?.mode === "for_each",
      isCollection: isMediaVariableType(field.type) || step.execution?.mode === "for_each",
    })),
  );
}

function allReferenceOptions(workflow: WorkflowDefinition): ReferenceOption[] {
  return [...inputReferenceOptions(workflow), ...outputReferenceOptions(workflow)];
}

function splitReferencePath(value: string) {
  const match = /^(iteration\.(?:item|previous|hasPrevious|index)|input\.[a-zA-Z0-9_]+|step\.[a-zA-Z0-9_-]+\.outputs\.[a-zA-Z0-9_]+)([\s\S]*)$/.exec(value);
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

function referenceTypeLabel(option: ReferenceOption) {
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

function isMediaArrayReference(option: ReferenceOption | undefined) {
  return Boolean(option?.isArray && isMediaVariableType(option.type));
}

function referencePathError(value: string, options: ReferenceOption[], allowJsonPath: boolean, allowMediaIndex = false) {
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

function isWorkflowArrayReference(workflow: WorkflowDefinition, reference: ReferenceOption) {
  if (isMediaVariableType(reference.type) || reference.type === "json") return true;
  const outputMatch = /^step\.([^.]+)\.outputs\.[^.]+$/.exec(reference.value);
  return outputMatch
    ? workflow.steps.find((step) => step.id === outputMatch[1])?.execution?.mode === "for_each"
    : false;
}

function iterationItemReferenceOption(workflow: WorkflowDefinition, sourceRef: string, sourceOptions: ReferenceOption[]): ReferenceOption | undefined {
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
    { value: "iteration.hasPrevious", label: "是否有上一项/初始状态", type: "boolean" },
    { value: "iteration.index", label: "当前项序号（从0开始）", type: "number" },
  ];
}

function ReferenceSelect({ value, options, onChange, onReferenceChange, selection, onSelectionChange, allowJsonPath = false, allowMediaIndex = false }: {
  value: string;
  options: ReferenceOption[];
  onChange: (value: string) => void;
  onReferenceChange?: (value: string, selection?: WorkflowMediaSelection) => void;
  selection?: WorkflowMediaSelection;
  onSelectionChange?: (selection: WorkflowMediaSelection | undefined) => void;
  allowJsonPath?: boolean;
  allowMediaIndex?: boolean;
}) {
  const parsed = splitReferencePath(value);
  const root = parsed?.root ?? value;
  const path = parsed?.path ?? "";
  const selected = options.find((option) => option.value === root);
  const mediaIndexEnabled = allowMediaIndex && isMediaArrayReference(selected);
  const pathEnabled = allowJsonPath && (selected?.type === "json" || mediaIndexEnabled);
  const legacyMediaIndex = /^\[(\d+)\]$/.exec(path)?.[1] ?? "";
  const mediaIndex = selection?.mode === "item" ? String(selection.index) : legacyMediaIndex;
  const mediaMode = selection?.mode === "item" || Boolean(legacyMediaIndex) ? "item" : "all";
  function commitReference(nextRoot: string, nextSelection?: WorkflowMediaSelection) {
    if (onReferenceChange) {
      onReferenceChange(nextRoot, nextSelection);
      return;
    }
    onChange(nextRoot);
    onSelectionChange?.(nextSelection);
  }
  function changeRoot(nextRoot: string) {
    const nextOption = options.find((option) => option.value === nextRoot);
    commitReference(nextRoot, isMediaArrayReference(nextOption) ? { mode: "all" } : undefined);
  }
  return <div className="ref-select">
    <div className="select-wrap ref-select-choice"><select value={selected ? root : value} onChange={(event) => changeRoot(event.target.value)}>
      {!selected && value && <option value={value}>失效引用：{value}</option>}
      <option value="">选择一个输入或上游输出</option>
      {options.map((option) => <option value={option.value} key={option.value}>{option.label}{option.type ? ` · ${referenceTypeLabel(option)}` : ""}（{option.value}）</option>)}
    </select><ChevronDown size={14} /></div>
    {pathEnabled && (mediaIndexEnabled
      ? <div className="media-reference-path">
        <div className="select-wrap"><select value={mediaMode} onChange={(event) => {
          if (event.target.value === "item") {
            commitReference(root, { mode: "item", index: Number(mediaIndex) || 0 });
          } else {
            commitReference(root, { mode: "all" });
          }
        }} aria-label="媒体引用方式"><option value="all">整组媒体</option><option value="item">选择单项</option></select><ChevronDown size={13} /></div>
        {mediaMode === "item" && <DeferredInput className="text-input json-path-input" type="number" min="0" step="1" value={mediaIndex} onCommit={(nextIndex) => {
          if (!/^\d+$/.test(nextIndex.trim())) return;
          const index = Number(nextIndex.trim());
          commitReference(root, { mode: "item", index });
        }} placeholder="序号，从 0 开始" title="输入数组中的媒体序号" aria-label="媒体数组序号" aria-invalid={!/^\d+$/.test(mediaIndex)} />}
      </div>
      : <DeferredInput className="text-input json-path-input" value={path} onCommit={(nextPath) => onChange(referenceWithJsonPath(root, nextPath))} placeholder="字段路径，如 [0].prompt" title="数组可写 [0].prompt；对象数组可写 shots[0].prompt" aria-label="结构化数据字段路径" />)}
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
  if (type === "json" || canonicalWorkflowMediaType(type)) {
    return <DeferredTextarea className="text-input literal-value-control literal-value-textarea" value={value} onCommit={onChange} placeholder={canonicalWorkflowMediaType(type) ? "输入 JSON 数组" : "输入有效 JSON"} aria-label={ariaLabel} />;
  }
  return <DeferredInput className="text-input literal-value-control" type={type === "number" ? "number" : "text"} step={type === "number" ? "any" : undefined} value={value} onCommit={onChange} placeholder={type === "number" ? "输入数字" : "填写固定值"} aria-label={ariaLabel} />;
}

function WorkflowInputJsonDefault({ field, onChange }: { field: WorkflowInputField; onChange: (value: JsonValue | undefined) => void }) {
  const serialized = field.defaultValue === undefined ? "" : JSON.stringify(field.defaultValue, null, 2);
  const [draft, setDraft] = useState(serialized);
  const [error, setError] = useState("");
  const mediaList = Boolean(canonicalWorkflowMediaType(field.type));

  useEffect(() => {
    setDraft(serialized);
    setError("");
  }, [serialized]);

  function commit() {
    if (!draft.trim()) {
      onChange(undefined);
      setError("");
      return;
    }
    try {
      const parsed = JSON.parse(draft) as unknown;
      if (mediaList && !Array.isArray(parsed)) {
        setError("媒体列表默认值需要是 JSON 数组");
        return;
      }
      if (field.type === "json" && (!parsed || typeof parsed !== "object")) {
        setError("结构化数据默认值需要是 JSON 对象或数组");
        return;
      }
      onChange(parsed as JsonValue);
      setError("");
    } catch {
      setError("默认值 JSON 格式无效");
    }
  }

  return <div className={`schema-default-json${error ? " invalid" : ""}`}>
    <textarea id={`input-default-${field.key}`} className="text-input schema-default-textarea" value={draft} onChange={(event) => setDraft(event.target.value)} onBlur={commit} placeholder={mediaList ? "输入媒体引用 JSON 数组" : "输入 JSON 对象或数组"} aria-label={`${field.label}默认值`} aria-invalid={Boolean(error)} />
    <small className={error ? "schema-default-error" : "schema-default-help"}>{error || (mediaList ? "JSON 数组；媒体引用须是可访问的固定素材" : "JSON 对象或数组；留空表示不设置")}</small>
  </div>;
}

function WorkflowInputDefaultEditor({ field, onChange }: { field: WorkflowInputField; onChange: (value: JsonValue | undefined) => void }) {
  const id = `input-default-${field.key}`;
  const value = field.defaultValue;
  const displayValue = value === undefined ? "" : typeof value === "string" ? value : String(value);
  const mediaList = Boolean(canonicalWorkflowMediaType(field.type));

  if (field.type === "boolean") {
    return <div className="select-wrap schema-default-select"><select id={id} value={value === true ? "true" : value === false ? "false" : ""} onChange={(event) => onChange(event.target.value === "" ? undefined : event.target.value === "true")} aria-label={`${field.label}默认值`}><option value="">不设置</option><option value="true">是</option><option value="false">否</option></select><ChevronDown size={13} /></div>;
  }
  if (field.type === "select") {
    const selected = typeof value === "string" ? value : "";
    const known = (field.options ?? []).includes(selected);
    return <div className="select-wrap schema-default-select"><select id={id} value={selected} onChange={(event) => onChange(event.target.value === "" ? undefined : event.target.value)} aria-label={`${field.label}默认值`}><option value="">不设置</option>{selected && !known && <option value={selected}>当前默认值（已不在选项中）</option>}{(field.options ?? []).map((option) => <option value={option} key={option}>{option}</option>)}</select><ChevronDown size={13} /></div>;
  }
  if (field.type === "json" || mediaList) return <WorkflowInputJsonDefault field={field} onChange={onChange} />;
  if (field.type === "textarea") {
    return <DeferredTextarea id={id} className="text-input schema-default-textarea" value={displayValue} onCommit={(next) => onChange(next === "" ? undefined : next)} placeholder="填写默认文本" aria-label={`${field.label}默认值`} />;
  }
  if (field.type === "number") {
    return <DeferredInput id={id} className="text-input schema-default-input" type="number" step="any" min={field.minimum} max={field.maximum} value={displayValue} onCommit={(next) => {
      if (!next.trim()) onChange(undefined);
      else if (Number.isFinite(Number(next))) onChange(Number(next));
    }} placeholder="不设置" aria-label={`${field.label}默认值`} />;
  }
  return <DeferredInput id={id} className="text-input schema-default-input" value={displayValue} onCommit={(next) => onChange(next === "" ? undefined : next)} placeholder="填写默认文本" aria-label={`${field.label}默认值`} />;
}

function literalValueError(type: WorkflowVariableType, value: string) {
  if (type === "number") return value.trim() && Number.isFinite(Number(value)) ? "" : "固定值需要填写有效数字";
  if (type === "boolean") return value === "true" || value === "false" ? "" : "固定值需要选择真或假";
  if (type === "json" || canonicalWorkflowMediaType(type)) {
    if (!value.trim()) return "固定值需要填写有效 JSON";
    try {
      const parsed = JSON.parse(value) as unknown;
      if (canonicalWorkflowMediaType(type) && !Array.isArray(parsed)) return "媒体列表固定值需要是 JSON 数组";
    } catch {
      return "固定值 JSON 格式无效";
    }
  }
  return "";
}

function MediaRoleSelect({ type, value, onChange, label }: { type: string; value?: WorkflowMediaRole; onChange: (role: WorkflowMediaRole | undefined) => void; label: string }) {
  const options = workflowMediaRoleOptions(type);
  if (!options.length) return null;
  const genericLabel = canonicalWorkflowMediaType(type) === "image_list" ? "参考图片" : canonicalWorkflowMediaType(type) === "audio_list" ? "参考声音" : "参考视频";
  return <div className="select-wrap media-role-select"><select value={value ?? "reference"} onChange={event => onChange(event.target.value === "reference" ? undefined : event.target.value as WorkflowMediaRole)} aria-label={label} title="素材用途与媒体类型分开配置；参考音色不是驱动音轨">{options.map(role => <option value={role} key={role}>{role === "reference" ? genericLabel : workflowMediaRoleLabels[role]}</option>)}</select><ChevronDown size={13} /></div>;
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
      ...(input.selection ? { selection: input.selection } : {}),
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
function stepWithComfyBindings(step: WorkflowStepDefinition, bindings: ComfyUIBinding[], catalog: readonly CapabilityDefinition[] = builtinCapabilities): WorkflowStepDefinition {
  const boundOutputs = bindings.filter((binding) => binding.direction === "output").map((binding) => ({
    key: binding.key,
    label: binding.label,
    type: bindingOutputType(binding.type),
  }));
  const capability = capabilityForStep(step, catalog);
  const adapterKeys = capability?.editor.outputs === "ports" ? step.outputs.map((output) => output.key) : capability?.outputs.map((output) => output.key) ?? [];
  const adapterOutputs = step.outputs.filter((output) => adapterKeys.includes(output.key) && !boundOutputs.some((binding) => binding.key === output.key));
  return {
    ...step,
    comfyui: { ...step.comfyui, workflowFile: step.comfyui?.workflowFile ?? "", bindings },
    // Adapter contracts are separate from the underlying model-node bindings.
    inputs: capability?.editor.inputs === "ports" ? step.inputs : bindings.filter((binding) => binding.direction === "input").map((binding) => ({
      key: binding.key,
      label: binding.label,
      sourceRef: binding.sourceRef ?? "",
      ...(binding.selection ? { selection: binding.selection } : {}),
      ...(binding.valueSource ? { valueSource: binding.valueSource } : {}),
      ...(binding.literalValue !== undefined ? { literalValue: binding.literalValue } : {}),
      ...(binding.valueSource === "literal" ? { literalType: binding.type } : {}),
    })),
    outputs: [...boundOutputs, ...adapterOutputs],
  };
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
): { workflow: WorkflowDefinition; binding: ComfyUIBinding } {
  const previousOutput = bindingValueSource(previous) === "reference" ? comfySourceOutput(previous.sourceRef ?? "") : undefined;
  const nextOutput = bindingValueSource(next) === "reference" ? comfySourceOutput(next.sourceRef ?? "") : undefined;
  const sameOutput = Boolean(previousOutput && nextOutput && previousOutput.stepId === nextOutput.stepId && previousOutput.outputKey === nextOutput.outputKey);
  let updatedWorkflow = workflow;

  if (previousOutput && (!sameOutput || !property)) {
    updatedWorkflow = restoreComfySourceOutput(updatedWorkflow, previous.sourceRef ?? "", previous.sourceOutputFormat);
  }
  if (!property || !nextOutput) {
    return { workflow: updatedWorkflow, binding: { ...next, sourceInputFormat: undefined, sourceOutputFormat: undefined } };
  }

  const output = updatedWorkflow.steps.find((step) => step.id === nextOutput.stepId)?.outputs.find((item) => item.key === nextOutput.outputKey);
  if (!output) return { workflow: updatedWorkflow, binding: { ...next, sourceInputFormat: undefined, sourceOutputFormat: undefined } };
  const sourceOutputFormat = sameOutput && previous.sourceOutputFormat
    ? previous.sourceOutputFormat
    : { stepId: nextOutput.stepId, outputKey: nextOutput.outputKey, type: output.type };
  updatedWorkflow = {
    ...updatedWorkflow,
    steps: updatedWorkflow.steps.map((step) => step.id !== nextOutput.stepId ? step : {
      ...step,
      outputs: step.outputs.map((item) => item.key === nextOutput.outputKey ? { ...item, type: property.type } : item),
    }),
  };
  return { workflow: updatedWorkflow, binding: { ...next, sourceInputFormat: undefined, sourceOutputFormat } };
}

export default function FlowDesigner({ saveStatus = "saved", sceneId, scenes, scene, workflow, optionPresets, versionRecord, onSceneChange, onSortScenes, onChange, onOptionPresetsChange, onPublish, onApplyVersion, onOpenConnections }: FlowDesignerProps) {
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
  const { capabilities, error: capabilityError } = useCapabilities();
  const [showVersions, setShowVersions] = useState(false);
  const [showDiff, setShowDiff] = useState(false);
  const promptRef = useRef<HTMLTextAreaElement>(null);
  const [referenceToInsert, setReferenceToInsert] = useState("");
  const [referencePathToInsert, setReferencePathToInsert] = useState("");
  const workflowRef = useRef(workflow);
  workflowRef.current = workflow;

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
  const selectedCapability = selectedStep ? capabilityForStep(selectedStep, capabilities) : undefined;
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
    ? [...priorReferenceOptions, selectedIterationItemOption, ...carryReferenceOptions(selectedStep!)]
    : priorReferenceOptions;
  const selectedStepPromptOptions = selectedIterationItemOption
    ? [...promptSourceOptions, selectedIterationItemOption, ...carryReferenceOptions(selectedStep!)]
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
    if (!selectedStep || selectedStep.kind !== "comfyui" || !selectedStep.comfyui?.workflowFile || !selectedCapability?.editor.bindings) {
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
      .then(async (detail) => {
        if (!active) return;
        setComfyNodes(detail.nodes);
        setComfyFormat(detail.format);
        setComfyConverted(Boolean(detail.converted));
        const initialWorkflow = workflowRef.current;
        const initialStep = initialWorkflow.steps.find((step) => step.id === selectedStep.id);
        if (!initialStep || initialStep.kind !== "comfyui" || initialStep.comfyui?.workflowFile !== selectedStep.comfyui?.workflowFile) return;

        const initialBindings = comfyBindings(initialStep);
        const nodeInfos: Record<string, ComfyUINodeInfo> = { ...comfyNodeInfos };
        const nodeTypesToInspect = new Set<string>();
        for (const binding of initialBindings) {
          const nodeId = binding.nodeId.trim();
          const property = binding.property.trim();
          if (!nodeId || !property) continue;
          const node = detail.nodes.find((candidate) => candidate.id === nodeId);
          if (!node || nodeInfos[node.type]) continue;
          const summaryProperties = binding.direction === "input" ? node.inputProperties : node.outputProperties;
          if (binding.direction === "input" && !summaryProperties.includes(property)) nodeTypesToInspect.add(node.type);
        }
        const schemaReadFailures: string[] = [];
        await Promise.all([...nodeTypesToInspect].map(async (nodeType) => {
          try {
            const info = await loadComfyUINodeInfo(nodeType);
            nodeInfos[nodeType] = info;
            setComfyNodeInfos((current) => ({ ...current, [nodeType]: info }));
          } catch {
            // An unavailable schema is inconclusive; keep the user's binding.
            schemaReadFailures.push(nodeType);
          }
        }));
        if (!active) return;

        const currentWorkflow = workflowRef.current;
        const currentStep = currentWorkflow.steps.find((step) => step.id === selectedStep.id);
        if (!currentStep || currentStep.kind !== "comfyui" || currentStep.comfyui?.workflowFile !== selectedStep.comfyui?.workflowFile) return;
        const bindings = comfyBindings(currentStep);
        const nextBindings = clearConfirmedStaleComfyBindings(bindings, detail.nodes, nodeInfos, detail.format);
        if (nextBindings !== bindings) {
          onChange({
            ...currentWorkflow,
            steps: currentWorkflow.steps.map((step) => step.id === currentStep.id ? stepWithComfyBindings(step, nextBindings, capabilities) : step),
          });
          setComfyNodeError("已根据 ComfyUI 节点类型定义确认并清空失效绑定，请重新选择节点和属性。");
        } else if (schemaReadFailures.length) {
          setComfyNodeError("无法读取部分 ComfyUI 节点定义，现有绑定已保留，未自动清空。");
        }
      })
      .catch((error: unknown) => { if (active) setComfyError(error instanceof Error ? error.message : "无法读取工作流节点"); })
      .finally(() => { if (active) setComfyLoading(false); });
    return () => { active = false; };
  }, [selectedStep?.id, selectedStep?.kind, selectedStep?.comfyui?.workflowFile, selectedStep?.comfyui?.adapter, selectedCapability?.editor.bindings]);

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

  function setStepInputReference(index: number, sourceRef: string, selection?: WorkflowMediaSelection) {
    if (!selectedStep) return;
    updateStep(selectedStep.id, (step) => ({
      ...step,
      inputs: step.inputs.map((input, itemIndex) => itemIndex === index ? { ...input, sourceRef, selection } : input),
    }));
  }

  function setStepInputSource(index: number, valueSource: WorkflowValueSource) {
    if (!selectedStep) return;
    updateStep(selectedStep.id, (step) => ({
      ...step,
      inputs: step.inputs.map((input, itemIndex) => itemIndex !== index ? input : {
        ...input,
        valueSource,
        ...(valueSource === "literal" ? { sourceRef: "", literalType: input.literalType ?? "text", literalValue: input.literalValue ?? "" } : { sourceRef: input.sourceRef ?? "" }),
        ...(valueSource === "literal" ? { selection: undefined } : {}),
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
      inputs: workflow.inputs.map((field, fieldIndex) => {
        if (fieldIndex !== index) return field;
        const next = { ...field, ...changes };
        if (("defaultValue" in changes && changes.defaultValue === undefined) || ("type" in changes && changes.type !== field.type)) delete next.defaultValue;
        if ("type" in changes && changes.type !== "number") { delete next.minimum; delete next.maximum; }
        return validWorkflowMediaRole(next.mediaRole, next.type) ? next : { ...next, mediaRole: undefined };
      }),
    });
  }

  function moveInputField(index: number, direction: -1 | 1) {
    const target = index + direction;
    if (target < 0 || target >= workflow.inputs.length) return;
    const inputs = [...workflow.inputs];
    [inputs[index], inputs[target]] = [inputs[target], inputs[index]];
    update({ ...workflow, inputs });
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
      steps: workflow.steps.map((step) => step.id === stepId ? stepWithComfyBindings(step, bindings, capabilities) : step),
    });
  }

  function updateComfyBinding(stepId: string, index: number, changes: Partial<ComfyUIBinding>) {
    if (!selectedStep) return;
    const bindings = comfyBindings(selectedStep);
    updateComfyBindings(stepId, bindings.map((binding, itemIndex) => {
      if (itemIndex !== index) return binding;
      const next = { ...binding, ...changes };
      return validWorkflowMediaRole(next.mediaRole, next.type, next.direction) ? next : { ...next, mediaRole: undefined };
    }));
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
      const result = syncComfySourceFormat(workflow, binding, updated);
      nextWorkflow = result.workflow;
      updated = result.binding;
    }
    const nextBindings = bindings.map((item, itemIndex) => itemIndex === index ? updated : item);
    update({
      ...nextWorkflow,
      steps: nextWorkflow.steps.map((step) => step.id === selectedStep.id ? stepWithComfyBindings(step, nextBindings, capabilities) : step),
    });
  }

  function removeComfyBinding(index: number) {
    if (!selectedStep || selectedStep.kind !== "comfyui") return;
    const bindings = comfyBindings(selectedStep);
    const binding = bindings[index];
    if (!binding) return;
    const nextBindings = bindings.filter((_, itemIndex) => itemIndex !== index);
    update({
      ...workflow,
      steps: workflow.steps.map((step) => step.id === selectedStep.id ? stepWithComfyBindings(step, nextBindings, capabilities) : step),
    });
  }

  function propertyInfoForBinding(binding: ComfyUIBinding): ComfyUIPropertyInfo | undefined {
    const node = comfyNodes.find((item) => item.id === binding.nodeId.trim());
    const nodeInfo = node ? comfyNodeInfos[node.type] : undefined;
    if (!nodeInfo) return undefined;
    const properties = binding.direction === "input" ? nodeInfo.inputs : nodeInfo.outputs;
    return properties.find((property) => property.name === binding.property);
  }

  function updateComfyBindingSource(index: number, sourceRef: string, selection?: WorkflowMediaSelection) {
    if (!selectedStep || selectedStep.kind !== "comfyui") return;
    const bindings = comfyBindings(selectedStep);
    const binding = bindings[index];
    if (!binding) return;
    const propertyInfo = propertyInfoForBinding(binding);
    const sourceField = workflow.inputs.find(field => sourceRef === `input.${field.key}`);
    const mediaRole = sourceField?.mediaRole ?? binding.mediaRole;
    const result = syncComfySourceFormat(workflow, binding, { ...binding, valueSource: "reference", sourceRef, literalValue: undefined, selection, ...(validWorkflowMediaRole(mediaRole, binding.type) ? { mediaRole } : { mediaRole: undefined }) }, propertyInfo);
    const nextBindings = bindings.map((item, itemIndex) => itemIndex === index ? result.binding : item);
    update({
      ...result.workflow,
      steps: result.workflow.steps.map((step) => step.id === selectedStep.id ? stepWithComfyBindings(step, nextBindings, capabilities) : step),
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
    const bindingType = selectedCapability?.editor.bindingTypes?.find((rule) => rule.direction === binding.direction && rule.nodeType === node?.type && rule.property === propertyName)?.type;
    const isLoadAudioSelector = binding.direction === "input" && node?.type === "LoadAudio" && propertyName === "audio";
    let updated: ComfyUIBinding = propertyInfo
      ? { ...binding, property: propertyName, type: bindingType ?? propertyInfo.type, options: isLoadAudioSelector ? undefined : propertyInfo.options, required: propertyInfo.required }
      : { ...binding, property: propertyName, options: undefined, required: undefined };
    if (!validWorkflowMediaRole(updated.mediaRole, updated.type, updated.direction)) updated = { ...updated, mediaRole: undefined };
    let nextWorkflow = workflow;
    if (binding.direction === "input") {
      const result = syncComfySourceFormat(workflow, binding, updated, propertyInfo);
      nextWorkflow = result.workflow;
      updated = result.binding;
    }
    const nextBindings = bindings.map((item, itemIndex) => itemIndex === index ? updated : item);
    update({
      ...nextWorkflow,
      steps: nextWorkflow.steps.map((step) => step.id === selectedStep.id ? stepWithComfyBindings(step, nextBindings, capabilities) : step),
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
    const currentStep = workflow.steps.find((step) => step.id === stepId);
    if (!currentStep || currentStep.kind !== "comfyui") return;
    if (currentStep.comfyui?.workflowFile === workflowFile) return;

    // Node ids and widget names are local to a workflow. Keeping the old
    // bindings after a workflow switch makes a perfectly valid workflow fail
    // at runtime with errors such as "196.String not found". Preserve the
    // variable contracts/source references so the user only has to remap the
    // ComfyUI node and property for the new workflow.
    let nextWorkflow = workflow;
    const nextBindings = comfyBindings(currentStep).map((binding) => {
      if (binding.direction === "input" && binding.sourceOutputFormat) {
        nextWorkflow = restoreComfySourceOutput(nextWorkflow, binding.sourceRef ?? "", binding.sourceOutputFormat);
      }
      return {
        ...binding,
        nodeId: "",
        property: "",
        options: undefined,
        required: undefined,
        sourceInputFormat: undefined,
        sourceOutputFormat: undefined,
      };
    });
    update({
      ...nextWorkflow,
      steps: nextWorkflow.steps.map((step) => step.id !== stepId ? step : stepWithComfyBindings({
        ...step,
        comfyui: { ...step.comfyui, workflowFile, bindings: nextBindings },
      }, nextBindings, capabilities)),
    });
    setComfyNodeError("已切换工作流，旧节点绑定已清空，请重新选择节点和属性。");
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

  function changeStepCapability(stepId: string, capabilityId: string) {
    const definition = capabilities.find((item) => item.id === capabilityId);
    if (!definition) return;
    updateStep(stepId, (step) => {
      const next = applyCapabilityToStep(step, definition);
      if (definition.editor.condition) next.control = step.control ?? defaultControlConfig();
      if (definition.editor.profile) {
        next.hermesProfile = step.hermesProfile ?? enabledProfiles[0] ?? profiles[0]?.id ?? "";
        if (step.kind === "control" || !next.outputs.length) next.outputs = defaultHermesOutputs();
      }
      return next;
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

  function updateStartCondition(stepId: string, mutate: (condition: WorkflowStartCondition) => WorkflowStartCondition) {
    updateStep(stepId, (step) => ({ ...step, startCondition: mutate(step.startCondition ?? defaultStartCondition()) }));
  }

  function updateStartConditionRule(index: number, changes: Partial<WorkflowConditionRule>) {
    if (!selectedStep) return;
    updateStartCondition(selectedStep.id, (condition) => ({
      ...condition,
      rules: condition.rules.map((rule, ruleIndex) => ruleIndex === index ? { ...rule, ...changes } : rule),
    }));
  }

  function clearStartCondition(stepId: string) {
    updateStep(stepId, (step) => { const next = { ...step }; delete next.startCondition; return next; });
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
    if (workflow.inputs.some(field => field.type === "number" && field.minimum !== undefined && field.maximum !== undefined && field.minimum > field.maximum)) messages.push("数字输入的最小值不能大于最大值");
    if (workflow.inputs.some(field => field.hidden && field.required && isEmptyWorkflowInput(field, field.defaultValue))) messages.push("隐藏的必填字段需要配置非空默认值");
    workflow.inputs.forEach(field => {
      if (field.inputMode !== "object_array") return;
      const itemFields = field.itemFields ?? [];
      if (!itemFields.length) messages.push(`${field.label}对象数组至少需要一个行字段`);
      const keys = itemFields.map(item => item.key.trim());
      if (keys.some(key => !key) || new Set(keys).size !== keys.length) messages.push(`${field.label}的行字段 key 需要填写且不能重复`);
      if (itemFields.some(item => !item.label.trim())) messages.push(`${field.label}的行字段名称不能为空`);
      if (itemFields.some(item => item.type === "select" && !item.options?.length)) messages.push(`${field.label}的下拉行字段至少需要一个选项`);
      if (itemFields.some(item => item.type === "number" && item.minimum !== undefined && item.maximum !== undefined && item.minimum > item.maximum)) messages.push(`${field.label}的数字行字段最小值不能大于最大值`);
    });
    workflow.steps.forEach((step, index) => {
      const priorOptions = allReferenceOptions({ ...workflow, steps: workflow.steps.slice(0, index) });
      const iterationOption = step.execution?.mode === "for_each"
        ? iterationItemReferenceOption(workflow, step.execution.sourceRef ?? "", priorOptions)
        : undefined;
      const stepOptions = iterationOption ? [...priorOptions, iterationOption, ...carryReferenceOptions(step)] : priorOptions;
      const prior = new Set(stepOptions.map((option) => option.value));
      if (step.execution?.mode === "for_each") {
        const source = referenceOption(step.execution.sourceRef ?? "", priorOptions);
        if (!source) messages.push(`${step.name} 的逐项执行需要选择列表或数组来源`);
        else if (!isWorkflowArrayReference(workflow, source)) messages.push(`${step.name} 的逐项执行来源必须是多图列表、数组或前序逐项步骤的输出`);
        else {
          const error = referencePathError(step.execution.sourceRef ?? "", priorOptions, true);
          if (error) messages.push(`${step.name} 的遍历来源 ${error}`);
        }
        const carry = step.execution.carry;
        if (carry) {
          if (!step.outputs.some(output => output.key === carry.outputKey)) messages.push(`${step.name} 的状态传递需要选择已声明输出`);
          if ((step.execution.maxConcurrency ?? 1) !== 1 || (step.execution.onError ?? "stop") !== "stop") messages.push(`${step.name} 的状态传递必须串行且失败停止`);
          if (carry.initialSourceRef && referencePathError(carry.initialSourceRef, priorOptions, true, true)) messages.push(`${step.name} 的初始状态来源无效`);
        }
        const maxConcurrency = step.execution.maxConcurrency;
        if (maxConcurrency !== undefined && (!Number.isSafeInteger(maxConcurrency) || maxConcurrency < 1 || maxConcurrency > MAX_STEP_CONCURRENCY)) {
          messages.push(`${step.name} 的最大并行数需要是 1-${MAX_STEP_CONCURRENCY} 的整数`);
        }
      }
      step.inputs.forEach((input) => {
        if ((input.valueSource ?? "reference") === "literal") {
          const type = input.literalType ?? "text";
          const error = literalValueError(type, input.literalValue ?? "");
          if (error) messages.push(`${step.name} 的${input.label || input.key} ${error}`);
        } else {
          const error = referencePathError(input.sourceRef, stepOptions, true, true);
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
      const capability = capabilityForStep(step, capabilities);
      if (!capability) messages.push(step.name + " 的能力包未安装");
      else messages.push(...capabilityConfigErrors(step, capability).map((error) => step.name + "：" + error));
      if (capability?.editor.bindings) {
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
            const error = referencePathError(binding.sourceRef ?? "", stepOptions, true, true);
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
    const finalOutputOptions = allReferenceOptions(workflow);
    if (workflow.outputs.some((output) => {
      const option = referenceOption(output.sourceRef, finalOutputOptions);
      return !option || Boolean(referencePathError(output.sourceRef, finalOutputOptions, true, true));
    })) messages.push("最终输出存在未连接或失效的引用");
    return [...new Set(messages)];
  }

  const validation = validationMessages();
  const currentPublishedVersion = publishedSceneVersion(versionRecord);
  const hasUnpublishedChanges = !sceneDraftMatchesVersion(scene, workflow, optionPresets, currentPublishedVersion);
  const canPublish = validation.length === 0 && hasUnpublishedChanges && saveStatus === "saved";

  async function publish() {
    let version: SceneVersion | undefined;
    try { version = await onPublish(); } catch (error) { setNotice(error instanceof Error ? error.message : "发布尚未确认"); return; }
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
    const nextBinding: ComfyUIBinding = valueSource === "literal"
      ? { ...binding, valueSource, sourceRef: "", literalValue: binding.literalValue ?? "", selection: undefined, sourceInputFormat: undefined, sourceOutputFormat: undefined }
      : { ...binding, valueSource, sourceRef: "", literalValue: undefined, selection: undefined, sourceInputFormat: undefined, sourceOutputFormat: undefined };
    update({
      ...workflow,
      steps: workflow.steps.map((step) => step.id === selectedStep.id ? stepWithComfyBindings(step, bindings.map((item, itemIndex) => itemIndex === index ? nextBinding : item), capabilities) : step),
    });
  }

  return (
    <div className="designer-page">
      <div className="designer-topline">
        <div>
          <div className="eyebrow"><span className="eyebrow-line" />WORKFLOW DESIGN</div>
          <h1>流程配置</h1>
          <p className="page-subtitle">当前为草稿配置，与 MCP get_scene_draft 一致；显式发布后才用于创作。</p>
        </div>
        <div className="designer-release-actions">
          <span className={`designer-release-state ${currentPublishedVersion ? hasUnpublishedChanges ? "staged" : "published" : "unpublished"}`}>
            {notice || (currentPublishedVersion ? hasUnpublishedChanges ? `暂存修改 · 当前发布 v${currentPublishedVersion.version}` : `当前发布 v${currentPublishedVersion.version}` : "尚未发布")}
          </span>
          <button type="button" className="button button-outline designer-diff-button" onClick={() => setShowDiff(true)} title="对比草稿与当前发布快照，不会发布或生成"><GitCompareArrows size={14} />差异预览</button>
          <button className="button button-outline designer-versions-button" onClick={() => setShowVersions(true)}><HistoryIcon size={14} />版本管理</button>
          <button className="button button-dark designer-publish-button" onClick={publish} disabled={!canPublish} title={validation[0] ?? undefined}>
            {currentPublishedVersion && !hasUnpublishedChanges ? <Check size={14} /> : <Rocket size={14} />}
            {currentPublishedVersion && !hasUnpublishedChanges ? `已发布 v${currentPublishedVersion.version}` : currentPublishedVersion ? "发布更新" : "发布场景"}
          </button>
        </div>
      </div>

      <section className="designer-scene-switch" aria-label="场景选择">
        <div className="designer-scene-choice">
          <span className={`scene-icon-box ${scene.accent}`} aria-hidden="true"><Sparkles size={18} /></span>
          <div className="designer-scene-control">
            <label htmlFor="designer-scene-select">当前场景</label>
            <div className="select-wrap">
              <select id="designer-scene-select" value={sceneId} onChange={(event) => onSceneChange(event.target.value)} aria-label="选择配置场景">
                {scenes.map((item) => <option value={item.id} key={item.id}>{item.title}</option>)}
              </select>
              <ChevronDown size={14} aria-hidden="true" />
            </div>
          </div>
        </div>
        <p className="designer-scene-summary" title={scene.summary}>{scene.summary || "配置此场景的输入、处理步骤与最终输出。"}</p>
        <button className="button button-outline designer-scene-sort" onClick={onSortScenes} disabled={scenes.length < 2}><ArrowDownUp size={14} />场景排序</button>
      </section>

      <div className="designer-layout">
        <aside className="designer-index">
          <div className="designer-index-heading"><span>流程结构</span><span>{workflow.steps.length} 步</span></div>
          <button className={`designer-index-item ${selection.kind === "inputs" ? "active" : ""}`} onClick={() => setSelection({ kind: "inputs" })}>
            <span className="designer-index-icon input-index-icon"><FileInput size={16} /></span><span className="designer-index-copy"><strong>场景输入</strong><small>{workflow.inputs.length} 个字段</small></span>
          </button>
          <div className="designer-index-divider" />
          <div className="designer-step-index-list">
            {workflow.steps.map((step, index) => <button className={`designer-index-item designer-step-index ${selection.kind === "step" && selection.stepId === step.id ? "active" : ""}`} key={step.id} onClick={() => setSelection({ kind: "step", stepId: step.id })}>
              <span className="designer-step-number">{String(index + 1).padStart(2, "0")}</span><span className="designer-index-copy"><strong>{step.name || "未命名步骤"}</strong><small>{capabilityForStep(step, capabilities)?.label ?? stepKindLabels[step.kind]}</small></span><ArrowRight size={13} className="designer-index-arrow" />
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
              <div><h2>{selection.kind === "inputs" ? "场景输入" : selection.kind === "outputs" ? "最终输出" : selectedStep?.name ?? "步骤设置"}</h2><p>{selection.kind === "inputs" ? "定义启动场景时需要填写的数据" : selection.kind === "outputs" ? "把流程中的数据映射为场景最终结果" : `第 ${String(selectedStepIndex + 1).padStart(2, "0")} 步 · ${selectedCapability?.label ?? (selectedStep ? stepKindLabels[selectedStep.kind] : "")}`}</p></div>
            </div>
            {selection.kind === "step" && selectedStep && <div className="step-move-actions">
              <button className="icon-button" onClick={() => moveStep(selectedStep.id, -1)} title="上移" aria-label="上移" disabled={selectedStepIndex === 0}><ArrowUp size={15} /></button>
              <button className="icon-button" onClick={() => moveStep(selectedStep.id, 1)} title="下移" aria-label="下移" disabled={selectedStepIndex === workflow.steps.length - 1}><ArrowDown size={15} /></button>
              <button className="icon-button delete-icon-button" onClick={() => { const steps = workflow.steps.filter((step) => step.id !== selectedStep.id); update({ ...workflow, steps }); setSelection({ kind: "inputs" }); }} title="删除步骤" aria-label="删除步骤"><Trash2 size={15} /></button>
            </div>}
          </div>

          {selection.kind === "inputs" && <section className="schema-editor">
            <div className="designer-field-explainer"><Braces size={15} /><span>每个输入都会成为可引用变量，例如 <code>input.story_seed</code>；隐藏仅影响网页输入表单展示。</span></div>
            {workflow.inputs.map((field, index) => <div className="schema-row" key={`schema-input-${field.key}-${index}`}>
              <div className="schema-row-toolbar">
                <span className="schema-row-index">{String(index + 1).padStart(2, "0")}</span>
                <div className="schema-row-actions">
                  <button className="icon-button schema-order-button" onClick={() => moveInputField(index, -1)} title="上移输入" aria-label={`上移${field.label}`} disabled={index === 0}><ArrowUp size={13} /></button>
                  <button className="icon-button schema-order-button" onClick={() => moveInputField(index, 1)} title="下移输入" aria-label={`下移${field.label}`} disabled={index === workflow.inputs.length - 1}><ArrowDown size={13} /></button>
                  <button className="icon-button schema-delete" onClick={() => update({ ...workflow, inputs: workflow.inputs.filter((_, itemIndex) => itemIndex !== index) })} title="删除输入" aria-label={`删除${field.label}`}><Trash2 size={14} /></button>
                </div>
              </div>
              <div className="schema-row-main">
                <DeferredInput className="text-input schema-label-input" value={field.label} onCommit={(value) => updateInputField(index, { label: value })} aria-label="输入名称" placeholder="输入名称" />
                <DeferredInput className="text-input schema-key-input" value={field.key} onCommit={(value) => updateInputField(index, { key: value.replace(/[^a-zA-Z0-9_]/g, "_") })} aria-label="输入 key" placeholder="field_key" />
                <div className="media-type-controls"><div className="select-wrap schema-type-select"><select value={canonicalWorkflowType(field.type) ?? field.type} onChange={(event) => updateInputField(index, { type: event.target.value as WorkflowFieldType, defaultValue: undefined, ...(event.target.value === "select" ? {} : { optionPresetId: undefined }) })} aria-label="输入类型">{fieldTypeOptions.map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select><ChevronDown size={13} /></div><MediaRoleSelect type={field.type} value={field.mediaRole} onChange={mediaRole => updateInputField(index, { mediaRole })} label={`${field.label}的素材用途`} /></div>
                <label className="required-toggle"><input type="checkbox" checked={field.required} onChange={(event) => updateInputField(index, { required: event.target.checked })} /><span>必填</span></label>
              </div>
              {field.type === "number" && <div className="schema-number-controls">
                <label><span>最小值</span><DeferredInput className="text-input" type="number" step="any" value={field.minimum === undefined ? "" : String(field.minimum)} onCommit={value => { const minimum = value.trim() ? Number(value) : undefined; if (minimum === undefined || Number.isFinite(minimum)) updateInputField(index, { minimum }); }} placeholder="不限制" aria-label={`${field.label}最小值`} /></label>
                <label><span>最大值</span><DeferredInput className="text-input" type="number" step="any" value={field.maximum === undefined ? "" : String(field.maximum)} onCommit={value => { const maximum = value.trim() ? Number(value) : undefined; if (maximum === undefined || Number.isFinite(maximum)) updateInputField(index, { maximum }); }} placeholder="不限制" aria-label={`${field.label}最大值`} /></label>
                <small>用户可不填写；填写时必须在范围内。</small>
              </div>}
              {field.type === "json" && <div className="object-array-mode-control"><label htmlFor={`input-mode-${field.key}`}>用户填写方式</label><div className="select-wrap"><select id={`input-mode-${field.key}`} value={field.inputMode ?? "json"} onChange={event => updateInputField(index, event.target.value === "object_array" ? { inputMode: "object_array", itemFields: field.itemFields?.length ? field.itemFields : [{ key: "item_field_1", label: "字段1", type: "text", required: true }] } : { inputMode: undefined, itemFields: undefined })}><option value="json">JSON 编辑器</option><option value="object_array">对象数组表单</option></select><ChevronDown size={13} /></div></div>}
              {field.inputMode === "object_array" && <div className="object-array-schema-editor">
                <div className="object-array-schema-heading"><strong>每行字段</strong><small>用户按行填写，提交值仍是结构化数组。</small></div>
                {(field.itemFields ?? []).map((item, itemIndex) => <div className="object-array-schema-row" key={`${item.key}-${itemIndex}`}>
                  <DeferredInput className="text-input" value={item.label} onCommit={label => updateInputField(index, { itemFields: (field.itemFields ?? []).map((current, position) => position === itemIndex ? { ...current, label } : current) })} placeholder="字段名称" aria-label={`${item.label}字段名称`} />
                  <DeferredInput className="text-input" value={item.key} onCommit={key => updateInputField(index, { itemFields: (field.itemFields ?? []).map((current, position) => position === itemIndex ? { ...current, key: key.replace(/[^a-zA-Z0-9_]/g, "_") } : current) })} placeholder="field_key" aria-label={`${item.label}字段 key`} />
                  <div className="select-wrap"><select value={item.type} onChange={event => updateInputField(index, { itemFields: (field.itemFields ?? []).map((current, position) => position === itemIndex ? { ...current, type: event.target.value as WorkflowObjectArrayItemField["type"], ...(event.target.value === "select" ? {} : { options: undefined }), ...(event.target.value === "number" ? {} : { minimum: undefined, maximum: undefined }) } : current) })} aria-label={`${item.label}字段类型`}>{objectArrayItemTypeOptions.map(([type, label]) => <option value={type} key={type}>{label}</option>)}</select><ChevronDown size={13} /></div>
                  {item.type === "select" && <DeferredInput className="text-input" value={(item.options ?? []).join(", ")} onCommit={value => updateInputField(index, { itemFields: (field.itemFields ?? []).map((current, position) => position === itemIndex ? { ...current, options: value.split(",").map(option => option.trim()).filter(Boolean) } : current) })} placeholder="选项用逗号分隔" aria-label={`${item.label}下拉选项`} />}
                  {item.type === "number" && <div className="schema-number-controls object-array-number-controls">
                    <label><span>最小值</span><DeferredInput className="text-input" type="number" step="any" value={item.minimum === undefined ? "" : String(item.minimum)} onCommit={value => { const minimum = value.trim() ? Number(value) : undefined; if (minimum === undefined || Number.isFinite(minimum)) updateInputField(index, { itemFields: (field.itemFields ?? []).map((current, position) => position === itemIndex ? { ...current, minimum } : current) }); }} placeholder="不限制" aria-label={`${item.label}最小值`} /></label>
                    <label><span>最大值</span><DeferredInput className="text-input" type="number" step="any" value={item.maximum === undefined ? "" : String(item.maximum)} onCommit={value => { const maximum = value.trim() ? Number(value) : undefined; if (maximum === undefined || Number.isFinite(maximum)) updateInputField(index, { itemFields: (field.itemFields ?? []).map((current, position) => position === itemIndex ? { ...current, maximum } : current) }); }} placeholder="不限制" aria-label={`${item.label}最大值`} /></label>
                  </div>}
                  <label className="required-toggle"><input type="checkbox" checked={item.required} onChange={event => updateInputField(index, { itemFields: (field.itemFields ?? []).map((current, position) => position === itemIndex ? { ...current, required: event.target.checked } : current) })} /><span>必填</span></label>
                  <button className="icon-button schema-delete" onClick={() => updateInputField(index, { itemFields: (field.itemFields ?? []).filter((_current, position) => position !== itemIndex) })} title="删除子字段" aria-label={`删除${item.label}`}><Trash2 size={14} /></button>
                </div>)}
                <button className="designer-add-field" onClick={() => updateInputField(index, { itemFields: [...(field.itemFields ?? []), { key: `item_field_${(field.itemFields?.length ?? 0) + 1}`, label: `字段${(field.itemFields?.length ?? 0) + 1}`, type: "text", required: false }] })}><ListPlus size={14} />添加行字段</button>
              </div>}
              {field.type === "select" && <div className="schema-options-controls">
                <DeferredInput className="text-input schema-options-input" value={(field.options ?? []).join(", ")} onCommit={(value) => updateInputField(index, { options: value.split(",").map((option) => option.trim()).filter(Boolean), optionPresetId: undefined })} placeholder="选项用逗号分隔" aria-label={`${field.label} 的选项`} />
                <div className="select-wrap schema-option-preset-select"><select value={field.optionPresetId ?? ""} onChange={(event) => applyOptionPreset(index, event.target.value)} aria-label={`${field.label} 的选项预设`}><option value="">自定义选项</option>{optionPresets.map((preset) => <option value={preset.id} key={preset.id}>{preset.name}</option>)}</select><ChevronDown size={13} /></div>
              </div>}
              <div className="schema-default-field"><label htmlFor={`input-default-${field.key}`}>默认值</label><WorkflowInputDefaultEditor field={field} onChange={(defaultValue) => updateInputField(index, { defaultValue })} /><small>创建任务时预填，可由提交人修改；留空表示不设置</small></div>
              <DeferredInput className="text-input schema-placeholder-input" value={field.placeholder ?? ""} onCommit={(value) => update({ ...workflow, inputs: workflow.inputs.map((item, itemIndex) => itemIndex === index ? { ...item, placeholder: value } : item) })} placeholder="填写提示（可选）" aria-label={`${field.label} 的填写提示`} />
              <label className="schema-hidden-toggle" title="从管理创作页和用户端网页表单中隐藏；输入契约与流程执行仍保留该字段">
                <input type="checkbox" checked={Boolean(field.hidden)} onChange={event => updateInputField(index, { hidden: event.target.checked })} />
                <span>从网页输入表单隐藏</span>
                <small>字段仍参与预检和流程执行</small>
              </label>
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
              <div className="select-wrap schema-type-select"><select value={canonicalWorkflowType(field.type) ?? field.type} onChange={(event) => update({ ...workflow, outputs: workflow.outputs.map((item, itemIndex) => itemIndex === index ? { ...item, type: event.target.value as WorkflowOutputField["type"] } : item) })} aria-label="输出类型">{outputTypeOptions.map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select><ChevronDown size={13} /></div>
              <button className="icon-button schema-delete" onClick={() => update({ ...workflow, outputs: workflow.outputs.filter((_, itemIndex) => itemIndex !== index) })} title="删除输出" aria-label={`删除${field.label}`}><Trash2 size={14} /></button>
              <ReferenceSelect value={field.sourceRef} options={sourceOptions} selection={field.selection} onChange={(sourceRef) => update({ ...workflow, outputs: workflow.outputs.map((item, itemIndex) => itemIndex === index ? { ...item, sourceRef } : item) })} onReferenceChange={(sourceRef, selection) => update({ ...workflow, outputs: workflow.outputs.map((item, itemIndex) => itemIndex === index ? { ...item, sourceRef, selection } : item) })} allowJsonPath allowMediaIndex />
            </div>)}
            <button className="designer-add-field" onClick={() => update({ ...workflow, outputs: [...workflow.outputs, newOutputField(workflow.outputs.length + 1)] })}><ListPlus size={15} />添加最终输出</button>
          </section>}

          {selection.kind === "step" && selectedStep && <section className="step-editor">
            <div className="designer-form-row">
              <div className="field-group"><label className="field-label">步骤名称</label><DeferredInput className="text-input" value={selectedStep.name} onCommit={(value) => updateStep(selectedStep.id, (step) => ({ ...step, name: value }))} /></div>
              <StepCapabilityPicker key={selectedStep.id} step={selectedStep} capabilities={capabilities} onChange={(id) => changeStepCapability(selectedStep.id, id)} />
            </div>
            {capabilityError && <div className="notice" role="status">能力目录未连接，暂时显示内置能力。{capabilityError}</div>}
            {selectedCapability ? <CapabilityConfigEditor step={selectedStep} definition={selectedCapability} references={selectedStepReferenceOptions} onChange={(next) => updateStep(selectedStep.id, () => next)} /> : <div className="notice error" role="alert">此能力包未安装，现有配置保留；请安装对应能力后再运行。</div>}
            <div className="designer-subsection execution-config-section step-execution-section">
              <div className="field-group"><label className="field-label"><input type="checkbox" checked={selectedStep.review?.enabled ?? false} onChange={event => updateStep(selectedStep.id, step => ({ ...step, review: { ...step.review, enabled: event.target.checked } }))} /> 完成后等待人工确认</label><p className="studio-field-hint">结果确认或修改后才执行后续步骤。逐项执行时，整批完成后确认。</p>{selectedStep.review?.enabled && <input className="text-input" placeholder="确认说明，例如：核对人物设定、对白和镜头顺序" value={selectedStep.review.instruction ?? ""} onChange={event => updateStep(selectedStep.id, step => ({ ...step, review: { enabled: true, instruction: event.target.value } }))} />}</div>
              <div className="designer-subsection-heading"><div><h3>步骤执行</h3><p>只让当前步骤按列表逐项运行，前后步骤仍按一次执行</p></div></div>
              <div className="execution-config-row">
                <label className="field-group"><span className="field-label">列表处理</span><div className="select-wrap"><select value={selectedStep.execution?.mode ?? "once"} onChange={(event) => {
                  if (event.target.value === "for_each") {
                    const currentSource = selectedStep.execution?.sourceRef && referenceOption(selectedStep.execution.sourceRef, stepIterationOptions)
                      && !referencePathError(selectedStep.execution.sourceRef, stepIterationOptions, true)
                      ? selectedStep.execution.sourceRef
                      : stepIterationOptions[0]?.value ?? "";
                    updateStep(selectedStep.id, (step) => ({ ...step, execution: { mode: "for_each", sourceRef: currentSource, onError: step.execution?.onError ?? "continue", maxConcurrency: step.execution?.maxConcurrency ?? 1 } }));
                  } else updateStep(selectedStep.id, (step) => { const { execution: _execution, ...withoutExecution } = step; return withoutExecution; });
                }} aria-label="步骤列表处理方式"><option value="once">执行一次</option><option value="for_each">按列表逐项执行</option></select><ChevronDown size={13} /></div></label>
                {selectedStep.execution?.mode === "for_each" && <>
                  <label className="field-group"><span className="field-label">遍历来源</span><ReferenceSelect value={selectedStep.execution.sourceRef ?? ""} options={stepIterationOptions} onChange={(sourceRef) => updateStep(selectedStep.id, (step) => ({ ...step, execution: step.execution ? { ...step.execution, sourceRef } : undefined }))} allowJsonPath /></label>
                  <label className="field-group"><span className="field-label">状态传递</span><div className="select-wrap"><select value={selectedStep.execution.carry ? "carry" : "independent"} aria-label="逐项状态传递" onChange={event => updateStep(selectedStep.id, step => {
                    if (!step.execution) return step;
                    if (event.target.value === "carry") return { ...step, execution: { ...step.execution, maxConcurrency: 1, onError: "stop", carry: { outputKey: step.outputs[0]?.key ?? "" } } };
                    const { carry: _carry, ...execution } = step.execution;
                    return { ...step, execution };
                  })}><option value="independent">各项独立</option><option value="carry">继承上一项输出（串行）</option></select><ChevronDown size={13} /></div></label>
                  {selectedStep.execution.carry && <>
                    <label className="field-group"><span className="field-label">传递输出</span><div className="select-wrap"><select value={selectedStep.execution.carry.outputKey} aria-label="状态传递输出键" onChange={event => updateStep(selectedStep.id, step => ({ ...step, execution: step.execution ? { ...step.execution, carry: { ...step.execution.carry, outputKey: event.target.value } } : undefined }))}><option value="">选择本步骤输出</option>{selectedStep.outputs.map(output => <option key={output.key} value={output.key}>{output.label || output.key}</option>)}</select><ChevronDown size={13} /></div></label>
                    <label className="field-group"><span className="field-label">初始状态（可选）</span><ReferenceSelect value={selectedStep.execution.carry.initialSourceRef ?? ""} options={priorReferenceOptions} allowJsonPath allowMediaIndex onChange={initialSourceRef => updateStep(selectedStep.id, step => ({ ...step, execution: step.execution?.carry ? { ...step.execution, carry: { outputKey: step.execution.carry.outputKey, ...(initialSourceRef ? { initialSourceRef } : {}) } } : step.execution }))} /><small className="field-help">留空时首项无上一段；显式种子必须有效且类型匹配。</small></label>
                  </>}
                  <label className="field-group"><span className="field-label">最大并行数</span><input className="text-input" type="number" min={1} max={MAX_STEP_CONCURRENCY} step={1} disabled={Boolean(selectedStep.execution.carry)} value={String(selectedStep.execution.maxConcurrency ?? 1)} onChange={(event) => {
                    const parsed = Number(event.target.value);
                    if (!Number.isFinite(parsed)) return;
                    updateStep(selectedStep.id, (step) => ({ ...step, execution: step.execution ? { ...step.execution, maxConcurrency: Math.min(MAX_STEP_CONCURRENCY, Math.max(1, Math.trunc(parsed))) } : undefined }));
                  }} aria-label="步骤最大并行数" /></label>
                  <label className="field-group"><span className="field-label">单项失败时</span><div className="select-wrap"><select disabled={Boolean(selectedStep.execution.carry)} value={selectedStep.execution.onError ?? (selectedStep.execution.carry ? "stop" : "continue")} onChange={(event) => updateStep(selectedStep.id, (step) => ({ ...step, execution: step.execution ? { ...step.execution, onError: event.target.value as "continue" | "stop" } : undefined }))} aria-label="步骤单项失败时的处理方式"><option value="continue">继续下一项</option><option value="stop">停止整个流程</option></select><ChevronDown size={13} /></div></label>
                </>}
              </div>
              {selectedStep.execution?.mode === "for_each" && <div className="designer-field-explainer execution-config-note"><Braces size={14} /><span>{selectedStep.execution.carry ? "下方可引用上一项输出、是否有上一项、当前序号；串行且失败停止，重做某项会重算后续项。输出仍按原顺序聚合。" : "下方输入可引用当前遍历项；步骤输出会按原列表顺序聚合，最多同时执行指定数量的项目。"}</span></div>}
            </div>
            <div className="designer-subsection start-condition-section">
              <div className="designer-subsection-heading"><div><h3>开始条件</h3><p>所有步骤通用：规则不满足时本步骤跳过，其输出按 null 参与下游引用，无需再建条件节点</p></div></div>
              <div className="condition-match-row">
                <span>规则关系</span>
                <div className="select-wrap"><select value={selectedStep.startCondition?.match ?? "all"} onChange={(event) => updateStartCondition(selectedStep.id, (condition) => ({ ...condition, match: event.target.value as "all" | "any" }))} aria-label="开始条件匹配方式">
                  <option value="all">全部满足</option><option value="any">任一满足</option>
                </select></div>
                {selectedStep.startCondition && <button type="button" className="text-button" onClick={() => clearStartCondition(selectedStep.id)}>移除开始条件</button>}
              </div>
              {(selectedStep.startCondition?.rules ?? []).map((rule, index) => {
                const leftType = referenceOption(rule.leftRef, selectedStepReferenceOptions)?.type;
                const operators = conditionOperators(leftType);
                const availableOperators = operators.includes(rule.operator) ? operators : [rule.operator, ...operators];
                const needsRightValue = rule.operator !== "is_empty" && rule.operator !== "is_not_empty";
                return <div className="condition-rule-row" key={rule.id || index}>
                  <div className="condition-rule-main">
                    <ReferenceSelect value={rule.leftRef} options={selectedStepReferenceOptions} onChange={(leftRef) => updateStartConditionRule(index, { leftRef, operator: "equals", valueSource: "literal", rightValue: "", rightRef: "" })} />
                    <div className="select-wrap"><select value={rule.operator} onChange={(event) => updateStartConditionRule(index, { operator: event.target.value as WorkflowConditionOperator })} aria-label="开始条件运算符">{availableOperators.map((operator) => <option key={operator} value={operator}>{conditionOperatorLabels[operator]}</option>)}</select></div>
                    <button className="icon-button schema-delete" onClick={() => updateStartCondition(selectedStep.id, (condition) => ({ ...condition, rules: condition.rules.filter((_, ruleIndex) => ruleIndex !== index) }))} aria-label="删除开始条件规则">×</button>
                  </div>
                  {needsRightValue ? <div className="condition-rule-value">
                    <div className="select-wrap condition-value-source"><select value={rule.valueSource} onChange={(event) => updateStartConditionRule(index, { valueSource: event.target.value as "literal" | "reference" })} aria-label="开始条件值来源"><option value="literal">固定值</option><option value="reference">引用</option></select></div>
                    {rule.valueSource === "reference" ? <ReferenceSelect value={rule.rightRef} options={selectedStepReferenceOptions} onChange={(rightRef) => updateStartConditionRule(index, { rightRef })} /> : <input className="text-input" value={rule.rightValue} onChange={(event) => updateStartConditionRule(index, { rightValue: event.target.value })} aria-label="开始条件比较值" />}
                  </div> : <div className="condition-no-value">无需比较值</div>}
                </div>;
              })}
              <button className="designer-add-field" onClick={() => updateStartCondition(selectedStep.id, (condition) => ({ ...condition, rules: [...condition.rules, newConditionRule(condition.rules.length + 1)] }))}>添加规则</button>
            </div>
            {(priorConditionSteps.length > 0 || selectedStep.runCondition) && <div className="designer-subsection run-condition-section">
              <div className="designer-subsection-heading"><div><h3>执行条件</h3><p>此步骤仅在指定条件节点返回对应结果时执行</p></div></div>
              <div className="run-condition-row">
                <div className="select-wrap"><select value={selectedStep.runCondition?.conditionStepId ?? ""} onChange={(event) => setRunCondition(selectedStep.id, event.target.value)} aria-label="选择执行条件"><option value="">始终执行</option>{selectedStep.runCondition && !priorConditionSteps.some((step) => step.id === selectedStep.runCondition?.conditionStepId) && <option value={selectedStep.runCondition.conditionStepId}>失效条件：{selectedStep.runCondition.conditionStepId}</option>}{priorConditionSteps.map((step) => <option value={step.id} key={step.id}>{step.name} · 判断结果</option>)}</select><ChevronDown size={14} /></div>
                {selectedStep.runCondition && <div className="select-wrap"><select value={String(selectedStep.runCondition.expectedResult)} onChange={(event) => updateStep(selectedStep.id, (step) => ({ ...step, runCondition: step.runCondition ? { ...step.runCondition, expectedResult: event.target.value === "true" } : undefined }))} aria-label="条件期望结果"><option value="true">结果为真时执行</option><option value="false">结果为假时执行</option></select><ChevronDown size={14} /></div>}
              </div>
            </div>}
            {selectedCapability?.editor.profile && <div className="step-profile-row"><div className="field-group"><label className="field-label">Hermes Profile</label><div className="select-wrap"><select value={selectedStep.hermesProfile ?? ""} onChange={(event) => updateStep(selectedStep.id, (step) => ({ ...step, hermesProfile: event.target.value }))}><option value="">选择 Profile</option>{profiles.map((profile) => <option value={profile.id} key={profile.id}>{profile.id}{profile.isDefault ? "（默认）" : enabledProfiles.includes(profile.id) ? "（已启用）" : "（未启用）"}</option>)}</select><ChevronDown size={14} /></div></div><button className="text-button" onClick={onOpenConnections}>管理 Profile <ArrowRight size={13} /></button></div>}
            {profileError && <div className="designer-profile-error">{profileError}</div>}

            {selectedCapability?.editor.condition && <div className="designer-subsection condition-editor">
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

            {selectedCapability?.editor.bindings && <div className="designer-subsection comfyui-subsection">
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
                     <div className="comfy-binding-heading"><div><strong>{inputDirection ? "输入变量" : "输出变量"}</strong><small>{inputDirection ? "ComfyUI只接收媒体列表；分类在上游选择并合并，图片→images、音频→audios、视频→videos" : "从节点属性读取，供后续步骤和最终结果引用"}</small></div><div className="comfy-binding-actions">{inputDirection && <button className="text-button comfy-import-button" onClick={() => {
                      const additions: ComfyUIBinding[] = importableInputs.map((field) => ({
                        key: field.key,
                        label: field.label,
                        direction: "input" as const,
                        nodeId: "",
                        property: "",
                        type: inputValueType(field.type),
                        mediaRole: field.mediaRole,
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
                        type: inputDirection ? "text" : "image_list",
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
                      const bindingSource = referenceOption(binding.sourceRef ?? "", sourceOptions);
                      const hasJsonPath = inputDirection && valueSource === "reference" && (bindingSource?.type === "json" || isMediaArrayReference(bindingSource));
                      return <div className={`comfy-binding-row ${inputDirection ? "input-binding" : "output-binding"} ${hasJsonPath ? "has-json-path" : ""}`} key={`comfy-binding-${direction}-${index}`}>
                         <div className="comfy-binding-variable"><DeferredInput className="text-input" value={binding.label} onCommit={(value) => updateComfyBinding(selectedStep.id, index, { label: value })} placeholder="变量名称" aria-label="变量名称" /><DeferredInput className="text-input output-key-input" value={binding.key} onCommit={(value) => updateComfyBinding(selectedStep.id, index, { key: value.replace(/[^a-zA-Z0-9_]/g, "_") })} placeholder="variable_key" aria-label="变量 key" /></div>
                         {inputDirection && <div className="comfy-binding-source"><div className="select-wrap comfy-source-mode"><select value={valueSource} onChange={(event) => setComfyBindingSource(index, event.target.value as WorkflowValueSource)} aria-label="输入取值来源"><option value="reference">引用变量</option><option value="literal">固定值</option></select><ChevronDown size={13} /></div>{valueSource === "literal" ? <LiteralValueControl type={binding.type} value={binding.literalValue ?? ""} options={binding.options} onChange={(literalValue) => updateComfyBinding(selectedStep.id, index, { literalValue })} ariaLabel="输入固定值" /> : <ReferenceSelect value={binding.sourceRef ?? ""} options={selectedStepReferenceOptions} selection={binding.selection} onChange={(sourceRef) => updateComfyBindingSource(index, sourceRef)} onReferenceChange={(sourceRef, selection) => updateComfyBindingSource(index, sourceRef, selection)} allowJsonPath allowMediaIndex />}</div>}
                        <div className="comfy-node-loader"><DeferredInput className="text-input comfy-node-input" value={binding.nodeId} onCommit={(value) => { updateComfyBindingNode(index, value); setComfyNodeError(""); }} list={nodeListId} placeholder="节点 ID" aria-label="ComfyUI 节点 ID" /><button className="icon-button comfy-node-load-button" onClick={() => loadComfyNodeProperties(binding.nodeId)} title="加载节点属性" aria-label={`加载节点 ${binding.nodeId || ""} 的属性`} disabled={comfyLoading || nodeLoading}><RefreshCw className={nodeLoading ? "spin" : undefined} size={13} /></button></div>
                        <datalist id={nodeListId}>{comfyNodes.map((item) => <option value={item.id} key={item.id}>{item.type}</option>)}</datalist>
                        <DeferredInput className="text-input comfy-property-input" value={binding.property} onCommit={(value) => updateComfyBindingProperty(index, value)} list={propertyListId} placeholder={inputDirection ? "节点输入属性" : "节点输出属性，如 Filenames"} aria-label="ComfyUI 节点属性" />
                        <datalist id={propertyListId}>{nodePropertiesLoaded && propertyOptions.map((property) => <option value={property} key={property} />)}</datalist>
                        <div className="media-type-controls"><div className="select-wrap schema-type-select"><select value={canonicalWorkflowType(binding.type) ?? binding.type} onChange={(event) => updateComfyBinding(selectedStep.id, index, { type: event.target.value as WorkflowVariableType })} aria-label="变量类型">{(inputDirection ? variableTypeOptions : outputTypeOptions).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select><ChevronDown size={13} /></div></div>
                        <button className="icon-button schema-delete" onClick={() => removeComfyBinding(index)} title="删除绑定" aria-label={`删除${binding.label}绑定`}><Trash2 size={14} /></button>
                        {node && <small className="comfy-node-type">{node.type}{nodePropertiesLoaded ? ` · 已加载 ${propertyInfos.length} 个${inputDirection ? "输入" : "输出"}属性` : " · 点击加载属性"}{selectedPropertyInfo?.options?.length ? ` · 选项 ${selectedPropertyInfo.options.length} 个` : ""}</small>}
                      </div>;
                    })}
                    {!bindings.length && <div className="comfy-workflow-empty">还没有定义变量绑定</div>}
                  </section>;
                })}
              </div>}
            </div>}


            {selectedCapability?.editor.inputs === "ports" && !selectedCapability.editor.condition && <div className="designer-subsection">
               <div className="designer-subsection-heading"><div><h3>步骤输入</h3><p>{selectedStep.kind === "hermes" ? "把文本和结构化数据映射给 Hermes；媒体会作为附件发送，JSON 可填写字段路径" : "选择变量引用，或为当前步骤填写固定值"}</p></div><span>{selectedStep.inputs.length} 项映射</span></div>
              {selectedStep.inputs.map((input, index) => {
                const valueSource = input.valueSource ?? "reference";
                const referenceOptions = selectedStepReferenceOptions;
                const referenceType = referenceOption(input.sourceRef, referenceOptions)?.type;
                const literalType = input.literalType ?? referenceType ?? "text";
                return <div className="step-input-row" key={`step-input-${index}`}>
                  <div className="step-input-labels"><DeferredInput className="text-input" value={input.label} onCommit={(value) => setStepInput(index, "label", value)} aria-label="输入标签" placeholder="输入名称" /><DeferredInput className="text-input" value={input.key} onCommit={(value) => setStepInput(index, "key", value.replace(/[^a-zA-Z0-9_]/g, "_") )} aria-label="输入 key" placeholder="step_input" /></div>
                  <div className="step-input-source"><div className="select-wrap step-input-source-mode"><select value={valueSource} onChange={(event) => setStepInputSource(index, event.target.value as WorkflowValueSource)} aria-label="输入取值来源"><option value="reference">引用变量</option><option value="literal">固定值</option></select><ChevronDown size={13} /></div>{valueSource === "literal" ? <div className="step-input-literal"><div className="select-wrap step-input-literal-type"><select value={canonicalWorkflowType(literalType) ?? literalType} onChange={(event) => setStepInput(index, "literalType", event.target.value)} aria-label="固定值类型">{variableTypeOptions.map(([type, label]) => <option value={type} key={type}>{label}</option>)}</select><ChevronDown size={13} /></div><LiteralValueControl type={literalType} value={input.literalValue ?? ""} onChange={(literalValue) => setStepInput(index, "literalValue", literalValue)} ariaLabel="输入固定值" /></div> : <><ReferenceSelect value={input.sourceRef} options={referenceOptions} selection={input.selection} onChange={(value) => setStepInput(index, "sourceRef", value)} onReferenceChange={(sourceRef, selection) => setStepInputReference(index, sourceRef, selection)} allowJsonPath allowMediaIndex /><div className="select-wrap"><select value={input.referenceType ?? ""} onChange={(event) => updateStep(selectedStep.id, (step) => ({ ...step, inputs: step.inputs.map((item, itemIndex) => itemIndex === index ? { ...item, referenceType: (event.target.value || undefined) as typeof item.referenceType } : item) }))} aria-label="引用媒体类型" title="引用JSON字段内的媒体时显式声明；普通文本/JSON保持自动"><option value="">自动识别类型</option><option value="image_list">图片列表</option><option value="video_list">视频列表</option><option value="audio_list">音频列表</option></select><ChevronDown size={13} /></div></>}</div>
                  <button className="icon-button schema-delete" onClick={() => updateStep(selectedStep.id, (step) => ({ ...step, inputs: step.inputs.filter((_, itemIndex) => itemIndex !== index) }))} title="删除输入映射" aria-label={`删除${input.label}映射`}><Trash2 size={14} /></button>
                </div>;
              })}
              <button className="designer-add-field" onClick={() => updateStep(selectedStep.id, (step) => ({ ...step, inputs: [...step.inputs, { key: `input_${step.inputs.length + 1}`, label: "新输入", sourceRef: "" }] }))}><Plus size={14} />添加步骤输入</button>
            </div>}

            {selectedCapability?.editor.outputs === "ports" && !selectedCapability.editor.condition && <div className="designer-subsection">
              <div className="designer-subsection-heading"><div><h3>步骤输出</h3><p>声明此步骤提供给后续步骤的结果</p></div><span>{selectedStep.outputs.length} 项结果</span></div>
              {selectedStep.outputs.map((output, index) => <div className="step-output-row" key={`step-output-${index}`}>
                <DeferredInput className="text-input" value={output.label} onCommit={(value) => setStepOutput(index, "label", value)} aria-label="输出标签" placeholder="输出名称" />
                <DeferredInput className="text-input output-key-input" disabled={selectedCapability.editor.editableOutputs === false} value={output.key} onCommit={(value) => setStepOutput(index, "key", value.replace(/[^a-zA-Z0-9_]/g, "_") )} aria-label="输出 key" placeholder="output_key" />
                <div className="select-wrap schema-type-select"><select disabled={selectedCapability.editor.editableOutputs === false} value={canonicalWorkflowType(output.type) ?? output.type} onChange={(event) => setStepOutput(index, "type", event.target.value)} aria-label="步骤输出类型">{outputTypeOptions.map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select><ChevronDown size={13} /></div>
                <button className="icon-button schema-delete" disabled={selectedCapability.editor.editableOutputs === false} onClick={() => updateStep(selectedStep.id, (step) => ({ ...step, outputs: step.outputs.filter((_, itemIndex) => itemIndex !== index) }))} title="删除步骤输出" aria-label={`删除${output.label}`}><Trash2 size={14} /></button>
                <DeferredInput className="text-input step-output-description" value={output.description ?? ""} onCommit={(value) => setStepOutput(index, "description", value)} aria-label="步骤输出字段描述" placeholder="字段描述：说明这里应该输出什么内容" />
              </div>)}
              <button className="designer-add-field" disabled={selectedCapability.editor.editableOutputs === false} onClick={() => updateStep(selectedStep.id, (step) => ({ ...step, outputs: [...step.outputs, { key: `output_${step.outputs.length + 1}`, label: "新输出", type: "text" }] }))}><Plus size={14} />添加步骤输出</button>
            </div>}

            {selectedCapability?.editor.prompt && <div className="designer-subsection prompt-subsection">
              <div className="designer-subsection-heading"><div><h3>提示词模板</h3><p>使用上方步骤输入，也可直接插入场景变量引用</p></div><span><Braces size={13} />变量引用</span></div>
              <div className={`prompt-reference-tools ${promptReferenceType === "json" ? "has-json-path" : ""}`}><div className="select-wrap"><select value={referenceToInsert} onChange={(event) => { setReferenceToInsert(event.target.value); setReferencePathToInsert(""); }} aria-label="选择要插入的引用"><option value="">选择输入或前序输出</option>{selectedStepPromptOptions.map((option) => <option key={option.value} value={option.value}>{option.label}（{option.value}）</option>)}</select><ChevronDown size={14} /></div>{promptReferenceType === "json" && <><input className="text-input json-path-input" value={referencePathToInsert} onChange={(event) => setReferencePathToInsert(event.target.value)} placeholder="字段路径，如 [0].prompt" title="数组可写 [0].prompt；对象数组可写 shots[0].prompt" aria-label="插入引用的 JSON 字段路径" aria-invalid={Boolean(referencePathToInsert.trim() && promptReferencePathError)} />{referencePathToInsert.trim() && promptReferencePathError && <small className="json-path-error">{promptReferencePathError}</small>}</>}<button type="button" className="button button-outline" onClick={insertReference} disabled={!referenceToInsert || Boolean(promptReferencePathError)}>插入引用</button></div>
              <DeferredTextarea ref={promptRef} className="text-input prompt-textarea" value={selectedStep.promptTemplate} onCommit={(value) => updateStep(selectedStep.id, (step) => ({ ...step, promptTemplate: value }))} placeholder="编写此步骤交给 Hermes 的任务描述……" />
            </div>}
          </section>}

           <div className={`designer-validation ${validation.length ? "has-errors" : ""}`}><span className="validation-mark">{validation.length ? "!" : <Check size={12} />}</span><span>{validation.length ? validation[0] : "输入配置完整"}</span><span>{validation.length ? `${validation.length} 个待处理` : saveStatus === "saving" ? "保存中 · 等待服务端" : saveStatus === "failed" ? "保存未确认" : "服务端已保存"}</span></div>
        </main>
      </div>
      {showDiff && <SceneDiffDialog sceneId={sceneId} sceneTitle={scene.title} contentHash={sceneVersionHash(scene, workflow, optionPresets)} saveStatus={saveStatus} onClose={() => setShowDiff(false)} />}
      {showVersions && <SceneVersionsDialog sceneTitle={scene.title} record={versionRecord} onClose={() => setShowVersions(false)} onApply={onApplyVersion} />}
    </div>
  );
}
