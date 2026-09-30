import assert from "node:assert/strict";
import test from "node:test";
import { canonicalWorkflowMediaType, canonicalWorkflowType, migrateLegacyComfyInputFormats, normalizeWorkflowMediaTypes } from "./workflowMigration";
import type { WorkflowDefinition } from "../types";

const legacy: WorkflowDefinition = {
  sceneId: "media_test",
  name: "媒体兼容测试",
  inputs: [
    { key: "image", label: "图片", type: "image", required: false },
    { key: "video", label: "视频", type: "video", required: false },
    { key: "audio", label: "音频", type: "audio", required: false },
  ],
  steps: [{
    id: "generate", name: "生成", kind: "comfyui", promptTemplate: "",
    inputs: [{ key: "audio", label: "音频", sourceRef: "", valueSource: "literal", literalType: "audio", literalValue: '["clip.wav"]' }],
    outputs: [{ key: "video", label: "视频", type: "video" }],
    execution: { mode: "for_each", sourceRef: "input.image" },
    comfyui: { workflowFile: "demo.json", bindings: [{
      key: "image", label: "图片", direction: "input", nodeId: "1", property: "image", type: "image", sourceRef: "input.image",
      selection: { mode: "item", index: 1 },
      sourceInputFormat: { type: "image", required: true },
      sourceOutputFormat: { stepId: "previous", outputKey: "audio", type: "audio" },
    }] },
  }],
  outputs: [{ key: "video", label: "视频", type: "video", sourceRef: "step.generate.outputs.video", selection: { mode: "all" } }],
};

test("old media names and list names have one canonical type", () => {
  for (const kind of ["image", "video", "audio"] as const) {
    assert.equal(canonicalWorkflowMediaType(kind), kind + "_list");
    assert.equal(canonicalWorkflowMediaType(kind + "_list"), kind + "_list");
  }
  assert.equal(canonicalWorkflowType("json"), "json");
  assert.equal(canonicalWorkflowType("textarea"), "textarea");
  assert.equal(canonicalWorkflowType("unsupported"), undefined);
});

test("migration updates every media declaration and preserves selection and execution", () => {
  const result = normalizeWorkflowMediaTypes(legacy);
  assert.deepEqual(result.inputs.map((field) => field.type), ["image_list", "video_list", "audio_list"]);
  assert.equal(result.steps[0].inputs[0].literalType, "audio_list");
  assert.equal(result.steps[0].inputs[0].literalValue, '["clip.wav"]');
  assert.equal(result.steps[0].outputs[0].type, "video_list");
  assert.equal(result.steps[0].comfyui?.bindings[0].type, "image_list");
  assert.equal(result.steps[0].comfyui?.bindings[0].sourceInputFormat?.type, "image_list");
  assert.equal(result.steps[0].comfyui?.bindings[0].sourceOutputFormat?.type, "audio_list");
  assert.deepEqual(result.steps[0].comfyui?.bindings[0].selection, { mode: "item", index: 1 });
  assert.deepEqual(result.steps[0].execution, legacy.steps[0].execution);
  assert.equal(result.outputs[0].type, "video_list");
  assert.deepEqual(result.outputs[0].selection, { mode: "all" });
});

test("media migration is idempotent and leaves the original workflow intact", () => {
  const original = structuredClone(legacy);
  const result = normalizeWorkflowMediaTypes(legacy);
  assert.deepEqual(normalizeWorkflowMediaTypes(result), result);
  assert.deepEqual(legacy, original);
});

test("legacy ComfyUI input formats migrate before media type normalization", () => {
  const value = structuredClone(legacy);
  value.inputs[0].type = "text";
  const result = normalizeWorkflowMediaTypes(migrateLegacyComfyInputFormats(value));
  assert.equal(result.inputs[0].type, "image_list");
  assert.equal(result.inputs[0].required, true);
  assert.equal(result.steps[0].comfyui?.bindings[0].sourceInputFormat, undefined);
  assert.equal(result.steps[0].comfyui?.bindings[0].sourceRef, "input.image");
  assert.deepEqual(result.steps[0].comfyui?.bindings[0].selection, { mode: "item", index: 1 });
});
