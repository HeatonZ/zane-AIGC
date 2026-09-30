import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { isRunId, readRunRecord } from "../artifacts/runArtifacts.js";
import { isActiveRunStatus } from "../domain/types.js";
import type { RunEvent, RunRecord, SavedSettings } from "../domain/types.js";
import { externalizeRuntimeValue } from "../domain/workflowValues.js";
import { ExecutorRegistry } from "../execution/executorRegistry.js";
import { executeWorkflow, type ExecutionContext, type ExecutionResult, type PreparedRun } from "../execution/workflowExecutor.js";
import { HttpError } from "../errors.js";
import { log } from "../observability/logger.js";
import { writeJsonFile } from "../storage/jsonFileStore.js";
import { SqliteStore, type RunListQuery } from "../storage/sqliteStore.js";
import { prepareRun } from "./runPreparation.js";

interface ServiceOptions {
  store: SqliteStore;
  executors: ExecutorRegistry;
  loadSettings(): Promise<SavedSettings>;
  maxActiveRuns?: number;
  execute?(prepared: PreparedRun, context: ExecutionContext): Promise<ExecutionResult>;
}
interface ActiveJob { prepared: PreparedRun; controller: AbortController; done: Promise<void>; shutdown: boolean }
function key(projectDirectory: string, runId: string) { return `${projectDirectory}\n${runId}`; }

export class RunService {
  private readonly events = new EventEmitter();
  private readonly active = new Map<string, ActiveJob>();
  private readonly preparing = new Set<string>();
  private readonly importing = new Map<string, Promise<void>>();
  private readonly queue: PreparedRun[] = [];
  private readonly mirrors = new Map<string, Promise<void>>();
  private readonly options: ServiceOptions;
  private accepting = true;
  private started = false;
  private starting?: Promise<void>;
  private closed = false;
  constructor(options: ServiceOptions) { this.options = options; this.events.setMaxListeners(0); }
  get store() { return this.options.store; }
  metrics() { return { queued: this.queue.length, active: this.active.size, preparing: this.preparing.size, accepting: this.accepting, ready: this.started && !this.closed, subscribers: this.events.eventNames().filter((name) => name !== "shutdown").reduce((sum, name) => sum + this.events.listenerCount(name), 0) }; }

  async start() {
    if (this.started) return;
    this.ensureOpen();
    this.starting ??= this.recover();
    await this.starting;
  }

  private async recover() {
    for (const entry of this.store.unfinishedRuns()) {
      if (this.closed) return;
      const submission = entry.submission as PreparedRun | undefined;
      if (entry.run.status === "queued" && submission?.runId === entry.run.runId && submission?.settings?.projectDirectory === entry.projectDirectory) {
        if (!this.queue.some((job) => key(job.settings.projectDirectory, job.runId) === key(entry.projectDirectory, entry.run.runId))) this.queue.push(submission);
        log("info", "run.recovered_queued", { runId: entry.run.runId });
      } else {
        const cancelled = entry.run.status === "cancelling";
        const updated: RunRecord = { ...entry.run, status: cancelled ? "cancelled" : "stale", finishedAt: new Date().toISOString(), error: cancelled ? "服务重启前已请求取消" : "服务已重启；已执行任务不会自动重复提交，请从断点继续" };
        await this.persist(entry.projectDirectory, updated, [{ type: cancelled ? "run.cancelled" : "run.stale" }]);
      }
    }
    if (this.closed) return;
    this.started = true;
    this.pump();
  }

  private ensureOpen() {
    if (this.closed) throw new HttpError(503, "运行服务已关闭");
  }

  async submit(body: unknown): Promise<RunRecord> {
    if (!this.accepting) throw new HttpError(503, "服务正在关闭，暂不接受新运行");
    const value = body && typeof body === "object" ? body as Record<string, unknown> : {};
    const runId = value.runId === undefined ? randomUUID() : value.runId;
    if (typeof runId !== "string" || !isRunId(runId)) throw new HttpError(400, "运行记录编号无效");
    const source = value.resumeFromRunId;
    if (source !== undefined && (typeof source !== "string" || !isRunId(source))) throw new HttpError(400, "断点来源运行记录编号无效");
    const settings = await this.options.loadSettings();
    if (!this.accepting) throw new HttpError(503, "服务正在关闭，暂不接受新运行");
    const runKey = key(settings.projectDirectory, runId);
    const sourceKey = typeof source === "string" ? key(settings.projectDirectory, source) : undefined;
    if (this.preparing.has(runKey) || this.store.getRun(settings.projectDirectory, runId)) throw new HttpError(409, "运行记录编号已存在", "RUN_ALREADY_EXISTS");
    if (sourceKey && (this.preparing.has(sourceKey) || [...this.active.values()].some((job) => job.prepared.resumedFromRunId === source && job.prepared.settings.projectDirectory === settings.projectDirectory) || this.queue.some((job) => job.resumedFromRunId === source && job.settings.projectDirectory === settings.projectDirectory))) throw new HttpError(409, "这条运行记录已有续跑任务");
    this.preparing.add(runKey);
    if (sourceKey) this.preparing.add(sourceKey);
    try {
      const prepared = await prepareRun(body, runId, settings, { getRun: (project, id) => this.getRun(project, id, true), supportsStep: (kind) => this.options.executors.supports(kind) });
      if (!this.accepting) throw new HttpError(503, "服务正在关闭；本次提交未进入队列");
      const workflow = prepared.executionWorkflow;
      const record: RunRecord = {
        runId, sceneId: workflow.sceneId ?? "comic", workflowName: workflow.name ?? "未命名工作流", status: "queued",
        createdAt: prepared.createdAt, startedAt: prepared.createdAt, steps: [], outputs: [],
        inputValues: externalizeRuntimeValue(prepared.inputValues) as RunRecord["inputValues"], workflow,
        artifacts: prepared.artifacts, ...(prepared.runTitle ? { runTitle: prepared.runTitle } : {}),
        ...(prepared.resumedFromRunId ? { resumedFromRunId: prepared.resumedFromRunId } : {}),
      };
      const events = this.store.createRun(settings.projectDirectory, record, prepared);
      this.publish(settings.projectDirectory, record, events);
      this.queue.push(prepared);
      log("info", "run.queued", { runId, sceneId: record.sceneId });
      setImmediate(() => this.pump());
      return record;
    } finally { this.preparing.delete(runKey); if (sourceKey) this.preparing.delete(sourceKey); }
  }

  async getRun(projectDirectory: string, runId: string, allowPreparing = false): Promise<RunRecord | undefined> {
    this.ensureOpen();
    const saved = this.store.getRun(projectDirectory, runId);
    if (saved) return saved;
    if (!allowPreparing && this.preparing.has(key(projectDirectory, runId))) return undefined;
    const legacy = await readRunRecord(projectDirectory, runId);
    this.ensureOpen();
    const current = this.store.getRun(projectDirectory, runId);
    if (current) return current;
    if (!allowPreparing && this.preparing.has(key(projectDirectory, runId))) return undefined;
    if (!legacy) return undefined;
    const status = isActiveRunStatus(legacy.status) ? "stale" : legacy.status;
    const record = { ...legacy, status, createdAt: legacy.startedAt, workflow: legacy.workflow ?? { sceneId: legacy.sceneId, name: legacy.workflowName, inputs: [], steps: [], outputs: [] }, ...(status === "stale" ? { error: "旧版服务留下了未结束任务，请从断点继续" } : {}) } as unknown as RunRecord;
    this.store.importRun(projectDirectory, record);
    return this.store.getRun(projectDirectory, runId);
  }

  async importLegacyProject(projectDirectory: string) {
    this.ensureOpen();
    if (!projectDirectory || this.store.hasImported(projectDirectory)) return;
    const current = this.importing.get(projectDirectory);
    if (current) return current;
    const operation = (async () => {
      let entries;
      try { entries = await readdir(path.join(projectDirectory, ".zane", "runs"), { withFileTypes: true }); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") { if (!this.closed) this.store.markImported(projectDirectory); return; } throw error; }
      if (this.closed) return;
      const ids = entries.filter((entry) => entry.isDirectory() && isRunId(entry.name)).map((entry) => entry.name);
      for (let index = 0; index < ids.length; index += 8) {
        if (this.closed) return;
        await Promise.all(ids.slice(index, index + 8).map(async (id) => {
          if (this.preparing.has(key(projectDirectory, id)) || this.store.getRun(projectDirectory, id)) return;
          try { await this.getRun(projectDirectory, id); }
          catch (error) { log("warn", "run.legacy_import_failed", { runId: id, error: error instanceof Error ? error.message : String(error) }); }
        }));
      }
      if (this.closed) return;
      this.store.markImported(projectDirectory);
      log("info", "run.legacy_indexed", { projectDirectory, discovered: ids.length });
    })();
    this.importing.set(projectDirectory, operation);
    try { await operation; } finally { this.importing.delete(projectDirectory); }
  }

  async listRuns(projectDirectory: string, query: RunListQuery = {}) {
    await this.importLegacyProject(projectDirectory);
    this.ensureOpen();
    return this.store.listRuns(projectDirectory, query);
  }

  async cancel(projectDirectory: string, runId: string) {
    await this.getRun(projectDirectory, runId);
    this.ensureOpen();
    // getRun may yield while a queued job is claimed; transition the latest state, not the old snapshot.
    const run = this.store.getRun(projectDirectory, runId);
    if (!run) throw new HttpError(404, "没有找到这条运行记录");
    if (!isActiveRunStatus(run.status)) throw new HttpError(409, "这条运行记录已结束，或当前服务无法停止它");
    if (run.status === "cancelling") return { runId, status: run.status };
    const reason = "用户主动点击了取消运行";
    if (run.status === "queued") {
      const index = this.queue.findIndex((item) => item.runId === runId && item.settings.projectDirectory === projectDirectory);
      if (index >= 0) this.queue.splice(index, 1);
      await this.persist(projectDirectory, { ...run, status: "cancelled", finishedAt: new Date().toISOString(), cancellationReason: reason, error: reason }, [{ type: "run.cancelled" }]);
      return { runId, status: "cancelled" as const };
    }
    const active = this.active.get(key(projectDirectory, runId));
    if (!active) throw new HttpError(409, "当前服务未持有此任务，请重新读取运行状态");
    const saving = this.persist(projectDirectory, { ...run, status: "cancelling", cancellationReason: reason }, [{ type: "run.cancelling" }]);
    // Abort immediately after the synchronous transaction, before waiting for the disk mirror.
    active.controller.abort(reason);
    await saving;
    return { runId, status: "cancelling" as const };
  }

  subscribe(projectDirectory: string, runId: string, listener: (run: RunRecord, event: RunEvent) => void) {
    const eventKey = key(projectDirectory, runId);
    this.events.on(eventKey, listener);
    return () => { this.events.off(eventKey, listener); };
  }
  onShutdown(listener: () => void) { this.events.on("shutdown", listener); return () => { this.events.off("shutdown", listener); }; }

  async wait(projectDirectory: string, runId: string, signal?: AbortSignal): Promise<RunRecord> {
    if (signal?.aborted) throw signal.reason;
    const run = await this.getRun(projectDirectory, runId);
    if (!run) throw new HttpError(404, "没有找到这条运行记录");
    if (!isActiveRunStatus(run.status)) { await this.mirrors.get(key(projectDirectory, runId)); return run; }
    if (!this.accepting) throw new HttpError(503, "服务正在关闭；后台任务状态已保存");
    return new Promise((resolve, reject) => {
      let settled = false;
      const cleanup = () => { unsubscribe(); unsubscribeShutdown(); signal?.removeEventListener("abort", abort); };
      const finish = (record: RunRecord) => { if (settled) return; settled = true; cleanup(); resolve(record); };
      const fail = (reason: unknown) => { if (settled) return; settled = true; cleanup(); reject(reason); };
      const unsubscribe = this.subscribe(projectDirectory, runId, (record) => { if (!isActiveRunStatus(record.status)) finish(record); });
      const unsubscribeShutdown = this.onShutdown(() => fail(new HttpError(503, "服务正在关闭；请重新连接读取运行结果")));
      const abort = () => fail(signal?.reason);
      signal?.addEventListener("abort", abort, { once: true });
      const latest = this.store.getRun(projectDirectory, runId);
      if (latest && !isActiveRunStatus(latest.status)) void Promise.resolve(this.mirrors.get(key(projectDirectory, runId))).then(() => finish(latest), fail);
      if (signal?.aborted) abort();
    });
  }

  private pump() {
    if (!this.started || !this.accepting || this.closed) return;
    const limit = this.options.maxActiveRuns ?? 2;
    while (this.active.size < limit && this.queue.length) {
      const prepared = this.queue.shift()!;
      const project = prepared.settings.projectDirectory;
      if (this.store.getRun(project, prepared.runId)?.status !== "queued") continue;
      const controller = new AbortController();
      const job: ActiveJob = { prepared, controller, done: Promise.resolve(), shutdown: false };
      this.active.set(key(project, prepared.runId), job);
      job.done = this.execute(job).finally(() => { this.active.delete(key(project, prepared.runId)); this.pump(); });
    }
  }

  private async execute(job: ActiveJob) {
    const { prepared, controller } = job;
    const project = prepared.settings.projectDirectory;
    let record = this.store.getRun(project, prepared.runId)!;
    try {
      await this.persist(project, { ...record, status: "running", startedAt: new Date().toISOString() }, [{ type: "run.started" }]);
      const result = await (this.options.execute ?? executeWorkflow)(prepared, {
        controller, executeStep: (context) => this.options.executors.execute(context),
        checkpoint: async (patch) => {
          if (this.closed) return;
          const previous = this.store.getRun(project, prepared.runId)!;
          const next = { ...previous, ...patch, status: previous.status === "cancelling" ? "cancelling" as const : "running" as const };
          const changed: Array<{ type: string; stepId?: string; payload?: Record<string, unknown> }> = [];
          for (const step of next.steps) {
            const old = previous.steps.find((item) => item.stepId === step.stepId);
            if (old?.status !== step.status) changed.push({ type: `step.${step.status === "running" ? "started" : step.status}`, stepId: step.stepId });
            for (const item of step.items ?? []) {
              if (old?.items?.find((candidate) => candidate.index === item.index)?.status !== item.status) changed.push({ type: `step.item.${item.status === "running" ? "started" : item.status}`, stepId: step.stepId, payload: { index: item.index } });
            }
          }
          await this.persist(project, next, changed.length ? changed : [{ type: "run.checkpoint" }]);
        },
      });
      if (this.closed) return;
      record = this.store.getRun(project, prepared.runId)!;
      const status = job.shutdown ? "stale" as const : result.status;
      await this.persist(project, { ...record, ...result, status, ...(job.shutdown ? { error: "服务关闭时中断，请从断点继续" } : {}) }, [{ type: `run.${status}` }]);
      log("info", `run.${status}`, { runId: prepared.runId, durationMs: result.durationMs });
    } catch (error) {
      if (this.closed) return;
      const current = this.store.getRun(project, prepared.runId)!;
      const status = job.shutdown ? "stale" as const : controller.signal.aborted ? "cancelled" as const : "failed" as const;
      const message = error instanceof Error ? error.message : String(error);
      try { await this.persist(project, { ...current, status, finishedAt: new Date().toISOString(), error: message }, [{ type: `run.${status}`, payload: { error: message } }]); }
      catch (failure) { log("error", "run.persistence_failed", { runId: prepared.runId, error: String(failure) }); }
      log("error", "run.execution_failed", { runId: prepared.runId, error: message });
    }
  }

  private persist(projectDirectory: string, run: RunRecord, changes: Array<{ type: string; stepId?: string; payload?: Record<string, unknown> }>) {
    const snapshot = structuredClone(run);
    const events = this.store.saveRun(projectDirectory, snapshot, changes);
    const runKey = key(projectDirectory, run.runId);
    // SQLite commits immediately. Serialize derived JSON mirrors/events so older writes cannot win.
    const previous = this.mirrors.get(runKey) ?? Promise.resolve();
    const operation = previous.then(async () => {
      try {
        await writeJsonFile(snapshot.artifacts.runtime, { format: "zane-studio.runtime/v1", ...snapshot });
        if (!isActiveRunStatus(snapshot.status)) await writeJsonFile(snapshot.artifacts.output, { format: "zane-studio.output/v1", ...snapshot });
      } catch (error) { log("warn", "run.archive_snapshot_failed", { runId: run.runId, error: String(error) }); }
      this.publish(projectDirectory, snapshot, events);
    });
    this.mirrors.set(runKey, operation);
    void operation.finally(() => { if (this.mirrors.get(runKey) === operation) this.mirrors.delete(runKey); }).catch(() => undefined);
    return operation;
  }
  private publish(project: string, run: RunRecord, events: RunEvent[]) {
    for (const event of events) for (const listener of this.events.listeners(key(project, run.runId))) {
      try { listener(structuredClone(run), event); }
      catch (error) { log("warn", "run.listener_failed", { runId: run.runId, error: String(error) }); }
    }
  }

  async shutdown(timeoutMs = 15000) {
    this.accepting = false;
    this.events.emit("shutdown");
    const wait = async (ms: number) => {
      const until = Date.now() + ms;
      while ((this.active.size || this.preparing.size || this.importing.size) && Date.now() < until) await new Promise((resolve) => setTimeout(resolve, 25));
    };
    await wait(timeoutMs);
    for (const job of this.active.values()) {
      if (!isActiveRunStatus(this.store.getRun(job.prepared.settings.projectDirectory, job.prepared.runId)!.status)) continue;
      job.shutdown = !job.controller.signal.aborted;
      job.controller.abort("服务正在关闭");
    }
    await wait(5000);
    // Fence late executors/imports/preparations before closing the database.
    this.closed = true;
    for (const job of this.active.values()) {
      const project = job.prepared.settings.projectDirectory;
      const run = this.store.getRun(project, job.prepared.runId)!;
      if (!isActiveRunStatus(run.status)) continue;
      const status = job.shutdown ? "stale" as const : "cancelled" as const;
      await this.persist(project, { ...run, status, finishedAt: new Date().toISOString(), error: "服务关闭等待超时，请从断点继续" }, [{ type: `run.${status}` }]);
    }
    await Promise.allSettled([...this.mirrors.values()]);
    this.events.removeAllListeners();
  }
}
