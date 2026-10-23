import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import type { TestContext } from "node:test";
import { harness, id } from "../testing/testSupport.js";
import { StepFeedbackService, type StepAgentFeedbackExecution, type StepAgentFeedbackRunner } from "./stepFeedbackService.js";
import { stepAgentFeedbackResult } from "../domain/stepAgentFeedback.js";
import { HttpError } from "../errors.js";
import type { Identity } from "./accessService.js";
import type { JsonValue, RunRecord, RunWorkflowDefinition } from "../domain/types.js";

const admin: Identity = { id: "test-admin", revision: 1, username: "test-admin", displayName: "测试管理员", role: "admin", enabled: true, sceneIds: [], createdAt: "2026-10-17T00:00:00.000Z", updatedAt: "2026-10-17T00:00:00.000Z" };
const code = (error: unknown) => (error as HttpError).code;

function workflow(iterative = false): RunWorkflowDefinition {
  return {
    sceneId: "test-scene", name: "反馈测试", inputs: [
      { key: "brief", type: "text", required: true },
      { key: "refs", type: "image_list", required: false },
      ...(iterative ? [{ key: "items", type: "json" as const, required: true }] : []),
    ], outputs: [],
    steps: [
      { id: "writer", name: "编剧", kind: "hermes", hermesProfile: "default", hermesProvider: "custom:chat", hermesModel: "gpt-x", inputs: [{ key: "brief", sourceRef: "input.brief" }], outputs: [{ key: "storyboard", type: "json" }] },
      ...(iterative ? [{ id: "shot", name: "逐镜", kind: "hermes" as const, hermesProfile: "default", inputs: [{ key: "item", sourceRef: "iteration.item" }], outputs: [{ key: "text", type: "text" as const }], execution: { mode: "for_each" as const, sourceRef: "input.items" } }] : []),
    ],
  };
}

function fixtureRun(iterative = false): RunRecord {
  return {
    runId: id(iterative ? "feedback-service-run-items" : "feedback-service-run"), sceneId: "test-scene", workflowName: "反馈测试", status: "completed",
    createdAt: "2026-10-17T00:00:00.000Z", startedAt: "2026-10-17T00:00:00.000Z", finishedAt: "2026-10-17T00:05:00.000Z",
    workflow: workflow(iterative),
    inputValues: {
      brief: "三镜短片",
      refs: [{ assetId: "asset-1", assetVersion: 1, path: path.join("F:", "runs", "feedback", "inputs", "files", "ref-0.png") }],
      ...(iterative ? { items: ["甲", "乙"] } : {}),
    },
    steps: [
      { stepId: "writer", name: "编剧", status: "completed", agentPrompt: "ORIGINAL-PROMPT", outputs: { storyboard: { shots: 3 } }, outputTypes: { storyboard: "json" } },
      ...(iterative ? [{
        stepId: "shot", name: "逐镜", status: "completed" as const, outputs: { text: ["甲稿", "乙稿"] } as Record<string, JsonValue>,
        items: [
          { index: 0, value: "甲" as JsonValue, status: "completed" as const, outputs: { text: "甲稿" } as Record<string, JsonValue> },
          { index: 1, value: "乙" as JsonValue, status: "completed" as const, outputs: { text: "乙稿" } as Record<string, JsonValue> },
        ],
      }] : []),
    ],
    outputs: [], artifacts: { directory: path.join("F:", "runs", "feedback"), inputs: "", workflow: "", runtime: "", output: "" },
  };
}

const storyboardRunner: StepAgentFeedbackRunner = {
  runStepFeedback: async () => ({ raw: '{"storyboard":{"shots":4}}', outputs: { storyboard: { shots: 4 } } }),
};

async function serviceWith(t: TestContext, run: RunRecord, runner: StepAgentFeedbackRunner = storyboardRunner, calls: StepAgentFeedbackExecution[] = []) {
  const h = await harness(t);
  h.store.importRun(h.settings.projectDirectory, run);
  const service = new StepFeedbackService({
    loadSettings: async () => h.settings,
    getRun: async (project, runId) => h.store.getRun(project, runId),
    runner: {
      runStepFeedback: async execution => { calls.push(execution); return runner.runStepFeedback(execution); },
    },
  });
  return { ...h, service, calls };
}

test("步骤级反馈：反馈与上下文交给同一个 Agent，返回修订结果且运行记录逐字节不变", async t => {
  const run = fixtureRun();
  const { service, calls, store, settings } = await serviceWith(t, run);
  const before = structuredClone(store.getRun(settings.projectDirectory, run.runId)!);

  const result = stepAgentFeedbackResult.parse(await service.requestStepAgentFeedback(admin, {
    runId: run.runId, stepId: "writer", message: "第二镜节奏太慢",
    context: { observation: "前 3 秒没有动作", expectation: "第 1 秒进冲突" },
  }));
  assert.equal(result.stepId, "writer");
  assert.equal(result.replyParsed, true);
  assert.deepEqual(result.outputs, { storyboard: { shots: 4 } });
  assert.deepEqual(result.originalOutputs, { storyboard: { shots: 3 } }, "原结果由服务端从运行快照捕获，调用方不能伪造");  assert.equal(result.agentPromptOmitted, true);
  assert.match(result.context.feedback, /第二镜节奏太慢/);
  assert.match(result.context.feedback, /观察到的问题：前 3 秒没有动作/);
  assert.ok(!JSON.stringify(result).includes("ORIGINAL-PROMPT"), "响应不得回传完整提示词");

  assert.equal(calls.length, 1);
  const execution = calls[0]!;
  assert.equal(execution.step.id, "writer");
  assert.equal(execution.step.hermesProvider, "custom:chat", "必须沿用该步骤当时的步骤级 provider 覆盖");
  assert.deepEqual(execution.inputValues, { brief: "三镜短片" }, "步骤输入按运行快照重建");
  assert.deepEqual(execution.feedback?.originalOutputs, { storyboard: { shots: 3 } });
  assert.equal(execution.feedback?.notes.length, 1);
  assert.match(execution.feedback!.notes[0]!.message, /期望结果：第 1 秒进冲突/);
  assert.equal(execution.feedback!.notes[0]!.sourceRunId, run.runId);
  assert.equal(execution.signal, undefined, "没有 HTTP 取消信号时不伪造 signal");

  assert.deepEqual(store.getRun(settings.projectDirectory, run.runId), before, "不重做：运行记录必须逐字节不变");

  // 未知字段与未知上下文键都拒绝，不静默忽略。
  await assert.rejects(service.requestStepAgentFeedback(admin, { runId: run.runId, stepId: "writer", message: "意见", context: { unknownKey: "x" } }), (error: unknown) => code(error) === "INVALID_STEP_FEEDBACK_REQUEST");
  await assert.rejects(service.requestStepAgentFeedback(admin, { runId: run.runId, stepId: "writer", message: "意见", originalOutputs: { storyboard: { shots: 99 } } }), (error: unknown) => code(error) === "INVALID_STEP_FEEDBACK_REQUEST");
  assert.equal(calls.length, 1, "被拒绝的请求不能触发模型调用");
});

test("逐项反馈：只取该项与该项原结果；非逐项步骤与越界编号明确拒绝", async t => {
  const run = fixtureRun(true);
  const calls: StepAgentFeedbackExecution[] = [];
  const { service } = await serviceWith(t, run, { runStepFeedback: async () => ({ raw: "甲稿（修订）", outputs: { text: "甲稿（修订）" } }) }, calls);
  const result = stepAgentFeedbackResult.parse(await service.requestStepAgentFeedback(admin, { runId: run.runId, stepId: "shot", itemIndex: 0, message: "开场补一个动作" }));
  assert.equal(result.itemIndex, 0);
  assert.deepEqual(result.originalOutputs, { text: "甲稿" });
  assert.deepEqual(result.outputs, { text: "甲稿（修订）" });
  assert.deepEqual(calls[0]!.inputValues, { item: "甲" });
  assert.equal(calls[0]!.itemIndex, 0);

  // 可反馈条件与重做链路同一份校验：越界编号与非逐项步骤都按 INVALID_FEEDBACK 拒绝。
  await assert.rejects(service.requestStepAgentFeedback(admin, { runId: run.runId, stepId: "shot", itemIndex: 5, message: "意见" }), (error: unknown) => code(error) === "INVALID_FEEDBACK");
  await assert.rejects(service.requestStepAgentFeedback(admin, { runId: run.runId, stepId: "writer", itemIndex: 0, message: "意见" }), (error: unknown) => code(error) === "INVALID_STEP_FEEDBACK_REQUEST");
  assert.equal(calls.length, 1, "被拒绝的请求不能触发模型调用");
});

test("拒绝路径：未知运行、非 Hermes、无可反馈结果都在付费请求之前失败", async t => {
  const run = fixtureRun();
  const never: StepAgentFeedbackRunner = { runStepFeedback: async () => { throw new Error("不应被调用"); } };
  const { service } = await serviceWith(t, run, never);
  await assert.rejects(service.requestStepAgentFeedback(admin, { runId: id("missing-run"), stepId: "writer", message: "意见" }), (error: unknown) => code(error) === "RUN_NOT_FOUND");
  await assert.rejects(service.requestStepAgentFeedback(admin, { runId: run.runId, stepId: "ghost", message: "意见" }), (error: unknown) => code(error) === "STEP_FEEDBACK_STEP_NOT_FOUND");
  await assert.rejects(service.requestStepAgentFeedback(admin, { runId: run.runId, stepId: "writer", message: "   " }), (error: unknown) => code(error) === "INVALID_STEP_FEEDBACK_REQUEST");

  const comfy = fixtureRun();
  comfy.workflow.steps[0]!.kind = "comfyui";
  const comfyService = await serviceWith(t, comfy, never);
  await assert.rejects(comfyService.service.requestStepAgentFeedback(admin, { runId: comfy.runId, stepId: "writer", message: "意见" }), (error: unknown) => code(error) === "STEP_FEEDBACK_STEP_KIND");

  const unfinished = fixtureRun();
  unfinished.steps[0]!.status = "failed";
  unfinished.steps[0]!.outputs = {};
  const unfinishedService = await serviceWith(t, unfinished, never);
  await assert.rejects(unfinishedService.service.requestStepAgentFeedback(admin, { runId: unfinished.runId, stepId: "writer", message: "意见" }), (error: unknown) => code(error) === "INVALID_FEEDBACK");
});

test("Agent 侧失败不伪装成功：502 带一段诊断原文、取消是 504，都不写运行", async t => {
  const run = fixtureRun();
  const agentFailure = Object.assign(new Error("Hermes 输出 JSON 格式无效"), { raw: "不是 JSON 的回复".repeat(500) });
  const { service, store, settings } = await serviceWith(t, run, { runStepFeedback: async () => { throw agentFailure; } });
  const before = structuredClone(store.getRun(settings.projectDirectory, run.runId)!);
  await assert.rejects(service.requestStepAgentFeedback(admin, { runId: run.runId, stepId: "writer", message: "意见" }), (error: unknown) => {
    const http = error as HttpError;
    assert.equal(http.status, 502);
    assert.equal(http.code, "STEP_FEEDBACK_AGENT_FAILED");
    assert.equal(http.details?.rawReplyTruncated, true);
    assert.ok(String(http.details?.rawReply).length <= 4_000);
    return true;
  });
  const aborted = Object.assign(new Error("已取消"), { name: "AbortError" });
  const cancelled = await serviceWith(t, run, { runStepFeedback: async () => { throw aborted; } });
  await assert.rejects(cancelled.service.requestStepAgentFeedback(admin, { runId: run.runId, stepId: "writer", message: "意见" }), (error: unknown) => code(error) === "STEP_FEEDBACK_TIMEOUT");
  assert.deepEqual(store.getRun(settings.projectDirectory, run.runId), before);
});
