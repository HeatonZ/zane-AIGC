import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { defaultWorkflows } from "../data/workflows.js";
import { harness, id } from "../../server/testing/testSupport.js";
import { normalizeMediaList, resolveStepInputs } from "../../server/domain/workflowValues.js";
import { createRuntimeMediaValue } from "../../server/runtimeValue.js";

const definition = defaultWorkflows.text_to_image;
test("默认文生图用条件步骤反推图片，随后只走同一个纯文生图步骤", () => {
  assert.equal(definition.inputs.find(f => f.key === "prompt")?.required, false);
  assert.equal(definition.inputs.find(f => f.key === "reference_images")?.type, "image_list");
  assert.equal(definition.inputs.find(f => f.key === "denoise"), undefined);
  assert.equal(definition.steps[0].control?.rules[0].leftRef, "input.reference_images");
  const reverse = definition.steps.find(s => s.id === "reverse_prompt")!;
  assert.equal(reverse.hermesProfile, "aixg");
  assert.deepEqual(reverse.runCondition, { conditionStepId: definition.steps[0].id, expectedResult: true });
  assert.equal(reverse.inputs[0].sourceRef, "input.reference_images");
  const prepare = definition.steps.find(s => s.id === "prompt_prepare")!;
  assert.ok(prepare.inputs.every(i => i.sourceRef !== "input.reference_images"));
  assert.ok(prepare.promptTemplate.includes("独立的纯文生图"));
  const generators = definition.steps.filter(s => s.kind === "comfyui");
  assert.equal(generators.length, 1);
  assert.equal(generators[0].id, "text_to_image");
  assert.equal(generators[0].runCondition, undefined);
  assert.equal(generators[0].inputs.find(i => i.key === "prompt")?.sourceRef, "step.prompt_prepare.outputs.prompt");
  assert.ok(generators[0].inputs.every(i => i.sourceRef !== "input.reference_images"));
  assert.ok(!definition.steps.some(s => s.id === "reference_reconstruction" || s.capabilityId === "data.select"));
  assert.equal(definition.outputs[0].sourceRef, "step.text_to_image.outputs.image");
});

test("可导入场景同样只把反推文本送入 T2I，不绑定原图、latent 或重绘强度", async () => {
  const { workflow } = JSON.parse(await readFile(new URL("../../examples/scenes/text-to-image-reference.json", import.meta.url), "utf8"));
  const generators = workflow.steps.filter((s: any) => s.kind === "comfyui");
  assert.equal(generators.length, 1);
  const generator = generators[0];
  assert.equal(generator.comfyui.workflowFile, "Zane/t2i_UI.json");
  assert.equal(generator.runCondition, undefined);
  assert.ok(!workflow.inputs.some((f: any) => f.key === "denoise"));
  assert.ok(generator.inputs.every((i: any) => i.sourceRef !== "input.reference_images"));
  const bindings = generator.comfyui.bindings.filter((b: any) => b.direction === "input");
  assert.ok(bindings.every((b: any) => !["image", "image_list"].includes(b.type)));
  assert.ok(bindings.every((b: any) => b.sourceRef !== "input.reference_images"));
  const prompt = bindings.find((b: any) => b.property === "prompt");
  assert.equal(prompt.sourceRef, "step.step_mukrnpps_3.outputs.output_1");
  const prepare = workflow.steps.find((s: any) => s.id === "step_mukrnpps_3");
  assert.ok(prepare.inputs.every((i: any) => i.sourceRef !== "input.reference_images"));
  assert.equal(prepare.inputs.find((i: any) => i.key === "reverse_prompt").sourceRef, "step.step_aixg_reverse_prompt.outputs.output_1");
  assert.equal(workflow.outputs.find((o: any) => o.key === "result").sourceRef, "step." + generator.id + ".outputs.output_1");
});

test("空描述单图、多图、附加要求、空列表及未传图片都通过文本链路生成", async (t) => {
  const calls: string[] = [];
  const { executors, service, settings } = await harness(t);
  const reversedText = "写实咖啡店展示柜，中层从左到右是一块巧克力蛋糕和四只透明盖餐碗，下层左侧橙子篮、右侧三明治，底层饮料瓶。";
  executors.register({ kind: "control", async execute(ctx) { return { result: normalizeMediaList(ctx.inputValues.reference_images).length > 0 }; } });
  executors.register({ kind: "hermes", async execute(ctx) {
    calls.push(ctx.step.id);
    const inputs = resolveStepInputs(ctx.step, ctx.inputValues, ctx.stepValues);
    if (ctx.step.id === "reverse_prompt") {
      assert.ok(normalizeMediaList(inputs.reference_images).length > 0);
      return { prompt: reversedText };
    }
    assert.equal(inputs.reference_images, undefined, "整理步骤不应继续携带原图");
    const hasImages = normalizeMediaList(ctx.inputValues.reference_images).length > 0;
    assert.equal(inputs.reverse_prompt, hasImages ? reversedText : null);
    return { prompt: hasImages ? reversedText + (inputs.prompt || "") : String(inputs.prompt) };
  } });
  executors.register({ kind: "comfyui", async execute(ctx) {
    calls.push(ctx.step.id);
    assert.equal(ctx.step.id, "text_to_image");
    const inputs = resolveStepInputs(ctx.step, ctx.inputValues, ctx.stepValues);
    assert.equal(inputs.reference_images, undefined, "生成步骤不应获得原图绑定");
    const hasImages = normalizeMediaList(ctx.inputValues.reference_images).length > 0;
    assert.equal(inputs.prompt, hasImages ? reversedText + (ctx.inputValues.prompt || "") : ctx.inputValues.prompt);
    const bindings = ctx.step.comfyui?.bindings;
    assert.ok(bindings);
    assert.ok(bindings.every(b => b.direction !== "input" || !["image", "image_list"].includes(b.type ?? "")));
    return { image: createRuntimeMediaValue("image", [{ filename: "regenerated.png", type: "output" }]) };
  } });
  await service.start();
  const configured = structuredClone(definition);
  // The default model remains an editor placeholder; bindings are model-specific configuration.
  const generator = configured.steps.find(s => s.id === "text_to_image")!;
  generator.comfyui!.workflowFile = "test-t2i.json";
  generator.comfyui!.bindings = [{ key: "prompt", label: "正向提示词", direction: "input", nodeId: "1", property: "text", type: "text", sourceRef: "step.prompt_prepare.outputs.prompt", required: true }];
  const cases = [
    { name: "single-image-empty-description", prompt: "", reference_images: [{ filename: "one.png", type: "input" }] },
    { name: "multiple-images-empty-description", prompt: "", reference_images: [{ filename: "one.png", type: "input" }, { filename: "two.png", type: "input" }] },
    { name: "image-with-instructions", prompt: "暖色灯光", reference_images: [{ filename: "one.png", type: "input" }] },
    { name: "empty-image-list", prompt: "咖啡店甜点柜", reference_images: [] },
    { name: "omitted-image-list", prompt: "咖啡店甜点柜" },
  ];
  for (const input of cases) {
    calls.length = 0;
    const { name, ...values } = input;
    const hasImages = Boolean(values.reference_images?.length);
    const run = await service.submit({ runId: id("prompt-regeneration-" + name), workflow: configured, inputValues: { ...values, width: 1024, height: 1024 } });
    const result = await service.wait(settings.projectDirectory, run.runId);
    assert.equal(result.status, "completed", name + ": " + result.error);
    assert.deepEqual(calls, hasImages ? ["reverse_prompt", "prompt_prepare", "text_to_image"] : ["prompt_prepare", "text_to_image"]);
    assert.equal(result.steps.find(s => s.stepId === "reverse_prompt")?.status, hasImages ? "completed" : "skipped");
    assert.equal(result.steps.find(s => s.stepId === "text_to_image")?.status, "completed");
    assert.equal(result.outputs[0].type, "image_list");
    assert.equal((result.outputs[0].value as any[])[0].filename, "regenerated.png");
  }
});
