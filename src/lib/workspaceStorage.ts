import { readDrafts, writeDrafts } from "./drafts";
import { readScenes, writeScenes } from "./sceneStorage";
import { migrateWorkflowExecution, readOptionPresets, readWorkflows, writeOptionPresets, writeWorkflows } from "./workflowStorage";
import { initialSceneVersions, sceneVersionHash } from "./sceneVersions";
import { migrateLegacyComfyInputFormats, normalizeWorkflowMediaTypes } from "./workflowMigration";
import type { SceneId, SceneVersion, SceneVersionRecord, WorkspaceSnapshot } from "../types";

const workspaceFormat = "zane-studio.workspace/v1" as const;
const sceneVersionsStorageKey = "zane-studio:scene-versions:v1";

function sortDrafts<T extends { createdAt: string }>(drafts: T[]) {
  return [...drafts].sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function readLocalWorkspace(): WorkspaceSnapshot {
  const scenes = readScenes();
  const workflows = readWorkflows(scenes);
  const optionPresets = readOptionPresets();
  let sceneVersions: Record<SceneId, SceneVersionRecord>;
  try {
    const saved = window.localStorage.getItem(sceneVersionsStorageKey);
    sceneVersions = saved ? JSON.parse(saved) as Record<SceneId, SceneVersionRecord> : initialSceneVersions(scenes, workflows, optionPresets);
  } catch {
    sceneVersions = initialSceneVersions(scenes, workflows, optionPresets);
  }
  return {
    format: workspaceFormat,
    scenes,
    workflows,
    optionPresets,
    drafts: sortDrafts(readDrafts()),
    sceneVersions: normalizeSceneVersions(sceneVersions, scenes, workflows, optionPresets),
  };
}

export function writeLocalWorkspace(workspace: WorkspaceSnapshot) {
  writeScenes(workspace.scenes);
  writeWorkflows(workspace.workflows);
  writeOptionPresets(workspace.optionPresets);
  writeDrafts(workspace.drafts);
  window.localStorage.setItem(sceneVersionsStorageKey, JSON.stringify(workspace.sceneVersions));
}

type StoredSceneVersion = Omit<SceneVersion, "version"> & { version: string | number };

function validSceneVersion(value: unknown, sceneId: SceneId): value is StoredSceneVersion {
  const validVersion = isRecord(value) && (
    (typeof value.version === "number" && Number.isInteger(value.version))
    || (typeof value.version === "string" && /^[a-f0-9]{8}$/i.test(value.version))
  );
  if (!isRecord(value) || typeof value.id !== "string" || !value.id || !validVersion || typeof value.publishedAt !== "string") return false;
  if (!isRecord(value.scene) || !isRecord(value.workflow) || !Array.isArray(value.optionPresets)) return false;
  if (!Array.isArray(value.workflow.inputs) || !Array.isArray(value.workflow.steps) || !Array.isArray(value.workflow.outputs)) return false;
  return value.scene.id === sceneId;
}

function normalizeSceneVersions(
  value: unknown,
  scenes: WorkspaceSnapshot["scenes"],
  workflows: WorkspaceSnapshot["workflows"],
  optionPresets: WorkspaceSnapshot["optionPresets"],
): WorkspaceSnapshot["sceneVersions"] {
  if (!isRecord(value)) return initialSceneVersions(scenes, workflows, optionPresets);
  return Object.fromEntries(scenes.map((scene) => {
    const recordValue = value[scene.id];
    if (!isRecord(recordValue) || !Array.isArray(recordValue.versions)) {
      return [scene.id, { publishedVersionId: null, versions: [] }];
    }
    const versions = recordValue.versions
      .filter((version) => validSceneVersion(version, scene.id))
      .map((version): SceneVersion => {
        const normalizedScene = { ...version.scene, id: scene.id };
        const normalizedWorkflow = migrateWorkflowExecution(normalizeWorkflowMediaTypes(migrateLegacyComfyInputFormats({ ...version.workflow, sceneId: scene.id })));
        return {
          ...version,
          version: sceneVersionHash(normalizedScene, normalizedWorkflow, version.optionPresets),
          scene: normalizedScene,
          workflow: normalizedWorkflow,
        };
      })
      .sort((left, right) => left.publishedAt.localeCompare(right.publishedAt))
      .slice(-10);
    const publishedVersionId = typeof recordValue.publishedVersionId === "string"
      && versions.some((version) => version.id === recordValue.publishedVersionId)
      ? recordValue.publishedVersionId
      : null;
    return [scene.id, { publishedVersionId, versions }];
  }));
}

export function hasLegacyNumericSceneVersions(value: unknown) {
  if (!isRecord(value)) return false;
  return Object.values(value).some((record) => isRecord(record)
    && Array.isArray(record.versions)
    && record.versions.some((version) => isRecord(version) && typeof version.version === "number"));
}

export function normalizeWorkspaceSnapshot(value: unknown, fallback: WorkspaceSnapshot): WorkspaceSnapshot {
  if (!isRecord(value)) return fallback;
  const scenes = Array.isArray(value.scenes) ? value.scenes as WorkspaceSnapshot["scenes"] : fallback.scenes;
  const workflows = isRecord(value.workflows)
    ? Object.fromEntries(Object.entries(value.workflows).map(([sceneId, workflow]) => [sceneId, migrateWorkflowExecution(normalizeWorkflowMediaTypes(migrateLegacyComfyInputFormats(workflow as WorkspaceSnapshot["workflows"][SceneId])))])) as Record<SceneId, WorkspaceSnapshot["workflows"][SceneId]>
    : fallback.workflows;
  const optionPresets = Array.isArray(value.optionPresets)
    ? value.optionPresets as WorkspaceSnapshot["optionPresets"]
    : fallback.optionPresets;
  const drafts = Array.isArray(value.drafts)
    ? sortDrafts(value.drafts as WorkspaceSnapshot["drafts"])
    : fallback.drafts;
  const sceneVersions = normalizeSceneVersions(value.sceneVersions, scenes, workflows, optionPresets);
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
