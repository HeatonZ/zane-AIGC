import { useEffect, useRef, useState } from "react";
import type { CapabilityConfigField, CapabilityDefinition } from "../lib/capabilities";
import { readCapabilityConfig, writeCapabilityConfig, parseCapabilityDraft } from "../lib/capabilities";
import type { WorkflowStepDefinition } from "../types";
type DraftChange = (key: string, error?: string) => void;
/** 把「当前焦点里的草稿」按字段交给父级：父级可以在点击发布这类动作前先同步提交，不必等失焦。 */
type DraftPending = (key: string, flush: (() => void) | null) => void;
function ConfigField({ step, field, references, onChange, onDraftChange, onDraftPending }: { step: WorkflowStepDefinition; field: CapabilityConfigField; references: Array<{ value: string; label: string }>; onChange(step: WorkflowStepDefinition): void; onDraftChange?: DraftChange; onDraftPending?: DraftPending }) {
  const value = readCapabilityConfig(step, field);
  const serialize = (next: unknown) => field.type === "json" ? next === undefined ? "" : JSON.stringify(next, null, 2) : String(next ?? "");
  const [draft, setDraft] = useState(serialize(value));
  const [error, setError] = useState("");
  const draftRef = useRef(draft);
  const focusedRef = useRef(false);
  const stepIdRef = useRef(step.id);
  const pendingRef = useRef(onDraftPending);
  pendingRef.current = onDraftPending;
  // 交出去的提交句柄可能在若干次渲染之后才被调用；必须写回最新的步骤和最新的回调，
  // 否则发布会把同一能力包其它字段的修改覆盖回旧值。
  const stepRef = useRef(step);
  stepRef.current = step;
  const changeRef = useRef(onChange);
  changeRef.current = onChange;
  const fieldKey = field.key;
  // 保存回执会让父级用服务端值重渲染；正在编辑的草稿不能被旧值覆盖。
  useEffect(() => {
    const switched = stepIdRef.current !== step.id;
    stepIdRef.current = step.id;
    if (!switched && focusedRef.current) return;
    draftRef.current = serialize(value);
    setDraft(serialize(value));
    setError("");
  }, [step.id, JSON.stringify(value)]);
  // 切换步骤或卸载时收回未提交的草稿句柄，避免发布时提交到已经离开的字段。
  useEffect(() => () => pendingRef.current?.(fieldKey, null), [fieldKey, step.id]);
  function commit() {
    try {
      changeRef.current(writeCapabilityConfig(stepRef.current, field, parseCapabilityDraft(field, draftRef.current))); setError(""); onDraftChange?.(field.key);
    } catch (reason) { const message = reason instanceof Error ? reason.message : "配置格式无效"; setError(message); onDraftChange?.(field.key, message); }
    pendingRef.current?.(fieldKey, null);
  }
  function updateDraft(next: string) {
    draftRef.current = next;
    setDraft(next);
    try { parseCapabilityDraft(field, next); setError(""); onDraftChange?.(field.key); pendingRef.current?.(fieldKey, commit); }
    catch (reason) {
      const message = reason instanceof Error ? reason.message : "配置格式无效";
      setError(message); onDraftChange?.(field.key, message); pendingRef.current?.(fieldKey, null);
    }
  }
  const listId = "capability-ref-" + step.id + "-" + field.key;
  return <label className="field-group capability-config-field"><span className="field-label">{field.label}{field.required ? " *" : ""}</span>
    {field.type === "boolean" ? <input type="checkbox" checked={value === true} onChange={(event) => onChange(writeCapabilityConfig(step, field, event.target.checked))} />
      : field.type === "select" ? <select className="text-input" value={String(value ?? "")} onChange={(event) => onChange(writeCapabilityConfig(step, field, event.target.value))}><option value="">请选择</option>{field.options?.map((option) => <option key={option}>{option}</option>)}</select>
      : field.type === "textarea" || field.type === "json" ? <textarea className="text-input prompt-textarea" value={draft} placeholder={field.placeholder} onFocus={() => { focusedRef.current = true; }} onChange={(event) => updateDraft(event.target.value)} onBlur={() => { focusedRef.current = false; commit(); }} aria-invalid={Boolean(error)} />
      : <><input className="text-input" type={field.type === "number" ? "number" : "text"} list={field.type === "reference" ? listId : undefined} value={draft} placeholder={field.placeholder} onFocus={() => { focusedRef.current = true; }} onChange={(event) => updateDraft(event.target.value)} onBlur={() => { focusedRef.current = false; commit(); }} aria-invalid={Boolean(error)} />{field.type === "reference" && <datalist id={listId}>{references.map((reference) => <option key={reference.value} value={reference.value}>{reference.label}</option>)}</datalist>}</>}
    {field.description && <small>{field.description}</small>}{error && <small role="alert">{error}</small>}
  </label>;
}
export default function CapabilityConfigEditor({ step, definition, references, onChange, onDraftChange, onDraftPending }: { step: WorkflowStepDefinition; definition: CapabilityDefinition; references: Array<{ value: string; label: string }>; onChange(step: WorkflowStepDefinition): void; onDraftChange?: DraftChange; onDraftPending?: DraftPending }) {
  return <div className="designer-subsection capability-config"><div className="designer-subsection-heading"><div><h3>{definition.label}</h3><p>{definition.description}</p></div><span>v{definition.version}</span></div>
    {definition.config.map((field) => <ConfigField key={field.key} step={step} field={field} references={references} onChange={onChange} onDraftChange={onDraftChange} onDraftPending={onDraftPending} />)}
  </div>;
}
