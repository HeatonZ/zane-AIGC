import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { prepareLongTextShot, longTextFrameCount, runLongTextVideoStep, validateLongTextStoryboard } from "./longTextVideo.js";
import type { StepExecutionContext } from "./workflowExecutor.js";
import type { JsonValue } from "../domain/types.js";
import { createRuntimeMediaValue, runtimeMediaItems, runtimeMediaItemValue } from "../runtimeValue.js";
import { parseScenePackage } from "../../src/lib/sceneTransfer.js";
import { validateWorkflowShape } from "../domain/workflowValidation.js";

const assets = { characters: ["char-1.png", "char-2.png"], scenes: ["scene-1.png"], props: ["prop-1.png"], voices: [{ filename: "voice-1.wav", type: "input", subfolder: "voices", url: "/view" }, { filename: "voice-2.wav", type: "input", subfolder: "voices", url: "/view" }] };
const shot = (overrides: Record<string, unknown> = {}): JsonValue => ({ index: 1, seconds: 5, characters: [2], scenes: [1], props: [1], voices: [2], prompt: "subject_definitions:\n<Character 2> 在 <Scene 1> 持有 <Prop 1>，音色为 <Voice 2>。\nsummary:\n收到消息。\nretention_analysis:\n保持服装、房间布局与信封颜色。\ndetailed_description:\n0-5秒，中近景，人物打开信封，正常说话：信到了。\noverall_soundscape:\n<Voice 2> 的音色说：信到了。纸张摩擦声。\nnon_diegetic_music:\nA dramatic orchestral score", ...overrides }) as JsonValue;
function context(rows: JsonValue[] = [shot()]): StepExecutionContext {
  const inputValues = { character_assets: assets.characters, scene_assets: assets.scenes, prop_assets: assets.props, voice_reference_audio: assets.voices, "iteration.item": rows[0] } as Record<string, JsonValue>;
  return { inputValues, runInputValues: inputValues, iterationItems: rows, stepValues: new Map(), types: new Map(), runId: "test", artifacts: { directory: "test", inputs: "", workflow: "", runtime: "", output: "" }, signal: new AbortController().signal, settings: { projectDirectory: "test", comfyuiBaseUrl: "http://comfy", enabledHermesProfiles: ["writer"], workflowTimeoutMinutes: 10 }, inputFields: Object.keys(inputValues).filter((key) => !key.startsWith("iteration")).map((key) => ({ key, type: key === "voice_reference_audio" ? "audio_list" : "image_list", required: true })), step: { id: "generate", kind: "comfyui", name: "生成", inputs: ["character_assets", "scene_assets", "prop_assets", "voice_reference_audio"].map((key) => ({ key, sourceRef: `input.${key}` })).concat([{ key: "shot", sourceRef: "iteration.item" }]), outputs: [{ key: "result", type: "video_list" }, { key: "applied_shot", type: "json" }], comfyui: { workflowFile: "Zane/video_json.json", adapter: "long_text_video", bindings: [] } } };
}

test("compiles per-shot global asset IDs in character-scene-prop and voice order", () => {
  const prepared = prepareLongTextShot(shot(), assets);
  const row = prepared.shot as Record<string, JsonValue>;
  assert.deepEqual(row.reference_map, [{ asset: "<Character 2>", reference: "<Picture 1>" }, { asset: "<Scene 1>", reference: "<Picture 2>" }, { asset: "<Prop 1>", reference: "<Picture 3>" }, { asset: "<Voice 2>", reference: "<Audio 1>" }]);
  assert.deepEqual(prepared.selected.characters, ["char-2.png"]);
  assert.equal((prepared.selected.voices[0] as Record<string, JsonValue>).filename, "voice-2.wav");
  assert.match(String(row.prompt), /<Picture 1> 在 <Picture 2> 持有 <Picture 3>/);
  assert.match(String(row.prompt), /<Audio 1> 的音色说：信到了/);
  assert.doesNotMatch(String(row.prompt), /orchestral|<Voice 2>/);
  assert.match(String(row.prompt), /禁止任何音乐/);
  assert.match(String(row.prompt), /不复制其中的文字/);
  assert.match(String(row.prompt), /non_diegetic_music:\nN\/A$/);
  assert.equal(row.frames, 124);
  assert.equal(row.actual_seconds, 124 / 24);
});

test("aligns duration to H3 native 24fps instead of speeding video to 30fps", () => {
  for (let seconds = 5; seconds <= 15; seconds += 0.1) {
    const frames = longTextFrameCount(seconds);
    assert.equal((frames - 5) % 17, 0);
    assert.ok(frames / 24 >= seconds - 1e-9);
    assert.ok(frames <= 362);
  }
});

test("rejects unsupported lengths, invalid asset IDs, unselected tags and malformed prompt sections", () => {
  assert.throws(() => prepareLongTextShot(shot({ seconds: 16 }), assets), /5到15秒/);
  assert.throws(() => prepareLongTextShot(shot({ characters: [3] }), assets), /不存在/);
  assert.throws(() => prepareLongTextShot(shot({ characters: [1, 1] }), assets), /不能重复/);
  assert.throws(() => prepareLongTextShot(shot({ characters: [] }), assets), /未选中/);
  assert.throws(() => prepareLongTextShot(shot({ prompt: "<Picture 1>" }), assets), /全局资产标记/);
  assert.throws(() => prepareLongTextShot(shot({ prompt: "not an H3 prompt" }), assets), /六个英文段落/);
});

test("enforces each shot's reference capacity without silently dropping assets", () => {
  const many = { ...assets, characters: Array.from({ length: 10 }, (_, i) => `c${i}.png`), voices: Array.from({ length: 4 }, (_, i) => `v${i}.wav`) };
  assert.throws(() => prepareLongTextShot(shot({ characters: [1,2,3,4,5,6,7,8,9] }), many), /最多引用9张/);
  assert.throws(() => prepareLongTextShot(shot({ voices: [1,2,3,4] }), many), /最多引用3个/);
});

test("validates the whole iteration source before starting an expensive first clip", async () => {
  const rows = [shot(), shot({ index: 2, seconds: 22 })];
  let generated = false;
  await assert.rejects(runLongTextVideoStep(context(rows), async () => { generated = true; return {}; }), /5到15秒/);
  assert.equal(generated, false);
  assert.throws(() => validateLongTextStoryboard([shot({ index: 2 })], assets), /连续递增/);
});

test("selects reference subsets without mutating project asset banks and returns applied prompt", async () => {
  const current = context();
  const original = structuredClone(current.inputValues);
  const result = await runLongTextVideoStep(current, async (effective) => {
    assert.deepEqual(runtimeMediaItems(effective.inputValues.character_assets).map(runtimeMediaItemValue), ["char-2.png"]);
    assert.equal((effective.inputValues["iteration.item"] as Record<string, JsonValue>).frames, 124);
    assert.ok(effective.inputFields.every((field) => field.required === false));
    return { result: createRuntimeMediaValue("video", "clip.mp4") as unknown as JsonValue };
  });
  assert.deepEqual(current.inputValues, original);
  assert.ok(result.applied_shot);
  assert.equal(runtimeMediaItems(result.result, "video").length, 1);
});

test("published scene has four asset inputs and only Writer, native generation and real concatenation", async () => {
  const pkg = parseScenePackage(JSON.parse(await readFile(new URL("../../examples/scenes/long-text-to-video.json", import.meta.url), "utf8")));
  validateWorkflowShape(pkg.workflow as unknown as Record<string, unknown>);
  assert.deepEqual(pkg.workflow.steps.map((step) => step.id), ["writer", "generate", "assemble"]);
  for (const key of ["character_assets", "scene_assets", "prop_assets", "voice_reference_audio"]) assert.ok(pkg.workflow.inputs.some((input) => input.key === key));
  const generation = pkg.workflow.steps[1];
  assert.equal(generation.comfyui?.adapter, "long_text_video");
  assert.ok(generation.comfyui?.bindings.some((binding) => binding.property === "ref_audios" && binding.type === "audio_list"));
  assert.equal(generation.comfyui?.bindings.find((binding) => binding.key === "fps")?.literalValue, "24");
  assert.equal(pkg.workflow.steps[2].comfyui?.adapter, "video_concat");
  assert.equal(pkg.workflow.steps[2].kind, "comfyui");
});
