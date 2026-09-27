import { ArrowLeft, Check, ChevronDown, CircleHelp, Film, Image as ImageIcon, Package, Save, Sparkles } from "lucide-react";
import { useState, type FormEvent } from "react";
import { scenes } from "../data/scenes";
import type { JsonValue, SceneId, WorkflowDefinition, WorkflowDraft, WorkflowInputField } from "../types";

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
      ) : field.type === "json" ? (
        <textarea id={id} className={`${controlClass} json-input-control`} value={value} onChange={(event) => onChange(event.target.value)} placeholder={field.placeholder ?? '{ "key": "value" }'} required={field.required} />
      ) : field.type === "boolean" ? (
        <div className="boolean-options" role="radiogroup" aria-label={field.label}>
          {!field.required && <label><input type="radio" name={id} value="" checked={value === ""} onChange={(event) => onChange(event.target.value)} /><span>未设置</span></label>}
          <label><input type="radio" name={id} value="true" checked={value === "true"} onChange={(event) => onChange(event.target.value)} required={field.required} /><span>是</span></label>
          <label><input type="radio" name={id} value="false" checked={value === "false"} onChange={(event) => onChange(event.target.value)} required={field.required} /><span>否</span></label>
        </div>
      ) : field.type === "select" ? (
        <div className="select-wrap"><select id={id} value={value} onChange={(event) => onChange(event.target.value)} required={field.required}>
          <option value="">请选择</option>
          {(field.options ?? []).map((option) => <option value={option} key={option}>{option}</option>)}
        </select><ChevronDown size={15} /></div>
      ) : (
        <input id={id} className={controlClass} type={field.type === "number" ? "number" : "text"} step={field.type === "number" ? "any" : undefined} value={value} onChange={(event) => onChange(event.target.value)} placeholder={field.placeholder ?? (field.type === "image" || field.type === "video" ? "输入资源 URL 或文件路径" : undefined)} required={field.required} />
      )}
    </div>
  );
}

export default function Studio({ sceneId, workflow, onBack, onSaveDraft }: StudioProps) {
  const scene = scenes.find((item) => item.id === sceneId) ?? scenes[0];
  const [values, setValues] = useState<Record<string, string>>({});
  const [saved, setSaved] = useState(false);
  const [formError, setFormError] = useState("");

  function updateValue(key: string, value: string) {
    setValues((current) => ({ ...current, [key]: value }));
    setFormError("");
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    const inputValues: Record<string, JsonValue> = {};
    for (const field of workflow.inputs) {
      const value = values[field.key] ?? "";
      if (field.type === "number") inputValues[field.key] = value === "" ? null : Number(value);
      else if (field.type === "boolean") inputValues[field.key] = value === "" ? null : value === "true";
      else if (field.type === "json") {
        if (!value.trim()) inputValues[field.key] = null;
        else {
          try {
            inputValues[field.key] = JSON.parse(value) as JsonValue;
          } catch {
            setFormError(`${field.label} 需要填写有效 JSON`);
            return;
          }
        }
      } else inputValues[field.key] = value;
    }
    const titleField = workflow.inputs.find((field) => field.key === "project_name") ?? workflow.inputs[0];
    const titleValue = titleField ? inputValues[titleField.key] : undefined;
    const title = (typeof titleValue === "string" || typeof titleValue === "number" ? String(titleValue) : "").trim() || `${scene.shortTitle}草稿`;
    const summary = workflow.inputs
      .map((field) => ({ field, value: inputValues[field.key] }))
      .filter(({ value }) => value !== "" && value !== undefined && value !== null)
      .map(({ field, value }) => `${field.label}：${typeof value === "boolean" ? (value ? "是" : "否") : typeof value === "object" ? JSON.stringify(value) : value}`)
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
            <span className={`scene-icon-box ${scene.accent}`}>{sceneId === "comic" ? <Film size={18} /> : sceneId === "commerce" ? <Package size={18} /> : <ImageIcon size={18} />}</span>
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
            {formError && <div className="studio-form-error" role="alert">{formError}</div>}
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
