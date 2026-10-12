import type { CapabilityCatalogPage } from "../capabilities/contracts.js";
import { CAPABILITY_SELECTION_POLICY } from "../capabilities/contracts.js";
import { capabilityQuery } from "../ai/schemas.js";
import { contentRevision } from "../domain/sceneContent.js";
import { HttpError } from "../errors.js";
import type { ExecutorRegistry } from "../execution/executorRegistry.js";
import type { WorkspaceService } from "./workspaceService.js";

export interface CompatibilityUsage {
  capabilityId: string;
  draftScenes: number;
  publishedScenes: number;
  nextAction: string;
}

/** Read projection of the existing registry; no separate state or execution path. */
export class CapabilityCatalogService {
  constructor(private readonly registry: ExecutorRegistry, private readonly workspace?: WorkspaceService) {}
  /** 统计退役能力在草稿与发布快照中的引用场景数，为下线决策提供依据；只读，不修改任何快照。 */
  async compatibilityUsage(): Promise<CompatibilityUsage[]> {
    if (!this.workspace) return [];
    const retired = this.registry.definitions().filter((definition) => definition.usage?.compatibilityOnly).map((definition) => definition.id);
    if (!retired.length) return [];
    const workspace = await this.workspace.get().catch(() => undefined);
    if (!workspace) return retired.map((capabilityId) => ({ capabilityId, draftScenes: 0, publishedScenes: 0, nextAction: "no_workspace_initialized" }));
    const counts = new Map(retired.map((id) => [id, { draftScenes: 0, publishedScenes: 0 }]));
    const workflows = (workspace.workflows ?? {}) as Record<string, unknown>;
    for (const workflow of Object.values(workflows)) {
      const steps = (workflow as { steps?: unknown[] } | undefined)?.steps;
      if (!Array.isArray(steps)) continue;
      const referenced = new Set<string>();
      for (const step of steps) {
        const id = (step as { capabilityId?: unknown } | undefined)?.capabilityId;
        if (typeof id === "string" && counts.has(id)) referenced.add(id);
      }
      for (const id of referenced) counts.get(id)!.draftScenes += 1;
    }
    const sceneVersions = (workspace.sceneVersions ?? {}) as Record<string, unknown>;
    for (const record of Object.values(sceneVersions)) {
      const versions = (record as { versions?: unknown[] } | undefined)?.versions;
      if (!Array.isArray(versions)) continue;
      const referenced = new Set<string>();
      for (const version of versions) {
        const steps = ((version as { workflow?: { steps?: unknown[] } } | undefined)?.workflow?.steps);
        if (!Array.isArray(steps)) continue;
        for (const step of steps) {
          const id = (step as { capabilityId?: unknown } | undefined)?.capabilityId;
          if (typeof id === "string" && counts.has(id)) referenced.add(id);
        }
      }
      for (const id of referenced) counts.get(id)!.publishedScenes += 1;
    }
    return retired.map((capabilityId) => {
      const count = counts.get(capabilityId)!;
      return { capabilityId, ...count, nextAction: count.draftScenes || count.publishedScenes ? "keep_registered_until_unreferenced" : "candidate_for_retirement" };
    });
  }
  list(input: unknown = {}): CapabilityCatalogPage {
    const parsed = capabilityQuery.safeParse(input);
    if (!parsed.success) throw new HttpError(400, "能力目录查询参数无效", "INVALID_CAPABILITY_QUERY");
    const query = parsed.data;
    const catalog = this.registry.definitions();
    const revision = contentRevision(catalog);
    let offset = 0;
    if (query.cursor) {
      try {
        const token = JSON.parse(Buffer.from(query.cursor, "base64url").toString("utf8"));
        if (token.format !== "capability-page/v1" || !Number.isSafeInteger(token.offset) || token.offset < 1 || typeof token.revision !== "string") throw new Error();
        if (token.revision !== revision) throw new HttpError(409, "能力目录在分页期间变化，请重读第一页", "CAPABILITY_PAGE_CHANGED", { currentRevision: revision, nextAction: "read_first_page" });
        if (token.offset >= catalog.length) throw new Error();
        offset = token.offset;
      } catch (error) {
        if (error instanceof HttpError) throw error;
        throw new HttpError(400, "能力目录游标无效", "INVALID_CAPABILITY_CURSOR");
      }
    }
    const capabilities = catalog.slice(offset, offset + query.limit);
    const nextOffset = offset + capabilities.length;
    const hasMore = nextOffset < catalog.length;
    return { schemaVersion: 1, revision, selectionPolicy: { ...CAPABILITY_SELECTION_POLICY }, capabilities, hasMore,
      ...(hasMore ? { nextCursor: Buffer.from(JSON.stringify({ format: "capability-page/v1", revision, offset: nextOffset })).toString("base64url") } : {}),
    };
  }
}
