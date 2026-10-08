import { Plus, Trash2 } from "lucide-react";
import type { JsonValue, WorkflowInputField } from "../types";

export default function ObjectArrayInput({ field, value, disabled = false, onChange }: {
  field: WorkflowInputField;
  value: unknown;
  disabled?: boolean;
  onChange: (rows: JsonValue[]) => void;
}) {
  let parsed: unknown = value;
  let invalidStoredValue = false;
  if (typeof value === "string" && value.trim()) {
    try { parsed = JSON.parse(value) as unknown; } catch { invalidStoredValue = true; }
  }
  if (parsed !== undefined && parsed !== null && parsed !== "" && !Array.isArray(parsed)) invalidStoredValue = true;
  const rows: Array<Record<string, unknown>> = Array.isArray(parsed) ? parsed.map(row => typeof row === "object" && row !== null && !Array.isArray(row) ? row as Record<string, unknown> : {}) : [];
  const itemFields = field.itemFields ?? [];
  function updateRow(index: number, key: string, cell: unknown) {
    onChange(rows.map((row, rowIndex) => rowIndex === index ? { ...row, [key]: cell as JsonValue } : row) as unknown as JsonValue[]);
  }
  function addRow() {
    const row: Record<string, JsonValue> = {};
    onChange([...rows, row] as unknown as JsonValue[]);
  }
  return <div className="object-array-input" aria-label={`${field.label}表格输入`}>
    {invalidStoredValue && <p className="object-array-input-error" role="alert">已保存的表格数据无法读取。请刷新表单核对服务端草稿，再继续填写。</p>}
    {rows.map((row, rowIndex) => <fieldset className="object-array-row" key={rowIndex} disabled={disabled}>
      <legend>{field.label} {rowIndex + 1}</legend>
      <div className="object-array-row-fields">
        {itemFields.map(item => <label className="object-array-cell" key={item.key}>
          <span>{item.label}{item.required && <b> *</b>}</span>
          {item.type === "boolean" ? <select className="text-input" value={row[item.key] === true ? "true" : row[item.key] === false ? "false" : ""} required={item.required} onChange={event => updateRow(rowIndex, item.key, event.target.value === "" ? undefined : event.target.value === "true")}>
              <option value="">请选择</option><option value="true">是</option><option value="false">否</option>
            </select>
            : item.type === "select" ? <select className="text-input" value={String(row[item.key] ?? "")} required={item.required} onChange={event => updateRow(rowIndex, item.key, event.target.value)}>
              <option value="">请选择</option>{item.options?.map(option => <option value={option} key={option}>{option}</option>)}
            </select>
            : <input className="text-input" type={item.type === "number" ? "number" : "text"} step={item.type === "number" ? "any" : undefined} min={item.type === "number" ? item.minimum : undefined} max={item.type === "number" ? item.maximum : undefined} value={String(row[item.key] ?? "")} required={item.required} placeholder={item.placeholder} onChange={event => updateRow(rowIndex, item.key, event.target.value)} />}
        </label>)}
      </div>
      <button className="object-array-remove" type="button" disabled={disabled} onClick={() => onChange(rows.filter((_row, index) => index !== rowIndex) as JsonValue[])}><Trash2 size={14} />删除这一行</button>
    </fieldset>)}
    <button className="button button-outline object-array-add" type="button" disabled={disabled || invalidStoredValue || rows.length >= 100} onClick={addRow}><Plus size={15} />添加一行</button>
    <small>{field.placeholder || "按行填写；可以继续添加多项。"}{field.required ? " 至少填写一行。" : ""}</small>
  </div>;
}
