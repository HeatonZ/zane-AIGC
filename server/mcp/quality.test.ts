import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import express from "express";
import { harness, id } from "../testing/testSupport.js";
import { WorkspaceService } from "../services/workspaceService.js";
import { AccessService } from "../services/accessService.js";
import { RunQualityService } from "../services/runQualityService.js";
import { createQualityRouter } from "../api/qualityRoutes.js";
import { HttpError } from "../errors.js";
import { runAuditSchema, runCritiqueEnvelope, runCritiquePage, runHermesAuditResult } from "../domain/runQualityContracts.js";
import type { RunRecord } from "../domain/types.js";
import type { ApiResult } from "./httpClient.js";

/**
 * Real stdio MCP closed loop for the run quality channel: an actual MCP client drives the actual
 * `server/mcp/index.ts` adapter against an isolated HTTP backend, so this covers
 * schema → tool registration → HTTP → service, not just the service in isolation.
 */
test("真实stdio MCP隔离闭环：质检工具经MCP读证据包、留意见、直连评审，普通用户与无效参数被拒", async t => {
  const h = await harness(t);
  const workspace = new WorkspaceService(h.store, path.join(h.root, "workspace.json"));
  t.after(() => workspace.shutdown());
  const access = new AccessService(h.store, workspace, "");
  const password = "quality-mcp-password";
  async function createUser(username: string, role: "admin" | "user") {
    const user = (await access.create({ userId: randomUUID(), username, displayName: username, password, role })).user;
    return { user, token: (await access.login(username, password)).token };
  }
  const admin = await createUser("qmcp-admin", "admin");
  const member = await createUser("qmcp-user", "user");
  const run: RunRecord = {
    runId: id("quality-mcp-run"), sceneId: "demo", workflowName: "质检MCP场景", status: "completed",
    createdAt: "2026-10-10T03:00:00.000Z", startedAt: "2026-10-10T03:00:01.000Z", finishedAt: "2026-10-10T03:01:01.000Z",
    workflow: {
      publishedScene: { versionId: "version-m", version: "beef0002", publishedAt: "2026-10-01T00:00:00.000Z" },
      inputs: [{ key: "brief", type: "text", required: true }],
      steps: [{ id: "writer", name: "写分镜", kind: "hermes", hermesProfile: "default", outputs: [{ key: "storyboard", type: "json" }] }],
      outputs: [{ key: "final", type: "json", sourceRef: "step.writer.outputs.storyboard" }],
    },
    inputValues: { brief: "三镜短片" },
    steps: [{ stepId: "writer", name: "写分镜", status: "completed", durationMs: 4000, agentPrompt: "MCP-PROMPT-" + "y".repeat(500), outputs: { storyboard: { shots: 3 } }, outputTypes: { storyboard: "json" } }],
    outputs: [{ key: "final", label: "分镜", type: "json", value: { shots: 3 } }],
    artifacts: { directory: "F:/private/mcp-run", inputs: "", workflow: "", runtime: "", output: "" },
  };
  h.store.importRun(h.settings.projectDirectory, run);
  h.settings.enabledHermesProfiles = ["default"];
  const audited = { verdict: "warn", score: 75, summary: "分镜可用但镜头数待确认", findings: [{ severity: "minor", message: "镜头数没有对账", stepId: "writer" }], recommendations: ["在 brief 里写死镜头数"] };
  const service = new RunQualityService(access, async () => h.settings, async (project, runId) => h.store.getRun(project, runId), () => false,
    async () => ({ value: audited, repaired: false, raw: JSON.stringify(audited), promptBytes: 999 }));
  const app = express();
  app.use(express.json());
  app.use(access.middleware(async () => h.settings.projectDirectory));
  app.use(createQualityRouter(service));
  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(error instanceof HttpError ? error.status : 500).json({ error: (error as Error).message, code: error instanceof HttpError ? error.code : "INTERNAL_ERROR", ...(error instanceof HttpError && error.details ? { details: error.details } : {}) });
  });
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => server.once("listening", resolve));
  t.after(() => new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); }));
  const base = "http://127.0.0.1:" + (server.address() as { port: number }).port;

  const spawn = (token: string) => new StdioClientTransport({ command: process.execPath, args: ["--import", "tsx", path.resolve("server/mcp/index.ts")], cwd: process.cwd(), env: { ...Object.fromEntries(Object.entries(process.env).filter((item): item is [string, string] => typeof item[1] === "string")), ZANE_BASE_URL: base, ZANE_API_TOKEN: token }, stderr: "pipe" });
  const transport = spawn(admin.token);
  const client = new Client({ name: "isolated-run-quality", version: "1.0.0" });
  t.after(() => client.close());
  await client.connect(transport);
  async function call(target: Client, name: string, args: Record<string, unknown> = {}) {
    const result = await target.callTool({ name, arguments: args });
    return { payload: result.structuredContent as ApiResult, isError: Boolean(result.isError) };
  }

  const tools = await client.listTools();
  const expected: Record<string, { readOnly: boolean; openWorld: boolean }> = {
    get_run_audit: { readOnly: true, openWorld: false },
    submit_run_critique: { readOnly: false, openWorld: false },
    list_run_critiques: { readOnly: true, openWorld: false },
    get_run_critique: { readOnly: true, openWorld: false },
    update_run_critique: { readOnly: false, openWorld: false },
    audit_run_with_hermes: { readOnly: false, openWorld: true },
  };
  for (const [name, facts] of Object.entries(expected)) {
    const tool = tools.tools.find(item => item.name === name);
    assert.ok(tool, "MCP 应注册工具：" + name);
    assert.equal(tool.annotations?.readOnlyHint, facts.readOnly, name + " readOnlyHint");
    assert.equal(tool.annotations?.idempotentHint, facts.readOnly, name + " idempotentHint");
    assert.equal(tool.annotations?.destructiveHint, !facts.readOnly, name + " destructiveHint");
    assert.equal(tool.annotations?.openWorldHint, facts.openWorld, name + " openWorldHint（只有直连评审会离开本机）");
  }

  // 证据包：截断、省略与「不内联输出值」都必须穿过 MCP 边界后依然成立。
  const audit = runAuditSchema.parse((await call(client, "get_run_audit", { runId: run.runId, promptLimit: 200, itemSample: 0 })).payload.data);
  assert.equal(audit.runId, run.runId);
  assert.equal(audit.steps[0]!.agent?.prompt?.length, 200);
  assert.equal(audit.steps[0]!.agent?.promptPage.hasMore, true);
  assert.equal(audit.steps[0]!.agent?.nextAction, "get_run");
  assert.doesNotMatch(JSON.stringify(audit), /F:\/|mcp-run/);
  assert.doesNotMatch(JSON.stringify(audit.outputs), /"value"/);
  assert.equal(audit.critiqueSummary.total, 0);
  assert.equal(audit.nextAction, "submit_run_critique");

  // 留一条意见：MCP 边界同样要带 ID 对账，而不是幂等成功。
  const critiqueId = randomUUID();
  const body = { runId: run.runId, critiqueId, verdict: "warn", score: 70, summary: "整体可用", reviewer: "外部质检AI", findings: [], recommendations: ["补失败处理"] };
  const created = runCritiqueEnvelope.parse((await call(client, "submit_run_critique", body)).payload.data);
  assert.equal(created.critique.id, critiqueId);
  assert.equal(created.nextAction, "get_run_critique");
  assert.equal((await call(client, "submit_run_critique", body)).payload.error?.code, "RUN_CRITIQUE_ALREADY_EXISTS");
  // 无效参数在 schema 边界就被拒，不会到达服务。
  for (const args of [{ ...body, critiqueId: randomUUID(), verdict: "great" }, { ...body, critiqueId: randomUUID(), summary: "" }, { ...body, critiqueId: randomUUID(), unknownKey: 1 }, { runId: run.runId, critiqueId: randomUUID(), verdict: "pass", summary: "缺 reviewer", findings: [], recommendations: [] }]) {
    assert.equal((await call(client, "submit_run_critique", args)).isError, true, JSON.stringify(args));
  }

  // 列表只给索引；游标绑定快照，目录变化必须重读第一页。
  const second = await call(client, "submit_run_critique", { ...body, critiqueId: randomUUID(), verdict: "pass", score: 95, findings: [] });
  assert.equal(runCritiqueEnvelope.parse(second.payload.data).critique.verdict, "pass");
  const page = runCritiquePage.parse((await call(client, "list_run_critiques", { runId: run.runId, limit: 1 })).payload.data);
  assert.equal(page.total, 2);
  assert.equal(page.hasMore, true);
  assert.equal(page.items[0]!.findingsOmitted, true);
  const nextPage = runCritiquePage.parse((await call(client, "list_run_critiques", { runId: run.runId, limit: 1, cursor: page.nextCursor })).payload.data);
  assert.notEqual(nextPage.items[0]!.id, page.items[0]!.id);
  await call(client, "submit_run_critique", { ...body, critiqueId: randomUUID(), verdict: "fail" });
  assert.equal((await call(client, "list_run_critiques", { runId: run.runId, limit: 1, cursor: page.nextCursor })).payload.error?.code, "ACCESS_PAGE_CHANGED");
  const detail = runCritiqueEnvelope.parse((await call(client, "get_run_critique", { critiqueId })).payload.data);
  assert.equal(detail.nextAction, "update_run_critique");
  assert.equal((await call(client, "get_run_critique", { critiqueId: randomUUID() })).payload.error?.code, "RUN_CRITIQUE_NOT_FOUND");

  // 状态机经 MCP 同样生效，revision 冲突要显式对账。
  assert.equal((await call(client, "update_run_critique", { critiqueId, revision: detail.critique.revision, status: "fixed" })).payload.error?.code, "RUN_CRITIQUE_STATE_CONFLICT");
  assert.equal((await call(client, "update_run_critique", { critiqueId, revision: 99, status: "accepted" })).payload.error?.code, "RUN_CRITIQUE_REVISION_CONFLICT");
  const accepted = runCritiqueEnvelope.parse((await call(client, "update_run_critique", { critiqueId, revision: detail.critique.revision, status: "accepted", note: "要修" })).payload.data);
  assert.equal(accepted.critique.status, "accepted");
  assert.equal(accepted.nextAction, "preview_rerun");

  // 直连 Hermes 评审：付费操作靠预分配 critiqueId 对账。
  const auditCritiqueId = randomUUID();
  const hermes = runHermesAuditResult.parse((await call(client, "audit_run_with_hermes", { runId: run.runId, critiqueId: auditCritiqueId, focus: "重点看镜头数" })).payload.data);
  assert.equal(hermes.critique.source, "hermes");
  assert.equal(hermes.critique.id, auditCritiqueId);
  assert.equal(hermes.target.profile, "default");
  assert.equal(hermes.promptBytes, 999);
  assert.equal(hermes.nextAction, "get_run_critique");
  assert.equal((await call(client, "audit_run_with_hermes", { runId: run.runId, critiqueId: auditCritiqueId })).payload.error?.code, "RUN_CRITIQUE_ALREADY_EXISTS");
  for (const args of [{ runId: run.runId }, { runId: run.runId, critiqueId: "not-a-uuid" }, { runId: run.runId, critiqueId: randomUUID(), focus: "x".repeat(2001) }]) {
    assert.equal((await call(client, "audit_run_with_hermes", args)).isError, true, JSON.stringify(args));
  }

  // 普通用户凭证不能触达这条通道，即使工具在服务端存在。
  const userTransport = spawn(member.token);
  const userClient = new Client({ name: "isolated-run-quality-user", version: "1.0.0" });
  t.after(() => userClient.close());
  await userClient.connect(userTransport);
  for (const [name, args] of [["get_run_audit", { runId: run.runId }], ["submit_run_critique", body], ["list_run_critiques", { runId: run.runId }], ["audit_run_with_hermes", { runId: run.runId, critiqueId: randomUUID() }]] as Array<[string, Record<string, unknown>]>) {
    const result = await call(userClient, name, args);
    assert.equal(result.isError, true, name + " 不应向普通用户开放");
    assert.equal(result.payload.error?.code, "ADMIN_REQUIRED", name);
  }
});
