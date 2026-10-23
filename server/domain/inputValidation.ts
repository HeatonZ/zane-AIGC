import { HttpError } from "../errors.js";
import type { JsonValue, RunInputField, RunWorkflowDefinition } from "./types.js";
import { isMediaWorkflowType, isReadableMediaItem, normalizeMediaList } from "./workflowValues.js";

/**
 * requireInputs:false 表示这次校验不要求「必填已填」——任务草稿可以边填边存，
 * 必填留到确认提交前再判。已经填了的值的类型/范围/选项照常校验，不会被一起放过。
 */
export interface InputValidationOptions { requireInputs?: boolean }

export function isEmptyWorkflowInput(field: RunInputField, value: unknown) {
  return value === undefined || value === null || value === ""
    || (isMediaWorkflowType(field.type) && normalizeMediaList(value).length === 0)
    || (field.inputMode === "object_array" && Array.isArray(value) && value.length === 0);
}
export function workflowInputIssue(field: RunInputField, value: unknown, options: InputValidationOptions = {}) {
  const requireInputs = options.requireInputs !== false;
  const empty = isEmptyWorkflowInput(field, value);
  if (requireInputs && field.required && empty) return { code: "REQUIRED_INPUT_MISSING", message: "请填写必填字段：" + field.key };
  if (empty) return undefined;
  if (field.inputMode === "object_array") {
    if (field.type !== "json" || !Array.isArray(value)) return { code: "INPUT_TYPE_MISMATCH", message: "字段 " + field.key + " 必须是对象数组" };
    if (value.length > 100) return { code: "INPUT_TOO_LARGE", message: field.key + " 最多填写100行" };
    const fields = field.itemFields ?? [];
    const keys = new Set(fields.map(item => item.key));
    for (let rowIndex = 0; rowIndex < value.length; rowIndex += 1) {
      const row = value[rowIndex];
      if (typeof row !== "object" || row === null || Array.isArray(row)) return { code: "INPUT_TYPE_MISMATCH", message: `${field.key} 第 ${rowIndex + 1} 行必须是对象` };
      if (Object.keys(row).some(key => !keys.has(key))) return { code: "INPUT_TYPE_MISMATCH", message: `${field.key} 第 ${rowIndex + 1} 行包含未声明字段` };
      for (const item of fields) {
        const cell = (row as Record<string, unknown>)[item.key];
        const emptyCell = cell === undefined || cell === null || cell === "" || (typeof cell === "string" && !cell.trim());
        if (item.required && emptyCell && requireInputs) return { code: "REQUIRED_INPUT_MISSING", message: `${field.key} 第 ${rowIndex + 1} 行请填写${item.label || item.key}` };
        if (emptyCell) continue;
        if (item.type === "number" && (typeof cell !== "number" || !Number.isFinite(cell))) return { code: "INPUT_TYPE_MISMATCH", message: `${field.key} 第 ${rowIndex + 1} 行的${item.label || item.key}必须是数字` };
        if (item.type === "number" && typeof cell === "number" && item.minimum !== undefined && cell < item.minimum) return { code: "INPUT_OUT_OF_RANGE", message: `${field.key} 第 ${rowIndex + 1} 行的${item.label || item.key}不能小于 ${item.minimum}` };
        if (item.type === "number" && typeof cell === "number" && item.maximum !== undefined && cell > item.maximum) return { code: "INPUT_OUT_OF_RANGE", message: `${field.key} 第 ${rowIndex + 1} 行的${item.label || item.key}不能大于 ${item.maximum}` };
        if ((item.type === "text" || item.type === "select") && typeof cell !== "string") return { code: "INPUT_TYPE_MISMATCH", message: `${field.key} 第 ${rowIndex + 1} 行的${item.label || item.key}必须是文本` };
        if (item.type === "boolean" && typeof cell !== "boolean") return { code: "INPUT_TYPE_MISMATCH", message: `${field.key} 第 ${rowIndex + 1} 行的${item.label || item.key}必须是布尔值` };
        if (item.type === "select" && item.options && !item.options.includes(cell as string)) return { code: "INVALID_INPUT_OPTION", message: `${field.key} 第 ${rowIndex + 1} 行的${item.label || item.key}选项无效` };
      }
    }
    return undefined;
  }
  const correct = isMediaWorkflowType(field.type) ? normalizeMediaList(value).every(isReadableMediaItem) : field.type === "number" ? typeof value === "number" && Number.isFinite(value) : field.type === "boolean" ? typeof value === "boolean" : field.type === "json" ? typeof value === "object" : typeof value === "string";
  if (!correct) return { code: "INPUT_TYPE_MISMATCH", message: "字段 " + field.key + " 的数据类型不匹配" };
  if (field.type === "number" && typeof value === "number" && field.minimum !== undefined && value < field.minimum) return { code: "INPUT_OUT_OF_RANGE", message: `字段 ${field.key} 不能小于 ${field.minimum}` };
  if (field.type === "number" && typeof value === "number" && field.maximum !== undefined && value > field.maximum) return { code: "INPUT_OUT_OF_RANGE", message: `字段 ${field.key} 不能大于 ${field.maximum}` };
  if (field.type === "select" && field.options && !field.options.includes(String(value))) return { code: "INVALID_INPUT_OPTION", message: "字段 " + field.key + " 的选项无效" };
  // 媒体列表的 maximum 表示最多几张：复用同一字段名，不另造一套数量上限配置。
  if (isMediaWorkflowType(field.type) && field.maximum !== undefined) {
    const count = normalizeMediaList(value).length;
    if (count > field.maximum) return { code: "INPUT_TOO_LARGE", message: `字段 ${field.key} 最多 ${field.maximum} 个` };
  }
  return undefined;
}
export function workflowInputDefaults(workflow: RunWorkflowDefinition): Record<string, JsonValue> {
  return Object.fromEntries(workflow.inputs.flatMap(field => field.defaultValue !== undefined ? [[field.key, field.defaultValue]] : []));
}
export function validateWorkflowInputs(workflow: RunWorkflowDefinition, inputValues: Record<string, JsonValue>, options: InputValidationOptions = {}) {
  for (const field of workflow.inputs) {
    const issue = workflowInputIssue(field, inputValues[field.key], options);
    if (issue) throw new HttpError(400, issue.message, issue.code, { inputKey: field.key, expectedType: field.type, nextAction: "correct_input_values" });
  }
}
