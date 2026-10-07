import assert from "node:assert/strict";
import test from "node:test";
import { formatRunSubmitter, getRunDisplayTitle } from "./WorkflowRuns";

test("运行记录优先显示业务场景名，不透出不匹配的内部流程名", () => {
  assert.equal(getRunDisplayTitle("AI参考生视频", undefined), "AI参考生视频");
  assert.equal(getRunDisplayTitle("AI参考生视频", "  "), "AI参考生视频");
});

test("运行记录仍保留用户自定义任务标题", () => {
  assert.equal(getRunDisplayTitle("AI参考生视频", "咖啡杯镜头测试"), "咖啡杯镜头测试");
});


test("管理员运行记录优先显示用户名，缺少用户名时不暴露用户ID", () => {
  assert.equal(formatRunSubmitter({ userId: "user-1", username: "alice", displayName: "Alice" }), "Alice（alice）");
  assert.equal(formatRunSubmitter({ userId: "user-1", username: "alice", displayName: "alice" }), "alice");
  assert.equal(formatRunSubmitter({ userId: "user-1", username: "  ", displayName: "Alice" }), "用户名未记录");
  assert.equal(formatRunSubmitter({ userId: "user-1", username: "", displayName: "" }), "用户名未记录");
  assert.equal(formatRunSubmitter(undefined), "用户名未记录");
});
