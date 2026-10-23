import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { AsyncLocalStorage } from "node:async_hooks";

import { z } from "zod";

import type { JsonValue, RunInputField, RunRecord, RunSubmitter, SavedSettings } from "../domain/types.js";
import { asRecord, isMediaWorkflowType } from "../domain/workflowValues.js";
import { HttpError } from "../errors.js";
import { log as writeLog } from "../observability/logger.js";
import { redactErrorText } from "../security/errorHandler.js";
import type { AiSceneService } from "./aiSceneService.js";
import type { AccessService, Identity } from "./accessService.js";
import type { AssetService } from "./assetService.js";
import type { CreditService } from "./creditService.js";
import type { RunInputQuery } from "../ai/accessSchemas.js";
import { fromUnits, hasAtMostTwoDecimals, normalizePoints, toUnits } from "../domain/creditUnits.js";
import { workflowInputIssue } from "../domain/inputValidation.js";
import { packageRunInputs } from "./runDetailService.js";
import { validatePresentation, type PackagePresentation } from "../domain/packageContracts.js";
import type { RunCreditPlan } from "../domain/scenePricing.js";
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
/**
 * 多场景执行清单的一项：`key` 是包代码里用来选场景的名字，sceneId/versionId 是固定发布版。
 * 一个包可以声明多条（如短剧的「四视图 / 场景图 / 分镜 / 出片」），代码用 framework.scenes.run({ scene: key }) 选。
 */
const executorEntrySchema = z.object({
  key: z.string().min(1).max(64).regex(/^[A-Za-z0-9_.-]+$/, "场景键只允许字母、数字、下划线、点与短横线"),
  sceneId: z.string().min(1),
  versionId: z.string().min(1),
});
const executorsSchema = z.array(executorEntrySchema).max(32);

const configDocumentSchema = z.object({
  id: z.string().min(1),
  revision: z.int().min(0),
  enabled: z.boolean(),
  executor: executorSchema.nullable().optional(),
  /** 多场景清单：与 executor 并存，两者都声明时以清单为准（executor 视作清单第一项）。 */
  executors: executorsSchema.optional(),
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
    /** 多场景清单：短剧这类一条流水线要用多个场景的包，用清单声明，代码按 key 选。 */
    executors: executorsSchema.optional(),
    inputs: z.array(z.record(z.string(), z.unknown())).optional(),
    entry: z.string().min(1).optional(),
    // 服务页面与定价属于包自身：代码工程要能自描述「用户打开看到什么、跑一次多少钱」，
    // 否则每上一个包都要人工到管理端补配置。管理端配置仍可覆盖（见 decorateStatus）。
    summary: z.string().max(200).optional(),
    description: z.string().max(4000).optional(),
    presentation: z.record(z.string(), z.unknown()).optional(),
    pricing: z.record(z.string(), z.unknown()).optional(),
  }),
});

export interface CodeScenePackageExecutor {
  sceneId: string;
  versionId: string;
}

/** 多场景清单的一项：key 是包代码里的选择名，sceneId/versionId 固定发布版。 */
export interface CodeScenePackageExecutorEntry extends CodeScenePackageExecutor {
  key: string;
}

/**
 * 包自带的定价声明：与配置型包的 `packagePricing` 同构，单位是积分（最多两位小数）。
 * 代码包的调用次数由包代码决定，提交时无法预知，所以这里只声明「每个计价项一次多少钱」。
 */
const packagePricingSchema = z.object({
  version: z.literal(1),
  base: z.number().min(0).max(1_000_000).refine(hasAtMostTwoDecimals, "基础分最多两位小数").default(0),
  items: z.record(z.string(), z.object({
    unit: z.enum(["per_call", "per_item"]),
    credits: z.number().min(0).max(1_000_000).refine(hasAtMostTwoDecimals, "单价最多两位小数"),
  })).default({}),
}).strict();

/** package.json 里声明的元数据：executor 可省略（省略时取管理端配置）。 */
export interface DeclaredScenePackageManifest {
  title: string;
  version: string;
  executor?: CodeScenePackageExecutor;
  /** 多场景清单（可选）：一条流水线要用多个场景时声明，代码按 key 选。 */
  executors?: CodeScenePackageExecutorEntry[];
  inputs: Array<Record<string, unknown>>;
  entry: string;
  /** 一句话说明与详情，用户面目录/详情直接读包自己的声明。 */
  summary?: string;
  description?: string;
  /** 服务页面（PackagePresentation）与定价（PackagePricing），随包自描述。 */
  presentation?: Record<string, unknown>;
  pricing?: Record<string, unknown>;
}

/** 已解析的执行契约：单场景包一定有 executor；多场景包用 executors，此时 executor 可省略。 */
export interface CodeScenePackageManifest extends DeclaredScenePackageManifest {
  executor?: CodeScenePackageExecutor;
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
  status: "running" | "completed" | "failed" | "cancelled";
  createdAt: string;
  updatedAt: string;
  finishedAt?: string;
  runIds: string[];
  error?: string;
  errorCode?: string;
  result?: JsonValue;
  /** 提交时的输入快照：用户面「再做一次」与原始输入读取都以它为准，改版不影响历史。 */
  inputValues?: Record<string, JsonValue>;
  /** 该次运行固化的输入契约（字段来自提交时的包声明），历史读取不跟随磁盘改动。 */
  inputFields?: Array<Record<string, unknown>>;
  /** 本次运行的上限价与实际结算；未配置定价时不写。 */
  credit?: { total: number; settlement?: { settledAt: string; charged: number; refunded: number } };
  /** 用户取消的时间；有值时 status 一定是 cancelled。 */
  cancelledAt?: string;
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
    /** 本包声明过的场景清单：key 用于 run({ scene: key }) 选场景。 */
    list(): Array<{ key: string; sceneId: string; versionId: string }>;
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
  /** 积分账本：用户面路径的预扣/结算唯一入口；未接线时只按操作员身份跑、不计费。 */
  credits?: Pick<CreditService, "balance" | "reserve" | "release" | "settlePackage">;
  /** 包授权（packageIds）与身份刷新：用户面路径必须用它判定，管理员不受限。 */
  access?: Pick<AccessService, "authorizePackage" | "refresh">;
  loadSettings(): Promise<SavedSettings>;
  workbenchBaseUrl?(): string;
  packagesRoot?(projectDirectory: string): string;
  resolveOwner?(): { ownerUserId: string; submitter?: RunSubmitter } | undefined;
  importEntry?(url: string): Promise<unknown>;
  now?(): Date;
}

/** 一次运行的身份与计费上下文：用户面路径由路由传入，管理端路径回退操作员。 */
export interface CodeScenePackageInvocation {
  identity?: Identity;
  /** 用户面提交时的包运行ID（幂等键）：同ID重放返回同一条记录，不重复执行。 */
  packageRunId?: string;
  inputValues?: Record<string, JsonValue>;
  runTitle?: string;
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
  /** 生效的执行场景：管理端配置优先，package.json 只作默认值（规格 §2/§6）。多场景包可省略。 */
  executor?: CodeScenePackageExecutor;
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

  /**
   * 这个 packageId 是否由代码子工程提供（已加载成功、已启用）。
   * 用户面目录靠它裁决「同 ID 时谁上场」：代码包在就是代码包，配置型同 ID 包不再出现。
   */
  offers(packageId: string): boolean {
    const entry = this.statuses.get(packageId);
    return Boolean(entry && entry.status === "ok" && entry.enabled && entry.manifest);
  }

  /**
   * 这条运行是否属于代码包（按集合存在性判断，与调用者身份无关）。
   * 用户面的 `package-runs*` 用它分流：代码包记录在 codeScenePackageRuns，
   * 历史配置型记录在 packageRuns，两个集合的 ID 空间不重叠。
   */
  async ownsRun(packageRunId: string): Promise<boolean> {
    if (!packageRunId) return false;
    return Boolean(await this.getPackageRun(packageRunId));
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

  /**
   * 生效的场景清单：管理端配置优先，其次 package.json；两者都没写 executors 时，
   * 把旧的单 executor 包成一项（key = "default"），旧包因此不需要改一行代码。
   * 清单非空即视为「多场景包」，sceneRun 允许按 key 选；单场景包仍只认配置的那一个场景。
   */
  private effectiveExecutors(
    config: CodeScenePackageConfigDocument | undefined,
    manifest: DeclaredScenePackageManifest,
  ): CodeScenePackageExecutorEntry[] {
    const declared = config?.executors ?? manifest.executors;
    if (declared?.length) return declared;
    const single = this.effectiveExecutor(config, manifest);
    return single ? [{ key: "default", ...single }] : [];
  }

  /** 清单里按 key 找场景；key 省略时取第一项（单场景包等价于原来的唯一执行场景）。 */
  private pickExecutor(
    executors: CodeScenePackageExecutorEntry[],
    key: unknown,
  ): CodeScenePackageExecutorEntry | undefined {
    if (!executors.length) return undefined;
    if (key === undefined || key === null || key === "") return executors[0];
    if (typeof key !== "string") return undefined;
    return executors.find((entry) => entry.key === key);
  }

  /**
   * 运行记录/日志上的「执行场景」字段。多场景包没有唯一执行场景，
   * 用第一项占位（保持字段非空、可读），真实用哪个场景看该次子运行。
   */
  private primaryExecutor(manifest: CodeScenePackageManifest): CodeScenePackageExecutor {
    const declared = manifest.executors?.length ? manifest.executors : manifest.executor ? [{ key: "default", ...manifest.executor }] : [];
    return declared[0] ?? { sceneId: "", versionId: "" };
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
      executors: body.executors === undefined ? current?.executors : body.executors,
      inputs: Array.isArray(body.inputs) ? body.inputs : current?.inputs ?? [],
      ...(body.presentation !== undefined ? { presentation: body.presentation } : current?.presentation ? { presentation: current.presentation } : {}),
      ...(body.pricing !== undefined ? { pricing: body.pricing } : current?.pricing ? { pricing: current.pricing } : {}),
      updatedAt: this.now().toISOString(),
    };
    const parsed = configDocumentSchema.safeParse(next);
    if (!parsed.success) throw new HttpError(400, "场景包配置格式无效", "INVALID_CODE_PACKAGE_CONFIG", { issues: parsed.error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })) });
    const effective = parsed.data.executor ?? manifest?.executor;
    const effectiveList = this.effectiveExecutors(parsed.data, manifest ?? { title: "", version: "", inputs: [], entry: "" });
    if (parsed.data.enabled && !effectiveList.length && (!effective?.sceneId || !effective.versionId)) throw new HttpError(400, "必须选择执行场景和已发布版本", "CODE_PACKAGE_EXECUTOR_REQUIRED");
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
      // 多场景包没有单一 executor，但清单非空同样算「已配置执行场景」。
      const executors = this.effectiveExecutors(config, declared);
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
      if (!executor && !executors.length) {
        throw new HttpError(400, "未配置执行场景：请在此场景包的配置面板选择执行场景与已发布版本", "CODE_PACKAGE_EXECUTOR_REQUIRED", { packageId });
      }
      const resolved: CodeScenePackageManifest = { ...manifest, ...(executor ? { executor } : {}), ...(executors.length > 1 ? { executors } : {}) };
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
      ...(meta.executors?.length ? { executors: meta.executors } : {}),
      inputs: meta.inputs ?? [],
      entry: meta.entry ?? DEFAULT_ENTRY,
      ...(meta.summary ? { summary: meta.summary } : {}),
      ...(meta.description ? { description: meta.description } : {}),
      ...(meta.presentation ? { presentation: meta.presentation } : {}),
      ...(meta.pricing ? { pricing: meta.pricing } : {}),
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
        list: () => {
          const config = service.configFor(service.active.getStore()?.projectDirectory ?? "", packageId);
          return service.effectiveExecutors(config, manifest).map((entry) => ({ key: entry.key, sceneId: entry.sceneId, versionId: entry.versionId }));
        },
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

    // 选场景：清单里按 key 选（多场景包），或用旧的单 executor（单场景包）。
    // 两种形态都必须落在包声明过的场景上——执行归属仍归父工程，不能临时指定任意场景。
    const executors = this.effectiveExecutors(this.configFor(context.projectDirectory, packageId), manifest);
    const requestedKey = body.scene ?? body.sceneKey;
    const chosen = this.pickExecutor(executors, requestedKey);
    if (!chosen) {
      throw new HttpError(400, requestedKey === undefined || requestedKey === null || requestedKey === ""
        ? "场景包未配置执行场景"
        : "场景包没有声明这个场景键：" + String(requestedKey) + "；可用：" + executors.map((entry) => entry.key).join("、"),
      "PACKAGE_SCENE_NOT_DECLARED", { packageId, requested: String(requestedKey ?? ""), declared: executors.map((entry) => entry.key) });
    }
    // Only the executor fields at the call's top level can change attribution. A scene may
    // legitimately declare an input literally named "sceneId"; that is payload, not executor.
    if (suppliedSceneId !== undefined && suppliedSceneId !== chosen.sceneId) throw executorMismatch(packageId, "sceneId", suppliedSceneId, chosen.sceneId);
    if (suppliedVersionId !== undefined && suppliedVersionId !== chosen.versionId) throw executorMismatch(packageId, "versionId", suppliedVersionId, chosen.versionId);

    const reserved = new Set(["sceneId", "versionId", "scene", "sceneKey", "title", "runTitle", "inputs", "inputValues"]);
    const flatInputs = Object.fromEntries(Object.entries(body).filter(([key]) => !reserved.has(key)));
    const inputValues = asRecord(body.inputValues) ?? inputsBody ?? (Object.keys(flatInputs).length ? flatInputs : {});

    const titleSource = body.title ?? body.runTitle;
    const title = typeof titleSource === "string" && titleSource.trim() ? titleSource.trim().slice(0, 80) : manifest.title;
    const runTitle = `${manifest.title} · ${title}`.slice(0, 120);

    const prepared = await this.deps.scenes.prepare(chosen.sceneId, chosen.versionId, inputValues as Record<string, JsonValue>);
    const runId = randomUUID();
    const run = await this.deps.runs.submit(
      { runId, runTitle, workflow: prepared.workflow, inputValues: prepared.inputValues, packageRunId: context.packageRunId },
      { ownerUserId: context.ownerUserId, ...(context.submitter ? { submitter: context.submitter } : {}), authorize: () => undefined },
    );
    context.runIds.push(run.runId);
    return {
      runId: run.runId,
      status: run.status,
      sceneId: chosen.sceneId,
      versionId: chosen.versionId,
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
      executorSceneId: this.primaryExecutor(manifest).sceneId,
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
    const reserved = await this.reserveRun(packageId, loaded, {});
    const outcome = await this.executeRun(packageId, loaded, reserved.packageRunId, raw);
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

  /** 生效定价：管理端配置覆盖优先，否则取 package.json 的 pricing。 */
  private effectivePricing(project: string, packageId: string, manifest: DeclaredScenePackageManifest): Record<string, unknown> | undefined {
    const config = this.configFor(project, packageId);
    return config?.pricing ?? manifest.pricing;
  }

  /** 生效输入契约：package.json 声明 + 管理端逐字段覆盖（键不可改，代码按 key 读）。 */
  private effectiveInputs(project: string, packageId: string, manifest: DeclaredScenePackageManifest): Array<Record<string, unknown>> {
    const overrides = this.configFor(project, packageId)?.inputs ?? [];
    const byKey = new Map(overrides.map((item) => [item.key, item]));
    return manifest.inputs.map((field) => {
      const key = String(field.key ?? "");
      const override = byKey.get(key);
      if (!override) return field;
      return {
        ...field,
        ...(override.label !== undefined ? { label: override.label } : {}),
        ...(override.required !== undefined ? { required: override.required } : {}),
        ...(override.defaultValue !== undefined ? { defaultValue: override.defaultValue } : {}),
      };
    });
  }

  /** 生效服务页面：管理端配置覆盖优先，否则取 package.json 的 presentation。 */
  private effectivePresentation(project: string, packageId: string, manifest: DeclaredScenePackageManifest): PackagePresentation | undefined {
    const raw = this.configFor(project, packageId)?.presentation ?? manifest.presentation;
    if (!raw) return undefined;
    // 磁盘上的页面配置同样要过发布期校验：坏配置不能让用户页崩掉，也不能静默少一块。
    return validatePresentation(raw);
  }

  /**
   * 上限价：代码包的调用次数由包代码决定，提交时无法预知，因此每个声明的计价项按 1 次计。
   * 这是**上限**——结算只退不补扣，多跑的不会额外收费，少跑的按实际退还。
   */
  private planCost(pricing: Record<string, unknown> | undefined): RunCreditPlan | undefined {
    if (!pricing) return undefined;
    const parsed = packagePricingSchema.safeParse(pricing);
    if (!parsed.success) {
      throw new HttpError(400, "场景包定价格式无效：" + parsed.error.issues.map((issue) => issue.path.join(".") + ": " + issue.message).join("; "), "INVALID_CODE_PACKAGE_PRICING");
    }
    const baseUnits = toUnits(parsed.data.base);
    const plan: RunCreditPlan = { pricingVersion: 1, base: fromUnits(baseUnits), total: fromUnits(baseUnits), steps: {} };
    let totalUnits = baseUnits;
    for (const [itemId, entry] of Object.entries(parsed.data.items)) {
      const units = 1;
      plan.steps[itemId] = { unit: entry.unit, credits: fromUnits(toUnits(entry.credits)), units };
      totalUnits += units * toUnits(entry.credits);
    }
    plan.total = fromUnits(totalUnits);
    return plan.total > 0 ? plan : undefined;
  }

  /** 建一条 running 记录并占住该包；返回 packageRunId 与是否新建。 */
  private async reserveRun(packageId: string, loaded: LoadedPackage, invocation: CodeScenePackageInvocation): Promise<{ packageRunId: string; created: boolean }> {
    // 占位必须同步完成：中间有 await，两个并发请求都能通过检查，包就会被同时跑两次。
    if (this.busy.has(packageId)) throw new HttpError(409, "场景包正在运行", "PACKAGE_BUSY", { packageId });
    this.busy.add(packageId);
    let handedOff = false;
    let reserved = false;
    let reservedUserId = "";
    let packageRunId = "";
    try {
      const project = await this.projectDirectory();
      if (!project) throw new HttpError(409, "请先配置项目目录", "PROJECT_NOT_CONFIGURED");

      const owner = this.ownerOf(invocation);
      const createdAt = this.now().toISOString();
      packageRunId = invocation.packageRunId ?? randomUUID();
      // 同 ID 重放：响应丢失后客户端只查这个 ID，不换 ID 重提；不重复执行、不重复扣费。
      const existing = this.deps.store.getDocument<CodeScenePackageRun>(project, PACKAGE_RUNS_COLLECTION, packageRunId);
      if (existing) {
        if (existing.ownerUserId !== owner.ownerUserId && invocation.identity?.role !== "admin") {
          throw new HttpError(404, "没有找到这条场景包运行记录", "PACKAGE_RUN_NOT_FOUND", { packageRunId });
        }
        return { packageRunId, created: false };
      }

      const plan = this.planCost(this.effectivePricing(project, packageId, loaded.manifest));
      // 计费只发生在用户自助路径：管理员入口没有积分账户，不该被扣费。
      const billable = Boolean(invocation.identity && invocation.identity.role !== "admin" && plan && this.deps.credits);
      const inputValues = (invocation.inputValues ?? {}) as Record<string, JsonValue>;
      const record: CodeScenePackageRun = {
        id: packageRunId,
        revision: 0,
        kind: "code-scene-package",
        packageId,
        packageTitle: loaded.manifest.title,
        executorSceneId: this.primaryExecutor(loaded.manifest).sceneId,
        executorVersionId: this.primaryExecutor(loaded.manifest).versionId,
        packageRunId,
        ownerUserId: owner.ownerUserId,
        ...(owner.submitter ? { submitter: owner.submitter } : {}),
        status: "running",
        createdAt,
        updatedAt: createdAt,
        runIds: [],
        ...(Object.keys(inputValues).length ? { inputValues } : {}),
        ...(invocation.inputValues !== undefined ? { inputFields: this.effectiveInputs(project, packageId, loaded.manifest) } : {}),
        ...(billable && plan ? { credit: { total: plan.total } } : {}),
      };
      if (billable && plan && this.deps.credits) {
        // 预扣上限价：与配置型包同一本账、同一幂等键（包运行ID作为 ref）。
        this.deps.credits.reserve(owner.ownerUserId, packageRunId, plan);
        reserved = true;
        reservedUserId = owner.ownerUserId;
      }
      try {
        this.putRun(project, record, 0);
      } catch (error) {
        if (reserved && this.deps.credits) this.deps.credits.release(reservedUserId, packageRunId, "包运行写入失败");
        reserved = false;
        throw error;
      }
      handedOff = true;
      return { packageRunId, created: true };
    } catch (error) {
      // 预扣成功但后续抛错同样要退回，不留悬空预扣。
      if (reserved && this.deps.credits) this.deps.credits.release(reservedUserId, packageRunId, error instanceof Error ? error.message : String(error));
      throw error;
    } finally {
      // 只有真正把包交给 executeRun 时才继续占位；重放与异常路径必须立刻释放，
      // 否则一次失败的提交会让这个包永久 409。
      if (!handedOff) this.busy.delete(packageId);
    }
  }

  /** 运行归属：用户面取登录身份，管理端回退操作员；不接受客户端传入的 owner。 */
  private ownerOf(invocation: CodeScenePackageInvocation): { ownerUserId: string; submitter?: RunSubmitter } {
    if (invocation.identity) {
      return { ownerUserId: invocation.identity.id, submitter: { userId: invocation.identity.id, username: invocation.identity.username, displayName: invocation.identity.displayName } };
    }
    return this.deps.resolveOwner?.() ?? OPERATOR_IDENTITY;
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
      // 成功即结算：只退不补扣，上限就是预扣价。
      this.settle(project, packageRunId);
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
      // 失败全额退还预扣：不依赖包作者写对，宿主负责。
      this.settle(project, packageRunId, 0);
      const currentStatus = this.statuses.get(packageId);
      if (currentStatus) {
        this.statuses.set(packageId, { ...currentStatus, status: "error", error: message, loadedAt: currentStatus.loadedAt });
      }
      writeLog("error", "scene_package.run_failed", {
        packageId,
        packageRunId,
        executorSceneId: this.primaryExecutor(loaded.manifest).sceneId,
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
   * 包级结算：charged 省略表示「按预扣上限全额收取」（成功路径），传 0 表示全额退还（失败/取消）。
   * 走 CreditService.settlePackage，与配置型包同一本账、同一幂等键；重复调用只结一次。
   */
  private settle(project: string, packageRunId: string, charged?: number) {
    if (!this.deps.credits) return;
    const record = this.deps.store.getDocument<CodeScenePackageRun>(project, PACKAGE_RUNS_COLLECTION, packageRunId);
    if (!record?.credit || record.credit.settlement) return;
    const total = record.credit.total;
    if (!(total > 0)) return;
    const amount = charged === undefined ? total : Math.max(0, normalizePoints(charged));
    try {
      const result = this.deps.credits.settlePackage(record.ownerUserId, packageRunId, amount, total);
      this.updateRun(project, packageRunId, (current) => ({
        ...current,
        credit: { total, settlement: { settledAt: this.now().toISOString(), charged: result.charged, refunded: result.refunded } },
      }));
    } catch (error) {
      writeLog("error", "scene_package.settle_failed", { packageRunId, error: String(error) });
    }
  }

  /**
   * 用户面提交：授权、计费、归属全部在这一条路径上收口。
   * 与配置型包同一套语义——`packageIds` 是唯一授权单元，执行用包配置的场景，
   * 运行记录复用 RunService 队列与 codeScenePackageRuns 集合，不自建状态机。
   */
  async startForUser(identity: Identity, packageId: string, raw: unknown): Promise<{
    packageRun: ReturnType<CodeScenePackageService["viewUserRun"]>;
    created: boolean;
    nextAction: "poll_own_package_run";
  }> {
    if (!this.deps.access) throw new HttpError(503, "场景包授权服务未启用", "PACKAGES_DISABLED");
    const current = this.deps.access.authorizePackage(identity, packageId);
    const loaded = this.requireRunnable(packageId);
    const body = asRecord(raw) ?? {};
    const project = await this.projectDirectory();
    if (!project) throw new HttpError(409, "请先配置项目目录", "PROJECT_NOT_CONFIGURED");
    const inputs = this.resolveUserInputs(project, packageId, loaded.manifest, asRecord(body.inputValues) ?? {});
    const requestedId = typeof body.packageRunId === "string" && body.packageRunId ? body.packageRunId : undefined;
    if (requestedId && !/^[a-f0-9-]{36}$/i.test(requestedId)) throw new HttpError(400, "包运行ID无效", "INVALID_PACKAGE_RUN_ID");

    const reserved = await this.reserveRun(packageId, loaded, { identity: current, inputValues: inputs, ...(requestedId ? { packageRunId: requestedId } : {}) });
    const saved = this.deps.store.getDocument<CodeScenePackageRun>(project, PACKAGE_RUNS_COLLECTION, reserved.packageRunId)!;
    if (reserved.created) {
      // 已受理即返回；执行在后台推进，HTTP 请求不等分钟级子运行。
      void this.executeRun(packageId, loaded, reserved.packageRunId, {
        inputs,
        ...(typeof body.runTitle === "string" && body.runTitle.trim() ? { title: body.runTitle.trim().slice(0, 120) } : {}),
      });
    }
    return { packageRun: this.viewUserRun(saved), created: reserved.created, nextAction: "poll_own_package_run" };
  }

  /**
   * 用户输入：以包声明为准（含管理端覆盖），媒体保持素材引用原样（归属由素材解析校验）。
   * 未声明的键一律丢弃——代码只按声明的 key 读，多传的字段会让包作者以为有值。
   */
  private resolveUserInputs(project: string, packageId: string, manifest: DeclaredScenePackageManifest, supplied: Record<string, unknown>): Record<string, JsonValue> {
    const declared = this.effectiveInputs(project, packageId, manifest);
    const fields = declared.map((field) => normalizeInputField(field)).filter((field): field is NonNullable<typeof field> => Boolean(field));
    const values: Record<string, JsonValue> = {};
    for (const field of fields) {
      const value = supplied[field.key];
      if (value !== undefined && value !== null && value !== "") values[field.key] = value as JsonValue;
      else if (field.defaultValue !== undefined) values[field.key] = field.defaultValue;
    }
    for (const field of fields) {
      const issue = workflowInputIssue(field, values[field.key]);
      if (issue) throw new HttpError(400, issue.message, issue.code, { inputKey: field.key, expectedType: field.type, nextAction: "correct_input_values" });
    }
    return values;
  }

  /** 用户面预检：只算上限价与余额，不创建运行、不扣费。 */
  async prepareForUser(identity: Identity, packageId: string, raw: unknown) {
    if (!this.deps.access) throw new HttpError(503, "场景包授权服务未启用", "PACKAGES_DISABLED");
    const current = this.deps.access.authorizePackage(identity, packageId);
    const loaded = this.requireRunnable(packageId);
    const project = await this.projectDirectory();
    if (!project) throw new HttpError(409, "请先配置项目目录", "PROJECT_NOT_CONFIGURED");
    const body = asRecord(raw) ?? {};
    const inputs = this.resolveUserInputs(project, packageId, loaded.manifest, asRecord(body.inputValues) ?? {});
    const plan = this.planCost(this.effectivePricing(project, packageId, loaded.manifest));
    return {
      valid: true as const,
      packageId,
      version: loaded.manifest.version,
      costPlan: plan ?? { pricingVersion: 1, base: 0, total: 0, steps: {} },
      credits: this.deps.credits?.balance(current.id) ?? null,
      externalServicesChecked: false as const,
      nextAction: "submit_own_package" as const,
      ...(Object.keys(inputs).length ? { inputValues: inputs } : {}),
    };
  }

  /**
   * 受理一次包运行并立即返回 packageRunId：包内通常会 `scenes.wait` 到子运行终态（分钟级），
   * 挂在 HTTP 请求上等它结束会撑爆请求超时，也会让「已受理」与「已跑完」两件事混在一个响应里。
   * 执行语义与 `invoke` 完全一致（同一条 `invoke` 代码路径），只是不 await。
   */
  async start(packageId: string, raw?: unknown): Promise<{ packageRunId: string; packageId: string; status: "running"; executorSceneId: string; executorVersionId: string; nextAction: "poll_package_run" }> {
    const loaded = this.requireRunnable(packageId);
    // 先同步占位再返回：调用方拿到 packageRunId 后立刻查详情时必须能查到，不能出现「已返回但记录还没有」的窗口。
    const reserved = await this.reserveRun(packageId, loaded, {});
    void this.executeRun(packageId, loaded, reserved.packageRunId, raw);
    return {
      packageRunId: reserved.packageRunId,
      packageId,
      status: "running" as const,
      executorSceneId: this.primaryExecutor(loaded.manifest).sceneId,
      executorVersionId: this.primaryExecutor(loaded.manifest).versionId,
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

  // ---------------------------------------------------------------------------
  // 用户面（self/*）：授权单元是 packageIds，视图只给「服务」不该看到实现细节。
  // 这一组方法是 `/api/v1/self/packages*` 的唯一数据源，路由不再自己拼投影。
  // ---------------------------------------------------------------------------

  /** 用户可见的包目录：只列已加载成功、已启用且已授权的包。 */
  async listAvailable(identity: Identity, query: { limit?: number; cursor?: string }) {
    if (!this.deps.access) throw new HttpError(503, "场景包授权服务未启用", "PACKAGES_DISABLED");
    const current = this.deps.access.refresh(identity);
    const project = await this.projectDirectory();
    if (!project) throw new HttpError(409, "请先配置项目目录", "PROJECT_NOT_CONFIGURED");
    const visible = [...this.statuses.values()]
      .filter((entry) => entry.status === "ok" && entry.enabled && entry.manifest)
      .filter((entry) => current.role === "admin" || (current.packageIds ?? []).includes(entry.packageId))
      .sort((left, right) => (left.manifest!.title).localeCompare(right.manifest!.title) || left.packageId.localeCompare(right.packageId));
    const limit = Math.min(200, Math.max(1, query.limit ?? 50));
    const offset = query.cursor ? Number(Buffer.from(query.cursor, "base64url").toString("utf8")) : 0;
    if (!Number.isSafeInteger(offset) || offset < 0) throw new HttpError(400, "分页游标无效", "INVALID_PACKAGE_CURSOR");
    const page = visible.slice(offset, offset + limit);
    return {
      packages: page.map((entry) => {
        const presentation = this.safePresentation(project, entry.packageId, entry.manifest!);
        return {
          packageId: entry.packageId,
          source: "code" as const,
          version: entry.manifest!.version,
          title: entry.manifest!.title,
          ...(entry.manifest!.summary ? { summary: entry.manifest!.summary } : {}),
          itemCount: 1,
          ...(presentation?.hero?.headline ? { headline: presentation.hero.headline } : {}),
          ...(presentation?.hero?.showcase?.length ? { showcase: presentation.hero.showcase.slice(0, 1) } : {}),
          ...(presentation?.theme?.accent ? { accent: presentation.theme.accent } : {}),
        };
      }),
      total: visible.length,
      hasMore: offset + page.length < visible.length,
      ...(offset + page.length < visible.length ? { nextCursor: Buffer.from(String(offset + page.length)).toString("base64url") } : {}),
      nextAction: "get_available_package" as const,
    };
  }

  /**
   * 用户可见的包详情：输入契约 + 服务页面 + 预计消耗。
   * 不返回磁盘路径、入口文件、执行场景 ID——那些是实现细节，用户不需要也不能据此绕过。
   */
  async getAvailable(identity: Identity, packageId: string, _versionId?: string) {
    if (!this.deps.access) throw new HttpError(503, "场景包授权服务未启用", "PACKAGES_DISABLED");
    const current = this.deps.access.authorizePackage(identity, packageId);
    const loaded = this.requireRunnable(packageId);
    const project = await this.projectDirectory();
    if (!project) throw new HttpError(409, "请先配置项目目录", "PROJECT_NOT_CONFIGURED");
    const fields = this.effectiveInputs(project, packageId, loaded.manifest)
      .map((field) => normalizeInputField(field))
      .filter((field): field is NonNullable<typeof field> => Boolean(field))
      .map((field) => ({
        key: field.key,
        label: String(asRecord(field)?.label ?? field.key),
        type: field.type,
        required: Boolean(field.required),
        hidden: Boolean(field.hidden),
        ...(field.type === "number" && field.minimum !== undefined ? { minimum: field.minimum } : {}),
        ...(field.maximum !== undefined && (field.type === "number" || isMediaWorkflowType(field.type)) ? { maximum: field.maximum } : {}),
        ...(field.options ? { options: field.options } : {}),
        ...(field.defaultValue !== undefined ? { defaultValue: field.defaultValue } : {}),
      }));
    const defaults = Object.fromEntries(fields.filter((field) => field.defaultValue !== undefined).map((field) => [field.key, field.defaultValue]));
    const presentation = this.safePresentation(project, packageId, loaded.manifest);
    const plan = this.planCost(this.effectivePricing(project, packageId, loaded.manifest));
    return {
      packageId,
      source: "code" as const,
      version: loaded.manifest.version,
      title: loaded.manifest.title,
      ...(loaded.manifest.summary ? { summary: loaded.manifest.summary } : {}),
      ...(loaded.manifest.description ? { description: loaded.manifest.description } : {}),
      fields,
      inputDefaults: defaults,
      steps: [{ itemId: "run", name: loaded.manifest.title }],
      ...(presentation ? { presentation } : {}),
      costPlan: plan ?? { pricingVersion: 1, base: 0, total: 0, steps: {} },
      credits: this.deps.credits?.balance(current.id) ?? null,
      nextAction: "prepare_own_package" as const,
    };
  }

  /** 服务页面读不到或校验不过时降级为「无页面」，让用户面按默认页渲染，而不是整个服务打不开。 */
  private safePresentation(project: string, packageId: string, manifest: DeclaredScenePackageManifest): PackagePresentation | undefined {
    try {
      return this.effectivePresentation(project, packageId, manifest);
    } catch (error) {
      writeLog("warn", "scene_package.presentation_invalid", { packageId, error: this.safeError(error) });
      return undefined;
    }
  }

  /** 本人的服务运行列表（新的在前）。 */
  async listOwnRuns(identity: Identity, query: { limit?: number; cursor?: string }) {
    const project = await this.projectDirectory();
    if (!project) throw new HttpError(409, "请先配置项目目录", "PROJECT_NOT_CONFIGURED");
    const all = this.deps.store.listDocuments<CodeScenePackageRun>(project, PACKAGE_RUNS_COLLECTION)
      .filter((run) => run.ownerUserId === identity.id || identity.role === "admin")
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id));
    const limit = Math.min(200, Math.max(1, query.limit ?? 50));
    const offset = query.cursor ? Number(Buffer.from(query.cursor, "base64url").toString("utf8")) : 0;
    if (!Number.isSafeInteger(offset) || offset < 0) throw new HttpError(400, "分页游标无效", "INVALID_PACKAGE_CURSOR");
    const page = all.slice(offset, offset + limit);
    return {
      items: page.map((run) => this.viewUserRun(run)),
      total: all.length,
      hasMore: offset + page.length < all.length,
      ...(offset + page.length < all.length ? { nextCursor: Buffer.from(String(offset + page.length)).toString("base64url") } : {}),
      nextAction: "get_own_package_run" as const,
    };
  }

  /** 本人的单条服务运行；他人一律 404（不区分「不存在」与「不是你的」）。 */
  async getOwnRun(identity: Identity, packageRunId: string) {
    const record = await this.requireOwnRun(identity, packageRunId);
    return this.viewUserRun(record);
  }

  /** 服务级产出：按子运行聚合媒体，用户不需要知道来自哪次子运行。 */
  async ownOutputs(identity: Identity, packageRunId: string) {
    const record = await this.requireOwnRun(identity, packageRunId);
    const project = await this.projectDirectory();
    if (!project) throw new HttpError(409, "请先配置项目目录", "PROJECT_NOT_CONFIGURED");
    const items: Array<{ index: number; name: string; media: Array<{ url: string; kind: "image" | "video" | "audio" }> }> = [];
    record.runIds.forEach((runId, index) => {
      const run = this.deps.store.getRun(project, runId);
      if (!run) return;
      const seen = new Set<string>();
      const media = run.outputs.flatMap((output) => {
        if (!/^(image|video|audio)(_list)?$/.test(output.type)) return [];
        const values = Array.isArray(output.value) ? output.value : [output.value];
        return values.flatMap((value, mediaIndex) => {
          const identityKey = typeof value === "string" ? value : JSON.stringify(value ?? null);
          if (seen.has(identityKey)) return [];
          seen.add(identityKey);
          const parameters = new URLSearchParams({ outputKey: output.key, mediaIndex: String(mediaIndex) });
          return [{ url: "/api/v1/runs/" + run.runId + "/output-media?" + parameters, kind: (output.type.startsWith("video") ? "video" : output.type.startsWith("audio") ? "audio" : "image") as "image" | "video" | "audio" }];
        });
      });
      if (media.length) items.push({ index: index + 1, name: record.packageTitle, media });
    });
    return { packageRunId, items, total: items.reduce((sum, item) => sum + item.media.length, 0), nextAction: "get_own_package_run" as const };
  }

  /** 本次运行的原始输入：字段取提交时固化的契约，值取提交快照，之后改包不影响。 */
  async ownInputs(identity: Identity, packageRunId: string, query: RunInputQuery) {
    const record = await this.requireOwnRun(identity, packageRunId);
    const fields = (record.inputFields ?? []).map((field) => normalizeInputField(field)).filter((field): field is NonNullable<typeof field> => Boolean(field));
    const fallback = fields.length ? fields : Object.keys(record.inputValues ?? {}).map((key) => ({ key, type: "text" }));
    return {
      ...packageRunInputs({ id: record.id, versionId: record.packageId, inputValues: (record.inputValues ?? {}) as Record<string, JsonValue>, fields: fallback }, query),
      packageRunId: record.id,
      packageId: record.packageId,
      versionId: record.packageId,
      nextAction: "prepare_own_package" as const,
    };
  }

  /** 取消：标记终态、尽力取消在途子运行、按未完成全额退还预扣。 */
  async cancelOwnRun(identity: Identity, packageRunId: string) {
    const record = await this.requireOwnRun(identity, packageRunId);
    const project = await this.projectDirectory();
    if (!project) throw new HttpError(409, "请先配置项目目录", "PROJECT_NOT_CONFIGURED");
    if (record.cancelledAt || record.status === "cancelled") return this.viewUserRun(record);
    if (record.status !== "running") throw new HttpError(409, "这条服务运行已经结束，不能取消", "PACKAGE_RUN_NOT_CANCELLABLE", { status: record.status });
    const cancelledAt = this.now().toISOString();
    this.updateRun(project, packageRunId, (current) => ({ ...current, status: "cancelled", cancelledAt, finishedAt: cancelledAt }));
    for (const runId of record.runIds) {
      try { await this.deps.runs.cancel(project, runId); } catch { /* 子运行取消失败由它自己的真实状态反映 */ }
    }
    this.settle(project, packageRunId, 0);
    const latest = this.deps.store.getDocument<CodeScenePackageRun>(project, PACKAGE_RUNS_COLLECTION, packageRunId)!;
    return this.viewUserRun(latest);
  }

  private async requireOwnRun(identity: Identity, packageRunId: string): Promise<CodeScenePackageRun> {
    const project = await this.projectDirectory();
    if (!project) throw new HttpError(409, "请先配置项目目录", "PROJECT_NOT_CONFIGURED");
    const record = this.deps.store.getDocument<CodeScenePackageRun>(project, PACKAGE_RUNS_COLLECTION, packageRunId);
    if (!record || (record.ownerUserId !== identity.id && identity.role !== "admin")) {
      throw new HttpError(404, "没有找到这条服务运行", "PACKAGE_RUN_NOT_FOUND", { packageRunId });
    }
    return record;
  }

  /**
   * 用户面运行视图：只说「做到哪一步、出没出结果、扣了多少」。
   * 执行场景 ID、子运行 ID、磁盘路径与内部错误原文都是实现细节，一律不下发。
   */
  viewUserRun(record: CodeScenePackageRun) {
    const stage = record.cancelledAt ? "cancelled" : record.status === "completed" ? "completed" : record.status === "failed" ? "failed" : "running";
    // 代码包对用户是「一个服务、一步完成」：进度按单步投影，与配置型包的 progress 形状对齐，
    // 用户页才能用同一套渲染（结果画廊按 completed>0 判断是否出图）。
    const total = 1;
    const completed = record.status === "completed" ? 1 : 0;
    return {
      packageRunId: record.packageRunId,
      packageId: record.packageId,
      title: record.packageTitle,
      status: record.status,
      stage,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      ...(record.finishedAt ? { finishedAt: record.finishedAt } : {}),
      progress: { total, completed, current: Math.min(total, completed + 1) },
      inputCount: Object.keys(record.inputValues ?? {}).length,
      ...(record.credit ? { credit: { total: record.credit.total, ...(record.credit.settlement ? { settlement: record.credit.settlement } : {}) } } : {}),
      nextAction: stage === "running" ? "wait" : "get_own_package_run",
    };
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

function storeDocumentId(packageId: string, key: string) {
  return packageId + "/" + key;
}

/**
 * 包声明的输入字段（package.json 里是自由形状的 record）收敛成运行期契约。
 * 代码只按 key 读，所以 type 缺省按 text 处理、label 缺省取 key，其余非法值直接丢弃。
 */
function normalizeInputField(raw: unknown): RunInputField | undefined {
  const record = asRecord(raw);
  if (!record || typeof record.key !== "string" || !record.key) return undefined;
  const type = typeof record.type === "string" && record.type ? record.type : "text";
  return {
    key: record.key,
    type,
    ...(typeof record.label === "string" ? { label: record.label } : {}),
    ...(typeof record.required === "boolean" ? { required: record.required } : {}),
    ...(typeof record.hidden === "boolean" ? { hidden: record.hidden } : {}),
    ...(typeof record.minimum === "number" ? { minimum: record.minimum } : {}),
    ...(typeof record.maximum === "number" ? { maximum: record.maximum } : {}),
    ...(Array.isArray(record.options) && record.options.every((option) => typeof option === "string") ? { options: record.options as string[] } : {}),
    ...(record.defaultValue !== undefined ? { defaultValue: record.defaultValue as JsonValue } : {}),
    ...(record.inputMode === "object_array" ? { inputMode: "object_array" as const } : {}),
    ...(Array.isArray(record.itemFields) ? { itemFields: record.itemFields as RunInputField["itemFields"] } : {}),
  };
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
