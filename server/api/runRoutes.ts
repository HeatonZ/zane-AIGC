import path from "node:path";
import { Router } from "express";
import type { Request, Response } from "express";
import { isRunId } from "../artifacts/runArtifacts.js";
import { isActiveRunStatus } from "../domain/types.js";
import type { RunRecord, RunStatus, SavedSettings } from "../domain/types.js";
import { HttpError } from "../errors.js";
import { RunService } from "../services/runService.js";

function runSummary(run: RunRecord) {
  return { runId: run.runId, sceneId: run.sceneId, workflowName: run.workflowName, runTitle: run.runTitle, status: run.status, startedAt: run.startedAt, createdAt: run.createdAt, finishedAt: run.finishedAt, durationMs: run.durationMs, stepCount: run.steps.length, outputCount: run.outputs.length, error: run.error, artifacts: run.artifacts };
}
function validateId(id: unknown): string { if (typeof id !== "string" || !isRunId(id)) throw new HttpError(400, "运行记录编号无效"); return id; }
export function createRunRouter(service: RunService, loadSettings: () => Promise<SavedSettings>) {
  const router = Router();
  router.use(["/api/v1/runs", "/api/workflows/runs", "/api/workflows/run"], (_request, response, next) => { response.set("Cache-Control", "no-store"); next(); });
  const list = async (request: Request, response: Response) => {
    const { projectDirectory } = await loadSettings();
    if (!projectDirectory) { response.json({ projectDirectory: "", runs: [] }); return; }
    let before: { createdAt: string; runId: string } | undefined;
    if (typeof request.query.cursor === "string") {
      try {
        const cursor = JSON.parse(Buffer.from(request.query.cursor, "base64url").toString("utf8"));
        if (typeof cursor.createdAt !== "string" || typeof cursor.runId !== "string") throw new Error();
        before = cursor;
      } catch { throw new HttpError(400, "运行列表分页游标无效"); }
    }
    const status = typeof request.query.status === "string" ? request.query.status as RunStatus : undefined;
    if (status && !["queued", "running", "cancelling", "completed", "failed", "cancelled", "stale"].includes(status)) throw new HttpError(400, "运行状态筛选无效");
    const limit = request.query.limit === undefined ? 200 : Number(request.query.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new HttpError(400, "分页条数需要是 1–200 的整数");
    const page = await service.listRuns(projectDirectory, { before, limit, status, sceneId: typeof request.query.sceneId === "string" ? request.query.sceneId : undefined });
    response.json({ projectDirectory, runs: page.runs.map(runSummary), ...(page.nextCursor ? { nextCursor: Buffer.from(JSON.stringify(page.nextCursor)).toString("base64url") } : {}) });
  };
  router.get(["/api/v1/runs", "/api/workflows/runs"], list);
  router.post("/api/v1/runs", async (request, response) => {
    const run = await service.submit(request.body);
    response.status(202).json({ runId: run.runId, status: run.status, createdAt: run.createdAt });
  });
  router.post("/api/workflows/run", async (request, response) => {
    const run = await service.submit(request.body);
    const waiter = new AbortController();
    const disconnected = () => waiter.abort(new Error("运行结果等待连接已关闭"));
    response.once("close", disconnected);
    try { response.json(await service.wait(path.dirname(path.dirname(path.dirname(run.artifacts.directory))), run.runId, waiter.signal)); }
    catch (error) { if (!waiter.signal.aborted) throw error; }
    finally { response.off("close", disconnected); }
  });
  router.get(["/api/v1/runs/:runId", "/api/workflows/runs/:runId"], async (request, response) => {
    const { projectDirectory } = await loadSettings();
    const run = await service.getRun(projectDirectory, validateId(request.params.runId));
    if (!run) throw new HttpError(404, "没有找到这条运行记录");
    response.json(run);
  });
  router.post(["/api/v1/runs/:runId/cancel", "/api/workflows/runs/:runId/cancel"], async (request, response) => {
    const { projectDirectory } = await loadSettings();
    response.json(await service.cancel(projectDirectory, validateId(request.params.runId)));
  });
  router.post("/api/v1/runs/:runId/resume", async (request, response) => {
    const { projectDirectory } = await loadSettings();
    const source = await service.getRun(projectDirectory, validateId(request.params.runId));
    if (!source) throw new HttpError(404, "没有找到断点来源运行记录");
    const run = await service.submit({ ...request.body, workflow: source.workflow, inputValues: source.inputValues, runTitle: request.body?.runTitle ?? source.runTitle, resumeFromRunId: source.runId });
    response.status(202).json({ runId: run.runId, status: run.status });
  });
  router.get("/api/v1/runs/:runId/events/history", async (request, response) => {
    const { projectDirectory } = await loadSettings();
    const id = validateId(request.params.runId);
    if (!await service.getRun(projectDirectory, id)) throw new HttpError(404, "没有找到这条运行记录");
    const after = Number(request.query.after ?? 0);
    if (!Number.isSafeInteger(after) || after < 0) throw new HttpError(400, "事件序号无效");
    const events = service.store.events(projectDirectory, id, after);
    response.json({ events, nextSequence: events.at(-1)?.sequence ?? after });
  });
  router.get("/api/v1/runs/:runId/events", async (request, response) => {
    const { projectDirectory } = await loadSettings();
    const id = validateId(request.params.runId);
    const initial = await service.getRun(projectDirectory, id);
    if (!initial) throw new HttpError(404, "没有找到这条运行记录");
    const after = Number(request.get("Last-Event-ID") ?? request.query.after ?? 0);
    if (!Number.isSafeInteger(after) || after < 0) throw new HttpError(400, "事件序号无效");
    response.status(200).set({ "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive", "X-Accel-Buffering": "no" });
    response.flushHeaders();
    let stopped = false;
    let lastSent = -1;
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    let unsubscribe = () => {};
    let unsubscribeShutdown = () => {};
    const close = () => { if (stopped) return; stopped = true; if (heartbeat) clearInterval(heartbeat); unsubscribe(); unsubscribeShutdown(); request.off("close", close); response.end(); };
    const write = (sequence: number, data: unknown) => {
      if (stopped || response.destroyed) return false;
      if (sequence < lastSent) return true;
      lastSent = sequence;
      const buffered = response.write(`id: ${sequence}\ndata: ${JSON.stringify(data)}\n\n`);
      if (!buffered) close(); // Bound slow-client memory; reconnect replays the durable cursor.
      return buffered;
    };
    // All store reads here are synchronous; subscribe + replay cannot lose an intervening event.
    unsubscribe = service.subscribe(projectDirectory, id, (run, event) => {
      if (event.sequence <= lastSent) return;
      write(event.sequence, { event, run });
      if (!isActiveRunStatus(run.status)) close();
    });
    unsubscribeShutdown = service.onShutdown(close);
    request.once("close", close);
    if (after > 0) {
      let cursor = after;
      for (;;) {
        const events = service.store.events(projectDirectory, id, cursor);
        if (!events.length) break;
        for (const event of events) { if (!write(event.sequence, { event })) break; cursor = event.sequence; }
        if (stopped || events.length < 1000) break;
      }
    }
    const run = service.store.getRun(projectDirectory, id) ?? initial;
    write(service.store.latestSequence(projectDirectory, id), { event: { type: "run.snapshot", runId: id }, run });
    if (!isActiveRunStatus(run.status)) close();
    else if (!stopped) { heartbeat = setInterval(() => { if (!response.write(": heartbeat\n\n")) close(); }, 15000); heartbeat.unref(); }
  });
  return router;
}
