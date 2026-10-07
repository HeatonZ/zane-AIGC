import type { CapabilityCatalogPage } from "../capabilities/contracts.js";
import { CAPABILITY_SELECTION_POLICY, groupCapabilities } from "../capabilities/contracts.js";
import { capabilityQuery } from "../ai/schemas.js";
import { contentRevision } from "../domain/sceneContent.js";
import { HttpError } from "../errors.js";
import type { ExecutorRegistry } from "../execution/executorRegistry.js";

/** Read projection of the existing registry; no separate state or execution path. */
export class CapabilityCatalogService {
  constructor(private readonly registry: ExecutorRegistry) {}
  list(input: unknown = {}): CapabilityCatalogPage {
    const parsed = capabilityQuery.safeParse(input);
    if (!parsed.success) throw new HttpError(400, "能力目录查询参数无效", "INVALID_CAPABILITY_QUERY");
    const query = parsed.data;
    const groups = groupCapabilities(this.registry.definitions());
    const all = [...groups.basic, ...groups.specialized];
    const revision = contentRevision(all);
    const selected = query.tier === "all" ? all : groups[query.tier];
    let offset = 0;
    if (query.cursor) {
      try {
        const token = JSON.parse(Buffer.from(query.cursor, "base64url").toString("utf8"));
        if (token.format !== "capability-page/v1" || token.tier !== query.tier || !Number.isSafeInteger(token.offset) || token.offset < 1 || typeof token.revision !== "string") throw new Error();
        if (token.revision !== revision) throw new HttpError(409, "能力目录在分页期间变化，请重读第一页", "CAPABILITY_PAGE_CHANGED", { currentRevision: revision, nextAction: "read_first_page" });
        if (token.offset >= selected.length) throw new Error();
        offset = token.offset;
      } catch (error) {
        if (error instanceof HttpError) throw error;
        throw new HttpError(400, "能力目录游标无效或不属于当前tier", "INVALID_CAPABILITY_CURSOR");
      }
    }
    const capabilities = selected.slice(offset, offset + query.limit);
    const nextOffset = offset + capabilities.length;
    const hasMore = nextOffset < selected.length;
    return { schemaVersion: 1, revision, selectionPolicy: { ...CAPABILITY_SELECTION_POLICY }, capabilities, hasMore,
      ...(hasMore ? { nextCursor: Buffer.from(JSON.stringify({ format: "capability-page/v1", revision, tier: query.tier, offset: nextOffset })).toString("base64url") } : {}),
    };
  }
}
