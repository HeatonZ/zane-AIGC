import { cloneDefaultWorkflows, createSceneWorkflow } from "../data/workflows";
import type { SceneId, SceneModule, WorkflowDefinition, WorkflowFieldType, WorkflowOptionPreset, WorkflowStepDefinition } from "../types";

const storageKey = "zane-studio:workflows:v1";
const optionPresetStorageKey = "zane-studio:option-presets:v1";

type LegacyWorkflowDefinition = WorkflowDefinition & {
  optionPresets?: unknown;
};

type StoredWorkflowStep = Omit<WorkflowStepDefinition, "kind"> & {
  kind: WorkflowStepDefinition["kind"] | "comfyui_image" | "comfyui_video";
};

function normalizeStep(step: StoredWorkflowStep): WorkflowStepDefinition {
  const kind = step.kind === "comfyui_image" || step.kind === "comfyui_video" ? "comfyui" : step.kind;
  return {
    ...step,
    kind,
    inputs: step.inputs ?? [],
    outputs: kind === "hermes" && !step.outputs?.length
      ? [{ key: "result", label: "结构化结果", type: "json" }]
      : step.outputs ?? [],
    comfyui: kind === "comfyui" ? step.comfyui ?? { workflowFile: "", bindings: [] } : step.comfyui,
  };
}

function normalizeWorkflow(workflow: LegacyWorkflowDefinition): WorkflowDefinition {
  const optionPresets = Array.isArray(workflow.optionPresets)
    ? normalizeOptionPresets(workflow.optionPresets)
    : [];
  const optionPresetMap = new Map(optionPresets.map((preset) => [preset.id, preset]));
  const { optionPresets: _legacyOptionPresets, ...withoutLegacyOptionPresets } = workflow;
  return {
    ...withoutLegacyOptionPresets,
    inputs: workflow.inputs.map((field) => {
      if (field.type !== "select" || !field.optionPresetId) return field;
      const preset = optionPresetMap.get(field.optionPresetId);
      return preset ? { ...field, options: [...preset.options] } : { ...field, optionPresetId: undefined };
    }),
    steps: workflow.steps.map((step) => normalizeStep(step as StoredWorkflowStep)),
  };
}

export function migrateWorkflowExecution(workflow: WorkflowDefinition): WorkflowDefinition {
  const legacyExecution = workflow.execution;
  if (!legacyExecution) return workflow;
  const { execution: _legacyExecution, ...withoutLegacyExecution } = workflow;
  if (legacyExecution.mode !== "for_each" || workflow.steps.some((step) => step.execution?.mode === "for_each")) {
    return withoutLegacyExecution;
  }
  const targetIndex = workflow.steps.findIndex((step) => step.kind !== "control");
  if (targetIndex < 0) return withoutLegacyExecution;
  return {
    ...withoutLegacyExecution,
    steps: workflow.steps.map((step, index) => index === targetIndex ? { ...step, execution: legacyExecution } : step),
  };
}

function workflowReferenceType(workflow: WorkflowDefinition, sourceRef: string): WorkflowFieldType | undefined {
  const inputKey = /^input\.([a-zA-Z0-9_]+)$/.exec(sourceRef)?.[1];
  if (inputKey) {
    const type = workflow.inputs.find((field) => field.key === inputKey)?.type;
    return type === "textarea" || type === "select" ? "text" : type;
  }
  const outputMatch = /^step\.([^.]+)\.outputs\.([^.]+)$/.exec(sourceRef);
  if (!outputMatch) return undefined;
  return workflow.steps.find((step) => step.id === outputMatch[1])?.outputs.find((output) => output.key === outputMatch[2])?.type;
}

function repairWorkflowOutputReferences(workflow: WorkflowDefinition) {
  const stepOutputs = workflow.steps.flatMap((step) => step.outputs.map((output) => ({
    sourceRef: `step.${step.id}.outputs.${output.key}`,
    type: output.type,
  })));
  let repaired = false;
  const outputs = workflow.outputs.map((output) => {
    const sourceType = workflowReferenceType(workflow, output.sourceRef);
    if (!sourceType || sourceType === output.type) return output;
    const candidates = stepOutputs.filter((candidate) => candidate.type === output.type);
    if (candidates.length !== 1) return output;
    repaired = true;
    return { ...output, sourceRef: candidates[0].sourceRef };
  });
  return repaired ? { ...workflow, outputs } : workflow;
}

function migrateLegacyImageToImageWorkflow(workflow: LegacyWorkflowDefinition): LegacyWorkflowDefinition {
  return {
    ...workflow,
    inputs: workflow.inputs.map((field) => field.key === "reference_images" ? { ...field, type: "image_list" } : field),
    steps: workflow.steps.map((step) => {
      if (step.comfyui?.workflowFile !== "Zane/i2i_UI.json") return step;
      const hasLegacyBinding = step.comfyui.bindings?.some((binding) => binding.nodeId === "471" && binding.property === "images_json");
      if (!hasLegacyBinding) return step;
      const bindings = (step.comfyui.bindings ?? []).map((binding) => binding.nodeId === "471" && binding.property === "images_json"
        ? {
          ...binding,
          property: "images",
          type: "image_list" as const,
          ...(binding.sourceInputFormat ? { sourceInputFormat: { ...binding.sourceInputFormat, type: "image_list" as const } } : {}),
        }
        : binding);
      return {
        ...step,
        comfyui: { ...step.comfyui, bindings },
      };
    }),
  };
}

function normalizeOptionPreset(preset: unknown, index: number): WorkflowOptionPreset {
  const value = typeof preset === "object" && preset !== null ? preset as Partial<WorkflowOptionPreset> : {};
  return {
    id: typeof value.id === "string" && value.id ? value.id : `option_preset_${index + 1}`,
    name: typeof value.name === "string" && value.name.trim() ? value.name : `选项预设 ${index + 1}`,
    options: Array.isArray(value.options)
      ? [...new Set(value.options.filter((option): option is string => typeof option === "string").map((option) => option.trim()).filter(Boolean))]
      : [],
  };
}

function normalizeOptionPresets(value: unknown): WorkflowOptionPreset[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  return value.map((preset, index) => normalizeOptionPreset(preset, index)).filter((preset) => {
    if (seen.has(preset.id)) return false;
    seen.add(preset.id);
    return true;
  });
}

function legacyOptionPresets(): WorkflowOptionPreset[] {
  try {
    const saved = window.localStorage.getItem(storageKey);
    if (!saved) return [];
    const parsed = JSON.parse(saved) as Record<string, LegacyWorkflowDefinition>;
    return (Object.values(parsed) as Array<LegacyWorkflowDefinition | undefined>).flatMap((workflow) => normalizeOptionPresets(workflow?.optionPresets));
  } catch {
    return [];
  }
}

export function readWorkflows(scenes: SceneModule[]): Record<SceneId, WorkflowDefinition> {
  try {
    const saved = window.localStorage.getItem(storageKey);
    const parsed = saved ? JSON.parse(saved) as Record<string, LegacyWorkflowDefinition> : {};
    const defaults = cloneDefaultWorkflows();
    let repairedSavedWorkflow = false;
    const workflows = Object.fromEntries(scenes.map((scene) => {
      const savedWorkflow = parsed[scene.id];
      const defaultWorkflow = defaults[scene.id];
      const usesLegacyImageToImageApi = scene.id === "image_to_image"
        && savedWorkflow?.steps.some((step) => step.comfyui?.workflowFile === "Zane/Basic_Image_to_Image_Zane_API.json");
      const usesLegacyQwenImageWrapper = scene.id === "image_to_image"
        && savedWorkflow?.steps.some((step) => step.comfyui?.workflowFile === "Zane/i2i_UI.json"
          && step.comfyui.bindings?.some((binding) => binding.nodeId === "471" && binding.property === "images_json"));
      const workflow = usesLegacyImageToImageApi
        ? defaultWorkflow
        : usesLegacyQwenImageWrapper && savedWorkflow
          ? migrateLegacyImageToImageWorkflow(savedWorkflow)
          : savedWorkflow ?? defaultWorkflow ?? createSceneWorkflow(scene);
      const normalized = normalizeWorkflow(workflow);
      const repaired = repairWorkflowOutputReferences(normalized);
      const migrated = migrateWorkflowExecution(repaired);
      if (savedWorkflow && migrated !== normalized) {
        parsed[scene.id] = migrated;
        repairedSavedWorkflow = true;
      }
      return [scene.id, migrated];
    }));
    if (repairedSavedWorkflow) window.localStorage.setItem(storageKey, JSON.stringify(parsed));
    return workflows;
  } catch {
    const defaults = cloneDefaultWorkflows();
    return Object.fromEntries(scenes.map((scene) => [scene.id, defaults[scene.id] ?? createSceneWorkflow(scene)]));
  }
}

export function writeWorkflows(workflows: Record<SceneId, WorkflowDefinition>) {
  const withoutLegacyOptionPresets = Object.fromEntries(Object.entries(workflows).map(([sceneId, workflow]) => {
    const { optionPresets: _legacyOptionPresets, ...normalizedWorkflow } = workflow as LegacyWorkflowDefinition;
    return [sceneId, normalizedWorkflow];
  }));
  window.localStorage.setItem(storageKey, JSON.stringify(withoutLegacyOptionPresets));
}

export function readOptionPresets(): WorkflowOptionPreset[] {
  try {
    const saved = window.localStorage.getItem(optionPresetStorageKey);
    if (saved !== null) return normalizeOptionPresets(JSON.parse(saved));
    const migrated = legacyOptionPresets();
    window.localStorage.setItem(optionPresetStorageKey, JSON.stringify(migrated));
    return migrated;
  } catch {
    return [];
  }
}

export function writeOptionPresets(optionPresets: WorkflowOptionPreset[]) {
  window.localStorage.setItem(optionPresetStorageKey, JSON.stringify(normalizeOptionPresets(optionPresets)));
}
