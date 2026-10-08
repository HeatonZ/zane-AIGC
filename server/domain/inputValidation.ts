import { HttpError } from "../errors.js";
import type { JsonValue, RunInputField, RunWorkflowDefinition } from "./types.js";
import { isMediaWorkflowType, isReadableMediaItem, normalizeMediaList } from "./workflowValues.js";

export function isEmptyWorkflowInput(field: RunInputField, value: unknown) {
  return value === undefined || value === null || value === "" || (isMediaWorkflowType(field.type) && normalizeMediaList(value).length === 0);
}
export function workflowInputIssue(field: RunInputField, value: unknown) {
  const empty = isEmptyWorkflowInput(field, value);
  if (field.required && empty) return { code: "REQUIRED_INPUT_MISSING", message: "请填写必填字段：" + field.key };
  if (empty) return undefined;
  const correct = isMediaWorkflowType(field.type) ? normalizeMediaList(value).every(isReadableMediaItem) : field.type === "number" ? typeof value === "number" && Number.isFinite(value) : field.type === "boolean" ? typeof value === "boolean" : field.type === "json" ? typeof value === "object" : typeof value === "string";
  if (!correct) return { code: "INPUT_TYPE_MISMATCH", message: "字段 " + field.key + " 的数据类型不匹配" };
  if (field.type === "select" && field.options && !field.options.includes(String(value))) return { code: "INVALID_INPUT_OPTION", message: "字段 " + field.key + " 的选项无效" };
  return undefined;
}
export function workflowInputDefaults(workflow: RunWorkflowDefinition): Record<string, JsonValue> {
  return Object.fromEntries(workflow.inputs.flatMap(field => field.defaultValue !== undefined ? [[field.key, field.defaultValue]] : []));
}
export function validateWorkflowInputs(workflow: RunWorkflowDefinition, inputValues: Record<string, JsonValue>) {
  for (const field of workflow.inputs) {
    const issue = workflowInputIssue(field, inputValues[field.key]);
    if (issue) throw new HttpError(400, issue.message, issue.code, { inputKey: field.key, expectedType: field.type, nextAction: "correct_input_values" });
  }
}
