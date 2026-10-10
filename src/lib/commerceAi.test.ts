import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { defaultScenes } from "../data/scenes";
import { defaultWorkflows } from "../data/workflows";
import { parseScenePackage, createScenePackage } from "./sceneTransfer";
import { loadCapabilityPackages } from "../../server/capabilities/loadPackages";
import { validateWorkflowShape } from "../../server/domain/workflowValidation";
const retired = ["media.select_references", "media.image_layout", "text.template", "core.manual", "core.condition", "data.select", "data.zip", "comfyui.commerce_pack", "comfyui.h3_long_video", "comfyui.long_text_video"];

test("AI电商模板只用 Hermes/ComfyUI/core.code，旧发布包不修改且导入导出不丢审核/媒体/对齐契约", async () => {
  const pkg = parseScenePackage(JSON.parse(await readFile("examples/scenes/commerce-ai.json", "utf8")));
  const registry = await loadCapabilityPackages({ async hermes() { throw new Error("禁止调用模型"); }, async comfyui() { throw new Error("禁止调用模型"); }, async condition() { return { result: true }; } });
  validateWorkflowShape(pkg.workflow as unknown as Record<string, unknown>);
  for (const step of pkg.workflow.steps) {
    registry.prepareStep(step);
    const usage = registry.definitions().find(item => item.id === step.capabilityId)?.usage;
    assert.equal(usage?.compatibilityOnly, undefined, step.id + " 不得使用已退役执行方式");
    assert.equal(step.comfyui?.adapter, undefined, step.id + " 不得使用场景专用适配器");
    assert.ok(!retired.includes(step.capabilityId ?? ""), step.id + " 使用了已退役能力：" + step.capabilityId);
  }
  const roundtrip = parseScenePackage(createScenePackage(pkg.scene, pkg.workflow, pkg.optionPresets)); assert.deepEqual(roundtrip.workflow, pkg.workflow);
  assert.equal(defaultScenes.filter(scene => scene.id === "commerce_ai").length, 1); assert.ok(defaultWorkflows.commerce_ai);
  assert.match(defaultScenes.find(scene => scene.id === "commerce_pack")!.title, /旧版兼容/); assert.equal(defaultWorkflows.commerce_pack.steps.at(-1)!.comfyui!.adapter, "commerce_pack");
  assert.ok(pkg.workflow.inputs.find(field => field.key === "product_images")!.required); assert.ok(!pkg.workflow.inputs.find(field => field.key === "style_images")!.required);
  assert.ok(!pkg.workflow.inputs.some(field => field.key === "add_text")); assert.ok(!pkg.workflow.inputs.some(field => ["shot_types", "generation_mode", "platform_profiles"].includes(field.key)));
  assert.deepEqual(pkg.workflow.steps.filter(step => step.review?.enabled).map(step => step.id), ["prompt_jobs", "sample", "final"]);
  assert.equal(pkg.workflow.steps.find(step => step.id === "remaining")!.execution!.sourceRef, "step.render_jobs.outputs.rest");
  const generators = pkg.workflow.steps.filter(step => step.kind === "comfyui"); assert.equal(generators.length, 2); assert.ok(generators.every(step => (step.capabilityConfig?.outputMediaCounts as Record<string, unknown>)?.images === 1));
  // 计划校验、素材编号、列表对齐与交付排序都由自定义代码完成，替代已退役的 data.zip / 媒体选择步骤。
  assert.deepEqual(pkg.workflow.steps.filter(step => step.capabilityId === "core.code").map(step => step.id), ["plan_contract", "references", "prompt_jobs", "render_jobs", "final"]);
  assert.equal(pkg.workflow.steps.length, 10);
  assert.ok(!pkg.workflow.steps.some(step => ["layout", "need_text", "image_jobs", "collect"].includes(step.id)));
  assert.equal(pkg.workflow.outputs.find(output => output.key === "images")!.sourceRef, "step.final.outputs.images");
  // 参考图集合对所有设计相同：自定义代码合并成一组有序附件，直接绑定到 AIXG 与两次生成。
  assert.ok(generators.every(step => step.comfyui!.bindings!.filter(binding => binding.key === "reference_images").every(binding => binding.sourceRef === "step.references.outputs.images")));
  for (const id of ["prompts", "sample", "remaining"]) {
    const reference = pkg.workflow.steps.find(step => step.id === id)!.inputs.find(input => input.key === "reference_images")!;
    assert.equal(reference.sourceRef, "step.references.outputs.images", id);
    assert.equal(reference.referenceType, "image_list", id);
  }
  const plan = pkg.workflow.steps.find(step => step.id === "plan")!;
  assert.match(plan.promptTemplate!, /AI直接生成的完整电商设计稿/);
  assert.match(plan.promptTemplate!, /不要求Writer选择或编号素材/);
  assert.doesNotMatch(plan.promptTemplate!, /每项只含[^\n]*selection/);
  const code = (id: string) => String(pkg.workflow.steps.find(step => step.id === id)!.capabilityConfig?.code);
  const contract = pkg.workflow.steps.find(step => step.id === "plan_contract")!;
  assert.deepEqual(contract.inputs.map(input => [input.key, input.sourceRef]), [["cards", "step.plan.outputs.cards"], ["image_count", "input.image_count"]]);
  assert.deepEqual(contract.outputs.map(output => [output.key, output.type]), [["rows", "json"], ["first", "json"], ["rest", "json"]]);
  assert.match(code("plan_contract"), /cards\.length !== expected/, "数量不符必须在生成前失败");
  assert.match(code("plan_contract"), /id 重复/, "重复标识必须在生成前失败");
  assert.match(code("plan_contract"), /roles\.includes/, "role 枚举必须校验");
  assert.match(code("plan_contract"), /brief 必须是非空字符串/, "brief 结构必须校验");
  const promptJobs = pkg.workflow.steps.find(step => step.id === "prompt_jobs")!;
  assert.deepEqual(promptJobs.inputs.map(input => [input.key, input.sourceRef]), [["rows", "step.plan_contract.outputs.rows"], ["reference_map", "step.references.outputs.reference_map"]]);
  assert.match(code("prompt_jobs"), /reference_map: map/, "每张提示任务都带上素材局部编号");
  assert.equal(pkg.workflow.steps.find(step => step.id === "prompts")!.inputs.find(input => input.key === "reference_map")!.sourceRef, "iteration.item.reference_map");
  const renderJobs = pkg.workflow.steps.find(step => step.id === "render_jobs")!;
  assert.deepEqual(renderJobs.inputs.map(input => [input.key, input.sourceRef]), [["cards", "step.plan.outputs.cards"], ["prompts", "step.prompts.outputs.prompt"]]);
  assert.match(code("render_jobs"), /提示词数量与方案数量不一致/, "提示词与方案必须等长对齐");
  const references = pkg.workflow.steps.find(step => step.id === "references")!;
  assert.deepEqual(references.inputs.map(input => [input.key, input.sourceRef]), [["product_images", "input.product_images"], ["style_images", "input.style_images"]]);
  assert.deepEqual(references.outputs.map(output => [output.key, output.type]), [["images", "image_list"], ["reference_map", "json"], ["count", "number"]]);
  assert.match(code("references"), /<Picture /, "reference_map maps real group tags to attachment numbering");
  const delivery = pkg.workflow.steps.at(-1)!;
  assert.equal(delivery.id, "final");
  assert.deepEqual(delivery.inputs.map(input => [input.key, input.sourceRef]), [["sample_images", "step.sample.outputs.images"], ["remaining_images", "step.remaining.outputs.images"]]);
  assert.deepEqual(delivery.outputs.map(output => [output.key, output.type]), [["images", "image_list"]]);
  assert.match(code("final"), /sample_images[\s\S]*remaining_images/, "delivery only orders the original AI images already produced in this run");
  assert.match(pkg.workflow.steps.find(step => step.id === "prompts")!.promptTemplate!, /同一次AI生图中完成/);
  const source = await readFile("src/components/RunMediaDownloadButton.tsx", "utf8"); assert.doesNotMatch(source, /commerce_pack|commerce_ai/);
});
