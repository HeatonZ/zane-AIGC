import assert from "node:assert/strict";
import test from "node:test";
import type { TestContext } from "node:test";
import express from "express";
import http from "node:http";
import { createRunRouter } from "./runRoutes.js";
import { harness, id, submission, deferred, until } from "../testing/testSupport.js";
import type { RunService } from "../services/runService.js";
import type { RunRecord, SavedSettings } from "../domain/types.js";
import { HttpError } from "../errors.js";

async function listen(t: TestContext, service: RunService, settings: SavedSettings) {
  const app = express();
  app.use(express.json());
  app.use(createRunRouter(service, async () => settings));
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
