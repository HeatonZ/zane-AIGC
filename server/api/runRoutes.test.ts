import assert from "node:assert/strict";
import test from "node:test";
import type { TestContext } from "node:test";
import express from "express";
import http from "node:http";
import { createRunRouter } from "./runRoutes.js";
import { harness, id, submission, deferred, until, workflow } from "../testing/testSupport.js";
import type { RunService } from "../services/runService.js";
import type { RunRecord, SavedSettings } from "../domain/types.js";
import { HttpError } from "../errors.js";

interface SseLifecycleTrace {
  requestAborted: boolean;
  requestClosed: boolean;
  responseFinished: boolean;
  responseClosed: boolean;
  backpressured: boolean;
}
async function listen(t: TestContext, service: RunService, settings: SavedSettings, onSseTrace?: (trace: SseLifecycleTrace) => void, identity?: { id: string; username: string; displayName: string }, resolveSubmitter?: (userId: string) => { userId: string; username: string; displayName: string } | undefined) {
  const app = express();
  app.use((request, response, next) => {
    if (request.path.endsWith("/events") && onSseTrace) {
      const trace: SseLifecycleTrace = { requestAborted: false, requestClosed: false, responseFinished: false, responseClosed: false, backpressured: false };
      onSseTrace(trace);
      request.once("aborted", () => { trace.requestAborted = true; });
      request.once("close", () => { trace.requestClosed = true; });
      response.once("finish", () => { trace.responseFinished = true; });
      response.once("close", () => { trace.responseClosed = true; });
      const write = response.write.bind(response);
      response.write = ((...args: Parameters<typeof response.write>) => {
        const accepted = write(...args);
        if (!accepted) trace.backpressured = true;
        return accepted;
      }) as typeof response.write;
    }
    next();
  });
  app.use(express.json());
  app.use((_request, response, next) => { if (identity) { response.locals.identity = identity; response.locals.authorizeAdmin = () => {}; } next(); });
  app.use(createRunRouter(service, async () => settings, resolveSubmitter));
  app.use((error: unknown, _request: express.Request, response: express.Response, _next: express.NextFunction) => {
    response.status(error instanceof HttpError ? error.status : 500).json({ error: String(error) });
  });
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  t.after(() => new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); }));
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}

function frames(text: string): Array<{ id: number; data: { event: { type: string; sequence?: number }; run?: RunRecord } }> {
  return text.split("\n\n").filter((part) => part.startsWith("id:")).map((part) => ({ id: Number(part.split("\n")[0].slice(4)), data: JSON.parse(part.split("\n").find((line) => line.startsWith("data:"))!.slice(6)) }));
}

test("v1 异步提交返回 202；SSE 重连按 Last-Event-ID 回放且单调有序", async (t) => {
  const gate = deferred<void>();
  const { service, store, settings } = await harness(t, { executor: { kind: "fake", async execute() { await gate.promise; return { value: "done" }; } } });
  await service.start();
  const base = await listen(t, service, settings);
  const response = await fetch(`${base}/api/v1/runs`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(submission(id("sse"))) });
  assert.equal(response.status, 202);
  assert.equal((await response.json() as { status: string }).status, "queued");
  const controller = new AbortController();
  const live = await fetch(`${base}/api/v1/runs/${id("sse")}/events`, { signal: controller.signal });
  assert.match(live.headers.get("content-type")!, /text\/event-stream/);
  const reader = live.body!.getReader();
  const first = await reader.read();
  const firstFrame = frames(new TextDecoder().decode(first.value))[0];
  assert.ok(firstFrame.data.run);
  controller.abort();
  await reader.cancel().catch(() => undefined);
  gate.resolve();
  await service.wait(settings.projectDirectory, id("sse"));
  const replay = await fetch(`${base}/api/v1/runs/${id("sse")}/events`, { headers: { "Last-Event-ID": String(firstFrame.id) } });
  const events = frames(await replay.text());
  assert.equal(events.at(-1)?.data.run?.status, "completed");
  assert.ok(events.some((event) => event.data.event.type === "run.completed"));
  assert.ok(events.every((event, index) => event.id >= firstFrame.id && (!index || event.id >= events[index - 1].id)));
  const history = await fetch(`${base}/api/v1/runs/${id("sse")}/events/history?after=${firstFrame.id}`).then((result) => result.json()) as { events: unknown[] };
  assert.deepEqual(history.events, store.events(settings.projectDirectory, id("sse"), firstFrame.id));
  await until(() => service.metrics().subscribers === 0);
});

test("人工确认后大运行快照不会因 SSE 写入背压主动断开", async (t) => {
  const gate = deferred<void>(); let continuationStarted = false; let lifecycle: SseLifecycleTrace | undefined;
  const h = await harness(t, { executor: { kind: "fake", async execute(context) {
    if (context.step.id === "reviewed") return { value: "x".repeat(40 * 1024) };
    continuationStarted = true; await gate.promise; return { value: "continued" };
  } } });
  await h.service.start(); const base = await listen(t, h.service, h.settings, trace => { lifecycle = trace; });
  const definition = workflow([
    { id: "reviewed", name: "待确认步骤", kind: "fake", inputs: [], outputs: [{ key: "value", type: "text" }], review: { enabled: true } },
    { id: "continuation", name: "确认后步骤", kind: "fake", inputs: [], outputs: [{ key: "value", type: "text" }] },
  ]);
  const accepted = await h.service.submit(submission(id("sse-review-large"), definition));
  const waiting = await h.service.wait(h.settings.projectDirectory, accepted.runId);
  assert.equal(waiting.status, "waiting"); assert.ok(waiting.pendingReview);
  const reviewed = await fetch(`${base}/api/v1/runs/${accepted.runId}/review`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ reviewId: waiting.pendingReview!.id, action: "approve" }) });
  assert.equal(reviewed.status, 202);
  await until(() => continuationStarted);

  const controller = new AbortController(); const live = await fetch(`${base}/api/v1/runs/${accepted.runId}/events`, { signal: controller.signal });
  const reader = live.body!.getReader();
  try {
    const first = await reader.read(); assert.ok(first.value);
    let streamEnded = false;
    const drain = (async () => { while (true) { const next = await reader.read(); if (next.done) { streamEnded = true; return; } } })();
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(lifecycle?.backpressured, true, "人工确认回放的大快照应覆盖 Node 响应高水位，验证 drain 路径");
    assert.equal(streamEnded, false, "活动运行的 SSE 应保持连接，而不是把 write() 返回 false 当成断线");
    assert.equal(lifecycle?.requestAborted, false);
    assert.equal(lifecycle?.responseFinished, false, "服务端不应仅因 write() 返回 false 就正常结束 SSE 响应");
    assert.equal(lifecycle?.responseClosed, false, "背压期间响应不能提前关闭");
    controller.abort(); await reader.cancel().catch(() => undefined); await drain.catch(() => undefined);
  } finally { gate.resolve(); controller.abort(); }
  await h.service.wait(h.settings.projectDirectory, accepted.runId);
});

test("旧同步接口断开 HTTP 连接也不会取消执行", async (t) => {
  const gate = deferred<void>(); let executing = false;
  const { service, settings } = await harness(t, { executor: { kind: "fake", async execute() { executing = true; await gate.promise; return { value: "done" }; } } });
  await service.start(); const base = await listen(t, service, settings);
  const request = http.request(`${base}/api/workflows/run`, { method: "POST", headers: { "Content-Type": "application/json" } });
  request.on("error", () => {});
  request.end(JSON.stringify(submission(id("http-disconnect"))));
  await until(() => executing);
  request.destroy(); gate.resolve();
  assert.equal((await service.wait(settings.projectDirectory, id("http-disconnect"))).status, "completed");
});

test("运行记录归属来自已验证身份，管理员列表和详情显示稳定提交人", async (t) => {
  const { service, store, settings } = await harness(t);
  const identity = { id: id("verified-submitter"), username: "alice", displayName: "Alice" };
  const base = await listen(t, service, settings, undefined, identity, userId => userId === identity.id ? { userId: identity.id, username: identity.username, displayName: identity.displayName } : undefined);
  const runId = id("verified-submitter-run");
  const response = await fetch(`${base}/api/v1/runs`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...submission(runId), ownerUserId: "spoofed", submitter: { userId: "spoofed", username: "intruder", displayName: "Intruder" } }) });
  assert.equal(response.status, 202);
  const accepted = store.getRun(settings.projectDirectory, runId)!;
  assert.equal(accepted.ownerUserId, identity.id);
  assert.deepEqual(accepted.submitter, { userId: identity.id, username: identity.username, displayName: identity.displayName });
  const page = await fetch(`${base}/api/v1/runs?limit=10`).then(response => response.json()) as { runs: Array<{ runId: string; ownerUserId?: string; submitter?: unknown }> };
  assert.equal(page.runs.find(run => run.runId === runId)?.ownerUserId, identity.id);
  assert.deepEqual(page.runs.find(run => run.runId === runId)?.submitter, accepted.submitter);
  const detail = await fetch(`${base}/api/v1/runs/${runId}`).then(response => response.json()) as RunRecord;
  assert.deepEqual(detail.submitter, accepted.submitter);

  const legacy = { ...accepted, runId: id("legacy-submitter-run"), ownerUserId: identity.id, submitter: undefined, status: "completed" as const };
  store.importRun(settings.projectDirectory, legacy);
  const legacyDetail = await fetch(`${base}/api/v1/runs/${legacy.runId}`).then(response => response.json()) as RunRecord;
  assert.deepEqual(legacyDetail.submitter, accepted.submitter, "legacy owned runs resolve display name without rewriting their record");
  assert.equal(store.getRun(settings.projectDirectory, legacy.runId)?.submitter, undefined);
});

test("游标分页以时间和 ID 稳定排序，支持筛选且无重复遗漏", async (t) => {
  const { service, store, settings } = await harness(t);
  const seed = await service.submit(submission(id("seed")));
  for (let index = 0; index < 7; index++) store.importRun(settings.projectDirectory, { ...seed, runId: id(`page-${index}`), status: "completed", sceneId: "page-scene", createdAt: "2026-09-30T00:00:00.000Z" });
  const base = await listen(t, service, settings);
  const found: string[] = []; let cursor: string | undefined;
  do {
    const page: { runs: Array<{ runId: string }>; nextCursor?: string } = await fetch(`${base}/api/v1/runs?limit=2&status=completed&sceneId=page-scene${cursor ? `&cursor=${cursor}` : ""}`).then((response) => response.json()) as never;
    found.push(...page.runs.map((run) => run.runId)); cursor = page.nextCursor;
  } while (cursor);
  assert.equal(found.length, 7); assert.equal(new Set(found).size, 7);
  assert.deepEqual(found, [...found].sort().reverse());
  assert.equal((await fetch(`${base}/api/v1/runs?cursor=broken`)).status, 400);
  assert.equal((await fetch(`${base}/api/v1/runs?limit=0`)).status, 400);
  assert.equal((await fetch(`${base}/api/v1/runs?status=invalid`)).status, 400);
  assert.equal((await fetch(`${base}/api/v1/runs/${id("missing")}/events`)).status, 404);
});


test("局部重做 HTTP：预览无生成副作用，提交 202 且原版本保留", async (t) => {
  let calls = 0;
  const h = await harness(t, { executor: { kind: "fake", async execute() { calls++; return { value: "原结果" }; } } });
  await h.service.start(); const base = await listen(t, h.service, h.settings);
  const initial = await h.service.submit(submission(id("rerun-http-source")));
  const original = await h.service.wait(h.settings.projectDirectory, initial.runId); calls = 0;
  const changes = { outputOverrides: [{ stepId: "first", outputs: { value: "修订结果" } }] };
  const preview = await fetch(base + "/api/v1/runs/" + original.runId + "/rerun/preview", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ changes }) });
  assert.equal(preview.status, 200); assert.equal(calls, 0);
  assert.equal((await preview.json() as { steps: Array<{ action: string }> }).steps[0].action, "replace");
  const response = await fetch(base + "/api/v1/runs/" + original.runId + "/rerun", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ changes, runId: id("rerun-http-revised") }) });
  assert.equal(response.status, 202);
  const revised = await h.service.wait(h.settings.projectDirectory, id("rerun-http-revised"));
  assert.equal(revised.outputs[0].value, "修订结果"); assert.equal(revised.rerunFromRunId, original.runId); assert.equal(calls, 0);
  assert.equal((await h.service.getRun(h.settings.projectDirectory, original.runId))!.outputs[0].value, "原结果");
  const missing = await fetch(base + "/api/v1/runs/" + id("missing-rerun") + "/rerun/preview", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ changes }) });
  assert.equal(missing.status, 404);
});

test("读取提交准备中的运行返回可重试状态，而不是错误地报告不存在", async t => {
  const h = await harness(t); const gate = deferred<void>(); let entered = false;
  const { RunService: Service } = await import("../services/runService.js");
  const service = new Service({ store: h.store, executors: h.executors, loadSettings: async () => h.settings,
    async resolveAssets(_project, _workflow, values) { entered = true; await gate.promise; return values; } });
  t.after(() => service.shutdown(0)); const base = await listen(t, service, h.settings);
  const runId = id("reading-preparing-run"); const pending = service.submit(submission(runId));
  await until(() => entered);
  try {
    const response = await fetch(base + "/api/v1/runs/" + runId);
    assert.equal(response.status, 409); assert.equal(response.headers.get("retry-after"), "1");
    assert.match((await response.json() as { error: string }).error, /准备素材/);
  } finally { gate.resolve(); }
  await pending;
  assert.equal((await fetch(base + "/api/v1/runs/" + runId)).status, 200);
  assert.equal((await fetch(base + "/api/v1/runs/" + id("genuinely-missing"))).status, 404);
});
