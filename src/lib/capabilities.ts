import { builtinCapabilities } from "../../server/capabilities/definitions.js";
import type { CapabilityConfigField, CapabilityDefinition } from "../../server/capabilities/contracts.js";
import { capabilityForStep, capabilityUsage, writeCapabilityConfig } from "../../server/capabilities/contracts.js";
import type { WorkflowStepDefinition } from "../types";
export { capabilityUsage, capabilityForStep, capabilityConfigErrors, readCapabilityConfig, writeCapabilityConfig } from "../../server/capabilities/contracts.js";
export type { CapabilityCatalogPage, CapabilityUsage, CapabilityDefinition, CapabilityConfigField } from "../../server/capabilities/contracts.js";
/** Old backends may not return usage; only fill exact-version built-ins from their shared declaration. */
export function withBuiltinCapabilityUsage(catalog: readonly CapabilityDefinition[]) {
  return catalog.map((item) => {
    const known = item.usage ? undefined : builtinCapabilities.find((builtin) => builtin.id === item.id && builtin.version === item.version);
    return known?.usage ? { ...item, usage: structuredClone(known.usage) } : item;
  });
}
/** One flat catalog: offer every capability that is not retired (compatibilityOnly), and keep an already selected step visible. */
export function capabilityChoices(catalog: readonly CapabilityDefinition[], selectedId: string | undefined) {
  // 已退役的执行方式（compatibilityOnly）不再向新步骤推荐，但已选中的必须保留，避免隐藏后丢配置或自动切换。
  return catalog.filter((item) => !capabilityUsage(item).compatibilityOnly || item.id === selectedId);
}
/** Only a serializable manifest is needed to configure a newly installed capability. */
export function applyCapabilityToStep(step: WorkflowStepDefinition, definition: CapabilityDefinition): WorkflowStepDefinition {
  const same = step.capabilityId === definition.id || (!step.capabilityId && capabilityForStep(step, [definition]));
  let next: WorkflowStepDefinition = { ...structuredClone(step), kind: definition.legacy.kind, capabilityId: definition.id, capabilityVersion: definition.version, capabilityConfig: same ? step.capabilityConfig ?? {} : {} };
  if (!definition.editor.condition) delete next.control;
  if (!definition.editor.profile) delete next.hermesProfile;
  if (!definition.editor.prompt) next.promptTemplate = "";
  if (definition.legacy.kind === "comfyui") {
    next.comfyui = { workflowFile: step.comfyui?.workflowFile ?? "", bindings: step.comfyui?.bindings ?? [], ...(definition.legacy.adapter ? { adapter: definition.legacy.adapter } : {}) };
  } else delete next.comfyui;
  if (definition.inputs.length) next.inputs = definition.inputs.map((port) => step.inputs.find((item) => item.key === port.key) ?? { key: port.key, label: port.label, sourceRef: "" });
  if (definition.outputs.length && definition.editor.outputs === "ports") next.outputs = definition.outputs.map((port) => ({ key: port.key, label: port.label, type: port.type, ...(port.description ? { description: port.description } : {}) }));
  if (definition.editor.condition) next.inputs = [];
  for (const field of definition.config) if (field.defaultValue !== undefined && !same) next = writeCapabilityConfig(next, field, field.defaultValue);
  return next;
}


/** Parse raw form text without discarding an invalid draft in favor of old values. */
export function parseCapabilityDraft(field: CapabilityConfigField, draft: string): unknown {
  if (draft === "") {
    if (field.required) throw new Error(field.label + "不能为空");
    return undefined;
  }
  if (field.type === "number") {
    const value = Number(draft);
    if (draft.trim() === "" || !Number.isFinite(value)) throw new Error("请输入有效数字");
    return value;
  }
  if (field.type === "json") {
    let value: unknown;
    try { value = JSON.parse(draft); } catch { throw new Error("请填写有效的 JSON"); }
    if (typeof value !== "object") throw new Error("JSON 配置必须是对象或数组");
    if (value === null && field.required) throw new Error(field.label + "不能为空");
    return value;
  }
  return draft;
}
