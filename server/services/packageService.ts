import { randomUUID } from "node:crypto";
import type { JsonValue, RunInputField, RunRecord, RunSubmitter, RunWorkflowDefinition } from "../domain/types.js";
import { asRecord, isMediaWorkflowType, normalizeRunWorkflow, splitWorkflowReference } from "../domain/workflowValues.js";
import {
  packageDraftDocument, selectPackageValue, validatePackageDraft, validatePresentation,
  type PackageDraft, type PackageVersion, type PackageVersionItem,
} from "../domain/packageContracts.js";
import { fromUnits, planSceneCost, toUnits, type RunCreditPlan, type ScenePricing } from "../domain/scenePricing.js";
import { validateWorkflowInputs, workflowInputDefaults } from "../domain/inputValidation.js";
import { contentRevision } from "../domain/sceneContent.js";
import { HttpError } from "../errors.js";
import { log } from "../observability/logger.js";
import { packageRunInputs } from "./runDetailService.js";
import type { RunInputQuery } from "../ai/accessSchemas.js";
import type { AiSceneService } from "./aiSceneService.js";
import type { CreditService } from "./creditService.js";
import type { RunService } from "./runService.js";
import type { SqliteStore } from "../storage/sqliteStore.js";
import type { AccessService, Identity } from "./accessService.js";

const DRAFTS = "packages";
const VERSIONS = "packageVersions";
const RUNS = "packageRuns";
const MAX_ITEMS = 50;

/** 包运行：父协调器 + N 个普通子运行。状态由子运行投影，不新建第二套状态机。 */
export type PackageRunStatus = "queued" | "running" | "waiting_confirm" | "completed" | "completed_with_errors" | "failed" | "cancelled";
export interface PackageRunItem {
  itemId: string;
  name: string;
  runId?: string;
  status: "pending" | "running" | "waiting_confirm" | "completed" | "completed_with_errors" | "failed" | "skipped";
  confirmAfter?: boolean;
  confirmed?: boolean;
  error?: string;
  /** 本项产出（供后续项取值）；媒体保持为素材引用，不落本机路径。 */
  outputs?: Record<string, JsonValue>;
}
export interface PackageRun {
  id: string;
  revision: number;
  packageId: string;
  versionId: string;
  title: string;
  ownerUserId: string;
  submitter?: RunSubmitter;
  status: PackageRunStatus;
  createdAt: string;
  updatedAt: string;
  inputValues: Record<string, JsonValue>;
  items: PackageRunItem[];
  /** 包级资金：一次预扣，子运行不再各自扣费。 */
  credit?: { plan: RunCreditPlan; settlement?: { settledAt: string; charged: number; refunded: number } };
  cancelledAt?: string;
  error?: string;
}

/**
 * 场景包：用户面的产品单元。包=一条流水线（组件按顺序执行，可声明「第 2 项用第 1 项的产出」，
 * 需要审美的环节可停下等人工确认）。包发布时把组件发布版**内嵌**成自包含快照，
 * 因此组件场景后续改版或删除都不会让已发布的包悬空。
 */
export class PackageService {
  private readonly busy = new Set<string>();
  constructor(
    private readonly store: SqliteStore,
    private readonly scenes: AiSceneService,
    private readonly runs: RunService,
    private readonly access: AccessService,
    private readonly credits?: CreditService,
  ) {}

  private async project() { return (await this.scenes.loadSettings()).projectDirectory; }
  private requireProject(project: string) { if (!project) throw new HttpError(409, "请先配置项目目录", "PROJECT_NOT_CONFIGURED"); return project; }
  private async locked<T>(key: string, operation: () => Promise<T>): Promise<T> {
    if (this.busy.has(key)) throw new HttpError(409, "正在处理此场景包，请稍后重试", "PACKAGE_BUSY");
    this.busy.add(key);
    try { return await operation(); } finally { this.busy.delete(key); }
  }
  private putDraft(project: string, draft: PackageDraft & { revision: number }, expectedRevision: number) {
    try { return this.store.putDocumentChecked(project, DRAFTS, draft, expectedRevision); }
    catch (error) {
      if ((error as Error).message === "DOCUMENT_CONFLICT") throw new HttpError(409, "场景包已变化，请重新读取", "PACKAGE_REVISION_CONFLICT");
      throw error;
    }
  }

  // ── 草稿与发布 ──────────────────────────────────────────────────────────

  /** 组件快照：只接受已发布的场景版本，且必须是当前发布版。 */
  private async component(sceneId: string, versionId: string) {
    const scene = await this.scenes.get(sceneId, versionId);
    return {
      scene: scene.scene as Record<string, unknown>,
      workflow: scene.workflow,
      optionPresets: ((scene as unknown as Record<string, unknown>).optionPresets as Array<Record<string, unknown>> | undefined) ?? [],
      pricing: scene.pricing as ScenePricing | null,
      title: String(asRecord(scene.scene)?.title ?? sceneId),
    };
  }

  /**
   * 已发布的包ID：CDK 新用户默认授权这些服务。
   * 包版本存在 production_documents 里、按项目分区，因此需要一个项目目录；
   * 调用方在请求上下文里传进来，避免在这里引入异步设置读取。
   */
  publishedIds(project: string): string[] {
    if (!project) return [];
    return this.latestVersions(project).map(version => version.packageId);
  }

  /** 管理端授权校验用的已知包ID（草稿即可，未发布的包允许预先授权）。 */
  listDraftIds(project: string): string[] {
    return this.store.listDocuments<PackageDraft & { revision: number }>(project, DRAFTS).map(draft => draft.id);
  }
  async listDrafts() {
    const project = this.requireProject(await this.project());
    return { packages: this.store.listDocuments<PackageDraft & { revision: number }>(project, DRAFTS).sort((a, b) => a.title.localeCompare(b.title)), nextAction: "get_package_draft" as const };
  }
  async getDraft(packageId: string) {
    const project = this.requireProject(await this.project());
    const draft = this.store.getDocument<PackageDraft & { revision: number }>(project, DRAFTS, packageId);
    if (!draft) throw new HttpError(404, "场景包不存在", "PACKAGE_NOT_FOUND");
    const versions = this.store.listDocuments<PackageVersion>(project, VERSIONS).filter(version => version.packageId === packageId).sort((a, b) => b.publishedAt.localeCompare(a.publishedAt));
    return { package: draft, publishedVersionId: versions[0]?.versionId ?? null, versions: versions.map(version => ({ versionId: version.versionId, version: version.version, publishedAt: version.publishedAt })), nextAction: "update_package_draft" as const };
  }
  async createDraft(raw: unknown) {
    const project = this.requireProject(await this.project());
    const parsed = packageDraftDocument.safeParse(raw);
    if (!parsed.success) throw new HttpError(400, "场景包格式无效：" + parsed.error.issues.map(issue => issue.path.join(".") + ": " + issue.message).join("; "), "INVALID_PACKAGE");
    const draft = parsed.data;
    if (this.store.getDocument(project, DRAFTS, draft.id)) throw new HttpError(409, "场景包ID已存在；读取原ID对账，不要换ID重建", "PACKAGE_ALREADY_EXISTS", { packageId: draft.id });
    await this.validateDraft(draft);
    const saved = this.putDraft(project, { ...draft, revision: 0 }, 0);
    return { package: saved, nextAction: "publish_package" as const };
  }
  async updateDraft(packageId: string, raw: unknown) {
    const project = this.requireProject(await this.project());
    const body = asRecord(raw) ?? {};
    const revision = Number(body.revision);
    if (!Number.isSafeInteger(revision) || revision < 0) throw new HttpError(400, "revision 无效", "INVALID_PACKAGE");
    const current = this.store.getDocument<PackageDraft & { revision: number }>(project, DRAFTS, packageId);
    if (!current) throw new HttpError(404, "场景包不存在", "PACKAGE_NOT_FOUND");
    // revision 是草稿元数据，不属于 packageDraftDocument 的 strict 形状；
    // 必须真正删除这个键，赋 undefined 在 zod strict 下仍算未识别键。
    const merged: Record<string, unknown> = { ...current, ...body, id: packageId };
    delete merged.revision;
    const parsed = packageDraftDocument.safeParse(merged);
    if (!parsed.success) throw new HttpError(400, "场景包格式无效：" + parsed.error.issues.map(issue => issue.path.join(".") + ": " + issue.message).join("; "), "INVALID_PACKAGE");
    await this.validateDraft(parsed.data);
    const saved = this.putDraft(project, { ...parsed.data, revision }, revision);
    return { package: saved, nextAction: "publish_package" as const };
  }
  private async validateDraft(draft: PackageDraft) {
    if (draft.items.length > MAX_ITEMS) throw new HttpError(400, "包内最多 " + MAX_ITEMS + " 项", "INVALID_PACKAGE");
    if (draft.pricing) {
      const known = new Set(draft.items.map(item => item.id));
      for (const itemId of Object.keys(draft.pricing.items)) {
        if (!known.has(itemId)) throw new HttpError(400, "服务定价引用了不存在的包内项：" + itemId, "INVALID_PACKAGE", { itemId });
      }
    }
    const components = new Map<string, Awaited<ReturnType<PackageService["component"]>>>();
    for (const item of draft.items) components.set(item.sceneId + "@" + item.versionId, await this.component(item.sceneId, item.versionId));
    validatePackageDraft(draft, (sceneId, versionId) => components.get(sceneId + "@" + versionId));
    return components;
  }

  /** 发布：内嵌组件快照，固化包级定价（各组件定价之和 + 可选包装费）。 */
  async publish(packageId: string, raw: unknown) {
    const project = this.requireProject(await this.project());
    const body = asRecord(raw) ?? {};
    const revision = Number(body.revision);
    const publicationId = typeof body.publicationId === "string" ? body.publicationId : "";
    if (!publicationId) throw new HttpError(400, "请提供 publicationId（调用前生成的 UUID）", "INVALID_PACKAGE");
    return this.locked("publish:" + project + ":" + packageId, async () => {
      const draft = this.store.getDocument<PackageDraft & { revision: number }>(project, DRAFTS, packageId);
      if (!draft) throw new HttpError(404, "场景包不存在", "PACKAGE_NOT_FOUND");
      const existing = this.store.listDocuments<PackageVersion>(project, VERSIONS).find(version => version.versionId === publicationId);
      if (existing) return { version: existing, created: false, nextAction: "get_package" as const };
      if (draft.revision !== revision) throw new HttpError(409, "场景包已变化，请重新读取", "PACKAGE_REVISION_CONFLICT", { currentRevision: draft.revision });
      const components = await this.validateDraft(draft);
      const items: PackageVersionItem[] = draft.items.map(item => {
        const component = components.get(item.sceneId + "@" + item.versionId)!;
        return { id: item.id, name: item.name, sceneId: item.sceneId, versionId: item.versionId, scene: component.scene, workflow: component.workflow, optionPresets: component.optionPresets, inputs: item.inputs, ...(item.confirmAfter ? { confirmAfter: true } : {}) };
      });
      const version: PackageVersion & { id: string } = {
        id: publicationId,
        versionId: publicationId,
        version: contentRevision({ packageId, title: draft.title, items: items.map(item => [item.id, item.sceneId, item.versionId, item.inputs]) }).slice(0, 12),
        publishedAt: new Date().toISOString(),
        packageId,
        title: draft.title,
        ...(draft.summary ? { summary: draft.summary } : {}),
        ...(draft.description ? { description: draft.description } : {}),
        ...(draft.cover ? { cover: draft.cover } : {}),
        inputs: draft.inputs as unknown as RunInputField[],
        items,
        // 服务定价随发布快照固化：配置了就按服务自己的价格，没配置才回退到组件场景定价。
        pricing: draft.pricing
          ? {
              version: 1 as const,
              base: draft.pricing.base,
              source: "package" as const,
              components: Object.fromEntries(items.map(item => [item.id, { credits: draft.pricing!.items[item.id]?.credits ?? 0 }])),
              items: draft.pricing.items,
            }
          : { version: 1 as const, base: 0, source: "component" as const, components: Object.fromEntries(items.map(item => [item.id, { credits: 0 }])) },
        ...(validatePresentation(draft.presentation) ? { presentation: validatePresentation(draft.presentation)! } : {}),
        revision: draft.revision,
      };
      this.store.putDocumentChecked(project, VERSIONS, version, 0);
      return { version, created: true, nextAction: "get_package" as const };
    });
  }

  /** 已发布包目录（用户面）：只返回授权且已发布的包，不含组件快照。 */
  async listAvailable(identity: Identity, query: { limit?: number; cursor?: string }) {
    const current = this.access.refresh(identity);
    const project = this.requireProject(await this.project());
    const versions = this.latestVersions(project);
    const allowed = versions.filter(version => current.role === "admin" || (current.packageIds ?? []).includes(version.packageId));
    const limit = Math.min(200, Math.max(1, query.limit ?? 50));
    const offset = query.cursor ? Number(Buffer.from(query.cursor, "base64url").toString("utf8")) : 0;
    if (!Number.isSafeInteger(offset) || offset < 0) throw new HttpError(400, "分页游标无效", "INVALID_PACKAGE_CURSOR");
    const page = allowed.slice(offset, offset + limit);
    return {
      packages: page.map(version => ({
        packageId: version.packageId, versionId: version.versionId, version: version.version,
        title: version.title, ...(version.summary ? { summary: version.summary } : {}), ...(version.cover ? { cover: version.cover } : {}),
        ...(version.presentation?.hero?.headline ? { headline: version.presentation.hero.headline } : {}),
        ...(version.presentation?.hero?.showcase?.length ? { showcase: version.presentation.hero.showcase.slice(0, 1) } : {}),
        ...(version.presentation?.theme?.accent ? { accent: version.presentation.theme.accent } : {}),
        itemCount: version.items.length,
      })),
      total: allowed.length, hasMore: offset + page.length < allowed.length,
      ...(offset + page.length < allowed.length ? { nextCursor: Buffer.from(String(offset + page.length)).toString("base64url") } : {}),
      nextAction: "get_available_package" as const,
    };
  }
  private latestVersions(project: string) {
    const all = this.store.listDocuments<PackageVersion>(project, VERSIONS);
    const latest = new Map<string, PackageVersion>();
    for (const version of all.sort((a, b) => b.publishedAt.localeCompare(a.publishedAt))) if (!latest.has(version.packageId)) latest.set(version.packageId, version);
    return [...latest.values()];
  }
  private version(project: string, packageId: string, versionId?: string) {
    const versions = this.store.listDocuments<PackageVersion>(project, VERSIONS).filter(version => version.packageId === packageId);
    const selected = versionId ? versions.find(version => version.versionId === versionId) : versions.sort((a, b) => b.publishedAt.localeCompare(a.publishedAt))[0];
    if (!selected) throw new HttpError(409, "场景包尚未发布或该版本不存在", "PACKAGE_NOT_PUBLISHED", { packageId, versionId });
    return selected;
  }

  /** 包详情（用户面）：字段 + 每项的预计消耗，不返回组件提示词与工作流。 */
  async getAvailable(identity: Identity, packageId: string, versionId?: string) {
    const current = this.access.authorizePackage(identity, packageId);
    const project = this.requireProject(await this.project());
    const version = this.version(project, packageId, versionId);
    const fields = version.inputs.map(field => ({
      key: field.key, label: String(asRecord(field)?.label ?? field.key), type: field.type, required: Boolean(field.required), hidden: Boolean(field.hidden),
      ...(field.type === "number" && field.minimum !== undefined ? { minimum: field.minimum } : {}),
      // 数字字段是取值范围；媒体字段是数量上限（最多几张）。
      ...(field.maximum !== undefined && (field.type === "number" || isMediaWorkflowType(field.type)) ? { maximum: field.maximum } : {}),
      ...(field.options ? { options: field.options } : {}),
      ...(field.defaultValue !== undefined ? { defaultValue: field.defaultValue } : {}),
    }));
    const defaults = workflowInputDefaults({ inputs: version.inputs, steps: [], outputs: [] } as unknown as RunWorkflowDefinition);
    return {
      packageId, versionId: version.versionId, version: version.version,
      title: version.title, ...(version.summary ? { summary: version.summary } : {}), ...(version.description ? { description: version.description } : {}),
      fields, inputDefaults: defaults,
      steps: version.items.map(item => ({ itemId: item.id, name: item.name, ...(item.confirmAfter ? { confirmAfter: true } : {}) })),
      ...(version.presentation ? { presentation: version.presentation } : {}),
      credits: this.credits?.balance(current.id) ?? null,
      nextAction: "prepare_own_package" as const,
    };
  }

  /**
   * 上限价。服务自己定价（pricing.source=package）优先：价格属于服务，不跟随内部场景改价；
   * 未配置服务定价时才回退到组件场景自身的定价（兼容旧包）。
   */
  private planCost(version: PackageVersion, inputValues: Record<string, JsonValue>): RunCreditPlan {
    const baseUnits = toUnits(version.pricing.base);
    const plan: RunCreditPlan = { pricingVersion: 1, base: fromUnits(baseUnits), total: fromUnits(baseUnits), steps: {} };
    let totalUnits = baseUnits;
    if (version.pricing.source === "package") {
      // 服务定价按包内项计：每项执行一次即算一次调用，逐项执行按实际项数（提交时已由输入确定）。
      for (const item of version.items) {
        const entry = version.pricing.items?.[item.id];
        if (!entry) continue;
        const units = entry.unit === "per_item" ? forEachInputCount(item.workflow, inputValues as Record<string, unknown>) : 1;
        plan.steps[item.id] = { unit: entry.unit, credits: fromUnits(toUnits(entry.credits)), units };
        totalUnits += units * toUnits(entry.credits);
      }
      plan.total = fromUnits(totalUnits);
      return plan;
    }
    for (const item of version.items) {
      const pricing = asRecord(asRecord(item.scene)?.pricing) as ScenePricing | undefined;
      if (!pricing) continue;
      const cost = planSceneCost(pricing, item.workflow, inputValues as Record<string, unknown>);
      totalUnits += toUnits(cost.total);
      for (const [stepId, entry] of Object.entries(cost.steps)) plan.steps[item.id + "." + stepId] = entry;
    }
    plan.total = fromUnits(totalUnits);
    return plan;
  }

  async prepare(identity: Identity, packageId: string, raw: unknown) {
    const current = this.access.authorizePackage(identity, packageId);
    const body = asRecord(raw) ?? {};
    const versionId = typeof body.versionId === "string" ? body.versionId : "";
    const supplied = asRecord(body.inputValues) ?? {};
    const project = this.requireProject(await this.project());
    const version = this.version(project, packageId, versionId);
    const inputValues = { ...workflowInputDefaults({ inputs: version.inputs, steps: [], outputs: [] } as unknown as RunWorkflowDefinition), ...supplied } as Record<string, JsonValue>;
    this.validatePackageInputs(version, inputValues);
    const plan = this.planCost(version, inputValues);
    return { valid: true, packageId, versionId: version.versionId, costPlan: plan, credits: this.credits?.balance(current.id) ?? null, externalServicesChecked: false, nextAction: "submit_own_package" as const };
  }

  /** 包级输入契约校验：服务自己的字段（含参考图数量上限）在提交前就拒绝，不留给内部场景。 */
  private validatePackageInputs(version: PackageVersion, inputValues: Record<string, JsonValue>) {
    validateWorkflowInputs({ inputs: version.inputs, steps: [], outputs: [] } as unknown as RunWorkflowDefinition, inputValues);
  }

  /** 提交包：一次预扣，逐项串行提交子运行；返回包运行ID与首项运行ID。 */
  async submit(identity: Identity, packageId: string, raw: unknown) {
    const current = this.access.authorizePackage(identity, packageId);
    const body = asRecord(raw) ?? {};
    const versionId = typeof body.versionId === "string" ? body.versionId : "";
    const supplied = asRecord(body.inputValues) ?? {};
    const packageRunId = typeof body.packageRunId === "string" && body.packageRunId ? body.packageRunId : typeof body.runId === "string" ? body.runId : randomUUID();
    if (!/^[a-f0-9-]{36}$/i.test(packageRunId)) throw new HttpError(400, "包运行ID无效", "INVALID_PACKAGE");
    const project = this.requireProject(await this.project());
    return this.locked("run:" + project + ":" + packageRunId, async () => {
      const existing = this.store.getDocument<PackageRun>(project, RUNS, packageRunId);
      if (existing) return { packageRun: this.runView(identity, existing), created: false, nextAction: "get_own_package_run" as const };
      const version = this.version(project, packageId, versionId);
      const inputValues = { ...workflowInputDefaults({ inputs: version.inputs, steps: [], outputs: [] } as unknown as RunWorkflowDefinition), ...supplied } as Record<string, JsonValue>;
      this.validatePackageInputs(version, inputValues);
      const plan = this.planCost(version, inputValues);
      const now = new Date().toISOString();
      const record: PackageRun = {
        id: packageRunId, revision: 0, packageId, versionId: version.versionId, title: typeof body.runTitle === "string" && body.runTitle.trim() ? body.runTitle.trim().slice(0, 120) : version.title,
        ownerUserId: current.id, ...(this.submitter(current) ? { submitter: this.submitter(current)! } : {}),
        status: "queued", createdAt: now, updatedAt: now, inputValues,
        items: version.items.map(item => ({ itemId: item.id, name: item.name, status: "pending" as const, ...(item.confirmAfter ? { confirmAfter: true } : {}) })),
        ...(plan.total > 0 && this.credits ? { credit: { plan } } : {}),
      };
      // 预扣：与单个运行同一套账本与幂等键（包运行ID作为 ref）。
      if (record.credit && this.credits) {
        try { this.credits.reserve(current.id, packageRunId, plan); }
        catch (error) { if (error instanceof HttpError && error.code === "CREDIT_INSUFFICIENT") throw error; throw error; }
      }
      try {
        this.store.putDocumentChecked(project, RUNS, record, 0);
      } catch (error) {
        if (record.credit && this.credits) this.credits.release(current.id, packageRunId, "包运行写入失败");
        throw error;
      }
      // 立即推进第一项；后续项由 pump 在上一项终态后继续。
      await this.pump(project, packageRunId, version);
      const saved = this.store.getDocument<PackageRun>(project, RUNS, packageRunId)!;
      return { packageRun: this.runView(identity, saved), created: true, nextAction: "get_own_package_run" as const };
    });
  }
  private submitter(identity: Identity): RunSubmitter | undefined {
    return { userId: identity.id, username: identity.username, displayName: identity.displayName };
  }

  /** 串行泵：按顺序推进，遇到等待确认/失败/取消即停。 */
  private async pump(project: string, packageRunId: string, version?: PackageVersion) {
    const record = this.store.getDocument<PackageRun>(project, RUNS, packageRunId);
    if (!record || record.cancelledAt) return;
    const resolvedVersion = version ?? this.version(project, record.packageId, record.versionId);
    for (const item of record.items) {
      if (item.status !== "pending") continue;
      if (item.runId) {
        const live = this.store.getRun(project, item.runId);
        if (live && ["queued", "running", "cancelling"].includes(live.status)) return;
        if (live?.status === "waiting") return;
      }
      // 前一项必须完成才能继续（除首项）。
      const index = record.items.indexOf(item);
      const previous = index > 0 ? record.items[index - 1] : undefined;
      if (previous && !["completed", "completed_with_errors", "skipped"].includes(previous.status)) return;
      try {
        const runId = randomUUID();
        const inputValues = this.resolveItemInputs(resolvedVersion, record, item.itemId);
        const prepared = await this.scenes.prepare(itemSceneId(resolvedVersion, item.itemId), itemVersionId(resolvedVersion, item.itemId), inputValues);
        const run = await this.runs.submit(
          { runId, runTitle: (record.title + " · " + item.name).slice(0, 120), workflow: prepared.workflow, inputValues: prepared.inputValues, packageRunId },
          { ownerUserId: record.ownerUserId, ...(record.submitter ? { submitter: record.submitter } : {}), authorize: () => undefined },
        );
        this.mutateRun(project, packageRunId, current => ({
          ...current,
          items: current.items.map(candidate => candidate.itemId === item.itemId ? { ...candidate, runId: run.runId, status: "running" as const } : candidate),
          status: "running" as const,
        }));
        // 等待这一项结束（不阻塞进程：await 在请求内，run 服务自行排队）。
        void this.awaitItem(project, packageRunId, item.itemId, run.runId, resolvedVersion);
        return;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        log("warn", "package.item_submit_failed", { packageRunId, itemId: item.itemId, error: message });
        this.mutateRun(project, packageRunId, current => ({
          ...current,
          items: current.items.map(candidate => candidate.itemId === item.itemId ? { ...candidate, status: "failed" as const, error: message } : candidate),
          status: "failed" as const,
          error: message,
        }));
        this.settle(project, packageRunId);
        return;
      }
    }
    // 所有项都结束：汇总终态并结算。
    this.mutateRun(project, packageRunId, current => ({ ...current, status: packageStatus(current) }));
    this.settle(project, packageRunId);
  }

  private async awaitItem(project: string, packageRunId: string, itemId: string, runId: string, version: PackageVersion) {
    try {
      const run = await this.runs.wait(project, runId);
      const outputs = this.itemOutputs(version, itemId, run);
      const waiting = run.status === "waiting";
      // 运行状态是步骤级的；包内一项的运行只要完成即算完成（部分失败在步骤里，结算按项计）。
      const status = run.status === "completed" ? "completed" as const : run.status === "cancelled" ? "skipped" as const : "failed" as const;
      const current = this.store.getDocument<PackageRun>(project, RUNS, packageRunId);
      if (!current || current.cancelledAt) return;
      const item = current.items.find(candidate => candidate.itemId === itemId);
      if (!item) return;
      if (waiting) {
        // 子运行在等审核：包运行也停在等待确认，用户处理子运行审核后由 pump 继续。
        this.mutateRun(project, packageRunId, record => ({ ...record, status: "waiting_confirm" as const, items: record.items.map(candidate => candidate.itemId === itemId ? { ...candidate, status: "waiting_confirm" as const } : candidate) }));
        return;
      }
      const needsConfirm = item.confirmAfter && status === "completed";
      // 确认点：项本身标记为 waiting_confirm（不是 completed），否则 UI 与投影会以为它已经通过。
      this.mutateRun(project, packageRunId, record => ({
        ...record,
        status: needsConfirm ? "waiting_confirm" as const : record.status,
        items: record.items.map(candidate => candidate.itemId === itemId
          ? { ...candidate, status: needsConfirm ? "waiting_confirm" as const : status, ...(outputs ? { outputs } : {}), ...(run.error && status !== "completed" ? { error: run.error } : {}) }
          : candidate),
      }));
      if (needsConfirm) return;
      if (status === "failed") { this.mutateRun(project, packageRunId, record => ({ ...record, status: "failed" as const, error: run.error ?? "组件执行失败" })); this.settle(project, packageRunId); return; }
      await this.pump(project, packageRunId, version);
    } catch (error) {
      log("warn", "package.await_failed", { packageRunId, itemId, error: error instanceof Error ? error.message : String(error) });
      this.mutateRun(project, packageRunId, record => ({ ...record, status: "failed" as const, error: error instanceof Error ? error.message : String(error) }));
      this.settle(project, packageRunId);
    }
  }

  /**
   * 服务级产出：按包内顺序聚合各已完成项的最终媒体，返回可直接预览的地址。
   * 用户不需要知道这些图来自哪个子运行；地址仍走同一套 output-media 鉴权。
   */
  async outputs(identity: Identity, packageRunId: string) {
    const project = this.requireProject(await this.project());
    const record = this.store.getDocument<PackageRun>(project, RUNS, packageRunId);
    if (!record) throw new HttpError(404, "包运行不存在", "OBJECT_NOT_FOUND");
    if (record.ownerUserId !== identity.id && identity.role !== "admin") throw new HttpError(404, "包运行不存在", "OBJECT_NOT_FOUND");
    this.access.refresh(identity);
    const items: Array<{ index: number; name: string; media: Array<{ url: string; kind: "image" | "video" | "audio" }> }> = [];
    record.items.forEach((item, index) => {
      if (!item.runId) return;
      const run = this.store.getRun(project, item.runId);
      if (!run) return;
      // 同一个文件可能被多个输出键引用（例如 result 与 generated 在文生图分支指向同一张图）。
      // 用户看到的应该是「产出」，按实际文件去重，而不是按输出键重复展示。
      const seen = new Set<string>();
      const media = run.outputs.flatMap(output => {
        if (!/^(image|video|audio)(_list)?$/.test(output.type)) return [];
        const values = Array.isArray(output.value) ? output.value : [output.value];
        return values.flatMap((value, mediaIndex) => {
          const identity = typeof value === "string" ? value : JSON.stringify(value ?? null);
          if (seen.has(identity)) return [];
          seen.add(identity);
          const parameters = new URLSearchParams({ outputKey: output.key, mediaIndex: String(mediaIndex) });
          return [{ url: "/api/v1/runs/" + run.runId + "/output-media?" + parameters, kind: (output.type.startsWith("video") ? "video" : output.type.startsWith("audio") ? "audio" : "image") as "image" | "video" | "audio" }];
        });
      });
      if (media.length) items.push({ index: index + 1, name: item.name, media });
    });
    return { packageRunId, items, total: items.reduce((sum, item) => sum + item.media.length, 0), nextAction: "get_own_package_run" as const };
  }

  /** 取本项产出：只保留声明为最终输出的键，媒体转成素材引用（后续项可直接当输入）。 */
  private itemOutputs(version: PackageVersion, itemId: string, run: RunRecord): Record<string, JsonValue> | undefined {
    const item = version.items.find(candidate => candidate.id === itemId);
    if (!item) return undefined;
    const outputs: Record<string, JsonValue> = {};
    for (const output of item.workflow.outputs) {
      const produced = run.outputs.find(candidate => candidate.key === output.key);
      if (produced) outputs[output.key] = produced.value;
    }
    return Object.keys(outputs).length ? outputs : undefined;
  }

  /** 组件输入：包输入 / 固定值 / 前序项产出；媒体保持引用原样（由素材解析校验归属）。 */
  private resolveItemInputs(version: PackageVersion, record: PackageRun, itemId: string): Record<string, JsonValue> {
    const item = version.items.find(candidate => candidate.id === itemId);
    if (!item) throw new HttpError(409, "包内项不存在：" + itemId, "PACKAGE_ITEM_MISSING");
    const values: Record<string, JsonValue> = {};
    for (const binding of item.inputs) {
      if (binding.valueSource === "input") {
        const key = binding.sourceRef!.slice(6);
        if (record.inputValues[key] !== undefined) values[binding.key] = record.inputValues[key];
        continue;
      }
      if (binding.valueSource === "literal") {
        const field = item.workflow.inputs.find(candidate => candidate.key === binding.key);
        values[binding.key] = literalValue(binding.literalValue!, field?.type);
        continue;
      }
      const reference = /^([a-zA-Z0-9][a-zA-Z0-9_.-]*)\.([a-zA-Z0-9_]+)$/.exec(binding.sourceRef ?? "");
      const source = reference ? record.items.find(candidate => candidate.itemId === reference[1]) : undefined;
      if (!reference || !source?.outputs) throw new HttpError(409, "前序项还没有可用的产出：" + String(binding.sourceRef), "PACKAGE_PREVIOUS_VALUE_MISSING", { itemId, reference: binding.sourceRef });
      values[binding.key] = selectPackageValue(source.outputs[reference[2]], binding.selection);
    }
    return values;
  }

  private mutateRun(project: string, packageRunId: string, transform: (current: PackageRun) => PackageRun) {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const current = this.store.getDocument<PackageRun>(project, RUNS, packageRunId);
      if (!current) return undefined;
      try {
        return this.store.putDocumentChecked(project, RUNS, { ...transform(current), updatedAt: new Date().toISOString() }, current.revision);
      } catch (error) {
        if ((error as Error).message !== "DOCUMENT_CONFLICT") throw error;
      }
    }
    return undefined;
  }

  /**
   * 包级精确结算：只收**已完成项**的上限价，其余退还。项内若部分逐项失败，
   * 该子运行自己的结算口径（成功项计费）已经体现在运行记录里，包级按项的上限价收是保守且可解释的：
   * 用户看到的是「这一步算完成，按这一步的上限价收费」。
   */
  private settle(project: string, packageRunId: string) {
    if (!this.credits) return;
    const record = this.store.getDocument<PackageRun>(project, RUNS, packageRunId);
    if (!record?.credit || record.credit.settlement) return;
    if (["queued", "running", "waiting_confirm"].includes(record.status)) return;
    const chargedUnits = record.items.reduce((sum, item) => sum + (item.status === "completed" || item.status === "completed_with_errors" ? this.itemCostUnits(record, item) : 0), 0);
    const total = record.credit.plan.total;
    try {
      const result = this.credits.settlePackage(record.ownerUserId, packageRunId, fromUnits(chargedUnits), total);
      this.mutateRun(project, packageRunId, current => ({
        ...current,
        credit: { ...current.credit!, settlement: { settledAt: new Date().toISOString(), charged: result.charged, refunded: result.refunded } },
      }));
    } catch (error) {
      log("error", "package.settle_failed", { packageRunId, error: String(error) });
    }
  }
  /** 本项在包预算里的上限价（厘）：服务定价按项计（键是项ID），组件定价按项内步骤计（键是 项ID.步骤ID）。 */
  private itemCostUnits(record: PackageRun, item: PackageRunItem) {
    const plan = record.credit?.plan;
    if (!plan) return 0;
    const direct = plan.steps[item.itemId];
    if (direct) return direct.units * toUnits(direct.credits);
    return Object.entries(plan.steps).filter(([key]) => key.startsWith(item.itemId + ".")).reduce((sum, [, entry]) => sum + entry.units * toUnits(entry.credits), 0);
  }

  /** 人工确认点：approve 继续剩余项；redo 重跑本项。 */
  async confirmItem(identity: Identity, raw: unknown) {
    const body = asRecord(raw) ?? {};
    const packageRunId = typeof body.packageRunId === "string" ? body.packageRunId : "";
    const itemId = typeof body.itemId === "string" ? body.itemId : "";
    const action = body.action;
    const project = this.requireProject(await this.project());
    const record = this.store.getDocument<PackageRun>(project, RUNS, packageRunId);
    if (!record) throw new HttpError(404, "包运行不存在", "OBJECT_NOT_FOUND");
    if (record.ownerUserId !== identity.id && identity.role !== "admin") throw new HttpError(404, "包运行不存在", "OBJECT_NOT_FOUND");
    this.access.authorizePackage(identity, record.packageId);
    if (record.cancelledAt) throw new HttpError(409, "包运行已取消", "PACKAGE_RUN_CANCELLED");
    const item = record.items.find(candidate => candidate.itemId === itemId);
    if (!item) throw new HttpError(404, "包内项不存在", "OBJECT_NOT_FOUND");
    const version = this.version(project, record.packageId, record.versionId);
    // 重试：失败后把这一项及其后的失败项重新排入执行。
    // 费用沿用本包运行原有的预扣（失败项本来就不计费，重试成功后按完成项结算），
    // 不额外预扣，避免与包级结算的幂等键冲突。
    if (action === "retry") {
      if (record.status !== "failed" && item.status !== "failed") throw new HttpError(409, "只有失败的任务可以重试", "PACKAGE_NOT_FAILED");
      this.mutateRun(project, packageRunId, current => ({
        ...current, status: "queued" as const, error: undefined, cancelledAt: undefined,
        credit: current.credit ? { plan: current.credit.plan } : undefined,
        items: current.items.map(candidate => {
          if (candidate.itemId === itemId) return { ...candidate, runId: undefined, status: "pending" as const, error: undefined, confirmed: false };
          if (candidate.status === "failed") return { ...candidate, runId: undefined, status: "pending" as const, error: undefined };
          return candidate;
        }),
      }));
      await this.pump(project, packageRunId, version);
      return { packageRun: this.runView(identity, this.store.getDocument<PackageRun>(project, RUNS, packageRunId)!), nextAction: "get_own_package_run" as const };
    }
    if (item.status !== "waiting_confirm") throw new HttpError(409, "该项不在等待确认状态", "PACKAGE_NOT_WAITING");
    if (action === "approve") {
      this.mutateRun(project, packageRunId, current => ({ ...current, status: "running" as const, items: current.items.map(candidate => candidate.itemId === itemId ? { ...candidate, status: candidate.runId && this.store.getRun(project, candidate.runId)?.status === "waiting" ? "completed" as const : "completed" as const, confirmed: true } : candidate) }));
      await this.pump(project, packageRunId, version);
      return { packageRun: this.runView(identity, this.store.getDocument<PackageRun>(project, RUNS, packageRunId)!), nextAction: "get_own_package_run" as const };
    }
    if (action === "redo") {
      if (!item.runId) throw new HttpError(409, "该项还没有可重跑的运行", "PACKAGE_ITEM_MISSING");
      const newRunId = randomUUID();
      const inputValues = this.resolveItemInputs(version, record, itemId);
      const prepared = await this.scenes.prepare(itemSceneId(version, itemId), itemVersionId(version, itemId), inputValues);
      const run = await this.runs.submit({ runId: newRunId, runTitle: (record.title + " · " + item.name).slice(0, 120), workflow: prepared.workflow, inputValues: prepared.inputValues, packageRunId },
        { ownerUserId: record.ownerUserId, ...(record.submitter ? { submitter: record.submitter } : {}), authorize: () => undefined });
      this.mutateRun(project, packageRunId, current => ({ ...current, status: "running" as const, items: current.items.map(candidate => candidate.itemId === itemId ? { ...candidate, runId: run.runId, status: "running" as const, confirmed: false, error: undefined } : candidate) }));
      void this.awaitItem(project, packageRunId, itemId, run.runId, version);
      return { packageRun: this.runView(identity, this.store.getDocument<PackageRun>(project, RUNS, packageRunId)!), nextAction: "get_own_package_run" as const };
    }
    throw new HttpError(400, "确认动作无效", "INVALID_PACKAGE");
  }

  /**
   * 用户面服务视图：包是 SaaS 服务，用户只该看到「做到哪一步、要不要确认、出了什么结果」。
   * 组件名、步骤名、子运行ID、内部错误原文都是实现细节，一律不出现在这里。
   */
  private viewServiceRun(record: PackageRun) {
    const total = record.items.length;
    const done = record.items.filter(item => item.status === "completed" || item.status === "completed_with_errors").length;
    const failed = record.items.some(item => item.status === "failed");
    const waitingItem = record.items.find(item => item.status === "waiting_confirm");
    const failedItem = record.items.find(item => item.status === "failed");
    // 失败只说「这一步没成功」，不把内部异常文本透给用户。
    const stage = record.cancelledAt ? "cancelled" : waitingItem ? "waiting_confirm" : failed ? "failed" : record.status === "completed" || record.status === "completed_with_errors" ? "completed" : "running";
    return {
      packageRunId: record.id, packageId: record.packageId, versionId: record.versionId, title: record.title,
      status: record.status, stage, createdAt: record.createdAt, updatedAt: record.updatedAt,
      progress: { total, completed: done, current: Math.min(total, done + 1) },
      inputCount: Object.keys(record.inputValues).length,
      ...(waitingItem ? { confirmation: { step: done + 1, total, itemId: waitingItem.itemId, actions: ["approve", "redo"] as const } } : {}),
      // 失败时给一个重试入口：用户只需一个按钮，不需要知道是哪一步、更不需要看错误原文。
      ...(stage === "failed" && failedItem ? { retry: { step: Math.min(total, done + 1), total, itemId: failedItem.itemId, action: "retry" as const } } : {}),
      ...(record.credit ? { credit: { total: record.credit.plan.total, ...(record.credit.settlement ? { settlement: record.credit.settlement } : {}) } } : {}),
      nextAction: waitingItem ? "confirm_own_package_item" : ["queued", "running"].includes(record.status) ? "wait" : "get_own_package_run",
    };
  }

  /** 包运行视图：子运行状态实时投影，避免协调器状态与真实运行漂移。 */
  viewRun(record: PackageRun) {
    return {
      packageRunId: record.id, packageId: record.packageId, versionId: record.versionId, title: record.title,
      status: record.status, createdAt: record.createdAt, updatedAt: record.updatedAt,
      inputCount: Object.keys(record.inputValues).length,
      items: record.items.map(item => ({
        itemId: item.itemId, name: item.name, status: item.status,
        ...(item.runId ? { runId: item.runId } : {}),
        ...(item.confirmAfter ? { confirmAfter: true } : {}), ...(item.confirmed ? { confirmed: true } : {}),
        ...(item.error ? { error: item.error } : {}),
        ...(item.outputs ? { outputKeys: Object.keys(item.outputs) } : {}),
      })),
      ...(record.credit ? { credit: { total: record.credit.plan.total, ...(record.credit.settlement ? { settlement: record.credit.settlement } : {}) } } : {}),
      ...(record.error ? { error: record.error } : {}),
      nextAction: record.status === "waiting_confirm" ? "confirm_own_package_item" : ["queued", "running"].includes(record.status) ? "wait" : "get_own_package_run",
    };
  }

  /** 按身份选择视图：管理员看完整协调器状态，用户只看服务级进度与结果。 */
  private runView(identity: Identity, record: PackageRun) {
    return identity.role === "admin" ? this.viewRun(record) : this.viewServiceRun(record);
  }

  async getRun(identity: Identity, packageRunId: string) {
    const project = this.requireProject(await this.project());
    const record = this.store.getDocument<PackageRun>(project, RUNS, packageRunId);
    if (!record) throw new HttpError(404, "包运行不存在", "OBJECT_NOT_FOUND");
    if (record.ownerUserId !== identity.id && identity.role !== "admin") throw new HttpError(404, "包运行不存在", "OBJECT_NOT_FOUND");
    this.access.refresh(identity);
    return this.runView(identity, record);
  }
  /**
   * 本次服务运行的原始输入：字段取该次运行固化的包发布快照，值取提交时的 inputValues。
   * 后续改版或重新发布都不会改写它；媒体只返回固定 assetId/assetVersion，不返回本机路径。
   */
  async inputs(identity: Identity, packageRunId: string, query: RunInputQuery) {
    const project = this.requireProject(await this.project());
    const record = this.store.getDocument<PackageRun>(project, RUNS, packageRunId);
    if (!record) throw new HttpError(404, "包运行不存在", "OBJECT_NOT_FOUND");
    if (record.ownerUserId !== identity.id && identity.role !== "admin") throw new HttpError(404, "包运行不存在", "OBJECT_NOT_FOUND");
    this.access.refresh(identity);
    // 版本已被清理时仍要能读到输入：退回只列出实际提交的键（不含标签/类型），
    // 不伪造当前发布版的字段定义——那会把「当时没填」显示成「现在有默认值」。
    const version = this.store.listDocuments<PackageVersion>(project, VERSIONS)
      .find(candidate => candidate.packageId === record.packageId && candidate.versionId === record.versionId);
    const fields: RunInputField[] = version?.inputs
      ?? Object.keys(record.inputValues).map(key => ({ key, type: typeof record.inputValues[key] === "number" ? "number" : typeof record.inputValues[key] === "boolean" ? "boolean" : "text" }));
    return { ...packageRunInputs({ id: record.id, versionId: record.versionId, inputValues: record.inputValues, fields }, query), packageRunId: record.id, packageId: record.packageId, versionId: record.versionId, nextAction: "prepare_own_package" as const };
  }
  async listRuns(identity: Identity, query: { limit?: number; cursor?: string }) {
    const project = this.requireProject(await this.project());
    const all = this.store.listDocuments<PackageRun>(project, RUNS)
      .filter(record => record.ownerUserId === identity.id || identity.role === "admin")
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
    const limit = Math.min(200, Math.max(1, query.limit ?? 50));
    const offset = query.cursor ? Number(Buffer.from(query.cursor, "base64url").toString("utf8")) : 0;
    if (!Number.isSafeInteger(offset) || offset < 0) throw new HttpError(400, "分页游标无效", "INVALID_PACKAGE_CURSOR");
    const page = all.slice(offset, offset + limit);
    return { items: page.map(record => this.runView(identity, record)), total: all.length, hasMore: offset + page.length < all.length, ...(offset + page.length < all.length ? { nextCursor: Buffer.from(String(offset + page.length)).toString("base64url") } : {}), nextAction: "get_own_package_run" as const };
  }
  async cancel(identity: Identity, packageRunId: string) {
    const project = this.requireProject(await this.project());
    const record = this.store.getDocument<PackageRun>(project, RUNS, packageRunId);
    if (!record) throw new HttpError(404, "包运行不存在", "OBJECT_NOT_FOUND");
    if (record.ownerUserId !== identity.id && identity.role !== "admin") throw new HttpError(404, "包运行不存在", "OBJECT_NOT_FOUND");
    this.access.refresh(identity);
    if (record.cancelledAt) return this.runView(identity, record);
    const marked = this.mutateRun(project, packageRunId, current => ({ ...current, cancelledAt: new Date().toISOString(), status: "cancelled" as const }))!;
    for (const item of marked.items) {
      if (!item.runId) continue;
      try { await this.runs.cancel(project, item.runId); } catch { /* 单项取消失败由该项真实状态反映 */ }
    }
    this.settle(project, packageRunId);
    return this.runView(identity, this.store.getDocument<PackageRun>(project, RUNS, packageRunId)!);
  }
}

function packageStatus(record: PackageRun): PackageRunStatus {
  if (record.cancelledAt) return "cancelled";
  const statuses = record.items.map(item => item.status);
  if (statuses.some(status => status === "waiting_confirm")) return "waiting_confirm";
  if (statuses.some(status => status === "pending" || status === "running")) return "running";
  if (statuses.every(status => status === "completed" || status === "skipped")) return "completed";
  if (statuses.some(status => status === "completed" || status === "completed_with_errors")) return "completed_with_errors";
  return "failed";
}
function itemSceneId(version: PackageVersion, itemId: string) { return version.items.find(item => item.id === itemId)!.sceneId; }
function itemVersionId(version: PackageVersion, itemId: string) { return version.items.find(item => item.id === itemId)!.versionId; }
/**
 * 服务按项定价时的项数上限：该项工作流若整体 for_each 且来源是包输入数组，
 * 项数在提交时已确定；来源是前序产出时无法预估，按 1 计（结算按成功项数，永不补扣）。
 */
function forEachInputCount(workflow: RunWorkflowDefinition, inputValues: Record<string, unknown>) {
  const sourceRef = workflow.execution?.mode === "for_each" ? workflow.execution.sourceRef : undefined;
  const root = typeof sourceRef === "string" ? splitWorkflowReference(sourceRef)?.root : undefined;
  const inputKey = root?.startsWith("input.") ? root.slice(6) : undefined;
  if (!inputKey) return 1;
  const value = inputValues[inputKey];
  if (value === undefined || value === null || value === "") return 1;
  return Array.isArray(value) ? Math.max(1, value.length) : 1;
}
function literalValue(raw: string, type: string | undefined): JsonValue {
  if (type === "number") { const value = Number(raw); if (!Number.isFinite(value)) throw new HttpError(400, "固定值不是有效数字", "INVALID_PACKAGE"); return value; }
  if (type === "boolean") return raw === "true" || raw === "1";
  if (type === "json" || type === "image_list" || type === "video_list" || type === "audio_list") { try { return JSON.parse(raw) as JsonValue; } catch { return raw; } }
  return raw;
}
export { normalizeRunWorkflow };
