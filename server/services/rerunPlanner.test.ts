import assert from "node:assert/strict";
import test from "node:test";
import type { RunRecord, RunStep } from "../domain/types.js";
import { planRerun } from "./rerunPlanner.js";
import { harness, workflow, id } from "../testing/testSupport.js";
import { resolveStepInputs, resolveWorkflowReference, externalizeRuntimeValue } from "../domain/workflowValues.js";
function source(): RunRecord {
  const steps: RunStep[] = [
    { id: "a", name: "生成", kind: "fake", inputs: [{ key: "text", sourceRef: "input.text" }], outputs: [{ key: "value", type: "text" }] },
    { id: "b", name: "加工", kind: "fake", inputs: [{ key: "text", sourceRef: "step.a.outputs.value" }], outputs: [{ key: "value", type: "text" }] },
    { id: "independent", name: "独立", kind: "fake", inputs: [], outputs: [{ key: "value", type: "text" }] },
  ];
  return { runId: id("plan-source"), sceneId: "test-scene", workflowName: "测试", status: "completed", createdAt: "2026-09-30T00:00:00Z", startedAt: "2026-09-30T00:00:00Z", inputValues: { text: "原文" }, workflow: { ...workflow(steps), inputs: [{ key: "text", type: "text" }] }, steps: steps.map((step) => ({ stepId: step.id, name: step.name, status: "completed", outputs: { value: step.id } })), outputs: [], artifacts: { directory: "", inputs: "", workflow: "", runtime: "", output: "" } };
}
test("替换中间结果只失效依赖分支，独立步骤复用且原记录不变", () => {
  const original = source(); const before = structuredClone(original);
  const result = planRerun(original, { outputOverrides: [{ stepId: "a", outputs: { value: "新文" } }] });
  assert.deepEqual(result.plan.steps.map((step) => step.action), ["replace", "run", "reuse"]);
  assert.equal(result.reusedSteps[0].outputs?.value, "新文"); assert.deepEqual(original, before);
});
test("修改输入和提示词依赖会传递失效，空修改/非法步骤/类型错误被拒绝", () => {
  const original = source();
  assert.deepEqual(planRerun(original, { inputOverrides: { text: "新输入" } }).plan.steps.map((step) => step.action), ["run", "run", "reuse"]);
  original.workflow.steps[2].promptTemplate = "{{step.b.outputs.value}}";
  assert.deepEqual(planRerun(original, { rerunSteps: [{ stepId: "a" }] }).plan.steps.map((step) => step.action), ["run", "run", "run"]);
  assert.throws(() => planRerun(original, {}), /请选择|请修改/);
  assert.throws(() => planRerun(original, { rerunSteps: [{ stepId: "missing" }] }), /找不到/);
  assert.throws(() => planRerun(original, { outputOverrides: [{ stepId: "a", outputs: { value: 3 } }] }), /类型/);
  assert.throws(() => planRerun({ ...original, status: "running" }, { rerunSteps: [{ stepId: "a" }] }), /运行中/);
  assert.throws(() => planRerun(original, { outputOverrides: [{ stepId: "a", outputs: { value: "x" } }], rerunSteps: [{ stepId: "a" }] }), /同时/);
});
test("未声明依赖的能力保守重算，不错误复用可能读取全局上下文的结果", () => {
  const original = source(); original.workflow.steps[2].kind = "capability"; original.workflow.steps[2].capabilityId = "custom.opaque";
  const catalog = [{ id: "custom.opaque", version: "1", label: "未知依赖", description: "", category: "", legacy: { kind: "capability" as const }, inputs: [], outputs: [], config: [], editor: { inputs: "ports" as const, outputs: "ports" as const }, result: { renderer: "auto" as const } }];
  assert.equal(planRerun(original, { rerunSteps: [{ stepId: "a" }] }, catalog).plan.steps[2].action, "run");
});
async function runSource(t: Parameters<typeof harness>[0], foreach = false) {
  const calls: Array<{ step: string; value: unknown; prompt?: string }> = [];
  const h = await harness(t, { executor: { kind: "fake", async execute(context) {
    const values = resolveStepInputs(context.step, context.inputValues, context.stepValues);
    calls.push({ step: context.step.id, value: externalizeRuntimeValue(values.text ?? null), prompt: context.step.promptTemplate });
    if (context.step.id === "generate") return { value: context.step.promptTemplate ? context.step.promptTemplate + ":" + String(values.text) : String(values.text) };
    if (context.step.id === "combine") return { value: JSON.stringify(externalizeRuntimeValue(resolveWorkflowReference("step.generate.outputs.value", context.inputValues, context.stepValues))) };
    return { value: "independent" };
  } } });
  await h.service.start();
  const definition = { ...workflow([
    { id: "generate", name: "镜头生成", kind: "fake", inputs: [{ key: "text", sourceRef: foreach ? "iteration.item" : "input.text" }], outputs: [{ key: "value", type: "text" }], ...(foreach ? { execution: { mode: "for_each" as const, sourceRef: "input.shots", maxConcurrency: 2 } } : {}) },
    { id: "combine", name: "合成", kind: "fake", inputs: [{ key: "text", sourceRef: "step.generate.outputs.value" }], outputs: [{ key: "value", type: "text" }] },
    { id: "independent", name: "独立分支", kind: "fake", inputs: [], outputs: [{ key: "value", type: "text" }] },
  ]), inputs: [{ key: "text", type: "text" }, { key: "shots", type: "json" }], outputs: [{ key: "result", type: "text", sourceRef: "step.combine.outputs.value" }] };
  const queued = await h.service.submit({ workflow: definition, inputValues: { text: "原文", shots: ["镜头1", "镜头2", "镜头3"] } });
  const original = await h.service.wait(h.settings.projectDirectory, queued.runId); calls.length = 0;
  return { ...h, original, calls };
}
test("完成的运行也可局部重做：只调用依赖步骤，新旧版本独立保存", async (t) => {
  const h = await runSource(t); const before = structuredClone(h.original);
  const changes = { outputOverrides: [{ stepId: "generate", outputs: { value: "人工修订" } }] };
  const preview = await h.service.previewRerun(h.settings.projectDirectory, h.original.runId, changes);
  assert.equal(preview.steps[1].action, "run"); assert.equal(h.calls.length, 0);
  const queued = await h.service.submit({ workflow: h.original.workflow, inputValues: h.original.inputValues, rerunFromRunId: h.original.runId, rerunRequest: changes });
  const revised = await h.service.wait(h.settings.projectDirectory, queued.runId);
  assert.equal(revised.status, "completed"); assert.deepEqual(h.calls.map((call) => call.step), ["combine"]);
  assert.equal(revised.outputs[0].value, '"人工修订"'); assert.equal(revised.rerunFromRunId, h.original.runId);
  assert.deepEqual(await h.service.getRun(h.settings.projectDirectory, h.original.runId), before);
  assert.equal(revised.steps[2].reusedFromRunId, h.original.runId);
});
test("逐项只重做第二镜，保留其余镜头并重算合成；单项参数可再次复用", async (t) => {
  const h = await runSource(t, true);
  const changes = { stepOverrides: [{ stepId: "generate", itemIndex: 1, promptTemplate: "新提示" }] };
  const queued = await h.service.submit({ workflow: h.original.workflow, inputValues: h.original.inputValues, rerunFromRunId: h.original.runId, rerunRequest: changes });
  const result = await h.service.wait(h.settings.projectDirectory, queued.runId);
  assert.equal(result.status, "completed"); assert.deepEqual(h.calls.map((call) => [call.step, call.value]), [["generate", "镜头2"], ["combine", ["镜头1", "新提示:镜头2", "镜头3"]]]);
  assert.deepEqual(result.rerunPlan?.steps[0].reuseItemIndexes, [0, 2]); assert.equal(result.steps[0].items?.[1].stepSnapshot?.promptTemplate, "新提示");
  assert.equal(result.steps[0].items?.[0].reusedFromRunId, h.original.runId);
  h.calls.length = 0;
  const next = await h.service.submit({ workflow: result.workflow, inputValues: result.inputValues, rerunFromRunId: result.runId, rerunRequest: { rerunSteps: [{ stepId: "generate", itemIndexes: [1] }] } });
  assert.equal((await h.service.wait(h.settings.projectDirectory, next.runId)).status, "completed"); assert.equal(h.calls[0].prompt, "新提示");
});
test("替换某一项无需再次生成，聚合顺序保持不变", async (t) => {
  const h = await runSource(t, true);
  const queued = await h.service.submit({ workflow: h.original.workflow, inputValues: h.original.inputValues, rerunFromRunId: h.original.runId, rerunRequest: { outputOverrides: [{ stepId: "generate", itemIndex: 1, outputs: { value: "替换镜头" } }] } });
  const result = await h.service.wait(h.settings.projectDirectory, queued.runId);
  assert.equal(result.status, "completed"); assert.deepEqual(h.calls.map((call) => call.step), ["combine"]);
  assert.deepEqual(result.steps[0].outputs?.value, ["镜头1", "替换镜头", "镜头3"]);
  assert.equal(result.steps[0].items?.[1].replaced, true);
});
test("逐项来源整体修改会使整步重算，不能误复用旧列表项目", async (t) => {
  const h = await runSource(t, true);
  const queued = await h.service.submit({ workflow: h.original.workflow, inputValues: h.original.inputValues, rerunFromRunId: h.original.runId, rerunRequest: { inputOverrides: { shots: ["新镜头", "镜头1"] }, rerunSteps: [{ stepId: "generate", itemIndexes: [1] }] } });
  const result = await h.service.wait(h.settings.projectDirectory, queued.runId);
  assert.equal(result.status, "completed"); assert.deepEqual(h.calls.filter((call) => call.step === "generate").map((call) => call.value), ["新镜头", "镜头1"]);
});


test("拒绝替换未完成逐项步骤和未来步骤引用；配置可真正清空", () => {
  const run = source(); run.workflow.steps[0].execution = { mode: "for_each", sourceRef: "input.text" };
  run.steps[0].status = "failed"; run.steps[0].items = [{ index: 0, value: "a", status: "completed", outputs: { value: "A" } }];
  assert.throws(() => planRerun(run, { outputOverrides: [{ stepId: "a", itemIndex: 0, outputs: { value: "new" } }] }), /尚未完成/);
  const future = source(); future.workflow.steps[0].inputs = [{ key: "text", sourceRef: "step.b.outputs.value" }];
  assert.throws(() => planRerun(future, { rerunSteps: [{ stepId: "a" }] }), /尚未执行/);
  const original = source(); original.workflow.steps[0].capabilityConfig = { optional: "old" };
  assert.deepEqual(planRerun(original, { stepOverrides: [{ stepId: "a", capabilityConfig: {} }] }).workflow.steps[0].capabilityConfig, {});
});

test("局部改单项失败后，断点续跑仍使用该项的修改参数", async (t) => {
  const calls: string[] = []; let fail = false;
  const h = await harness(t, { executor: { kind: "fake", async execute(context) {
    const text = String(context.inputValues["iteration.item"] ?? "");
    if (context.step.promptTemplate === "单项新参数") { calls.push(context.step.promptTemplate); if (fail) throw new Error("模拟失败"); }
    return { value: text };
  } } });
  await h.service.start(); const definition = { ...workflow([{ id: "first", name: "逐项", kind: "fake", inputs: [], outputs: [{ key: "value", type: "text" }], execution: { mode: "for_each" as const, sourceRef: "input.items" } }]), inputs: [{ key: "items", type: "json" }] };
  const initial = await h.service.submit({ workflow: definition, inputValues: { items: ["a", "b"] } }); const original = await h.service.wait(h.settings.projectDirectory, initial.runId);
  fail = true; const queued = await h.service.submit({ workflow: original.workflow, inputValues: original.inputValues, rerunFromRunId: original.runId, rerunRequest: { stepOverrides: [{ stepId: "first", itemIndex: 1, promptTemplate: "单项新参数" }] } });
  const failed = await h.service.wait(h.settings.projectDirectory, queued.runId); assert.equal(failed.status, "failed");
  fail = false; const resumed = await h.service.submit({ workflow: failed.workflow, inputValues: failed.inputValues, resumeFromRunId: failed.runId });
  assert.equal((await h.service.wait(h.settings.projectDirectory, resumed.runId)).status, "completed"); assert.deepEqual(calls, ["单项新参数", "单项新参数"]);
});


test("单项历史参数的额外依赖也使缓存失效，不能仅检查全局步骤", () => {
  const original = source();
  const step = original.workflow.steps[2];
  step.execution = { mode: "for_each", sourceRef: "input.items" };
  original.workflow.inputs.push({ key: "items", type: "json" }); original.inputValues.items = ["x"];
  original.steps[2].items = [{ index: 0, value: "x", status: "completed", outputs: { value: "old" }, stepSnapshot: { ...step, inputs: [{ key: "text", sourceRef: "step.b.outputs.value" }] } }];
  assert.deepEqual(planRerun(original, { rerunSteps: [{ stepId: "a" }] }).plan.steps.map((step) => step.action), ["run", "run", "run"]);
});

test("单项编辑也拒绝未来引用，误写作用范围不会触发全量重做", () => {
  const original = source(); const step = original.workflow.steps[0];
  step.execution = { mode: "for_each", sourceRef: "input.items" };
  original.workflow.inputs.push({ key: "items", type: "json" }); original.inputValues.items = ["x"];
  original.steps[0].items = [{ index: 0, value: "x", status: "completed", outputs: { value: "old" } }];
  assert.throws(() => planRerun(original, { stepOverrides: [{ stepId: "a", itemIndex: 0, inputs: [{ key: "text", sourceRef: "step.b.outputs.value" }] }] }), /尚未执行/);
  assert.throws(() => planRerun(original, { rerunSteps: [{ stepId: "a", itemIndex: 0 }] }), /itemIndexes/);
  assert.throws(() => planRerun(original, { outputOverrides: [{ stepId: "b", outputs: { value: "new" }, typo: true }] }), /不支持的字段/);
});


test("重做上游时保留来源未变的单项参数，列表项变化时不错误套用旧参数", async (t) => {
  const h = await harness(t, { executor: { kind: "fake", async execute(context) {
    return { value: externalizeRuntimeValue(resolveStepInputs(context.step, context.inputValues, context.stepValues).text) };
  } } });
  await h.service.start();
  const definition = workflow([
    { id: "first", name: "上游", kind: "fake", inputs: [{ key: "text", sourceRef: "input.text" }], outputs: [{ key: "value", type: "text" }] },
    { id: "loop", name: "逐项", kind: "fake", inputs: [{ key: "text", sourceRef: "iteration.item" }], outputs: [{ key: "value", type: "text" }], execution: { mode: "for_each", sourceRef: "input.items" } },
  ]);
  definition.inputs = [{ key: "text", type: "text" }, { key: "items", type: "json" }]; definition.outputs[0].type = "json";
  const start = await h.service.submit({ workflow: definition, inputValues: { text: "before", items: ["x", "y"] } });
  const original = await h.service.wait(h.settings.projectDirectory, start.runId);
  const edit = await h.service.submit({ workflow: original.workflow, inputValues: original.inputValues, rerunFromRunId: original.runId, rerunRequest: { stepOverrides: [{ stepId: "loop", itemIndex: 1, inputs: [{ key: "text", sourceRef: "step.first.outputs.value" }] }] } });
  const edited = await h.service.wait(h.settings.projectDirectory, edit.runId);
  assert.deepEqual(edited.outputs[0].value, ["x", "before"]);
  const changeUpstream = await h.service.submit({ workflow: edited.workflow, inputValues: edited.inputValues, rerunFromRunId: edited.runId, rerunRequest: { outputOverrides: [{ stepId: "first", outputs: { value: "after" } }] } });
  const updated = await h.service.wait(h.settings.projectDirectory, changeUpstream.runId);
  assert.deepEqual(updated.outputs[0].value, ["x", "after"]);
  assert.equal(updated.steps[1].items?.[1].stepSnapshot?.inputs?.[0].sourceRef, "step.first.outputs.value");
  const changeItems = await h.service.submit({ workflow: updated.workflow, inputValues: updated.inputValues, rerunFromRunId: updated.runId, rerunRequest: { inputOverrides: { items: ["new-x", "new-y"] } } });
  const changed = await h.service.wait(h.settings.projectDirectory, changeItems.runId);
  assert.deepEqual(changed.outputs[0].value, ["new-x", "new-y"]);
  assert.equal(changed.steps[1].items?.[1].stepSnapshot, undefined); // Uses the global iteration.item mapping, not the former single-item override.
});
