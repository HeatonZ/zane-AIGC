import assert from "node:assert/strict";
import test from "node:test";
import type { RunRecord } from "./types.js";
import { captureStepFeedback, feedbackForStep, validateStepFeedback } from "./stepFeedback.js";
import { feedbackMessageMaxLength } from "./feedbackContracts.js";
import { workflow, id } from "../testing/testSupport.js";

function source(iterative = false): RunRecord {
  const definition = workflow([{ id: "writer", name: "编剧", kind: "hermes", promptTemplate: "写故事", hermesProfile: "default", inputs: [], outputs: [{ key: "value", type: "text" }], ...(iterative ? { execution: { mode: "for_each" as const, sourceRef: "input.items" } } : {}) }]);
  return { runId: id("feedback-source"), sceneId: "test-scene", workflowName: "反馈测试", createdAt: "2026-10-02T00:00:00Z", startedAt: "2026-10-02T00:00:00Z", status: "completed", inputValues: {}, workflow: definition, steps: [{ stepId: "writer", name: "编剧", status: "completed", outputs: { value: iterative ? ["甲的旧结果", "乙的旧结果"] : "旧结果" }, ...(iterative ? { items: [{ index: 0, value: "甲", status: "completed" as const, outputs: { value: "甲的旧结果" } }, { index: 1, value: "乙", status: "completed" as const, outputs: { value: "乙的旧结果" } }] } : {}) }], outputs: [], artifacts: { directory: "", inputs: "", workflow: "", runtime: "", output: "" } };
}

test("反馈验证限定 Hermes 已完成结果、合法范围和非空长度；不接受伪造原结果", () => {
  const run = source();
  assert.deepEqual(validateStepFeedback(run, { stepId: "writer", message: "  开头不够抓人  " }), { stepId: "writer", message: "开头不够抓人" });
  for (const raw of [null, { stepId: "missing", message: "意见" }, { stepId: "writer", message: " " }, { stepId: "writer", message: 123 }, { stepId: "writer", message: "字".repeat(feedbackMessageMaxLength + 1) }, { stepId: "writer", itemIndex: 0, message: "意见" }, { stepId: "writer", message: "意见", originalOutputs: { value: "伪造" } }]) assert.throws(() => validateStepFeedback(run, raw));
  run.workflow.steps[0].kind = "comfyui";
  assert.throws(() => validateStepFeedback(run, { stepId: "writer", message: "意见" }), /Hermes/);
  run.workflow.steps[0].kind = "hermes"; run.steps[0].status = "failed";
  assert.throws(() => validateStepFeedback(run, { stepId: "writer", message: "意见" }), /已完成/);
  const batch = source(true); batch.steps[0].status = "failed"; batch.steps[0].items![1].status = "failed";
  assert.doesNotThrow(() => validateStepFeedback(batch, { stepId: "writer", message: "整步反馈" }));
  for (const itemIndex of [-1, 0.5, "0", 1, 2]) assert.throws(() => validateStepFeedback(batch, { stepId: "writer", itemIndex, message: "单项反馈" }));
});

test("反馈快照独立于原记录，累积意见只使用最近的原结果", () => {
  const run = source(); const before = structuredClone(run);
  const first = captureStepFeedback(run, { stepId: "writer", message: "缩短铺垫" }, "2026-10-02T01:00:00Z");
  assert.deepEqual(run, before); assert.equal(first.sourceRunId, run.runId);
  run.steps[0].outputs!.value = "改过一次";
  const second = captureStepFeedback(run, { stepId: "writer", message: "增加冲突" }, "2026-10-02T02:00:00Z");
  assert.deepEqual(first.originalOutputs, { value: "旧结果" });
  const context = feedbackForStep([first, second], "writer")!;
  assert.deepEqual(context.notes.map(note => note.message), ["缩短铺垫", "增加冲突"]);
  assert.deepEqual(context.originalOutputs, { value: "改过一次" });
  context.originalOutputs!.value = "修改上下文不会污染历史";
  assert.equal(second.originalOutputs.value, "改过一次");
  assert.equal(feedbackForStep([first], "other"), undefined);
});

test("整批意见携带各项原结果，单项意见不会污染别的项或改变后的来源", () => {
  const run = source(true);
  const all = captureStepFeedback(run, { stepId: "writer", message: "都要加强开头" }, "2026-10-02T01:00:00Z");
  const one = captureStepFeedback(run, { stepId: "writer", itemIndex: 1, message: "只给乙增加转折" }, "2026-10-02T02:00:00Z");
  assert.deepEqual(one.originalOutputs, { value: "乙的旧结果" });
  assert.deepEqual(feedbackForStep([all, one], "writer", 0, "甲")?.originalOutputs, { value: "甲的旧结果" });
  assert.deepEqual(feedbackForStep([all, one], "writer", 1, "乙")?.notes.map(note => note.message), ["都要加强开头", "只给乙增加转折"]);
  const changed = feedbackForStep([all, one], "writer", 1, "丙")!;
  assert.deepEqual(changed.notes.map(note => note.message), ["都要加强开头"]);
  assert.equal(changed.originalOutputs, undefined);
  assert.equal(feedbackForStep([one], "writer", 0, "甲"), undefined);
});
