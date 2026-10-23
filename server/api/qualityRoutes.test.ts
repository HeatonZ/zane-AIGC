import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { randomUUID } from "node:crypto";
import express from "express";
import { harness, id } from "../testing/testSupport.js";
import { WorkspaceService } from "../services/workspaceService.js";
import { AccessService } from "../services/accessService.js";
import { RunQualityService } from "../services/runQualityService.js";
import { StepFeedbackService, type StepAgentFeedbackRunner } from "../services/stepFeedbackService.js";
import { createQualityRouter } from "./qualityRoutes.js";
import { HttpError } from "../errors.js";
import { runAuditSchema, runCritiqueEnvelope, runCritiquePage, runHermesAuditResult } from "../domain/runQualityContracts.js";
import { stepAgentFeedbackResult } from "../domain/stepAgentFeedback.js";
import type { RunRecord } from "../domain/types.js";

function fixtureRun(): RunRecord {
  return {
    runId: id("quality-http-run"), sceneId: "demo", workflowName: "质检HTTP场景", status: "completed",
    createdAt: "2026-10-10T02:00:00.000Z", startedAt: "2026-10-10T02:00:01.000Z", finishedAt: "2026-10-10T02:01:01.000Z",
    workflow: {
      publishedScene: { versionId: "version-h", version: "feed0001", publishedAt: "2026-10-01T00:00:00.000Z" },
      inputs: [{ key: "brief", type: "text", required: true }],
      steps: [{ id: "writer", name: "写分镜", kind: "hermes", hermesProfile: "default", outputs: [{ key: "storyboard", type: "json" }] }],
      outputs: [{ key: "final", type: "json", sourceRef: "step.writer.outputs.storyboard" }],
    },
    inputValues: { brief: "做一个三镜短片" },
    steps: [{ stepId: "writer", name: "写分镜", status: "completed", durationMs: 5000, agentPrompt: "PROMPT-HTTP", outputs: { storyboard: { shots: 3 } }, outputTypes: { storyboard: "json" } }],
    outputs: [{ key: "final", label: "分镜", type: "json", value: { shots: 3 } }],
    artifacts: { directory: "F:/private/http-run", inputs: "", workflow: "", runtime: "", output: "" },
  };
}

async function harnessWithRouter(t: Parameters<typeof harness>[0], options: { runner?: ConstructorParameters<typeof RunQualityService>[4]; bare?: boolean; feedbackRunner?: StepAgentFeedbackRunner } = {}) {
  const h = await harness(t);
  const workspace = new WorkspaceService(h.store, path.join(h.root, "workspace.json"));
  t.after(() => workspace.shutdown());
  const access = new AccessService(h.store, workspace, "");
  const password = "quality-http-password";
  const create = async (username: string, role: "admin" | "user") => {
    const user = (await access.create({ userId: randomUUID(), username, displayName: username, password, role })).user;
    return { user, token: (await access.login(username, password)).token };
  };
  const admin = await create("qhttp-admin", "admin");
  const member = await create("qhttp-user", "user");
  const run = fixtureRun();
  h.store.importRun(h.settings.projectDirectory, run);
  const service = new RunQualityService(access, async () => h.settings, async (project, runId) => h.store.getRun(project, runId), () => false, options.runner);
  const stepFeedback = new StepFeedbackService({
    loadSettings: async () => h.settings,
    getRun: async (project, runId) => h.store.getRun(project, runId),
    runner: options.feedbackRunner ?? { runStepFeedback: async () => ({ raw: '{"storyboard":{"shots":4}}', outputs: { storyboard: { shots: 4 } } }) },
  });
  const app = express();
  app.use(express.json());
  // bare 模式刻意不挂身份中间件，用来证明路由会失败关闭而不是静默放行。
  if (!options.bare) app.use(access.middleware(async () => h.settings.projectDirectory));
  app.use(createQualityRouter(service, stepFeedback));
  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => res.status(error instanceof HttpError ? error.status : 500).json({ error: (error as Error).message, code: error instanceof HttpError ? error.code : "INTERNAL_ERROR", ...(error instanceof HttpError && error.details ? { details: error.details } : {}) }));
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => server.once("listening", resolve));
  t.after(() => new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); }));
  const base = "http://127.0.0.1:" + (server.address() as { port: number }).port;
  async function api(route: string, token = "", body?: unknown, method = body === undefined ? "GET" : "POST") {
    const response = await fetch(base + route, { method, headers: { ...(token ? { Authorization: "Bearer " + token } : {}), ...(body === undefined ? {} : { "Content-Type": "application/json" }) }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { response, data: await response.json() as Record<string, any> };
  }
  const critiqueBody = (extra: Record<string, unknown> = {}) => ({ critiqueId: randomUUID(), verdict: "warn", summary: "整体可用，逐镜失败未拦住", reviewer: "外部质检AI", source: "agent", findings: [{ severity: "major", message: "失败未拦住", stepId: "writer" }], recommendations: ["补失败处理"], ...extra });
  return { ...h, access, admin, member, run, service, api, critiqueBody };
}

test("质检HTTP：管理员可用、普通用户与匿名被拒，未挂身份中间件时失败关闭", async t => {
  const h = await harnessWithRouter(t);
  const audit = await h.api("/api/v1/runs/" + h.run.runId + "/audit", h.admin.token);
  assert.equal(audit.response.status, 200);
  assert.equal(runAuditSchema.safeParse(audit.data).success, true);
  assert.equal(audit.response.headers.get("cache-control"), "no-store");
  assert.equal((await h.api("/api/v1/runs/" + h.run.runId + "/audit", h.member.token)).response.status, 403);
  assert.equal((await h.api("/api/v1/runs/" + h.run.runId + "/audit")).response.status, 401);
  assert.equal((await h.api("/api/v1/runs/" + h.run.runId + "/audit?promptLimit=10", h.admin.token)).data.code, "INVALID_RUN_QUALITY_REQUEST");
  assert.equal((await h.api("/api/v1/runs/" + h.run.runId + "/audit?promptLimit=abc", h.admin.token)).data.code, "INVALID_RUN_QUALITY_REQUEST");
  assert.equal((await h.api("/api/v1/runs/" + id("missing-run") + "/audit", h.admin.token)).data.code, "RUN_NOT_FOUND");
  assert.equal((await h.api("/api/v1/runs/" + h.run.runId + "/audit?stepId=ghost", h.admin.token)).data.code, "RUN_AUDIT_STEP_NOT_FOUND");
  // 身份中间件缺失时必须失败关闭：不能因为路由顺序变化而变成匿名可写。
  const bare = await harnessWithRouter(t, { bare: true });
  assert.equal((await bare.api("/api/v1/runs/" + bare.run.runId + "/audit")).response.status, 403);
  assert.equal((await bare.api("/api/v1/runs/" + bare.run.runId + "/critiques", "", bare.critiqueBody())).response.status, 403);
});

test("质检HTTP：建档/列表/详情/状态收敛与409对账路径", async t => {
  const h = await harnessWithRouter(t);
  const created = await h.api("/api/v1/runs/" + h.run.runId + "/critiques", h.admin.token, h.critiqueBody());
  assert.equal(created.response.status, 201);
  const envelope = runCritiqueEnvelope.parse(created.data);
  assert.equal(envelope.critique.runId, h.run.runId);
  assert.equal(envelope.critique.findings[0]!.stepId, "writer");
  assert.equal((await h.api("/api/v1/runs/" + h.run.runId + "/critiques", h.member.token, h.critiqueBody())).response.status, 403);
  const duplicate = await h.api("/api/v1/runs/" + h.run.runId + "/critiques", h.admin.token, h.critiqueBody({ critiqueId: envelope.critique.id }));
  assert.equal(duplicate.response.status, 409);
  assert.equal(duplicate.data.code, "RUN_CRITIQUE_ALREADY_EXISTS");
  for (const body of [h.critiqueBody({ verdict: "great" }), h.critiqueBody({ score: 101 }), h.critiqueBody({ unknownKey: 1 }), h.critiqueBody({ findings: [{ severity: "blocker", message: "x" }] })]) {
    assert.equal((await h.api("/api/v1/runs/" + h.run.runId + "/critiques", h.admin.token, body)).data.code, "INVALID_RUN_QUALITY_REQUEST");
  }
  const list = runCritiquePage.parse((await h.api("/api/v1/runs/" + h.run.runId + "/critiques?limit=1", h.admin.token)).data);
  assert.equal(list.total, 1);
  assert.equal(list.items[0]!.findingsOmitted, true);
  assert.equal((await h.api("/api/v1/runs/" + h.run.runId + "/critiques?verdict=pass", h.admin.token)).data.total, 0);
  assert.equal((await h.api("/api/v1/runs/" + h.run.runId + "/critiques?cursor=not-a-cursor", h.admin.token)).data.code, "INVALID_ACCESS_CURSOR");
  assert.equal((await h.api("/api/v1/runs/" + h.run.runId + "/critiques", h.member.token)).response.status, 403);
  const detail = await h.api("/api/v1/quality/critiques/" + envelope.critique.id, h.admin.token);
  assert.equal(detail.response.status, 200);
  assert.equal(runCritiqueEnvelope.parse(detail.data).nextAction, "update_run_critique");
  assert.equal((await h.api("/api/v1/quality/critiques/" + randomUUID(), h.admin.token)).data.code, "RUN_CRITIQUE_NOT_FOUND");
  assert.equal((await h.api("/api/v1/quality/critiques/" + envelope.critique.id, h.member.token)).response.status, 403);
  // 状态收敛：非法跳转与过期revision都必须先对账。
  const illegal = await h.api("/api/v1/quality/critiques/" + envelope.critique.id, h.admin.token, { revision: envelope.critique.revision, status: "fixed" }, "PATCH");
  assert.equal(illegal.data.code, "RUN_CRITIQUE_STATE_CONFLICT");
  const stale = await h.api("/api/v1/quality/critiques/" + envelope.critique.id, h.admin.token, { revision: 99, status: "accepted" }, "PATCH");
  assert.equal(stale.data.code, "RUN_CRITIQUE_REVISION_CONFLICT");
  const accepted = await h.api("/api/v1/quality/critiques/" + envelope.critique.id, h.admin.token, { revision: envelope.critique.revision, status: "accepted", note: "确认要修" }, "PATCH");
  assert.equal(runCritiqueEnvelope.parse(accepted.data).nextAction, "preview_rerun");
  assert.equal((await h.api("/api/v1/quality/critiques/" + envelope.critique.id, h.member.token, { revision: 1, status: "accepted" }, "PATCH")).response.status, 403);
});

test("步骤级反馈HTTP：管理员可用并返回契约结果，权限、参数与运行状态都被守住", async t => {
  const h = await harnessWithRouter(t);
  const route = "/api/v1/runs/" + h.run.runId + "/steps/writer/feedback";
  const before = structuredClone(h.store.getRun(h.settings.projectDirectory, h.run.runId)!);

  const ok = await h.api(route, h.admin.token, { message: "第二镜节奏太慢", context: { expectation: "第 1 秒进冲突" } });
  assert.equal(ok.response.status, 200);
  assert.equal(ok.response.headers.get("cache-control"), "no-store");
  const result = stepAgentFeedbackResult.parse(ok.data);
  assert.equal(result.stepId, "writer");
  assert.deepEqual(result.outputs, { storyboard: { shots: 4 } });
  assert.deepEqual(result.originalOutputs, { storyboard: { shots: 3 } });
  assert.match(result.context.feedback, /期望结果：第 1 秒进冲突/);

  // 权限：普通用户与匿名都不可达；未挂身份中间件时失败关闭（不能因路由顺序变化变成匿名可付费）。
  assert.equal((await h.api(route, h.member.token, { message: "意见" })).response.status, 403);
  assert.equal((await h.api(route, undefined, { message: "意见" })).response.status, 401);
  const bare = await harnessWithRouter(t, { bare: true });
  assert.equal((await bare.api("/api/v1/runs/" + bare.run.runId + "/steps/writer/feedback", "", { message: "意见" })).response.status, 403);

  // 参数与目标：未知字段、空反馈、非 Hermes 步骤、未知步骤都明确报错。
  assert.equal((await h.api(route, h.admin.token, { message: "意见", unknown: 1 })).data.code, "INVALID_STEP_FEEDBACK_REQUEST");
  assert.equal((await h.api(route, h.admin.token, { message: "   " })).data.code, "INVALID_STEP_FEEDBACK_REQUEST");
  assert.equal((await h.api(route, h.admin.token, { message: "意见", itemIndex: 0 })).data.code, "INVALID_STEP_FEEDBACK_REQUEST");
  assert.equal((await h.api("/api/v1/runs/" + h.run.runId + "/steps/ghost/feedback", h.admin.token, { message: "意见" })).data.code, "STEP_FEEDBACK_STEP_NOT_FOUND");
  assert.equal((await h.api("/api/v1/runs/" + id("missing-feedback-run") + "/steps/writer/feedback", h.admin.token, { message: "意见" })).data.code, "RUN_NOT_FOUND");

  // 不重做：反馈不写运行记录（不新建运行、不改状态/pendingReview/revision）。
  assert.deepEqual(h.store.getRun(h.settings.projectDirectory, h.run.runId), before);
});

test("步骤级反馈HTTP：Agent 失败映射成 502 并带诊断原文，不伪装成功", async t => {
  const h = await harnessWithRouter(t, { feedbackRunner: { runStepFeedback: async () => { throw new Error("Hermes API 请求失败：timeout"); } } });
  const failed = await h.api("/api/v1/runs/" + h.run.runId + "/steps/writer/feedback", h.admin.token, { message: "意见" });
  assert.equal(failed.response.status, 502);
  assert.equal(failed.data.code, "STEP_FEEDBACK_AGENT_FAILED");
  assert.match(failed.data.error, /Hermes API 请求失败/);
});

test("质检HTTP：直连Hermes评审写入hermes来源意见，配置缺失与输出越界都明确报错", async t => {
  const valid = { verdict: "fail", score: 30, summary: "分镜与输入要求不符", findings: [{ severity: "critical", message: "镜头数与要求不一致", stepId: "writer" }], recommendations: ["按 brief 重写分镜"] };
  const h = await harnessWithRouter(t, { runner: async () => ({ value: valid, repaired: true, raw: JSON.stringify(valid), promptBytes: 2048 }) });
  h.settings.enabledHermesProfiles = ["default"];
  const auditId = randomUUID();
  const created = await h.api("/api/v1/runs/" + h.run.runId + "/audit/hermes", h.admin.token, { critiqueId: auditId, focus: "重点看镜头数" });
  assert.equal(created.response.status, 201);
  const result = runHermesAuditResult.parse(created.data);
  assert.equal(result.critique.source, "hermes");
  assert.equal(result.critique.id, auditId);
  assert.equal(result.critique.verdict, "fail");
  assert.equal(result.repaired, true);
  assert.equal(result.nextAction, "get_run_critique");
  assert.equal((await h.api("/api/v1/quality/critiques/" + auditId, h.admin.token)).data.critique.reviewer, "Hermes 质检（default）");
  // 同一ID不得重复评审（付费操作靠预分配ID对账）。
  const again = await h.api("/api/v1/runs/" + h.run.runId + "/audit/hermes", h.admin.token, { critiqueId: auditId });
  assert.equal(again.response.status, 409);
  assert.equal((await h.api("/api/v1/runs/" + h.run.runId + "/audit/hermes", h.member.token, { critiqueId: randomUUID() })).response.status, 403);
  assert.equal((await h.api("/api/v1/runs/" + h.run.runId + "/audit/hermes", h.admin.token, { critiqueId: randomUUID(), focus: "x".repeat(2001) })).data.code, "INVALID_RUN_QUALITY_REQUEST");
  assert.equal((await h.api("/api/v1/runs/" + h.run.runId + "/audit/hermes", h.admin.token, { critiqueId: randomUUID(), unknown: 1 })).data.code, "INVALID_RUN_QUALITY_REQUEST");
  const noProfile = await harnessWithRouter(t);
  assert.equal((await noProfile.api("/api/v1/runs/" + noProfile.run.runId + "/audit/hermes", noProfile.admin.token, { critiqueId: randomUUID() })).data.code, "RUN_AUDIT_PROFILE_UNAVAILABLE");
});
