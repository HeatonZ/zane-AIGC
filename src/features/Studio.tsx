import { ArrowLeft, Check, ChevronDown, CircleHelp, Film, Package, Save, Sparkles } from "lucide-react";
import { useState, type FormEvent } from "react";
import { scenes } from "../data/scenes";
import type { SceneId, WorkflowDefinition, WorkflowDraft, WorkflowInputField } from "../types";

interface StudioProps {
  sceneId: SceneId;
  workflow: WorkflowDefinition;
  onBack: () => void;
  onSaveDraft: (draft: WorkflowDraft) => void;
}

function DynamicField({
  field,
  value,
  onChange,
}: {
  field: WorkflowInputField;
  value: string;
  onChange: (value: string) => void;
}) {
  const id = `studio-input-${field.key}`;
  const controlClass = `text-input studio-dynamic-control${field.type === "textarea" ? " text-area" : ""}`;

  return (
    <div className={`studio-dynamic-field ${field.type === "textarea" ? "wide-field" : ""}`}>
      <label className="field-label" htmlFor={id}>{field.label}{field.required && <span>必填</span>}</label>
      {field.type === "textarea" ? (
        <textarea id={id} className={controlClass} value={value} onChange={(event) => onChange(event.target.value)} placeholder={field.placeholder} required={field.required} />
      ) : field.type === "select" ? (
        <div className="select-wrap"><select id={id} value={value} onChange={(event) => onChange(event.target.value)} required={field.required}>
          <option value="">请选择</option>
          {(field.options ?? []).map((option) => <option value={option} key={option}>{option}</option>)}
        </select><ChevronDown size={15} /></div>
      ) : (
        <input id={id} className={controlClass} type={field.type === "number" ? "number" : "text"} value={value} onChange={(event) => onChange(event.target.value)} placeholder={field.placeholder} required={field.required} />
      )}
    </div>
  );
}

export default function Studio({ sceneId, workflow, onBack, onSaveDraft }: StudioProps) {
  const scene = scenes.find((item) => item.id === sceneId) ?? scenes[0];
  const [values, setValues] = useState<Record<string, string>>({});
  const [saved, setSaved] = useState(false);

  function updateValue(key: string, value: string) {
    setValues((current) => ({ ...current, [key]: value }));
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    const inputValues = Object.fromEntries(workflow.inputs.map((field) => {
      const value = values[field.key] ?? "";
      return [field.key, field.type === "number" && value !== "" ? Number(value) : value];
    }));
    const titleField = workflow.inputs.find((field) => field.key === "project_name") ?? workflow.inputs[0];
    const title = String((titleField && inputValues[titleField.key]) || `${scene.shortTitle}草稿`).trim();
    const summary = workflow.inputs
      .map((field) => ({ field, value: inputValues[field.key] }))
      .filter(({ value }) => value !== "" && value !== undefined)
      .map(({ field, value }) => `${field.label}：${value}`)
      .join(" · ");

    onSaveDraft({
      id: crypto.randomUUID(),
      sceneId,
      title,
      summary: summary || workflow.name,
      inputValues,
      createdAt: new Date().toISOString(),
      status: "draft",
    });
    setSaved(true);
    window.setTimeout(() => setSaved(false), 2600);
  }

  return (
    <div className="studio-page">
      <button className="back-link" onClick={onBack}><ArrowLeft size={15} />返回工作台</button>
      <div className="studio-heading">
        <div>
          <div className={`eyebrow`}><span className={`eyebrow-line ${scene.accent === "coral" ? "coral-line" : ""}`} />{scene.title.toUpperCase()}</div>
          <h1>{scene.title}</h1>
          <p className="page-subtitle">{scene.description}</p>
        </div>
        <span className={`studio-heading-mark ${scene.accent}`}><Sparkles size={20} /></span>
      </div>
      <div className="studio-layout">
        <form className="studio-form" onSubmit={submit}>
          <div className="form-intro">
            <span className={`scene-icon-box ${scene.accent}`}>{sceneId === "comic" ? <Film size={18} /> : <Package size={18} />}</span>
            <div><h2>{workflow.name}</h2><p>{scene.description}</p></div>
          </div>

          <div className="studio-input-grid">
            {workflow.inputs.map((field) => <DynamicField key={field.key} field={field} value={values[field.key] ?? ""} onChange={(value) => updateValue(field.key, value)} />)}
          </div>

          <div className="workflow-preview">
            <div className="workflow-preview-heading"><div><span className={`eyebrow-line ${scene.accent === "coral" ? "coral-line" : ""}`} /><h3>工作流程</h3></div><span>{workflow.steps.length} 个步骤</span></div>
            <div className="workflow-steps">
              {workflow.steps.map((step, index) => (
                <div className={`workflow-step ${index === 0 ? `current ${scene.accent === "coral" ? "coral-current" : ""}` : ""}`} key={step.id}>
                  <span className="step-index">{String(index + 1).padStart(2, "0")}</span><strong>{step.name}</strong>
                  {index < workflow.steps.length - 1 && <span className="step-line" />}
                </div>
              ))}
            </div>
          </div>

          <div className="form-actions">
            <span className="form-save-hint">草稿保存在此设备</span>
            <button className="button button-dark" type="submit"><Save size={15} />{saved ? <><Check size={15} />已保存</> : "保存任务草稿"}</button>
          </div>
        </form>
        <aside className="studio-aside">
          <div className={`studio-aside-image ${scene.accent}`}><img src={scene.cover} alt="" style={{ objectPosition: scene.coverPosition }} /><span>{scene.shortTitle}制作</span></div>
          <div className="aside-section">
            <span className="aside-label">最终输出</span>
            {workflow.outputs.length ? <ul className="output-list">
              {workflow.outputs.map((output) => <li key={output.key}><Check size={14} /><span>{output.label}</span></li>)}
            </ul> : <div className="studio-empty-outputs"><CircleHelp size={14} />尚未定义最终输出</div>}
          </div>
          <div className="aside-note"><CircleHelp size={15} /><span>保存后创建本地草稿。</span></div>
        </aside>
      </div>
    </div>
  );
}
