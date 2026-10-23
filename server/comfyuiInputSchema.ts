import { asRecord } from "./domain/workflowValues.js";

/** Expand only enumerated-name V3 autogrow ports. Never accept arbitrary dotted input names. */
export function comfyNamedAutogrowSchemas(rawSchema: unknown, parent: string): Record<string, unknown> {
  if (!Array.isArray(rawSchema) || rawSchema[0] !== "COMFY_AUTOGROW_V3") return {};
  const template = asRecord(asRecord(rawSchema[1])?.template);
  if (!Array.isArray(template?.names) || !template.names.length || template.names.length > 1000) return {};
  const input = asRecord(template.input);
  const entries = [...Object.entries(asRecord(input?.required) ?? {}), ...Object.entries(asRecord(input?.optional) ?? {})];
  if (entries.length !== 1 || !Array.isArray(entries[0][1])) return {};
  const schema = entries[0][1];
  return Object.fromEntries(template.names.flatMap(name => typeof name === "string" && /^[a-zA-Z0-9_]+$/.test(name) ? [[parent + "." + name, schema]] : []));
}

/** Options of a V3 dynamic combo: each one declares the inputs it adds while selected. */
export function comfyDynamicComboOptions(rawSchema: unknown): Array<{ key: string; inputs: Record<string, unknown> }> {
  if (!Array.isArray(rawSchema) || rawSchema[0] !== "COMFY_DYNAMICCOMBO_V3") return [];
  const options = asRecord(rawSchema[1])?.options;
  if (!Array.isArray(options) || !options.length || options.length > 1000) return [];
  return options.flatMap(value => {
    const option = asRecord(value);
    return typeof option?.key === "string" && asRecord(option.inputs) ? [{ key: option.key, inputs: asRecord(option.inputs)! }] : [];
  });
}

/**
 * Children a dynamic combo contributes under the selected option only. ComfyUI finalizes
 * them as `<parent>.<child>` in the executed prompt, so a binding addresses that dotted name.
 * An unknown or missing selection expands nothing: the child does not exist at runtime.
 */
export function comfyDynamicComboSchemas(rawSchema: unknown, parent: string, selected: unknown): Record<string, unknown> {
  if (typeof selected !== "string") return {};
  const option = comfyDynamicComboOptions(rawSchema).find(candidate => candidate.key === selected);
  if (!option) return {};
  return Object.fromEntries(["required", "optional"].flatMap(section => Object.entries(asRecord(option.inputs[section]) ?? {}))
    .flatMap(([name, schema]) => /^[a-zA-Z0-9_]+$/.test(name) ? [[parent + "." + name, schema] as const] : []));
}

export function comfyNodeInputSchema(payload: unknown, nodeType: string, property: string, selected?: unknown): unknown {
  const root = asRecord(payload), definition = asRecord(root?.[nodeType]) ?? root;
  const input = asRecord(definition?.input);
  for (const section of ["required", "optional"]) {
    const entries = asRecord(input?.[section]);
    if (entries && Object.hasOwn(entries, property)) return entries[property];
    const parent = property.split(".", 1)[0];
    if (entries && Object.hasOwn(entries, parent)) {
      const expanded = comfyNamedAutogrowSchemas(entries[parent], parent);
      if (Object.hasOwn(expanded, property)) return expanded[property];
      const dynamic = comfyDynamicComboSchemas(entries[parent], parent, selected);
      if (Object.hasOwn(dynamic, property)) return dynamic[property];
    }
  }
  return undefined;
}
