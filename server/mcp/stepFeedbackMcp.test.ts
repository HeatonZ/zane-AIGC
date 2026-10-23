import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { randomUUID } from "node:crypto";
import express from "express";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { harness, id } from "../testing/testSupport.js";
import { WorkspaceService } from "../services/workspaceService.js";
import { AccessService } from "../services/accessService.js";
import { RunQualityService } from "../services/runQualityService.js";
import { StepFeedbackService } from "../services/stepFeedbackService.js";
import { createQualityRouter } from "../api/qualityRoutes.js";
import { HttpError } from "../errors.js";
import type { RunRecord } from "../domain/types.js";
import type { ApiResult } from "./httpClient.js";

/** 真实 stdio MCP 闭环：证明 request_step_agent_feedback 从工具目录、参数 schema、HTTP 路由到
 *  业务服务的链路是通的，并且「不重做」不是靠说明文字保证，而是运行记录确实没被写过。 */

const password = "step-feedback-password";

function fixtureRun(): RunRecord {
  return {
    runId: id("mcp-step-feedback-run"), sceneId: "demo", workflowName: "反馈闭环", status: "completed",
    createdAt: "2026-10-17T00:00:00.000Z", startedAt: "2026-10-17T00:00:00.000Z", finishedAt: "2026-10-17T00:01:00.000Z",
    workflow: {
      inputs: [{ key: "brief", type: "text", required: true }],
      steps: [{ id: "writer", name: "写分镜", kind: "hermes", hermesProfile: "default", inputs: [{ key: "brief", sourceRef: "input.brief" }], outputs: [{ key: "storyboard", type: "json" }] }],
      outputs: [{ key: "final", type: "json", sourceRef: "step.writer.outputs.storyboard" }],
    },
    inputValues: { brief: "三镜短片" },
    steps: [{ stepId: "writer", name: "写分镜", status: "completed", agentPrompt: "ORIGINAL-PROMPT", outputs: { storyboard: { shots: 3 } }, outputTypes: { storyboard: "json" } }],
    outputs: [{ key: "final", label: "分镜", type: "json", value: { shots: 3 } }],
    artifacts: { directory: path.join("F:", "runs", "mcp-feedback"), inputs: "", workflow: "", runtime: "", output: "" },
  };
}

async function connect(t: Parameters<typeof harness>[0], base: string, token: string) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", "tsx", path.resolve("server/mcp/index.ts")],
    cwd: process.cwd(),
    env: { ...Object.fromEntries(Object.entries(process.env).filter((item): item is [string, string] => typeof item[1] === "string")), ZANE_BASE_URL: base, ZANE_API_TOKEN: token },
    stderr: "pipe",
  });
  let errors = "";
  transport.stderr?.on("data", chunk => { errors += chunk; });
  const client = new Client({ name: "step-feedback-mcp-test", version: "1.0.0" });
  t.after(async () => { await client.close(); });
  try { await client.connect(transport); } catch (error) { throw new Error(String(error) + "\n" + errors); }
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const result = await client.callTool({ name, arguments: args });
    assert.ok("content" in result);
    // MCP SDK 会先用 inputSchema 校验参数：被 schema 拒绝的调用没有 structuredContent，
    // 只有 isError 与文本原因。两种情况都如实带回，测试按真实行为断言。
    const text = Array.isArray(result.content) ? result.content.map(part => "text" in part ? part.text : "").join("") : "";
    return { payload: result.structuredContent as ApiResult | undefined, isError: result.isError === true, text };
  };
  return { client, call };
}

async function harnessWithMcp(t: Parameters<typeof harness>[0]) {
  const h = await harness(t);
  const workspace = new WorkspaceService(h.store, path.join(h.root, "workspace.json"));
  t.after(() => workspace.shutdown());
  const access = new AccessService(h.store, workspace, "");
  const user = (await access.create({ userId: randomUUID(), username: "feedback-admin", displayName: "反馈管理员", password, role: "admin" })).user;
  const token = (await access.login("feedback-admin", password)).token;
  const run = fixtureRun();
  h.store.importRun(h.settings.projectDirectory, run);
  const feedback = new StepFeedbackService({
    loadSettings: async () => h.settings,
    getRun: async (project, runId) => h.store.getRun(project, runId),
    runner: { runStepFeedback: async () => ({ raw: '{"storyboard":{"shots":4}}', outputs: { storyboard: { shots: 4 } } }) },
  });
  const quality = new RunQualityService(access, async () => h.settings, async (project, runId) => h.store.getRun(project, runId), () => false);
  const app = express();
  app.use(express.json());
  app.use(access.middleware(async () => h.settings.projectDirectory));
  app.use(createQualityRouter(quality, feedback));
  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => res.status(error instanceof HttpError ? error.status : 500).json({ error: (error as Error).message, code: error instanceof HttpError ? error.code : "INTERNAL_ERROR", ...(error instanceof HttpError && error.details ? { details: error.details } : {}) }));
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => server.once("listening", resolve));
  t.after(() => new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); }));
  const base = "http://127.0.0.1:" + (server.address() as { port: number }).port;
  return { ...h, run, token, user, mcp: await connect(t, base, token) };
}

test("真实stdio MCP：步骤级反馈带上下文交给 Agent，返回修订结果且不写运行记录", async t => {
  const h = await harnessWithMcp(t);
  const tools = await h.mcp.client.listTools();
  const tool = tools.tools.find(candidate => candidate.name === "request_step_agent_feedback");
  assert.ok(tool, "新操作必须出现在 tools/list 里");
  assert.equal(tool.annotations?.readOnlyHint, false);
  assert.equal(tool.annotations?.openWorldHint, true, "会真实调用模型，必须声明为接触外部世界");
  assert.ok(tool.inputSchema.required?.includes("runId"));
  assert.ok(tool.inputSchema.required?.includes("stepId"));
  assert.ok(tool.inputSchema.required?.includes("message"));
  const before = structuredClone(h.store.getRun(h.settings.projectDirectory, h.run.runId)!);

  const result = await h.mcp.call("request_step_agent_feedback", {
    runId: h.run.runId, stepId: "writer", message: "第二镜节奏太慢",
    context: { observation: "前 3 秒没有动作", expectation: "第 1 秒进冲突" },
  });
  assert.equal(result.payload?.ok, true, JSON.stringify(result.payload?.error));
  const data = result.payload!.data as Record<string, any>;
  assert.equal(data.stepId, "writer");
  assert.deepEqual(data.outputs, { storyboard: { shots: 4 } });
  assert.deepEqual(data.originalOutputs, { storyboard: { shots: 3 } });
  assert.match(data.context.feedback, /期望结果：第 1 秒进冲突/);
  assert.equal(data.agentPromptOmitted, true);
  assert.ok(!JSON.stringify(data).includes("ORIGINAL-PROMPT"), "MCP 响应同样不得回传完整提示词");

  // 不重做：MCP 闭环后运行记录仍然逐字节不变（没有新运行、没有 feedbackHistory、没有 revision 变化）。
  assert.deepEqual(h.store.getRun(h.settings.projectDirectory, h.run.runId), before);
  assert.equal(h.store.listRuns(h.settings.projectDirectory).runs.length, 1);

  // 参数校验也走同一条 schema：未知字段与空反馈由 MCP 客户端 schema 直接拒绝（没有业务响应，
  // 更不会发出付费请求）；目标不存在这类业务错误经结构化回执返回。
  const unknown = await h.mcp.call("request_step_agent_feedback", { runId: h.run.runId, stepId: "writer", message: "意见", unknownKey: 1 });
  assert.equal(unknown.isError, true);
  assert.equal(unknown.payload, undefined);
  assert.match(unknown.text, /unknownKey|unrecognized|Invalid|validation/i);
  const blank = await h.mcp.call("request_step_agent_feedback", { runId: h.run.runId, stepId: "writer", message: "   " });
  assert.equal(blank.isError, true);
  assert.equal(blank.payload, undefined, "空反馈在 schema 层就被拒绝，不会到达业务服务");
  const missing = await h.mcp.call("request_step_agent_feedback", { runId: h.run.runId, stepId: "ghost", message: "意见" });
  assert.equal(missing.payload?.error?.code, "STEP_FEEDBACK_STEP_NOT_FOUND");
});
