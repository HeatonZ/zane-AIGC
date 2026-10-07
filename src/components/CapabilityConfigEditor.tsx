import { useEffect, useState } from "react";
import type { CapabilityConfigField, CapabilityDefinition } from "../lib/capabilities";
import { readCapabilityConfig, writeCapabilityConfig, parseCapabilityDraft } from "../lib/capabilities";
import type { WorkflowStepDefinition } from "../types";
type DraftChange = (key: string, error?: string) => void;
function ConfigField({ step, field, references, onChange, onDraftChange }: { step: WorkflowStepDefinition; field: CapabilityConfigField; references: Array<{ value: string; label: string }>; onChange(step: WorkflowStepDefinition): void; onDraftChange?: DraftChange }) {
  const value = readCapabilityConfig(step, field);
  const serialize = (next: unknown) => field.type === "json" ? next === undefined ? "" : JSON.stringify(next, null, 2) : String(next ?? "");
  const [draft, setDraft] = useState(serialize(value));
  const [error, setError] = useState("");
  useEffect(() => { setDraft(serialize(value)); setError(""); }, [step.id, JSON.stringify(value)]);
  function updateDraft(next: string) {
    setDraft(next);
    try { parseCapabilityDraft(field, next); setError(""); onDraftChange?.(field.key); }
    catch (reason) { const message = reason instanceof Error ? reason.message : "配置格式无效"; setError(message); onDraftChange?.(field.key, message); }
  }
  function commit() {
    try {
      onChange(writeCapabilityConfig(step, field, parseCapabilityDraft(field, draft))); setError(""); onDraftChange?.(field.key);
    } catch (reason) { const message = reason instanceof Error ? reason.message : "配置格式无效"; setError(message); onDraftChange?.(field.key, message); }
  }
  const listId = "capability-ref-" + step.id + "-" + field.key;
  return <label className="field-group capability-config-field"><span className="field-label">{field.label}{field.required ? " *" : ""}</span>
    {field.type === "boolean" ? <input type="checkbox" checked={value === true} onChange={(event) => onChange(writeCapabilityConfig(step, field, event.target.checked))} />
      : field.type === "select" ? <select className="text-input" value={String(value ?? "")} onChange={(event) => onChange(writeCapabilityConfig(step, field, event.target.value))}><option value="">请选择</option>{field.options?.map((option) => <option key={option}>{option}</option>)}</select>
      : field.type === "textarea" || field.type === "json" ? <textarea className="text-input prompt-textarea" value={draft} placeholder={field.placeholder} onChange={(event) => updateDraft(event.target.value)} onBlur={commit} aria-invalid={Boolean(error)} />
      : <><input className="text-input" type={field.type === "number" ? "number" : "text"} list={field.type === "reference" ? listId : undefined} value={draft} placeholder={field.placeholder} onChange={(event) => updateDraft(event.target.value)} onBlur={commit} aria-invalid={Boolean(error)} />{field.type === "reference" && <datalist id={listId}>{references.map((reference) => <option key={reference.value} value={reference.value}>{reference.label}</option>)}</datalist>}</>}
    {field.description && <small>{field.description}</small>}{error && <small role="alert">{error}</small>}
  </label>;
}
export default function CapabilityConfigEditor({ step, definition, references, onChange, onDraftChange }: { step: WorkflowStepDefinition; definition: CapabilityDefinition; references: Array<{ value: string; label: string }>; onChange(step: WorkflowStepDefinition): void; onDraftChange?: DraftChange }) {
  return <div className="designer-subsection capability-config"><div className="designer-subsection-heading"><div><h3>{definition.label}</h3><p>{definition.description}</p></div><span>v{definition.version}</span></div>
    {definition.config.map((field) => <ConfigField key={field.key} step={step} field={field} references={references} onChange={onChange} onDraftChange={onDraftChange} />)}
  </div>;
}
