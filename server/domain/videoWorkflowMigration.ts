import assert from "node:assert/strict";
import type { ComfyUIWorkflowNode, RunWorkflowDefinition } from "./types.js";
import { validateWorkflowShape } from "./workflowValidation.js";

export const DUAL_VIDEO_FILES = { text: "Zane/video_双采.json", json: "Zane/video_双采_json.json" } as const;
type Mode = keyof typeof DUAL_VIDEO_FILES;
type ReferenceSchema = { input?: { required?: Record<string, unknown[]>; optional?: Record<string, unknown[]> } };

/** Configuration-only migration. Execution still uses the existing ComfyUI/H3 adapters. */
export function migrateVideoSampling(
  workflow: RunWorkflowDefinition,
  mode: Mode,
  nodes: ComfyUIWorkflowNode[],
  referenceSchema?: ReferenceSchema,
) {
  assert.ok(mode === "text" || mode === "json", "Unknown video input mode");
  const unique = (type: string) => {
    const matches = nodes.filter(node => node.type === type);
    assert.equal(matches.length, 1, `Expected exactly one ${type} node in the dual-sampling graph`);
    return matches[0]!;
  };
  unique("SelfLiftAvatarH3Sampler");
  unique("H3SigmaRefiner");
  const h3 = unique("MiniMaxH3ReferenceToVideo");
  const save = unique("SaveVideo");
  const resolution = unique("ResolutionSelector");
  const targets: Record<string, { node: ComfyUIWorkflowNode; property: string }> = {
    result: { node: save, property: "video" },
    mp: { node: resolution, property: "megapixels" },
    ratio: { node: resolution, property: "aspect_ratio" },
  };
  const required = mode === "json" ? ["shot_json", "length", "fps", "mp", "ratio", "result"] : ["prompt", "time", "mp", "ratio", "result"];
  if (mode === "json") {
    targets.shot_json = { node: unique("String"), property: "String" };
    targets.length = { node: h3, property: "length" };
    targets.fps = { node: unique("CreateVideo"), property: "fps" };
  } else {
    targets.prompt = { node: h3, property: "prompt" };
    targets.time = { node: unique("PrimitiveFloat"), property: "value" };
  }
  const media = new Set(["references", "character_assets", "scene_assets", "prop_assets", "voice_reference_audio", "reference_images", "reference_audio"]);
  const next = structuredClone(workflow);
  const sourceFile = mode === "json" ? "Zane/video_json.json" : "Zane/video_UI.json";
  const candidates = next.steps.filter(step => step.kind === "comfyui" && [sourceFile, DUAL_VIDEO_FILES[mode]].includes(step.comfyui?.workflowFile ?? ""));
  assert.equal(candidates.length, 1, "Expected exactly one supported video generation step; custom graphs are not overwritten");
  const generate = candidates[0]!;
  if (mode === "json") {
    assert.equal(generate.comfyui?.adapter, "long_text_video", "Preserve the existing native-dialogue adapter");
    assert.equal(generate.execution?.mode, "for_each", "Long text must remain per-shot execution");
  }
  const bindings = generate.comfyui!.bindings ?? [];
  assert.equal(new Set(bindings.map(binding => binding.key)).size, bindings.length, "Duplicate binding keys must be reviewed");
  const mergedMedia = new Set(["reference_images", "reference_audio"]);
  const legacyMedia = ["character_assets", "scene_assets", "prop_assets", "voice_reference_audio"];
  if (mode === "json") {
    const merged = bindings.some(binding => mergedMedia.has(binding.key));
    if (merged) assert.ok(!bindings.some(binding => legacyMedia.includes(binding.key)), "Mixed legacy categories and merged bindings must be reviewed explicitly");
    required.push(...(merged ? [...mergedMedia] : legacyMedia));
  }
  const types: Record<string, string> = { result: "video_list", mp: "number", ratio: "text", prompt: "text", time: "number", shot_json: "text", length: "number", fps: "number", references: "image_list", character_assets: "image_list", scene_assets: "image_list", prop_assets: "image_list", voice_reference_audio: "audio_list", reference_images: "image_list", reference_audio: "audio_list" };
  for (const key of required) assert.equal(bindings.filter(binding => binding.key === key).length, 1, `Missing or duplicate ${key} binding`);
  for (const binding of bindings) {
    assert.equal(binding.type, types[binding.key], `Unexpected ${binding.key} binding type`);
    const isOutput = binding.direction === "output";
    assert.equal(isOutput, binding.key === "result", `Unsupported binding direction for ${binding.key}`);
    let target = targets[binding.key];
    if (media.has(binding.key)) {
      const merged = mergedMedia.has(binding.key);
      const expectedSource = merged ? `iteration.item.references.${binding.key === "reference_audio" ? "audios" : "images"}` : `input.${binding.key}`;
      assert.equal(binding.sourceRef, expectedSource, "Do not overwrite a custom media source");
      const property = ["voice_reference_audio", "reference_audio"].includes(binding.key) ? "ref_audios" : "ref_images";
      const declared = referenceSchema?.input?.optional?.[property] ?? referenceSchema?.input?.required?.[property];
      assert.equal(declared?.[0], "COMFY_AUTOGROW_V3", `H3 must declare real ${property} ports`);
      target = { node: h3, property };
      // Repair only completely unset native asset ports, never a different custom property.
      assert.ok(binding.property === property || (mode === "json" && binding.nodeId === "" && binding.property === ""), `Unexpected ${binding.key} port`);
      if (mode === "json") {
        if (merged) binding.required ??= binding.key === "reference_images";
        else binding.required = false;
      }
    } else {
      assert.ok(target, `Unsupported binding ${binding.key}; review custom configuration explicitly`);
      assert.equal(binding.property, target.property, `Unexpected ${binding.key} property`);
    }
    assert.ok(target);
    const properties = isOutput ? target.node.outputProperties : target.node.inputProperties;
    assert.ok(media.has(binding.key) || properties.includes(target.property), `Missing ${target.node.type}.${target.property}`);
    binding.nodeId = target.node.id;
    binding.property = target.property;
  }
  if (mode === "json") {
    const json = bindings.find(binding => binding.key === "shot_json")!;
    assert.equal(json.sourceRef, "iteration.item", "The String node must receive the whole shot JSON");
    assert.equal(json.type, "text", "Shot JSON must be serialized as text");
    assert.equal(bindings.find(binding => binding.key === "length")?.sourceRef, "iteration.item.frames");
    const fps = bindings.find(binding => binding.key === "fps")!;
    assert.equal(fps.valueSource, "literal");
    assert.equal(fps.literalValue, "24", "Preserve H3 native audio/video timing");
  }
  assert.ok(next.outputs.some(output => output.sourceRef === `step.${generate.id}.outputs.result`), "Final outputs must retain the generated video/clip list");
  generate.comfyui!.workflowFile = DUAL_VIDEO_FILES[mode];
  validateWorkflowShape(next as unknown as Record<string, unknown>);
  return next;
}
