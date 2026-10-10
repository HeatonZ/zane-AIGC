import assert from "node:assert/strict";
import test from "node:test";
import { loadCapabilityPackages } from "../capabilities/loadPackages.js";
import { harness, id } from "../testing/testSupport.js";
import type { CapabilityRuntime } from "../capabilities/package.js";
import { createRuntimeMediaValue } from "../runtimeValue.js";

let hermesCalls = 0;
let thirdPartyCalls = 0;
const runtime: CapabilityRuntime = {
  async hermes() { hermesCalls += 1; return { result: "清新自然的日系生活风格" }; },
  async comfyui() { throw new Error("生图步骤不应在本验证中执行"); },
  async condition() { throw new Error("旧条件步骤不应在本验证中执行"); },
  // 第三方接口用可控替身计数：开始条件不满足时不得发出任何请求，也不产生第三方费用。
  async thirdPartyRequest() { thirdPartyCalls += 1; return { response: { ok: true }, status: 200 }; },
};
const registry = await loadCapabilityPackages(runtime);
const reference = [createRuntimeMediaValue("image", [{ filename: "reference.png", type: "input" }])];
const fallback = "整体风格活泼、时尚、高级、简洁，采用撞色设计，具有强视觉冲击力";
const gateRule = { id: "r1", leftRef: "input.reference", operator: "is_not_empty", valueSource: "literal", rightValue: "", rightRef: "" };
const styleWorkflow = (startCondition: unknown) => ({
  sceneId: "test", name: "开始条件验证", inputs: [{ key: "reference", type: "image_list" }, { key: "flag", type: "boolean" }],
  steps: [
    { id: "analyzer", name: "推理风格", kind: "hermes", hermesProfile: "writer", promptTemplate: "分析风格", inputs: [{ key: "images", sourceRef: "input.reference" }], outputs: [{ key: "result", type: "text" }], ...(startCondition ? { startCondition } : {}) },
    { id: "style", name: "风格结果", kind: "capability", capabilityId: "core.code", capabilityVersion: "1", capabilityConfig: { code: "return { value: inputs.analyzed ?? inputs.fallback };", timeoutMs: 5000 }, inputs: [{ key: "analyzed", sourceRef: "step.analyzer.outputs.result" }, { key: "fallback", valueSource: "literal", literalType: "text", literalValue: fallback }], outputs: [{ key: "value", type: "text" }] },
  ],
  outputs: [{ key: "style", type: "text", sourceRef: "step.style.outputs.value" }],
});

test("开始条件：满足时执行，不满足时整步跳过且输出按 null 参与下游", async (t) => {
  const { service, settings } = await harness(t, { executors: registry });
  await service.start();
  hermesCalls = 0;
  const runA = await service.submit({ runId: id("start-condition-run"), inputValues: { reference, flag: true }, workflow: styleWorkflow({ match: "all", rules: [gateRule] }) });
  const resultA = await service.wait(settings.projectDirectory, runA.runId);
  assert.equal(resultA.status, "completed", resultA.error);
  assert.equal(hermesCalls, 1);
  assert.equal(resultA.outputs[0]?.value, "清新自然的日系生活风格");
  assert.deepEqual(resultA.steps.map((step) => step.status), ["completed", "completed"]);

  hermesCalls = 0;
  const runB = await service.submit({ runId: id("start-condition-skip"), inputValues: { reference: [], flag: false }, workflow: styleWorkflow({ match: "all", rules: [gateRule] }) });
  const resultB = await service.wait(settings.projectDirectory, runB.runId);
  assert.equal(resultB.status, "completed", resultB.error);
  assert.equal(hermesCalls, 0, "开始条件不满足时不得调用模型");
  assert.equal(resultB.outputs[0]?.value, fallback);
  assert.equal(resultB.steps[0].status, "skipped");
  assert.equal(resultB.steps[0].message, "开始条件未满足");
  assert.deepEqual(resultB.steps[0].outputs, { result: null });
  assert.equal(resultB.steps[1].status, "completed");
  assert.equal(resultB.steps[0].outputs?.result, null);
});

test("开始条件：任意步骤通用，布尔/文本/媒体规则都可在步骤上声明", async (t) => {
  const { service, settings } = await harness(t, { executors: registry });
  await service.start();
  const booleanGate = { match: "all", rules: [{ id: "r1", leftRef: "input.flag", operator: "equals", valueSource: "literal", rightValue: "true", rightRef: "" }] };
  const falseGate = { match: "any", rules: [{ id: "r2", leftRef: "input.flag", operator: "equals", valueSource: "literal", rightValue: "false", rightRef: "" }] };
  const template = (id: string, condition: unknown) => ({ id, name: id + "步骤", kind: "capability", capabilityId: "text.template", capabilityVersion: "1", capabilityConfig: { template: id }, inputs: [], outputs: [{ key: "text", type: "text" }], ...(condition ? { startCondition: condition } : {}) });
  const run = await service.submit({ runId: id("start-condition-any-step"), inputValues: { reference: [], flag: true }, workflow: {
    sceneId: "test", name: "任意步骤开始条件", inputs: [{ key: "reference", type: "image_list" }, { key: "flag", type: "boolean" }],
    steps: [template("first", booleanGate), template("second", falseGate), template("third", { match: "all", rules: [{ id: "r3", leftRef: "input.reference", operator: "is_not_empty", valueSource: "literal", rightValue: "", rightRef: "" }] })],
    outputs: [{ key: "text", type: "text", sourceRef: "step.second.outputs.text" }],
  } });
  const result = await service.wait(settings.projectDirectory, run.runId);
  assert.equal(result.status, "completed", result.error);
  assert.deepEqual(result.steps.map((step) => step.status), ["completed", "skipped", "skipped"]);
  assert.deepEqual(result.outputs[0]?.value, null);
});

test("开始条件：引用后续步骤、未知引用、空规则和无效匹配方式在提交前拒绝", async (t) => {
  const { service } = await harness(t, { executors: registry });
  await service.start();
  for (const [startCondition, code] of [
    [{ match: "all", rules: [{ id: "r", leftRef: "step.style.outputs.value", operator: "is_not_empty", valueSource: "literal", rightValue: "", rightRef: "" }] }, "INVALID_WORKFLOW_REFERENCE"],
    [{ match: "all", rules: [{ id: "r", leftRef: "bad-ref", operator: "is_not_empty", valueSource: "literal", rightValue: "", rightRef: "" }] }, "INVALID_WORKFLOW"],
    [{ match: "all", rules: [] }, "INVALID_WORKFLOW"],
    [{ match: "sometimes", rules: [{ id: "r", leftRef: "input.flag", operator: "is_not_empty", valueSource: "literal", rightValue: "", rightRef: "" }] }, "INVALID_WORKFLOW"],
  ] as Array<[unknown, string]>) {
    const flow = styleWorkflow(startCondition);
    (flow.steps[0] as { startCondition?: unknown }).startCondition = startCondition;
    await assert.rejects(() => service.submit({ runId: id("start-condition-invalid-" + Math.random().toString(36).slice(2)), inputValues: { reference: [], flag: false }, workflow: flow }), { code }, JSON.stringify(startCondition));
  }
});
const thirdPartyConfig = { url: "https://api.example.net/v1/images/edits", method: "POST", bodyFormat: "json", bodyTemplate: { model: "{{model}}", prompt: "{{prompt}}", n: 1 }, timeoutSeconds: 10 };

test("开始条件：第三方接口步骤遵循通用开始条件，规则不满足时不发出请求", async (t) => {
  const { service, settings } = await harness(t, { executors: registry });
  await service.start();
  const imagesGate = { match: "all", rules: [{ id: "r1", leftRef: "input.images", operator: "is_not_empty", valueSource: "literal", rightValue: "", rightRef: "" }] };
  const flow = (startCondition: unknown) => ({
    sceneId: "test", name: "第三方接口开始条件", inputs: [{ key: "prompt", type: "textarea" }, { key: "images", type: "image_list" }, { key: "model", type: "select", options: ["gpt-image-2.5-sunburst"], defaultValue: "gpt-image-2.5-sunburst" }],
    steps: [{ id: "generate", name: "内容生成", kind: "capability", capabilityId: "core.http_request", capabilityVersion: "2", inputs: [{ key: "input_images", sourceRef: "input.images", selection: { mode: "all" } }, { key: "prompt", sourceRef: "input.prompt" }, { key: "model", sourceRef: "input.model" }], outputs: [{ key: "response", type: "json" }, { key: "status", type: "number" }], capabilityConfig: thirdPartyConfig, ...(startCondition ? { startCondition } : {}) }],
    outputs: [{ key: "result", type: "json", sourceRef: "step.generate.outputs.response" }],
  });
  thirdPartyCalls = 0;
  const runA = await service.submit({ runId: id("third-party-start-run"), inputValues: { prompt: "编辑这张图", model: "gpt-image-2.5-sunburst", images: [createRuntimeMediaValue("image", [{ filename: "input.png", type: "input" }])] }, workflow: flow(imagesGate) });
  const resultA = await service.wait(settings.projectDirectory, runA.runId);
  assert.equal(resultA.status, "completed", resultA.error);
  assert.equal(thirdPartyCalls, 1, "开始条件满足时应调用一次第三方接口");
  assert.deepEqual(resultA.steps.map((step) => step.status), ["completed"]);
  assert.deepEqual(resultA.outputs[0]?.value, { ok: true });

  thirdPartyCalls = 0;
  const runB = await service.submit({ runId: id("third-party-start-skip"), inputValues: { prompt: "编辑这张图", model: "gpt-image-2.5-sunburst", images: [] }, workflow: flow(imagesGate) });
  const resultB = await service.wait(settings.projectDirectory, runB.runId);
  assert.equal(resultB.status, "completed", resultB.error);
  assert.equal(thirdPartyCalls, 0, "开始条件不满足时不得调用第三方接口");
  assert.equal(resultB.steps[0].status, "skipped");
  assert.equal(resultB.steps[0].message, "开始条件未满足");
  assert.deepEqual(resultB.steps[0].outputs, { response: null, status: null });
  assert.equal(resultB.outputs[0]?.value, null);
});

test("开始条件：第三方接口逐项执行按项跳过，空项不发出请求且保留位置", async (t) => {
  const { service, settings } = await harness(t, { executors: registry });
  await service.start();
  const run = await service.submit({ runId: id("third-party-start-items"), inputValues: { prompts: ["first", "", "third"], model: "gpt-image-2.5-sunburst" }, workflow: {
    sceneId: "test", name: "第三方逐项开始条件", inputs: [{ key: "prompts", type: "json" }, { key: "model", type: "text" }],
    steps: [{ id: "edit", name: "逐项编辑", kind: "capability", capabilityId: "core.http_request", capabilityVersion: "2", execution: { mode: "for_each", sourceRef: "input.prompts", onError: "continue", maxConcurrency: 1 }, inputs: [{ key: "prompt", sourceRef: "iteration.item" }, { key: "model", sourceRef: "input.model" }], outputs: [{ key: "response", type: "json" }, { key: "status", type: "number" }], capabilityConfig: thirdPartyConfig, startCondition: { match: "all", rules: [{ id: "r1", leftRef: "input.prompts", operator: "is_not_empty", valueSource: "literal", rightValue: "", rightRef: "" }] } }],
    outputs: [{ key: "result", type: "json", sourceRef: "step.edit.outputs.response" }],
  } });
  const result = await service.wait(settings.projectDirectory, run.runId);
  assert.equal(result.status, "completed", result.error);
  assert.equal(thirdPartyCalls, 2, "只有非空项调用第三方接口");
  assert.deepEqual(result.steps[0]?.items?.map((item) => item.status), ["completed", "skipped", "completed"]);
  assert.equal(result.steps[0]?.items?.[1]?.error, "开始条件未满足");
  assert.deepEqual(result.outputs[0]?.value, [{ ok: true }, null, { ok: true }]);
});
