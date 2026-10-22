import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { AsyncLocalStorage } from "node:async_hooks";

import { z } from "zod";

import type { JsonValue, RunRecord, RunSubmitter, SavedSettings } from "../domain/types.js";
import { asRecord } from "../domain/workflowValues.js";
import { HttpError } from "../errors.js";
import { log as writeLog } from "../observability/logger.js";
import { redactErrorText } from "../security/errorHandler.js";
import type { AiSceneService } from "./aiSceneService.js";
import type { AssetService } from "./assetService.js";
import type { RunService } from "./runService.js";
import type { SqliteStore } from "../storage/sqliteStore.js";

export const PACKAGE_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/;
const STORE_KEY_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,200}$/;
// 必须与配置型场景包的 `packageRuns` 集合分开：两者记录形状不同，共用会让读取方互相污染。
const PACKAGE_RUNS_COLLECTION = "codeScenePackageRuns";
const PACKAGE_STORE_COLLECTION = "codeScenePackageStore";
const DEFAULT_ENTRY = "index.mjs";
const MAX_STORE_VALUE_BYTES = 1_000_000;
const MAX_ERROR_LENGTH = 500;

const executorSchema = z.object({
  sceneId: z.string().min(1),
  versionId: z.string().min(1),
});

const packageJsonSchema = z.object({
  zaneScenePackage: z.object({
    title: z.string().min(1),
    version: z.string().min(1),
    executor: executorSchema,
    inputs: z.array(z.record(z.string(), z.unknown())).optional(),
    entry: z.string().min(1).optional(),
  }),
});

export interface CodeScenePackageExecutor {
  sceneId: string;
  versionId: string;
}

export interface CodeScenePackageManifest {
  title: string;
  version: string;
  executor: CodeScenePackageExecutor;
  inputs: Array<Record<string, unknown>>;
  entry: string;
}

export type CodeScenePackageStatus = "ok" | "error";

export interface CodeScenePackageRegistryEntry {
  packageId: string;
  status: CodeScenePackageStatus;
  directory: string;
  error?: string;
  manifest?: CodeScenePackageManifest;
  entryPath?: string;
  loadedAt?: string;
}

export interface CodeScenePackageRun {
  id: string;
  revision: number;
  kind: "code-scene-package";
  packageId: string;
  packageTitle: string;
  executorSceneId: string;
  executorVersionId: string;
  packageRunId: string;
  ownerUserId: string;
  submitter?: RunSubmitter;
  status: "running" | "completed" | "failed";
  createdAt: string;
  updatedAt: string;
  finishedAt?: string;
  runIds: string[];
  error?: string;
  errorCode?: string;
  result?: JsonValue;
}

export interface CodeScenePackageFramework {
  env: {
    projectDirectory: string;
    workbenchBaseUrl: string;
    packageId: string;
    packageRunId: string;
  };
  package: { packageId: string; title: string; version: string };
  scenes: {
    run(input?: unknown): Promise<{
      runId: string;
      status: string;
      sceneId: string;
      versionId: string;
      runTitle: string;
      packageRunId: string;
    }>;
    wait(runId: string, options?: { timeoutMs?: number; signal?: AbortSignal }): Promise<RunRecord>;
    cancel(runId: string): Promise<{ runId: string; status: string }>;
    outputs(runId: string): Promise<{ runId: string; status: string; outputs: RunRecord["outputs"] }>;
  };
  assets: {
    save(nameOrInput: unknown, mediaValue?: unknown): Promise<unknown>;
  };
  store: {
    get(key: string): Promise<{ value: JsonValue; revision: number } | undefined>;
    set(key: string, value: unknown, options?: { expectedRevision?: number }): Promise<{ revision: number }>;
  };
  log(level: "info" | "warn" | "error", message: string, fields?: Record<string, unknown>): void;
}

export interface CodeScenePackageDependencies {
  store: SqliteStore;
  scenes: Pick<AiSceneService, "prepare">;
  runs: Pick<RunService, "submit" | "wait" | "cancel" | "getRun">;
  assets?: Pick<AssetService, "save">;
  loadSettings(): Promise<SavedSettings>;
  workbenchBaseUrl?(): string;
  packagesRoot?(projectDirectory: string): string;
  resolveOwner?(): { ownerUserId: string; submitter?: RunSubmitter } | undefined;
  importEntry?(url: string): Promise<unknown>;
  now?(): Date;
}

interface InvocationContext {
  packageRunId: string;
  projectDirectory: string;
  ownerUserId: string;
  submitter?: RunSubmitter;
  runIds: string[];
}

interface LoadedPackage {
  packageId: string;
  directory: string;
  projectDirectory: string;
  manifest: CodeScenePackageManifest;
  entryPath: string;
  framework: CodeScenePackageFramework;
  run: (input: unknown) => unknown;
  loadedAt: string;
}

const OPERATOR_IDENTITY = {
  ownerUserId: "@operator",
  submitter: { userId: "@operator", username: "operator", displayName: "运维管理员" },
};

export class CodeScenePackageService {
  private readonly entries = new Map<string, LoadedPackage>();
  private readonly statuses = new Map<string, CodeScenePackageRegistryEntry>();
  private readonly active = new AsyncLocalStorage<InvocationContext>();
  private readonly busy = new Set<string>();
  private importCounter = 0;

  constructor(private readonly deps: CodeScenePackageDependencies) {}

  private now(): Date {
    return this.deps.now ? this.deps.now() : new Date();
  }

  private rootFor(projectDirectory: string): string {
    return this.deps.packagesRoot ? this.deps.packagesRoot(projectDirectory) : path.join(projectDirectory, "scene-packages");
  }

  private async projectDirectory(): Promise<string> {
    const settings = await this.deps.loadSettings();
    return settings.projectDirectory;
  }

  private safeError(error: unknown): string {
    const text = error instanceof Error ? error.message : String(error);
    return redactErrorText(text).replace(/\s+/g, " ").trim().slice(0, MAX_ERROR_LENGTH);
  }

  list(): CodeScenePackageRegistryEntry[] {
    return [...this.statuses.values()].sort((left, right) => left.packageId.localeCompare(right.packageId));
  }

  get(packageId: string): CodeScenePackageRegistryEntry | undefined {
    return this.statuses.get(packageId);
  }

  async loadAll(): Promise<{ loaded: number; failed: number; packages: CodeScenePackageRegistryEntry[] }> {
    const project = await this.projectDirectory();
    this.statuses.clear();
    this.entries.clear();
    if (!project) return { loaded: 0, failed: 0, packages: [] };

    const root = this.rootFor(project);
    let dirents: Array<{ name: string; isDirectory(): boolean }>;
    try {
      dirents = await readdir(root, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { loaded: 0, failed: 0, packages: [] };
      const failure: CodeScenePackageRegistryEntry = { packageId: root, status: "error", directory: root, error: this.safeError(error), loadedAt: this.now().toISOString() };
      this.statuses.set(root, failure);
      return { loaded: 0, failed: 1, packages: [failure] };
    }

    const ids = dirents.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
    for (const id of ids) await this.loadOne(project, id, root);

    const packages = this.list();
    const loaded = packages.filter((entry) => entry.status === "ok").length;
    const failed = packages.filter((entry) => entry.status === "error").length;
    // 启动日志按业务口径给一行可读汇总（验收依赖这一行），明细另走 scene_package.* 事件。
    writeLog(failed ? "warn" : "info", `已加载 ${loaded} 个场景包：${packages.filter((entry) => entry.status === "ok").map((entry) => entry.packageId).join(", ") || "无"}`, { loaded, failed, packages: packages.map((entry) => ({ packageId: entry.packageId, status: entry.status })) });
    return { loaded, failed, packages };
  }

  async reload(packageId: string): Promise<CodeScenePackageRegistryEntry> {
    if (!PACKAGE_ID_PATTERN.test(packageId)) {
      const error = new HttpError(400, "场景包ID无效", "INVALID_PACKAGE_ID", { packageId });
      const status: CodeScenePackageRegistryEntry = { packageId, status: "error", directory: "", error: this.safeError(error), loadedAt: this.now().toISOString() };
      this.statuses.set(packageId, status);
      this.entries.delete(packageId);
      throw error;
    }
    const project = await this.projectDirectory();
    if (!project) throw new HttpError(409, "请先配置项目目录", "PROJECT_NOT_CONFIGURED");
    return this.loadOne(project, packageId, this.rootFor(project));
  }

  private async loadOne(project: string, packageId: string, root: string): Promise<CodeScenePackageRegistryEntry> {
    const directory = path.join(root, packageId);
    const loadedAt = this.now().toISOString();

    if (!PACKAGE_ID_PATTERN.test(packageId)) {
      const entry: CodeScenePackageRegistryEntry = { packageId, status: "error", directory, error: "场景包目录名无效：只允许字母、数字、下划线、点与短横线，且必须以字母或数字开头", loadedAt };
      this.statuses.set(packageId, entry);
      this.entries.delete(packageId);
      return entry;
    }

    try {
      const manifest = await this.readManifest(packageId, directory);
      const entryPath = path.resolve(directory, manifest.entry);
      const relative = path.relative(directory, entryPath);
      if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
        throw new HttpError(400, "场景包入口不能指向包目录之外", "PACKAGE_ENTRY_INVALID", { packageId, entry: manifest.entry });
      }

      const extension = path.extname(entryPath).toLowerCase();
      if (extension !== ".mjs" && extension !== ".js" && extension !== ".ts" && extension !== ".mts" && extension !== ".cts") {
        throw new HttpError(400, "场景包入口扩展名不支持：" + manifest.entry, "PACKAGE_ENTRY_UNSUPPORTED", { packageId, entry: manifest.entry });
      }

      const importer = this.deps.importEntry ?? ((url: string) => import(url));
      const imported = await importer(pathToFileURL(entryPath).href + "?v=" + ++this.importCounter);
      const moduleRecord = asRecord(imported);
      const factory = moduleRecord?.default;
      if (typeof factory !== "function") {
        throw new HttpError(400, "场景包入口缺少 default 工厂函数", "PACKAGE_ENTRY_INVALID", { packageId });
      }

      const framework = this.createFramework(packageId, manifest);
      let created: unknown;
      try {
        created = await (factory as (framework: CodeScenePackageFramework) => unknown)(framework);
      } catch (error) {
        throw new HttpError(500, "场景包工厂执行失败：" + this.safeError(error), "PACKAGE_FACTORY_FAILED", { packageId });
      }
      const run = asRecord(created)?.run;
      if (typeof run !== "function") {
        throw new HttpError(400, "场景包工厂必须返回 { run }", "PACKAGE_ENTRY_INVALID", { packageId });
      }

      const loaded: LoadedPackage = {
        packageId,
        directory,
        projectDirectory: project,
        manifest,
        entryPath,
        framework,
        run: run as (input: unknown) => unknown,
        loadedAt,
      };
      this.entries.set(packageId, loaded);

      const status: CodeScenePackageRegistryEntry = {
        packageId,
        status: "ok",
        directory,
        manifest,
        entryPath,
        loadedAt,
      };
      this.statuses.set(packageId, status);
      writeLog("info", "scene_package.loaded", { packageId, directory, title: manifest.title, version: manifest.version });
      return status;
    } catch (error) {
      const message = this.safeError(error);
      const status: CodeScenePackageRegistryEntry = { packageId, status: "error", directory, error: message, loadedAt };
      this.statuses.set(packageId, status);
      this.entries.delete(packageId);
      writeLog("warn", "scene_package.load_failed", { packageId, directory, error: message });
      return status;
    }
  }

  private async readManifest(packageId: string, directory: string): Promise<CodeScenePackageManifest> {
    let text: string;
    try {
      text = await readFile(path.join(directory, "package.json"), "utf8");
    } catch {
      throw new HttpError(404, "场景包缺少 package.json", "PACKAGE_MANIFEST_MISSING", { packageId });
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      throw new HttpError(400, "package.json 不是有效 JSON：" + this.safeError(error), "PACKAGE_MANIFEST_INVALID", { packageId });
    }
    const result = packageJsonSchema.safeParse(parsed);
    if (!result.success) {
      throw new HttpError(400, "场景包元数据无效：" + result.error.issues.map((issue) => issue.path.join(".") + ": " + issue.message).join("; "), "PACKAGE_MANIFEST_INVALID", { packageId });
    }
    const meta = result.data.zaneScenePackage;
    return {
      title: meta.title,
      version: meta.version,
      executor: meta.executor,
      inputs: meta.inputs ?? [],
      entry: meta.entry ?? DEFAULT_ENTRY,
    };
  }

  private createFramework(packageId: string, manifest: CodeScenePackageManifest): CodeScenePackageFramework {
    const service = this;
    return {
      env: {
        get projectDirectory() {
          return service.active.getStore()?.projectDirectory ?? "";
        },
        get workbenchBaseUrl() {
          return service.deps.workbenchBaseUrl ? service.deps.workbenchBaseUrl() : "";
        },
        packageId,
        get packageRunId() {
          return service.active.getStore()?.packageRunId ?? "";
        },
      },
      package: { packageId, title: manifest.title, version: manifest.version },
      scenes: {
        run: (input) => service.sceneRun(packageId, manifest, input),
        wait: (runId, options) => service.sceneWait(runId, options),
        cancel: (runId) => service.sceneCancel(runId),
        outputs: (runId) => service.sceneOutputs(runId),
      },
      assets: {
        save: (nameOrInput, mediaValue) => service.assetSave(nameOrInput, mediaValue),
      },
      store: {
        get: (key) => service.storeGet(packageId, key),
        set: (key, value, options) => service.storeSet(packageId, key, value, options),
      },
      log: (level, message, fields) => service.packageLog(packageId, manifest, level, message, fields),
    };
  }

  private requireContext(): InvocationContext {
    const context = this.active.getStore();
    if (!context) throw new HttpError(409, "场景包框架方法只能在 run() 执行期间调用", "PACKAGE_CONTEXT_MISSING");
    return context;
  }

  private async sceneRun(packageId: string, manifest: CodeScenePackageManifest, raw: unknown): Promise<{
    runId: string;
    status: string;
    sceneId: string;
    versionId: string;
    runTitle: string;
    packageRunId: string;
  }> {
    const context = this.requireContext();
    const body = asRecord(raw) ?? {};
    const suppliedSceneId = body.sceneId;
    const suppliedVersionId = body.versionId;
    const inputsBody = asRecord(body.inputs);
    // Only the executor fields at the call's top level can change attribution. A scene may
    // legitimately declare an input literally named "sceneId"; that is payload, not executor.
    if (suppliedSceneId !== undefined && suppliedSceneId !== manifest.executor.sceneId) throw executorMismatch(packageId, "sceneId", suppliedSceneId, manifest.executor.sceneId);
    if (suppliedVersionId !== undefined && suppliedVersionId !== manifest.executor.versionId) throw executorMismatch(packageId, "versionId", suppliedVersionId, manifest.executor.versionId);

    const reserved = new Set(["sceneId", "versionId", "title", "runTitle", "inputs", "inputValues"]);
    const flatInputs = Object.fromEntries(Object.entries(body).filter(([key]) => !reserved.has(key)));
    const inputValues = asRecord(body.inputValues) ?? inputsBody ?? (Object.keys(flatInputs).length ? flatInputs : {});

    const titleSource = body.title ?? body.runTitle;
    const title = typeof titleSource === "string" && titleSource.trim() ? titleSource.trim().slice(0, 80) : manifest.title;
    const runTitle = `${manifest.title} · ${title}`.slice(0, 120);

    const prepared = await this.deps.scenes.prepare(manifest.executor.sceneId, manifest.executor.versionId, inputValues as Record<string, JsonValue>);
    const runId = randomUUID();
    const run = await this.deps.runs.submit(
      { runId, runTitle, workflow: prepared.workflow, inputValues: prepared.inputValues, packageRunId: context.packageRunId },
      { ownerUserId: context.ownerUserId, ...(context.submitter ? { submitter: context.submitter } : {}), authorize: () => undefined },
    );
    context.runIds.push(run.runId);
    return {
      runId: run.runId,
      status: run.status,
      sceneId: manifest.executor.sceneId,
      versionId: manifest.executor.versionId,
      runTitle: run.runTitle ?? runTitle,
      packageRunId: context.packageRunId,
    };
  }

  private async sceneWait(runId: unknown, options?: { timeoutMs?: number; signal?: AbortSignal }): Promise<RunRecord> {
    const context = this.requireContext();
    if (typeof runId !== "string" || !runId) throw new HttpError(400, "运行ID无效", "INVALID_PACKAGE_RUN_ID");
    const project = context.projectDirectory;
    const timeoutMs = options?.timeoutMs && options.timeoutMs > 0 ? Math.min(options.timeoutMs, 10 * 60 * 1000) : 0;
    if (!timeoutMs) return this.deps.runs.wait(project, runId, options?.signal);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new HttpError(504, "等待运行超时", "PACKAGE_WAIT_TIMEOUT")), timeoutMs);
    try {
      return await this.deps.runs.wait(project, runId, controller.signal);
    } finally {
      clearTimeout(timer);
    }
  }

  private async sceneCancel(runId: unknown): Promise<{ runId: string; status: string }> {
    const context = this.requireContext();
    if (typeof runId !== "string" || !runId) throw new HttpError(400, "运行ID无效", "INVALID_PACKAGE_RUN_ID");
    const result = await this.deps.runs.cancel(context.projectDirectory, runId);
    const record = asRecord(result);
    return { runId: typeof record?.runId === "string" ? record.runId : runId, status: typeof record?.status === "string" ? record.status : "cancelled" };
  }

  private async sceneOutputs(runId: unknown): Promise<{ runId: string; status: string; outputs: RunRecord["outputs"] }> {
    const context = this.requireContext();
    if (typeof runId !== "string" || !runId) throw new HttpError(400, "运行ID无效", "INVALID_PACKAGE_RUN_ID");
    const run = await this.deps.runs.getRun(context.projectDirectory, runId);
    if (!run) throw new HttpError(404, "运行不存在", "RUN_NOT_FOUND", { runId });
    return { runId: run.runId, status: run.status, outputs: run.outputs };
  }

  private async assetSave(raw: unknown, mediaValue?: unknown): Promise<unknown> {
    if (!this.deps.assets) throw new HttpError(501, "当前环境未接入素材服务", "PACKAGE_ASSETS_UNAVAILABLE");
    const context = this.requireContext();
    // 两种调用形状都接受：save({name, source}) 或规格 §4 的 save(name, mediaValue)。
    const body = mediaValue !== undefined ? { name: String(raw ?? ""), source: mediaValue } : raw;
    return this.deps.assets.save(body, undefined, { ownerUserId: context.ownerUserId, authorize: () => undefined });
  }

  private async storeGet(packageId: string, key: string): Promise<{ value: JsonValue; revision: number } | undefined> {
    if (!STORE_KEY_PATTERN.test(key)) throw new HttpError(400, "存储键无效", "INVALID_PACKAGE_STORE_KEY", { key });
    const context = this.requireContext();
    const document = this.deps.store.getDocument<{ id: string; revision: number; value: JsonValue }>(context.projectDirectory, PACKAGE_STORE_COLLECTION, storeDocumentId(packageId, key));
    if (!document) return undefined;
    return { value: document.value, revision: document.revision };
  }

  private async storeSet(packageId: string, key: string, value: unknown, options?: { expectedRevision?: number }): Promise<{ revision: number }> {
    if (!STORE_KEY_PATTERN.test(key)) throw new HttpError(400, "存储键无效", "INVALID_PACKAGE_STORE_KEY", { key });
    const context = this.requireContext();
    const serialized = jsonValue(value);
    const id = storeDocumentId(packageId, key);
    const current = this.deps.store.getDocument<{ revision: number }>(context.projectDirectory, PACKAGE_STORE_COLLECTION, id);
    const expected = options?.expectedRevision ?? 0;
    if (!Number.isSafeInteger(expected) || expected < 0) throw new HttpError(400, "revision 无效", "INVALID_PACKAGE_STORE_REVISION", { key });
    try {
      const saved = this.deps.store.putDocumentChecked(context.projectDirectory, PACKAGE_STORE_COLLECTION, { id, revision: expected, packageId, key, value: serialized, updatedAt: this.now().toISOString() }, expected);
      return { revision: saved.revision };
    } catch (error) {
      if ((error as Error).message === "DOCUMENT_CONFLICT") {
        throw new HttpError(409, "场景包存储已被修改，请重新读取", "PACKAGE_STORE_CONFLICT", { key, currentRevision: current?.revision ?? 0 });
      }
      throw error;
    }
  }

  private packageLog(packageId: string, manifest: CodeScenePackageManifest, level: "info" | "warn" | "error", message: string, fields?: Record<string, unknown>): void {
    const context = this.active.getStore();
    const safeLevel = level === "warn" || level === "error" ? level : "info";
    writeLog(safeLevel, "scene_package.log", {
      packageId,
      packageRunId: context?.packageRunId ?? "",
      executorSceneId: manifest.executor.sceneId,
      message: message.slice(0, 500),
      ...(fields ?? {}),
    });
  }

  async invoke(packageId: string, raw?: unknown): Promise<{
    packageRunId: string;
    packageId: string;
    status: "completed" | "failed";
    result?: JsonValue;
    error?: string;
    errorCode?: string;
    runIds: string[];
  }> {
    const loaded = this.entries.get(packageId);
    const status = this.statuses.get(packageId);
    if (!loaded || !status || status.status !== "ok") {
      throw new HttpError(status ? 409 : 404, "场景包不存在或加载失败", "PACKAGE_NOT_LOADED", { packageId, error: status?.error });
    }
    if (this.busy.has(packageId)) throw new HttpError(409, "场景包正在运行", "PACKAGE_BUSY", { packageId });

    const project = await this.projectDirectory();
    if (!project) throw new HttpError(409, "请先配置项目目录", "PROJECT_NOT_CONFIGURED");

    const owner = this.deps.resolveOwner?.() ?? OPERATOR_IDENTITY;
    const createdAt = this.now().toISOString();
    const packageRunId = randomUUID();
    const record: CodeScenePackageRun = {
      id: packageRunId,
      revision: 0,
      kind: "code-scene-package",
      packageId,
      packageTitle: loaded.manifest.title,
      executorSceneId: loaded.manifest.executor.sceneId,
      executorVersionId: loaded.manifest.executor.versionId,
      packageRunId,
      ownerUserId: owner.ownerUserId,
      ...(owner.submitter ? { submitter: owner.submitter } : {}),
      status: "running",
      createdAt,
      updatedAt: createdAt,
      runIds: [],
    };
    this.putRun(project, record, 0);

    const context: InvocationContext = {
      packageRunId,
      projectDirectory: project,
      ownerUserId: owner.ownerUserId,
      submitter: owner.submitter,
      runIds: [],
    };

    this.busy.add(packageId);
    const abort = new AbortController();
    // 入口契约（规格 §3）：run({ inputs, runId, signal, log })。log 必须是可直接调用的函数，
    // 不能只挂在 framework 上，否则照规格写的包会在第一行日志处失败。
    const runInput = {
      ...(asRecord(raw) ?? {}),
      runId: packageRunId,
      signal: abort.signal,
      log: (level: "info" | "warn" | "error", message: string, fields?: Record<string, unknown>) => this.packageLog(packageId, loaded.manifest, level, message, fields),
    };
    try {
      const result = await this.active.run(context, async () => loaded.run(runInput));
      const finishedAt = this.now().toISOString();
      this.updateRun(project, packageRunId, (current) => ({
        ...current,
        status: "completed",
        finishedAt,
        updatedAt: finishedAt,
        runIds: [...context.runIds],
        result: jsonValue(result),
      }));
      return { packageRunId, packageId, status: "completed", result: jsonValue(result), runIds: [...context.runIds] };
    } catch (error) {
      const message = this.safeError(error);
      const finishedAt = this.now().toISOString();
      this.updateRun(project, packageRunId, (current) => ({
        ...current,
        status: "failed",
        finishedAt,
        updatedAt: finishedAt,
        runIds: [...context.runIds],
        error: message,
        ...(error instanceof HttpError ? { errorCode: error.code } : {}),
      }));
      const currentStatus = this.statuses.get(packageId);
      if (currentStatus) {
        this.statuses.set(packageId, { ...currentStatus, status: "error", error: message, loadedAt: currentStatus.loadedAt });
      }
      writeLog("error", "scene_package.run_failed", {
        packageId,
        packageRunId,
        executorSceneId: loaded.manifest.executor.sceneId,
        error: message,
      });
      return {
        packageRunId,
        packageId,
        status: "failed",
        error: message,
        errorCode: error instanceof HttpError ? error.code : "PACKAGE_RUN_FAILED",
        runIds: [...context.runIds],
      };
    } finally {
      this.busy.delete(packageId);
    }
  }

  async getPackageRun(packageRunId: string): Promise<CodeScenePackageRun | undefined> {
    const project = await this.projectDirectory();
    if (!project) return undefined;
    return this.deps.store.getDocument<CodeScenePackageRun>(project, PACKAGE_RUNS_COLLECTION, packageRunId);
  }

  private putRun(project: string, record: CodeScenePackageRun, expectedRevision: number): CodeScenePackageRun {
    try {
      return this.deps.store.putDocumentChecked(project, PACKAGE_RUNS_COLLECTION, record, expectedRevision);
    } catch (error) {
      if ((error as Error).message === "DOCUMENT_CONFLICT") {
        throw new HttpError(409, "场景包运行已被修改", "PACKAGE_RUN_CONFLICT", { packageRunId: record.id });
      }
      throw error;
    }
  }

  private updateRun(project: string, packageRunId: string, transform: (current: CodeScenePackageRun) => CodeScenePackageRun): void {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const current = this.deps.store.getDocument<CodeScenePackageRun>(project, PACKAGE_RUNS_COLLECTION, packageRunId);
      if (!current) return;
      try {
        this.deps.store.putDocumentChecked(project, PACKAGE_RUNS_COLLECTION, { ...transform(current), updatedAt: this.now().toISOString() }, current.revision);
        return;
      } catch (error) {
        if ((error as Error).message !== "DOCUMENT_CONFLICT") throw error;
      }
    }
  }
}

function storeDocumentId(packageId: string, key: string): string {
  return packageId + "/" + key;
}

function executorMismatch(packageId: string, field: "sceneId" | "versionId", supplied: unknown, expected: string): HttpError {
  return new HttpError(400, "场景包只能执行配置的执行器：" + expected + "；不能改为 " + String(supplied), "PACKAGE_EXECUTOR_MISMATCH", {
    packageId,
    field,
    expected,
    supplied: typeof supplied === "string" ? supplied : typeof supplied,
  });
}

function jsonValue(value: unknown): JsonValue {
  if (value === undefined || value === null) return null;
  try {
    const text = JSON.stringify(value);
    if (typeof text !== "string" || text.length > MAX_STORE_VALUE_BYTES) throw new Error("too large");
    return JSON.parse(text) as JsonValue;
  } catch {
    throw new HttpError(400, "值不是可序列化的 JSON", "INVALID_PACKAGE_STORE_VALUE");
  }
}
