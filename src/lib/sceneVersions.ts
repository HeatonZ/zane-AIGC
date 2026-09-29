import { md5 } from "js-md5";
import { createSceneWorkflow } from "../data/workflows";
import { createId } from "./ids";
import type {
  SceneModule,
  SceneVersion,
  SceneVersionRecord,
  WorkflowDefinition,
  WorkflowOptionPreset,
} from "../types";

const MAX_SCENE_VERSIONS = 10;
const VERSION_HASH_LENGTH = 8;

function referencedPresetIds(workflow: WorkflowDefinition) {
  const ids = new Set<string>();
  workflow.inputs.forEach((input) => {
    if (input.optionPresetId) ids.add(input.optionPresetId);
  });
  workflow.steps.forEach((step) => step.comfyui?.bindings.forEach((binding) => {
    if (binding.sourceInputFormat?.optionPresetId) ids.add(binding.sourceInputFormat.optionPresetId);
  }));
  return ids;
}

function versionContent(scene: SceneModule, workflow: WorkflowDefinition, optionPresets: WorkflowOptionPreset[]) {
  const presetIds = referencedPresetIds(workflow);
  return {
    scene,
    workflow: { ...workflow, sceneId: scene.id },
    optionPresets: optionPresets.filter((preset) => presetIds.has(preset.id)).sort((left, right) => left.id.localeCompare(right.id)),
  };
}

function sortJsonKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJsonKeys);
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(Object.keys(record).sort().map((key) => [key, sortJsonKeys(record[key])]));
  }
  return value;
}

function shortMd5(value: unknown) {
  return md5(JSON.stringify(sortJsonKeys(value)) ?? "").slice(0, VERSION_HASH_LENGTH);
}

export function sceneVersionHash(scene: SceneModule, workflow: WorkflowDefinition, optionPresets: WorkflowOptionPreset[]) {
  return shortMd5(versionContent(scene, workflow, optionPresets));
}

export function createSceneVersion(
  scene: SceneModule,
  workflow: WorkflowDefinition,
  optionPresets: WorkflowOptionPreset[],
): SceneVersion {
  const content = structuredClone(versionContent(scene, workflow, optionPresets));
  return {
    id: createId(),
    version: shortMd5(content),
    publishedAt: new Date().toISOString(),
    ...content,
  };
}

export function sceneDraftMatchesVersion(
  scene: SceneModule,
  workflow: WorkflowDefinition,
  optionPresets: WorkflowOptionPreset[],
  version: SceneVersion | undefined,
) {
  if (!version) return false;
  return JSON.stringify(versionContent(scene, workflow, optionPresets)) === JSON.stringify(versionContent(version.scene, version.workflow, version.optionPresets));
}

export function initialSceneVersions(
  scenes: SceneModule[],
  workflows: Record<string, WorkflowDefinition>,
  optionPresets: WorkflowOptionPreset[],
): Record<string, SceneVersionRecord> {
  return Object.fromEntries(scenes.map((scene) => {
    const workflow = workflows[scene.id] ?? createSceneWorkflow(scene);
    const version = createSceneVersion(scene, workflow, optionPresets);
    return [scene.id, { publishedVersionId: version.id, versions: [version] }];
  }));
}

export function publishedSceneVersion(record: SceneVersionRecord | undefined) {
  if (!record?.publishedVersionId) return undefined;
  return record.versions.find((version) => version.id === record.publishedVersionId);
}

export function publishSceneVersion(
  record: SceneVersionRecord | undefined,
  scene: SceneModule,
  workflow: WorkflowDefinition,
  optionPresets: WorkflowOptionPreset[],
) {
  const currentRecord = record ?? { publishedVersionId: null, versions: [] };
  const currentPublished = publishedSceneVersion(currentRecord);
  if (sceneDraftMatchesVersion(scene, workflow, optionPresets, currentPublished)) {
    return { record: currentRecord, version: currentPublished, created: false };
  }
  const version = createSceneVersion(scene, workflow, optionPresets);
  const versions = [...currentRecord.versions, version]
    .sort((left, right) => left.publishedAt.localeCompare(right.publishedAt))
    .slice(-MAX_SCENE_VERSIONS);
  return {
    record: { publishedVersionId: version.id, versions },
    version,
    created: true,
  };
}

function sameOptions(left: string[], right: string[]) {
  return left.length === right.length && left.every((option, index) => option === right[index]);
}

function remapWorkflowPresetIds(workflow: WorkflowDefinition, presetIds: Map<string, string>) {
  const mapPresetId = (id: string | undefined) => id ? presetIds.get(id) ?? id : undefined;
  return {
    ...structuredClone(workflow),
    inputs: workflow.inputs.map((input) => ({ ...input, optionPresetId: mapPresetId(input.optionPresetId) })),
    steps: workflow.steps.map((step) => ({
      ...step,
      comfyui: step.comfyui ? {
        ...step.comfyui,
        bindings: step.comfyui.bindings.map((binding) => ({
          ...binding,
          sourceInputFormat: binding.sourceInputFormat ? {
            ...binding.sourceInputFormat,
            optionPresetId: mapPresetId(binding.sourceInputFormat.optionPresetId),
          } : binding.sourceInputFormat,
        })),
      } : step.comfyui,
    })),
  };
}

export function restoreSceneVersionDraft(version: SceneVersion, existingOptionPresets: WorkflowOptionPreset[]) {
  const existingById = new Map(existingOptionPresets.map((preset) => [preset.id, preset]));
  const presetIds = new Map<string, string>();
  const additions: WorkflowOptionPreset[] = [];
  version.optionPresets.forEach((preset) => {
    const existing = existingById.get(preset.id);
    if (!existing) {
      presetIds.set(preset.id, preset.id);
      additions.push(structuredClone(preset));
      return;
    }
    if (existing.name === preset.name && sameOptions(existing.options, preset.options)) {
      presetIds.set(preset.id, preset.id);
      return;
    }
    const newId = `option_preset_${createId()}`;
    presetIds.set(preset.id, newId);
    additions.push({ ...structuredClone(preset), id: newId });
  });
  return {
    scene: structuredClone(version.scene),
    workflow: { ...remapWorkflowPresetIds(version.workflow, presetIds), sceneId: version.scene.id },
    optionPresets: [...existingOptionPresets, ...additions],
  };
}
