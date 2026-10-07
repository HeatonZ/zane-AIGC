import assert from "node:assert/strict";
import test from "node:test";
import type { ComfyUIBinding, ComfyUINodeInfo, ComfyUIWorkflowNode } from "../types";
import { clearConfirmedStaleComfyBindings } from "./comfyBindingValidation";

const h3Bindings: ComfyUIBinding[] = [
  { key: "reference_images", label: "参考图片", direction: "input", nodeId: "192", property: "ref_images", type: "image_list", sourceRef: "iteration.item.references.images" },
  { key: "reference_audio", label: "参考音频", direction: "input", nodeId: "192", property: "ref_audios", type: "audio_list", sourceRef: "iteration.item.references.audios" },
];
const h3Node: ComfyUIWorkflowNode = {
  id: "192",
  type: "MiniMaxH3ReferenceToVideo",
  // Autogrow ports are absent from the graph until configured.
  inputProperties: ["clip", "prompt", "width", "height", "length"],
  outputProperties: ["positive", "LATENT"],
};
const h3NodeInfo: ComfyUINodeInfo = {
  type: h3Node.type,
  inputs: [
    { name: "ref_images", type: "image_list", required: false },
    { name: "ref_audios", type: "audio_list", required: false },
  ],
  outputs: [],
};

test("keeps H3 autogrow media bindings declared by object_info but absent from the graph summary", () => {
  const result = clearConfirmedStaleComfyBindings(h3Bindings, [h3Node], { [h3Node.type]: h3NodeInfo }, "api");
  assert.equal(result, h3Bindings);
  assert.deepEqual(result.map(({ nodeId, property }) => [nodeId, property]), [["192", "ref_images"], ["192", "ref_audios"]]);
});

test("clears a binding only when the authoritative node schema confirms the property is absent", () => {
  const bindings: ComfyUIBinding[] = [
    h3Bindings[0]!,
    { ...h3Bindings[1]!, property: "removed_audio_port" },
  ];
  const result = clearConfirmedStaleComfyBindings(bindings, [h3Node], { [h3Node.type]: h3NodeInfo }, "api");
  assert.notEqual(result, bindings);
  assert.equal(result[0]!.property, "ref_images");
  assert.equal(result[1]!.nodeId, "");
  assert.equal(result[1]!.property, "");
});

test("preserves bindings when a schema read fails or the workflow format is unknown", () => {
  assert.equal(clearConfirmedStaleComfyBindings(h3Bindings, [h3Node], {}, "api"), h3Bindings);
  assert.equal(clearConfirmedStaleComfyBindings(h3Bindings, [], {}, "unknown"), h3Bindings);
});

test("preserves incomplete edits and API output bindings when the summary cannot enumerate runtime fields", () => {
  const incomplete: ComfyUIBinding = { ...h3Bindings[0]!, nodeId: "192", property: "" };
  const output: ComfyUIBinding = { key: "result", label: "结果", direction: "output", nodeId: "192", property: "Filenames", type: "video_list" };
  const outputInfo: ComfyUINodeInfo = { type: h3Node.type, inputs: [], outputs: [{ name: "VIDEO", type: "video_list" }] };
  const bindings = [incomplete, output];
  const apiNode = { ...h3Node, outputProperties: [] };
  assert.equal(clearConfirmedStaleComfyBindings(bindings, [apiNode], { [h3Node.type]: outputInfo }, "api"), bindings);
});

test("clears a fully configured binding when its node no longer exists in a recognized workflow", () => {
  const result = clearConfirmedStaleComfyBindings(h3Bindings, [], {}, "api");
  assert.ok(result.every((binding) => binding.nodeId === "" && binding.property === ""));
});
