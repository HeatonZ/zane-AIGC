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


test("旧版兼容示例集中在目录末尾，新默认方案不再以媒体选择/排版步骤开头", () => {
  assert.equal(defaultScenes[0].id, "commerce_ai");
  assert.doesNotMatch(defaultScenes[0].title, /旧版兼容/, "AI电商模板已改用 core.code 媒体输出，不再是旧版兼容入口");
  // 旧示例流程保持可执行：media.select_references / media.image_layout 仍注册为 compatibilityOnly。
  assert.ok(defaultWorkflows.basic_image_layout.steps.every((step) => ["media.select_references", "media.image_layout"].includes(step.capabilityId!)));
  for (const id of ["basic_image_layout", "commerce_pack"]) assert.match(defaultScenes.find((scene) => scene.id === id)!.title, /旧版兼容/, id);
  assert.equal(defaultScenes.at(-1)!.id, "commerce_pack");
  const legacyIds = defaultScenes.filter((scene) => /旧版兼容/.test(scene.title)).map((scene) => scene.id);
  assert.deepEqual(legacyIds, defaultScenes.slice(defaultScenes.length - legacyIds.length).map((scene) => scene.id), "旧版兼容示例只在目录末尾");
});
