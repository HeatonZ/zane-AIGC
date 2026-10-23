import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import express from "express";
import { harness } from "../testing/testSupport.js";
import { WorkspaceService } from "../services/workspaceService.js";
import { AccessService } from "../services/accessService.js";
import { LogBuffer } from "../observability/logger.js";
import { SystemLogService } from "../services/systemLogService.js";
import { createSystemLogRouter } from "../api/systemLogRoutes.js";
import { HttpError } from "../errors.js";
import { opsLogPageSchema, systemLogPageSchema } from "../domain/systemLogContracts.js";
import type { ApiResult } from "./httpClient.js";

/**
 * Real stdio MCP closed loop for the admin log surface: an actual MCP client drives the actual
 * `server/mcp/index.ts` adapter against an isolated HTTP backend, so this covers schema → tool
 * registration → HTTP → service, not just the service in isolation.
 */
test("真实stdio MCP隔离闭环：日志只读工具经MCP分页/筛选/409对账，越界文件名与无效参数被拒", async t => {
  const h = await harness(t);
  const workspace = new WorkspaceService(h.store, path.join(h.root, "workspace.json"));
  t.after(() => workspace.shutdown());
  const access = new AccessService(h.store, workspace, "");
  const buffer = new LogBuffer(50);
  async function createUser(username: string, role: "admin" | "user") {
    const user = (await access.create({ userId: randomUUID(), username, displayName: username, password: "isolated-log-mcp-password", role })).user;
    return { ...(await access.login(username, "isolated-log-mcp-password")), user };
  }
  const admin = await createUser("logmcpadmin", "admin");
  const member = await createUser("logmcpuser", "user");
  await mkdir(h.root, { recursive: true });
  await writeFile(path.join(h.root, "watchdog.log"), "{\"event\":\"backend_ready\"}\n{\"level\":\"error\",\"event\":\"backend_degraded\"}\n", "utf8");
  const app = express();
  app.use(express.json());
  app.use(access.middleware(async () => h.settings.projectDirectory));
  app.use(createSystemLogRouter(new SystemLogService(buffer, h.root)));
  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(error instanceof HttpError ? error.status : 500).json({ error: (error as Error).message, code: error instanceof HttpError ? error.code : "INTERNAL_ERROR", ...(error instanceof HttpError && error.details ? { details: error.details } : {}) });
  });
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => server.once("listening", resolve));
  t.after(() => new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); }));
  const base = "http://127.0.0.1:" + (server.address() as { port: number }).port;

  const transport = new StdioClientTransport({ command: process.execPath, args: ["--import", "tsx", path.resolve("server/mcp/index.ts")], cwd: process.cwd(), env: { ...Object.fromEntries(Object.entries(process.env).filter((item): item is [string, string] => typeof item[1] === "string")), ZANE_BASE_URL: base, ZANE_API_TOKEN: admin.token }, stderr: "pipe" });
  const client = new Client({ name: "isolated-system-logs", version: "1.0.0" });
  t.after(() => client.close());
  await client.connect(transport);

  const tools = await client.listTools();
  for (const name of ["get_system_logs", "get_ops_log"]) {
    const tool = tools.tools.find(item => item.name === name);
    assert.ok(tool, "MCP 应注册工具：" + name);
    // Both are read-only: an AI must not be able to write, rotate or delete logs.
    assert.equal(tool.annotations?.readOnlyHint, true);
    assert.equal(tool.annotations?.idempotentHint, true);
    assert.equal(tool.annotations?.destructiveHint, false);
    assert.equal(tool.annotations?.openWorldHint, false);
  }
  async function call(name: string, args: Record<string, unknown> = {}) {
    const result = await client.callTool({ name, arguments: args });
    const payload = result.structuredContent as ApiResult;
    return { payload, isError: Boolean(result.isError) };
  }

  const runId = "0b2ddab7-5c7c-4c66-9e62-56bf6d083f3b";
  buffer.append("info", "run.queued", { runId, sceneId: "demo", authorization: "Bearer mcp-leak" });
  buffer.append("warn", "hermes.output_json_repaired", { runId, stepId: "aixg" });
  buffer.append("error", "run.execution_failed", { runId, sceneId: "demo", error: "boom" });

  const page = systemLogPageSchema.parse((await call("get_system_logs", { runId })).payload.data);
  assert.equal(page.source, "process");
  assert.equal(page.total, 3);
  assert.equal(page.entries[0]!.event, "run.execution_failed");
  // The credential must not survive the round trip through MCP.
  assert.doesNotMatch(JSON.stringify(page), /mcp-leak/);

  // Filters are real, not decorative: each one narrows the same window.
  assert.equal(systemLogPageSchema.parse((await call("get_system_logs", { level: "error" })).payload.data).total, 1);
  assert.equal(systemLogPageSchema.parse((await call("get_system_logs", { event: "hermes." })).payload.data).total, 1);
  assert.equal(systemLogPageSchema.parse((await call("get_system_logs", { q: "aixg" })).payload.data).total, 1);
  assert.equal(systemLogPageSchema.parse((await call("get_system_logs", { sceneId: "demo" })).payload.data).total, 2);

  // Cursor pagination across the MCP boundary, append-safe: reading the log adds entries of its
  // own, and that must not shift or invalidate the pages.
  const first = systemLogPageSchema.parse((await call("get_system_logs", { limit: 2 })).payload.data);
  assert.equal(first.hasMore, true);
  assert.ok(first.nextCursor);
  const second = systemLogPageSchema.parse((await call("get_system_logs", { limit: 2, cursor: first.nextCursor! })).payload.data);
  assert.deepEqual(first.entries.map(e => e.sequence).filter(id => second.entries.some(e => e.sequence === id)), []);
  // Contiguous pages: the anchor held even though the reads themselves appended entries.
  assert.equal(Math.max(...second.entries.map(e => e.sequence)), Math.min(...first.entries.map(e => e.sequence)) - 1);

  // A cursor used under different filters is rejected as its own error, not reinterpreted.
  const wrongFilter = await call("get_system_logs", { limit: 2, level: "warn", cursor: first.nextCursor! });
  assert.equal(wrongFilter.isError, true);
  assert.equal(wrongFilter.payload.error?.code, "INVALID_LOG_CURSOR");

  // An invalid cursor is rejected rather than silently returning a fresh first page.
  assert.equal((await call("get_system_logs", { cursor: "not-a-cursor" })).isError, true);
  assert.equal((await call("get_system_logs", { cursor: Buffer.from(JSON.stringify({ format: "wrong" })).toString("base64url") })).isError, true);

  // Invalid parameters are rejected at the schema boundary (never reaching the service).
  for (const args of [{ limit: 0 }, { level: "debug" }, { runId: "nope" }, { unknown: 1 }]) {
    assert.equal((await call("get_system_logs", args)).isError, true, JSON.stringify(args));
  }

  const ops = opsLogPageSchema.parse((await call("get_ops_log", { file: "watchdog.log" })).payload.data);
  assert.equal(ops.source, "ops");
  assert.equal(ops.lines.length, 2);
  assert.equal(ops.complete, true);
  assert.deepEqual(ops.available, ["watchdog.log"]);
  const filtered = opsLogPageSchema.parse((await call("get_ops_log", { file: "watchdog.log", level: "error" })).payload.data);
  assert.deepEqual(filtered.lines.map(line => line.lineNumber), [2]);
  const missing = opsLogPageSchema.parse((await call("get_ops_log", { file: "server.stderr.log" })).payload.data);
  assert.equal(missing.missing, true);
  // The file parameter is an allowlist: no traversal, no arbitrary path, no other data file.
  for (const file of ["../../zane.db", "zane.db", "/etc/passwd", "watchdog.log.bak", ""]) {
    assert.equal((await call("get_ops_log", { file })).isError, true, "应拒绝：" + JSON.stringify(file));
  }

  // Read-only means read-only: none of these calls may remove, mutate or compact entries.
  const snapshot = buffer.snapshot();
  assert.equal(snapshot.dropped, 0);
  const appended = snapshot.entries.map(entry => entry.event);
  for (const event of ["run.queued", "hermes.output_json_repaired", "run.execution_failed"]) {
    assert.ok(appended.includes(event), "只读调用后仍应保留已写入的条目：" + event);
  }
  assert.equal((await call("get_system_logs", {})).payload.ok, true);

  // A普通用户 credential must not reach either tool, even though the tools exist on the server.
  const userTransport = new StdioClientTransport({ command: process.execPath, args: ["--import", "tsx", path.resolve("server/mcp/index.ts")], cwd: process.cwd(), env: { ...Object.fromEntries(Object.entries(process.env).filter((item): item is [string, string] => typeof item[1] === "string")), ZANE_BASE_URL: base, ZANE_API_TOKEN: member.token }, stderr: "pipe" });
  const userClient = new Client({ name: "isolated-system-logs-user", version: "1.0.0" });
  t.after(() => userClient.close());
  await userClient.connect(userTransport);
  for (const name of ["get_system_logs", "get_ops_log"]) {
    const result = await userClient.callTool({ name, arguments: name === "get_ops_log" ? { file: "watchdog.log" } : {} });
    assert.equal(result.isError, true, name + " 不应向普通用户开放");
    assert.equal((result.structuredContent as ApiResult).error?.code, "ADMIN_REQUIRED");
  }
});
