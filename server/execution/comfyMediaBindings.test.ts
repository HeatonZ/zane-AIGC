import assert from "node:assert/strict";
import test from "node:test";
import { bindComfyAudioPaths, comfyAutogrowInputNames, groupComfyMediaBindings } from "./comfyMediaBindings.js";
import type { RunComfyBinding } from "../domain/types.js";

function autogrow(type: string, prefix: string, max: number) {
  return ["COMFY_AUTOGROW_V3", { template: { input: { required: { reference: [type, {}] } }, prefix, min: 0, max } }];
}

test("classifies image and reference-audio autogrow ports independently", () => {
  assert.deepEqual(comfyAutogrowInputNames(autogrow("IMAGE", "ref_image_", 3), "image"), ["ref_image_0", "ref_image_1", "ref_image_2"]);
  assert.deepEqual(comfyAutogrowInputNames(autogrow("AUDIO", "ref_audio_", 2), "audio"), ["ref_audio_0", "ref_audio_1"]);
  assert.deepEqual(comfyAutogrowInputNames(autogrow("AUDIO", "ref_audio_", 2), "image"), []);
  assert.deepEqual(comfyAutogrowInputNames(autogrow("IMAGE", "ref_image_", 3), "audio"), []);
  assert.deepEqual(comfyAutogrowInputNames(autogrow("AUDIO", "ref_audio_", 100_000), "audio"), []);
});

test("appends character, scene and prop bindings in deterministic order", () => {
  const binding = (key: string, nodeId = "192", property = "ref_images"): RunComfyBinding => ({ key, direction: "input", nodeId, property, type: "image_list", sourceRef: `input.${key}` });
  const items = [
    { binding: binding("characters"), mediaKind: "image" as const },
    { binding: binding("prompt", "196", "String") },
    { binding: binding("scenes"), mediaKind: "image" as const },
    { binding: binding("props"), mediaKind: "image" as const },
    { binding: binding("voices", "192", "ref_audios"), mediaKind: "audio" as const },
  ];
  const groups = groupComfyMediaBindings(items);
  assert.deepEqual(groups.map((group) => group.map((item) => item.binding.key)), [["characters", "scenes", "props"], ["prompt"], ["voices"]]);
});

test("reference audio is loaded and linked to H3 autogrow slots", () => {
  const inputs: Record<string, unknown> = { "ref_audios.ref_audio_0": ["old", 0], "ref_audios.ref_audio_2": ["old2", 0], prompt: "keep" };
  const graph = { "192": { class_type: "MiniMaxH3ReferenceToVideo", inputs } };
  bindComfyAudioPaths(graph, inputs, "MiniMaxH3ReferenceToVideo", "ref_audios", autogrow("AUDIO", "ref_audio_", 3), ["voice-a.wav", "voice-b.wav"], "视频生成");
  assert.deepEqual(inputs["ref_audios.ref_audio_0"], ["193", 0]);
  assert.deepEqual(inputs["ref_audios.ref_audio_1"], ["194", 0]);
  assert.equal(inputs["ref_audios.ref_audio_2"], undefined);
  assert.deepEqual((graph as Record<string, unknown>)["193"], { class_type: "LoadAudio", inputs: { audio: "voice-a.wav" } });
  assert.equal(inputs.prompt, "keep");
});

test("empty optional audio group clears saved references without creating loaders", () => {
  const inputs = { "ref_audios.ref_audio_0": ["old", 0] };
  const graph = { "192": { class_type: "MiniMaxH3ReferenceToVideo", inputs } };
  bindComfyAudioPaths(graph, inputs, "MiniMaxH3ReferenceToVideo", "ref_audios", autogrow("AUDIO", "ref_audio_", 3), [], "视频生成");
  assert.deepEqual(inputs, {});
  assert.equal(Object.keys(graph).length, 1);
});

test("keeps LoadAudio file-widget compatibility and supports direct AUDIO ports", () => {
  const loaderInputs = { audio: "default.wav" };
  const graph: Record<string, Record<string, unknown>> = { "1": { class_type: "LoadAudio", inputs: loaderInputs } };
  bindComfyAudioPaths(graph, loaderInputs, "LoadAudio", "audio", ["COMBO", {}], ["voice.wav"], "加载音频");
  assert.equal(loaderInputs.audio, "voice.wav");
  assert.throws(() => bindComfyAudioPaths(graph, loaderInputs, "LoadAudio", "audio", ["COMBO", {}], ["a.wav", "b.wav"], "加载音频"), /需要一个音频/);
  const direct: Record<string, unknown> = {};
  bindComfyAudioPaths(graph, direct, "AudioConsumer", "audio", ["AUDIO", {}], ["voice.wav"], "音频条件");
  assert.deepEqual(direct.audio, ["2", 0]);
});

test("rejects excessive voice references and unsupported destination ports", () => {
  const graph: Record<string, Record<string, unknown>> = {};
  assert.throws(() => bindComfyAudioPaths(graph, {}, "H3", "ref_audios", autogrow("AUDIO", "ref_audio_", 1), ["a.wav", "b.wav"], "视频生成"), /最多支持 1 个参考音频/);
  assert.throws(() => bindComfyAudioPaths(graph, {}, "H3", "prompt", ["STRING", {}], ["voice.wav"], "视频生成"), /不支持音频/);
  assert.deepEqual(graph, {});
});
