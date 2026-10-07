import assert from "node:assert/strict";
import test from "node:test";
import { addCategorizedMediaInputs } from "./workflowMediaInputs";
import type { ComfyUIBinding, WorkflowInputField } from "../types";

test("explicit categorized inputs are independent and node mapping remains user-controlled", () => {
  const inputs: WorkflowInputField[] = [{ key: "reference_images", label: "旧参考图", type: "image_list", required: true }];
  const bindings: ComfyUIBinding[] = [{ key: "existing", label: "旧绑定", direction: "input", type: "text", nodeId: "1", property: "prompt", sourceRef: "input.prompt" }];
  const original = structuredClone({ inputs, bindings });
  const added = addCategorizedMediaInputs(inputs, bindings);
  assert.deepEqual(added.inputs.slice(1).map(field => [field.key, field.type, field.mediaRole]), [["character_assets", "image_list", "character"], ["scene_assets", "image_list", "scene"], ["prop_assets", "image_list", "prop"], ["voice_reference_audio", "audio_list", "voice_reference"]]);
  assert.ok(added.bindings.slice(1).every(binding => binding.nodeId === "" && binding.property === "" && binding.sourceRef === "input." + binding.key));
  assert.deepEqual({ inputs, bindings }, original);
  assert.deepEqual(addCategorizedMediaInputs(added.inputs, added.bindings), added);
});

test("adding roles preserves existing custom input and node bindings and refuses collisions atomically", () => {
  const inputs: WorkflowInputField[] = [{ key: "character_assets", label: "定制人物", type: "image_list", required: true, placeholder: "原说明" }];
  const bindings: ComfyUIBinding[] = [{ key: "character_assets", label: "既有绑定", direction: "input", type: "image_list", nodeId: "192", property: "ref_images", sourceRef: "input.character_assets", selection: { mode: "all" } }];
  const added = addCategorizedMediaInputs(inputs, bindings);
  assert.deepEqual(added.inputs[0], { ...inputs[0], mediaRole: "character" });
  assert.deepEqual(added.bindings[0], { ...bindings[0], mediaRole: "character" });
  assert.throws(() => addCategorizedMediaInputs([{ ...inputs[0], type: "audio_list" }], bindings), /不兼容/);
  assert.throws(() => addCategorizedMediaInputs(inputs, [{ ...bindings[0], mediaRole: "prop" }]), /不兼容/);
  assert.equal(inputs[0].mediaRole, undefined); assert.equal(bindings[0].mediaRole, undefined);
});
