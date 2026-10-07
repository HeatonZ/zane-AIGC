import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { validWorkflowMediaRole } from "./workflowMediaRoles.js";
import { validateWorkflowShape } from "./workflowValidation.js";
import { sceneInputContract } from "./inputContract.js";
import { createScene } from "../ai/sceneSchemas.js";
import { parseScenePackage, serializeScenePackage } from "../../src/lib/sceneTransfer.js";
import type { RunWorkflowDefinition } from "./types.js";

test("semantic roles constrain physical media types without changing old inputs", () => {
  for (const type of ["image", "image_list"]) for (const role of ["reference", "character", "scene", "prop"]) assert.equal(validWorkflowMediaRole(role, type), true);
  for (const type of ["audio", "audio_list"]) assert.equal(validWorkflowMediaRole("voice_reference", type), true);
  assert.equal(validWorkflowMediaRole("reference", "video_list"), true);
  assert.equal(validWorkflowMediaRole(undefined, "text"), true);
  for (const [role,type] of [["voice_reference","image_list"],["character","audio_list"],["scene","video_list"],["reference","text"],["invalid","image_list"]]) assert.equal(validWorkflowMediaRole(role,type), false);
  assert.equal(validWorkflowMediaRole("character", "image_list", "output"), false);
});

test("roles survive package import/export and published input contracts, with shared shape/schema rejection", async () => {
  const pkg = parseScenePackage(JSON.parse(await readFile(new URL("../../examples/scenes/long-text-to-video.json", import.meta.url), "utf8")));
  const roundTrip = parseScenePackage(JSON.parse(serializeScenePackage(pkg.scene, pkg.workflow, pkg.optionPresets)));
  assert.deepEqual(roundTrip.workflow, pkg.workflow);
  const contract = sceneInputContract(pkg.workflow as unknown as RunWorkflowDefinition);
  assert.equal((contract.inputSchema.properties as Record<string,Record<string,unknown>>).voice_reference_audio["x-media-role"], "voice_reference");
  assert.equal(contract.inputRequirements.find(field => field.key === "character_assets")?.mediaRole, "character");
  assert.equal(createScene.safeParse({ scene: pkg.scene, workflow: pkg.workflow }).success, true);
  for (const mutate of [
    (workflow: any) => { workflow.inputs[1].mediaRole = "voice_reference"; },
    (workflow: any) => { workflow.steps[2].comfyui.bindings.find((binding: any) => binding.key === "reference_images").mediaRole = "voice_reference"; },
    (workflow: any) => { workflow.steps[2].comfyui.bindings.find((binding: any) => binding.direction === "output").mediaRole = "reference"; },
  ]) {
    const workflow = structuredClone(pkg.workflow); mutate(workflow);
    assert.equal(createScene.safeParse({ scene: pkg.scene, workflow }).success, false);
    assert.throws(() => validateWorkflowShape(workflow as unknown as Record<string,unknown>), /素材用途/);
    assert.throws(() => parseScenePackage({ ...pkg, workflow }), /素材用途/);
  }
});
