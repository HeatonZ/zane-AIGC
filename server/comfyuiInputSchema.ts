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

export function comfyNodeInputSchema(payload: unknown, nodeType: string, property: string): unknown {
  const root = asRecord(payload), definition = asRecord(root?.[nodeType]) ?? root;
  const input = asRecord(definition?.input);
  for (const section of ["required", "optional"]) {
    const entries = asRecord(input?.[section]);
    if (entries && Object.hasOwn(entries, property)) return entries[property];
    const parent = property.split(".", 1)[0];
    if (entries && Object.hasOwn(entries, parent)) {
      const expanded = comfyNamedAutogrowSchemas(entries[parent], parent);
      if (Object.hasOwn(expanded, property)) return expanded[property];
    }
  }
  return undefined;
}
