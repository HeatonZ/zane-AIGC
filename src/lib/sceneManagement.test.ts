import assert from "node:assert/strict";
import test from "node:test";
import {
  parseScenePackage,
  prepareImportedScene,
  serializeScenePackage,
} from "./sceneTransfer";
import {
  createSceneVersion,
  publishSceneVersion,
  restoreSceneVersionDraft,
} from "./sceneVersions";
import type { SceneModule, WorkflowDefinition, WorkflowOptionPreset } from "../types";

const scene: SceneModule = {
  id: "scene_demo",
  title: "演示场景",
  shortTitle: "演示",
  summary: "用于场景管理测试",
  description: "验证发布、恢复和导入导出",
  cover: "",
  coverPosition: "center",
  accent: "green",
  stages: ["输入", "处理", "输出"],
};

const sharedPreset: WorkflowOptionPreset = {
  id: "preset_style",
  name: "风格",
  options: ["电影感", "插画感"],
};

const unusedPreset: WorkflowOptionPreset = {
  id: "preset_unused",
  name: "未引用",
  options: ["A", "B"],
};

const workflow: WorkflowDefinition = {
  sceneId: scene.id,
  name: "演示场景流程",
  inputs: [
    { key: "prompt", label: "提示词", type: "textarea", required: true },
    {
      key: "style",
      label: "风格",
      type: "select",
      required: false,
      options: [...sharedPreset.options],
      optionPresetId: sharedPreset.id,
    },
  ],
  steps: [{
    id: "step_generate",
    name: "生成",
    kind: "comfyui",
    inputs: [{
      key: "reference",
      label: "参考图",
      sourceRef: "input.reference_images",
      selection: { mode: "item", index: 1 },
    }],
    outputs: [{ key: "images", label: "生成图像", type: "image" }],
    promptTemplate: "{{input.prompt}}",
    comfyui: {
      workflowFile: "demo.json",
      bindings: [{
        key: "images",
        label: "输出图像",
        direction: "output",
        nodeId: "2",
        property: "images",
        type: "image",
        selection: { mode: "all" },
      }],
    },
  }],
  outputs: [{
    key: "result",
    label: "结果",
    type: "image",
    sourceRef: "step.step_generate.outputs.images",
    selection: { mode: "item", index: 0 },
  }],
};

function clone<T>(value: T): T {
  return structuredClone(value);
}

test("publishing the same scene snapshot is idempotent and changes create a version", () => {
  const first = publishSceneVersion(undefined, scene, workflow, [sharedPreset]);
  assert.equal(first.created, true);
  assert.ok(first.version);

  const duplicate = publishSceneVersion(first.record, clone(scene), clone(workflow), [clone(sharedPreset)]);
  assert.equal(duplicate.created, false);
  assert.equal(duplicate.version?.id, first.version?.id);
  assert.equal(duplicate.record.versions.length, 1);

  const changed = publishSceneVersion(first.record, scene, { ...workflow, name: "演示场景流程 v2" }, [sharedPreset]);
  assert.equal(changed.created, true);
  assert.notEqual(changed.version?.version, first.version?.version);
  assert.equal(changed.record.publishedVersionId, changed.version?.id);
  assert.equal(changed.record.versions.length, 2);
});

test("publishing keeps only the ten newest versions", () => {
  let record = publishSceneVersion(undefined, scene, workflow, [sharedPreset]).record;
  for (let index = 1; index <= 12; index += 1) {
    const result = publishSceneVersion(record, scene, { ...workflow, name: `演示场景流程 ${index}` }, [sharedPreset]);
    assert.equal(result.created, true);
    record = result.record;
  }
  assert.equal(record.versions.length, 10);
  assert.ok(record.publishedVersionId);
  assert.equal(record.versions.some((version) => version.id === record.publishedVersionId), true);
});

test("restoring a version remaps a conflicting option preset ID", () => {
  const version = createSceneVersion(scene, workflow, [sharedPreset]);
  const conflictingPreset = { ...sharedPreset, options: ["水彩感"] };
  const restored = restoreSceneVersionDraft(version, [conflictingPreset]);
  const restoredPresetId = restored.workflow.inputs.find((input) => input.key === "style")?.optionPresetId;

  assert.ok(restoredPresetId);
  assert.notEqual(restoredPresetId, sharedPreset.id);
  assert.equal(restored.optionPresets.length, 2);
  assert.deepEqual(restored.optionPresets.find((preset) => preset.id === restoredPresetId)?.options, sharedPreset.options);
  assert.equal(restored.workflow.sceneId, scene.id);
});

test("scene packages round-trip media selections and include only referenced presets", () => {
  const serialized = serializeScenePackage(scene, workflow, [sharedPreset, unusedPreset]);
  const parsed = parseScenePackage(JSON.parse(serialized));

  assert.equal(parsed.optionPresets.length, 1);
  assert.equal(parsed.optionPresets[0].id, sharedPreset.id);
  assert.deepEqual(parsed.workflow.steps[0].inputs[0].selection, { mode: "item", index: 1 });
  assert.deepEqual(parsed.workflow.steps[0].comfyui?.bindings[0].selection, { mode: "all" });
  assert.deepEqual(parsed.workflow.outputs[0].selection, { mode: "item", index: 0 });
});

test("importing a package creates a new scene and remaps a colliding preset", () => {
  const packageValue = parseScenePackage(JSON.parse(serializeScenePackage(scene, workflow, [sharedPreset])));
  const imported = prepareImportedScene(packageValue, [{ ...sharedPreset, options: ["水彩感"] }]);
  const importedPresetId = imported.workflow.inputs.find((input) => input.key === "style")?.optionPresetId;

  assert.notEqual(imported.scene.id, scene.id);
  assert.equal(imported.workflow.sceneId, imported.scene.id);
  assert.ok(importedPresetId);
  assert.notEqual(importedPresetId, sharedPreset.id);
  assert.equal(imported.optionPresets.length, 1);
  assert.deepEqual(imported.optionPresets[0].options, sharedPreset.options);
});

test("invalid scene packages are rejected before import", () => {
  assert.throws(
    () => parseScenePackage({ format: "unknown", version: 1 }),
    /无法识别这个场景文件/,
  );
});
