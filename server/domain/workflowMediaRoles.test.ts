import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { validWorkflowMediaRole } from "./workflowMediaRoles.js";
import { validateWorkflowShape } from "./workflowValidation.js";
import { sceneInputContract } from "./inputContract.js";
import { createScene } from "../ai/sceneSchemas.js";
import { parseScenePackage, serializeScenePackage } from "../../src/lib/sceneTransfer.js";
import type { RunWorkflowDefinition } from "./types.js";

test("legacy semantic roles stay valid for released snapshots without changing physical media types", () => {
  for (const type of ["image", "image_list"]) for (const role of ["reference", "character", "scene", "prop"]) assert.equal(validWorkflowMediaRole(role, type), true);
  for (const type of ["audio", "audio_list"]) assert.equal(validWorkflowMediaRole("voice_reference", type), true);
  assert.equal(validWorkflowMediaRole("reference", "video_list"), true);
  assert.equal(validWorkflowMediaRole(undefined, "text"), true);
  for (const [role,type] of [["voice_reference","image_list"],["character","audio_list"],["scene","video_list"],["reference","text"],["invalid","image_list"]]) assert.equal(validWorkflowMediaRole(role,type), false);
  assert.equal(validWorkflowMediaRole("character", "image_list", "output"), false);
  assert.equal(validWorkflowMediaRole(undefined, "image_list"), true);
});

test("shipped scene packages declare media type only, and legacy role snapshots still import and publish", async () => {
  const pkg = parseScenePackage(JSON.parse(await readFile(new URL("../../examples/scenes/long-text-to-video.json", import.meta.url), "utf8")));
  assert.deepEqual(pkg.workflow.inputs.filter(field => field.mediaRole), []);
  assert.deepEqual(pkg.workflow.steps.flatMap(step => step.comfyui?.bindings ?? []).filter(binding => binding.mediaRole), []);
  assert.deepEqual(pkg.workflow.inputs.map(field => [field.key, field.type]), [["content", "textarea"], ["character_assets", "image_list"], ["scene_assets", "image_list"], ["prop_assets", "image_list"], ["voice_reference_audio", "audio_list"], ["asset_notes", "textarea"], ["production_notes", "textarea"], ["target_seconds", "number"], ["ratio", "select"], ["mp", "number"]]);
  const roundTrip = parseScenePackage(JSON.parse(serializeScenePackage(pkg.scene, pkg.workflow, pkg.optionPresets)));
  assert.deepEqual(roundTrip.workflow, pkg.workflow);
  assert.equal(createScene.safeParse({ scene: pkg.scene, workflow: pkg.workflow }).success, true);
  const contract = sceneInputContract(pkg.workflow as unknown as RunWorkflowDefinition);
  assert.equal((contract.inputSchema.properties as Record<string,Record<string,unknown>>).character_assets["x-media-role"], undefined);
  assert.equal(contract.inputRequirements.some(field => field.mediaRole), false);

  // Released snapshots keep the legacy marker: it still imports, validates and reports unchanged.
  const legacy = structuredClone(pkg.workflow);
  legacy.inputs[1] = { ...legacy.inputs[1], mediaRole: "character" };
  const legacyPackage = parseScenePackage({ ...pkg, workflow: legacy });
  assert.equal(legacyPackage.workflow.inputs[1].mediaRole, "character");
  assert.equal(createScene.safeParse({ scene: pkg.scene, workflow: legacy }).success, true);
  const legacyContract = sceneInputContract(legacy as unknown as RunWorkflowDefinition);
  assert.equal((legacyContract.inputSchema.properties as Record<string,Record<string,unknown>>).character_assets["x-media-role"], "character");
  assert.equal(legacyContract.inputRequirements.find(field => field.key === "character_assets")?.mediaRole, "character");
});

test("shared shape/schema rejection still guards incompatible legacy roles", async () => {
  const pkg = parseScenePackage(JSON.parse(await readFile(new URL("../../examples/scenes/long-text-to-video.json", import.meta.url), "utf8")));
  const imageListBinding = pkg.workflow.steps.flatMap(step => step.comfyui?.bindings ?? []).find(binding => binding.direction === "input" && binding.type === "image_list");
  assert.ok(imageListBinding, "long-text package must bind an input image list");
  const outputBinding = pkg.workflow.steps.flatMap(step => step.comfyui?.bindings ?? []).find(binding => binding.direction === "output");
  assert.ok(outputBinding, "long-text package must declare an output binding");
  for (const mutate of [
    (workflow: any) => { workflow.inputs[1].mediaRole = "voice_reference"; },
    (workflow: any) => { workflow.steps.flatMap((step: any) => step.comfyui?.bindings ?? []).find((binding: any) => binding.key === imageListBinding.key).mediaRole = "voice_reference"; },
    (workflow: any) => { workflow.steps.flatMap((step: any) => step.comfyui?.bindings ?? []).find((binding: any) => binding.key === outputBinding.key).mediaRole = "reference"; },
  ]) {
    const workflow = structuredClone(pkg.workflow); mutate(workflow);
    assert.equal(createScene.safeParse({ scene: pkg.scene, workflow }).success, false);
    assert.throws(() => validateWorkflowShape(workflow as unknown as Record<string,unknown>), /素材用途/);
    assert.throws(() => parseScenePackage({ ...pkg, workflow }), /素材用途/);
  }
});
