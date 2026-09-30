import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { parseScenePackage, createScenePackage, prepareImportedScene } from "./sceneTransfer";
import { defaultScenes } from "../data/scenes";
import { defaultWorkflows } from "../data/workflows";

test("独立电商场景包导入/导出保留适配器；商品展示不被覆盖", async () => {
  const raw = JSON.parse(await readFile(new URL("../../examples/scenes/commerce-pack.json", import.meta.url), "utf8"));
  const pkg = parseScenePackage(raw);
  assert.equal(pkg.workflow.steps.at(-1)!.comfyui!.adapter, "commerce_pack");
  const imported = prepareImportedScene(pkg, []);
  assert.notEqual(imported.scene.id, "commerce"); assert.equal(imported.workflow.sceneId, imported.scene.id);
  const roundtrip = parseScenePackage(createScenePackage(imported.scene, imported.workflow, []));
  assert.equal(roundtrip.workflow.steps.at(-1)!.comfyui!.adapter, "commerce_pack");
  assert.deepEqual(roundtrip.workflow.inputs.find((input) => input.key === "shot_types")!.defaultValue, '["hero","selling_point","detail","lifestyle","specs","package"]');
  assert.equal(defaultScenes.find((scene) => scene.id === "commerce")!.title, "商品展示");
  assert.equal(defaultWorkflows.commerce.steps.at(-1)!.id, "product_video");
  assert.equal(defaultScenes.filter((scene) => scene.id === "commerce_pack").length, 1);
});
