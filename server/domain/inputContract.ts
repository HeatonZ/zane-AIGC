import { ASSET_MEDIA_EXECUTION_CONTRACT } from "./assetMediaReference.js";
import type { JsonValue, RunInputField, RunWorkflowDefinition } from "./types.js";
import { asRecord, isMediaWorkflowType } from "./workflowValues.js";
import { isEmptyWorkflowInput, workflowInputDefaults, workflowInputIssue } from "./inputValidation.js";

type Schema = Record<string, unknown>;
const empty: Schema = { enum: [null, ""] };
const readableString = { type: "string", minLength: 1, pattern: "\\S" };
const readableObject: Schema = { type: "object", anyOf: [{ required: ["filename"], properties: { filename: readableString } }, { required: ["path"], properties: { path: readableString } }, { required: ["url"], properties: { url: { type: "string", pattern: "^(?:https?://|data:)" } } }], additionalProperties: true };
const assetReference: Schema = { type: "object", required: ["assetId", "assetVersion"], properties: { assetId: { type: "string", minLength: 1 }, assetVersion: { type: "integer", minimum: 1 } }, additionalProperties: true, description: "真实素材ID和固定版本；存在性、媒体类型与文件可读性由prepare校验。后端按已授权任务读取内部固定版本并归档；图片由Hermes转为inline图片、ComfyUI上传同一来源，Hermes仍按现有图片预算处理；previewUrl只是需鉴权的显示接口，不是执行端下载凭证" };
const runtimeItem = { type: "object", required: ["id", "kind", "locator"], properties: { id: { type: "string" }, kind: { enum: ["image", "video", "audio"] }, locator: { type: "object", required: ["type"], properties: { type: { enum: ["path", "url", "comfy"] } }, additionalProperties: true } }, additionalProperties: true };
function mediaDefinitions(): Record<string, Schema> {
  const wrapper = (nonEmpty: boolean): Schema => ({ type: "object", required: ["kind", "__zaneRuntime", "mediaKind", "items"], properties: { kind: { const: "media" }, __zaneRuntime: { const: "media" }, mediaKind: { enum: ["image", "video", "audio"] }, items: { type: "array", items: runtimeItem, ...(nonEmpty ? { minItems: 1 } : {}) } }, additionalProperties: true });
  return {
    MediaInput: { anyOf: [empty, readableString, readableObject, assetReference, { type: "array", items: { $ref: "#/$defs/MediaInput" } }, wrapper(false)] },
    NonEmptyMediaInput: { anyOf: [readableString, readableObject, assetReference, { type: "array", items: { $ref: "#/$defs/MediaInput" }, contains: { $ref: "#/$defs/NonEmptyMediaInput" }, minContains: 1 }, wrapper(true)] },
  };
}
function schemaFor(field: RunInputField): Schema {
  let nonEmpty: Schema;
  if (isMediaWorkflowType(field.type)) return { $ref: "#/$defs/" + (field.required ? "NonEmptyMediaInput" : "MediaInput") };
  if (field.type === "number") nonEmpty = { type: "number" };
  else if (field.type === "boolean") nonEmpty = { type: "boolean" };
  else if (field.type === "json") nonEmpty = { type: ["object", "array"] };
  else if (field.type === "select" && field.options) { const options = field.options.filter(option => option !== ""); nonEmpty = options.length ? { type: "string", enum: options } : { not: {} }; }
  else nonEmpty = { type: "string", minLength: 1 };
  return field.required ? nonEmpty : { anyOf: [empty, nonEmpty] };
}
/** The snapshot supplies fields/options, and shared validation rules supply empty/default semantics. */
export function sceneInputContract(workflow: RunWorkflowDefinition, supplied: Record<string, JsonValue> = {}) {
  const defaults = workflowInputDefaults(workflow);
  const values = { ...defaults, ...supplied };
  const missing = workflow.inputs.filter(field => field.required && isEmptyWorkflowInput(field, values[field.key]));
  const properties = Object.fromEntries(workflow.inputs.map(field => {
    const raw = asRecord(field) ?? {};
    const defaultValue = raw.defaultValue;
    const validDefault = defaultValue !== undefined && !isEmptyWorkflowInput(field, defaultValue) && (!workflowInputIssue(field, defaultValue) || isMediaWorkflowType(field.type));
    return [field.key, { ...schemaFor(field), title: typeof raw.label === "string" ? raw.label : field.key, ...(typeof raw.placeholder === "string" ? { description: raw.placeholder } : {}), ...(field.mediaRole ? { "x-media-role": field.mediaRole } : {}), ...(validDefault ? { default: defaultValue } : {}) }];
  }));
  const required = workflow.inputs.filter(field => field.required && (isEmptyWorkflowInput(field, defaults[field.key]) || (!isMediaWorkflowType(field.type) && Boolean(workflowInputIssue(field, defaults[field.key]))))).map(field => field.key);
  const inputSchema: Schema = { $schema: "https://json-schema.org/draft/2020-12/schema", type: "object", properties, required, additionalProperties: false, ...(workflow.inputs.some(field => isMediaWorkflowType(field.type)) ? { $defs: mediaDefinitions() } : {}) };
  const exampleValues: Record<string, JsonValue> = {};
  const requiresUserInput: string[] = [];
  for (const field of workflow.inputs) {
    const value = defaults[field.key];
    if (value !== undefined && !workflowInputIssue(field, value)) { exampleValues[field.key] = structuredClone(value); continue; }
    if (!field.required) continue;
    if (isMediaWorkflowType(field.type)) { requiresUserInput.push(field.key); continue; }
    if (field.type === "number") exampleValues[field.key] = 0;
    else if (field.type === "boolean") exampleValues[field.key] = false;
    else if (field.type === "json") exampleValues[field.key] = {};
    else if (field.type === "select" && field.options) { const first = field.options.find(option => option !== ""); if (first !== undefined) exampleValues[field.key] = first; else requiresUserInput.push(field.key); }
    else { exampleValues[field.key] = "示例文本，请替换为实际业务内容"; requiresUserInput.push(field.key); }
  }
  const exampleMissing = workflow.inputs.filter(field => field.required && isEmptyWorkflowInput(field, exampleValues[field.key])).map(field => field.key);
  return { inputSchema, inputDefaults: defaults, inputRequirements: workflow.inputs.map(field => ({ key: field.key, type: field.type, required: Boolean(field.required), ...(field.mediaRole ? { mediaRole: field.mediaRole } : {}), ...(field.options ? { options: field.options } : {}), ...(defaults[field.key] !== undefined ? { defaultValue: defaults[field.key] } : {}), needsValue: missing.some(item => item.key === field.key), ...(isMediaWorkflowType(field.type) ? { mediaReference: { assetId: "真实素材ID", assetVersion: "固定正整数版本" }, mediaExecution: ASSET_MEDIA_EXECUTION_CONTRACT } : {}) })), missingRequiredInputs: missing.map(field => field.key), inputExamples: [{ name: "minimal", inputValues: exampleValues, requiresUserInput, missingRequiredInputs: exampleMissing, syntacticallyComplete: exampleMissing.length === 0, validationScope: "inputs-only-not-external-services", notice: "示例不代替真实业务输入；媒体不会伪造素材ID，缺少素材时先上传/查询并固定版本，再prepare。" }] };
}
