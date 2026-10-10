import { isRuntimeMediaValue, createRuntimeMediaValue, selectRuntimeMedia } from "../runtimeValue.js";
import { comfyBindingMediaKind } from "./comfyMediaBindings.js";
import { resolveWorkflowReference, workflowReferenceRoot, parseWorkflowLiteral } from "../domain/workflowValues.js";
import type { RunComfyBinding } from "../domain/types.js";
import type { JsonValue } from "../domain/types.js";

export interface ResolvedComfyInputBinding {
  binding: RunComfyBinding;
  sourceField?: { key: string; required?: boolean };
  value: JsonValue | undefined;
  mediaKind?: "image" | "audio" | "video";
}

/**
 * Resolve input bindings against the run inputs and prior step outputs.
 *
 * A media selection that points past the end of its list marks an optional
 * numbered slot (for example the fixed `audio1..audioN` inputs of an audio-list
 * bridge node). Such a slot is skipped so the graph keeps the workflow file's
 * saved default for that input; a required binding still fails loudly instead of
 * silently dropping media.
 */
export function resolveComfyInputBindings(options: {
  bindings: readonly RunComfyBinding[];
  inputs: Record<string, JsonValue>;
  stepValues: Map<string, Record<string, JsonValue>>;
  inputFields: readonly { key: string; type: string; required?: boolean }[];
  variableTypes: Map<string, string>;
  stepName: string;
}): ResolvedComfyInputBinding[] {
  const { bindings, inputs, stepValues, inputFields, variableTypes, stepName } = options;
  const resolved: ResolvedComfyInputBinding[] = [];
  for (const binding of bindings) {
    if (binding.direction !== "input") continue;
    const inputKey = binding.valueSource === "literal" ? undefined : /^input\.([a-zA-Z0-9_]+)$/.exec(workflowReferenceRoot(binding.sourceRef ?? ""))?.[1];
    const sourceField = inputKey ? inputFields.find((field) => field.key === inputKey) : undefined;
    const sourceType = binding.valueSource === "literal" ? binding.type : variableTypes.get(workflowReferenceRoot(binding.sourceRef ?? "")) ?? sourceField?.type ?? binding.type;
    const rawValue = binding.valueSource === "literal"
      ? parseWorkflowLiteral(binding.literalValue, binding.type, binding.label ?? binding.key)
      : resolveWorkflowReference(binding.sourceRef ?? "", inputs, stepValues);
    const mediaKind = comfyBindingMediaKind(rawValue, sourceType, binding.type);
    const normalizedValue = mediaKind && !isRuntimeMediaValue(rawValue) ? createRuntimeMediaValue(mediaKind, rawValue) : rawValue;
    if (binding.selection?.mode === "item" && isRuntimeMediaValue(normalizedValue) && normalizedValue.items.length <= (binding.selection.index ?? 0)) {
      const label = binding.label ?? binding.key;
      if (binding.required ?? sourceField?.required) throw new Error(`${stepName} 的 ${label} 引用的媒体不存在，不能静默留空`);
      continue;
    }
    const value = (binding.selection ? selectRuntimeMedia(normalizedValue, binding.selection) : normalizedValue) as JsonValue | undefined;
    resolved.push({ binding, sourceField, value, mediaKind });
  }
  return resolved;
}
