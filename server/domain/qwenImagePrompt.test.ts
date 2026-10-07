import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { defaultWorkflows } from "../../src/data/workflows.js";
import { addQwenImage21PromptStep, QWEN_IMAGE_21_PROMPT_REF, QWEN_IMAGE_21_PROMPT_STEP_ID, qwenImage21PromptStep, qwenImage21WriterStep, qwenImage21WriterPromptStep, QWEN_IMAGE_21_WRITER_STEP_ID, QWEN_IMAGE_21_WRITER_REF } from "./qwenImagePrompt.js";
import { updateSceneDraft } from "../ai/sceneSchemas.js";
import { normalizeMediaList, resolveStepInputs, resolveWorkflowValue } from "./workflowValues.js";
import { harness, id } from "../testing/testSupport.js";
import type { JsonValue, RunWorkflowDefinition } from "./types.js";

function beforeConversion(): RunWorkflowDefinition {
  const workflow = structuredClone(defaultWorkflows.image_to_image) as RunWorkflowDefinition;
  workflow.steps = workflow.steps.filter(step => ![QWEN_IMAGE_21_PROMPT_STEP_ID, QWEN_IMAGE_21_WRITER_STEP_ID].includes(step.id));
  workflow.inputs.push({ key: "negative_prompt", type: "textarea", required: false });
  const generate = workflow.steps[0]!;
  generate.inputs!.find(input => input.key === "prompt")!.sourceRef = "input.prompt";
  generate.inputs!.push({ key: "negative_prompt", sourceRef: "input.negative_prompt" });
  generate.comfyui!.bindings!.push({ key: "negative_prompt", direction: "input", nodeId: "471", property: "negative_prompt", type: "text", sourceRef: "input.negative_prompt", required: false });
  generate.comfyui!.bindings!.find(binding => binding.key === "prompt")!.sourceRef = "input.prompt";
  return workflow;
}

test("Qwen Image 2.1方言是基础AIXG步骤，图片顺序与全部原参数保留", () => {
  const workflow = beforeConversion();
  const snapshot = structuredClone(workflow);
  const converted = addQwenImage21PromptStep(workflow);
  assert.deepEqual(workflow, snapshot);
  assert.deepEqual(converted.inputs, workflow.inputs);
  assert.deepEqual(converted.outputs, workflow.outputs);
  assert.equal(converted.steps.length, 2);
  assert.deepEqual(converted.steps[0], qwenImage21PromptStep());
  assert.equal(converted.steps[0].hermesProfile, "aixg");
  assert.equal(converted.steps[0].kind, "hermes");
  assert.ok(converted.steps[0].promptTemplate!.includes("<image1>"));
  const expectedGenerator = structuredClone(workflow.steps[0]);
  expectedGenerator.inputs!.find(input => input.key === "prompt")!.sourceRef = QWEN_IMAGE_21_PROMPT_REF;
  expectedGenerator.comfyui!.bindings!.find(binding => binding.key === "prompt")!.sourceRef = QWEN_IMAGE_21_PROMPT_REF;
  assert.deepEqual(converted.steps[1], expectedGenerator);
  assert.deepEqual(addQwenImage21PromptStep(converted), converted);
  assert.ok(updateSceneDraft.safeParse({ revision: "a".repeat(64), workflow: converted }).success);
  const defaultGenerator = defaultWorkflows.image_to_image.steps[2];
  assert.equal(defaultGenerator.execution?.mode, undefined, "有序多图共同作为一次生成的条件，不逐图丢失编号");
  assert.equal(defaultGenerator.comfyui?.bindings.find(binding => binding.key === "prompt")?.sourceRef, QWEN_IMAGE_21_PROMPT_REF);
});

test("Qwen方言草稿编辑拒绝自定义提示词、错误绑定、同名步骤和未核对逐图执行", () => {
  const edits: Array<(workflow: RunWorkflowDefinition) => void> = [
    workflow => { workflow.steps[0]!.inputs!.find(input => input.key === "prompt")!.sourceRef = "step.custom.outputs.prompt"; },
    workflow => { workflow.steps[0]!.comfyui!.bindings!.find(binding => binding.key === "prompt")!.valueSource = "literal"; },
    workflow => { workflow.steps[0]!.comfyui!.bindings!.find(binding => binding.key === "reference_images")!.selection = { mode: "item", index: 1 }; },
    workflow => { workflow.steps[0]!.comfyui!.bindings!.find(binding => binding.key === "reference_images")!.sourceRef = "step.custom.outputs.images"; },
    workflow => { workflow.steps[0]!.comfyui!.workflowFile = "custom.json"; },
    workflow => { workflow.steps[0]!.execution = { mode: "for_each", sourceRef: "input.reference_images" }; },
    workflow => { workflow.steps.unshift({ ...qwenImage21PromptStep(), promptTemplate: "用户已有提示词" }); },
    workflow => { workflow.steps[0]!.comfyui!.bindings = []; },
    workflow => { workflow.inputs = workflow.inputs.filter(input => input.key !== "prompt"); },
  ];
  for (const edit of edits) {
    const workflow = beforeConversion(); edit(workflow); const snapshot = structuredClone(workflow);
    assert.throws(() => addQwenImage21PromptStep(workflow), { code: "QWEN_IMAGE_PROMPT_CONFIGURATION_CONFLICT" });
    assert.deepEqual(workflow, snapshot);
  }
  const customized = addQwenImage21PromptStep(beforeConversion()); customized.steps[0]!.promptTemplate += "用户新要求";
  assert.throws(() => addQwenImage21PromptStep(customized), { code: "QWEN_IMAGE_PROMPT_CONFIGURATION_CONFLICT" });
});

test("没有负向输入的流程不增设业务输入、悬空引用或不可对账步骤", () => {
  const workflow = beforeConversion();
  workflow.inputs = workflow.inputs.filter(input => input.key !== "negative_prompt");
  workflow.steps[0]!.inputs = workflow.steps[0]!.inputs!.filter(input => input.key !== "negative_prompt");
  workflow.steps[0]!.comfyui!.bindings = workflow.steps[0]!.comfyui!.bindings!.filter(binding => binding.key !== "negative_prompt");
  const converted = addQwenImage21PromptStep(workflow);
  assert.deepEqual(converted.inputs, workflow.inputs);
  assert.ok(converted.steps[0]!.inputs!.every(input => input.key !== "negative_prompt"));
  assert.ok(!converted.steps[0]!.promptTemplate!.includes("{{input.negative_prompt}}"));
  assert.deepEqual(addQwenImage21PromptStep(converted), converted);
});

test("Writer → AIXG → 图生图只开放五项输入，画幅/像素使用目标画布", async () => {
  const workflow = defaultWorkflows.image_to_image;
  const { workflow: example } = JSON.parse(await readFile(new URL("../../examples/scenes/image-to-image-qwen21.json", import.meta.url), "utf8"));
  assert.deepEqual(workflow, example);
  assert.deepEqual(workflow.inputs.map(field => [field.key, field.label]), [["reference_images", "图片"], ["prompt", "想法"], ["seed", "随机种子"], ["ratio", "画幅"], ["mp", "像素"]]);
  assert.deepEqual(workflow.steps[0], qwenImage21WriterStep());
  assert.deepEqual(workflow.steps[1], qwenImage21WriterPromptStep());
  assert.equal(workflow.steps[0].hermesProfile, "writer");
  assert.equal(workflow.steps[1].hermesProfile, "aixg");
  assert.equal(workflow.steps[1].inputs.find(input => input.key === "prompt")?.sourceRef, QWEN_IMAGE_21_WRITER_REF);
  assert.ok(workflow.steps[1].promptTemplate.includes("{{" + QWEN_IMAGE_21_WRITER_REF + "}}"));
  assert.ok(!workflow.steps[1].promptTemplate.includes("{{input.prompt}}"));
  assert.ok(!JSON.stringify(workflow).match(/input\.(negative_prompt|steps|cfg|resolution|empty)\b/));
  const bindings = workflow.steps[2].comfyui!.bindings;
  assert.equal(bindings.find(binding => binding.key === "prompt")?.sourceRef, QWEN_IMAGE_21_PROMPT_REF);
  assert.deepEqual(bindings.filter(binding => ["seed", "ratio", "mp"].includes(binding.key)).map(binding => [binding.nodeId, binding.property, binding.sourceRef]), [["476", "seed", "input.seed"], ["481", "aspect_ratio", "input.ratio"], ["481", "megapixels", "input.mp"]]);
  const canvas = bindings.find(binding => binding.key === "configured_canvas")!;
  assert.equal(canvas.nodeId, "479"); assert.equal(canvas.property, "switch");
  assert.equal(canvas.valueSource, "literal"); assert.equal(canvas.literalValue, "true");
  assert.equal(bindings.find(binding => binding.key === "reference_images")?.sourceRef, "input.reference_images", "目标画布不移除图像编辑条件");
  assert.ok(workflow.steps.every(step => !step.execution?.mode && !step.runCondition));
  assert.ok(updateSceneDraft.safeParse({ revision: "a".repeat(64), workflow }).success);
});

test("隔离运行：Writer先整理单图/多图想法，AIXG只收整理结果，生成消费最终提示词", async t => {
  const h = await harness(t);
  const calls: string[] = [];
  const idea = "只改背景";
  const brief = "只将第一张图的背景改为浅蓝色，保留杯子数量、形状与构图。";
  const nativePrompt = "把 <image1> 中杯子的背景改为浅蓝色，保留杯子形状、数量与构图。";
  h.executors.register({ kind: "hermes", async execute(context): Promise<Record<string, JsonValue>> {
    calls.push(context.step.id);
    const values = resolveStepInputs(context.step, context.inputValues, context.stepValues);
    assert.deepEqual(normalizeMediaList(values.reference_images), normalizeMediaList(context.inputValues.reference_images));
    assert.equal(values.seed, undefined); assert.equal(values.ratio, undefined); assert.equal(values.mp, undefined);
    if (context.step.id === QWEN_IMAGE_21_WRITER_STEP_ID) {
      assert.equal(context.step.hermesProfile, "writer"); assert.equal(values.idea, idea);
      return { edit_brief: brief };
    }
    assert.equal(context.step.hermesProfile, "aixg"); assert.equal(values.prompt, brief);
    assert.notEqual(values.prompt, idea); assert.equal(values.negative_prompt, undefined);
    return { prompt: nativePrompt };
  } });
  h.executors.register({ kind: "comfyui", async execute(context) {
    calls.push(context.step.id);
    const values = resolveStepInputs(context.step, context.inputValues, context.stepValues);
    assert.equal(values.prompt, nativePrompt);
    for (const key of ["seed", "ratio", "mp"]) assert.equal(values[key], context.inputValues[key]);
    for (const key of ["prompt", "reference_images", "seed", "ratio", "mp", "configured_canvas"]) {
      const binding = context.step.comfyui!.bindings!.find(binding => binding.key === key)!;
      const value = resolveWorkflowValue({ ...binding, literalType: binding.type }, context.inputValues, context.stepValues);
      if (key === "reference_images") assert.deepEqual(normalizeMediaList(value), normalizeMediaList(context.inputValues.reference_images));
      else assert.equal(value, key === "prompt" ? nativePrompt : key === "configured_canvas" ? true : context.inputValues[key]);
    }
    return { images: [] }; // Protocol fixture only; never invoke a real model or generate media.
  } });
  await h.service.start();
  const image = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==";
  for (const count of [1, 2]) {
    const run = await h.service.submit({ runId: id("qwen-writer-" + count), workflow: defaultWorkflows.image_to_image, inputValues: { reference_images: Array(count).fill(image), prompt: idea, seed: 20261005, ratio: "9:16 (Portrait Widescreen)", mp: 1 } });
    const result = await h.service.wait(h.settings.projectDirectory, run.runId);
    assert.equal(result.status, "completed", result.error);
    assert.deepEqual(calls.splice(0), [QWEN_IMAGE_21_WRITER_STEP_ID, QWEN_IMAGE_21_PROMPT_STEP_ID, "image_to_image"]);
    assert.equal(result.steps[0].outputs?.edit_brief, brief); assert.equal(result.steps[1].outputs?.prompt, nativePrompt);
  }
});

test("Writer或AIXG失败都停止，不回退到用户原始想法偷偷生成", async t => {
  for (const failedStep of [QWEN_IMAGE_21_WRITER_STEP_ID, QWEN_IMAGE_21_PROMPT_STEP_ID]) {
    const h = await harness(t); const called: string[] = []; let generated = false;
    h.executors.register({ kind: "hermes", async execute(context) {
      called.push(context.step.id);
      if (context.step.id === failedStep) throw new Error("隔离整理/转换失败");
      return { edit_brief: "只改背景" };
    } });
    h.executors.register({ kind: "comfyui", async execute() { generated = true; return { images: [] }; } });
    await h.service.start();
    const run = await h.service.submit({ runId: id("qwen-writer-failure-" + failedStep), workflow: defaultWorkflows.image_to_image, inputValues: { reference_images: ["data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg=="], prompt: "只改背景", ratio: "1:1 (Square)", mp: 1 } });
    assert.equal((await h.service.wait(h.settings.projectDirectory, run.runId)).status, "failed"); assert.equal(generated, false);
    assert.deepEqual(called, failedStep === QWEN_IMAGE_21_WRITER_STEP_ID ? [failedStep] : [QWEN_IMAGE_21_WRITER_STEP_ID, failedStep]);
  }
});
