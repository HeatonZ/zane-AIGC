import type { ComfyUIBinding, WorkflowDefinition, WorkflowFieldType, WorkflowVariableType } from "../types";

type LegacyComfyInputFormat = NonNullable<ComfyUIBinding["sourceInputFormat"]>;

export function canonicalWorkflowMediaType(type: unknown): "image_list" | "video_list" | "audio_list" | undefined {
  if (type === "image" || type === "image_list") return "image_list";
  if (type === "video" || type === "video_list") return "video_list";
  if (type === "audio" || type === "audio_list") return "audio_list";
  return undefined;
}

export function canonicalWorkflowType(type: unknown): WorkflowFieldType | undefined {
  return canonicalWorkflowMediaType(type) ?? (typeof type === "string" && [
    "text", "textarea", "number", "boolean", "select", "json",
  ].includes(type) ? type as WorkflowFieldType : undefined);
}

function canonicalVariableType(type: unknown): WorkflowVariableType | undefined {
  return canonicalWorkflowType(type) as WorkflowVariableType | undefined;
}

export function normalizeWorkflowMediaTypes<T extends WorkflowDefinition>(workflow: T): T {
  return {
    ...workflow,
    inputs: workflow.inputs.map((field) => ({
      ...field,
      type: canonicalWorkflowType(field.type) ?? field.type,
    })),
    steps: workflow.steps.map((step) => ({
      ...step,
      inputs: step.inputs.map((input) => ({
        ...input,
        ...(input.literalType ? { literalType: canonicalVariableType(input.literalType) ?? input.literalType } : {}),
      })),
      outputs: step.outputs.map((output) => ({
        ...output,
        type: canonicalVariableType(output.type) ?? output.type,
      })),
      ...(step.comfyui ? {
        comfyui: {
          ...step.comfyui,
          bindings: step.comfyui.bindings.map((binding) => ({
            ...binding,
            type: canonicalVariableType(binding.type) ?? binding.type,
            ...(binding.sourceInputFormat ? {
              sourceInputFormat: {
                ...binding.sourceInputFormat,
                type: canonicalWorkflowType(binding.sourceInputFormat.type) ?? binding.sourceInputFormat.type,
              },
            } : {}),
            ...(binding.sourceOutputFormat ? {
              sourceOutputFormat: {
                ...binding.sourceOutputFormat,
                type: canonicalVariableType(binding.sourceOutputFormat.type) ?? binding.sourceOutputFormat.type,
              },
            } : {}),
          })),
        },
      } : {}),
    })),
    outputs: workflow.outputs.map((output) => ({
      ...output,
      type: canonicalVariableType(output.type) ?? output.type,
    })),
  } as T;
}

export function migrateLegacyComfyInputFormats<T extends WorkflowDefinition>(workflow: T): T {
  const formats = new Map<string, LegacyComfyInputFormat>();
  workflow.steps.forEach((step) => step.comfyui?.bindings.forEach((binding) => {
    const inputKey = /^input\.([a-zA-Z0-9_]+)$/.exec(binding.sourceRef ?? "")?.[1];
    if (binding.direction === "input" && inputKey && binding.sourceInputFormat && !formats.has(inputKey)) {
      formats.set(inputKey, binding.sourceInputFormat);
    }
  }));

  const hasLegacyFormats = workflow.steps.some((step) => step.comfyui?.bindings.some((binding) => binding.sourceInputFormat));
  if (!hasLegacyFormats) return workflow;

  return {
    ...workflow,
    inputs: workflow.inputs.map((field) => {
      const format = formats.get(field.key);
      if (!format) return field;
      const { options: _options, optionPresetId: _optionPresetId, ...withoutOptions } = field;
      return {
        ...withoutOptions,
        type: format.type,
        required: format.required,
        ...(format.options ? { options: format.options } : {}),
        ...(format.optionPresetId ? { optionPresetId: format.optionPresetId } : {}),
      };
    }),
    steps: workflow.steps.map((step) => step.comfyui ? {
      ...step,
      comfyui: {
        ...step.comfyui,
        bindings: step.comfyui.bindings.map((binding) => {
          if (!binding.sourceInputFormat) return binding;
          const { sourceInputFormat: _sourceInputFormat, ...withoutSourceInputFormat } = binding;
          return withoutSourceInputFormat;
        }),
      },
    } : step),
  } as T;
}
