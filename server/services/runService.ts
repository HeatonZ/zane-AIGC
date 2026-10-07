import { captureStepFeedback, validateStepFeedback } from "../domain/stepFeedback.js";
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { copyFile, mkdir, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { discardRunArtifacts, isRunId, readRunRecord, restoreArchivedRunInputs } from "../artifacts/runArtifacts.js";
import { isActiveRunStatus } from "../domain/types.js";
import type { RunEvent, RunRecord, RunSubmitter, SavedSettings } from "../domain/types.js";
import { asRecord, normalizeMediaList } from "../domain/workflowValues.js";
import { mediaKindFromWorkflowType } from "../runtimeValue.js";
import { externalizeRuntimeValue } from "../domain/workflowValues.js";
import { ExecutorRegistry } from "../execution/executorRegistry.js";
import { executeWorkflow, type ExecutionContext, type ExecutionResult, type PreparedRun } from "../execution/workflowExecutor.js";
import { HttpError } from "../errors.js";
import { log } from "../observability/logger.js";
import { writeJsonFile } from "../storage/jsonFileStore.js";
import { SqliteStore, type RunListQuery } from "../storage/sqliteStore.js";
import { planRerun } from "./rerunPlanner.js";
import { validateWorkflowShape, validateCarryReferences } from "../domain/workflowValidation.js";
import { validateWorkflowInputs } from "../domain/inputValidation.js";
import { normalizeRunWorkflow } from "../domain/workflowValues.js";
import { prepareRun } from "./runPreparation.js";

interface ServiceOptions {
  store: SqliteStore;
  executors: ExecutorRegistry;
  loadSettings(): Promise<SavedSettings>;
  maxActiveRuns?: number;
  getMaxActiveRuns?(): number;
  resolveAssets?: import("./runPreparation.js").PreparationDependencies["resolveAssets"];
  execute?(prepared: PreparedRun, context: ExecutionContext): Promise<ExecutionResult>;
}
interface ActiveJob { prepared: PreparedRun; controller: AbortController; done: Promise<void>; shutdown: boolean }
function key(projectDirectory: string, runId: string) { return `${projectDirectory}\n${runId}`; }

export class RunService {
  private readonly events = new EventEmitter();
  private readonly active = new Map<string, ActiveJob>();
  private readonly preparing = new Set<string>();
  private readonly preparingOwners = new Map<string,string>();
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
  isPreparing(projectDirectory: string, runId: string) { return this.preparing.has(key(projectDirectory, runId)); }
  isPreparingFor(project: string, runId: string, userId: string) { return this.preparingOwners.get(key(project,runId)) === userId; }
  /** Re-evaluate admission after a committed configuration change. Existing jobs are not interrupted. */
  refreshConcurrency() { this.pump(); }
  private concurrencyLimit() { return this.options.getMaxActiveRuns?.() ?? this.options.maxActiveRuns ?? 2; }
  metrics() { return { maxActiveRuns: this.concurrencyLimit(), queued: this.queue.length, active: this.active.size, preparing: this.preparing.size, accepting: this.accepting, ready: this.started && !this.closed, subscribers: this.events.eventNames().filter((name) => name !== "shutdown").reduce((sum, name) => sum + this.events.listenerCount(name), 0) }; }

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
        try {
          const inputValues = await restoreArchivedRunInputs(entry.projectDirectory, entry.run.runId, submission.executionWorkflow, submission.inputValues);
          if (this.closed) return;
          // Cancellation may have happened while restoring the archive; never resurrect it.
          if (this.store.getRun(entry.projectDirectory, entry.run.runId)?.status !== "queued") continue;
          const restored = { ...submission, inputValues };
          await this.persist(entry.projectDirectory, { ...entry.run, inputValues: externalizeRuntimeValue(inputValues) as RunRecord["inputValues"] }, [{ type: "run.recovered_queued" }], restored);
          if (this.closed) return;
          if (this.store.getRun(entry.projectDirectory, entry.run.runId)?.status !== "queued") continue;
          if (!this.queue.some(job => key(job.settings.projectDirectory, job.runId) === key(entry.projectDirectory, entry.run.runId))) this.queue.push(restored);
          log("info", "run.recovered_queued", { runId: entry.run.runId });
        } catch (error) {
          if (this.closed) return;
          if (this.store.getRun(entry.projectDirectory, entry.run.runId)?.status !== "queued") continue;
          const message = "恢复输入归档失败，请检查素材或从备份恢复：" + (error instanceof Error ? error.message : String(error));
          await this.persist(entry.projectDirectory, { ...entry.run, status: "stale", finishedAt: new Date().toISOString(), error: message }, [{ type: "run.stale", payload: { error: message } }]);
          log("warn", "run.queued_recovery_failed", { runId: entry.run.runId, error: message });
        }
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

  async submit(body: unknown, access?: { ownerUserId: string; submitter?: RunSubmitter; authorize(): void }): Promise<RunRecord> {
    if (!this.accepting) throw new HttpError(503, "服务正在关闭，暂不接受新运行");
    const value = body && typeof body === "object" ? body as Record<string, unknown> : {};
    const runId = value.runId === undefined ? randomUUID() : value.runId;
    if (typeof runId !== "string" || !isRunId(runId)) throw new HttpError(400, "运行记录编号无效");
    const source = value.resumeFromRunId ?? value.rerunFromRunId;
    if (source !== undefined && (typeof source !== "string" || !isRunId(source))) throw new HttpError(400, "断点来源运行记录编号无效");
    const settings = await this.options.loadSettings();
    if (!this.accepting) throw new HttpError(503, "服务正在关闭，暂不接受新运行");
    const runKey = key(settings.projectDirectory, runId);
    const sourceKey = typeof source === "string" ? key(settings.projectDirectory, source) : undefined;
    if (this.preparing.has(runKey) || this.store.getRun(settings.projectDirectory, runId)) throw new HttpError(409, "运行记录编号已存在", "RUN_ALREADY_EXISTS");
    if (sourceKey && (this.preparing.has(sourceKey) || [...this.active.values()].some((job) => (job.prepared.resumedFromRunId ?? job.prepared.rerunFromRunId) === source && job.prepared.settings.projectDirectory === settings.projectDirectory) || this.queue.some((job) => (job.resumedFromRunId ?? job.rerunFromRunId) === source && job.settings.projectDirectory === settings.projectDirectory))) throw new HttpError(409, "这条运行记录已有续跑任务");
    this.preparing.add(runKey);
    if (access) this.preparingOwners.set(runKey,access.ownerUserId);
    if (sourceKey) this.preparing.add(sourceKey);
    let prepared: PreparedRun | undefined;
    let accepted = false;
    try {
      prepared = await prepareRun(body, runId, settings, { getRun: (project, id) => this.getRun(project, id, true), supportsStep: (kind) => this.options.executors.supports(kind), prepareStep: (step) => this.options.executors.prepareStep(step), capabilities: this.options.executors.definitions(), resolveAssets: this.options.resolveAssets });
      if (!this.accepting) throw new HttpError(503, "服务正在关闭；本次提交未进入队列");
      const workflow = prepared.executionWorkflow;
      access?.authorize();
      const record: RunRecord = {
        ...(access ? { ownerUserId: access.ownerUserId, ...(access.submitter ? { submitter: access.submitter } : {}) } : {}),
        runId, sceneId: workflow.sceneId ?? "comic", workflowName: workflow.name ?? "未命名工作流", status: "queued",
        createdAt: prepared.createdAt, startedAt: prepared.createdAt, steps: [], outputs: [],
        inputValues: externalizeRuntimeValue(prepared.inputValues) as RunRecord["inputValues"], workflow,
        artifacts: prepared.artifacts, ...(prepared.feedbackHistory?.length ? { feedbackHistory: prepared.feedbackHistory } : {}), ...(prepared.runTitle ? { runTitle: prepared.runTitle } : {}),
        ...(prepared.resumedFromRunId ? { resumedFromRunId: prepared.resumedFromRunId } : {}),
        ...(prepared.rerunFromRunId ? { rerunFromRunId: prepared.rerunFromRunId, rerunPlan: prepared.rerun!.plan, rerunRequest: prepared.rerun!.request } : {}),
      };
      const events = this.store.createRun(settings.projectDirectory, record, prepared);
      accepted = true;
      this.publish(settings.projectDirectory, record, events);
      this.queue.push(prepared);
      log("info", "run.queued", { runId, sceneId: record.sceneId });
      setImmediate(() => this.pump());
      return record;
    } catch (error) {
      // Only remove the directory owned by this uncommitted preparation, never an accepted run.
      if (prepared && !accepted) await discardRunArtifacts(settings.projectDirectory, runId).catch(failure => log("warn", "run.preparation_cleanup_failed", { runId, error: String(failure) }));
      throw error;
    } finally { this.preparing.delete(runKey); this.preparingOwners.delete(runKey); if (sourceKey) this.preparing.delete(sourceKey); }
  }

  async review(project: string, runId: string, raw: unknown, authorize?: () => void): Promise<RunRecord> {
    if (!this.accepting) throw new HttpError(503, "服务正在关闭");
    const runKey = key(project, runId);
    if (this.preparing.has(runKey)) throw new HttpError(409, "此运行的确认正在提交中");
    this.preparing.add(runKey);
    try {
      await this.getRun(project, runId, true);
      const job = this.active.get(runKey);
      if (this.store.getRun(project, runId)?.status === "waiting" && job) await job.done;
      const run = this.store.getRun(project, runId);
      const body = asRecord(raw);
      if (!run) throw new HttpError(404, "运行不存在");
      if (run.status !== "waiting" || !run.pendingReview || body?.reviewId !== run.pendingReview.id) throw new HttpError(409, "确认状态已变化，请刷新后重试", "REVIEW_CONFLICT");
      if (body.action !== "approve" && body.action !== "redo") throw new HttpError(400, "确认操作无效");
      const submission = this.store.getSubmission(project, runId) as PreparedRun | undefined;
      if (!submission) throw new HttpError(409, "此记录缺少可恢复的执行快照");
      const workflow = structuredClone(submission.executionWorkflow);
      const position = workflow.steps.findIndex(step => step.id === run.pendingReview!.stepId);
      const definition = workflow.steps[position];
      const result = run.steps.find(step => step.stepId === definition?.id);
      if (!definition || !result || result.status !== "completed") throw new HttpError(409, "待确认步骤结果不可用");
      const originalOutputs = structuredClone(result.outputs ?? {});
      if (body.feedback !== undefined && body.action !== "redo") throw new HttpError(400, "反馈意见仅用于退回重做", "INVALID_FEEDBACK");
      const feedback = body.feedback === undefined ? undefined : captureStepFeedback(run, validateStepFeedback(run, { stepId: definition.id, message: body.feedback }), new Date().toISOString());
      const feedbackHistory = [...(run.feedbackHistory ?? []), ...(feedback ? [feedback] : [])];
      const edited = body.outputs === undefined ? undefined : asRecord(body.outputs);
      if (body.outputs !== undefined && (!edited || body.action !== "approve" || definition.execution?.mode === "for_each")) throw new HttpError(400, "只能在确认单次步骤时修改输出；逐项步骤请退回重做");
      if (edited) {
        for (const field of Object.keys(edited)) if (!definition.outputs?.some(output => output.key === field)) throw new HttpError(400, "未知步骤输出：" + field);
        const contract = { inputs: (definition.outputs ?? []).filter(output => Object.hasOwn(edited, output.key)).map(output => ({ key: output.key, type: output.type, required: true })), steps: [], outputs: [] };
        let values = edited as Record<string, import("../domain/types.js").JsonValue>;
        if (this.options.resolveAssets) values = await this.options.resolveAssets(project, contract, values);
        validateWorkflowInputs(contract, values);
        for (const field of contract.inputs) if (mediaKindFromWorkflowType(field.type)) {
          const archived = [];
          for (const [index, value] of normalizeMediaList(values[field.key]).entries()) {
            const record = asRecord(value); const source = typeof value === "string" ? value : typeof record?.path === "string" ? record.path : undefined;
            if (!source || /^(?:https?:|data:|\/api\/)/i.test(source)) { archived.push(value); continue; }
            if (!(await stat(source).catch(() => undefined))?.isFile()) throw new HttpError(400, "无法读取修改后的媒体文件");
            const destination = path.join(submission.artifacts.directory, "outputs", "media", "review-" + run.pendingReview.id + "-" + field.key.replace(/[^a-z0-9_-]/gi, "_") + "-" + index + path.extname(source).replace(/[^.a-z0-9]/gi, ""));
            await mkdir(path.dirname(destination), { recursive: true }); await copyFile(source, destination); archived.push(destination);
          }
          values[field.key] = archived;
        }
        result.outputs = { ...result.outputs, ...values };
      }
      if (body.stepChanges !== undefined) {
        const changes = asRecord(body.stepChanges);
        if (body.action !== "redo" || !changes || Object.keys(changes).some(field => !["promptTemplate", "hermesProfile", "capabilityConfig", "inputs"].includes(field))) throw new HttpError(400, "退回重做参数无效");
        workflow.steps[position] = this.options.executors.prepareStep({ ...definition, ...changes });
        validateWorkflowShape(workflow as unknown as Record<string, unknown>);
      }
      if (body.action === "approve") result.review = { status: "approved", id: run.pendingReview.id, decidedAt: new Date().toISOString() };
      const history: NonNullable<RunRecord["reviewHistory"]> = [...(run.reviewHistory ?? []), { reviewId: run.pendingReview.id, stepId: definition.id, action: body.action, at: new Date().toISOString(), originalOutputs, ...(feedback ? { feedback: feedback.message, feedbackId: feedback.id } : {}), ...(edited ? { editedOutputs: structuredClone(result.outputs) } : {}) }];
      const steps = body.action === "redo" ? run.steps.filter(step => workflow.steps.findIndex(item => item.id === step.stepId) < position) : run.steps;
      const source: RunRecord = { ...run, steps, workflow, pendingReview: undefined, reviewHistory: history, ...(feedbackHistory.length ? { feedbackHistory } : {}) };
      const prepared: PreparedRun = { ...submission, executionWorkflow: workflow, resumeSource: source, rerun: undefined, feedbackHistory };
      if (!this.accepting) throw new HttpError(503, "服务正在关闭，本次确认未提交");
      authorize?.();
      const next: RunRecord = { ...source, status: "queued", outputs: [], error: undefined, finishedAt: undefined, durationMs: undefined };
      await this.persist(project, next, [{ type: "review." + body.action, stepId: definition.id, payload: { reviewId: run.pendingReview.id, edited: Boolean(edited), ...(feedback ? { feedbackId: feedback.id } : {}) } }, { type: "run.queued" }], prepared);
      this.queue.push(prepared); setImmediate(() => this.pump()); return next;
    } finally { this.preparing.delete(runKey); }
  }

  async previewRerun(projectDirectory: string, runId: string, changes: unknown) {
    const source = await this.getRun(projectDirectory, runId);
    if (!source) throw new HttpError(404, "没有找到局部重做来源运行记录");
    const planned = planRerun(source, changes, this.options.executors.definitions());
    validateWorkflowShape(planned.workflow as unknown as Record<string, unknown>);
    planned.workflow = normalizeRunWorkflow(planned.workflow);
    validateCarryReferences(planned.workflow);
    validateWorkflowInputs(planned.workflow, planned.inputValues);
    for (const step of planned.workflow.steps) this.options.executors.prepareStep(step);
    for (const item of planned.itemStepOverrides) {
      validateWorkflowShape({ ...planned.workflow, steps: [item.step] });
      this.options.executors.prepareStep(item.step);
    }
    return planned.plan;
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
    if (this.preparing.has(key(projectDirectory, runId))) throw new HttpError(409, "正在提交此运行的修改，请稍后再取消");
    if (run.status === "waiting") { await this.persist(projectDirectory, { ...run, status: "cancelled", pendingReview: undefined, finishedAt: new Date().toISOString(), cancellationReason: "用户取消待确认运行" }, [{ type: "run.cancelled" }]); return { runId, status: "cancelled" as const }; }
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
    const limit = this.concurrencyLimit();
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
          if (this.closed || this.active.get(key(project, prepared.runId)) !== job) return;
          const previous = this.store.getRun(project, prepared.runId);
          // Fence progress after completion/review, including callbacks from an older execution.
          if (!previous || !["running", "cancelling"].includes(previous.status)) return;
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
      // A cancellation committed while the executor was finalizing wins over its late result.
      const interrupted = job.shutdown || controller.signal.aborted;
      const status = job.shutdown ? "stale" as const : controller.signal.aborted ? "cancelled" as const : result.status;
      const finishedAt = result.finishedAt ?? new Date().toISOString();
      const reason = record.cancellationReason ?? String(controller.signal.reason ?? "运行已取消");
      await this.persist(project, { ...record, ...result, status, ...(interrupted ? {
        pendingReview: undefined, finishedAt, durationMs: result.durationMs ?? Math.max(0, Date.parse(finishedAt) - Date.parse(record.startedAt)),
        error: job.shutdown ? "服务关闭时中断，请从断点继续" : reason,
        ...(!job.shutdown ? { cancellationReason: reason } : {}),
      } : {}) }, [{ type: `run.${status}` }]);
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

  private persist(projectDirectory: string, run: RunRecord, changes: Array<{ type: string; stepId?: string; payload?: Record<string, unknown> }>, submission?: PreparedRun) {
    const snapshot = structuredClone(run);
    const events = submission ? this.store.saveRunSubmission(projectDirectory, snapshot, submission, changes) : this.store.saveRun(projectDirectory, snapshot, changes);
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
