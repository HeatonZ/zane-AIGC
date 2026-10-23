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
const PACKAGE_CONFIG_COLLECTION = "codePackageConfigs";
const executorSchema = z.object({
  sceneId: z.string().min(1),
  versionId: z.string().min(1),
});

const configDocumentSchema = z.object({
  id: z.string().min(1),
  revision: z.int().min(0),
  enabled: z.boolean(),
  executor: executorSchema.nullable().optional(),
  inputs: z.array(z.object({
    key: z.string().min(1).max(200),
    label: z.string().max(200).optional(),
    required: z.boolean().optional(),
    defaultValue: z.unknown().optional(),
  }).strict()).max(200).optional(),
  presentation: z.record(z.string(), z.unknown()).optional(),
  pricing: z.record(z.string(), z.unknown()).optional(),
  updatedAt: z.string().optional(),
}).strict();

export type CodeScenePackageConfigDocument = z.output<typeof configDocumentSchema>;
const DEFAULT_ENTRY = "index.mjs";
const MAX_STORE_VALUE_BYTES = 1_000_000;
const MAX_ERROR_LENGTH = 500;

const packageJsonSchema = z.object({
  zaneScenePackage: z.object({
    title: z.string().min(1),
    version: z.string().min(1),
    // 规格 §2：executor 可省略，省略时取管理端配置（管理端为准）。
    executor: executorSchema.optional(),
    inputs: z.array(z.record(z.string(), z.unknown())).optional(),
    entry: z.string().min(1).optional(),
  }),
});

export interface CodeScenePackageExecutor {
  sceneId: string;
  versionId: string;
}

/** package.json 里声明的元数据：executor 可省略（省略时取管理端配置）。 */
export interface DeclaredScenePackageManifest {
  title: string;
  version: string;
  executor?: CodeScenePackageExecutor;
  inputs: Array<Record<string, unknown>>;
  entry: string;
}

/** 已解析的执行契约：executor 一定存在，运行期只认这个形状。 */
export interface CodeScenePackageManifest extends DeclaredScenePackageManifest {
  executor: CodeScenePackageExecutor;
}

export type CodeScenePackageStatus = "ok" | "error" | "disabled";

export interface CodeScenePackageConfig {
  id: string;
  revision: number;
  enabled: boolean;
  /** null = 显式清空管理端覆盖，回退 package.json 默认值。 */
  executor?: { sceneId: string; versionId: string } | null;
  inputs?: Array<{ key: string; label?: string; required?: boolean; defaultValue?: unknown }>;
  presentation?: Record<string, unknown>;
  pricing?: Record<string, unknown>;
  updatedAt?: string;
}

export interface CodeScenePackageRegistryEntry {
  packageId: string;
  status: CodeScenePackageStatus;
  directory: string;
  error?: string;
  manifest?: DeclaredScenePackageManifest;
  entryPath?: string;
  loadedAt?: string;
  enabled: boolean;
  executor?: { sceneId: string; versionId: string };
  config?: CodeScenePackageConfig;
  revision?: number;
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
  /** 生效的执行场景：管理端配置优先，package.json 只作默认值（规格 §2/§6）。 */
  executor: CodeScenePackageExecutor;
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

  async loadAll(): Promise<{ loaded: number; failed: number; disabled: number; packages: CodeScenePackageRegistryEntry[] }> {
    const project = await this.projectDirectory();
    this.statuses.clear();
    this.entries.clear();
    if (!project) return { loaded: 0, failed: 0, disabled: 0, packages: [] };

    const root = this.rootFor(project);
    let dirents: Array<{ name: string; isDirectory(): boolean }>;
    try {
      dirents = await readdir(root, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { loaded: 0, failed: 0, disabled: 0, packages: [] };
      const failure: CodeScenePackageRegistryEntry = { packageId: root, status: "error", directory: root, error: this.safeError(error), loadedAt: this.now().toISOString(), enabled: true };
      this.statuses.set(root, failure);
      return { loaded: 0, failed: 1, disabled: 0, packages: [failure] };
    }

    const ids = dirents.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
    for (const id of ids) await this.loadOne(project, id, root);

    const packages = this.list();
    const loaded = packages.filter((entry) => entry.status === "ok").length;
    const failed = packages.filter((entry) => entry.status === "error").length;
    const disabled = packages.filter((entry) => entry.status === "disabled").length;
    // 启动日志按业务口径给一行可读汇总（验收依赖这一行），明细另走 scene_package.* 事件。
    writeLog(failed ? "warn" : "info", `已加载 ${loaded} 个场景包：${packages.filter((entry) => entry.status === "ok").map((entry) => entry.packageId).join(", ") || "无"}`, { loaded, failed, disabled, packages: packages.map((entry) => ({ packageId: entry.packageId, status: entry.status })) });
    return { loaded, failed, disabled, packages };
  }

  private configFor(project: string, packageId: string): CodeScenePackageConfigDocument | undefined {
    const raw = this.deps.store.getDocument<unknown>(project, PACKAGE_CONFIG_COLLECTION, packageId);
    if (raw === undefined) return undefined;
    const parsed = configDocumentSchema.safeParse(raw);
    return parsed.success ? parsed.data : undefined;
  }

  private effectiveExecutor(config: CodeScenePackageConfigDocument | undefined, manifest: DeclaredScenePackageManifest): CodeScenePackageExecutor | undefined {
    return config?.executor ?? manifest.executor;
  }

  private decorateStatus(project: string, entry: CodeScenePackageRegistryEntry): CodeScenePackageRegistryEntry {
    const config = this.configFor(project, entry.packageId);
    const manifest = entry.manifest;
    const enabled = config?.enabled ?? true;
    const executor = manifest ? this.effectiveExecutor(config, manifest) : config?.executor ?? undefined;
    return {
      ...entry,
      enabled,
      ...(config ? { config, revision: config.revision } : { revision: 0 }),
      ...(executor ? { executor } : {}),
      ...(enabled ? {} : { status: "disabled" as const }),
    };
  }

  async getAdminList(): Promise<{ packages: CodeScenePackageRegistryEntry[]; nextAction: "configure_code_package" }> {
    const project = await this.projectDirectory();
    if (!project) throw new HttpError(409, "请先配置项目目录", "PROJECT_NOT_CONFIGURED");
    const root = this.rootFor(project);
    let names: string[] = [];
    try {
      names = (await readdir(root, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    // 保留 registry 中启动时失败的目录状态；同时也能呈现启动后新增的磁盘目录。
    const ids = new Set([...names, ...this.statuses.keys()].filter((id) => id && id !== root));
    const packages: CodeScenePackageRegistryEntry[] = [];
    for (const packageId of [...ids].sort()) {
      let entry = this.statuses.get(packageId);
      if (!entry && names.includes(packageId)) {
        entry = await this.loadOne(project, packageId, root);
      }
      if (!entry) continue;
      packages.push(this.decorateStatus(project, entry));
    }
    return { packages, nextAction: "configure_code_package" };
  }

  async updateConfig(packageId: string, raw: unknown): Promise<{ package: CodeScenePackageRegistryEntry; nextAction: "reload_code_package" }> {
    if (!PACKAGE_ID_PATTERN.test(packageId)) throw new HttpError(400, "场景包ID无效", "INVALID_PACKAGE_ID", { packageId });
    const project = await this.projectDirectory();
    if (!project) throw new HttpError(409, "请先配置项目目录", "PROJECT_NOT_CONFIGURED");
    const body = asRecord(raw) ?? {};
    const current = this.configFor(project, packageId);
    const expectedRevision = body.revision;
    if (!Number.isSafeInteger(expectedRevision) || (expectedRevision as number) < 0) throw new HttpError(400, "revision 无效", "INVALID_CODE_PACKAGE_REVISION");
    if ((current?.revision ?? 0) !== expectedRevision) throw new HttpError(409, "场景包配置已变化，请重新读取", "CODE_PACKAGE_REVISION_CONFLICT", { currentRevision: current?.revision ?? 0 });
    const manifestEntry = this.statuses.get(packageId);
    const manifest = manifestEntry?.manifest;
    const next = {
      id: packageId,
      revision: expectedRevision as number,
      enabled: typeof body.enabled === "boolean" ? body.enabled : current?.enabled ?? true,
      executor: body.executor === null ? null : body.executor === undefined ? current?.executor ?? null : body.executor,
      inputs: Array.isArray(body.inputs) ? body.inputs : current?.inputs ?? [],
      ...(body.presentation !== undefined ? { presentation: body.presentation } : current?.presentation ? { presentation: current.presentation } : {}),
      ...(body.pricing !== undefined ? { pricing: body.pricing } : current?.pricing ? { pricing: current.pricing } : {}),
      updatedAt: this.now().toISOString(),
    };
    const parsed = configDocumentSchema.safeParse(next);
    if (!parsed.success) throw new HttpError(400, "场景包配置格式无效", "INVALID_CODE_PACKAGE_CONFIG", { issues: parsed.error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })) });
    const effective = parsed.data.executor ?? manifest?.executor;
    if (parsed.data.enabled && (!effective?.sceneId || !effective.versionId)) throw new HttpError(400, "必须选择执行场景和已发布版本", "CODE_PACKAGE_EXECUTOR_REQUIRED");
    try {
      const saved = this.deps.store.putDocumentChecked(project, PACKAGE_CONFIG_COLLECTION, parsed.data, expectedRevision as number);
      if (!saved.enabled) {
        this.entries.delete(packageId);
        const old = this.statuses.get(packageId);
        if (old) this.statuses.set(packageId, { ...old, enabled: false, status: "disabled", config: saved, revision: saved.revision });
      } else {
        const old = this.statuses.get(packageId);
        if (old) this.statuses.set(packageId, this.decorateStatus(project, { ...old, enabled: true, config: saved, revision: saved.revision }));
      }
      const entry = this.statuses.get(packageId);
      if (!entry) throw new HttpError(404, "磁盘上没有此场景包", "CODE_PACKAGE_NOT_FOUND", { packageId });
      return { package: this.decorateStatus(project, entry), nextAction: "reload_code_package" };
    } catch (error) {
      if ((error as Error).message === "DOCUMENT_CONFLICT") {
        const latest = this.configFor(project, packageId);
        throw new HttpError(409, "场景包配置已变化，请重新读取", "CODE_PACKAGE_REVISION_CONFLICT", { currentRevision: latest?.revision ?? 0 });
      }
      throw error;
    }
  }

  async reload(packageId: string): Promise<CodeScenePackageRegistryEntry> {
    if (!PACKAGE_ID_PATTERN.test(packageId)) {
      const error = new HttpError(400, "场景包ID无效", "INVALID_PACKAGE_ID", { packageId });
      const status: CodeScenePackageRegistryEntry = { packageId, status: "error", directory: "", enabled: true, revision: 0, error: this.safeError(error), loadedAt: this.now().toISOString() };
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
      const entry: CodeScenePackageRegistryEntry = { packageId, status: "error", directory, enabled: true, revision: 0, error: "场景包目录名无效：只允许字母、数字、下划线、点与短横线，且必须以字母或数字开头", loadedAt };
      this.statuses.set(packageId, entry);
      this.entries.delete(packageId);
      return entry;
    }

    try {
      const declared = await this.readManifest(packageId, directory);
      const config = this.configFor(project, packageId);
      const enabled = config?.enabled ?? true;
      const executor = this.effectiveExecutor(config, declared);
      // 管理端配置为准（规格 §2/§6）：package.json 只作默认值。缺执行场景时该包不可运行，
      // 但磁盘代码仍要能列出来，让管理员在配置面板里补选。
      const manifest: DeclaredScenePackageManifest = declared;
      if (!enabled) {
        const status: CodeScenePackageRegistryEntry = {
          packageId, status: "disabled", directory, manifest, enabled: false,
          ...(executor ? { executor } : {}),
          ...(config ? { config, revision: config.revision } : { revision: 0 }),
          loadedAt,
        };
        this.statuses.set(packageId, status);
        this.entries.delete(packageId);
        writeLog("info", "scene_package.disabled", { packageId, directory });
        return status;
      }
      if (!executor) {
        throw new HttpError(400, "未配置执行场景：请在此场景包的配置面板选择执行场景与已发布版本", "CODE_PACKAGE_EXECUTOR_REQUIRED", { packageId });
      }
      const resolved: CodeScenePackageManifest = { ...manifest, executor };
      const entryPath = path.resolve(directory, resolved.entry);
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

      const framework = this.createFramework(packageId, resolved);
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
        manifest: resolved,
        executor,
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
        enabled: true,
        executor,
        ...(config ? { config, revision: config.revision } : { revision: 0 }),
        entryPath,
        loadedAt,
      };
      this.statuses.set(packageId, status);
      writeLog("info", "scene_package.loaded", { packageId, directory, title: manifest.title, version: manifest.version });
      return status;
    } catch (error) {
      const message = this.safeError(error);
      const config = this.configFor(project, packageId);
      const status: CodeScenePackageRegistryEntry = {
        packageId, status: "error", directory, error: message, loadedAt,
        enabled: config?.enabled ?? true,
        ...(config?.executor ? { executor: config.executor } : {}),
        ...(config ? { config, revision: config.revision } : { revision: 0 }),
      };
      this.statuses.set(packageId, status);
      this.entries.delete(packageId);
      writeLog("warn", "scene_package.load_failed", { packageId, directory, error: message });
      return status;
    }
  }

  private async readManifest(packageId: string, directory: string): Promise<DeclaredScenePackageManifest> {
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
    const loaded = this.requireRunnable(packageId);
    const packageRunId = await this.reserveRun(packageId, loaded);
    const outcome = await this.executeRun(packageId, loaded, packageRunId, raw);
    return outcome;
  }

  /** 可取运行的包：已加载且状态 ok。 */
  private requireRunnable(packageId: string): LoadedPackage {
    const loaded = this.entries.get(packageId);
    const status = this.statuses.get(packageId);
    if (!loaded || !status || status.status !== "ok") {
      throw new HttpError(status ? 409 : 404, "场景包不存在或加载失败", "PACKAGE_NOT_LOADED", { packageId, error: status?.error });
    }
    if (this.busy.has(packageId)) throw new HttpError(409, "场景包正在运行", "PACKAGE_BUSY", { packageId });
    return loaded;
  }

  /** 建一条 running 记录并占住该包；返回 packageRunId。 */
  private async reserveRun(packageId: string, loaded: LoadedPackage): Promise<string> {
    // 占位必须同步完成：中间有 await，两个并发请求都能通过检查，包就会被同时跑两次。
    if (this.busy.has(packageId)) throw new HttpError(409, "场景包正在运行", "PACKAGE_BUSY", { packageId });
    this.busy.add(packageId);
    try {
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
      return packageRunId;
    } catch (error) {
      this.busy.delete(packageId);
      throw error;
    }
  }

  /** 执行一次已占位的包运行，并落终态。start() 与 invoke() 共用这一条路径。 */
  private async executeRun(packageId: string, loaded: LoadedPackage, packageRunId: string, raw?: unknown): Promise<{
    packageRunId: string;
    packageId: string;
    status: "completed" | "failed";
    result?: JsonValue;
    error?: string;
    errorCode?: string;
    runIds: string[];
  }> {
    const project = await this.projectDirectory();
    const owner = this.deps.resolveOwner?.() ?? OPERATOR_IDENTITY;
    const context: InvocationContext = {
      packageRunId,
      projectDirectory: project,
      ownerUserId: owner.ownerUserId,
      submitter: owner.submitter,
      runIds: [],
    };

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

  /**
   * 受理一次包运行并立即返回 packageRunId：包内通常会 `scenes.wait` 到子运行终态（分钟级），
   * 挂在 HTTP 请求上等它结束会撑爆请求超时，也会让「已受理」与「已跑完」两件事混在一个响应里。
   * 执行语义与 `invoke` 完全一致（同一条 `invoke` 代码路径），只是不 await。
   */
  async start(packageId: string, raw?: unknown): Promise<{ packageRunId: string; packageId: string; status: "running"; executorSceneId: string; executorVersionId: string; nextAction: "poll_package_run" }> {
    const loaded = this.requireRunnable(packageId);
    // 先同步占位再返回：调用方拿到 packageRunId 后立刻查详情时必须能查到，不能出现「已返回但记录还没有」的窗口。
    const packageRunId = await this.reserveRun(packageId, loaded);
    void this.executeRun(packageId, loaded, packageRunId, raw);
    return {
      packageRunId,
      packageId,
      status: "running" as const,
      executorSceneId: loaded.manifest.executor.sceneId,
      executorVersionId: loaded.manifest.executor.versionId,
      nextAction: "poll_package_run" as const,
    };
  }

  /** 按包列出运行记录（新的在前）；cursor 为上一页最后一条的 id。 */
  async listRuns(packageId: string, query: { limit?: number; cursor?: string; status?: CodeScenePackageRun["status"] } = {}): Promise<{
    packageId: string;
    runs: Array<Omit<CodeScenePackageRun, "result">>;
    hasMore: boolean;
    nextCursor?: string;
  }> {
    if (!PACKAGE_ID_PATTERN.test(packageId)) throw new HttpError(400, "场景包ID无效", "INVALID_PACKAGE_ID", { packageId });
    const limit = query.limit === undefined ? 50 : query.limit;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw new HttpError(400, "分页条数需要是 1–200 的整数", "INVALID_RUN_LIMIT");
    const project = await this.projectDirectory();
    if (!project) throw new HttpError(409, "请先配置项目目录", "PROJECT_NOT_CONFIGURED");
    const all = this.deps.store.listDocuments<CodeScenePackageRun>(project, PACKAGE_RUNS_COLLECTION)
      .filter((run) => run.packageId === packageId)
      .filter((run) => !query.status || run.status === query.status)
      // listDocuments 已按 updated_at DESC 排；这里再按 createdAt 稳定一次，避免同毫秒写入的顺序抖动。
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id));
    const start = query.cursor ? all.findIndex((run) => run.id === query.cursor) + 1 : 0;
    if (query.cursor && start === 0) throw new HttpError(400, "运行记录分页游标无效", "INVALID_RUN_CURSOR", { packageRunId: query.cursor });
    const page = all.slice(start, start + limit);
    const hasMore = start + limit < all.length;
    return {
      packageId,
      // 列表不带 result：包的产出可能很大，详情接口才给。
      runs: page.map(({ result: _result, ...rest }) => rest),
      hasMore,
      ...(hasMore && page.length ? { nextCursor: page[page.length - 1]!.id } : {}),
    };
  }

  /** 单条包运行详情：带 result 与本次产出的子运行。 */
  async getRunDetail(packageId: string, packageRunId: string): Promise<CodeScenePackageRun & { runs: RunRecord[] }> {
    if (!PACKAGE_ID_PATTERN.test(packageId)) throw new HttpError(400, "场景包ID无效", "INVALID_PACKAGE_ID", { packageId });
    const project = await this.projectDirectory();
    if (!project) throw new HttpError(409, "请先配置项目目录", "PROJECT_NOT_CONFIGURED");
    const record = this.deps.store.getDocument<CodeScenePackageRun>(project, PACKAGE_RUNS_COLLECTION, packageRunId);
    // 归属校验：包详情只能看这个包自己的运行，不能拿别的包的 packageRunId 读别人记录。
    if (!record || record.packageId !== packageId) throw new HttpError(404, "没有找到这条场景包运行记录", "PACKAGE_RUN_NOT_FOUND", { packageId, packageRunId });
    const runs = record.runIds
      .map((runId) => this.deps.store.getRun(project, runId))
      .filter((run): run is RunRecord => Boolean(run));
    return { ...record, runs };
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
