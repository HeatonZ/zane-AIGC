import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import type { ComfyUIWorkflowNode, RunWorkflowDefinition } from "./types.js";
import { DUAL_VIDEO_FILES, migrateVideoSampling } from "./videoWorkflowMigration.js";
import { updateSceneDraft } from "../ai/sceneSchemas.js";

const schema = { input: { optional: { ref_images: ["COMFY_AUTOGROW_V3", {}], ref_audios: ["COMFY_AUTOGROW_V3", {}] } } };
const node = (id: string, type: string, inputs: string[] = [], outputs: string[] = []): ComfyUIWorkflowNode => ({ id, type, inputProperties: inputs, outputProperties: outputs });
const nodes = [node("92", "SaveVideo", [], ["video"]), node("115", "ResolutionSelector", ["aspect_ratio", "megapixels"]), node("155", "PrimitiveFloat", ["value"]), node("192", "MiniMaxH3ReferenceToVideo", ["prompt", "length"]), node("152", "CreateVideo", ["fps"]), node("196", "SelfLiftAvatarH3Sampler"), node("197", "H3SigmaRefiner"), node("201", "String", ["String"])];
function fixture(name: string) {
  const pkg = JSON.parse(readFileSync(new URL(`../../examples/scenes/${name}.json`, import.meta.url), "utf8"));
  const workflow = pkg.workflow as RunWorkflowDefinition;
  const generate = workflow.steps.find(step => step.kind === "comfyui" && step.comfyui?.workflowFile.startsWith("Zane/video"))!;
  generate.comfyui!.workflowFile = name === "long-text-to-video" ? "Zane/video_json.json" : "Zane/video_UI.json";
  if (name === "long-text-to-video") generate.comfyui!.bindings!.find(binding => binding.key === "shot_json")!.nodeId = "196";
  return workflow;
}

test("dual sampling migrates both text scenes and preserves all prompt/reference metadata", () => {
  for (const name of ["text-to-video-repaired", "reference-to-video-repaired"]) {
    const original = fixture(name); const before = structuredClone(original);
    const migrated = migrateVideoSampling(original, "text", nodes, schema);
    assert.deepEqual(original, before);
    const expected = structuredClone(original); expected.steps.find(step => step.kind === "comfyui")!.comfyui!.workflowFile = DUAL_VIDEO_FILES.text;
    assert.deepEqual(migrated, expected);
    assert.deepEqual(migrateVideoSampling(migrated, "text", nodes, schema), migrated);
    assert.ok(updateSceneDraft.safeParse({ revision: "a".repeat(64), workflow: migrated }).success);
  }
});

test("no-design remains one prompt agent followed by ComfyUI; no writer/review stages added", () => {
  const original = fixture("text-to-video-repaired"); original.steps.shift();
  original.steps[0]!.promptTemplate = "直接按{{input.thought}}编写提示词";
  const migrated = migrateVideoSampling(original, "text", nodes, schema);
  assert.equal(migrated.steps.length, 2);
  assert.deepEqual(migrated.steps[0], original.steps[0]);
  assert.equal(migrated.steps[1]!.comfyui!.workflowFile, DUAL_VIDEO_FILES.text);
});

test("long text rebinds complete shot JSON from old String 196 to String 201, never the sampler", () => {
  const original = fixture("long-text-to-video"); const migrated = migrateVideoSampling(original, "json", nodes, schema);
  const generate = migrated.steps.find(step => step.id === "generate")!;
  assert.equal(generate.comfyui!.workflowFile, DUAL_VIDEO_FILES.json);
  assert.equal(generate.comfyui!.bindings!.find(binding => binding.key === "shot_json")!.nodeId, "201");
  assert.ok(generate.comfyui!.bindings!.every(binding => binding.nodeId !== "196"));
  assert.deepEqual(generate.execution, original.steps.find(step => step.id === "generate")!.execution);
  assert.deepEqual(migrated.inputs, original.inputs); assert.deepEqual(migrated.outputs, original.outputs);
  assert.deepEqual(migrated.steps.filter(step => step.id !== "generate"), original.steps.filter(step => step.id !== "generate"));
  assert.deepEqual(migrateVideoSampling(migrated, "json", nodes, schema), migrated);
  assert.ok(updateSceneDraft.safeParse({ revision: "a".repeat(64), workflow: migrated }).success);
});

test("unfinished long-text asset ports are repaired without replacing user draft labels or inputs", () => {
  const original = fixture("long-text-to-video"); const generate = original.steps.find(step => step.id === "generate")!;
  generate.outputs![0]!.label = "用户保留的片段名称";
  for (const binding of generate.comfyui!.bindings!.filter(binding => binding.type === "image_list" || binding.type === "audio_list")) { binding.nodeId = ""; binding.property = ""; delete binding.required; }
  const next = migrateVideoSampling(original, "json", nodes, schema).steps.find(step => step.id === "generate")!;
  assert.equal(next.outputs![0]!.label, "用户保留的片段名称"); assert.deepEqual(next.inputs, generate.inputs);
  for (const binding of next.comfyui!.bindings!.filter(binding => binding.type === "image_list" || binding.type === "audio_list")) { assert.equal(binding.nodeId, "192"); assert.equal(binding.required, binding.key === "reference_images"); assert.equal(binding.property, binding.type === "audio_list" ? "ref_audios" : "ref_images"); }
});

test("unknown/ambiguous graphs, missing real reference ports and custom bindings fail closed", () => {
  const text = fixture("text-to-video-repaired");
  assert.throws(() => migrateVideoSampling(text, "text", nodes.filter(node => node.type !== "SelfLiftAvatarH3Sampler"), schema), /SelfLiftAvatar/);
  assert.throws(() => migrateVideoSampling(text, "text", [...nodes, node("99", "SaveVideo", [], ["video"])], schema), /SaveVideo/);
  assert.throws(() => migrateVideoSampling(fixture("reference-to-video-repaired"), "text", nodes), /real ref_images/);
  const custom = structuredClone(text); custom.steps.find(step => step.kind === "comfyui")!.comfyui!.workflowFile = "user-custom.json";
  assert.throws(() => migrateVideoSampling(custom, "text", nodes, schema), /custom graphs/);
  const wrong = fixture("long-text-to-video"); wrong.steps.find(step => step.id === "generate")!.comfyui!.bindings!.find(binding => binding.key === "shot_json")!.sourceRef = "iteration.item.prompt";
  assert.throws(() => migrateVideoSampling(wrong, "json", nodes, schema), /whole shot JSON/);
  const fps = fixture("long-text-to-video"); fps.steps.find(step => step.id === "generate")!.comfyui!.bindings!.find(binding => binding.key === "fps")!.literalValue = "30";
  assert.throws(() => migrateVideoSampling(fps, "json", nodes, schema), /native audio/);
});


test("旧四分类绑定与新合并列表分别兼容，不借采样迁移自动改变分类合并策略",()=>{
 const modern=fixture("long-text-to-video");const legacy=structuredClone(modern),generate=legacy.steps.find(step=>step.id==="generate")!;
 generate.comfyui!.bindings=generate.comfyui!.bindings!.filter(binding=>!["reference_images","reference_audio"].includes(binding.key));
 for(const key of ["character_assets","scene_assets","prop_assets","voice_reference_audio"])generate.comfyui!.bindings.push({key,direction:"input",nodeId:"192",property:key==="voice_reference_audio"?"ref_audios":"ref_images",type:key==="voice_reference_audio"?"audio_list":"image_list",sourceRef:"input."+key,required:false});
 const migrated=migrateVideoSampling(legacy,"json",nodes,schema);assert.deepEqual(migrated.steps.find(step=>step.id==="generate")!.comfyui!.bindings!.filter(binding=>binding.type==="image_list"||binding.type==="audio_list"),generate.comfyui!.bindings.filter(binding=>binding.type==="image_list"||binding.type==="audio_list"));
 const mixed=structuredClone(modern);mixed.steps.find(step=>step.id==="generate")!.comfyui!.bindings!.push(generate.comfyui!.bindings.find(binding=>binding.key==="character_assets")!);
 assert.throws(()=>migrateVideoSampling(mixed,"json",nodes,schema),/Mixed legacy/);
});
