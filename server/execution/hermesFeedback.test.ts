import assert from "node:assert/strict";
import test from "node:test";
import { appendHermesFeedback } from "./hermesFeedback.js";

test("普通 Hermes 调用不改提示词；反馈调用包含问题、原结果和完整输出要求", () => {
  const prompt = "原任务\n步骤输入：商品故事";
  assert.equal(appendHermesFeedback(prompt), prompt);
  assert.equal(appendHermesFeedback(prompt, { notes: [] }), prompt);
  const result = appendHermesFeedback(prompt, { notes: [{ message: "删除空泛描写，保留 {{input.name}} 字面文本", sourceRunId: "source", createdAt: "now" }], originalOutputs: { script: "太长的开头", shots: [{ index: 0 }], approved: false } });
  assert.ok(result.startsWith(prompt));
  assert.match(result, /删除空泛描写/); assert.match(result, /太长的开头/);
  assert.match(result, /\{\{input.name\}\}/); assert.match(result, /"approved": false/);
  assert.match(result, /完整步骤输出/); assert.match(result, /字段与类型/);
});
