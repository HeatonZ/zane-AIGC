import { HttpError } from "../errors.js";
import type { RunInputQuery } from "../ai/accessSchemas.js";
import type { Identity } from "./accessService.js";
import type { CodeScenePackageService } from "./codeScenePackageService.js";
import type { PackageService } from "./packageService.js";

/**
 * 用户面场景包的唯一入口（`/api/v1/self/packages*`）。
 *
 * 业务口径：场景包就是磁盘上的代码子工程，工作台是宿主框架。但历史已发布的配置型包
 * （草稿 + 组件绑定 + 发布快照）仍在生产里被用户使用、且有历史运行记录，因此用户面
 * 不再「猜」包来自哪套实现，而是由这里统一裁决：
 *
 * - **同一 packageId 只有一条目录项**，代码子工程优先。这就是「生图包等价替换」的落点：
 *   磁盘上有 `ai_image` 代码包时，用户看到、提交的都是代码包，配置型同 ID 包不再出现在目录里。
 * - 代码包不存在或未启用时，回退到配置型包（不制造功能空洞）。
 * - 运行记录按 `packageRunId` 归属分流：代码包运行在 `codeScenePackageRuns`，历史配置型运行在
 *   `packageRuns`。两者都能读，用户不需要知道区别。
 *
 * 这一层只做「裁决 + 投影对齐」，不复制任何执行、计费或状态机逻辑：
 * 提交、预扣、结算、子运行排队全部仍在 CodeScenePackageService / PackageService 里。
 */
export class PackageCatalogueService {
  constructor(private readonly config: PackageService, private readonly code?: CodeScenePackageService) {}

  /**
   * 目录：合并两个来源，代码包优先，同 ID 去重后统一分页。
   * 分页由这一层做：两个来源各自的分页游标不能混用，合并后必须按合并序列重新切片。
   */
  async listAvailable(identity: Identity, query: { limit?: number; cursor?: string }) {
    const limit = Math.min(200, Math.max(1, query.limit ?? 50));
    const offset = query.cursor ? Number(Buffer.from(query.cursor, "base64url").toString("utf8")) : 0;
    if (!Number.isSafeInteger(offset) || offset < 0) throw new HttpError(400, "分页游标无效", "INVALID_PACKAGE_CURSOR");

    // 一次取满两个来源：目录是用户面首屏，条数由授权决定，通常只有个位数到十几个。
    const [codeItems, configItems] = await Promise.all([this.codeEntries(identity), this.configEntries(identity)]);
    const seen = new Set<string>();
    const merged: Array<Record<string, unknown>> = [];
    for (const item of codeItems) {
      if (seen.has(String(item.packageId))) continue;
      seen.add(String(item.packageId));
      merged.push({ ...item, source: "code" as const });
    }
    for (const item of configItems) {
      if (seen.has(String(item.packageId))) continue;
      seen.add(String(item.packageId));
      merged.push({ ...item, source: "config" as const });
    }
    const page = merged.slice(offset, offset + limit);
    const hasMore = offset + page.length < merged.length;
    return {
      packages: page,
      total: merged.length,
      hasMore,
      ...(hasMore && page.length ? { nextCursor: Buffer.from(String(offset + page.length)).toString("base64url") } : {}),
      nextAction: "get_available_package" as const,
    };
  }

  /** 包详情：代码包优先；代码包没有 versionId（版本由包自身声明），不回填假值。 */
  async getAvailable(identity: Identity, packageId: string, versionId?: string) {
    if (this.isCodePackage(packageId)) return { ...(await this.code!.getAvailable(identity, packageId, versionId)), source: "code" as const };
    return { ...(await this.config.getAvailable(identity, packageId, versionId)), source: "config" as const };
  }

  /**
   * 预检：代码包按包声明的 pricing 算上限价；配置型包按发布快照的 pricing 算。
   * 两者都不创建运行、不扣费。
   */
  async prepare(identity: Identity, packageId: string, raw: unknown) {
    if (this.isCodePackage(packageId)) return { ...(await this.code!.prepareForUser(identity, packageId, raw)), source: "code" as const };
    return { ...(await this.config.prepare(identity, packageId, raw)), source: "config" as const };
  }

  /** 提交：代码包走 CodeScenePackageService.startForUser（授权 + 预扣 + 包运行记录 + 后台执行）。 */
  async submit(identity: Identity, packageId: string, raw: unknown) {
    if (this.isCodePackage(packageId)) {
      const result = await this.code!.startForUser(identity, packageId, raw);
      return { packageRun: { ...result.packageRun, source: "code" as const }, created: result.created, nextAction: result.nextAction };
    }
    return this.config.submit(identity, packageId, raw);
  }

  /** 本人服务运行：两个来源合并，按创建时间倒序统一分页。 */
  async listRuns(identity: Identity, query: { limit?: number; cursor?: string }) {
    const limit = Math.min(200, Math.max(1, query.limit ?? 50));
    const offset = query.cursor ? Number(Buffer.from(query.cursor, "base64url").toString("utf8")) : 0;
    if (!Number.isSafeInteger(offset) || offset < 0) throw new HttpError(400, "分页游标无效", "INVALID_PACKAGE_CURSOR");
    const [codePage, configPage] = await Promise.all([
      this.code ? this.code.listOwnRuns(identity, { limit: 200 }) : Promise.resolve({ items: [] as Array<Record<string, unknown>> }),
      this.config.listRuns(identity, { limit: 200 }),
    ]);
    const merged: Array<Record<string, unknown>> = [];
    for (const item of codePage.items as Array<Record<string, unknown>>) merged.push({ ...item, source: "code" as const });
    for (const item of configPage.items as Array<Record<string, unknown>>) merged.push({ ...item, source: "config" as const });
    merged.sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt)) || String(right.packageRunId).localeCompare(String(left.packageRunId)));
    const page = merged.slice(offset, offset + limit);
    const hasMore = offset + page.length < merged.length;
    return {
      items: page,
      total: merged.length,
      hasMore,
      ...(hasMore && page.length ? { nextCursor: Buffer.from(String(offset + page.length)).toString("base64url") } : {}),
      nextAction: "get_own_package_run" as const,
    };
  }

  async getRun(identity: Identity, packageRunId: string) {
    if (await this.isCodeRun(packageRunId)) return { ...(await this.code!.getOwnRun(identity, packageRunId)), source: "code" as const };
    return { ...(await this.config.getRun(identity, packageRunId)), source: "config" as const };
  }

  async outputs(identity: Identity, packageRunId: string) {
    if (await this.isCodeRun(packageRunId)) return this.code!.ownOutputs(identity, packageRunId);
    return this.config.outputs(identity, packageRunId);
  }

  async inputs(identity: Identity, packageRunId: string, query: RunInputQuery) {
    if (await this.isCodeRun(packageRunId)) return this.code!.ownInputs(identity, packageRunId, query);
    return this.config.inputs(identity, packageRunId, query);
  }

  async cancel(identity: Identity, packageRunId: string) {
    if (await this.isCodeRun(packageRunId)) return { ...(await this.code!.cancelOwnRun(identity, packageRunId)), source: "code" as const };
    return this.config.cancel(identity, packageRunId);
  }

  /**
   * 只读工程状态：只有代码子工程有 `framework.store`（包自己写的工程账）。
   *
   * 配置型包没有这条账，但这里**不能直接 404**：那会变成「存在但无权限」与「不存在」不可区分的探测口。
   * 所以先走配置型的 `getAvailable`（内含授权与存在性检查），确有权限且确实存在时，才报「没有可显示的工程状态」。
   */
  async state(identity: Identity, packageId: string, key?: string) {
    if (this.isCodePackage(packageId)) return { ...(await this.code!.readState(identity, packageId, key)), source: "code" as const };
    await this.config.getAvailable(identity, packageId);
    throw new HttpError(404, "这个服务还没有可显示的工程状态", "PACKAGE_STATE_NOT_FOUND", { packageId });
  }

  /**
   * 确认点：只有配置型包有「项完成后等确认」的概念。代码包的进度由包代码自己决定，
   * 宿主不给它引入第二套确认状态机，所以这里明确拒绝而不是静默成功。
   */
  async confirmItem(identity: Identity, raw: unknown) {
    const packageRunId = typeof (raw as Record<string, unknown> | undefined)?.packageRunId === "string" ? String((raw as Record<string, unknown>).packageRunId) : "";
    if (packageRunId && (await this.isCodeRun(packageRunId))) {
      throw new HttpError(409, "这个服务没有需要确认的步骤", "PACKAGE_NOT_WAITING", { packageRunId });
    }
    return this.config.confirmItem(identity, raw);
  }

  /** 授权可授予的包 ID 全集：代码包（已加载且启用）+ 配置型草稿/发布。 */
  async knownPackageIds(): Promise<string[]> {
    const configIds = this.config.listDraftIds(await this.config.projectDirectory());
    const codeIds = await this.codePackageIds();
    return [...new Set([...codeIds, ...configIds])];
  }

  /** CDK 开通时自动授予的包：代码包优先（同 ID 时配置型不再重复授予）。 */
  async grantablePackageIds(): Promise<string[]> {
    const project = await this.config.projectDirectory();
    const codeIds = await this.codePackageIds();
    const configIds = this.config.publishedIds(project).filter((id) => !codeIds.includes(id));
    return [...new Set([...codeIds, ...configIds])];
  }

  private async codeEntries(identity: Identity): Promise<Array<Record<string, unknown>>> {
    if (!this.code) return [];
    return (await this.code.listAvailable(identity, { limit: 200 })).packages as Array<Record<string, unknown>>;
  }

  private async configEntries(identity: Identity): Promise<Array<Record<string, unknown>>> {
    return (await this.config.listAvailable(identity, { limit: 200 })).packages as Array<Record<string, unknown>>;
  }

  private async codePackageIds(): Promise<string[]> {
    if (!this.code) return [];
    const project = await this.config.projectDirectory();
    if (!project) return [];
    return (await this.code.getAdminList()).packages
      .filter((entry) => entry.status === "ok" && entry.enabled)
      .map((entry) => entry.packageId);
  }

  /** 这个 packageId 当前是否由代码子工程提供（已加载成功且启用）。 */
  private isCodePackage(packageId: string): boolean {
    return Boolean(this.code?.offers(packageId));
  }

  /** 这条 packageRunId 是否落在代码包运行集合里。 */
  private async isCodeRun(packageRunId: string): Promise<boolean> {
    return Boolean(this.code && (await this.code.ownsRun(packageRunId)));
  }
}
