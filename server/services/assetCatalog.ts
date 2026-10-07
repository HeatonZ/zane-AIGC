import type * as z from "zod/v4";
import { assetQuerySchema, assetPageSchema, assetVersionQuerySchema } from "../domain/assetLibraryContracts.js";
import type { AssetEnvelope, AssetPage, AssetSummary, AssetVersionSummary, AssetVersionPage, AssetVersionEnvelope } from "../domain/assetLibraryContracts.js";
import type { AssetRecord, AssetReference, AssetVersion } from "../domain/productionContracts.js";
import { contentRevision } from "../domain/sceneContent.js";
import { HttpError } from "../errors.js";

export function parseAssetInput<S extends z.ZodType>(schema: S, raw: unknown): z.output<S> {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw new HttpError(400, "素材参数无效：" + parsed.error.issues.map(issue => issue.path.join(".") + " " + issue.message).join("；"), "INVALID_ASSET_REQUEST");
  return parsed.data;
}
export function assetSummary(asset: AssetRecord): AssetSummary {
  const { versions, ...metadata } = asset;
  return { ...metadata, description: asset.description ?? "", versionCount: versions.length, versionsOmitted: true };
}
export function assetEnvelope(asset: AssetRecord, reference: AssetReference): AssetEnvelope { return { asset: assetSummary(asset), reference, nextAction: "save_reference_or_list_asset_versions" }; }
export function versionSummary(version: AssetVersion, reference: AssetReference): AssetVersionSummary {
  const { filename: _filename, parameters, ...metadata } = version;
  return { ...metadata, parametersOmitted: parameters !== undefined, reference };
}
function page<T>(items: T[], query: { limit: number; cursor?: string }, binding: string, revision: string) {
  let offset = 0;
  if (query.cursor) {
    try {
      const token = JSON.parse(Buffer.from(query.cursor, "base64url").toString("utf8"));
      if (token.format !== "asset-page/v1" || token.binding !== binding || typeof token.revision !== "string" || !Number.isSafeInteger(token.offset) || token.offset < 1) throw new Error();
      if (token.revision !== revision) throw new HttpError(409, "素材在分页期间已变化，请重新读取第一页", "ASSET_PAGE_CHANGED", { currentRevision: revision, nextAction: "read_first_page" });
      if (token.offset >= items.length) throw new Error();
      offset = token.offset;
    } catch (error) {
      if (error instanceof HttpError) throw error;
      throw new HttpError(400, "素材游标无效或不属于当前对象、筛选、身份", "INVALID_ASSET_CURSOR");
    }
  }
  const selected = items.slice(offset, offset + query.limit);
  const nextOffset = offset + selected.length;
  const hasMore = nextOffset < items.length;
  return { selected, total: items.length, hasMore, ...(hasMore ? { nextCursor: Buffer.from(JSON.stringify({ format: "asset-page/v1", binding, revision, offset: nextOffset })).toString("base64url") } : {}) };
}
export function assetCatalog(assets: AssetRecord[], raw: unknown, project: string, actorId: string): AssetPage {
  const { limit, cursor, ...filters } = parseAssetInput(assetQuerySchema, raw);
  const q = filters.q.toLocaleLowerCase();
  const selected = assets.filter(asset => (filters.archived || !asset.archivedAt) && (!filters.kind || asset.kind === filters.kind) && (!filters.category || asset.category === filters.category) && (filters.group === undefined || asset.group === filters.group) && (filters.tag === undefined || asset.tags.includes(filters.tag)) && (!q || [asset.name, asset.description ?? "", asset.group, ...asset.tags].join(" ").toLocaleLowerCase().includes(q)))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id));
  const catalogRevision = contentRevision(assets.map(asset => [asset.id, asset.revision]).sort((a, b) => String(a[0]).localeCompare(String(b[0]))));
  const { selected: result, ...pagination } = page(selected, { limit, cursor }, contentRevision({ project, actorId, filters, view: "catalog" }), catalogRevision);
  return { schemaVersion: 1, catalogRevision, assets: result.map(assetSummary), ...pagination, nextAction: "get_asset" };
}
export function assetVersions(asset: AssetRecord, raw: unknown, project: string, actorId: string, reference: (version: number) => AssetReference): AssetVersionPage {
  const query = parseAssetInput(assetPageSchema, raw);
  const { selected, ...pagination } = page([...asset.versions].sort((a, b) => b.version - a.version), query, contentRevision({ project, actorId, assetId: asset.id, view: "versions" }), String(asset.revision));
  return { schemaVersion: 1, assetId: asset.id, revision: asset.revision, versions: selected.map(version => versionSummary(version, reference(version.version))), ...pagination, nextAction: "get_asset_version" };
}
export function assetVersion(asset: AssetRecord, version: number, raw: unknown, reference: AssetReference): AssetVersionEnvelope {
  const query = parseAssetInput(assetVersionQuerySchema, raw);
  const item = asset.versions.find(item => item.version === version);
  if (!item) throw new HttpError(404, "素材版本不存在", "ASSET_VERSION_NOT_FOUND");
  const result: AssetVersionEnvelope = { assetId: asset.id, revision: asset.revision, version: versionSummary(item, reference), nextAction: "save_reference_or_read_parameters" };
  if (query.includeParameters) {
    const json = JSON.stringify(item.parameters ?? null);
    if (query.parametersOffset > json.length) throw new HttpError(400, "参数读取偏移超出范围", "INVALID_ASSET_REQUEST");
    const text = json.slice(query.parametersOffset, query.parametersOffset + query.parametersLimit);
    const nextOffset = query.parametersOffset + text.length;
    result.parameters = { encoding: "json", totalChars: json.length, offset: query.parametersOffset, text, hasMore: nextOffset < json.length, ...(nextOffset < json.length ? { nextOffset } : {}) };
    result.version.parametersOmitted = false;
  } else if (query.parametersOffset !== 0) throw new HttpError(400, "参数分段读取必须开启includeParameters", "INVALID_ASSET_REQUEST");
  return result;
}
