import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { readFile, writeFile } from "node:fs/promises";
import { SqliteStore } from "../storage/sqliteStore.js";
import { RunService } from "./runService.js";
import { planRerun } from "./rerunPlanner.js";
import { feedbackForStep } from "../domain/stepFeedback.js";
import type { HermesFeedbackContext } from "../domain/feedbackContracts.js";
import { externalizeRuntimeValue, resolveStepInputs } from "../domain/workflowValues.js";
import { deferred, harness, id, submission, workflow } from "../testing/testSupport.js";

async function setup(t: Parameters<typeof harness>[0], iterative = false, review = false) {
  const calls: Array<{ stepId: string; value?: unknown; feedback?: HermesFeedbackContext }> = [];
  const h = await harness(t, { executor: { kind: "fake", async execute(context) {
    calls.push({ stepId: context.step.id });
    const values = resolveStepInputs(context.step, context.inputValues, context.stepValues);
    return { value: values.value === undefined ? "前序" : String(externalizeRuntimeValue(values.value)) };
  } } });
  h.executors.register({ kind: "hermes", async execute(context) {
    const value = externalizeRuntimeValue(context.inputValues["iteration.item"] ?? null);
    calls.push({ stepId: context.step.id, value, feedback: structuredClone(context.feedback) });
    return { value: context.feedback ? "修订:" + context.feedback.notes.map(note => note.message).join(";") : "旧结果:" + String(value) };
  } });
  await h.service.start();
  const definition = workflow([
    { id: "prefix", name: "前序", kind: "fake", inputs: [], outputs: [{ key: "value", type: "text" }] },
    { id: "writer", name: "Hermes编剧", kind: "hermes", hermesProfile: "default", promptTemplate: "原任务", inputs: [], outputs: [{ key: "value", type: "text" }], ...(iterative ? { execution: { mode: "for_each" as const, sourceRef: "input.items", maxConcurrency: 2 } } : {}), ...(review ? { review: { enabled: true } } : {}) },
    { id: "tail", name: "依赖下游", kind: "fake", inputs: [{ key: "value", sourceRef: "step.writer.outputs.value" }], outputs: [{ key: "value", type: "text" }] },
    { id: "independent", name: "独立分支", kind: "hermes", hermesProfile: "default", promptTemplate: "独立任务", inputs: [], outputs: [{ key: "value", type: "text" }] },
  ]);
  if (iterative) definition.inputs = [{ key: "items", type: "json", required: true }];
  const accepted = await h.service.submit(submission(id("feedback-original-" + iterative + "-" + review), definition, iterative ? { items: ["甲", "乙"] } : {}));
  const original = await h.service.wait(h.settings.projectDirectory, accepted.runId);
  calls.length = 0;
  return { ...h, calls, definition, original };
}

test("反馈预览纯读；重做绑定原结果并持久化历史、累积修订、保留独立步骤与原配置", async t => {
  const h = await setup(t); const before = structuredClone(h.original);
  const changes = { feedback: [{ stepId: "writer", message: "  缩短开头  " }] };
  const plan = await h.service.previewRerun(h.settings.projectDirectory, h.original.runId, changes);
  assert.deepEqual(plan.steps.map(step => step.action), ["reuse", "run", "run", "reuse"]);
  assert.match(plan.steps[1].reason, /反馈/); assert.equal(h.calls.length, 0);
  assert.deepEqual(h.store.getRun(h.settings.projectDirectory, h.original.runId), before);
  const accepted = await h.service.submit({ ...submission(id("feedback-revision"), h.definition), rerunFromRunId: h.original.runId, rerunRequest: changes });
  const revised = await h.service.wait(h.settings.projectDirectory, accepted.runId);
  assert.equal(revised.status, "completed"); assert.deepEqual(h.calls.map(call => call.stepId), ["writer", "tail"]);
  assert.deepEqual(h.calls[0].feedback?.originalOutputs, before.steps[1].outputs);
  assert.deepEqual(h.calls[0].feedback?.notes.map(note => note.message), ["缩短开头"]);
  assert.equal(revised.workflow.steps[1].promptTemplate, "原任务");
  assert.equal(revised.feedbackHistory?.[0].sourceRunId, h.original.runId);
  assert.equal(revised.feedbackHistory?.[0].message, "缩短开头");
  assert.deepEqual(JSON.parse(await readFile(revised.artifacts.output, "utf8")).feedbackHistory, revised.feedbackHistory);
  assert.deepEqual(h.store.getRun(h.settings.projectDirectory, h.original.runId), before);
  const second = await h.service.submit({ ...submission(id("feedback-revision-two"), revised.workflow), rerunFromRunId: revised.runId, rerunRequest: { feedback: [{ stepId: "writer", message: "增加反转" }] } });
  const latest = await h.service.wait(h.settings.projectDirectory, second.runId);
  assert.equal(latest.feedbackHistory?.length, 2);
  const context = feedbackForStep(latest.feedbackHistory!, "writer")!;
  assert.deepEqual(context.notes.map(note => note.message), ["缩短开头", "增加反转"]);
  assert.deepEqual(context.originalOutputs, revised.steps[1].outputs);
});

test("单项反馈只修订目标，整批反馈给每项自己的原结果，反馈历史随排队重启恢复", async t => {
  const h = await setup(t, true);
  const accepted = await h.service.submit({ ...submission(id("feedback-item"), h.definition), rerunFromRunId: h.original.runId, rerunRequest: { feedback: [{ stepId: "writer", itemIndex: 1, message: "乙要更有冲突" }] } });
  const revised = await h.service.wait(h.settings.projectDirectory, accepted.runId);
  assert.deepEqual(h.calls.map(call => call.stepId), ["writer", "tail"]);
  assert.equal(h.calls[0].value, "乙"); assert.deepEqual(h.calls[0].feedback?.originalOutputs, { value: "旧结果:乙" });
  assert.equal(revised.steps[1].items?.[0].reusedFromRunId, h.original.runId);
  assert.deepEqual(revised.rerunPlan?.steps[1].runItemIndexes, [1]);
  h.calls.length = 0;
  await h.service.shutdown();
  // Submit against an unstarted service so the durable queued snapshot is tested.
  const queuedService = new RunService({ store: h.store, executors: h.executors, loadSettings: async () => h.settings });
  const all = await queuedService.submit({ ...submission(id("feedback-batch"), revised.workflow), inputValues: revised.inputValues, rerunFromRunId: revised.runId, rerunRequest: { feedback: [{ stepId: "writer", message: "都要删掉套话" }] } });
  await queuedService.shutdown();
  const recoveredStore = new SqliteStore(h.store.filename);
  const recovered = new RunService({ store: recoveredStore, executors: h.executors, loadSettings: async () => h.settings });
  try {
  await recovered.start();
  const result = await recovered.wait(h.settings.projectDirectory, all.runId);
  assert.equal(result.status, "completed"); assert.equal(result.feedbackHistory?.length, 2);
  const writers = h.calls.filter(call => call.stepId === "writer");
  assert.equal(writers.length, 2);
  assert.deepEqual(writers.find(call => call.value === "甲")?.feedback?.notes.map(note => note.message), ["都要删掉套话"]);
  assert.deepEqual(writers.find(call => call.value === "甲")?.feedback?.originalOutputs, { value: "旧结果:甲" });
  assert.deepEqual(writers.find(call => call.value === "乙")?.feedback?.notes.map(note => note.message), ["乙要更有冲突", "都要删掉套话"]);
  assert.deepEqual(writers.find(call => call.value === "乙")?.feedback?.originalOutputs, revised.steps[1].items?.[1].outputs);
  } finally { await recovered.shutdown(); recoveredStore.close(); }
});

test("人工关卡退回反馈保留前序、原结果和决定关联，拒绝重复或非法反馈", async t => {
  const h = await setup(t, false, true); const first = h.original;
  assert.equal(first.status, "waiting");
  await assert.rejects(h.service.review(h.settings.projectDirectory, first.runId, { reviewId: first.pendingReview!.id, action: "approve", feedback: "意见" }), /仅用于退回/);
  await assert.rejects(h.service.review(h.settings.projectDirectory, first.runId, { reviewId: first.pendingReview!.id, action: "redo", feedback: " " }), /填写反馈/);
  assert.equal(h.store.getRun(h.settings.projectDirectory, first.runId)?.feedbackHistory, undefined);
  await h.service.review(h.settings.projectDirectory, first.runId, { reviewId: first.pendingReview!.id, action: "redo", feedback: "主角动机不清晰" });
  const waiting = await h.service.wait(h.settings.projectDirectory, first.runId);
  assert.equal(waiting.status, "waiting"); assert.notEqual(waiting.pendingReview!.id, first.pendingReview!.id);
  assert.deepEqual(h.calls.map(call => call.stepId), ["writer"]);
  assert.deepEqual(h.calls[0].feedback?.originalOutputs, first.steps[1].outputs);
  assert.equal(waiting.reviewHistory?.[0].feedback, "主角动机不清晰");
  assert.equal(waiting.reviewHistory?.[0].feedbackId, waiting.feedbackHistory?.[0].id);
  await assert.rejects(h.service.review(h.settings.projectDirectory, first.runId, { reviewId: first.pendingReview!.id, action: "redo", feedback: "重复" }), /状态已变化/);
  await h.service.review(h.settings.projectDirectory, first.runId, { reviewId: waiting.pendingReview!.id, action: "approve" });
  const done = await h.service.wait(h.settings.projectDirectory, first.runId);
  assert.equal(done.status, "completed"); assert.equal(done.feedbackHistory?.length, 1);
  assert.equal(h.calls.find(call => call.stepId === "independent")?.feedback, undefined);
});

test("非法反馈、重复或冲突范围以及变动上游的单项反馈均不可规划", async t => {
  const h = await setup(t, true); const source = h.original;
  for (const changes of [
    { feedback: [{ stepId: "prefix", message: "非Hermes" }] },
    { feedback: [{ stepId: "writer", itemIndex: 9, message: "不存在" }] },
    { feedback: [{ stepId: "writer", message: "一" }, { stepId: "writer", message: "二" }] },
    { feedback: [{ stepId: "writer", message: "全部" }, { stepId: "writer", itemIndex: 1, message: "单项" }] },
    { feedback: [{ stepId: "writer", itemIndex: 1, message: "意见" }], outputOverrides: [{ stepId: "writer", itemIndex: 1, outputs: { value: "替换" } }] },
    { inputOverrides: { items: ["新的甲", "新的乙"] }, feedback: [{ stepId: "writer", itemIndex: 1, message: "意见" }] },
  ]) assert.throws(() => planRerun(source, changes));
  assert.equal(h.calls.length, 0);
});

test("反馈生成失败后的断点续跑仍收到反馈，不污染场景模板", async t => {
  const gate = deferred<void>(); let fail = true;
  const received: Array<HermesFeedbackContext | undefined> = [];
  const h = await harness(t, { executor: { kind: "hermes", async execute(context) {
    received.push(structuredClone(context.feedback));
    if (context.feedback && fail) { await gate.promise; throw new Error("暂时失败"); }
    return { value: context.feedback ? "修改完成" : "原结果" };
  } } });
  await h.service.start();
  const definition = workflow([{ id: "writer", name: "Hermes", kind: "hermes", promptTemplate: "原模板", hermesProfile: "default", inputs: [], outputs: [{ key: "value", type: "text" }] }]);
  const first = await h.service.submit(submission(id("feedback-resume-source"), definition)); await h.service.wait(h.settings.projectDirectory, first.runId);
  const revision = await h.service.submit({ ...submission(id("feedback-resume-failed"), definition), rerunFromRunId: first.runId, rerunRequest: { feedback: [{ stepId: "writer", message: "修正结尾" }] } });
  gate.resolve(); const failed = await h.service.wait(h.settings.projectDirectory, revision.runId); assert.equal(failed.status, "failed");
  fail = false;
  const accepted = await h.service.submit({ ...submission(id("feedback-resumed"), definition), resumeFromRunId: failed.runId });
  const resumed = await h.service.wait(h.settings.projectDirectory, accepted.runId);
  assert.equal(resumed.status, "completed"); assert.equal(resumed.feedbackHistory?.length, 1);
  assert.deepEqual(received[2], received[1]); assert.equal(resumed.workflow.steps[0].promptTemplate, "原模板");
});

test("媒体逐项反馈不因新版本归档路径变化而丢失，重新选择不同来源不会误用旧意见", async t => {
  const received: Array<{ value: unknown; feedback?: HermesFeedbackContext }> = [];
  const h = await harness(t, { executor: { kind: "hermes", async execute(context) {
    received.push({ value: externalizeRuntimeValue(context.inputValues["iteration.item"]), feedback: structuredClone(context.feedback) });
    return { value: context.feedback ? "反馈修订完成" : "图片原描述" };
  } } });
  await h.service.start();
  const image = path.join(h.root, "image.png"); await writeFile(image, "fake image bytes");
  const definition = workflow([{ id: "writer", name: "图片分析", kind: "hermes", promptTemplate: "描述图片", hermesProfile: "default", execution: { mode: "for_each", sourceRef: "input.images" }, inputs: [{ key: "image", sourceRef: "iteration.item" }], outputs: [{ key: "value", type: "text" }] }]);
  definition.inputs = [{ key: "images", type: "image_list", required: true }];
  const source = await h.service.submit(submission(id("media-feedback-source"), definition, { images: [image] }));
  const original = await h.service.wait(h.settings.projectDirectory, source.runId);
  const revision = await h.service.submit({ ...submission(id("media-feedback-revision"), definition), rerunFromRunId: original.runId, rerunRequest: { feedback: [{ stepId: "writer", itemIndex: 0, message: "重点描述服装" }] } });
  const revised = await h.service.wait(h.settings.projectDirectory, revision.runId);
  assert.equal(revised.status, "completed"); assert.notDeepEqual(received[1].value, received[0].value);
  assert.deepEqual(received[1].feedback?.notes.map(note => note.message), ["重点描述服装"]);
  assert.deepEqual(received[1].feedback?.originalOutputs, { value: "图片原描述" });
  const copy = await h.service.submit({ ...submission(id("media-feedback-copy"), definition), rerunFromRunId: revised.runId, rerunRequest: { rerunSteps: [{ stepId: "writer" }] } });
  const copied = await h.service.wait(h.settings.projectDirectory, copy.runId);
  assert.equal(copied.status, "completed"); assert.deepEqual(received[2].feedback?.notes.map(note => note.message), ["重点描述服装"]);
  await writeFile(image, "different image at same user path");
  const changed = await h.service.submit({ ...submission(id("media-feedback-changed"), definition), rerunFromRunId: copied.runId, rerunRequest: { inputOverrides: { images: [image] } } });
  assert.equal((await h.service.wait(h.settings.projectDirectory, changed.runId)).status, "completed");
  assert.equal(received[3].feedback, undefined);
});
