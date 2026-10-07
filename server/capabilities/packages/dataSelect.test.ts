import assert from "node:assert/strict";
import test from "node:test";
import factory from "./dataSelect.js";
import type { CapabilityPackage, CapabilityRuntime } from "../package.js";
import type { StepExecutionContext } from "../../execution/workflowExecutor.js";
import type { JsonValue, RunStep } from "../../domain/types.js";
import { createRuntimeMediaValue, isRuntimeMediaValue } from "../../runtimeValue.js";
import { harness, id } from "../../testing/testSupport.js";

const runtime: CapabilityRuntime = {
  async hermes() { throw new Error("不应调用 Hermes"); },
  async comfyui() { throw new Error("不应调用 ComfyUI"); },
  async condition() { throw new Error("不应调用条件适配器"); },
};
const pkg = await factory(runtime) as CapabilityPackage;
const step: RunStep = {
  id: "merge", name: "选择结果", kind: "capability", capabilityId: "data.select",
  inputs: [
    { key: "condition", sourceRef: "input.condition" },
    { key: "when_true", sourceRef: "input.yes" },
    // An invalid path in an unselected branch must not be evaluated.
    { key: "when_false", sourceRef: "step.skipped.outputs.result::missing.field" },
  ],
  outputs: [{ key: "value", type: "json" }],
};
function context(values: Record<string, JsonValue>, currentStep = step): StepExecutionContext {
  return { step: currentStep, inputValues: values, stepValues: new Map() } as StepExecutionContext;
}

test("条件选择只读取选中分支，保留 JSON、false、0、空字符串和 null", async () => {
  for (const value of [{ nested: [1, false, "a"] }, false, 0, "", null]) {
    assert.deepEqual(await pkg.execute(context({ condition: true, yes: value })), { value });
  }
  const other = structuredClone(step);
  other.inputs![2].sourceRef = "input.no";
  assert.deepEqual(await pkg.execute(context({ condition: false, no: 0 }, other)), { value: 0 });
});

test("条件选择原样保留媒体类型、顺序和元数据", async () => {
  const images = createRuntimeMediaValue("image", [{ filename: "first.png", type: "input" }, { filename: "second.png", type: "input" }]);
  const result = await pkg.execute(context({ condition: true, yes: images }));
  assert.equal(result.value, images);
  assert.ok(isRuntimeMediaValue(result.value));
});

test("条件选择拒绝非布尔条件和缺失的已选结果", async () => {
  for (const condition of ["false", "true", 1, 0, null]) {
    await assert.rejects(pkg.execute(context({ condition, yes: "ok" })), /必须是布尔/);
  }
  await assert.rejects(pkg.execute(context({ condition: true })), /已选分支没有结果/);
  assert.throws(() => pkg.validate!({ ...step, outputs: [] }), /value/);
});

test("条件分支通过后台执行、跳过另一个生成器，并归档统一图片输出", async (t) => {
  const calls: string[] = [];
  const { executors, service, settings } = await harness(t);
  executors.registerCapability(pkg);
  executors.register({ kind: "control", async execute(ctx) { return { result: ctx.inputValues.has_image }; } });
  executors.register({ kind: "comfyui", async execute(ctx) {
    calls.push(ctx.step.id);
    return { images: createRuntimeMediaValue("image", [{ filename: ctx.step.id + ".png", type: "output" }]) };
  } });
  await service.start();
  for (const has_image of [true, false]) {
    calls.length = 0;
    const run = await service.submit({ runId: id("data-select-" + has_image), inputValues: { has_image }, workflow: {
      sceneId: "test", name: "可配置图片条件流程", inputs: [{ key: "has_image", type: "boolean" }],
      steps: [
        { id: "condition", name: "判断", kind: "control", outputs: [{ key: "result", type: "boolean" }] },
        ...[true, false].map((expectedResult) => ({ id: expectedResult ? "i2i" : "t2i", name: "生图", kind: "comfyui", runCondition: { conditionStepId: "condition", expectedResult }, outputs: [{ key: "images", type: "image_list" }] })),
        { ...step, outputs: [{ key: "value", type: "image_list" }], inputs: [
          { key: "condition", sourceRef: "step.condition.outputs.result" },
          { key: "when_true", sourceRef: "step.i2i.outputs.images" },
          { key: "when_false", sourceRef: "step.t2i.outputs.images" },
        ] },
      ],
      outputs: [{ key: "images", type: "image_list", sourceRef: "step.merge.outputs.value" }],
    } });
    const result = await service.wait(settings.projectDirectory, run.runId);
    assert.equal(result.status, "completed", result.error);
    assert.deepEqual(calls, [has_image ? "i2i" : "t2i"]);
    assert.equal(result.steps.find((item) => item.stepId === (has_image ? "t2i" : "i2i"))?.status, "skipped");
    const output = result.outputs[0].value as Array<Record<string, JsonValue>>;
    assert.equal(output.length, 1);
    assert.equal(output[0].filename, (has_image ? "i2i" : "t2i") + ".png");
    assert.equal(output[0].type, "output");
    assert.equal(result.steps.at(-1)?.capabilityId, "data.select");
  }
});
