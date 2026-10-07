import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import SystemFeedback from "./SystemFeedback";
import UserRunDetail from "../components/UserRunDetail";
import { businessRun } from "../../server/services/runDetailService";
import type { RunRecord } from "../../server/domain/types";

test("系统反馈独立入口：用户只有提交/本人反馈，管理员是处理列表，不是Agent修订", () => {
  const user = renderToStaticMarkup(createElement(SystemFeedback, { userId: "user" }));
  assert.match(user, /提交给管理员/); assert.match(user, /我的反馈/); assert.match(user, /不直接作为 Agent 修订意见/);
  const admin = renderToStaticMarkup(createElement(SystemFeedback, { userId: "admin", admin: true }));
  assert.match(admin, /集中处理用户问题与建议/); assert.match(admin, /反馈列表/); assert.doesNotMatch(admin, /提交给管理员/);
});
test("普通用户审核不渲染Agent反馈输入，仍有确认和无意见退回按钮", () => {
  const record = { runId: "run", sceneId: "demo", workflowName: "测试", status: "waiting", createdAt: "2026-10-05", inputValues: {}, outputs: [], steps: [], workflow: { sceneId: "demo", name: "测试", inputs: [], outputs: [], steps: [] }, pendingReview: { id: "review", stepId: "writer", name: "审核", createdAt: "2026-10-05" } } as unknown as RunRecord;
  const markup = renderToStaticMarkup(createElement(UserRunDetail, { run: businessRun(record), userId: "user", busy: false, submissionPending: false, onRefresh: async () => {}, onCancel() {}, onResume() {}, onReview() {} }));
  assert.match(markup, /确认并继续/); assert.match(markup, /退回重做/); assert.doesNotMatch(markup, /退回意见|textarea|反馈并重做/);
});
