import { cloneDefaultWorkflows } from "../data/workflows";
import type { SceneId, WorkflowDefinition, WorkflowStepDefinition } from "../types";

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
  return {
    ...workflow,
    steps: workflow.steps.map((step) => normalizeStep(step as StoredWorkflowStep)),
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
