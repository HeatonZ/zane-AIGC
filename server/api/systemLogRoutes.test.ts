import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import express from "express";
import { harness } from "../testing/testSupport.js";
import { WorkspaceService } from "../services/workspaceService.js";
import { AccessService } from "../services/accessService.js";
import { LogBuffer } from "../observability/logger.js";
import { SystemLogService } from "../services/systemLogService.js";
import { createSystemLogRouter } from "../api/systemLogRoutes.js";
import { HttpError } from "../errors.js";
import { systemLogPageSchema, opsLogPageSchema } from "../domain/systemLogContracts.js";

/**
 * HTTP surface for the admin log viewer, wired to the same access middleware production uses.
 * The data directory is the harness root so the ops-log allowlist can be exercised for real.
 */
async function logHarness(t: Parameters<typeof harness>[0]) {
  const h = await harness(t);
  const workspace = new WorkspaceService(h.store, path.join(h.root, "workspace.json"));
  t.after(() => workspace.shutdown());
  const access = new AccessService(h.store, workspace, "");
  const buffer = new LogBuffer(50);
  async function createUser(username: string, role: "admin" | "user") {
    const user = (await access.create({ userId: randomUUID(), username, displayName: username, password: "isolated-system-log-password", role })).user;
    const session = await access.login(username, "isolated-system-log-password");
    return { ...session, user };
  }
  const admin = await createUser("logadmin", "admin");
  const user = await createUser("loguser", "user");
  const app = express();
  app.use(express.json());
  app.use(access.middleware(async () => h.settings.projectDirectory));
  app.use(createSystemLogRouter(new SystemLogService(buffer, h.root)));
  // Mirrors production `errorResponse`: domain errors keep their code AND details, which is
  // what makes RUN/LOG conflict recovery actionable (`details.currentRevision`).
  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(error instanceof HttpError ? error.status : 500).json({ error: (error as Error).message, code: error instanceof HttpError ? error.code : "INTERNAL_ERROR", ...(error instanceof HttpError && error.details ? { details: error.details } : {}) });
  });
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => server.once("listening", resolve));
  t.after(() => new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); }));
  const base = "http://127.0.0.1:" + (server.address() as { port: number }).port;
  async function get(route: string, token = admin.token) {
    const response = await fetch(base + route, { headers: token ? { Authorization: "Bearer " + token } : {} });
    return { response, data: await response.json().catch(() => undefined) as any };
  }
  return { ...h, base, buffer, access, admin, user, get };
}

const runId = "0b2ddab7-5c7c-4c66-9e62-56bf6d083f3b";

test("日志HTTP：管理员可读且响应符合契约，未认证401、普通用户403", async t => {
  const h = await logHarness(t);
  h.buffer.append("info", "http.request", { requestId: "r1", method: "GET", path: "/api/health", status: 200, authorization: "Bearer leak-me" });
  h.buffer.append("error", "run.execution_failed", { runId, sceneId: "demo", error: "boom" });

  const ok = await h.get("/api/v1/maintenance/logs");
  assert.equal(ok.response.status, 200);
  assert.equal(ok.response.headers.get("cache-control"), "no-store");
  const page = systemLogPageSchema.parse(ok.data);
  assert.equal(page.source, "process");
  assert.equal(page.total, 2);
  assert.equal(page.entries[0]!.event, "run.execution_failed");
  // The credential never reaches an authenticated reader through this surface.
  assert.doesNotMatch(JSON.stringify(ok.data), /leak-me/);
  assert.equal(page.entries[1]!.fields.authorization, "[REDACTED]");

  assert.equal((await h.get("/api/v1/maintenance/logs", "")).response.status, 401);
  assert.equal((await h.get("/api/v1/maintenance/logs", h.user.token)).response.status, 403);
  assert.equal((await h.get("/api/v1/maintenance/logs/ops", h.user.token)).response.status, 403);
  assert.equal((await h.get("/api/v1/maintenance/logs/ops", "")).response.status, 401);
});

test("日志HTTP：筛选经查询串生效，无效参数400且不静默忽略未知键", async t => {
  const h = await logHarness(t);
  h.buffer.append("info", "run.queued", { runId, sceneId: "demo" });
  h.buffer.append("warn", "hermes.output_json_repaired", { runId, stepId: "aixg" });
  h.buffer.append("error", "comfy.failed", { sceneId: "other" });

  assert.equal((await h.get("/api/v1/maintenance/logs?runId=" + runId)).data.total, 2);
  // sceneId=demo matches only the entry that actually carries that sceneId.
  assert.equal((await h.get("/api/v1/maintenance/logs?sceneId=demo")).data.total, 1);
  assert.equal((await h.get("/api/v1/maintenance/logs?sceneId=other")).data.total, 1);
  assert.equal((await h.get("/api/v1/maintenance/logs?level=warn")).data.total, 2);
  assert.equal((await h.get("/api/v1/maintenance/logs?event=hermes.")).data.total, 1);
  assert.equal((await h.get("/api/v1/maintenance/logs?q=aixg")).data.total, 1);
  const limited = await h.get("/api/v1/maintenance/logs?limit=1");
  assert.equal(limited.data.entries.length, 1);
  assert.equal(limited.data.total, 3);
  assert.equal(limited.data.hasMore, true);

  for (const suffix of ["?limit=0", "?limit=201", "?level=debug", "?runId=nope", "?file=watchdog.log", "?userId=admin", "?unknown=1"]) {
    const result = await h.get("/api/v1/maintenance/logs" + suffix);
    assert.equal(result.response.status, 400, suffix);
    assert.equal(result.data.code, "INVALID_LOG_REQUEST");
  }
  // A malformed cursor is its own error: it says the cursor — not the filter — was wrong.
  const cursor = await h.get("/api/v1/maintenance/logs?cursor=bad");
  assert.equal(cursor.response.status, 400);
  assert.equal(cursor.data.code, "INVALID_LOG_CURSOR");
});

test("日志HTTP：翻页追加安全；条目被挤出才409 LOG_PAGE_CHANGED 且提示重读第一页", async t => {
  const h = await logHarness(t);
  for (let index = 0; index < 5; index += 1) h.buffer.append("info", "run.event", { index });
  const first = await h.get("/api/v1/maintenance/logs?limit=2");
  assert.equal(first.data.hasMore, true);
  assert.equal(first.data.total, 5);
  const cursor = first.data.nextCursor as string;

  // Reading the log appends an http.request entry (as production does). Appends must NOT
  // invalidate the cursor: this is the difference between usable and unusable pagination.
  h.buffer.append("info", "http.request", { path: "/api/v1/maintenance/logs", status: 200 });
  const second = await h.get("/api/v1/maintenance/logs?limit=2&cursor=" + encodeURIComponent(cursor));
  assert.equal(second.response.status, 200);
  assert.equal(second.data.entries.length, 2);
  // No overlap and no gap: the keyset anchor held across the append.
  const firstSequences = first.data.entries.map((entry: { sequence: number }) => entry.sequence);
  const secondSequences = second.data.entries.map((entry: { sequence: number }) => entry.sequence);
  assert.deepEqual(firstSequences.filter((id: number) => secondSequences.includes(id)), []);
  assert.equal(Math.max(...secondSequences), Math.min(...firstSequences) - 1);

  // Eviction is the real invalidation: unread entries are gone, so the cursor must be refused
  // with an actionable code instead of silently returning a spliced or empty page.
  const small = new LogBuffer(4);
  const h2 = await logHarness(t);
  const service = new SystemLogService(small, h2.root);
  const router = createSystemLogRouter(service);
  const app2 = express();
  app2.use(router);
  app2.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(error instanceof HttpError ? error.status : 500).json({ code: error instanceof HttpError ? error.code : "INTERNAL_ERROR", ...(error instanceof HttpError && error.details ? { details: error.details } : {}) });
  });
  const server2 = app2.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => server2.once("listening", resolve));
  t.after(() => new Promise<void>(resolve => { server2.close(() => resolve()); server2.closeAllConnections(); }));
  const base2 = "http://127.0.0.1:" + (server2.address() as { port: number }).port;
  const read2 = async (suffix: string) => { const response = await fetch(base2 + "/api/v1/maintenance/logs" + suffix); return { status: response.status, data: await response.json() as any }; };
  for (let index = 0; index < 4; index += 1) small.append("info", "run.event", { index });
  const page = await read2("?limit=2");
  assert.ok(page.data.nextCursor);
  small.append("error", "run.execution_failed", { index: 99 });
  small.append("error", "run.execution_failed", { index: 100 });
  const stale = await read2("?limit=2&cursor=" + encodeURIComponent(page.data.nextCursor));
  assert.equal(stale.status, 409);
  assert.equal(stale.data.code, "LOG_PAGE_CHANGED");
  assert.ok(stale.data.details?.currentRevision);
  assert.ok(stale.data.details?.retainedFromSequence);
});

test("日志HTTP：运维日志尾部可读且越界文件名400，missing不当作失败", async t => {
  const h = await logHarness(t);
  await mkdir(h.root, { recursive: true });
  await writeFile(path.join(h.root, "watchdog.log"), ["{\"event\":\"backend_ready\"}", "{\"level\":\"error\",\"event\":\"backend_degraded\"}"].join("\n"), "utf8");
  await appendFile(path.join(h.root, "watchdog.log"), "\n{\"event\":\"third\"}", "utf8");
  // A credential in the ops log must not be readable through the admin route either.
  await writeFile(path.join(h.root, "server.stderr.log"), "api_key=should-not-leak\n", "utf8");

  const ok = await h.get("/api/v1/maintenance/logs/ops?file=watchdog.log");
  assert.equal(ok.response.status, 200);
  const page = opsLogPageSchema.parse(ok.data);
  assert.equal(page.source, "ops");
  assert.equal(page.lines.length, 3);
  assert.equal(page.complete, true);
  assert.ok(page.available.includes("watchdog.log"));

  const redacted = await h.get("/api/v1/maintenance/logs/ops?file=server.stderr.log");
  assert.doesNotMatch(JSON.stringify(redacted.data), /should-not-leak/);

  const tail = await h.get("/api/v1/maintenance/logs/ops?file=watchdog.log&tailLines=1");
  assert.equal(tail.data.lines.length, 1);
  assert.equal(tail.data.complete, false);

  const missing = await h.get("/api/v1/maintenance/logs/ops?file=zane-server.stdout.log");
  assert.equal(missing.response.status, 200);
  assert.equal(missing.data.missing, true);

  for (const suffix of ["", "?file=zane.db", "?file=../../zane.db", "?file=watchdog.log.bak", "?file=watchdog.log&tailLines=0", "?file=watchdog.log&tailLines=5000"]) {
    const result = await h.get("/api/v1/maintenance/logs/ops" + suffix);
    assert.equal(result.response.status, 400, suffix);
    assert.equal(result.data.code, "INVALID_LOG_REQUEST");
  }
});
