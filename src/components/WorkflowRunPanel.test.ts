import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import WorkflowRunPanel from "./WorkflowRunPanel";
import ReviewPanel from "./ReviewPanel";
import type { WorkflowRunRecord } from "../types";

function run(): WorkflowRunRecord {
  return { runId: "source", sceneId: "demo", workflowName: "反馈测试", status: "completed", inputValues: {}, outputs: [], workflow: { sceneId: "demo", name: "测试", inputs: [], outputs: [], steps: [{ id: "writer", name: "编剧", kind: "hermes", hermesProfile: "default", promptTemplate: "原任务", inputs: [], outputs: [{ key: "text", label: "故事", type: "text" }] }] }, steps: [{ stepId: "writer", name: "编剧", status: "completed", outputs: { text: "原故事" }, outputTypes: { text: "text" } }] };
}

test("运行记录和创作结果都有反馈入口，反馈历史展示原因与来源版本", () => {
  const source = run();
  source.feedbackHistory = [{ id: "feedback-1", stepId: "writer", sourceRunId: "original-run", createdAt: "2026-10-02T01:00:00Z", message: "开头缺少冲突", originalOutputs: { text: "原故事" } }];
  const records = renderToStaticMarkup(createElement(WorkflowRunPanel, { result: source, onRerunStep: () => {} }));
  assert.match(records, /反馈并重做/); assert.match(records, /Hermes 反馈历史/); assert.match(records, /开头缺少冲突/); assert.match(records, /来源版本 original/);
  const studioResult = { ...source, workflow: undefined };
  const studio = renderToStaticMarkup(createElement(WorkflowRunPanel, { result: studioResult, workflow: source.workflow, onFeedbackStep: () => {} }));
  assert.match(studio, /反馈并重做/);
  const batch = run(); batch.steps[0].items = [{ index: 0, value: "甲", status: "completed", outputs: { text: "甲" } }, { index: 1, value: "乙", status: "failed" }];
  const items = renderToStaticMarkup(createElement(WorkflowRunPanel, { result: batch, onRerunStep: () => {} }));
  assert.match(items, /反馈并重做第 1 项/); assert.doesNotMatch(items, /反馈并重做第 2 项/);
});

test("运行中或待确认时不能从结果面板绕过关卡反馈重做，非Hermes不显示入口", () => {
  const source = run();
  for (const status of ["running", "queued", "cancelling", "waiting"] as const) {
    const html = renderToStaticMarkup(createElement(WorkflowRunPanel, { result: { ...source, status }, onFeedbackStep: () => {} }));
    assert.doesNotMatch(html, /反馈并重做/);
  }
  source.workflow!.steps[0].kind = "manual";
  assert.doesNotMatch(renderToStaticMarkup(createElement(WorkflowRunPanel, { result: source, onRerunStep: () => {} })), /反馈并重做/);
});

test("Hermes 人工确认关卡有退回反馈输入框，非Hermes关卡不展示", () => {
  const source = run(); source.status = "waiting"; source.pendingReview = { id: "review", stepId: "writer", name: "编剧", createdAt: "now" };
  assert.match(renderToStaticMarkup(createElement(ReviewPanel, { run: source, onSubmitted: () => {} })), /退回重做的反馈意见/);
  source.workflow!.steps[0].kind = "manual";
  assert.doesNotMatch(renderToStaticMarkup(createElement(ReviewPanel, { run: source, onSubmitted: () => {} })), /退回重做的反馈意见/);
});

test("步骤和逐项提示词警告用⚠展示，不改变已完成状态", () => {
  const source = run();
  source.steps[0].warnings = ["建议六段标题，仅提示，不阻止生成"];
  source.steps[0].items = [{ index: 0, value: "镜头", status: "completed", outputs: { text: "镜头输出" }, warnings: ["详细描述标题缺失"] }];
  const html = renderToStaticMarkup(createElement(WorkflowRunPanel, { result: source }));
  assert.match(html, /⚠/);
  assert.match(html, /建议六段标题，仅提示，不阻止生成/);
  assert.match(html, /详细描述标题缺失/);
  assert.match(html, /role="note"/);
  assert.match(html, /workflow-run-step-status completed">完成/);
  assert.equal(source.status, "completed");
  assert.equal(source.steps[0].items[0].status, "completed");
});
