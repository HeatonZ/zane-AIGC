import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { RunRecord } from "../domain/types.js";
import { harness, id } from "../testing/testSupport.js";
import { WorkspaceService } from "./workspaceService.js";
import { AccessService } from "./accessService.js";
import { buildRunAudit, RunQualityService } from "./runQualityService.js";
import { runAuditQuery, runAuditSchema, runHermesAuditResult } from "../domain/runQualityContracts.js";
import { HermesAuditOutputError } from "../execution/hermesAudit.js";
import { publicRequestAllowed } from "../security/publicEntry.js";

function fixtureRun(): RunRecord {
  return {
    runId: id("quality-run"), sceneId: "demo", workflowName: "质检场景", runTitle: "第三批",
    status: "completed", createdAt: "2026-10-10T01:00:00.000Z", startedAt: "2026-10-10T01:00:03.000Z", finishedAt: "2026-10-10T01:02:03.000Z",
    ownerUserId: "owner-1", submitter: { userId: "owner-1", username: "alice", displayName: "Alice" },
    workflow: {
      publishedScene: { versionId: "version-q", version: "abcd1234", publishedAt: "2026-10-01T00:00:00.000Z" },
      inputs: [{ key: "brief", type: "text", required: true }, { key: "reference", type: "image" }],
      steps: [
        { id: "writer", name: "写分镜", kind: "hermes", hermesProfile: "default", hermesModel: "anthropic/claude-opus-5", outputs: [{ key: "storyboard", type: "json", label: "分镜" }] },
        { id: "shots", name: "逐镜生成", kind: "hermes", execution: { mode: "for_each" }, outputs: [{ key: "image", type: "image_list" }] },
        { id: "pack", name: "打包", kind: "core.code", capabilityId: "core.code", capabilityVersion: "1.0.0", outputs: [{ key: "manifest", type: "json" }, { key: "missing", type: "text" }] },
      ],
      outputs: [{ key: "final", type: "json", sourceRef: "step.pack.outputs.manifest" }],
    },
    inputValues: { brief: "一句话" + "长".repeat(600), reference: { assetId: "asset-1", assetVersion: 2, path: "F:/internal/secret.png", previewUrl: "https://internal/secret" } },
    steps: [
      { stepId: "writer", name: "写分镜", capabilityId: "core.hermes", status: "completed", startedAt: "2026-10-10T01:00:03.000Z", durationMs: 12000,
        agentPrompt: "PROMPT-WRITER " + "x".repeat(3000), warnings: ["第一条建议", "第二条建议", "第三条建议"],
        outputs: { storyboard: { shots: [1, 2, 3] } }, outputTypes: { storyboard: "json" } },
      { stepId: "shots", name: "逐镜生成", status: "completed_with_errors", startedAt: "2026-10-10T01:00:20.000Z", durationMs: 90000,
        outputTypes: { image: "image_list" },
        items: [
          { index: 0, value: null, status: "completed", agentPrompt: "ITEM-PROMPT-0", outputs: { image: [{ filename: "a.png" }] } },
          { index: 1, value: null, status: "failed", error: "step failed", agentPrompt: "ITEM-PROMPT-1", agentResponse: "RAW-RESPONSE-1" },
          { index: 2, value: null, status: "completed", agentPrompt: "ITEM-PROMPT-2", outputs: { image: [{ filename: "c.png" }] } },
        ] },
      { stepId: "pack", name: "打包", status: "completed", outputs: { manifest: { count: 3 } }, outputTypes: { manifest: "json" } },
    ],
    outputs: [{ key: "final", label: "清单", type: "json", value: { count: 3 } }],
    artifacts: { directory: "F:/private/run-directory", inputs: "", workflow: "", runtime: "", output: "" },
  };
}

test("质检证据包：有界提示词、逐项抽样、输出只给元数据，且不夹带本机路径与输出值", () => {
  const run = fixtureRun();
  const packet = buildRunAudit(run, runAuditQuery.parse({ runId: run.runId, promptLimit: 200 }), []);
  // 机器契约：材料包必须能通过自己的schema，否则AI读到的结构与文档不一致。
  assert.equal(runAuditSchema.safeParse(packet).success, true, "材料包必须符合自己的机器契约：" + JSON.stringify(runAuditSchema.safeParse(packet).error?.issues));
  assert.deepEqual(packet.steps.map(step => step.stepId), ["writer", "shots", "pack"]);
  assert.equal(packet.steps[2]!.agent, undefined, "非模型步骤不应有提示词证据");
  const writer = packet.steps[0]!;
  assert.equal(writer.agent?.promptAvailable, true);
  assert.equal(writer.agent?.prompt?.length, 200, "提示词按码点截断");
  assert.equal(writer.agent?.promptPage.total, "PROMPT-WRITER ".length + 3000);
  assert.equal(writer.agent?.promptPage.hasMore, true);
  assert.equal(writer.agent?.nextAction, "get_run", "提示词全文只在运行原始快照里");
  assert.equal(writer.model?.profile, "default");
  assert.equal(writer.model?.model, "anthropic/claude-opus-5");
  assert.equal(writer.warningCount, 3);
  assert.deepEqual(writer.outputs.map(item => [item.key, item.present]), [["storyboard", true]]);
  const shots = packet.steps[1]!;
  assert.equal(shots.itemProgress?.total, 3);
  assert.equal(shots.itemProgress?.failed, 1);
  assert.equal(shots.itemSample?.length, 2, "默认只内联前2项");
  assert.equal(shots.itemSampleOmitted, 1);
  assert.equal(shots.itemSample?.[0]?.agent?.prompt, "ITEM-PROMPT-0");
  assert.equal(shots.itemSample?.[1]?.agent?.responseAvailable, true);
  assert.equal(shots.itemSample?.[1]?.agent?.response, "RAW-RESPONSE-1");
  assert.equal(shots.itemSample?.[1]?.error, true);
  assert.equal(shots.outputs.find(item => item.key === "image")?.present, false, "逐项产出不计入步骤级输出");
  assert.equal(shots.outputs.find(item => item.key === "image")?.mediaCount, undefined);
  const pack = packet.steps[2]!;
  assert.deepEqual(pack.outputs.map(item => [item.key, item.present]), [["manifest", true], ["missing", false]]);
  assert.equal(pack.outputs[0]!.valueBytes > 0, true);
  // 输入值脱敏且受预算；媒体只回固定版本引用。
  assert.equal(packet.inputs.find(item => item.key === "reference")!.value && (packet.inputs.find(item => item.key === "reference")!.value as Record<string, unknown>).assetId, "asset-1");
  assert.doesNotMatch(JSON.stringify(packet), /F:\/|run-directory|secret\.png|previewUrl|https:\/\/internal/, "材料包不得包含本机路径或内部地址");
  // 输出值一律不内联。
  assert.doesNotMatch(JSON.stringify(packet.outputs), /"value"/);
  assert.equal(packet.critiqueSummary.total, 0);
  assert.equal(packet.nextAction, "submit_run_critique");
  assert.equal(packet.evidenceBudget.promptLimitPerCall, 200);
  assert.equal(packet.revision, buildRunAudit(run, runAuditQuery.parse({ runId: run.runId, promptLimit: 200 }), []).revision, "同一快照revision稳定");
  run.status = "failed";
  assert.notEqual(buildRunAudit(run, runAuditQuery.parse({ runId: run.runId, promptLimit: 200 }), []).revision, packet.revision);
});

test("质检证据包：字节预算耗尽时显式省略而不是静默丢弃，stepId过滤与未知步骤", () => {
  const run = fixtureRun();
  const tiny = buildRunAudit(run, runAuditQuery.parse({ runId: run.runId, promptLimit: 8000 }), [], { promptBytesBudget: 10 });
  assert.equal(tiny.steps[0]!.agent?.promptOmitted, true);
  assert.equal(tiny.steps[0]!.agent?.promptOmissionReason, "byte_budget");
  assert.equal(tiny.steps[0]!.agent?.prompt, undefined);
  assert.equal(tiny.steps[0]!.agent?.promptPage.hasMore, true);
  assert.equal(tiny.evidenceBudget.promptBytesInlined + tiny.steps[1]!.itemSample!.reduce((count, item) => count + (item.agent?.prompt?.length ?? 0), 0) < 100, true);
  assert.ok(tiny.omissionNotes?.length);
  const single = buildRunAudit(run, runAuditQuery.parse({ runId: run.runId, stepId: "shots", itemSample: 0 }), []);
  assert.deepEqual(single.steps.map(step => step.stepId), ["shots"]);
  assert.equal(single.steps[0]!.itemSample, undefined);
  assert.equal(single.steps[0]!.itemSampleOmitted, 3);
  assert.throws(() => buildRunAudit(run, runAuditQuery.parse({ runId: run.runId, stepId: "ghost" }), []), (error: { code?: string }) => error.code === "RUN_AUDIT_STEP_NOT_FOUND");
  // 未执行的未来步骤也要出现在材料包里（否则质检看不到「本该跑却没跑」）。
  run.steps = run.steps.filter(step => step.stepId !== "pack");
  assert.equal(buildRunAudit(run, runAuditQuery.parse({ runId: run.runId }), []).steps[2]!.status, "pending");
});

async function qualityHarness(t: Parameters<typeof harness>[0], runner?: ConstructorParameters<typeof RunQualityService>[4]) {
  const h = await harness(t);
  const workspace = new WorkspaceService(h.store, path.join(h.root, "workspace.json"));
  t.after(() => workspace.shutdown());
  const access = new AccessService(h.store, workspace, "");
  const password = "quality-audit-password";
  const create = async (username: string, role: "admin" | "user") => {
    const user = (await access.create({ userId: randomUUID(), username, displayName: username, password, role })).user;
    const session = await access.login(username, password);
    return { user, identity: access.authenticate(session.token) };
  };
  const admin = await create("qa-admin", "admin");
  const member = await create("qa-user", "user");
  const run = fixtureRun();
  h.store.importRun(h.settings.projectDirectory, run);
  const service = new RunQualityService(access, async () => h.settings, async (project, runId) => h.store.getRun(project, runId), () => false, runner);
  return { ...h, access, admin, member, run, service };
}

const critiqueInput = (runIdValue: string, extra: Record<string, unknown> = {}) => ({
  runId: runIdValue, critiqueId: randomUUID(), verdict: "warn", score: 72,
  summary: "整体可用，但逐镜失败没有被上游拦住", reviewer: "exter-qa", source: "agent",
  findings: [{ severity: "major", message: "第2镜失败但步骤整体算完成", stepId: "shots", itemIndex: 1 }],
  recommendations: ["先修 shots 步骤的失败处理"], ...extra,
});

test("质检权限与建档：仅管理员可用，重复ID不幂等，未知步骤被拒", async t => {
  const h = await qualityHarness(t);
  await assert.rejects(() => h.service.audit(h.member.identity, { runId: h.run.runId }), (error: { code?: string }) => error.code === "ADMIN_REQUIRED");
  await assert.rejects(() => h.service.createCritique(h.member.identity, critiqueInput(h.run.runId)), (error: { code?: string }) => error.code === "ADMIN_REQUIRED");
  const created = await h.service.createCritique(h.admin.identity, critiqueInput(h.run.runId));
  assert.equal(created.critique.revision, 1);
  assert.equal(created.critique.status, "open");
  assert.equal(created.critique.findings[0]!.id, "f1");
  assert.equal(created.nextAction, "get_run_critique");
  const duplicate = critiqueInput(h.run.runId, { critiqueId: created.critique.id });
  await assert.rejects(() => h.service.createCritique(h.admin.identity, duplicate), (error: { code?: string }) => error.code === "RUN_CRITIQUE_ALREADY_EXISTS");
  await assert.rejects(() => h.service.createCritique(h.admin.identity, critiqueInput(h.run.runId, { findings: [{ severity: "minor", message: "引用了不存在的步骤", stepId: "ghost" }] })), (error: { code?: string }) => error.code === "INVALID_RUN_QUALITY_REQUEST");
  await assert.rejects(() => h.service.createCritique(h.admin.identity, critiqueInput(h.run.runId, { source: "hermes" })), (error: { code?: string }) => error.code === "INVALID_RUN_QUALITY_REQUEST");
  await assert.rejects(() => h.service.createCritique(h.admin.identity, critiqueInput(id("missing-run"))), (error: { code?: string }) => error.code === "RUN_NOT_FOUND");
  // 用户专用入口不得出现这条通道。
  assert.equal(publicRequestAllowed("POST", "/api/v1/runs/" + h.run.runId + "/critiques"), false);
  assert.equal(publicRequestAllowed("GET", "/api/v1/runs/" + h.run.runId + "/audit"), false);
  assert.equal(publicRequestAllowed("PATCH", "/api/v1/quality/critiques/" + created.critique.id), false);
});

test("质检意见：列表只给索引且游标绑定快照，状态机与revision冲突明确", async t => {
  const h = await qualityHarness(t);
  const first = (await h.service.createCritique(h.admin.identity, critiqueInput(h.run.runId, { verdict: "fail" }))).critique;
  const second = (await h.service.createCritique(h.admin.identity, critiqueInput(h.run.runId, { verdict: "pass", score: 95, findings: [] }))).critique;
  const page = await h.service.listCritiques(h.admin.identity, { runId: h.run.runId, limit: 1 });
  assert.equal(page.total, 2);
  assert.equal(page.hasMore, true);
  assert.equal(page.items[0]!.summaryOmitted, true);
  assert.equal("findings" in page.items[0]!, false);
  const secondPage = await h.service.listCritiques(h.admin.identity, { runId: h.run.runId, limit: 1, cursor: page.nextCursor });
  assert.notEqual(secondPage.items[0]!.id, page.items[0]!.id, "第二页必须换一条记录");
  assert.equal(secondPage.hasMore, false);
  await h.service.createCritique(h.admin.identity, critiqueInput(h.run.runId));
  await assert.rejects(() => h.service.listCritiques(h.admin.identity, { runId: h.run.runId, limit: 1, cursor: page.nextCursor }), (error: { code?: string }) => error.code === "ACCESS_PAGE_CHANGED");
  assert.deepEqual((await h.service.listCritiques(h.admin.identity, { runId: h.run.runId, verdict: "fail" })).items.map(item => item.id), [first.id]);
  assert.equal((await h.service.getCritique(h.admin.identity, { critiqueId: first.id })).nextAction, "update_run_critique");
  await assert.rejects(() => h.service.updateCritique(h.admin.identity, { critiqueId: first.id, revision: 99, status: "accepted" }), (error: { code?: string }) => error.code === "RUN_CRITIQUE_REVISION_CONFLICT");
  await assert.rejects(() => h.service.updateCritique(h.admin.identity, { critiqueId: first.id, revision: first.revision, status: "fixed" }), (error: { code?: string }) => error.code === "RUN_CRITIQUE_STATE_CONFLICT");
  const accepted = await h.service.updateCritique(h.admin.identity, { critiqueId: first.id, revision: first.revision, status: "accepted", note: "确认要修" });
  assert.equal(accepted.critique.status, "accepted");
  assert.equal(accepted.critique.statusNote, "确认要修");
  assert.equal(accepted.nextAction, "preview_rerun");
  const fixed = await h.service.updateCritique(h.admin.identity, { critiqueId: first.id, revision: accepted.critique.revision, status: "fixed" });
  assert.equal(fixed.nextAction, "get_run_audit");
  const reopened = await h.service.updateCritique(h.admin.identity, { critiqueId: first.id, revision: fixed.critique.revision, status: "open" });
  assert.equal(reopened.critique.status, "open");
  const dismissed = await h.service.updateCritique(h.admin.identity, { critiqueId: second.id, revision: second.revision, status: "dismissed" });
  assert.equal(dismissed.critique.status, "dismissed");
  // 材料包汇总已有意见，但不内联正文。
  const packet = await h.service.audit(h.admin.identity, { runId: h.run.runId });
  assert.equal(packet.critiqueSummary.total, 3);
  assert.equal(packet.critiqueSummary.open, 2);
  assert.equal(packet.critiqueSummary.byVerdict.fail, 1);
  assert.doesNotMatch(JSON.stringify(packet.critiqueSummary), /整体可用|先修 shots/);
});

test("直连 Hermes 质检：严格校验后才写入，失败不产生记录，响应丢失按同一ID对账", async t => {
  const calls: Array<Record<string, unknown>> = [];
  const valid = {
    verdict: "warn", score: 68, summary: "提示词清楚，但逐镜失败未被上游拦住",
    findings: [{ severity: "major", message: "第2镜失败仍算完成", stepId: "shots", itemIndex: 1 }, { severity: "info", message: "耗时偏长" }],
    recommendations: ["在 shots 步骤加失败处理"],
  };
  const h = await qualityHarness(t, async options => { calls.push(options as unknown as Record<string, unknown>); return { value: valid, repaired: false, raw: JSON.stringify(valid), promptBytes: 1234 }; });
  h.settings.enabledHermesProfiles = [];
  await assert.rejects(() => h.service.hermesAudit(h.admin.identity, { runId: h.run.runId, critiqueId: randomUUID() }), (error: { code?: string }) => error.code === "RUN_AUDIT_PROFILE_UNAVAILABLE");
  h.settings.enabledHermesProfiles = ["default"];
  const auditId = randomUUID();
  const result = await h.service.hermesAudit(h.admin.identity, { runId: h.run.runId, critiqueId: auditId, focus: "重点看失败处理" });
  assert.equal(runHermesAuditResult.safeParse(result).success, true);
  assert.equal(result.critique.source, "hermes");
  assert.equal(result.critique.reviewer, "Hermes 质检（default）");
  assert.equal(result.critique.status, "open");
  assert.equal(result.critique.verdict, "warn");
  assert.equal(result.critique.score, 68);
  assert.deepEqual(result.critique.findings.map(item => item.id), ["f1", "f2"]);
  assert.equal(result.critique.findings[0]!.stepId, "shots");
  assert.equal(result.target.profile, "default");
  assert.equal(result.promptBytes, 1234);
  assert.equal(calls.length, 1);
  const packet = calls[0]!.packet as { runId: string; evidenceBudget: { promptBytesBudget: number } };
  assert.equal(packet.runId, h.run.runId);
  assert.equal(packet.evidenceBudget.promptBytesBudget, 24 * 1024, "交给模型的证据包预算小于给人看的材料包");
  assert.equal(calls[0]!.focus, "重点看失败处理");
  // 同一 critiqueId 再评审必须被拒，不允许重复付费。
  await assert.rejects(() => h.service.hermesAudit(h.admin.identity, { runId: h.run.runId, critiqueId: auditId }), (error: { code?: string }) => error.code === "RUN_CRITIQUE_ALREADY_EXISTS");
  assert.equal(calls.length, 1);
});

test("直连 Hermes 质检：输出契约不符、超时与网关失败都不写入记录并给出可读错误", async t => {
  const h = await qualityHarness(t, async () => ({ value: { verdict: "maybe", score: 200, summary: "", findings: [], recommendations: [] }, repaired: false, raw: "{\"verdict\":\"maybe\"}", promptBytes: 10 }));
  h.settings.enabledHermesProfiles = ["default"];
  const bad = await h.service.hermesAudit(h.admin.identity, { runId: h.run.runId, critiqueId: randomUUID() }).catch((error: { code?: string; details?: Record<string, unknown> }) => error);
  assert.equal((bad as { code?: string }).code, "RUN_AUDIT_INVALID_OUTPUT");
  assert.match(String((bad as { details?: Record<string, unknown> }).details?.rawReply), /maybe/);
  assert.equal((await h.service.listCritiques(h.admin.identity, { runId: h.run.runId })).total, 0, "校验失败不得留下半条记录");

  const steps = await qualityHarness(t, async () => ({ value: { verdict: "pass", score: 90, summary: "ok", findings: [{ severity: "minor", message: "步骤不存在", stepId: "ghost" }], recommendations: [] }, repaired: true, raw: "{}", promptBytes: 10 }));
  steps.settings.enabledHermesProfiles = ["default"];
  await assert.rejects(() => steps.service.hermesAudit(steps.admin.identity, { runId: steps.run.runId, critiqueId: randomUUID() }), (error: { code?: string; details?: Record<string, unknown> }) => error.code === "RUN_AUDIT_INVALID_OUTPUT" && Array.isArray(error.details?.allowedStepIds));

  const broken = await qualityHarness(t, async () => { throw new HermesAuditOutputError("Hermes 质检 输出 JSON 格式无效", "not json"); });
  broken.settings.enabledHermesProfiles = ["default"];
  await assert.rejects(() => broken.service.hermesAudit(broken.admin.identity, { runId: broken.run.runId, critiqueId: randomUUID() }), (error: { code?: string; details?: Record<string, unknown> }) => error.code === "RUN_AUDIT_INVALID_OUTPUT" && error.details?.rawReply === "not json");

  const timeout = await qualityHarness(t, async () => { const error = new Error("aborted"); error.name = "AbortError"; throw error; });
  timeout.settings.enabledHermesProfiles = ["default"];
  await assert.rejects(() => timeout.service.hermesAudit(timeout.admin.identity, { runId: timeout.run.runId, critiqueId: randomUUID() }), (error: { code?: string }) => error.code === "RUN_AUDIT_TIMEOUT");

  const failed = await qualityHarness(t, async () => { throw new Error("Hermes API 请求失败：网关不可达"); });
  failed.settings.enabledHermesProfiles = ["default"];
  await assert.rejects(() => failed.service.hermesAudit(failed.admin.identity, { runId: failed.run.runId, critiqueId: randomUUID() }), (error: { code?: string }) => error.code === "RUN_AUDIT_HERMES_FAILED");
});
