import assert from "node:assert/strict";
import test from "node:test";
import { buildRerunChanges, editableStep, parseOutputDraft } from "./rerunEditing";
import type { WorkflowRunRecord } from "../types";
function source(): WorkflowRunRecord {
  return { runId: "source", sceneId: "demo", workflowName: "测试", status: "completed", inputValues: {}, outputs: [], workflow: { sceneId: "demo", name: "测试", inputs: [], outputs: [], steps: [{ id: "generate", name: "生成", kind: "hermes", hermesProfile: "test", inputs: [], outputs: [{ key: "text", label: "文本", type: "text" }], promptTemplate: "原提示", execution: { mode: "for_each", sourceRef: "input.shots" } }] }, steps: [{ stepId: "generate", name: "生成", status: "completed", outputs: { text: ["A", "B"] }, items: [{ index: 0, value: "a", status: "completed", outputs: { text: "A" } }, { index: 1, value: "b", status: "completed", outputs: { text: "B" } }] }] };
}
test("没有参数变化时只提交选定逐项，参数变化不会污染原始配置", () => {
  const run = source(); const current = editableStep(run, "generate", 1);
  assert.deepEqual(buildRerunChanges(run, "generate", 1, "rerun", current, {}), { rerunSteps: [{ stepId: "generate", itemIndexes: [1] }] });
  current.promptTemplate = "新提示";
  assert.deepEqual(buildRerunChanges(run, "generate", 1, "rerun", current, {}), { stepOverrides: [{ stepId: "generate", itemIndex: 1, promptTemplate: "新提示" }] });
  assert.equal(run.workflow!.steps[0].promptTemplate, "原提示");
});
test("替换结果仅提交变化的值，逐项替换必须明确指定项目", () => {
  const run = source(); const current = editableStep(run, "generate", 1);
  assert.deepEqual(buildRerunChanges(run, "generate", 1, "replace", current, { text: "改好的B" }), { outputOverrides: [{ stepId: "generate", itemIndex: 1, outputs: { text: "改好的B" } }] });
  assert.throws(() => buildRerunChanges(run, "generate", undefined, "replace", current, { text: "new" }), /具体的一项/);
  assert.throws(() => buildRerunChanges(run, "generate", 1, "replace", current, { text: "B" }), /尚未修改/);
  assert.equal(parseOutputDraft("boolean", "false"), false);
  assert.deepEqual(parseOutputDraft("image_list", '["F:/image.png"]'), ["F:/image.png"]);
  assert.throws(() => parseOutputDraft("json", "broken"), /JSON/);
});
test("再次编辑会读取该项已保存的参数快照，而不是原始全局提示词", () => {
  const run = source(); run.steps[0].items![1].stepSnapshot = { ...run.workflow!.steps[0], promptTemplate: "单项提示" };
  assert.equal(editableStep(run, "generate", 1).promptTemplate, "单项提示");
  assert.equal(editableStep(run, "generate").promptTemplate, "原提示");
});

test("反馈模式单独提交范围和意见，不把意见写入模板；空反馈和非Hermes结果被拒绝", () => {
  const run = source(); const current = editableStep(run, "generate", 1);
  current.promptTemplate = "不应提交的参数修改";
  assert.deepEqual(buildRerunChanges(run, "generate", 1, "feedback", current, {}, "  开头缺少冲突  "), { feedback: [{ stepId: "generate", itemIndex: 1, message: "开头缺少冲突" }] });
  assert.deepEqual(buildRerunChanges(run, "generate", undefined, "feedback", current, {}, "整批要更紧凑"), { feedback: [{ stepId: "generate", message: "整批要更紧凑" }] });
  assert.equal(run.workflow!.steps[0].promptTemplate, "原提示");
  assert.throws(() => buildRerunChanges(run, "generate", 1, "feedback", current, {}, "  "), /填写反馈/);
  run.status = "waiting";
  assert.throws(() => buildRerunChanges(run, "generate", 1, "feedback", current, {}, "意见"), /已完成结果/);
  run.status = "completed"; run.workflow!.steps[0].kind = "manual";
  assert.throws(() => buildRerunChanges(run, "generate", 1, "feedback", current, {}, "意见"), /Hermes/);
});
