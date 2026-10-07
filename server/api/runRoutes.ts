import path from "node:path";
import { Router } from "express";
import type { Request, Response } from "express";
import { isRunId } from "../artifacts/runArtifacts.js";
import { isActiveRunStatus } from "../domain/types.js";
import type { RunRecord, RunStatus, RunSubmitter, SavedSettings } from "../domain/types.js";
import { runSubmitter } from "../services/accessService.js";
import { HttpError } from "../errors.js";
import { RunService } from "../services/runService.js";

type RunSubmitterResolver = (userId: string) => RunSubmitter | undefined;
type RunResponse = RunRecord & { submitter?: RunSubmitter };
function decorateRun(run: RunRecord, resolveSubmitter?: RunSubmitterResolver): RunResponse {
  if (run.submitter || !run.ownerUserId || !resolveSubmitter) return run;
  const submitter = resolveSubmitter(run.ownerUserId);
  return submitter ? { ...run, submitter } : run;
}
function runSummary(run: RunRecord, resolveSubmitter?: RunSubmitterResolver) {
  const view = decorateRun(run, resolveSubmitter);
  return { ownerUserId: view.ownerUserId, ...(view.submitter ? { submitter: view.submitter } : {}), runId: view.runId, sceneId: view.sceneId, workflowName: view.workflowName, runTitle: view.runTitle, status: view.status, startedAt: view.startedAt, createdAt: view.createdAt, finishedAt: view.finishedAt, durationMs: view.durationMs, stepCount: view.steps.length, outputCount: view.outputs.length, error: view.error, artifacts: view.artifacts };
}
function validateId(id: unknown): string { if (typeof id !== "string" || !isRunId(id)) throw new HttpError(400, "运行记录编号无效"); return id; }
export function createRunRouter(service: RunService, loadSettings: () => Promise<SavedSettings>, resolveSubmitter?: RunSubmitterResolver) {
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
    if (status && !["waiting", "queued", "running", "cancelling", "completed", "failed", "cancelled", "stale"].includes(status)) throw new HttpError(400, "运行状态筛选无效");
    const limit = request.query.limit === undefined ? 200 : Number(request.query.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new HttpError(400, "分页条数需要是 1–200 的整数");
    const page = await service.listRuns(projectDirectory, { before, limit, status, sceneId: typeof request.query.sceneId === "string" ? request.query.sceneId : undefined });
    response.json({ projectDirectory, runs: page.runs.map(run => runSummary(run, resolveSubmitter)), ...(page.nextCursor ? { nextCursor: Buffer.from(JSON.stringify(page.nextCursor)).toString("base64url") } : {}) });
  };
  router.get(["/api/v1/runs", "/api/workflows/runs"], list);
  router.post("/api/v1/runs", async (request, response) => {
    const run = await service.submit(request.body, response.locals.identity ? { ownerUserId: response.locals.identity.id, submitter: runSubmitter(response.locals.identity), authorize: response.locals.authorizeAdmin } : undefined);
    response.status(202).json({ runId: run.runId, status: run.status, createdAt: run.createdAt });
  });
  router.post("/api/workflows/run", async (request, response) => {
    const run = await service.submit(request.body, response.locals.identity ? { ownerUserId: response.locals.identity.id, submitter: runSubmitter(response.locals.identity), authorize: response.locals.authorizeAdmin } : undefined);
    const waiter = new AbortController();
    const disconnected = () => waiter.abort(new Error("运行结果等待连接已关闭"));
    response.once("close", disconnected);
    try { response.json(decorateRun(await service.wait(path.dirname(path.dirname(path.dirname(run.artifacts.directory))), run.runId, waiter.signal), resolveSubmitter)); }
    catch (error) { if (!waiter.signal.aborted) throw error; }
    finally { response.off("close", disconnected); }
  });
  router.get(["/api/v1/runs/:runId", "/api/workflows/runs/:runId"], async (request, response) => {
    const { projectDirectory } = await loadSettings();
    const id = validateId(request.params.runId);
    const run = await service.getRun(projectDirectory, id);
    if (!run && service.isPreparing(projectDirectory, id)) {
      response.set("Retry-After", "1");
      throw new HttpError(409, "运行正在准备素材，请稍后读取", "RUN_PREPARING");
    }
    if (!run) throw new HttpError(404, "没有找到这条运行记录");
    response.json(decorateRun(run, resolveSubmitter));
  });
  router.post(["/api/v1/runs/:runId/cancel", "/api/workflows/runs/:runId/cancel"], async (request, response) => {
    const { projectDirectory } = await loadSettings();
    response.json(await service.cancel(projectDirectory, validateId(request.params.runId)));
  });
  router.post("/api/v1/runs/:runId/review", async (request, response) => {
    const { projectDirectory } = await loadSettings();
    const run = await service.review(projectDirectory, validateId(request.params.runId), request.body, response.locals.authorizeAdmin);
    response.status(202).json({ runId: run.runId, status: run.status });
  });
  router.post("/api/v1/runs/:runId/resume", async (request, response) => {
    const { projectDirectory } = await loadSettings();
    const source = await service.getRun(projectDirectory, validateId(request.params.runId));
    if (!source) throw new HttpError(404, "没有找到断点来源运行记录");
    const run = await service.submit({ ...request.body, workflow: source.workflow, inputValues: source.inputValues, runTitle: request.body?.runTitle ?? source.runTitle, resumeFromRunId: source.runId }, response.locals.identity ? { ownerUserId: response.locals.identity.id, submitter: runSubmitter(response.locals.identity), authorize: response.locals.authorizeAdmin } : undefined);
    response.status(202).json({ runId: run.runId, status: run.status });
  });
  router.post("/api/v1/runs/:runId/rerun/preview", async (request, response) => {
    const { projectDirectory } = await loadSettings();
    response.json(await service.previewRerun(projectDirectory, validateId(request.params.runId), request.body?.changes));
  });
  router.post("/api/v1/runs/:runId/rerun", async (request, response) => {
    const { projectDirectory } = await loadSettings();
    const source = await service.getRun(projectDirectory, validateId(request.params.runId));
    if (!source) throw new HttpError(404, "没有找到局部重做来源运行记录");
    const run = await service.submit({ workflow: source.workflow, inputValues: source.inputValues, runTitle: request.body?.runTitle ?? source.runTitle, runId: request.body?.runId, rerunFromRunId: source.runId, rerunRequest: request.body?.changes }, response.locals.identity ? { ownerUserId: response.locals.identity.id, submitter: runSubmitter(response.locals.identity), authorize: response.locals.authorizeAdmin } : undefined);
    response.status(202).json({ runId: run.runId, status: run.status, rerunPlan: run.rerunPlan });
  });
  router.get("/api/v1/runs/:runId/events/history", async (request, response) => {
    const { projectDirectory } = await loadSettings();
    const id = validateId(request.params.runId);
    if (!await service.getRun(projectDirectory, id)) throw new HttpError(404, "没有找到这条运行记录");
    const after = Number(request.query.after ?? 0);
    if (!Number.isSafeInteger(after) || after < 0) throw new HttpError(400, "事件序号无效");
    const limit = request.query.limit === undefined ? 1000 : Number(request.query.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new HttpError(400, "事件分页条数需要是1至1000的整数");
    const page = service.store.events(projectDirectory, id, after, limit + 1);
    const events = page.slice(0, limit);
    response.json({ events, nextSequence: events.at(-1)?.sequence ?? after, hasMore: page.length > limit });
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
    let ending = false;
    let blocked = false;
    let lastSent = -1;
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    let unsubscribe = () => {};
    let unsubscribeShutdown = () => {};
    const pendingWrites: string[] = [];
    let pendingBytes = 0;
    const maxPendingBytes = 1024 * 1024;
    const endResponse = () => {
      if (ending || response.destroyed || response.writableEnded) return;
      ending = true;
      response.end();
    };
    const cleanup = () => {
      if (heartbeat) clearInterval(heartbeat);
      unsubscribe(); unsubscribeShutdown();
      request.off("close", close); response.off("close", close);
    };
    const close = () => {
      if (stopped) return;
      stopped = true; cleanup(); pendingWrites.length = 0; pendingBytes = 0;
      endResponse();
    };
    const finish = () => {
      if (stopped) return;
      stopped = true; cleanup();
      if (!blocked && pendingWrites.length === 0) endResponse();
    };
    const onDrain = () => {
      if (response.destroyed || ending) return;
      blocked = false;
      while (pendingWrites.length) {
        const chunk = pendingWrites.shift()!;
        pendingBytes -= Buffer.byteLength(chunk);
        if (!response.write(chunk)) {
          blocked = true;
          response.once("drain", onDrain);
          return;
        }
      }
      if (stopped) endResponse();
    };
    const enqueue = (chunk: string) => {
      if (response.destroyed || ending) return false;
      if (blocked) {
        const bytes = Buffer.byteLength(chunk);
        if (pendingBytes + bytes > maxPendingBytes) { close(); return false; }
        pendingWrites.push(chunk); pendingBytes += bytes;
        return true;
      }
      if (!response.write(chunk)) {
        blocked = true;
        response.once("drain", onDrain);
      }
      return true;
    };
    const write = (sequence: number, data: unknown) => {
      if (stopped || response.destroyed) return false;
      try { response.locals.authorizeAdmin?.(); } catch { close(); return false; }
      if (sequence < lastSent) return true;
      lastSent = sequence;
      return enqueue(`id: ${sequence}\ndata: ${JSON.stringify(data)}\n\n`);
    };
    // All store reads here are synchronous; subscribe + replay cannot lose an intervening event.
    unsubscribe = service.subscribe(projectDirectory, id, (run, event) => {
      if (event.sequence <= lastSent) return;
      write(event.sequence, { event, run: decorateRun(run, resolveSubmitter) });
      if (!isActiveRunStatus(run.status)) finish();
    });
    unsubscribeShutdown = service.onShutdown(close);
    request.once("close", close); response.once("close", close);
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
    write(service.store.latestSequence(projectDirectory, id), { event: { type: "run.snapshot", runId: id }, run: decorateRun(run, resolveSubmitter) });
    if (!isActiveRunStatus(run.status)) finish();
    else if (!stopped) { heartbeat = setInterval(() => { try { response.locals.authorizeAdmin?.(); } catch { close(); return; } if (!blocked && !enqueue(": heartbeat\n\n")) close(); }, 15000); heartbeat.unref(); }
  });
  return router;
}
