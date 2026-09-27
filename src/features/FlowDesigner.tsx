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
  ListPlus,
  Plus,
  RefreshCw,
  Sparkles,
  Trash2,
} from "lucide-react";
import { forwardRef, useEffect, useMemo, useRef, useState } from "react";
import type { InputHTMLAttributes, TextareaHTMLAttributes } from "react";
import { scenes } from "../data/scenes";
import { loadComfyUIWorkflow, loadComfyUIWorkflows, loadConnectionSettings, loadHermesProfiles } from "../lib/api";
import type {
  ComfyUIBinding,
  ComfyUIWorkflowDetail,
  ComfyUIWorkflowNode,
  ComfyUIWorkflowSummary,
  HermesProfile,
  SceneId,
  WorkflowDefinition,
  WorkflowConditionOperator,
  WorkflowConditionRule,
  WorkflowControlConfig,
  WorkflowFieldType,
  WorkflowInputField,
  WorkflowOutputField,
  WorkflowStepDefinition,
  WorkflowStepKind,
  WorkflowStepOutput,
  WorkflowVariableType,
} from "../types";

interface FlowDesignerProps {
  sceneId: SceneId;
  workflow: WorkflowDefinition;
  onSceneChange: (sceneId: SceneId) => void;
  onChange: (workflow: WorkflowDefinition) => void;
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
  video: "视频",
  json: "结构化数据",
};

const outputTypeLabels: Record<WorkflowStepOutput["type"], string> = {
  text: "文本",
  number: "数字",
  boolean: "布尔值",
  image: "图像",
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
  return type === "textarea" || type === "select" ? "text" : type;
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

function ReferenceSelect({ value, options, onChange }: { value: string; options: ReferenceOption[]; onChange: (value: string) => void }) {
  const valid = options.some((option) => option.value === value);
  return <div className="select-wrap ref-select"><select value={value} onChange={(event) => onChange(event.target.value)}>
    {!valid && value && <option value={value}>失效引用：{value}</option>}
    <option value="">选择一个输入或上游输出</option>
    {options.map((option) => <option value={option.value} key={option.value}>{option.label}{option.type ? ` · ${variableTypeLabels[option.type]}` : ""}（{option.value}）</option>)}
  </select><ChevronDown size={14} /></div>;
}

function newInputField(index: number): WorkflowInputField {
  return { key: `input_${index}`, label: "新输入", type: "text", required: false };
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
    outputs: [],
    promptTemplate: "",
  };
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
      type: "text" as const,
      sourceRef: input.sourceRef,
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

export default function FlowDesigner({ sceneId, workflow, onSceneChange, onChange, onOpenConnections }: FlowDesignerProps) {
  const [selection, setSelection] = useState<Selection>({ kind: "inputs" });
  const [profiles, setProfiles] = useState<HermesProfile[]>([]);
  const [enabledProfiles, setEnabledProfiles] = useState<string[]>([]);
  const [profileError, setProfileError] = useState("");
  const [comfyWorkflows, setComfyWorkflows] = useState<ComfyUIWorkflowSummary[]>([]);
  const [comfyNodes, setComfyNodes] = useState<ComfyUIWorkflowNode[]>([]);
  const [comfyFormat, setComfyFormat] = useState<ComfyUIWorkflowDetail["format"] | null>(null);
  const [comfyLoading, setComfyLoading] = useState(false);
  const [comfyError, setComfyError] = useState("");
  const [comfyNodeError, setComfyNodeError] = useState("");
  const [loadedComfyNodeIds, setLoadedComfyNodeIds] = useState<string[]>([]);
  const [notice, setNotice] = useState("");
  const promptRef = useRef<HTMLTextAreaElement>(null);
  const [referenceToInsert, setReferenceToInsert] = useState("");

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
  const priorConditionSteps = selectedStep
    ? workflow.steps.slice(0, selectedStepIndex).filter((step) => step.kind === "control")
    : [];
  const selectedControl = selectedStep?.control ?? defaultControlConfig();

  useEffect(() => {
    if (!selectedStep || selectedStep.kind !== "comfyui" || !selectedStep.comfyui?.workflowFile) {
      setComfyNodes([]);
      setComfyFormat(null);
      setLoadedComfyNodeIds([]);
      setComfyNodeError("");
      return;
    }
    let active = true;
    setComfyLoading(true);
    setComfyError("");
    setComfyNodeError("");
    setComfyFormat(null);
    setLoadedComfyNodeIds([]);
    loadComfyUIWorkflow(selectedStep.comfyui.workflowFile)
      .then((detail) => { if (active) { setComfyNodes(detail.nodes); setComfyFormat(detail.format); } })
      .catch((error: unknown) => { if (active) setComfyError(error instanceof Error ? error.message : "无法读取工作流节点"); })
      .finally(() => { if (active) setComfyLoading(false); });
    return () => { active = false; };
  }, [selectedStep?.id, selectedStep?.kind, selectedStep?.comfyui?.workflowFile]);

  function update(next: WorkflowDefinition) {
    onChange(next);
    setNotice("已保存");
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
    const token = `{{${referenceToInsert}}}`;
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

  function setStepOutput(index: number, key: string, value: string) {
    if (!selectedStep) return;
    updateStep(selectedStep.id, (step) => ({ ...step, outputs: step.outputs.map((output, itemIndex) => itemIndex === index ? { ...output, [key]: value } : output) }));
  }

  function updateComfyBindings(stepId: string, bindings: ComfyUIBinding[]) {
    updateStep(stepId, (step) => ({
      ...step,
      comfyui: { workflowFile: step.comfyui?.workflowFile ?? "", bindings },
      inputs: bindings.filter((binding) => binding.direction === "input").map((binding) => ({
        key: binding.key,
        label: binding.label,
        sourceRef: binding.sourceRef ?? "",
      })),
      outputs: bindings.filter((binding) => binding.direction === "output").map((binding) => ({
        key: binding.key,
        label: binding.label,
        type: bindingOutputType(binding.type),
      })),
    }));
  }

  function updateComfyBinding(stepId: string, index: number, changes: Partial<ComfyUIBinding>) {
    if (!selectedStep) return;
    const bindings = comfyBindings(selectedStep);
    updateComfyBindings(stepId, bindings.map((binding, itemIndex) => itemIndex === index ? { ...binding, ...changes } : binding));
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

  function loadComfyNodeProperties(nodeId: string) {
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
    setLoadedComfyNodeIds((current) => current.includes(node.id) ? current : [...current, node.id]);
    setComfyNodeError("");
    setNotice(`已加载节点 ${node.id} 的属性`);
    window.setTimeout(() => setNotice(""), 1600);
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
        outputs: leavingControl ? [] : step.outputs,
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
      const prior = new Set(priorOptions.map((option) => option.value));
      if (step.inputs.some((input) => !prior.has(input.sourceRef))) messages.push(`${step.name} 存在未连接或失效的输入引用`);
      if (step.kind === "hermes" && !step.hermesProfile) messages.push(`${step.name} 还没有选择 Hermes Profile`);
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
            const left = priorOptions.find((option) => option.value === rule.leftRef);
            if (!left) messages.push(`${step.name} 存在未连接或失效的判断变量`);
            if (rule.valueSource === "reference" && !prior.has(rule.rightRef)) messages.push(`${step.name} 存在未连接或失效的比较变量`);
            const numericOperator = ["greater_than", "greater_or_equal", "less_than", "less_or_equal"].includes(rule.operator);
            const right = priorOptions.find((option) => option.value === rule.rightRef);
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
  return (
    <div className="designer-page">
      <div className="designer-topline">
        <div>
          <div className="eyebrow"><span className="eyebrow-line" />WORKFLOW DESIGN</div>
          <h1>流程配置</h1>
          <p className="page-subtitle">按顺序配置输入、处理步骤与最终输出。</p>
        </div>
        <div className="designer-save-state"><Check size={14} />{notice || "自动保存在此设备"}</div>
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
          <div className="designer-index-footer"><CircleHelp size={14} /><span>步骤按列表顺序执行；引用只可指向输入或前序步骤输出。</span></div>
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
                <DeferredInput className="text-input schema-label-input" value={field.label} onCommit={(value) => update({ ...workflow, inputs: workflow.inputs.map((item, itemIndex) => itemIndex === index ? { ...item, label: value } : item) })} aria-label="输入名称" placeholder="输入名称" />
                <DeferredInput className="text-input schema-key-input" value={field.key} onCommit={(value) => update({ ...workflow, inputs: workflow.inputs.map((item, itemIndex) => itemIndex === index ? { ...item, key: value.replace(/[^a-zA-Z0-9_]/g, "_") } : item) })} aria-label="输入 key" placeholder="field_key" />
                <div className="select-wrap schema-type-select"><select value={field.type} onChange={(event) => update({ ...workflow, inputs: workflow.inputs.map((item, itemIndex) => itemIndex === index ? { ...item, type: event.target.value as WorkflowFieldType } : item) })} aria-label="输入类型">{Object.entries(fieldTypeLabels).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select><ChevronDown size={13} /></div>
                <label className="required-toggle"><input type="checkbox" checked={field.required} onChange={(event) => update({ ...workflow, inputs: workflow.inputs.map((item, itemIndex) => itemIndex === index ? { ...item, required: event.target.checked } : item) })} /><span>必填</span></label>
                <button className="icon-button schema-delete" onClick={() => update({ ...workflow, inputs: workflow.inputs.filter((_, itemIndex) => itemIndex !== index) })} title="删除输入" aria-label={`删除${field.label}`}><Trash2 size={14} /></button>
              </div>
              {field.type === "select" && <DeferredInput className="text-input schema-options-input" value={(field.options ?? []).join(", ")} onCommit={(value) => update({ ...workflow, inputs: workflow.inputs.map((item, itemIndex) => itemIndex === index ? { ...item, options: value.split(",").map((option) => option.trim()).filter(Boolean) } : item) })} placeholder="选项用逗号分隔" aria-label={`${field.label} 的选项`} />}
              <DeferredInput className="text-input schema-placeholder-input" value={field.placeholder ?? ""} onCommit={(value) => update({ ...workflow, inputs: workflow.inputs.map((item, itemIndex) => itemIndex === index ? { ...item, placeholder: value } : item) })} placeholder="填写提示（可选）" aria-label={`${field.label} 的填写提示`} />
            </div>)}
            <button className="designer-add-field" onClick={() => update({ ...workflow, inputs: [...workflow.inputs, newInputField(workflow.inputs.length + 1)] })}><ListPlus size={15} />添加场景输入</button>
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
                const leftType = priorReferenceOptions.find((option) => option.value === rule.leftRef)?.type;
                const operators = conditionOperators(leftType);
                const availableOperators = operators.includes(rule.operator) ? operators : [rule.operator, ...operators];
                const needsRightValue = rule.operator !== "is_empty" && rule.operator !== "is_not_empty";
                return <div className="condition-rule-row" key={rule.id || index}>
                  <div className="condition-rule-main">
                    <ReferenceSelect value={rule.leftRef} options={priorReferenceOptions} onChange={(leftRef) => updateConditionRule(index, { leftRef, operator: "equals", valueSource: "literal", rightValue: "", rightRef: "" })} />
                    <div className="select-wrap"><select value={rule.operator} onChange={(event) => updateConditionRule(index, { operator: event.target.value as WorkflowConditionOperator })} aria-label="判断运算符">{availableOperators.map((operator) => <option value={operator} key={operator}>{conditionOperatorLabels[operator]}</option>)}</select><ChevronDown size={14} /></div>
                    <button className="icon-button schema-delete" onClick={() => updateControl(selectedStep.id, (control) => ({ ...control, rules: control.rules.filter((_, ruleIndex) => ruleIndex !== index) }))} title="删除判断规则" aria-label="删除判断规则"><Trash2 size={14} /></button>
                  </div>
                  {needsRightValue ? <div className="condition-rule-value">
                    <div className="select-wrap condition-value-source"><select value={rule.valueSource} onChange={(event) => updateConditionRule(index, { valueSource: event.target.value as WorkflowConditionRule["valueSource"] })} aria-label="比较值来源"><option value="literal">常量</option><option value="reference">引用变量</option></select><ChevronDown size={13} /></div>
                    {rule.valueSource === "reference" ? <ReferenceSelect value={rule.rightRef} options={priorReferenceOptions} onChange={(rightRef) => updateConditionRule(index, { rightRef })} /> : leftType === "boolean" ? <div className="select-wrap"><select value={rule.rightValue} onChange={(event) => updateConditionRule(index, { rightValue: event.target.value })} aria-label="比较布尔值"><option value="">选择真假</option><option value="true">真</option><option value="false">假</option></select><ChevronDown size={14} /></div> : leftType === "json" ? <DeferredTextarea className="text-input condition-literal-textarea" value={rule.rightValue} onCommit={(value) => updateConditionRule(index, { rightValue: value })} placeholder="输入有效 JSON" aria-label="比较常量" /> : <DeferredInput className="text-input condition-literal-input" type={leftType === "number" ? "number" : "text"} step={leftType === "number" ? "any" : undefined} value={rule.rightValue} onCommit={(value) => updateConditionRule(index, { rightValue: value })} placeholder={leftType === "number" ? "输入数字" : "输入比较值"} aria-label="比较常量" />}
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
              {comfyFormat === "ui" && <div className="designer-profile-error" role="status">这是 ComfyUI 画布工作流，当前不能直接运行。请导出为 API 格式 JSON 后再选择。</div>}
              {comfyFormat === "unknown" && <div className="designer-profile-error" role="status">无法识别此工作流格式，请选择 ComfyUI API 格式 JSON。</div>}
              {!comfyWorkflows.length && !comfyError && <div className="comfy-workflow-empty">ComfyUI 暂无可读取的 JSON 工作流</div>}
              {selectedStep.comfyui?.workflowFile && <div className="comfy-binding-groups">
                {(["input", "output"] as const).map((direction) => {
                  const bindings = selectedComfyBindings.filter((binding) => binding.direction === direction);
                  const inputDirection = direction === "input";
                  const importableInputs = inputDirection ? workflow.inputs.filter((field) => !bindings.some((binding) => binding.key === field.key)) : [];
                  return <section className="comfy-binding-group" key={direction}>
                    <div className="comfy-binding-heading"><div><strong>{inputDirection ? "输入变量" : "输出变量"}</strong><small>{inputDirection ? "场景或前序步骤变量写入节点属性" : "从节点属性读取，供后续步骤和最终结果引用"}</small></div><div className="comfy-binding-actions">{inputDirection && <button className="text-button comfy-import-button" onClick={() => {
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
                      const suffix = `${selectedStep.id}-${direction}-${index}`.replace(/[^a-zA-Z0-9_-]/g, "-");
                      const nodeListId = `comfy-node-options-${suffix}`;
                      const propertyListId = `comfy-property-options-${suffix}`;
                      const propertyOptions = inputDirection ? node?.inputProperties ?? [] : node?.outputProperties ?? [];
                      const nodePropertiesLoaded = loadedComfyNodeIds.includes(normalizedNodeId);
                      return <div className={`comfy-binding-row ${inputDirection ? "input-binding" : "output-binding"}`} key={`comfy-binding-${direction}-${index}`}>
                        <div className="comfy-binding-variable"><DeferredInput className="text-input" value={binding.label} onCommit={(value) => updateComfyBinding(selectedStep.id, index, { label: value })} placeholder="变量名称" aria-label="变量名称" /><DeferredInput className="text-input output-key-input" value={binding.key} onCommit={(value) => updateComfyBinding(selectedStep.id, index, { key: value.replace(/[^a-zA-Z0-9_]/g, "_") })} placeholder="variable_key" aria-label="变量 key" /></div>
                        {inputDirection && <ReferenceSelect value={binding.sourceRef ?? ""} options={outputReferenceOptions(workflow, Math.max(0, selectedStepIndex)).concat(inputReferenceOptions(workflow))} onChange={(sourceRef) => updateComfyBinding(selectedStep.id, index, { sourceRef })} />}
                        <div className="comfy-node-loader"><DeferredInput className="text-input comfy-node-input" value={binding.nodeId} onCommit={(value) => { updateComfyBinding(selectedStep.id, index, { nodeId: value }); setComfyNodeError(""); }} list={nodeListId} placeholder="节点 ID" aria-label="ComfyUI 节点 ID" /><button className="icon-button comfy-node-load-button" onClick={() => loadComfyNodeProperties(binding.nodeId)} title="加载节点属性" aria-label={`加载节点 ${binding.nodeId || ""} 的属性`} disabled={comfyLoading}><RefreshCw size={13} /></button></div>
                        <datalist id={nodeListId}>{comfyNodes.map((item) => <option value={item.id} key={item.id}>{item.type}</option>)}</datalist>
                        <DeferredInput className="text-input comfy-property-input" value={binding.property} onCommit={(value) => updateComfyBinding(selectedStep.id, index, { property: value })} list={propertyListId} placeholder={inputDirection ? "节点输入属性" : "输出属性，如 images"} aria-label="ComfyUI 节点属性" />
                        <datalist id={propertyListId}>{nodePropertiesLoaded && propertyOptions.map((property) => <option value={property} key={property} />)}</datalist>
                        <div className="select-wrap schema-type-select"><select value={binding.type} onChange={(event) => updateComfyBinding(selectedStep.id, index, { type: event.target.value as WorkflowVariableType })} aria-label="变量类型">{Object.entries(inputDirection ? variableTypeLabels : outputTypeLabels).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select><ChevronDown size={13} /></div>
                        <button className="icon-button schema-delete" onClick={() => updateComfyBindings(selectedStep.id, selectedComfyBindings.filter((_, itemIndex) => itemIndex !== index))} title="删除绑定" aria-label={`删除${binding.label}绑定`}><Trash2 size={14} /></button>
                        {node && <small className="comfy-node-type">{node.type}{nodePropertiesLoaded ? ` · 已加载 ${propertyOptions.length} 个${inputDirection ? "输入" : "输出"}属性` : " · 点击加载属性"}</small>}
                      </div>;
                    })}
                    {!bindings.length && <div className="comfy-workflow-empty">还没有定义变量绑定</div>}
                  </section>;
                })}
              </div>}
            </div>}

            {selectedStep.kind !== "comfyui" && selectedStep.kind !== "control" && <div className="designer-subsection">
              <div className="designer-subsection-heading"><div><h3>步骤输入</h3><p>为当前步骤选择场景输入或前序输出</p></div><span>{selectedStep.inputs.length} 项映射</span></div>
              {selectedStep.inputs.map((input, index) => <div className="step-input-row" key={`step-input-${index}`}>
                <div className="step-input-labels"><DeferredInput className="text-input" value={input.label} onCommit={(value) => setStepInput(index, "label", value)} aria-label="输入标签" placeholder="输入名称" /><DeferredInput className="text-input" value={input.key} onCommit={(value) => setStepInput(index, "key", value.replace(/[^a-zA-Z0-9_]/g, "_") )} aria-label="输入 key" placeholder="step_input" /></div>
                <ReferenceSelect value={input.sourceRef} options={outputReferenceOptions(workflow, Math.max(0, selectedStepIndex)).concat(inputReferenceOptions(workflow))} onChange={(value) => setStepInput(index, "sourceRef", value)} />
                <button className="icon-button schema-delete" onClick={() => updateStep(selectedStep.id, (step) => ({ ...step, inputs: step.inputs.filter((_, itemIndex) => itemIndex !== index) }))} title="删除输入映射" aria-label={`删除${input.label}映射`}><Trash2 size={14} /></button>
              </div>)}
              <button className="designer-add-field" onClick={() => updateStep(selectedStep.id, (step) => ({ ...step, inputs: [...step.inputs, { key: `input_${step.inputs.length + 1}`, label: "新输入", sourceRef: "" }] }))}><Plus size={14} />添加步骤输入</button>
            </div>}

            {selectedStep.kind !== "comfyui" && selectedStep.kind !== "control" && <div className="designer-subsection">
              <div className="designer-subsection-heading"><div><h3>步骤输出</h3><p>声明此步骤提供给后续步骤的结果</p></div><span>{selectedStep.outputs.length} 项结果</span></div>
              {selectedStep.outputs.map((output, index) => <div className="step-output-row" key={`step-output-${index}`}>
                <DeferredInput className="text-input" value={output.label} onCommit={(value) => setStepOutput(index, "label", value)} aria-label="输出标签" placeholder="输出名称" />
                <DeferredInput className="text-input output-key-input" value={output.key} onCommit={(value) => setStepOutput(index, "key", value.replace(/[^a-zA-Z0-9_]/g, "_") )} aria-label="输出 key" placeholder="output_key" />
                <div className="select-wrap schema-type-select"><select value={output.type} onChange={(event) => setStepOutput(index, "type", event.target.value)} aria-label="步骤输出类型">{Object.entries(outputTypeLabels).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select><ChevronDown size={13} /></div>
                <button className="icon-button schema-delete" onClick={() => updateStep(selectedStep.id, (step) => ({ ...step, outputs: step.outputs.filter((_, itemIndex) => itemIndex !== index) }))} title="删除步骤输出" aria-label={`删除${output.label}`}><Trash2 size={14} /></button>
              </div>)}
              <button className="designer-add-field" onClick={() => updateStep(selectedStep.id, (step) => ({ ...step, outputs: [...step.outputs, { key: `output_${step.outputs.length + 1}`, label: "新输出", type: "text" }] }))}><Plus size={14} />添加步骤输出</button>
            </div>}

            {selectedStep.kind === "hermes" && <div className="designer-subsection prompt-subsection">
              <div className="designer-subsection-heading"><div><h3>提示词模板</h3><p>使用上方步骤输入，也可直接插入场景变量引用</p></div><span><Braces size={13} />变量引用</span></div>
              <div className="prompt-reference-tools"><div className="select-wrap"><select value={referenceToInsert} onChange={(event) => setReferenceToInsert(event.target.value)} aria-label="选择要插入的引用"><option value="">选择输入或前序输出</option>{promptSourceOptions.map((option) => <option key={option.value} value={option.value}>{option.label}（{option.value}）</option>)}</select><ChevronDown size={14} /></div><button type="button" className="button button-outline" onClick={insertReference} disabled={!referenceToInsert}>插入引用</button></div>
              <DeferredTextarea ref={promptRef} className="text-input prompt-textarea" value={selectedStep.promptTemplate} onCommit={(value) => updateStep(selectedStep.id, (step) => ({ ...step, promptTemplate: value }))} placeholder="编写此步骤交给 Hermes 的任务描述……" />
            </div>}
          </section>}

          <div className={`designer-validation ${validation.length ? "has-errors" : ""}`}><span className="validation-mark">{validation.length ? "!" : <Check size={12} />}</span><span>{validation.length ? validation[0] : "引用关系完整"}</span><span>{validation.length ? `${validation.length} 个待处理` : "配置已保存"}</span></div>
        </main>
      </div>
    </div>
  );
}
