import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { loadCapabilityPackages } from "./loadPackages.js";
import { ExecutorRegistry } from "../execution/executorRegistry.js";
import { createCapabilityRouter } from "../api/capabilityRoutes.js";
import type { CapabilityRuntime, CapabilityPackage } from "./package.js";
import templateFactory from "./packages/textTemplate.js";
import dataSelectFactory from "./packages/dataSelect.js";
import { harness, id, temporaryDirectory } from "../testing/testSupport.js";
const runtime: CapabilityRuntime = { async hermes() { throw new Error("不应调用 Hermes"); }, async comfyui() { throw new Error("不应调用 ComfyUI"); }, async condition() { return { result: true }; } };
async function template() { return await templateFactory(runtime) as CapabilityPackage; }

test("能力目录自动发现内置与新增包，旧适配器映射不丢失", async () => {
  const registry = await loadCapabilityPackages(runtime);
  assert.ok(registry.definitions().some((item) => item.id === "data.select"));
  assert.ok(registry.definitions().some((item) => item.id === "text.template"));
  for (const adapter of ["h3_long_video", "commerce_pack", "long_text_video", "video_concat"]) {
    const step = { id: adapter, name: adapter, kind: "comfyui", comfyui: { workflowFile: "test.json", adapter, h3LongVideo: { planRef: "input.plan", promptRowsRef: "input.prompts", referenceImagesRef: "input.images" } } };
    const prepared = registry.prepareStep(step);
    assert.equal(prepared.capabilityVersion, "1");
    assert.ok(prepared.capabilityId);
    assert.equal(prepared.comfyui?.adapter, adapter);
  }
  assert.throws(() => registry.prepareStep({ id: "bad", name: "bad", kind: "comfyui", comfyui: { workflowFile: "", adapter: "missing" } }), /未安装此能力/);
});

test("第三方请求能力：response/status/images均为可选声明，生图场景可只声明images", async () => {
  const registry = await loadCapabilityPackages(runtime);
  const definition = registry.definitions().find(item => item.id === "core.http_request");
  assert.ok(definition);
  for (const key of ["response", "status", "images"]) assert.equal(definition!.outputs.find(output => output.key === key)?.required, false, key);
  const step = { id: "image", name: "生图", kind: "capability", capabilityId: "core.http_request", capabilityVersion: "2",
    capabilityConfig: { url: "https://images.example.net/v1/images/edits", bodyFormat: "multipart", bodyTemplate: { model: "fixture-model", prompt: "{{prompt}}" }, multipartImages: [{ inputKey: "product_images", fieldName: "image[]" }], responseImages: { path: "data", base64Field: "b64_json", expectedCount: 1 } },
    inputs: [{ key: "product_images", sourceRef: "input.product_images" }, { key: "prompt", sourceRef: "input.prompt" }],
    outputs: [{ key: "images", label: "返回图片", type: "image_list" }] };
  const prepared = registry.prepareStep(step);
  assert.deepEqual(prepared.outputs, [{ key: "images", label: "返回图片", type: "image_list" }]);
  assert.equal(prepared.capabilityVersion, "2");
});

test("能力契约冻结默认配置、拒绝重复注册/版本不匹配/无效配置", async () => {
  const registry = new ExecutorRegistry().registerCapability(await template());
  const step = { id: "template", name: "模板", kind: "capability", capabilityId: "text.template", inputs: [], outputs: [{ key: "text", type: "text" }] };
  assert.equal(registry.prepareStep(step).capabilityConfig?.template, "{{text}}");
  assert.throws(() => registry.prepareStep({ ...step, capabilityVersion: "0" }), /版本已变化/);
  assert.throws(() => registry.prepareStep({ ...step, capabilityConfig: { template: 7 } }), /数据类型/);
  const duplicate = await template();
  assert.throws(() => registry.registerCapability(duplicate), /重复/);
  const definitions = registry.definitions(); definitions[0].label = "mutated";
  assert.equal(registry.definitions()[0].label, "文本模板（旧版兼容）");
});

test("新增一个包文件即可自动发现，无须修改服务核心", async (t) => {
  const directory = path.join(await temporaryDirectory(t), "packages"); await mkdir(directory);
  await writeFile(path.join(directory, "package.json"), JSON.stringify({ type: "module" }));
  await writeFile(path.join(directory, "demo.js"), 'export default () => ({ definition: { id: "demo.echo", version: "1", label: "回声", description: "测试", category: "测试", legacy: { kind: "capability" }, inputs: [], outputs: [], config: [], editor: { inputs: "ports", outputs: "ports" }, result: { renderer: "text" } }, async execute() { return { text: "ok" }; } });');
  const registry = await loadCapabilityPackages(runtime, directory);
  assert.deepEqual(registry.definitions().map((item) => item.id), ["demo.echo"]);
});

test("文本模板通过现有后台引擎运行并归档能力版本，不调用模型", async (t) => {
  const { executors, service, settings } = await harness(t); executors.registerCapability(await template()); await service.start();
  const run = await service.submit({ runId: id("capability-template"), inputValues: { product: "茶杯" }, workflow: {
    sceneId: "test", name: "能力包运行", inputs: [{ key: "product", type: "text" }],
    steps: [{ id: "compose", name: "拼装", kind: "capability", capabilityId: "text.template", capabilityConfig: { template: "介绍：{{product}}" }, inputs: [{ key: "product", sourceRef: "input.product" }], outputs: [{ key: "text", type: "text" }] }],
    outputs: [{ key: "copy", type: "text", sourceRef: "step.compose.outputs.text" }],
  } });
  const result = await service.wait(settings.projectDirectory, run.runId);
  assert.equal(result.status, "completed"); assert.equal(result.outputs[0].value, "介绍：茶杯");
  assert.equal(result.steps[0].capabilityId, "text.template"); assert.equal(result.workflow.steps[0].capabilityVersion, "1");
});

test("退役的低频执行方式仍按旧快照执行，新场景只推荐core.code", async (t) => {
  const registry = await loadCapabilityPackages(runtime);
  for (const id of ["core.manual", "text.template", "media.select_references", "media.image_layout", "media.video_concat"]) {
    const definition = registry.definitions().find(item => item.id === id);
    assert.ok(definition, id + " 必须保留注册以兼容已发布快照");
    assert.equal(definition!.usage?.compatibilityOnly, true, id);
    assert.match(definition!.label, /旧版兼容/, id);
    assert.match(definition!.usage!.whenToUse, /core\.code/, id + " 必须给出 core.code 新场景做法");
  }
  const code = registry.definitions().find(item => item.id === "core.code")!;
  assert.equal(code.usage?.compatibilityOnly, undefined); assert.match(code.usage!.whenToUse, /数据传递|模板拼装/);
  // 旧形态：手动数据传递 + 文本模板按发布快照继续执行，行为不随新能力改变。
  const { service, settings } = await harness(t, { executors: registry });
  await service.start();
  const legacyRun = await service.submit({ runId: id("legacy-manual-template"), inputValues: { text: "旧快照" }, workflow: {
    sceneId: "test", name: "旧版数据传递兼容", inputs: [{ key: "text", type: "text" }],
    steps: [
      { id: "manual", name: "数据传递", kind: "manual", inputs: [{ key: "text", label: "文本", sourceRef: "input.text" }], outputs: [{ key: "text", label: "文本", type: "text" }], promptTemplate: "" },
      { id: "compose", name: "文本模板", kind: "capability", capabilityId: "text.template", capabilityVersion: "1", capabilityConfig: { template: "{{text}}" }, inputs: [{ key: "text", label: "文本", sourceRef: "step.manual.outputs.text" }], outputs: [{ key: "text", label: "拼装文本", type: "text" }], promptTemplate: "" },
    ],
    outputs: [{ key: "text", type: "text", sourceRef: "step.compose.outputs.text" }],
  } });
  const legacyResult = await service.wait(settings.projectDirectory, legacyRun.runId);
  assert.equal(legacyResult.status, "completed", legacyResult.error);
  assert.equal(legacyResult.outputs[0].value, "旧快照");
  assert.equal(legacyResult.steps.find(step => step.stepId === "manual")?.capabilityId, "core.manual");
  assert.equal(legacyResult.steps.find(step => step.stepId === "compose")?.capabilityId, "text.template");
});

test("能力目录 HTTP 只返回声明，不暴露执行函数", async (t) => {
  const registry = await loadCapabilityPackages(runtime);
  const app = express(); app.use(createCapabilityRouter(registry)); const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  t.after(() => new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); }));
  const response = await fetch("http://127.0.0.1:" + (server.address() as { port: number }).port + "/api/v1/capabilities");
  const body = await response.json() as { schemaVersion: number; capabilities: Array<{ id: string; execute?: unknown }> };
  assert.equal(body.schemaVersion, 1); assert.ok(body.capabilities.some((item) => item.id === "text.template"));
  assert.ok(body.capabilities.every((item) => item.execute === undefined));
});

test("旧条件步骤与条件选择保留仅旧版兼容，已发布形态仍可执行", async (t) => {
  const registry = await loadCapabilityPackages(runtime);
  for (const id of ["core.condition", "data.select"]) {
    const definition = registry.definitions().find(item => item.id === id);
    assert.ok(definition, id + " 必须保留注册以兼容已发布快照");
    assert.equal(definition!.usage?.compatibilityOnly, true, id + " 必须标记 compatibilityOnly");
    assert.match(definition!.usage!.whenToUse, /startCondition/, id + " 必须说明开始条件替代");
  }
  // 旧形态：条件节点 + runCondition + data.select 合并分支，行为不随新能力改变。
  const { executors, service, settings } = await harness(t);
  executors.registerCapability(await template());
  executors.registerCapability(await dataSelectFactory(runtime) as CapabilityPackage);
  executors.register({ kind: "control", async execute(context) { return { result: (context.inputValues.flag as boolean) === true }; } });
  executors.register({ kind: "hermes", async execute() { return { result: "活泼高级" }; } });
  await service.start();
  const legacyStep = (id: string, name: string) => id === "gate"
    ? { id, name, kind: "control", control: { type: "condition", match: "all", rules: [{ id: "rule_legacy_1", leftRef: "input.flag", operator: "equals", valueSource: "literal", rightValue: "true", rightRef: "" }] }, outputs: [{ key: "result", type: "boolean" }] }
    : id === "merge"
      ? { id, name, kind: "capability", capabilityId: "data.select", capabilityVersion: "1", inputs: [
          { key: "condition", sourceRef: "step.gate.outputs.result" },
          { key: "when_true", sourceRef: "step.writer.outputs.result" },
          { key: "when_false", valueSource: "literal", literalType: "text", literalValue: "固定默认风格" },
        ], outputs: [{ key: "value", type: "text" }] }
      : id === "writer"
        ? { id, name, kind: "hermes", hermesProfile: "writer", promptTemplate: "分析风格", inputs: [{ key: "input_1", sourceRef: "input.reference" }], outputs: [{ key: "result", type: "text" }], runCondition: { conditionStepId: "gate", expectedResult: true } }
        : { id, name, kind: "capability", capabilityId: "text.template", capabilityConfig: { template: "{{style}}" }, inputs: [{ key: "style", sourceRef: "step.merge.outputs.value" }], outputs: [{ key: "text", type: "text" }] };
  const steps = ["gate", "writer", "merge", "render"].map(id => legacyStep(id, id));
  const run = await service.submit({ runId: id("legacy-condition-compat"), inputValues: { flag: false, reference: [] }, workflow: {
    sceneId: "test", name: "旧条件兼容", inputs: [{ key: "flag", type: "boolean" }, { key: "reference", type: "image_list" }], steps,
    outputs: [{ key: "text", type: "text", sourceRef: "step.render.outputs.text" }],
  } });
  const result = await service.wait(settings.projectDirectory, run.runId);
  assert.equal(result.status, "completed", result.error);
  assert.equal(result.outputs[0].value, "固定默认风格");
  assert.equal(result.steps.find(step => step.stepId === "writer")?.status, "skipped");
  assert.equal(result.steps.find(step => step.stepId === "merge")?.capabilityId, "data.select");
});