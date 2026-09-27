import { ArrowLeft, Check, ChevronDown, CircleHelp, Film, Image as ImageIcon, LoaderCircle, Package, Play, Save, Sparkles } from "lucide-react";
import { useRef, useState, type FormEvent, type MouseEvent } from "react";
import { scenes } from "../data/scenes";
import { runWorkflow } from "../lib/api";
import type { JsonValue, SceneId, WorkflowDefinition, WorkflowDraft, WorkflowInputField, WorkflowRunOutput, WorkflowRunResult } from "../types";

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
  const [running, setRunning] = useState(false);
  const [runResult, setRunResult] = useState<WorkflowRunResult | null>(null);
  const formRef = useRef<HTMLFormElement>(null);

  function updateValue(key: string, value: string) {
    setValues((current) => ({ ...current, [key]: value }));
    setFormError("");
    setRunResult(null);
  }

  function collectInputValues(): Record<string, JsonValue> {
    const inputValues: Record<string, JsonValue> = {};
    for (const field of workflow.inputs) {
      const value = values[field.key] ?? "";
      if (field.required && value.trim() === "") throw new Error(`请填写必填字段：${field.label}`);
      if (field.type === "number") {
        if (!value.trim()) inputValues[field.key] = null;
        else {
          const number = Number(value);
          if (!Number.isFinite(number)) throw new Error(`${field.label} 需要填写有效数字`);
          inputValues[field.key] = number;
        }
      } else if (field.type === "boolean") inputValues[field.key] = value === "" ? null : value === "true";
      else if (field.type === "json") {
        if (!value.trim()) inputValues[field.key] = null;
        else {
          try {
            inputValues[field.key] = JSON.parse(value) as JsonValue;
          } catch {
            throw new Error(`${field.label} 需要填写有效 JSON`);
          }
        }
      } else inputValues[field.key] = value;
    }
    return inputValues;
  }

  function draftFor(inputValues: Record<string, JsonValue>, result?: WorkflowRunResult): WorkflowDraft {
    const titleField = workflow.inputs.find((field) => field.key === "project_name") ?? workflow.inputs[0];
    const titleValue = titleField ? inputValues[titleField.key] : undefined;
    const title = (typeof titleValue === "string" || typeof titleValue === "number" ? String(titleValue) : "").trim() || `${scene.shortTitle}草稿`;
    const summary = workflow.inputs
      .map((field) => ({ field, value: inputValues[field.key] }))
      .filter(({ value }) => value !== "" && value !== undefined && value !== null)
      .map(({ field, value }) => `${field.label}：${typeof value === "boolean" ? (value ? "是" : "否") : typeof value === "object" ? JSON.stringify(value) : value}`)
      .join(" · ");
    return {
      id: crypto.randomUUID(),
      sceneId,
      title,
      summary: summary || workflow.name,
      inputValues,
      createdAt: new Date().toISOString(),
      status: result?.status === "completed" ? "completed" : result?.status === "failed" ? "failed" : "draft",
      runResult: result,
    };
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    try {
      onSaveDraft(draftFor(collectInputValues()));
      setSaved(true);
      window.setTimeout(() => setSaved(false), 2600);
    } catch (error) {
      setFormError(error instanceof Error ? error.message : "输入格式无效");
    }
  }

  async function run(event: MouseEvent<HTMLButtonElement>) {
    event.preventDefault();
    if (!formRef.current?.reportValidity()) return;
    setFormError("");
    setRunning(true);
    setRunResult(null);
    try {
      const inputValues = collectInputValues();
      const result = await runWorkflow(workflow, inputValues);
      setRunResult(result);
      onSaveDraft(draftFor(inputValues, result));
    } catch (error) {
      setFormError(error instanceof Error ? error.message : "流程执行失败");
    } finally {
      setRunning(false);
    }
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
        <form ref={formRef} className="studio-form" onSubmit={submit}>
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
            <div className="studio-action-buttons">
              <button className="button button-outline" type="submit" disabled={running}><Save size={15} />{saved ? <><Check size={15} />已保存</> : "保存草稿"}</button>
              <button className="button button-dark" type="button" onClick={run} disabled={running}><>{running ? <LoaderCircle className="spin" size={15} /> : <Play size={15} />}{running ? "运行中…" : "运行流程"}</></button>
            </div>
          </div>
          {runResult && <WorkflowRunPanel result={runResult} />}
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

function mediaItems(value: JsonValue) {
  const items = Array.isArray(value) ? value : [value];
  return items.flatMap((item) => {
    if (typeof item === "string" && /^(https?:\/\/|\/api\/comfyui\/view)/i.test(item)) return [{ url: item, filename: item }];
    if (!item || typeof item !== "object" || Array.isArray(item) || typeof item.url !== "string") return [];
    return [{ url: item.url, filename: typeof item.filename === "string" ? item.filename : item.url }];
  });
}

function outputText(output: WorkflowRunOutput) {
  if (typeof output.value === "boolean") return output.value ? "真" : "假";
  if (output.value === null) return "无结果";
  if (typeof output.value === "object") return JSON.stringify(output.value, null, 2);
  return String(output.value);
}

function WorkflowRunPanel({ result }: { result: WorkflowRunResult }) {
  return (
    <section className={`workflow-run-result ${result.status}`} aria-live="polite">
      <div className="workflow-run-heading">
        <div><h3>{result.status === "completed" ? "运行完成" : "运行失败"}</h3><span>{result.steps.filter((step) => step.status === "completed").length} 步完成 · {result.steps.filter((step) => step.status === "skipped").length} 步跳过</span></div>
        <small>{result.runId.slice(0, 8)}</small>
      </div>
      {result.error && <div className="workflow-run-error" role="alert">{result.error}</div>}
      <ol className="workflow-run-steps">
        {result.steps.map((step) => <li key={step.stepId} className={step.status}><span>{step.name}</span><small>{step.status === "completed" ? "完成" : step.status === "skipped" ? "跳过" : "失败"}{step.message ? ` · ${step.message}` : ""}</small></li>)}
      </ol>
      {!!result.outputs.length && <div className="workflow-run-outputs">
        {result.outputs.map((output) => {
          const media = output.type === "image" || output.type === "video" ? mediaItems(output.value) : [];
          return <article className="workflow-run-output" key={output.key}>
            <div className="workflow-run-output-heading"><strong>{output.label}</strong><small>{output.type}</small></div>
            {media.length ? <div className="workflow-run-media">{media.map((item) => output.type === "video"
              ? <video src={item.url} controls preload="metadata" key={item.url} aria-label={item.filename} />
              : <a href={item.url} target="_blank" rel="noreferrer" key={item.url}><img src={item.url} alt={item.filename} loading="lazy" /></a>)}</div>
              : <pre>{outputText(output)}</pre>}
          </article>;
        })}
      </div>}
    </section>
  );
}
