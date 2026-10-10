/** Serializable capability contract. This module is also consumed by the browser; no Node dependencies. */
export type CapabilityValue = string | number | boolean | null | CapabilityValue[] | { [key: string]: CapabilityValue };
export type CapabilityStepKind = "hermes" | "comfyui" | "manual" | "control" | "capability";
export type CapabilityPortType = "text" | "number" | "boolean" | "json" | "image_list" | "video_list" | "audio_list";
/** Output ports are required by default; required:false is additive/optional for old snapshots. Input ports require explicit required:true. */
export interface CapabilityPort { key: string; label: string; type: CapabilityPortType; required?: boolean; description?: string; valueSchema?: Record<string, CapabilityValue> }
export interface CapabilityConfigField {
  key: string; label: string; type: "text" | "textarea" | "number" | "boolean" | "select" | "json" | "reference";
  /** Exact JSON value schema when the field type alone is insufficient. */
  valueSchema?: Record<string, CapabilityValue>;
  /** Legacy configuration location. Otherwise stored under capabilityConfig[key]. */
  path?: string; required?: boolean; defaultValue?: CapabilityValue; options?: string[]; placeholder?: string; description?: string;
}
export interface CapabilityUsage {
  /** When this step fits; scene differences are expressed by configuration and core.code custom code, not by scene-named adapters. */
  whenToUse: string;
  /** Retained for existing snapshots and historical runs; new scenes use core.code and the basic composition instead. */
  compatibilityOnly?: boolean;
}
export const CAPABILITY_SELECTION_POLICY = { sceneDifferences: "configuration-first", sceneSpecificLogic: "core.code" } as const;
export interface CapabilityDefinition {
  id: string; version: string; label: string; description: string; category: string;
  /** Optional for legacy packages; undeclared extensions are conservatively opt-in. */
  usage?: CapabilityUsage;
  legacy: { kind: CapabilityStepKind; adapter?: string };
  inputs: CapabilityPort[]; outputs: CapabilityPort[]; config: CapabilityConfigField[];
  editor: { inputs: "bindings" | "ports"; outputs: "bindings" | "ports"; editablePorts?: boolean; editableInputs?: boolean; editableOutputs?: boolean; bindings?: boolean; profile?: boolean; prompt?: boolean; condition?: boolean; bindingTypes?: Array<{ direction: "input" | "output"; nodeType: string; property: string; type: CapabilityPortType }> };
  /** Undeclared/opaque packages conservatively depend on all prior results and all scene inputs. */
  dependencyMode?: "declared" | "all-prior";
  result: { renderer: "auto" | "text" | "json" | "media" };
}
export function capabilityUsage(definition: CapabilityDefinition): CapabilityUsage {
  return definition.usage ?? { whenToUse: "此扩展尚未声明适用范围；仅在确认基础步骤与 core.code 自定义代码无法满足需求后选用。" };
}
export interface CapabilityCatalogPage {
  schemaVersion: 1;
  revision: string;
  selectionPolicy: typeof CAPABILITY_SELECTION_POLICY;
  capabilities: CapabilityDefinition[];
  hasMore: boolean;
  nextCursor?: string;
}
export interface CapabilityStepIdentity { kind: string; capabilityId?: string; capabilityVersion?: string; comfyui?: { adapter?: string } }
export function capabilityForStep(step: CapabilityStepIdentity, catalog: readonly CapabilityDefinition[]) {
  if (step.capabilityId) return catalog.find((item) => item.id === step.capabilityId);
  return catalog.find((item) => item.legacy.kind === step.kind && item.legacy.adapter === (step.kind === "comfyui" ? step.comfyui?.adapter : undefined));
}
export function readCapabilityConfig(step: object, field: CapabilityConfigField): unknown {
  const parts = field.path?.split(".") ?? ["capabilityConfig", field.key];
  let value: unknown = step;
  for (const part of parts) value = value && typeof value === "object" ? (value as Record<string, unknown>)[part] : undefined;
  return value === undefined ? field.defaultValue : value;
}
export function writeCapabilityConfig<T extends object>(step: T, field: CapabilityConfigField, value: unknown): T {
  const result = structuredClone(step) as Record<string, unknown>;
  const parts = field.path?.split(".") ?? ["capabilityConfig", field.key];
  let target = result;
  for (const part of parts.slice(0, -1)) {
    const current = target[part];
    target[part] = current && typeof current === "object" && !Array.isArray(current) ? { ...current } : {};
    target = target[part] as Record<string, unknown>;
  }
  if (value === undefined) delete target[parts.at(-1)!]; else target[parts.at(-1)!] = value;
  return result as T;
}
export function capabilityConfigErrors(step: object, definition: CapabilityDefinition): string[] {
  return definition.config.flatMap((field) => {
    const value = readCapabilityConfig(step, field);
    const empty = value === undefined || value === null || value === "";
    if (empty) return field.required ? [field.label + "不能为空"] : [];
    const valid = field.type === "number" ? typeof value === "number" && Number.isFinite(value)
      : field.type === "boolean" ? typeof value === "boolean"
      : field.type === "json" ? typeof value === "object"
      : typeof value === "string";
    if (!valid) return [field.label + "的数据类型不匹配"];
    if (field.type === "select" && !field.options?.includes(String(value))) return [field.label + "的选项无效"];
    return [];
  });
}
