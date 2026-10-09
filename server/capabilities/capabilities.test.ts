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
  assert.equal(registry.definitions()[0].label, "文本模板");
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
