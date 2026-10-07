import assert from "node:assert/strict";
import test from "node:test";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { carryValue } from "../domain/iterationCarry.js";
import { validateWorkflowShape } from "../domain/workflowValidation.js";
import { resolveStepInputs, resolveWorkflowReference } from "../domain/workflowValues.js";
import { isRuntimeMediaValue } from "../runtimeValue.js";
import { harness, workflow, submission, id, until, deferred } from "../testing/testSupport.js";
import type { RunWorkflowDefinition, JsonValue } from "../domain/types.js";
import { planRerun } from "../services/rerunPlanner.js";
import { executeWorkflow } from "./workflowExecutor.js";

function chain(seed = false): RunWorkflowDefinition {
  const flow = workflow([{ id: "loop", name: "状态链", kind: "fake", execution: { mode: "for_each", sourceRef: "input.items", carry: { outputKey: "value", ...(seed ? { initialSourceRef: "input.seed" } : {}) } },
    inputs: [{ key: "previous", sourceRef: "iteration.previous" }, { key: "has", sourceRef: "iteration.hasPrevious" }, { key: "index", sourceRef: "iteration.index" }, { key: "item", sourceRef: "iteration.item" }], outputs: [{ key: "value", type: "json" }] },
    { id: "last", name: "汇总", kind: "fake", inputs: [{ key: "all", sourceRef: "step.loop.outputs.value" }], outputs: [{ key: "value", type: "json" }] }]);
  flow.inputs = [{ key: "items", type: "json", required: true }, { key: "seed", type: "json" }];
  flow.outputs[0].type = "json"; return flow;
}
const inputs = { items: [1, 2, 3, 4], seed: { sum: 10 } };
function sum(previous: JsonValue, item: JsonValue) { return Number((previous as { sum?: number } | null)?.sum ?? 0) + Number(item); }

test("carry契约严格校验：非法作用域/输出键/来源/调度及未启用状态引用", () => {
  const valid = chain(); validateWorkflowShape(valid as unknown as Record<string, unknown>);
  for (const config of [{ outputKey: "missing" }, { outputKey: "value", initialSourceRef: "iteration.previous" }, { outputKey: "value", initialSourceRef: "input.seed[bad" }, { outputKey: "value", typo: true }]) {
    const bad = chain(); bad.steps[0].execution!.carry = config;
    assert.throws(() => validateWorkflowShape(bad as unknown as Record<string, unknown>), /状态传递/);
  }
  for (const fields of [{ maxConcurrency: 2 }, { onError: "continue" as const }, { mode: "once" as const }]) {
    const bad = chain(); Object.assign(bad.steps[0].execution!, fields);
    assert.throws(() => validateWorkflowShape(bad as unknown as Record<string, unknown>), /状态传递/);
  }
  const global = chain(); global.execution = global.steps[0].execution;
  assert.throws(() => validateWorkflowShape(global as unknown as Record<string, unknown>), /步骤级/);
  const disabled = chain(); delete disabled.steps[0].execution!.carry;
  assert.throws(() => validateWorkflowShape(disabled as unknown as Record<string, unknown>), /状态引用/);
});

test("typed状态：媒体保持附件、JSON路径支持、0/false/空文本有效，空媒体/null/错类型拒绝", () => {
  for (const [type, value] of [["boolean", false], ["number", 0], ["text", ""], ["json", { sum: 3 }]] as const) assert.deepEqual(carryValue(value, type, "状态"), value);
  const media = carryValue(["video.mp4"], "video_list", "状态"); assert.ok(isRuntimeMediaValue(media));
  assert.ok(isRuntimeMediaValue(resolveWorkflowReference("iteration.previous[0]", { "iteration.previous": media }, new Map())));
  assert.equal(resolveWorkflowReference("iteration.previous.sum", { "iteration.previous": { sum: 3 } }, new Map()), 3);
  for (const [type, value] of [["json", null], ["json", undefined], ["video_list", []], ["video_list", [{}]], ["number", "0"]]) assert.throws(() => carryValue(value, String(type), "状态"), /状态/);
});

test("无种子首项null/false与有种子true，串行继承紧邻输出、正常聚合和空来源", async t => {
  const calls: Record<string, JsonValue>[] = [];
  const h = await harness(t, { executor: { kind: "fake", async execute(c) {
    const v = resolveStepInputs(c.step, c.inputValues, c.stepValues) as Record<string, JsonValue>;
    if (c.step.id === "last") return { value: v.all };
    assert.equal(c.types.get("iteration.previous"), "json"); calls.push(v);
    return { value: { sum: sum(v.previous, v.item) } };
  } } }); await h.service.start();
  for (const seed of [false, true]) {
    calls.length = 0; const runId = id("carry-seed-" + seed);
    await h.service.submit(submission(runId, chain(seed), inputs)); const result = await h.service.wait(h.settings.projectDirectory, runId);
    assert.equal(result.status, "completed"); assert.equal(calls[0].has, seed); assert.deepEqual(calls[0].previous, seed ? inputs.seed : null);
    assert.deepEqual(calls.map(v => v.index), [0, 1, 2, 3]); assert.deepEqual(calls.map(v => v.has), [seed, true, true, true]);
    assert.deepEqual(calls.slice(1).map(v => v.previous), result.steps[0].items!.slice(0, 3).map(item => item.outputs!.value));
    assert.deepEqual(result.outputs[0].value, (seed ? [11, 13, 16, 20] : [1, 3, 6, 10]).map(sum => ({ sum })));
  }
  await h.service.submit(submission(id("carry-empty"), chain(), { items: [] }));
  assert.deepEqual((await h.service.wait(h.settings.projectDirectory, id("carry-empty"))).outputs[0].value, []);
});

test("失败/缺失状态停止后缀；恢复完成前缀并从紧邻成功输出继续", async t => {
  let fail = true; const calls: number[] = [];
  const h = await harness(t, { executor: { kind: "fake", async execute(c) {
    const v = resolveStepInputs(c.step, c.inputValues, c.stepValues) as Record<string, JsonValue>;
    if (c.step.id === "last") return { value: v.all! };
    calls.push(c.itemIndex!); if (fail && c.itemIndex === 1) throw new Error("段2失败");
    return { value: { sum: sum(v.previous!, v.item!) } };
  } } }); await h.service.start();
  await h.service.submit(submission(id("carry-fail"), chain(), inputs));
  const failed = await h.service.wait(h.settings.projectDirectory, id("carry-fail"));
  assert.equal(failed.status, "failed"); assert.deepEqual(calls, [0, 1]); assert.equal(failed.steps[0].items!.length, 2);
  const plan = await h.service.previewRerun(h.settings.projectDirectory, failed.runId, { rerunSteps: [{ stepId: "loop", itemIndexes: [1] }] });
  assert.deepEqual(plan.steps[0].runItemIndexes, [1, 2, 3]); assert.deepEqual(plan.steps[0].reuseItemIndexes, [0]);
  fail = false;
  await h.service.submit({ ...submission(id("carry-resume"), chain(), inputs), resumeFromRunId: failed.runId });
  const resumed = await h.service.wait(h.settings.projectDirectory, id("carry-resume"));
  assert.equal(resumed.status, "completed"); assert.deepEqual(calls, [0, 1, 1, 2, 3]);
  assert.deepEqual(resumed.outputs[0].value, [1, 3, 6, 10].map(sum => ({ sum })));
});

test("历史缺口/来源变化不复用陈旧后缀", async t => {
  const calls: number[] = []; let corruption = "gap";
  const h = await harness(t, { execute: (prepared, context) => {
    if (prepared.resumeSource) {
      const saved = prepared.resumeSource.steps[0]; saved.status = "failed";
      if (corruption === "gap") saved.items = saved.items?.filter(item => item.index !== 1);
      else if (corruption === "source") saved.items![1].value = 999;
      else saved.items![1].outputs = {};
    }
    return executeWorkflow(prepared, context);
  }, executor: { kind: "fake", async execute(c) {
    const v = resolveStepInputs(c.step, c.inputValues, c.stepValues) as Record<string, JsonValue>;
    if (c.step.id === "last") throw new Error("暂时不汇总");
    calls.push(c.itemIndex!); return { value: { sum: sum(v.previous!, v.item!) } };
  } } }); await h.service.start();
  for (corruption of ["gap", "source", "output"]) {
    const originalId = id("carry-original-" + corruption);
    await h.service.submit(submission(originalId, chain(), inputs)); await h.service.wait(h.settings.projectDirectory, originalId);
    calls.length = 0; const runId = id("carry-corrupt-" + corruption);
    await h.service.submit({ ...submission(runId, chain(), inputs), resumeFromRunId: originalId });
    await h.service.wait(h.settings.projectDirectory, runId); assert.deepEqual(calls, [1, 2, 3]);
  }
});

test("单项参数/重做失效后缀；替换保留本项、重算后续及下游；种子变化重算整链", async t => {
  const calls: string[] = [];
  const h = await harness(t, { executor: { kind: "fake", async execute(c) {
    const v = resolveStepInputs(c.step, c.inputValues, c.stepValues) as Record<string, JsonValue>;
    calls.push(c.step.id + ":" + (c.itemIndex ?? "once"));
    return { value: c.step.id === "last" ? v.all! : { sum: sum(v.previous!, v.item!) + (c.step.promptTemplate === "edit" ? 100 : 0) } };
  } } }); await h.service.start();
  await h.service.submit(submission(id("carry-rerun-original"), chain(true), inputs));
  const original = await h.service.wait(h.settings.projectDirectory, id("carry-rerun-original"));
  for (const [name, changes, expectedCalls, expectedSums] of [
    ["select", { rerunSteps: [{ stepId: "loop", itemIndexes: [1] }] }, ["loop:1", "loop:2", "loop:3", "last:once"], [11, 13, 16, 20]],
    ["edit", { stepOverrides: [{ stepId: "loop", itemIndex: 1, promptTemplate: "edit" }] }, ["loop:1", "loop:2", "loop:3", "last:once"], [11, 113, 116, 120]],
    ["replace", { outputOverrides: [{ stepId: "loop", itemIndex: 1, outputs: { value: { sum: 30 } } }] }, ["loop:2", "loop:3", "last:once"], [11, 30, 33, 37]],
    ["replace-last", { outputOverrides: [{ stepId: "loop", itemIndex: 3, outputs: { value: { sum: 30 } } }] }, ["last:once"], [11, 13, 16, 30]],
    ["seed", { inputOverrides: { seed: { sum: 20 } } }, ["loop:0", "loop:1", "loop:2", "loop:3", "last:once"], [21, 23, 26, 30]],
  ] as const) {
    calls.length = 0;
    const preview = await h.service.previewRerun(h.settings.projectDirectory, original.runId, changes);
    const run = await h.service.submit({ ...submission(id("carry-rerun-" + name), original.workflow, original.inputValues), rerunFromRunId: original.runId, rerunRequest: changes });
    const result = await h.service.wait(h.settings.projectDirectory, run.runId);
    assert.equal(result.status, "completed", result.error); assert.deepEqual(calls, expectedCalls);
    assert.deepEqual(result.outputs[0].value, expectedSums.map(sum => ({ sum }))); assert.deepEqual(result.rerunPlan, preview);
    assert.deepEqual(await h.service.getRun(h.settings.projectDirectory, original.runId), original);
  }
});

test("媒体链保存/恢复仍带类型，无显式种子时不使用样例；缺失输出立即失败", async t => {
  let missing = false; let failSecond = false; const mediaCalls: number[] = []; const h = await harness(t, { executor: { kind: "fake", async execute(c) {
    mediaCalls.push(c.itemIndex!); if (failSecond && c.itemIndex === 1) throw new Error("模拟第二段视频失败");
    if (c.itemIndex === 0) assert.equal(c.inputValues["iteration.previous"], null);
    else { assert.ok(isRuntimeMediaValue(c.inputValues["iteration.previous"])); assert.equal(c.types.get("iteration.previous"), "video_list"); }
    return missing ? {} as Record<string, JsonValue> : { value: [path.join(h.root, "segment.mp4")] };
  } } }); await h.service.start(); await writeFile(path.join(h.root, "segment.mp4"), "isolated fake media bytes");
  const flow = chain(); flow.steps = [flow.steps[0]]; flow.steps[0].outputs![0].type = "video_list"; flow.outputs[0] = { key: "result", type: "video_list", sourceRef: "step.loop.outputs.value" };
  await h.service.submit(submission(id("carry-video"), flow, { items: [1, 2] })); assert.equal((await h.service.wait(h.settings.projectDirectory, id("carry-video"))).status, "completed");
  failSecond = true; mediaCalls.length = 0;
  await h.service.submit(submission(id("carry-video-fail"), flow, { items: [1, 2] }));
  assert.equal((await h.service.wait(h.settings.projectDirectory, id("carry-video-fail"))).status, "failed"); assert.deepEqual(mediaCalls, [0, 1]);
  failSecond = false; mediaCalls.length = 0;
  await h.service.submit({ ...submission(id("carry-video-resume"), flow, { items: [1, 2] }), resumeFromRunId: id("carry-video-fail") });
  assert.equal((await h.service.wait(h.settings.projectDirectory, id("carry-video-resume"))).status, "completed"); assert.deepEqual(mediaCalls, [1]);
  missing = true;
  await h.service.submit(submission(id("carry-missing"), flow, { items: [1, 2] })); const failed = await h.service.wait(h.settings.projectDirectory, id("carry-missing"));
  assert.equal(failed.status, "failed"); assert.equal(failed.steps[0].items!.length, 1); assert.match(failed.error!, /传递输出/);
});


test("取消链中项后不启动后继；显式空种子在执行器调用前失败", async t => {
  const gate = deferred<void>(); const calls: number[] = []; let entered = false;
  const h = await harness(t, { executor: { kind: "fake", async execute(c) {
    calls.push(c.itemIndex!); if (c.itemIndex === 1) { entered = true; await gate.promise; c.signal.throwIfAborted(); }
    return { value: { sum: c.itemIndex! } };
  } } }); await h.service.start();
  await h.service.submit(submission(id("carry-cancel"), chain(), inputs)); await until(() => entered);
  await h.service.cancel(h.settings.projectDirectory, id("carry-cancel")); gate.resolve();
  assert.equal((await h.service.wait(h.settings.projectDirectory, id("carry-cancel"))).status, "cancelled"); assert.deepEqual(calls, [0, 1]);
  calls.length = 0;
  await h.service.submit(submission(id("carry-null-seed"), chain(true), { items: [1], seed: null }));
  const result = await h.service.wait(h.settings.projectDirectory, id("carry-null-seed"));
  assert.equal(result.status, "failed"); assert.match(result.error!, /初始传递状态/); assert.deepEqual(calls, []);
});

test("Hermes单项反馈失效后缀；拒绝多项替换或同时改种子，不启动任何执行", async t => {
  const calls: number[] = [];
  const h = await harness(t, { executor: { kind: "hermes", async execute(c) { calls.push(c.itemIndex!); return { value: { sum: c.itemIndex! } }; } } }); await h.service.start();
  const flow = chain(true); flow.steps = [flow.steps[0]]; flow.steps[0].kind = "hermes"; flow.steps[0].hermesProfile = "mock-only"; flow.outputs[0].sourceRef = "step.loop.outputs.value";
  await h.service.submit(submission(id("carry-feedback-source"), flow, inputs)); const source = await h.service.wait(h.settings.projectDirectory, id("carry-feedback-source"));
  calls.length = 0;
  const plan = planRerun(source, { feedback: [{ stepId: "loop", itemIndex: 1, message: "修正节奏" }] });
  assert.deepEqual(plan.plan.steps[0].runItemIndexes, [1, 2, 3]); assert.deepEqual(plan.plan.steps[0].reuseItemIndexes, [0]);
  await h.service.submit({ ...submission(id("carry-feedback-run"), flow, inputs), rerunFromRunId: source.runId, rerunRequest: plan.request });
  assert.equal((await h.service.wait(h.settings.projectDirectory, id("carry-feedback-run"))).status, "completed"); assert.deepEqual(calls, [1, 2, 3]);
  calls.length = 0;
  const replacement = { stepId: "loop", itemIndex: 1, outputs: { value: { sum: 100 } } };
  assert.throws(() => planRerun(source, { outputOverrides: [replacement, { ...replacement, itemIndex: 2 }] }), /一次只能替换一项/);
  assert.throws(() => planRerun(source, { inputOverrides: { seed: { sum: 20 } }, outputOverrides: [replacement] }), /上游修改/);
  assert.deepEqual(calls, []);
});


test("未声明/后序初始来源在接受任务前拒绝，不创建执行副作用", async t => {
  let calls = 0; const h = await harness(t, { executor: { kind: "fake", async execute() { calls++; return { value: "unused" }; } } }); await h.service.start();
  for (const [index, reference] of ["input.missing", "step.last.outputs.value", "step.nope.outputs.value"].entries()) {
    const flow = chain(true); flow.steps[0].execution!.carry!.initialSourceRef = reference;
    await assert.rejects(h.service.submit(submission(id("carry-invalid-dependency-" + index), flow, inputs)), (error: unknown) => (error as { code?: string }).code === "INVALID_WORKFLOW_REFERENCE");
  }
  assert.equal(calls, 0);
});
