import { cloneDefaultWorkflows } from "../data/workflows";
import type { SceneId, WorkflowDefinition } from "../types";

const storageKey = "zane-studio:workflows:v1";

export function readWorkflows(): Record<SceneId, WorkflowDefinition> {
  try {
    const saved = window.localStorage.getItem(storageKey);
    return saved ? { ...cloneDefaultWorkflows(), ...(JSON.parse(saved) as Partial<Record<SceneId, WorkflowDefinition>>) } : cloneDefaultWorkflows();
  } catch {
    return cloneDefaultWorkflows();
  }
}

export function writeWorkflows(workflows: Record<SceneId, WorkflowDefinition>) {
  window.localStorage.setItem(storageKey, JSON.stringify(workflows));
}

