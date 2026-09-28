import { cloneDefaultWorkflows } from "../data/workflows";
import type { SceneId, WorkflowDefinition, WorkflowOptionPreset, WorkflowStepDefinition } from "../types";

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
    const parsed = JSON.parse(saved) as Partial<Record<SceneId, LegacyWorkflowDefinition>>;
    return (Object.values(parsed) as Array<LegacyWorkflowDefinition | undefined>).flatMap((workflow) => normalizeOptionPresets(workflow?.optionPresets));
  } catch {
    return [];
  }
}

export function readWorkflows(): Record<SceneId, WorkflowDefinition> {
  try {
    const saved = window.localStorage.getItem(storageKey);
    if (!saved) return cloneDefaultWorkflows();
    const defaults = cloneDefaultWorkflows();
    const parsed = JSON.parse(saved) as Partial<Record<SceneId, LegacyWorkflowDefinition>>;
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
