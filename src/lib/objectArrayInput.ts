import type { JsonValue, WorkflowInputField } from "../types";

export function parseObjectArrayFormValue(field: WorkflowInputField, source: unknown, validateRequired = true): JsonValue[] {
  const value = typeof source === "string" ? (() => {
    if (!source.trim()) return [];
    try { return JSON.parse(source) as unknown; } catch { throw new Error(`${field.label} 表格数据无效，请重新填写`); }
  })() : source;
  if (!Array.isArray(value)) throw new Error(`${field.label} 必须是对象数组`);
  if (value.length > 100) throw new Error(`${field.label} 最多填写100行`);
  if (validateRequired && field.required && value.length === 0) throw new Error(`${field.label} 至少添加一行`);
  const itemFields = field.itemFields ?? [];
  return value.map((raw, index) => {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new Error(`${field.label} 第 ${index + 1} 行格式无效`);
    const sourceRow = raw as Record<string, unknown>;
    const declaredKeys = new Set(itemFields.map(item => item.key));
    if (Object.keys(sourceRow).some(key => !declaredKeys.has(key))) throw new Error(`${field.label} 第 ${index + 1} 行包含未声明字段，请重新打开表单核对`);
    const row: Record<string, JsonValue> = {};
    for (const item of itemFields) {
      let cell = sourceRow[item.key];
      const empty = cell === undefined || cell === null || cell === "" || (typeof cell === "string" && !cell.trim());
      if (empty && !item.required) continue;
      if (empty && item.required && validateRequired) throw new Error(`${field.label} 第 ${index + 1} 行请填写${item.label}`);
      if (empty) continue;
      if (item.type === "number") {
        if (typeof cell === "string") cell = Number(cell);
        if (typeof cell !== "number" || !Number.isFinite(cell)) throw new Error(`${field.label} 第 ${index + 1} 行的${item.label}需要填写有效数字`);
        if (item.minimum !== undefined && cell < item.minimum) throw new Error(`${field.label} 第 ${index + 1} 行的${item.label}不能小于 ${item.minimum}`);
        if (item.maximum !== undefined && cell > item.maximum) throw new Error(`${field.label} 第 ${index + 1} 行的${item.label}不能大于 ${item.maximum}`);
      } else if (item.type === "boolean") {
        if (typeof cell !== "boolean") throw new Error(`${field.label} 第 ${index + 1} 行的${item.label}需要选择是或否`);
      } else {
        if (typeof cell !== "string") throw new Error(`${field.label} 第 ${index + 1} 行的${item.label}需要填写文本`);
        if (item.type === "select" && item.options && !item.options.includes(cell)) throw new Error(`${field.label} 第 ${index + 1} 行的${item.label}选项无效`);
      }
      row[item.key] = cell as JsonValue;
    }
    return row;
  });
}
