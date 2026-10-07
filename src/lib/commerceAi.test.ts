import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { defaultScenes } from "../data/scenes";
import { defaultWorkflows } from "../data/workflows";
import { parseScenePackage, createScenePackage } from "./sceneTransfer";
import { loadCapabilityPackages } from "../../server/capabilities/loadPackages";
import { validateWorkflowShape } from "../../server/domain/workflowValidation";

test("AI电商模板仅组合基础步骤，旧发布包不修改且导入导出不丢审核/媒体/对齐契约", async () => {
  const pkg = parseScenePackage(JSON.parse(await readFile("examples/scenes/commerce-ai.json", "utf8")));
  const registry = await loadCapabilityPackages({ async hermes() { throw new Error("禁止调用模型"); }, async comfyui() { throw new Error("禁止调用模型"); }, async condition() { return { result: true }; } });
  validateWorkflowShape(pkg.workflow as unknown as Record<string, unknown>);
  for (const step of pkg.workflow.steps) { registry.prepareStep(step); assert.equal(registry.definitions().find(item => item.id === step.capabilityId)?.usage?.tier, "basic"); assert.equal(step.comfyui?.adapter, undefined); }
  const roundtrip = parseScenePackage(createScenePackage(pkg.scene, pkg.workflow, pkg.optionPresets)); assert.deepEqual(roundtrip.workflow, pkg.workflow);
  assert.equal(defaultScenes.filter(scene => scene.id === "commerce_ai").length, 1); assert.ok(defaultWorkflows.commerce_ai);
  assert.match(defaultScenes.find(scene => scene.id === "commerce_pack")!.title, /旧版兼容/); assert.equal(defaultWorkflows.commerce_pack.steps.at(-1)!.comfyui!.adapter, "commerce_pack");
  assert.ok(pkg.workflow.inputs.find(field => field.key === "product_images")!.required); assert.ok(!pkg.workflow.inputs.find(field => field.key === "style_images")!.required);
  assert.ok(!pkg.workflow.inputs.some(field => field.key === "add_text")); assert.ok(!pkg.workflow.inputs.some(field => ["shot_types", "generation_mode", "platform_profiles"].includes(field.key)));
  assert.deepEqual(pkg.workflow.steps.filter(step => step.review?.enabled).map(step => step.id), ["prompt_jobs", "sample", "final"]);
  assert.equal(pkg.workflow.steps.find(step => step.id === "remaining")!.execution!.sourceRef, "step.render_jobs.outputs.rest");
  const generators = pkg.workflow.steps.filter(step => step.kind === "comfyui"); assert.equal(generators.length, 2); assert.ok(generators.every(step => (step.capabilityConfig?.outputMediaCounts as Record<string, unknown>)?.images === 1));
  assert.ok(generators.every(step => step.comfyui!.bindings!.filter(binding => binding.key === "reference_images").every(binding => binding.sourceRef!.endsWith("references.images"))));
  assert.ok(pkg.workflow.steps.find(step => step.id === "prompts")!.inputs.find(input => input.key === "reference_images")!.referenceType === "image_list");
  assert.equal(pkg.workflow.steps.length, 10);
  assert.ok(!pkg.workflow.steps.some(step => ["media.image_layout", "data.select", "core.condition"].includes(step.capabilityId ?? "")));
  assert.ok(!pkg.workflow.steps.some(step => ["layout", "need_text", "image_jobs", "collect"].includes(step.id)));
  assert.equal(pkg.workflow.outputs.find(output => output.key === "images")!.sourceRef, "step.final.outputs.images");
  assert.equal(pkg.workflow.steps.at(-1)!.capabilityId, "media.select_references", "only collect original AI images at delivery");
  for (const step of pkg.workflow.steps.filter(step => step.capabilityId === "data.zip")) {
    const schema = step.capabilityConfig!.itemSchema as { required: string[]; properties: Record<string, unknown> };
    assert.ok(!schema.required.includes("layout")); assert.ok(!("layout" in schema.properties));
  }
  const plan = pkg.workflow.steps.find(step => step.id === "plan")!;
  assert.match(plan.promptTemplate!, /AI直接生成的完整电商设计稿/);
  assert.match(plan.promptTemplate!, /不要求Writer选择或编号素材/);
  assert.doesNotMatch(plan.promptTemplate!, /每项只含[^\n]*selection/);
  for (const id of ["plan_contract", "prompt_jobs", "render_jobs"]) {
    const schema = pkg.workflow.steps.find(step => step.id === id)!.capabilityConfig!.itemSchema as { required: string[]; properties: Record<string, unknown> };
    assert.ok(!schema.required.includes("selection"), `${id} accepts a model plan without selection`);
    assert.ok(!("selection" in schema.properties));
  }
  const selection = pkg.workflow.steps.find(step => step.id === "references")!.inputs.find(input => input.key === "selection")!;
  assert.equal(selection.valueSource, "literal");
  assert.equal(selection.literalValue, '{"product_images":"all","style_images":"all"}');
  assert.match(pkg.workflow.steps.find(step => step.id === "prompts")!.promptTemplate!, /同一次AI生图中完成/);
  const source = await readFile("src/components/RunMediaDownloadButton.tsx", "utf8"); assert.doesNotMatch(source, /commerce_pack|commerce_ai/);
});
