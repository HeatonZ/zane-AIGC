import { ArrowDown, ArrowLeft, ArrowUp, Check, ChevronDown, CircleHelp, Film, FolderOpen, Image as ImageIcon, LoaderCircle, Music2, Package, Play, Plus, Save, Sparkles, Trash2 } from "lucide-react";
import { useEffect, useRef, useState, type FormEvent, type MouseEvent } from "react";
import { loadConnectionSettings, pickLocalMediaFile, uploadComfyUIAudio, uploadComfyUIImage } from "../lib/api";
import { createId } from "../lib/ids";
import JsonEditor from "../components/JsonEditor";
import WorkflowRunPanel from "../components/WorkflowRunPanel";
import type { ComfyAudioAttachment, ComfyImageAttachment, JsonValue, PageId, SceneId, SceneModule, WorkflowDefinition, WorkflowDraft, WorkflowInputField, WorkflowRunResult } from "../types";

interface StudioProps {
  sceneId: SceneId;
  scene: SceneModule;
  workflow: WorkflowDefinition;
  draft?: WorkflowDraft;
  onNavigate: (page: PageId) => void;
  onBack: () => void;
  onSaveDraft: (draft: WorkflowDraft) => void;
  onStartRun: (workflow: WorkflowDefinition, inputValues: Record<string, JsonValue>, runId: string, runTitle?: string) => Promise<WorkflowRunResult>;
  onCancelRun: (runId: string) => void;
}

function draftInputValues(workflow: WorkflowDefinition, draft?: WorkflowDraft): Record<string, string> {
  return Object.fromEntries(workflow.inputs.map((field) => {
    const value = draft?.inputValues?.[field.key];
    if (value === undefined || value === null) return [field.key, ""];
    if (typeof value === "boolean") return [field.key, value ? "true" : "false"];
    if (typeof value === "object") return [field.key, JSON.stringify(value)];
    return [field.key, String(value)];
  }));
}

function imageAttachments(value: string): ComfyImageAttachment[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is ComfyImageAttachment => {
      if (typeof item !== "object" || item === null) return false;
      const candidate = item as Partial<ComfyImageAttachment>;
      return typeof candidate.id === "string" && typeof candidate.filename === "string" && typeof candidate.url === "string";
    });
  } catch {
    return [];
  }
}

function audioAttachment(value: string): ComfyAudioAttachment | null {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (typeof parsed !== "object" || parsed === null) return null;
    const candidate = parsed as Partial<ComfyAudioAttachment>;
    return typeof candidate.id === "string"
      && typeof candidate.filename === "string"
      && typeof candidate.subfolder === "string"
      && candidate.type === "input"
      && typeof candidate.url === "string"
      ? candidate as ComfyAudioAttachment
      : null;
  } catch {
    return null;
  }
}

function DynamicField({
  field,
  value,
  onChange,
  onPickFile,
  onPickImage,
  onPickAudio,
  onChangeImageOrder,
  picking,
  pickerBusy,
}: {
  field: WorkflowInputField;
  value: string;
  onChange: (value: string) => void;
  onPickFile: (type: "image" | "video") => void;
  onPickImage: (file: File) => void;
  onPickAudio: (file: File) => void;
  onChangeImageOrder: (attachments: ComfyImageAttachment[]) => void;
  picking: boolean;
  pickerBusy: boolean;
}) {
  const id = `studio-input-${field.key}`;
  const multiline = field.type === "textarea" || field.type === "json";
  const controlClass = `text-input studio-dynamic-control${multiline ? " text-area" : ""}`;
  const imageFileInputRef = useRef<HTMLInputElement>(null);
  const audioFileInputRef = useRef<HTMLInputElement>(null);
  const attachments = field.type === "image_list" ? imageAttachments(value) : [];
  const audio = field.type === "audio" ? audioAttachment(value) : null;

  return (
    <div className={`studio-dynamic-field ${multiline ? "wide-field" : ""}`}>
      <label className="field-label" htmlFor={id}>{field.label}{field.required && <span>必填</span>}</label>
      {field.type === "json" ? (
        <JsonEditor id={id} value={value} onChange={onChange} required={field.required} placeholder={field.placeholder} />
      ) : multiline ? (
        <textarea id={id} className={controlClass} value={value} onChange={(event) => onChange(event.target.value)} placeholder={field.placeholder} required={field.required} />
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
      ) : field.type === "image_list" ? (
        <div className="studio-image-list-control">
          <input ref={imageFileInputRef} className="studio-hidden-file-input" type="file" accept="image/*" onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = "";
            if (file) onPickImage(file);
          }} />
          <div className="studio-image-list-toolbar">
            <span>{attachments.length ? `已添加 ${attachments.length} 张，按序作为参考图` : "还没有添加参考图"}</span>
            <button className="button button-outline studio-add-image" type="button" onClick={() => imageFileInputRef.current?.click()} disabled={pickerBusy}>
              {picking ? <LoaderCircle className="spin" size={14} /> : <Plus size={14} />}
              <span>{picking ? "上传中" : "逐张添加"}</span>
            </button>
          </div>
          {attachments.length > 0 && <ol className="studio-image-list">
            {attachments.map((attachment, index) => <li key={attachment.id}>
              <img src={attachment.url} alt="" />
              <span className="studio-image-index">{String(index + 1).padStart(2, "0")}</span>
              <span className="studio-image-name" title={attachment.filename}>{attachment.filename}</span>
              <div className="studio-image-actions">
                <button className="tiny-icon-button" type="button" title="上移" aria-label="上移" disabled={index === 0} onClick={() => {
                  const next = [...attachments];
                  [next[index - 1], next[index]] = [next[index], next[index - 1]];
                  onChangeImageOrder(next);
                }}><ArrowUp size={13} /></button>
                <button className="tiny-icon-button" type="button" title="下移" aria-label="下移" disabled={index === attachments.length - 1} onClick={() => {
                  const next = [...attachments];
                  [next[index], next[index + 1]] = [next[index + 1], next[index]];
                  onChangeImageOrder(next);
                }}><ArrowDown size={13} /></button>
                <button className="tiny-icon-button studio-remove-image" type="button" title="移除" aria-label="移除" onClick={() => onChangeImageOrder(attachments.filter((_, itemIndex) => itemIndex !== index))}><Trash2 size={13} /></button>
              </div>
            </li>)}
          </ol>}
        </div>
      ) : field.type === "audio" ? (
        <div className="studio-audio-control">
          <input ref={audioFileInputRef} className="studio-hidden-file-input" type="file" accept="audio/*,.aac,.aif,.aiff,.flac,.m4a,.mp3,.ogg,.opus,.wav" onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = "";
            if (file) onPickAudio(file);
          }} />
          <div className="studio-audio-row">
            <span className="studio-audio-name" title={audio?.filename ?? ""}>{audio ? <><Music2 size={14} />{audio.filename}</> : "尚未上传音频"}</span>
            <div className="studio-audio-actions">
              {audio && <button className="icon-button studio-audio-remove" type="button" title="移除音频" aria-label="移除音频" onClick={() => onChange("")}><Trash2 size={14} /></button>}
              <button className="button button-outline studio-file-picker" type="button" onClick={() => audioFileInputRef.current?.click()} disabled={pickerBusy}>
                {picking ? <LoaderCircle className="spin" size={14} /> : <FolderOpen size={14} />}
                <span>{picking ? "上传中" : audio ? "更换音频" : "选择音频"}</span>
              </button>
            </div>
          </div>
          {audio && <audio controls preload="metadata" src={audio.url} />}
        </div>
      ) : field.type === "image" || field.type === "video" ? (
        <div className="studio-media-control">
          <input id={id} className={controlClass} type="text" value={value} onChange={(event) => onChange(event.target.value)} placeholder={field.placeholder ?? "输入资源 URL 或文件路径"} required={field.required} />
          <button className="button button-outline studio-file-picker" type="button" onClick={() => onPickFile(field.type as "image" | "video")} disabled={pickerBusy}>
            {picking ? <LoaderCircle className="spin" size={14} /> : <FolderOpen size={14} />}
            <span>{picking ? "打开中" : "选择文件"}</span>
          </button>
        </div>
      ) : (
        <input id={id} className={controlClass} type={field.type === "number" ? "number" : "text"} step={field.type === "number" ? "any" : undefined} value={value} onChange={(event) => onChange(event.target.value)} placeholder={field.placeholder} required={field.required} />
      )}
    </div>
  );
}

export default function Studio({ sceneId, scene, workflow, draft, onNavigate, onBack, onSaveDraft, onStartRun, onCancelRun }: StudioProps) {
  const [values, setValues] = useState<Record<string, string>>(() => draftInputValues(workflow, draft));
  const [runTitle, setRunTitle] = useState(() => draft?.runTitle ?? "");
  const [saved, setSaved] = useState(false);
  const [formError, setFormError] = useState("");
  const [running, setRunning] = useState(false);
  const [projectDirectory, setProjectDirectory] = useState<string | null>(null);
  const [pickingField, setPickingField] = useState<string | null>(null);
  const [runResult, setRunResult] = useState<WorkflowRunResult | null>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const currentRunIdRef = useRef<string | null>(null);
  const draftIdRef = useRef<string | null>(draft?.id ?? null);

  useEffect(() => {
    draftIdRef.current = draft?.id ?? null;
    setValues(draftInputValues(workflow, draft));
    setRunTitle(draft?.runTitle ?? "");
    setRunResult(draft?.runResult ?? null);
    setFormError("");
  }, [draft, sceneId, workflow]);

  useEffect(() => {
    let active = true;
    loadConnectionSettings()
      .then((settings) => { if (active) setProjectDirectory(settings.projectDirectory); })
      .catch(() => { if (active) setProjectDirectory(""); });
    return () => { active = false; };
  }, []);

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
      if (field.type === "image_list") {
        const attachments = imageAttachments(value);
        if (field.required && attachments.length === 0) throw new Error(`${field.label} 至少需要一张图片`);
        inputValues[field.key] = attachments as unknown as JsonValue;
      } else if (field.type === "audio") {
        if (!value.trim()) inputValues[field.key] = null;
        else {
          const attachment = audioAttachment(value);
          if (!attachment) throw new Error(`${field.label} 需要选择有效的音频文件`);
          inputValues[field.key] = attachment as unknown as JsonValue;
        }
      } else if (field.type === "number") {
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
    const title = runTitle.trim() || (typeof titleValue === "string" || typeof titleValue === "number" ? String(titleValue) : "").trim() || `${scene.shortTitle}草稿`;
    const summary = workflow.inputs
      .map((field) => ({ field, value: inputValues[field.key] }))
      .filter(({ value }) => value !== "" && value !== undefined && value !== null)
      .map(({ field, value }) => `${field.label}：${(field.type === "image_list" || field.type === "audio") && value && typeof value === "object" && !Array.isArray(value) && "filename" in value ? String(value.filename) : field.type === "image_list" && Array.isArray(value) ? value.map((item) => typeof item === "object" && item !== null && "filename" in item ? String(item.filename) : "图片").join("、") : typeof value === "boolean" ? (value ? "是" : "否") : typeof value === "object" ? JSON.stringify(value) : value}`)
      .join(" · ");
    return {
      id: draftIdRef.current ?? (draftIdRef.current = createId()),
      sceneId,
      title,
      ...(runTitle.trim() ? { runTitle: runTitle.trim() } : {}),
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
      onSaveDraft(draftFor(inputValues));
      const runId = createId();
      currentRunIdRef.current = runId;
      const result = await onStartRun(workflow, inputValues, runId, runTitle.trim() || undefined);
      setRunResult(result);
      onSaveDraft(draftFor(inputValues, result));
    } catch (error) {
      setFormError(error instanceof Error ? error.message : "流程执行失败");
    } finally {
      currentRunIdRef.current = null;
      setRunning(false);
    }
  }

  async function pickFile(key: string, type: "image" | "video") {
    setPickingField(key);
    setFormError("");
    try {
      const filePath = await pickLocalMediaFile(type);
      if (filePath) updateValue(key, filePath);
    } catch (error) {
      setFormError(error instanceof Error ? error.message : "无法打开文件选择器");
    } finally {
      setPickingField(null);
    }
  }

  function cancelRun() {
    if (currentRunIdRef.current) onCancelRun(currentRunIdRef.current);
  }

  async function addImage(key: string, file: File) {
    setPickingField(key);
    setFormError("");
    try {
      const attachment = await uploadComfyUIImage(file);
      const attachments = imageAttachments(values[key] ?? "");
      updateValue(key, JSON.stringify([...attachments, attachment]));
    } catch (error) {
      setFormError(error instanceof Error ? error.message : "无法上传图片");
    } finally {
      setPickingField(null);
    }
  }

  async function addAudio(key: string, file: File) {
    setPickingField(key);
    setFormError("");
    try {
      const attachment = await uploadComfyUIAudio(file);
      updateValue(key, JSON.stringify(attachment));
    } catch (error) {
      setFormError(error instanceof Error ? error.message : "无法上传音频");
    } finally {
      setPickingField(null);
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
            <div className="studio-dynamic-field wide-field">
              <label className="field-label" htmlFor="studio-run-title">作品标题（可选）</label>
              <input id="studio-run-title" className="text-input studio-dynamic-control" type="text" maxLength={120} value={runTitle} onChange={(event) => { setRunTitle(event.target.value); setFormError(""); setRunResult(null); }} placeholder="方便在运行记录中查找" />
            </div>
            {workflow.inputs.map((field) => <DynamicField key={field.key} field={field} value={values[field.key] ?? ""} onChange={(value) => updateValue(field.key, value)} onPickFile={(type) => void pickFile(field.key, type)} onPickImage={(file) => void addImage(field.key, file)} onPickAudio={(file) => void addAudio(field.key, file)} onChangeImageOrder={(attachments) => updateValue(field.key, JSON.stringify(attachments))} picking={pickingField === field.key} pickerBusy={pickingField !== null} />)}
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
            {projectDirectory === "" && <div className="studio-project-notice">运行前需要设置项目目录。<button type="button" className="text-button" onClick={() => onNavigate("connections")}>前往集成连接 <FolderOpen size={13} /></button></div>}
            {projectDirectory === null && <div className="studio-project-notice">正在读取项目目录设置…</div>}
            <span className="form-save-hint">草稿保存在此设备</span>
            <div className="studio-action-buttons">
              <button className="button button-outline" type="submit" disabled={running}><Save size={15} />{saved ? <><Check size={15} />已保存</> : "保存草稿"}</button>
              <button className="button button-dark" type="button" onClick={running ? cancelRun : run} disabled={!running && !projectDirectory}><>{running ? <LoaderCircle className="spin" size={15} /> : <Play size={15} />}{running ? "取消运行" : "运行流程"}</></button>
            </div>
          </div>
          {runResult && <WorkflowRunPanel result={runResult} inputValues={runResult.artifacts ? undefined : draft?.inputValues} onOpenRuns={() => onNavigate("runs")} />}
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
