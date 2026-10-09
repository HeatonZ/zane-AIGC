import assert from "node:assert/strict";
import test from "node:test";
import { executeCodeStep, validateCodeStep, CODE_STEP_CONTRACT } from "./codeSandbox.js";
import type { StepExecutionContext } from "./workflowExecutor.js";
import type { JsonValue, RunStep } from "../domain/types.js";
import { createRuntimeMediaValue } from "../runtimeValue.js";
import { harness, id } from "../testing/testSupport.js";
import codeStepFactory from "../capabilities/packages/codeStep.js";
import type { CapabilityPackage, CapabilityRuntime } from "../capabilities/package.js";

const pkg = (await codeStepFactory({ async hermes() { throw new Error("不应调用 Hermes"); }, async comfyui() { throw new Error("不应调用 ComfyUI"); }, async condition() { throw new Error("不应调用条件适配器"); } } as CapabilityRuntime)) as CapabilityPackage;

function step(code: string, outputs: RunStep["outputs"], inputs: RunStep["inputs"] = [], config: Record<string, unknown> = {}): RunStep {
  return { id: "code", name: "代码步骤", kind: "capability", capabilityId: "core.code", capabilityVersion: pkg.definition.version, capabilityConfig: { code, timeoutMs: 3000, ...config }, inputs, outputs };
}
function context(current: RunStep, inputValues: Record<string, JsonValue> = {}, signal?: AbortSignal): StepExecutionContext {
  return { runInputValues: inputValues, runId: "test", artifacts: { directory: "", inputs: "", workflow: "", runtime: "", output: "" }, step: current, inputValues, stepValues: new Map(), types: new Map(), settings: { projectDirectory: "", comfyuiBaseUrl: "", workflowTimeoutMinutes: 1, enabledHermesProfiles: [] }, inputFields: [], signal: signal ?? AbortSignal.timeout(30000) } as StepExecutionContext;
}

test("自定义代码：声明输入经沙箱计算，返回各输出端口的类型化结果", async () => {
  const current = step("const total = (inputs.items ?? []).length;\nconst doubled = inputs.items.map((item) => item * 2);\nreturn { count: total, first: inputs.items[0], enabled: total > 1, summary: \"共\" + total + \"项\", doubled };", [
    { key: "count", type: "number" }, { key: "first", type: "number" }, { key: "enabled", type: "boolean" }, { key: "summary", type: "text" }, { key: "doubled", type: "json" },
  ], [{ key: "items", sourceRef: "input.items" }]);
  assert.deepEqual(await executeCodeStep(context(current, { items: [1, 2, 3] })), { count: 3, first: 1, enabled: true, summary: "共3项", doubled: [2, 4, 6] });
});

test("自定义代码：await 异步、深结构输入和文本保留，空输入可用默认值", async () => {
  const async = step("await Promise.resolve();\nreturn { size: JSON.stringify(inputs.tree).length, text: inputs.title };", [{ key: "size", type: "number" }, { key: "text", type: "text" }], [{ key: "tree", sourceRef: "input.tree" }, { key: "title", sourceRef: "input.title" }]);
  assert.deepEqual(await executeCodeStep(context(async, { tree: { a: [1, { b: true, c: null }], d: "文本" }, title: "标题 & <b>标记</b>" })), { size: 38, text: "标题 & <b>标记</b>" });
  const empty = step("return { missing: inputs.absent ?? null };", [{ key: "missing", type: "json" }], [{ key: "absent", sourceRef: "input.absent" }]);
  assert.deepEqual(await executeCodeStep(context(empty, {})), { missing: null });
});

test("自定义代码：沙箱不暴露进程、Node 模块、网络、定时器和输入原型链", async () => {
  const current = step("return { exposed: [typeof process, typeof Buffer, typeof fetch, typeof require, typeof setTimeout, typeof structuredClone, typeof inputs.constructor, typeof inputs.__proto__].join(\",\") };", [{ key: "exposed", type: "text" }], [{ key: "items", sourceRef: "input.items" }]);
  assert.equal((await executeCodeStep(context(current, { items: [1] }))).exposed, "undefined,undefined,undefined,undefined,undefined,undefined,undefined,undefined");
});

test("自定义代码：抛错、console 日志尾部、不可序列化与超大返回都是明确错误", async () => {
  const thrower = step("console.log(\"debug-value\", 42);\nthrow new Error(\"业务校验失败\");", [{ key: "value", type: "json" }]);
  await assert.rejects(() => executeCodeStep(context(thrower)), (error: any) => error.code === "CODE_EXECUTION_FAILED" && error.message.includes("业务校验失败") && error.message.includes("debug-value 42"));
  for (const [code, label] of [["return { value: 10n };", "BigInt"], ["return { value: () => 1 };", "函数"], ["return { value: undefined };", "undefined"]] as const) {
    await assert.rejects(() => executeCodeStep(context(step(code, [{ key: "value", type: "json" }]))), { code: "INVALID_CODE_OUTPUT" }, label);
  }
  await assert.rejects(() => executeCodeStep(context(step("return { value: \"x\".repeat(2 * 1024 * 1024) };", [{ key: "value", type: "text" }]))), { code: "INVALID_CODE_OUTPUT" });
});

test("自定义代码：同步死循环被 vm 超时终止，永不完成的 Promise 立即失败", async () => {
  await assert.rejects(() => executeCodeStep(context(step("while (true) {}", [{ key: "value", type: "json" }], [], { timeoutMs: 300 }))), { code: "CODE_TIMEOUT" });
  await assert.rejects(() => executeCodeStep(context(step("await new Promise(() => {});\nreturn { value: null };", [{ key: "value", type: "json" }], [], { timeoutMs: 300 }))), { code: "CODE_EXECUTION_FAILED" });
});

test("自定义代码：长计算在运行取消时立即终止沙箱", async () => {
  const controller = new AbortController();
  const busy = step("const until = Date.now() + 5000; while (Date.now() < until) {}\nreturn { value: 1 };", [{ key: "value", type: "number" }]);
  setTimeout(() => controller.abort(new Error("运行已取消")), 300);
  await assert.rejects(() => executeCodeStep(context(busy, {}, controller.signal)), /运行已取消/);
});

test("自定义代码：输出必须齐声明端口，拒绝缺失、额外和类型不符", async () => {
  await assert.rejects(() => executeCodeStep(context(step("return { value: 1 };", [{ key: "value", type: "number" }, { key: "label", type: "text" }]))), { code: "INVALID_CODE_OUTPUT" });
  await assert.rejects(() => executeCodeStep(context(step("return { value: 1, debug: \"x\" };", [{ key: "value", type: "number" }]))), { code: "INVALID_CODE_OUTPUT" });
  await assert.rejects(() => executeCodeStep(context(step("return { value: 1 };", [{ key: "value", type: "text" }]))), { code: "INVALID_CODE_OUTPUT" });
  await assert.rejects(() => executeCodeStep(context(step("return { value: null };", [{ key: "value", type: "number" }]))), { code: "INVALID_CODE_OUTPUT" });
  await assert.rejects(() => executeCodeStep(context(step("return { value: \"yes\" };", [{ key: "value", type: "boolean" }]))), { code: "INVALID_CODE_OUTPUT" });
  await assert.rejects(() => executeCodeStep(context(step("return [1];", [{ key: "value", type: "json" }]))), { code: "INVALID_CODE_OUTPUT" });
});

test("自定义代码：媒体输入以只读文件名投影进入沙箱，不暴露路径/URL/字节", async () => {
  const images = createRuntimeMediaValue("image", [{ filename: "a.png", type: "input" }, { filename: "b.png", type: "input" }]);
  const empty = createRuntimeMediaValue("image", []);
  const read = step("return { count: (inputs.reference ?? []).length, names: (inputs.reference ?? []).map((item) => item.filename).join(\"|\"), nested: JSON.stringify(inputs.payload), plain: JSON.stringify(inputs.text) };", [{ key: "count", type: "number" }, { key: "names", type: "text" }, { key: "nested", type: "text" }, { key: "plain", type: "text" }], [{ key: "reference", sourceRef: "input.reference" }, { key: "payload", sourceRef: "input.payload" }, { key: "text", sourceRef: "input.text" }]);
  const filled = await executeCodeStep(context(read, { reference: images, payload: { shots: [{ cover: images }], note: "keep" }, text: "纯文本不受影响" }));
  assert.deepEqual(filled, { count: 2, names: "a.png|b.png", nested: JSON.stringify({ shots: [{ cover: [{ filename: "a.png" }, { filename: "b.png" }] }], note: "keep" }), plain: "\"纯文本不受影响\"" });
  for (const key of ["nested", "names", "plain"] as const) assert.ok(!String(filled[key]).includes("input") || key === "plain", key);
  const blank = await executeCodeStep(context(read, { reference: empty, payload: {}, text: "" }));
  assert.deepEqual(blank, { count: 0, names: "", nested: "{}", plain: "\"\"" });
  // A media projection is data only: the sandbox still cannot produce or consume media bytes.
  await assert.rejects(() => executeCodeStep(context(step("return { images: inputs.reference };", [{ key: "images", type: "image_list" }], [{ key: "reference", sourceRef: "input.reference" }]), { reference: images })), { code: "INVALID_CODE_CONFIG" });
});

test("自定义代码：配置和端口在发布前校验，拒绝无效代码与端口", () => {
  const outputs: RunStep["outputs"] = [{ key: "value", type: "json" }];
  validateCodeStep(step("return { value: 1 };", outputs));
  assert.throws(() => validateCodeStep(step("", outputs)), { code: "INVALID_CODE_CONFIG" });
  assert.throws(() => validateCodeStep(step("   ", outputs)), { code: "INVALID_CODE_CONFIG" });
  assert.throws(() => validateCodeStep(step("return { value: 1 };", outputs, [], { timeoutMs: 100 })), { code: "INVALID_CODE_CONFIG" });
  assert.throws(() => validateCodeStep(step("return { value: 1 };", outputs, [], { timeoutMs: 60001 })), { code: "INVALID_CODE_CONFIG" });
  assert.throws(() => validateCodeStep(step("return { value: 1 };", outputs, [], { timeoutMs: "3000" })), { code: "INVALID_CODE_CONFIG" });
  assert.throws(() => validateCodeStep(step("return { value: 1 };", outputs, [], { timeoutMs: 1.5 })), { code: "INVALID_CODE_CONFIG" });
  assert.throws(() => validateCodeStep(step("return { value: 1 };", [])), { code: "INVALID_CODE_CONFIG" });
  assert.throws(() => validateCodeStep(step("return { value: 1 };", [{ key: "images", type: "image_list" }])), { code: "INVALID_CODE_CONFIG" });
  assert.throws(() => validateCodeStep(step("return { value: 1 };", [{ key: "0bad", type: "json" }])), { code: "INVALID_CODE_CONFIG" });
  assert.throws(() => validateCodeStep(step("return { value: 1 };", [{ key: "value", type: "text" }, { key: "value", type: "number" }])), { code: "INVALID_CODE_CONFIG" });
  assert.throws(() => validateCodeStep(step("return { value: 1 };", outputs, [{ key: "has space", sourceRef: "input.a" }])), { code: "INVALID_CODE_CONFIG" });
  assert.throws(() => validateCodeStep(step("return { value: 1 };", outputs, [{ key: "dup", sourceRef: "input.a" }, { key: "dup", sourceRef: "input.b" }])), { code: "INVALID_CODE_CONFIG" });
  assert.throws(() => validateCodeStep(step("if (true) {", outputs)), { code: "INVALID_CODE_CONFIG" });
  // 未知配置键沿用既有能力包约定：不拒绝，也不进入执行。\n  validateCodeStep(step("return { value: 1 };", outputs, [], { timeoutMs: 5000, extra: "ignored" }));
  assert.equal(CODE_STEP_CONTRACT.capabilityId, "core.code");
  assert.ok(CODE_STEP_CONTRACT.sandbox.nodeBuiltins === false && CODE_STEP_CONTRACT.sandbox.network === false);
});

test("自定义代码：经后台执行完成运行、记录能力身份，无效配置在提交前拒绝", async (t) => {
  const { executors, service, settings } = await harness(t);
  executors.registerCapability(pkg);
  await service.start();
  const definition = { sceneId: "test", name: "代码步骤流程", inputs: [{ key: "items", type: "json" }], outputs: [] as Array<Record<string, unknown>>, steps: [] as Array<Record<string, unknown>> };
  const codeStep = { id: "code", name: "汇总", kind: "capability", capabilityId: "core.code", capabilityVersion: pkg.definition.version, capabilityConfig: { code: "return { count: (inputs.items ?? []).length, summary: \"共\" + inputs.items.length + \"项\" };", timeoutMs: 5000 }, inputs: [{ key: "items", sourceRef: "input.items" }], outputs: [{ key: "count", type: "number" }, { key: "summary", type: "text" }] };
  definition.steps = [codeStep];
  definition.outputs = [{ key: "count", type: "number", sourceRef: "step.code.outputs.count" }, { key: "summary", type: "text", sourceRef: "step.code.outputs.summary" }];
  const run = await service.submit({ runId: id("code-step-run"), inputValues: { items: [1, 2, 3] }, workflow: definition });
  const result = await service.wait(settings.projectDirectory, run.runId);
  assert.equal(result.status, "completed", result.error);
  assert.deepEqual(result.outputs.map((output) => [output.key, output.value]), [["count", 3], ["summary", "共3项"]]);
  assert.equal(result.steps[0]?.capabilityId, "core.code");
  assert.equal(result.steps[0]?.capabilityVersion, pkg.definition.version);

  const broken = structuredClone(definition);
  (broken.steps[0] as Record<string, unknown>).capabilityConfig = { code: "return { count: \"x\";", timeoutMs: 5000 };
  await assert.rejects(() => service.submit({ runId: id("code-step-broken"), inputValues: { items: [1] }, workflow: broken }), { code: "INVALID_CODE_CONFIG" });
});

test("自定义代码：逐项执行每项一次代码执行并按序聚合输出", async (t) => {
  const { executors, service, settings } = await harness(t);
  executors.registerCapability(pkg);
  await service.start();
  const run = await service.submit({ runId: id("code-step-each"), inputValues: { items: ["a", "b", "c"], seed: "起步" }, workflow: {
    sceneId: "test", name: "逐项代码流程", inputs: [{ key: "items", type: "json" }, { key: "seed", type: "text" }],
    steps: [{ id: "code", name: "逐项标记", kind: "capability", capabilityId: "core.code", capabilityVersion: pkg.definition.version, capabilityConfig: { code: "return { text: inputs.nth + \"/\" + inputs.item + \"/\" + inputs.has + \"/\" + inputs.carry };", timeoutMs: 5000 }, execution: { mode: "for_each", sourceRef: "input.items", carry: { outputKey: "text", initialSourceRef: "input.seed" } }, inputs: [{ key: "item", sourceRef: "iteration.item" }, { key: "nth", sourceRef: "iteration.index" }, { key: "has", sourceRef: "iteration.hasPrevious" }, { key: "carry", sourceRef: "iteration.previous" }], outputs: [{ key: "text", type: "text" }] }],
    outputs: [{ key: "texts", type: "json", sourceRef: "step.code.outputs.text" }],
  } });
  const result = await service.wait(settings.projectDirectory, run.runId);
  assert.equal(result.status, "completed", result.error);
  // 提供初始种子后首项即视为有上一项状态，index 仍为 0 基。\n  assert.deepEqual(result.outputs[0]?.value, ["0/a/true/起步", "1/b/true/0/a/true/起步", "2/c/true/1/b/true/0/a/true/起步"]);
  assert.equal(result.steps[0]?.items?.length, 3);
});