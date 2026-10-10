import assert from "node:assert/strict";
import test from "node:test";
import { resolveComfyInputBindings } from "./comfyBindings.js";
import { createRuntimeMediaValue } from "../runtimeValue.js";
import type { RunComfyBinding } from "../domain/types.js";
import type { JsonValue } from "../domain/types.js";

const binding = (over: Partial<RunComfyBinding>): RunComfyBinding => ({ key: "b", label: "绑定", direction: "input", nodeId: "1", property: "audio", type: "audio", ...over } as RunComfyBinding);
const images = createRuntimeMediaValue("image", [{ filename: "a.png", type: "input" }, { filename: "b.png", type: "input" }]);
const audios = createRuntimeMediaValue("audio", [{ filename: "v1.wav", type: "input" }]);
const resolve = (bindings: RunComfyBinding[], inputs: Record<string, JsonValue> = {}, required = false) => resolveComfyInputBindings({
  bindings, inputs, stepValues: new Map(), inputFields: [{ key: "voice_reference_audio", type: "audio_list", required }], variableTypes: new Map([["input.voice_reference_audio", "audio_list"]]), stepName: "生成",
});

test("绑定解析：普通引用、字面值与有效序号选择照常解析", () => {
  const resolved = resolve([
    binding({ key: "text", type: "text", sourceRef: "input.content", valueSource: "reference" }),
    binding({ key: "literal", type: "number", valueSource: "literal", literalValue: "24" }),
    binding({ key: "slot1", type: "audio", sourceRef: "input.voice_reference_audio", selection: { mode: "item", index: 0 } }),
  ], { content: "剧情", voice_reference_audio: audios });
  assert.deepEqual(resolved.map(item => [item.binding.key, item.value]), [["text", "剧情"], ["literal", 24], ["slot1", audios]]);
  assert.equal(resolved[0]!.mediaKind, undefined);
  assert.equal(resolved[2]!.mediaKind, "audio");
});

test("绑定解析：可选编号槽位越界时保留节点默认输入，不失败也不注入空值", () => {
  // Numbered bridge slots (audio1..audio10) stay absent so the node pads them itself.
  const resolved = resolve([
    binding({ key: "voice1", type: "audio", sourceRef: "input.voice_reference_audio", selection: { mode: "item", index: 0 }, required: false }),
    binding({ key: "voice2", type: "audio", sourceRef: "input.voice_reference_audio", selection: { mode: "item", index: 1 }, required: false }),
    binding({ key: "voice3", type: "audio", sourceRef: "input.voice_reference_audio", selection: { mode: "item", index: 2 }, required: false }),
  ], { voice_reference_audio: audios });
  assert.deepEqual(resolved.map(item => item.binding.key), ["voice1"], "只有存在的媒体序号进入绑定；越界槽位被跳过");
  assert.deepEqual(resolved[0]!.value, audios);
});

test("绑定解析：必需槽位越界仍然明确失败，不静默丢弃媒体", () => {
  assert.throws(() => resolve([binding({ key: "voice2", type: "audio", sourceRef: "input.voice_reference_audio", selection: { mode: "item", index: 1 }, required: true })], { voice_reference_audio: audios }), /引用的媒体不存在/);
  // A required scene input also makes the slot required.
  assert.throws(() => resolve([binding({ key: "voice2", type: "audio", sourceRef: "input.voice_reference_audio", selection: { mode: "item", index: 1 } })], { voice_reference_audio: audios }, true), /引用的媒体不存在/);
});

test("绑定解析：空媒体列表与图片序号语义一致，输出端绑定被忽略", () => {
  assert.deepEqual(resolve([binding({ key: "images", type: "image_list", sourceRef: "input.character_assets", required: true })], { character_assets: images }).map(item => item.binding.key), ["images"]);
  assert.deepEqual(resolve([binding({ key: "result", direction: "output", type: "video_list", nodeId: "63", property: "video" })]), []);
  const empty = resolve([binding({ key: "voice1", type: "audio", sourceRef: "input.voice_reference_audio", selection: { mode: "item", index: 0 } })], { voice_reference_audio: createRuntimeMediaValue("audio", []) });
  assert.deepEqual(empty.map(item => item.binding.key), []);
});
