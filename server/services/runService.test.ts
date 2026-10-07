import { SqliteStore } from "../storage/sqliteStore.js";
import { prepareRunArtifacts } from "../artifacts/runArtifacts.js";
import { writeJsonFile } from "../storage/jsonFileStore.js";
import assert from "node:assert/strict";
import test from "node:test";
import { readFile, writeFile, mkdir, unlink } from "node:fs/promises";
import path from "node:path";
import { harness, workflow, submission, until, deferred, id, temporaryDirectory } from "../testing/testSupport.js";
import { waitForAbortable } from "../execution/cancellation.js";
import { ResourceQueues } from "../execution/resourceQueue.js";
import { externalizeRuntimeValue, resolveWorkflowReference } from "../domain/workflowValues.js";
import { RunService } from "./runService.js";
import { ExecutorRegistry } from "../execution/executorRegistry.js";
import { HttpError } from "../errors.js";

test("后台执行成功：事件与 JSON 归档在 wait 返回前完成", async (t) => {
  const { service, settings, store } = await harness(t);
  await service.start();
  const run = await service.submit(submission(id("success")));
  assert.equal(run.status, "queued");
  const result = await service.wait(settings.projectDirectory, run.runId);
  assert.equal(result.status, "completed");
  assert.equal(result.outputs[0].value, "ok");
  assert.equal(JSON.parse(await readFile(result.artifacts.runtime, "utf8")).status, "completed");
  assert.equal(JSON.parse(await readFile(result.artifacts.output, "utf8")).status, "completed");
  const events = store.events(settings.projectDirectory, run.runId);
  assert.deepEqual(events.map((event) => event.sequence), events.map((_, index) => index + 1));
  assert.ok(events.some((event) => event.type === "step.completed"));
  assert.equal(events.at(-1)?.type, "run.completed");
});

test("失败后断点续跑只调用未完成步骤", async (t) => {
  const calls: string[] = [];
  let fail = true;
  const { service, settings } = await harness(t, { executor: { kind: "fake", async execute({ step, stepValues }) {
    calls.push(step.id);
    if (step.id === "second" && fail) throw new Error("模拟上游失败");
    return { value: step.id === "first" ? "first-output" : stepValues.get("first")!.value };
  } } });
  await service.start();
  const definition = workflow([{ id: "first", name: "一", kind: "fake", outputs: [{ key: "value", type: "text" }] }, { id: "second", name: "二", kind: "fake", outputs: [{ key: "value", type: "text" }] }]);
  await service.submit(submission(id("failure"), definition));
  const failed = await service.wait(settings.projectDirectory, id("failure"));
  assert.equal(failed.status, "failed");
  assert.match(failed.error!, /模拟上游失败/);
  fail = false;
  await service.submit({ ...submission(id("continued"), definition), resumeFromRunId: id("failure") });
  const continued = await service.wait(settings.projectDirectory, id("continued"));
  assert.equal(continued.status, "completed");
  assert.equal(continued.outputs[0].value, "first-output");
  assert.deepEqual(calls, ["first", "second", "second"]);
  await assert.rejects(service.submit({ ...submission(id("invalid-resume"), definition), resumeFromRunId: id("continued") }), (error) => error instanceof HttpError && error.status === 409);
});

test("取消排队和执行中任务，不突破 worker 并发上限", async (t) => {
  const gate = deferred<void>();
  let entered = false;
  let calls = 0;
  const { service, settings } = await harness(t, { executor: { kind: "fake", async execute({ signal }) {
    ++calls; entered = true; await waitForAbortable(gate.promise, signal); return { value: "never" };
  } } });
  await service.start();
  await service.submit(submission(id("active")));
  await until(() => entered);
  await service.submit(submission(id("pending")));
  assert.equal(service.metrics().active, 1);
  assert.equal((await service.cancel(settings.projectDirectory, id("pending"))).status, "cancelled");
  await service.cancel(settings.projectDirectory, id("active"));
  assert.equal((await service.wait(settings.projectDirectory, id("active"))).status, "cancelled");
  assert.equal((await service.getRun(settings.projectDirectory, id("pending")))?.status, "cancelled");
  assert.equal(calls, 1);
});

test("取消 getRun 与 worker 认领之间的竞争不会遗留执行中的任务", async (t) => {
  const { service, settings } = await harness(t, { executor: { kind: "fake", async execute({ signal }) { await waitForAbortable(new Promise(() => {}), signal); return {}; } } });
  await service.submit(submission(id("cancel-race")));
  const original = service.getRun.bind(service);
  let intercept = true;
  service.getRun = async (...args) => {
    const old = await original(...args);
    if (intercept) { intercept = false; await service.start(); }
    return old;
  };
  await service.cancel(settings.projectDirectory, id("cancel-race"));
  assert.equal((await service.wait(settings.projectDirectory, id("cancel-race"))).status, "cancelled");
  await until(() => service.metrics().active === 0);
});

test("客户端停止等待不会取消后台任务", async (t) => {
  const gate = deferred<void>();
  const { service, settings } = await harness(t, { executor: { kind: "fake", async execute() { await gate.promise; return { value: "done" }; } } });
  await service.start();
  await service.submit(submission(id("detached")));
  const waiter = new AbortController();
  const waiting = service.wait(settings.projectDirectory, id("detached"), waiter.signal);
  waiter.abort(new Error("页面已关闭"));
  await assert.rejects(waiting, /页面已关闭/);
  gate.resolve();
  assert.equal((await service.wait(settings.projectDirectory, id("detached"))).status, "completed");
});

test("相同运行 ID 并发提交只有一次成功", async (t) => {
  const { service, store, settings } = await harness(t);
  const results = await Promise.allSettled([service.submit(submission(id("duplicate"))), service.submit(submission(id("duplicate")))]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.ok(results.some((result) => result.status === "rejected" && result.reason.status === 409));
  assert.equal(store.listRuns(settings.projectDirectory).runs.length, 1);
});

test("重启按 FIFO 恢复排队任务，执行中的旧任务只标记 stale", async (t) => {
  const { service, store, settings, executors } = await harness(t);
  const running = await service.submit(submission(id("interrupted")));
  const queued = await service.submit(submission(id("recoverable")));
  store.saveRun(settings.projectDirectory, { ...running, status: "running" }, [{ type: "run.started" }]);
  await service.shutdown(0);
  const recovered = new RunService({ store, executors, loadSettings: async () => settings });
  t.after(() => recovered.shutdown(100));
  await recovered.start();
  assert.equal((await recovered.getRun(settings.projectDirectory, running.runId))?.status, "stale");
  assert.equal((await recovered.wait(settings.projectDirectory, queued.runId)).status, "completed");
});

test("逐项执行保留失败项并按 continue 聚合结果", async (t) => {
  let failSecond = true;
  const calls: number[] = [];
  const { service, settings } = await harness(t, { executor: { kind: "fake", async execute({ inputValues }) {
    const item = inputValues["iteration.item"];
    calls.push(item as number);
    if (item === 2 && failSecond) throw new Error("第二项失败");
    return { value: item };
  } } });
  await service.start();
  const definition = workflow([{ id: "loop", name: "逐项", kind: "fake", execution: { mode: "for_each", sourceRef: "input.items", onError: "continue" }, outputs: [{ key: "value", type: "json" }] }]);
  definition.inputs = [{ key: "items", type: "json", required: true }];
  definition.outputs[0].type = "json";
  await service.submit(submission(id("iteration"), definition, { items: [1, 2, 3] }));
  const result = await service.wait(settings.projectDirectory, id("iteration"));
  assert.deepEqual(result.steps[0].items?.map((item) => item.status), ["completed", "failed", "completed"]);
  assert.deepEqual(result.steps[0].outputs?.value, [1, null, 3]);

  failSecond = false;
  await service.submit({ ...submission(id("iteration-resume"), definition), resumeFromRunId: id("iteration") });
  const resumed = await service.wait(settings.projectDirectory, id("iteration-resume"));
  assert.equal(resumed.status, "completed");
  assert.deepEqual(resumed.steps[0].items?.map((item) => item.status), ["completed", "completed", "completed"]);
  assert.deepEqual(resumed.steps[0].outputs?.value, [1, 2, 3]);
  assert.deepEqual(resumed.outputs[0]?.value, [1, 2, 3]);
  assert.deepEqual(calls, [1, 2, 3, 2]);
});

test("逐项执行按最大并行数运行并保持结果顺序", async (t) => {
  let active = 0;
  let peak = 0;
  const { service, settings } = await harness(t, { executor: { kind: "fake", async execute({ inputValues }) {
    const item = inputValues["iteration.item"] as number;
    active += 1;
    peak = Math.max(peak, active);
    try {
      await new Promise((resolve) => setTimeout(resolve, item % 2 ? 20 : 5));
      return { value: item };
    } finally {
      active -= 1;
    }
  } } });
  await service.start();
  const definition = workflow([{ id: "loop", name: "并行逐项", kind: "fake", execution: { mode: "for_each", sourceRef: "input.items", onError: "continue", maxConcurrency: 2 }, outputs: [{ key: "value", type: "json" }] }]);
  definition.inputs = [{ key: "items", type: "json", required: true }];
  definition.outputs[0].type = "json";
  await service.submit(submission(id("iteration-parallel"), definition, { items: [1, 2, 3, 4] }));
  const result = await service.wait(settings.projectDirectory, id("iteration-parallel"));
  assert.equal(result.status, "completed");
  assert.equal(peak, 2);
  assert.deepEqual(result.steps[0].items?.map((item) => item.index), [0, 1, 2, 3]);
  assert.deepEqual(result.steps[0].outputs?.value, [1, 2, 3, 4]);
});

test("服务重启后逐项执行从断点继续，复用已完成项并重试中断项", async (t) => {
  let holdSecond = true;
  const enteredSecond = deferred<void>();
  const release = deferred<void>();
  const calls: number[] = [];
  const { service, settings, store, executors } = await harness(t, { executor: { kind: "fake", async execute({ inputValues, signal }) {
    const item = inputValues["iteration.item"] as number;
    calls.push(item);
    if (item === 2 && holdSecond) {
      holdSecond = false;
      enteredSecond.resolve();
      await waitForAbortable(release.promise, signal);
    }
    return { value: item };
  } } });
  await service.start();
  const definition = workflow([{ id: "loop", name: "逐项", kind: "fake", execution: { mode: "for_each", sourceRef: "input.items", onError: "continue" }, outputs: [{ key: "value", type: "json" }] }]);
  definition.inputs = [{ key: "items", type: "json", required: true }];
  definition.outputs[0].type = "json";
  await service.submit(submission(id("interrupted-iteration"), definition, { items: [1, 2, 3] }));
  await enteredSecond.promise;
  await service.shutdown(0);

  const stale = store.getRun(settings.projectDirectory, id("interrupted-iteration"));
  assert.equal(stale?.status, "stale");
  assert.deepEqual(stale?.steps[0]?.items?.map((item) => item.status), ["completed", "cancelled"]);

  const recovered = new RunService({ store, executors, loadSettings: async () => settings });
  t.after(() => recovered.shutdown(100));
  await recovered.start();
  await recovered.submit({ ...submission(id("continued-iteration"), definition), resumeFromRunId: id("interrupted-iteration") });
  const resumed = await recovered.wait(settings.projectDirectory, id("continued-iteration"));
  assert.equal(resumed.status, "completed");
  assert.deepEqual(resumed.steps[0]?.items?.map((item) => item.status), ["completed", "completed", "completed"]);
  assert.deepEqual(resumed.outputs[0]?.value, [1, 2, 3]);
  assert.deepEqual(calls, [1, 2, 2, 3]);
  await recovered.shutdown(100);
});

test("条件不满足时跳过步骤，旧单媒体输入归一化为列表", async (t) => {
  let calls = 0;
  const { service, settings } = await harness(t, { executor: { kind: "fake", async execute({ inputValues }) {
    ++calls;
    assert.deepEqual(externalizeRuntimeValue(inputValues.picture), ["data:image/png;base64,AQ=="]);
    return { result: false, value: "first" };
  } } });
  await service.start();
  const definition = workflow([{ id: "condition", name: "条件", kind: "fake", outputs: [{ key: "result", type: "boolean" }] }, { id: "branch", name: "分支", kind: "fake", runCondition: { conditionStepId: "condition", expectedResult: true }, outputs: [{ key: "value", type: "text" }] }]);
  definition.inputs = [{ key: "picture", type: "image", required: true }];
  await service.submit(submission(id("conditional"), definition, { picture: "data:image/png;base64,AQ==" }));
  const result = await service.wait(settings.projectDirectory, id("conditional"));
  assert.equal(result.status, "completed");
  assert.equal(result.steps[1].status, "skipped");
  assert.equal(calls, 1);
});

test("畸形嵌套请求返回 400，不创建运行目录", async (t) => {
  const { service } = await harness(t);
  for (const patch of [{ inputs: [null] }, { comfyui: { workflowFile: "file", bindings: {} } }, { outputs: [null] }, { control: { type: "condition", match: "all", rules: null } }]) {
    const definition = workflow([{ id: "bad", name: "坏步骤", kind: "fake", ...patch } as never]);
    await assert.rejects(service.submit(submission(id("malformed"), definition)), (error) => error instanceof HttpError && error.status === 400);
  }
});

test("损坏的旧运行不会阻止正常记录迁移和分页", async (t) => {
  const { service, settings } = await harness(t);
  const run = await service.submit(submission(id("legacy-good")));
  const folder = path.join(settings.projectDirectory, ".zane", "runs", id("legacy-bad"));
  await mkdir(folder); await writeFile(path.join(folder, "runtime.json"), "{broken");
  const paths = await prepareRunArtifacts(settings, id("legacy-imported"), workflow(), {}, "2026-09-29T00:00:00.000Z");
  await writeJsonFile(paths.runtime, { status: "completed", sceneId: "test-scene", startedAt: "2026-09-29T00:00:00.000Z", steps: [] });
  await writeJsonFile(paths.output, { status: "completed", steps: [], outputs: [] });
  const page = await service.listRuns(settings.projectDirectory, { limit: 10 });
  assert.ok(page.runs.some((item) => item.runId === run.runId));
  assert.equal(page.runs.find((item) => item.runId === id("legacy-imported"))?.status, "completed");
});

test("按资源隔离队列：同地址串行，不同地址可并发，取消等待不会阻塞后续", async () => {
  const queues = new ResourceQueues(); const gate = deferred<void>(); const order: string[] = [];
  const first = queues.run("http://gpu-one/", async () => { order.push("one"); await gate.promise; });
  const controller = new AbortController();
  const cancelled = queues.run("http://gpu-one", async () => { order.push("should-not-run"); }, controller.signal);
  const last = queues.run("http://gpu-one", async () => { order.push("last"); });
  controller.abort(); await assert.rejects(cancelled);
  await queues.run("http://gpu-two", async () => { order.push("two"); });
  assert.deepEqual(order, ["one", "two"]);
  gate.resolve(); await Promise.all([first, last]);
  assert.deepEqual(order, ["one", "two", "last"]);
});

test("资源队列按请求的最大并行数放行同地址任务", async () => {
  const queues = new ResourceQueues();
  let active = 0;
  let peak = 0;
  await Promise.all(Array.from({ length: 4 }, () => queues.run("http://gpu-parallel/", async () => {
    active += 1;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, 5));
    active -= 1;
  }, undefined, 2)));
  assert.equal(peak, 2);
});

test("引用与 JSON 路径解析维持原有执行语义", () => {
  assert.deepEqual(resolveWorkflowReference("input.plan.rows[0].name", { plan: { rows: [{ name: "镜头" }] } }, new Map()), "镜头");
});

test("关闭服务中断活动任务为 stale，不丢弃未开始的持久化队列", async (t) => {
  let entered = false;
  const { service, settings, store } = await harness(t, { executor: { kind: "fake", async execute({ signal }) {
    entered = true; await waitForAbortable(new Promise(() => {}), signal); return {};
  } } });
  await service.start();
  await service.submit(submission(id("shutdown-active")));
  await until(() => entered);
  await service.submit(submission(id("shutdown-queued")));
  await service.shutdown(0);
  assert.equal(store.getRun(settings.projectDirectory, id("shutdown-active"))?.status, "stale");
  assert.equal(store.getRun(settings.projectDirectory, id("shutdown-queued"))?.status, "queued");
  await assert.rejects(service.submit(submission(id("after-shutdown"))), (error) => error instanceof HttpError && error.status === 503);
});

test("坏的进度订阅者不会使任务失败", async (t) => {
  const { service, settings } = await harness(t);
  await service.start();
  await service.submit(submission(id("bad-listener")));
  const off = service.subscribe(settings.projectDirectory, id("bad-listener"), () => { throw new Error("bad subscriber"); });
  assert.equal((await service.wait(settings.projectDirectory, id("bad-listener"))).status, "completed");
  off(); assert.equal(service.metrics().subscribers, 0);
});


test("关闭之后才返回的提交准备，不访问已关闭的 SQLite", async () => {
  const store = new SqliteStore(":memory:");
  const settings = deferred<import("../domain/types.js").SavedSettings>();
  const service = new RunService({ store, executors: new (await import("../execution/executorRegistry.js")).ExecutorRegistry(), loadSettings: () => settings.promise });
  const submitting = service.submit(submission(id("late-preparation")));
  await service.shutdown(0);
  store.close();
  settings.resolve({ projectDirectory: "", comfyuiBaseUrl: "", workflowTimeoutMinutes: 1, enabledHermesProfiles: [] });
  await assert.rejects(submitting, (error) => error instanceof HttpError && error.status === 503);
});


test("排队的单项修订跨 SQLite 重开恢复，保留参数和复用范围且不修改源版本", async (t) => {
  let service: RunService | undefined;
  let store: SqliteStore | undefined;
  const root = await temporaryDirectory(t, async () => { await service?.shutdown(100); store?.close(); });
  const projectDirectory = path.join(root, "project"); await mkdir(projectDirectory);
  const settings = { projectDirectory, comfyuiBaseUrl: "http://127.0.0.1:1", workflowTimeoutMinutes: 1, enabledHermesProfiles: [] };
  const calls: { step: string; value?: string; prompt?: string }[] = [];
  let blocking = false;
  const executors = new ExecutorRegistry().register({ kind: "fake", async execute(context) {
    if (context.step.id === "blocker") {
      blocking = true;
      await waitForAbortable(new Promise(() => {}), context.signal);
    }
    calls.push({ step: context.step.id, value: context.inputValues["iteration.item"] as string | undefined, prompt: context.step.promptTemplate });
    return { value: context.step.id === "loop" ? String(context.inputValues["iteration.item"]) + (context.step.promptTemplate ?? "") : "independent" };
  } });
  const database = path.join(root, "metadata.db");
  store = new SqliteStore(database);
  service = new RunService({ store, executors, loadSettings: async () => settings });
  await service.start();
  const definition = workflow([
    { id: "loop", name: "逐项", kind: "fake", outputs: [{ key: "value", type: "text" }], execution: { mode: "for_each", sourceRef: "input.items" } },
    { id: "independent", name: "独立", kind: "fake", outputs: [{ key: "value", type: "text" }] },
  ]);
  definition.inputs = [{ key: "items", type: "json", required: true }];
  definition.outputs = [{ key: "result", type: "json", sourceRef: "step.loop.outputs.value" }];
  const initial = await service.submit(submission(id("queued-rerun-source"), definition, { items: ["a", "b", "c"] }));
  const original = await service.wait(projectDirectory, initial.runId);
  const originalSnapshot = structuredClone(original);
  await service.submit(submission(id("queued-rerun-blocker"), workflow([{ id: "blocker", name: "占用 worker", kind: "fake", outputs: [{ key: "value", type: "text" }] }])));
  await until(() => blocking);
  const revision = await service.submit({ ...submission(id("queued-rerun-revision"), original.workflow, original.inputValues), rerunFromRunId: original.runId, rerunRequest: { stepOverrides: [{ stepId: "loop", itemIndex: 1, promptTemplate: "-v2" }] } });
  assert.equal(store.getRun(projectDirectory, revision.runId)?.status, "queued");
  await service.shutdown(0); store.close();
  calls.length = 0;
  store = new SqliteStore(database);
  service = new RunService({ store, executors, loadSettings: async () => settings });
  await service.start();
  const result = await service.wait(projectDirectory, revision.runId);
  assert.equal(result.status, "completed");
  assert.equal(result.rerunFromRunId, original.runId);
  assert.deepEqual(result.outputs[0].value, ["a", "b-v2", "c"]);
  assert.deepEqual(calls, [{ step: "loop", value: "b", prompt: "-v2" }]);
  assert.equal(result.steps[0].items?.[1].stepSnapshot?.promptTemplate, "-v2");
  assert.equal(result.steps[0].items?.[0].reusedFromRunId, original.runId);
  assert.equal(result.steps[1].reusedFromRunId, original.runId);
  assert.deepEqual(store.getRun(projectDirectory, original.runId), originalSnapshot);
});


test("替换单项本地图片会归档到新版本并重建聚合，源文件移除后下游仍可读取", async (t) => {
  const calls: string[] = [];
  const h = await harness(t, { executor: { kind: "fake", async execute(context): Promise<Record<string, import("../domain/types.js").JsonValue>> {
    calls.push(context.step.id);
    if (context.step.id === "images") return { images: [context.inputValues["iteration.item"]] };
    const images = externalizeRuntimeValue(context.stepValues.get("images")!.images) as string[];
    return { value: (await Promise.all(images.map((filename) => readFile(filename, "utf8")))).join("|") };
  } } });
  const first = path.join(h.root, "first.png"), second = path.join(h.root, "second.png"), replacement = path.join(h.root, "replacement.png");
  await writeFile(first, "OLD_A"); await writeFile(second, "OLD_B"); await writeFile(replacement, "NEW_B");
  const definition = workflow([
    { id: "images", name: "生成图", kind: "fake", inputs: [], outputs: [{ key: "images", type: "image_list" }], execution: { mode: "for_each", sourceRef: "input.items" } },
    { id: "read", name: "下游", kind: "fake", inputs: [{ key: "images", sourceRef: "step.images.outputs.images" }], outputs: [{ key: "value", type: "text" }] },
  ]);
  definition.inputs = [{ key: "items", type: "json", required: true }];
  await h.service.start();
  const queued = await h.service.submit({ workflow: definition, inputValues: { items: [first, second] } });
  const original = await h.service.wait(h.settings.projectDirectory, queued.runId);
  assert.equal(original.outputs[0].value, "OLD_A|OLD_B"); calls.length = 0;
  const revised = await h.service.submit({ workflow: original.workflow, inputValues: original.inputValues, rerunFromRunId: original.runId, rerunRequest: { outputOverrides: [{ stepId: "images", itemIndex: 1, outputs: { images: [{ path: replacement }] } }] } });
  await unlink(replacement);
  const result = await h.service.wait(h.settings.projectDirectory, revised.runId);
  assert.equal(result.status, "completed"); assert.equal(result.outputs[0].value, "OLD_A|NEW_B");
  assert.deepEqual(calls, ["read"]);
  const stored = result.steps[0].items?.[1].outputs?.images as string[];
  assert.ok(stored[0].startsWith(result.artifacts.directory)); assert.equal(await readFile(stored[0], "utf8"), "NEW_B");
  assert.deepEqual(h.store.getRun(h.settings.projectDirectory, original.runId), original);
});

test("非阻断警告先持久化并去重；单步成功复用及上游失败均保留警告", async t => {
  const gate = deferred<void>();
  let warned = false;
  let firstCalls = 0;
  let fail = true;
  const { service, settings, store } = await harness(t, { executor: { kind: "fake", async execute({ step, warn }) {
    await warn?.(`${step.id} 格式建议`);
    await warn?.(`${step.id} 格式建议`);
    if (step.id === "first") { firstCalls++; warned = true; await gate.promise; }
    if (step.id === "second" && fail) throw new Error("上游不可用，与提示词格式无关");
    return { value: "ok" };
  } } });
  await service.start();
  const definition = workflow([
    { id: "first", name: "第一步", kind: "fake", outputs: [{ key: "value", type: "text" }] },
    { id: "second", name: "第二步", kind: "fake", outputs: [{ key: "value", type: "text" }] },
  ]);
  const initial = await service.submit(submission(id("warning-failed"), definition));
  t.after(() => gate.resolve());
  await until(() => warned);
  const checkpoint = await service.getRun(settings.projectDirectory, initial.runId);
  assert.equal(checkpoint?.status, "running");
  assert.deepEqual(checkpoint?.steps[0].warnings, ["first 格式建议"]);
  gate.resolve();
  const failed = await service.wait(settings.projectDirectory, initial.runId);
  assert.equal(failed.status, "failed");
  assert.deepEqual(failed.steps.map(step => step.warnings), [["first 格式建议"], ["second 格式建议"]]);
  assert.match(failed.error!, /上游不可用/);
  assert.doesNotMatch(failed.error!, /格式建议/);
  assert.deepEqual(JSON.parse(await readFile(failed.artifacts.runtime, "utf8")).steps[1].warnings, ["second 格式建议"]);
  fail = false;
  const resumed = await service.submit({ ...submission(id("warning-resumed"), definition), resumeFromRunId: initial.runId });
  const done = await service.wait(settings.projectDirectory, resumed.runId);
  assert.equal(done.status, "completed");
  assert.equal(firstCalls, 1);
  assert.deepEqual(done.steps.map(step => step.warnings), [["first 格式建议"], ["second 格式建议"]]);
  assert.deepEqual(store.getRun(settings.projectDirectory, done.runId)?.steps[0].warnings, ["first 格式建议"]);
});
