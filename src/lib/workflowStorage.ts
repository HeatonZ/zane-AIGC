import { cloneDefaultWorkflows } from "../data/workflows";
import type { SceneId, WorkflowDefinition, WorkflowOptionPreset, WorkflowStepDefinition } from "../types";

const storageKey = "zane-studio:workflows:v1";

type StoredWorkflowStep = Omit<WorkflowStepDefinition, "kind"> & {
  kind: WorkflowStepDefinition["kind"] | "comfyui_image" | "comfyui_video";
};

function normalizeStep(step: StoredWorkflowStep): WorkflowStepDefinition {
  const kind = step.kind === "comfyui_image" || step.kind === "comfyui_video" ? "comfyui" : step.kind;
  return {
    ...step,
    kind,
    comfyui: kind === "comfyui" ? step.comfyui ?? { workflowFile: "", bindings: [] } : step.comfyui,
  };
}

function normalizeWorkflow(workflow: WorkflowDefinition): WorkflowDefinition {
  const optionPresets = Array.isArray(workflow.optionPresets)
    ? workflow.optionPresets.map((preset, index) => normalizeOptionPreset(preset, index))
    : [];
  const optionPresetMap = new Map(optionPresets.map((preset) => [preset.id, preset]));
  return {
    ...workflow,
    optionPresets,
    inputs: workflow.inputs.map((field) => {
      if (field.type !== "select" || !field.optionPresetId) return field;
      const preset = optionPresetMap.get(field.optionPresetId);
      return preset ? { ...field, options: [...preset.options] } : { ...field, optionPresetId: undefined };
    }),
    steps: workflow.steps.map((step) => normalizeStep(step as StoredWorkflowStep)),
  };
}

function normalizeOptionPreset(preset: WorkflowOptionPreset, index: number): WorkflowOptionPreset {
  return {
    id: typeof preset?.id === "string" && preset.id ? preset.id : `option_preset_${index + 1}`,
    name: typeof preset?.name === "string" && preset.name.trim() ? preset.name : `选项预设 ${index + 1}`,
    options: Array.isArray(preset?.options)
      ? [...new Set(preset.options.filter((option): option is string => typeof option === "string").map((option) => option.trim()).filter(Boolean))]
      : [],
  };
}

export function readWorkflows(): Record<SceneId, WorkflowDefinition> {
  try {
    const saved = window.localStorage.getItem(storageKey);
    if (!saved) return cloneDefaultWorkflows();
    const defaults = cloneDefaultWorkflows();
    const parsed = JSON.parse(saved) as Partial<Record<SceneId, WorkflowDefinition>>;
    return (Object.keys(defaults) as SceneId[]).reduce((result, sceneId) => {
      const workflow = parsed[sceneId] ?? defaults[sceneId];
      result[sceneId] = normalizeWorkflow(workflow);
      return result;
    }, {} as Record<SceneId, WorkflowDefinition>);
  } catch {
    return cloneDefaultWorkflows();
  }
}

export function writeWorkflows(workflows: Record<SceneId, WorkflowDefinition>) {
  window.localStorage.setItem(storageKey, JSON.stringify(workflows));
}
