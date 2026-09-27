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
  Sparkles,
  Trash2,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { scenes } from "../data/scenes";
import { loadConnectionSettings, loadHermesProfiles } from "../lib/api";
import type {
  HermesProfile,
  SceneId,
  WorkflowDefinition,
  WorkflowFieldType,
  WorkflowInputField,
  WorkflowOutputField,
  WorkflowStepDefinition,
  WorkflowStepKind,
  WorkflowStepOutput,
} from "../types";

interface FlowDesignerProps {
  sceneId: SceneId;
  workflow: WorkflowDefinition;
  onSceneChange: (sceneId: SceneId) => void;
  onChange: (workflow: WorkflowDefinition) => void;
  onOpenConnections: () => void;
}

type Selection = { kind: "inputs" } | { kind: "step"; stepId: string } | { kind: "outputs" };
type ReferenceOption = { value: string; label: string };

const fieldTypeLabels: Record<WorkflowFieldType, string> = {
  text: "单行文本",
  textarea: "多行文本",
  number: "数字",
  select: "选项",
};

const outputTypeLabels: Record<WorkflowStepOutput["type"], string> = {
  text: "文本",
  image: "图像",
  video: "视频",
  json: "结构化数据",
};

const stepKindLabels: Record<WorkflowStepKind, string> = {
  hermes: "Hermes Agent",
  comfyui_image: "ComfyUI 图像",
  comfyui_video: "ComfyUI 视频",
  manual: "人工处理",
};

function inputReferenceOptions(workflow: WorkflowDefinition): ReferenceOption[] {
  return workflow.inputs.map((field) => ({ value: `input.${field.key}`, label: `场景输入 · ${field.label}` }));
}

function outputReferenceOptions(workflow: WorkflowDefinition, maxStepIndex = workflow.steps.length): ReferenceOption[] {
  return workflow.steps.slice(0, maxStepIndex).flatMap((step) =>
    step.outputs.map((field) => ({
      value: `step.${step.id}.outputs.${field.key}`,
      label: `${step.name} · ${field.label}`,
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
    {options.map((option) => <option value={option.value} key={option.value}>{option.label}（{option.value}）</option>)}
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

export default function FlowDesigner({ sceneId, workflow, onSceneChange, onChange, onOpenConnections }: FlowDesignerProps) {
  const [selection, setSelection] = useState<Selection>({ kind: "inputs" });
  const [profiles, setProfiles] = useState<HermesProfile[]>([]);
  const [enabledProfiles, setEnabledProfiles] = useState<string[]>([]);
  const [profileError, setProfileError] = useState("");
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
    setSelection({ kind: "inputs" });
    setNotice("");
  }, [sceneId]);

  const selectedStep = selection.kind === "step" ? workflow.steps.find((step) => step.id === selection.stepId) : undefined;
  const selectedStepIndex = selectedStep ? workflow.steps.findIndex((step) => step.id === selectedStep.id) : -1;
  const sourceOptions = useMemo(() => allReferenceOptions(workflow), [workflow]);
  const promptSourceOptions = selectedStep
    ? [...inputReferenceOptions(workflow), ...outputReferenceOptions(workflow, selectedStepIndex)]
    : inputReferenceOptions(workflow);

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

  function validationMessages() {
    const messages: string[] = [];
    const inputKeys = workflow.inputs.map((field) => field.key.trim());
    if (inputKeys.some((key) => !key)) messages.push("场景输入需要设置字段 key");
    if (new Set(inputKeys).size !== inputKeys.length) messages.push("场景输入 key 不能重复");
    workflow.steps.forEach((step) => {
      const prior = new Set(allReferenceOptions({ ...workflow, steps: workflow.steps.slice(0, workflow.steps.indexOf(step)) }).map((option) => option.value));
      if (step.inputs.some((input) => !prior.has(input.sourceRef))) messages.push(`${step.name} 存在未连接或失效的输入引用`);
      if (step.kind === "hermes" && !step.hermesProfile) messages.push(`${step.name} 还没有选择 Hermes Profile`);
      if (step.outputs.some((output) => !output.key.trim())) messages.push(`${step.name} 的输出需要设置字段 key`);
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
            {workflow.inputs.map((field, index) => <div className="schema-row" key={`${field.key}-${index}`}>
              <span className="schema-row-index">{String(index + 1).padStart(2, "0")}</span>
              <div className="schema-row-main">
                <input className="text-input schema-label-input" value={field.label} onChange={(event) => update({ ...workflow, inputs: workflow.inputs.map((item, itemIndex) => itemIndex === index ? { ...item, label: event.target.value } : item) })} aria-label="输入名称" placeholder="输入名称" />
                <input className="text-input schema-key-input" value={field.key} onChange={(event) => update({ ...workflow, inputs: workflow.inputs.map((item, itemIndex) => itemIndex === index ? { ...item, key: event.target.value.replace(/[^a-zA-Z0-9_]/g, "_") } : item) })} aria-label="输入 key" placeholder="field_key" />
                <div className="select-wrap schema-type-select"><select value={field.type} onChange={(event) => update({ ...workflow, inputs: workflow.inputs.map((item, itemIndex) => itemIndex === index ? { ...item, type: event.target.value as WorkflowFieldType } : item) })} aria-label="输入类型">{Object.entries(fieldTypeLabels).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select><ChevronDown size={13} /></div>
                <label className="required-toggle"><input type="checkbox" checked={field.required} onChange={(event) => update({ ...workflow, inputs: workflow.inputs.map((item, itemIndex) => itemIndex === index ? { ...item, required: event.target.checked } : item) })} /><span>必填</span></label>
                <button className="icon-button schema-delete" onClick={() => update({ ...workflow, inputs: workflow.inputs.filter((_, itemIndex) => itemIndex !== index) })} title="删除输入" aria-label={`删除${field.label}`}><Trash2 size={14} /></button>
              </div>
              {field.type === "select" && <input className="text-input schema-options-input" value={(field.options ?? []).join(", ")} onChange={(event) => update({ ...workflow, inputs: workflow.inputs.map((item, itemIndex) => itemIndex === index ? { ...item, options: event.target.value.split(",").map((option) => option.trim()).filter(Boolean) } : item) })} placeholder="选项用逗号分隔" aria-label={`${field.label} 的选项`} />}
              <input className="text-input schema-placeholder-input" value={field.placeholder ?? ""} onChange={(event) => update({ ...workflow, inputs: workflow.inputs.map((item, itemIndex) => itemIndex === index ? { ...item, placeholder: event.target.value } : item) })} placeholder="填写提示（可选）" aria-label={`${field.label} 的填写提示`} />
            </div>)}
            <button className="designer-add-field" onClick={() => update({ ...workflow, inputs: [...workflow.inputs, newInputField(workflow.inputs.length + 1)] })}><ListPlus size={15} />添加场景输入</button>
          </section>}

          {selection.kind === "outputs" && <section className="schema-editor">
            <div className="designer-field-explainer output-explainer"><Braces size={15} /><span>最终结果可引用场景输入或任意步骤的输出。</span></div>
            {workflow.outputs.map((field, index) => <div className="final-output-row" key={`${field.key}-${index}`}>
              <span className="schema-row-index">{String(index + 1).padStart(2, "0")}</span>
              <input className="text-input" value={field.label} onChange={(event) => update({ ...workflow, outputs: workflow.outputs.map((item, itemIndex) => itemIndex === index ? { ...item, label: event.target.value } : item) })} placeholder="结果名称" aria-label="最终输出名称" />
              <input className="text-input output-key-input" value={field.key} onChange={(event) => update({ ...workflow, outputs: workflow.outputs.map((item, itemIndex) => itemIndex === index ? { ...item, key: event.target.value.replace(/[^a-zA-Z0-9_]/g, "_") } : item) })} placeholder="output_key" aria-label="最终输出 key" />
              <div className="select-wrap schema-type-select"><select value={field.type} onChange={(event) => update({ ...workflow, outputs: workflow.outputs.map((item, itemIndex) => itemIndex === index ? { ...item, type: event.target.value as WorkflowOutputField["type"] } : item) })} aria-label="输出类型">{Object.entries(outputTypeLabels).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select><ChevronDown size={13} /></div>
              <button className="icon-button schema-delete" onClick={() => update({ ...workflow, outputs: workflow.outputs.filter((_, itemIndex) => itemIndex !== index) })} title="删除输出" aria-label={`删除${field.label}`}><Trash2 size={14} /></button>
              <ReferenceSelect value={field.sourceRef} options={sourceOptions} onChange={(sourceRef) => update({ ...workflow, outputs: workflow.outputs.map((item, itemIndex) => itemIndex === index ? { ...item, sourceRef } : item) })} />
            </div>)}
            <button className="designer-add-field" onClick={() => update({ ...workflow, outputs: [...workflow.outputs, newOutputField(workflow.outputs.length + 1)] })}><ListPlus size={15} />添加最终输出</button>
          </section>}

          {selection.kind === "step" && selectedStep && <section className="step-editor">
            <div className="designer-form-row">
              <div className="field-group"><label className="field-label">步骤名称</label><input className="text-input" value={selectedStep.name} onChange={(event) => updateStep(selectedStep.id, (step) => ({ ...step, name: event.target.value }))} /></div>
              <div className="field-group"><label className="field-label">执行方式</label><div className="select-wrap"><select value={selectedStep.kind} onChange={(event) => updateStep(selectedStep.id, (step) => ({ ...step, kind: event.target.value as WorkflowStepKind }))}><option value="hermes">Hermes Agent</option><option value="comfyui_image">ComfyUI 图像</option><option value="comfyui_video">ComfyUI 视频</option><option value="manual">人工处理</option></select><ChevronDown size={14} /></div></div>
            </div>
            {selectedStep.kind === "hermes" && <div className="step-profile-row"><div className="field-group"><label className="field-label">Hermes Profile</label><div className="select-wrap"><select value={selectedStep.hermesProfile ?? ""} onChange={(event) => updateStep(selectedStep.id, (step) => ({ ...step, hermesProfile: event.target.value }))}><option value="">选择 Profile</option>{profiles.map((profile) => <option value={profile.id} key={profile.id}>{profile.id}{profile.isDefault ? "（默认）" : enabledProfiles.includes(profile.id) ? "（已启用）" : "（未启用）"}</option>)}</select><ChevronDown size={14} /></div></div><button className="text-button" onClick={onOpenConnections}>管理 Profile <ArrowRight size={13} /></button></div>}
            {profileError && <div className="designer-profile-error">{profileError}</div>}

            <div className="designer-subsection">
              <div className="designer-subsection-heading"><div><h3>步骤输入</h3><p>为当前步骤选择场景输入或前序输出</p></div><span>{selectedStep.inputs.length} 项映射</span></div>
              {selectedStep.inputs.map((input, index) => <div className="step-input-row" key={`${input.key}-${index}`}>
                <div className="step-input-labels"><input className="text-input" value={input.label} onChange={(event) => setStepInput(index, "label", event.target.value)} aria-label="输入标签" placeholder="输入名称" /><input className="text-input" value={input.key} onChange={(event) => setStepInput(index, "key", event.target.value.replace(/[^a-zA-Z0-9_]/g, "_") )} aria-label="输入 key" placeholder="step_input" /></div>
                <ReferenceSelect value={input.sourceRef} options={outputReferenceOptions(workflow, Math.max(0, selectedStepIndex)).concat(inputReferenceOptions(workflow))} onChange={(value) => setStepInput(index, "sourceRef", value)} />
                <button className="icon-button schema-delete" onClick={() => updateStep(selectedStep.id, (step) => ({ ...step, inputs: step.inputs.filter((_, itemIndex) => itemIndex !== index) }))} title="删除输入映射" aria-label={`删除${input.label}映射`}><Trash2 size={14} /></button>
              </div>)}
              <button className="designer-add-field" onClick={() => updateStep(selectedStep.id, (step) => ({ ...step, inputs: [...step.inputs, { key: `input_${step.inputs.length + 1}`, label: "新输入", sourceRef: "" }] }))}><Plus size={14} />添加步骤输入</button>
            </div>

            <div className="designer-subsection">
              <div className="designer-subsection-heading"><div><h3>步骤输出</h3><p>声明此步骤提供给后续步骤的结果</p></div><span>{selectedStep.outputs.length} 项结果</span></div>
              {selectedStep.outputs.map((output, index) => <div className="step-output-row" key={`${output.key}-${index}`}>
                <input className="text-input" value={output.label} onChange={(event) => setStepOutput(index, "label", event.target.value)} aria-label="输出标签" placeholder="输出名称" />
                <input className="text-input output-key-input" value={output.key} onChange={(event) => setStepOutput(index, "key", event.target.value.replace(/[^a-zA-Z0-9_]/g, "_") )} aria-label="输出 key" placeholder="output_key" />
                <div className="select-wrap schema-type-select"><select value={output.type} onChange={(event) => setStepOutput(index, "type", event.target.value)} aria-label="步骤输出类型">{Object.entries(outputTypeLabels).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select><ChevronDown size={13} /></div>
                <button className="icon-button schema-delete" onClick={() => updateStep(selectedStep.id, (step) => ({ ...step, outputs: step.outputs.filter((_, itemIndex) => itemIndex !== index) }))} title="删除步骤输出" aria-label={`删除${output.label}`}><Trash2 size={14} /></button>
              </div>)}
              <button className="designer-add-field" onClick={() => updateStep(selectedStep.id, (step) => ({ ...step, outputs: [...step.outputs, { key: `output_${step.outputs.length + 1}`, label: "新输出", type: "text" }] }))}><Plus size={14} />添加步骤输出</button>
            </div>

            {selectedStep.kind === "hermes" && <div className="designer-subsection prompt-subsection">
              <div className="designer-subsection-heading"><div><h3>提示词模板</h3><p>使用上方步骤输入，也可直接插入场景变量引用</p></div><span><Braces size={13} />变量引用</span></div>
              <div className="prompt-reference-tools"><div className="select-wrap"><select value={referenceToInsert} onChange={(event) => setReferenceToInsert(event.target.value)} aria-label="选择要插入的引用"><option value="">选择输入或前序输出</option>{promptSourceOptions.map((option) => <option key={option.value} value={option.value}>{option.label}（{option.value}）</option>)}</select><ChevronDown size={14} /></div><button type="button" className="button button-outline" onClick={insertReference} disabled={!referenceToInsert}>插入引用</button></div>
              <textarea ref={promptRef} className="text-input prompt-textarea" value={selectedStep.promptTemplate} onChange={(event) => updateStep(selectedStep.id, (step) => ({ ...step, promptTemplate: event.target.value }))} placeholder="编写此步骤交给 Hermes 的任务描述……" />
            </div>}
          </section>}

          <div className={`designer-validation ${validation.length ? "has-errors" : ""}`}><span className="validation-mark">{validation.length ? "!" : <Check size={12} />}</span><span>{validation.length ? validation[0] : "引用关系完整"}</span><span>{validation.length ? `${validation.length} 个待处理` : "配置已保存"}</span></div>
        </main>
      </div>
    </div>
  );
}
