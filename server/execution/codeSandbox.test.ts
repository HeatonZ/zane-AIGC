import assert from "node:assert/strict";
import test from "node:test";
import { executeCodeStep, validateCodeStep, CODE_STEP_CONTRACT } from "./codeSandbox.js";
import type { StepExecutionContext } from "./workflowExecutor.js";
import type { JsonValue, RunStep } from "../domain/types.js";
import path from "node:path";
import os from "node:os";
import { mkdir, writeFile } from "node:fs/promises";
import sharp from "sharp";
import { createRuntimeMediaValue, runtimeMediaItems, type RuntimeMediaValue } from "../runtimeValue.js";
import { harness, id, temporaryDirectory } from "../testing/testSupport.js";
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

test("自定义代码：无法经原型链/构造函数逃逸到宿主 process（安全回归）", async () => {
  // 这些探针只读取 `typeof`，即使逃逸成功也不会产生副作用；断言的是「拿不到宿主对象」。
  // 历史缺陷：沙箱全局是带 Object.prototype 的宿主对象、console 又是宿主函数，
  // 于是 this.constructor.constructor / console.log.constructor 都能拿到宿主 realm 的
  // Function，`Function("return process")()` 即得宿主 process，进而
  // process.binding("spawn_sync") 执行任意命令、process.binding("fs") 读写任意文件。
  const probes: Array<[string, string]> = [
    ["this.constructor.constructor", "this.constructor.constructor"],
    ["console.log.constructor", "console.log.constructor"],
    ["Object.getPrototypeOf(console.log).constructor", "Object.getPrototypeOf(console.log).constructor"],
    ["({}).constructor.constructor", "({}).constructor.constructor"],
    ["[].filter.constructor", "([].filter).constructor"],
    ["(function(){}).constructor", "(function() {}).constructor"],
    ["console.log.constructor.constructor", "console.log.constructor.constructor"],
  ];
  for (const [label, expression] of probes) {
    const current = step("try { const F = " + expression + "; return { kind: typeof F(\"return process\")() }; } catch (error) { return { kind: \"blocked\" }; }", [{ key: "kind", type: "text" }]);
    const reachable = (await executeCodeStep(context(current))).kind;
    assert.equal(reachable, "blocked", label + " 不应拿到宿主 process，实际为 " + reachable);
  }
  // 沙箱内仍必须是一个可用的 ECMAScript 环境：console 与语言内置能力不受加固影响。
  const usable = step("const values = [3, 1, 2].sort();\nconsole.log(\"still-works\", 42);\nreturn { summary: values.join(\",\") + \"|\" + Math.max(1, 2, 3) + \"|\" + JSON.stringify({ a: [1] }) + \"|\" + /a(b)/.exec(\"ab\")[1] + \"|\" + typeof Date };", [{ key: "summary", type: "text" }]);
  const result = await executeCodeStep(context(usable));
  assert.equal(result.summary, "1,2,3|3|{\"a\":[1]}|b|function");
  // 纵深防御：上下文禁用字符串代码生成，因此 eval/new Function 在沙箱内直接不可用。
  // 这不是逃逸路径（逃逸已被上面的探针堵住），而是即使有宿主函数对象泄漏也构造不出新函数。
  // 已核验当前 14 个场景的 9 个 core.code 步骤均未使用 eval/new Function。
  for (const [label, expression] of [["eval", "eval(\"1+1\")"], ["new Function", "(function () {}).constructor(\"return 1\")()"]] as const) {
    const attempt = step("try { " + expression + "; return { outcome: \"allowed\" }; } catch (error) { return { outcome: \"blocked\" }; }", [{ key: "outcome", type: "text" }]);
    assert.equal((await executeCodeStep(context(attempt))).outcome, "blocked", label + " 应被上下文禁用");
  }
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
  // 投影只是数据：媒体输出端口按 filename 选择既有媒体，既不产生新媒体，也不暴露路径/URL/字节。
  const passthrough = await executeCodeStep(context(step("return { images: inputs.reference };", [{ key: "images", type: "image_list" }], [{ key: "reference", sourceRef: "input.reference" }]), { reference: images }));
  assert.deepEqual(runtimeMediaItems(passthrough.images, "image").map((item) => item.filename), ["a.png", "b.png"]);
  await assert.rejects(() => executeCodeStep(context(step("return { images: [{ filename: \"c.png\" }] };", [{ key: "images", type: "image_list" }], [{ key: "reference", sourceRef: "input.reference" }]), { reference: images })), { code: "INVALID_CODE_OUTPUT" }, "输入里不存在的媒体不能凭文件名伪造");
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
  for (const type of ["image_list", "video_list", "audio_list"]) assert.doesNotThrow(() => validateCodeStep(step("return { " + type + ": [] };", [{ key: type, type }])), type);
  assert.throws(() => validateCodeStep(step("return { value: 1 };", [{ key: "value", type: "single_media" as never }])), { code: "INVALID_CODE_CONFIG" });
  assert.throws(() => validateCodeStep(step("return { value: 1 };", [{ key: "0bad", type: "json" }])), { code: "INVALID_CODE_CONFIG" });
  assert.throws(() => validateCodeStep(step("return { value: 1 };", [{ key: "value", type: "text" }, { key: "value", type: "number" }])), { code: "INVALID_CODE_CONFIG" });
  assert.throws(() => validateCodeStep(step("return { value: 1 };", outputs, [{ key: "has space", sourceRef: "input.a" }])), { code: "INVALID_CODE_CONFIG" });
  assert.throws(() => validateCodeStep(step("return { value: 1 };", outputs, [{ key: "dup", sourceRef: "input.a" }, { key: "dup", sourceRef: "input.b" }])), { code: "INVALID_CODE_CONFIG" });
  assert.throws(() => validateCodeStep(step("if (true) {", outputs)), { code: "INVALID_CODE_CONFIG" });
  // 未知配置键沿用既有能力包约定：不拒绝，也不进入执行。\n  validateCodeStep(step("return { value: 1 };", outputs, [], { timeoutMs: 5000, extra: "ignored" }));
  assert.equal(CODE_STEP_CONTRACT.capabilityId, "core.code");
  assert.ok(CODE_STEP_CONTRACT.sandbox.nodeBuiltins === false && CODE_STEP_CONTRACT.sandbox.network === false);
});

test("自定义代码：媒体输出端口按 filename 选择、重排、合并既有媒体，未授权引用与类型不符明确失败", async () => {
  const images = createRuntimeMediaValue("image", [
    { id: "img-a", kind: "image", locator: { type: "path", value: "C:/tmp/a.png" }, filename: "a.png" },
    { id: "img-b", kind: "image", locator: { type: "path", value: "C:/tmp/b.png" }, filename: "b.png" },
  ]);
  const voices = createRuntimeMediaValue("audio", [{ id: "aud-a", kind: "audio", locator: { type: "path", value: "C:/tmp/a.wav" }, filename: "a.wav" }]);
  const current = step("return { picked: [inputs.images[1].filename, inputs.images[0].filename, inputs.images[0].filename], names: inputs.images.map(item => item.filename), voices: inputs.voices.map(item => ({ filename: item.filename })) };",
    [{ key: "picked", type: "image_list" }, { key: "names", type: "json" }, { key: "voices", type: "audio_list" }],
    [{ key: "images", sourceRef: "input.images" }, { key: "voices", sourceRef: "input.voices" }]);
  const result = await executeCodeStep(context(current, { images, voices }));
  const picked = result.picked as RuntimeMediaValue;
  assert.equal(picked.mediaKind, "image");
  assert.deepEqual(picked.items.map((item) => [item.filename, item.kind]), [["b.png", "image"], ["a.png", "image"], ["a.png", "image"]]);
  assert.deepEqual(picked.items.map((item) => (item.locator as { value: string }).value), ["C:/tmp/b.png", "C:/tmp/a.png", "C:/tmp/a.png"]);
  assert.deepEqual(result.names, ["a.png", "b.png"]);
  assert.deepEqual((result.voices as RuntimeMediaValue).items.map((item) => item.filename), ["a.wav"]);
  // 只能引用本步骤输入里的媒体：未知文件、路径/URL、类型不符、非数组与未声明输入都是明确失败。
  for (const [code, expected] of [
    ["return { picked: [\"missing.png\"] };", "不存在的媒体"],
    ["return { picked: [\"C:/tmp/a.png\"] };", "不存在的媒体"],
    ["return { picked: [\"a.wav\"] };", "不一致"],
    ["return { picked: \"a.png\" };", "必须是媒体文件名数组"],
    ["return { picked: [\"\"] };", "每一项都必须是媒体文件名"],
    ["return { picked: [{ path: \"C:/tmp/a.png\" }] };", "每一项都必须是媒体文件名"],
  ] as const) {
    await assert.rejects(() => executeCodeStep(context(step(code, [{ key: "picked", type: "image_list" }], [{ key: "images", sourceRef: "input.images" }, { key: "voices", sourceRef: "input.voices" }]), { images, voices })),
      (error: any) => error.code === "INVALID_CODE_OUTPUT" && error.message.includes(expected), code);
  }
  await assert.rejects(() => executeCodeStep(context(step("return { picked: [\"a.png\"] };", [{ key: "picked", type: "image_list" }]), { images })), { code: "INVALID_CODE_OUTPUT" }, "未声明的输入不可见");
});

test("自定义代码：相对归档URL的媒体输入仍可按filename选择（回归）", async () => {
  // Regression for a third-party image step feeding a code step. The image step
  // publishes its decoded results as canonical *relative* archive URLs; that
  // shape previously carried no file name, so the sandbox projection was blank
  // and every selection by filename failed with INVALID_CODE_OUTPUT.
  const runId = "72fa80cb-9724-4755-9f07-e03f72b061a4";
  const generated = createRuntimeMediaValue("image", [{ url: `/api/v1/runs/${runId}/media/7985392f-89d8-41d7-9033-6c8fbbe3d0aa.png` }]);
  assert.equal(generated.items[0]!.filename, "7985392f-89d8-41d7-9033-6c8fbbe3d0aa.png");
  const current = step("const edited = (inputs.edit_images ?? []).map((item) => item.filename);\nconst generated = (inputs.gen_images ?? []).map((item) => item.filename);\nreturn { images: edited.length ? edited : generated };", [{ key: "images", type: "image_list" }], [{ key: "edit_images", sourceRef: "input.edit_images" }, { key: "gen_images", sourceRef: "input.gen_images" }]);
  const filled = await executeCodeStep(context(current, { edit_images: createRuntimeMediaValue("image", []), gen_images: generated }));
  const items = runtimeMediaItems(filled.images, "image");
  assert.deepEqual(items.map((item) => item.filename), ["7985392f-89d8-41d7-9033-6c8fbbe3d0aa.png"]);
  // The selection reuses the already-archived media instead of inventing a file.
  assert.deepEqual(items.map((item) => (item.locator as { value: string }).value), [`/api/v1/runs/${runId}/media/7985392f-89d8-41d7-9033-6c8fbbe3d0aa.png`]);
});

test("自定义代码：媒体输出经后台运行按序合并，可作为最终输出读取", async (t) => {
  const { executors, service, settings, root } = await harness(t);
  executors.registerCapability(pkg);
  await service.start();
  const seed = path.join(root, "seed.png"); const left = path.join(root, "left.png"); const right = path.join(root, "right.png");
  for (const file of [seed, left, right]) await writeFile(file, await sharp({ create: { width: 8, height: 8, channels: 3, background: "#123456" } }).png().toBuffer());
  const run = await service.submit({ runId: id("code-step-media"), inputValues: { seed: [seed], left: [left], right: [right] }, workflow: {
    sceneId: "test", name: "代码媒体合并", inputs: [{ key: "seed", type: "image_list" }, { key: "left", type: "image_list" }, { key: "right", type: "image_list" }],
    steps: [{ id: "merge", name: "合并媒体", kind: "capability", capabilityId: "core.code", capabilityVersion: pkg.definition.version,
      capabilityConfig: { code: "return { images: [...inputs.seed.map(item => item.filename), ...inputs.left.map(item => item.filename), ...inputs.right.map(item => item.filename)] };", timeoutMs: 5000 },
      inputs: [{ key: "seed", sourceRef: "input.seed" }, { key: "left", sourceRef: "input.left" }, { key: "right", sourceRef: "input.right" }],
      outputs: [{ key: "images", type: "image_list" }] }],
    outputs: [{ key: "images", type: "image_list", sourceRef: "step.merge.outputs.images" }],
  } });
  const result = await service.wait(settings.projectDirectory, run.runId);
  assert.equal(result.status, "completed", result.error);
  // 选择的媒体仍是本运行已归档的同一批文件：顺序保持 seed → left → right，不产生新媒体。
  const values = (result.outputs[0]?.value ?? []) as string[];
  assert.equal(values.length, 3);
  assert.deepEqual(values.map((value) => /([^\\/]+)\.png$/.exec(value)?.[1].split("-")[0]), ["seed", "left", "right"]);
  assert.ok(values.every((value) => value.includes(path.join(".zane", "runs", run.runId))), "媒体输出必须指向本次运行已归档的同一文件");
  assert.deepEqual(runtimeMediaItems(result.steps[0]?.outputs?.images, "image").map((item) => (item.locator as { value: string }).value), values);
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

test("自定义代码：开启 fileAccess 后只能经宿主读取受控根目录，返回根内绝对路径", async (t) => {
  const root = await temporaryDirectory(t);
  const batch = path.join(root, "11");
  await mkdir(path.join(batch, "角色"), { recursive: true });
  for (const name of ["ちびムーン.png", "AZKi.png"]) await writeFile(path.join(batch, "角色", name), "x");
  await writeFile(path.join(batch, "2.png"), "y");
  const code = [
    "const entries = zane.fs.list(inputs.batch + \"/角色\");",
    "const missing = zane.fs.stat(inputs.batch + \"/不存在\");",
    "const dir = zane.fs.stat(inputs.batch);",
    "return { names: entries.map((entry) => entry.name).join(\",\"), sizes: entries.every((entry) => entry.isFile && entry.size === 1), first: entries[0].path, missing: missing.exists, isDir: dir.isDir };",
  ].join("\n");
  const current = step(code, [{ key: "names", type: "text" }, { key: "sizes", type: "boolean" }, { key: "first", type: "text" }, { key: "missing", type: "boolean" }, { key: "isDir", type: "boolean" }], [{ key: "batch", sourceRef: "input.batch" }], { fileAccess: { enabled: true } });
  const base = context(current, { batch });
  const result = await executeCodeStep({ ...base, localExportRoot: root } as StepExecutionContext);
  // 目录按名称排序（与平台无关的稳定顺序），并返回根目录内的绝对路径交给下游步骤。
  assert.equal(result.names, "AZKi.png,ちびムーン.png");
  assert.equal(result.sizes, true);
  assert.equal(result.first, path.join(batch, "角色", "AZKi.png"));
  assert.equal(result.missing, false);
  assert.equal(result.isDir, true);
});

test("自定义代码：readText 读取受控根目录内的文本，用于从动作集合里挑一行", async (t) => {
  const root = await temporaryDirectory(t);
  const batch = path.join(root, "11");
  await mkdir(batch, { recursive: true });
  // 动作集合：多行文本，行尾混用 \n 与 \r\n，并带一个空行。
  await writeFile(path.join(batch, "动作1.txt"), "第一条动作\n\n第二条动作\r\n第三条动作\n", "utf8");
  await writeFile(path.join(root, "binary.bin"), "无关内容");
  const code = [
    "const text = zane.fs.readText(inputs.batch + \"/动作1.txt\");",
    "const lines = text.split(/\\r?\\n/).map((line) => line.trim()).filter(Boolean);",
    "const picked = lines[1];",
    "const missing = (() => { try { zane.fs.readText(inputs.batch + \"/不存在.txt\"); return \"no-error\"; } catch (error) { return error.code; } })();",
    "return { count: lines.length, picked: picked, first: lines[0], missing: missing, isString: typeof text === \"string\" };",
  ].join("\n");
  const current = step(code, [{ key: "count", type: "number" }, { key: "picked", type: "text" }, { key: "first", type: "text" }, { key: "missing", type: "text" }, { key: "isString", type: "boolean" }], [{ key: "batch", sourceRef: "input.batch" }], { fileAccess: { enabled: true } });
  const result = await executeCodeStep({ ...context(current, { batch }), localExportRoot: root } as StepExecutionContext);
  assert.equal(result.count, 3, "空行被过滤后应剩 3 条动作");
  assert.equal(result.first, "第一条动作");
  assert.equal(result.picked, "第二条动作", "\r\n 行尾也要能被正确切分");
  assert.equal(result.isString, true);
  assert.equal(result.missing, "FILE_NOT_FOUND");
});

test("自定义代码：readText 越界、非文件与超过大小上限都明确失败", async (t) => {
  const root = await temporaryDirectory(t);
  await mkdir(path.join(root, "11"), { recursive: true });
  await writeFile(path.join(root, "11", "big.txt"), "x".repeat(1024 * 1024 + 1));
  const base = (current: RunStep) => ({ ...context(current), localExportRoot: root } as StepExecutionContext);
  const codeOf = (error: unknown) => (error as { code?: string }).code;
  const read = (expression: string) => step("const value = zane.fs.readText(" + expression + ");\nreturn { value: String(value).length };", [{ key: "value", type: "text" }], [], { fileAccess: { enabled: true } });

  // .. 逃逸与根外绝对路径都必须拒绝，读文本不放宽既有边界。
  await assert.rejects(() => executeCodeStep(base(read("\"../outside.txt\""))), (error) => codeOf(error) === "FILE_OUTSIDE_ROOT");
  await assert.rejects(() => executeCodeStep(base(read(JSON.stringify(path.join(os.tmpdir(), "outside.txt"))))), (error) => codeOf(error) === "FILE_OUTSIDE_ROOT");
  // 目录不是文件：报错信息必须点明原因（FILE_ACCESS_FAILED 与既有 list 行为一致，按通用执行失败暴露）。
  await assert.rejects(() => executeCodeStep(base(read("\"11\""))), (error) => /不是文件/.test(String((error as Error).message)));
  // 超过 1MB 上限：明确失败，而不是把大文件读进内存。
  await assert.rejects(() => executeCodeStep(base(read("\"11/big.txt\""))), (error) => codeOf(error) === "FILE_TOO_LARGE");
});

test("自定义代码：文件访问越界、未配置根目录与关闭时无 zane.fs 都明确失败", async (t) => {
  const root = await temporaryDirectory(t);
  await writeFile(path.join(root, "kept.png"), "x");
  const code = (expression: string) => step("const value = " + expression + ";\nreturn { value: JSON.stringify(value) };", [{ key: "value", type: "text" }], [], { fileAccess: { enabled: true } });
  const base = (current: RunStep) => ({ ...context(current), localExportRoot: root } as StepExecutionContext);
  const codeOf = (error: unknown) => (error as { code?: string }).code;

  // .. 逃逸必须被拒绝，而不是被归一化到根目录内。
  for (const escape of ["\"../outside.png\"", "\"..\\\\outside.png\"", "inputs.batch + \"/../../outside.png\""]) {
    const current = escape.startsWith("inputs") ? step("const value = zane.fs.list(" + escape + ");\nreturn { value: \"read\" };", [{ key: "value", type: "text" }], [{ key: "batch", sourceRef: "input.batch" }], { fileAccess: { enabled: true } }) : code("zane.fs.list(" + escape + ")");
    await assert.rejects(() => executeCodeStep({ ...base(current), inputValues: { batch: path.join(root, "11") } } as StepExecutionContext), (error) => codeOf(error) === "FILE_OUTSIDE_ROOT", escape);
  }
  // 根目录之外的绝对路径同样拒绝。
  const absolute = code("zane.fs.stat(" + JSON.stringify(path.join(os.tmpdir(), "outside.png")) + ")");
  await assert.rejects(() => executeCodeStep(base(absolute)), (error) => codeOf(error) === "FILE_OUTSIDE_ROOT");

  // 未配置根目录：整步失败，不退化到无限制读取。
  const noRoot = code("zane.fs.list(\".\")");
  await assert.rejects(() => executeCodeStep({ ...context(noRoot) } as StepExecutionContext), (error) => codeOf(error) === "FILE_ACCESS_DISABLED");

  // 未开启 fileAccess：沙箱里根本没有 zane，配置也不会泄露成可用能力。
  const disabled = step("return { value: [typeof zane, typeof globalThis.zane].join(\",\") };", [{ key: "value", type: "text" }]);
  assert.equal((await executeCodeStep({ ...context(disabled), localExportRoot: root } as StepExecutionContext)).value, "undefined,undefined");
});

test("自定义代码：开启 fileAccess 不放宽隔离，宿主对象与进程仍不可达", async () => {
  const probes = ["this.constructor.constructor", "console.log.constructor", "({}).constructor.constructor", "zane.fs.list.constructor", "Object.getPrototypeOf(zane.fs).constructor"];
  for (const expression of probes) {
    const current = step("try { const F = " + expression + "; return { kind: typeof F(\"return process\")() }; } catch { return { kind: \"blocked\" }; }", [{ key: "kind", type: "text" }], [], { fileAccess: { enabled: true } });
    // 未配置根目录时 zane.fs 的调用会失败，但这里断言的是「拿不到宿主 Function」，与根目录无关。
    const kind = (await executeCodeStep({ ...context(current), localExportRoot: os.tmpdir() } as StepExecutionContext)).kind;
    assert.equal(kind, "blocked", expression + " 不应拿到宿主 process");
  }
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