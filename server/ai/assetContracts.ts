const text = { type: "string" };
const integer = { type: "integer" };
const boolean = { type: "boolean" };
const ref = (name: string) => ({ $ref: "#/components/schemas/" + name });
const object = (required: string[], properties: Record<string, unknown>) => ({ type: "object", required, properties, additionalProperties: false });
const pagination = { total: integer, hasMore: boolean, nextCursor: { ...text, description: "hasMore时提供，绑定快照revision、筛选、对象及身份；不跨快照拼页" }, nextAction: text };
export const ASSET_RESPONSE_SCHEMAS = {
  AssetReference: object(["assetId", "assetVersion", "previewUrl", "assetName"], { assetId: text, assetVersion: { ...integer, minimum: 1 }, previewUrl: { ...text, description: "需鉴权的浏览器/HTTP媒体显示地址；执行时提供assetId+assetVersion，由后端解析并上传内部归档，不向ComfyUI转发工作台token" }, assetName: text }),
  AssetSummary: object(["id", "revision", "name", "description", "category", "kind", "group", "tags", "createdAt", "updatedAt", "currentVersion", "versionCount", "versionsOmitted"], { id: text, revision: { ...integer, minimum: 1 }, ownerUserId: text, name: text, description: { ...text, maxLength: 4000 }, category: { enum: ["character", "scene", "prop", "voice", "material"] }, kind: { enum: ["image", "video", "audio"] }, group: text, tags: { type: "array", items: text }, createdAt: text, updatedAt: text, archivedAt: text, currentVersion: integer, versionCount: integer, versionsOmitted: { const: true } }),
  AssetSource: object(["runId", "outputKey", "mediaIndex"], { runId: text, stepId: text, itemIndex: integer, outputKey: text, mediaIndex: integer }),
  AssetVersionSummary: object(["version", "createdAt", "sha256", "bytes", "originalName", "parametersOmitted", "reference"], { version: integer, createdAt: text, sha256: text, bytes: integer, originalName: text, source: ref("AssetSource"), parametersOmitted: boolean, reference: ref("AssetReference") }),
  AssetPage: object(["schemaVersion", "catalogRevision", "assets", "total", "hasMore", "nextAction"], { schemaVersion: { const: 1 }, catalogRevision: text, assets: { type: "array", items: ref("AssetSummary") }, ...pagination }),
  AssetEnvelope: object(["asset", "reference", "nextAction"], { asset: ref("AssetSummary"), reference: ref("AssetReference"), nextAction: { const: "save_reference_or_list_asset_versions" } }),
  AssetMutation: object(["asset", "nextAction"], { asset: ref("AssetSummary"), nextAction: { const: "get_asset" } }),
  AssetVersionPage: object(["schemaVersion", "assetId", "revision", "versions", "total", "hasMore", "nextAction"], { schemaVersion: { const: 1 }, assetId: text, revision: integer, versions: { type: "array", items: ref("AssetVersionSummary") }, ...pagination }),
  AssetParameterChunk: object(["encoding", "totalChars", "offset", "text", "hasMore"], { encoding: { const: "json" }, totalChars: integer, offset: integer, text: { ...text, maxLength: 16000 }, hasMore: boolean, nextOffset: integer }),
  AssetVersionEnvelope: object(["assetId", "revision", "version", "nextAction"], { assetId: text, revision: integer, version: ref("AssetVersionSummary"), parameters: ref("AssetParameterChunk"), nextAction: { const: "save_reference_or_read_parameters" } }),
};
export const ASSET_OUTPUT_TYPES: Record<string, string> = { list_assets: "AssetPage", get_asset: "AssetEnvelope", save_asset: "AssetEnvelope", upload_asset: "AssetEnvelope", update_asset: "AssetMutation", list_asset_versions: "AssetVersionPage", get_asset_version: "AssetVersionEnvelope" };
