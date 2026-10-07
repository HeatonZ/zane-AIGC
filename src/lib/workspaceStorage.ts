import { sortWorkflowDrafts } from "./drafts";
import type { WorkspaceSnapshot } from "../types";

const workspaceFormat = "zane-studio.workspace/v1" as const;

/** A loading placeholder / explicit empty initialization, never a browser-owned scene catalog. */
export function createEmptyWorkspaceSnapshot(): WorkspaceSnapshot {
  return { format: workspaceFormat, scenes: [], workflows: {}, optionPresets: [], drafts: [], sceneVersions: {} };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function normalizeWorkspaceSnapshot(value: unknown, fallback: WorkspaceSnapshot): WorkspaceSnapshot {
  if (!isRecord(value)) return fallback;
  const scenes = Array.isArray(value.scenes) ? value.scenes as WorkspaceSnapshot["scenes"] : fallback.scenes;
  const workflows = isRecord(value.workflows)
    ? value.workflows as WorkspaceSnapshot["workflows"]
    : fallback.workflows;
  const optionPresets = Array.isArray(value.optionPresets)
    ? value.optionPresets as WorkspaceSnapshot["optionPresets"]
    : fallback.optionPresets;
  const drafts = Array.isArray(value.drafts)
    ? sortWorkflowDrafts(value.drafts as WorkspaceSnapshot["drafts"])
    : fallback.drafts;
  const sceneVersions = isRecord(value.sceneVersions) ? value.sceneVersions as WorkspaceSnapshot["sceneVersions"] : {};
  return {
    format: workspaceFormat,
    ...(typeof value.revision === "number" ? { revision: value.revision } : {}),
    scenes,
    workflows,
    optionPresets,
    drafts,
    sceneVersions,
  };
}
