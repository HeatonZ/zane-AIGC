import * as z from "zod/v4";
import type { AssetRecord, AssetReference, AssetVersion } from "./productionContracts.js";

export const assetKindSchema = z.enum(["image", "video", "audio"]);
export const assetCategorySchema = z.enum(["character", "scene", "prop", "voice", "material"]);
const assetId = z.string().min(1).max(200);
const revision = z.int().positive();
export const assetSourceSchema = z.object({ runId: z.string().regex(/^[a-f0-9-]{36}$/i), stepId: assetId.optional(), itemIndex: z.int().nonnegative().optional(), outputKey: assetId, mediaIndex: z.int().nonnegative().default(0) }).strict();
export const assetMetadataSchema = z.object({
  name: z.string().trim().min(1).max(160).optional(), category: assetCategorySchema.optional(),
  description: z.string().max(4000).optional().describe("素材内容、适用用途、限制等供人和AI检索的说明；不是生成提示词或自动授权"),
  group: z.string().trim().max(160).optional(), tags: z.array(z.string().trim().min(1).max(80)).max(30).optional(),
  createId: z.string().uuid().optional().describe("新建前生成并保存的UUID；响应丢失用get_asset查询这个ID，不换ID重投"),
  assetId: assetId.optional(), revision: revision.optional(),
}).strict();
const checkTarget = (value: { createId?: string; assetId?: string; revision?: number }, ctx: z.RefinementCtx) => {
  if (value.assetId ? value.createId !== undefined || value.revision === undefined : !value.createId || value.revision !== undefined)
    ctx.addIssue({ code: "custom", message: "新建必须提供createId且不带revision；新增版本必须提供assetId+revision且不带createId" });
};
export const saveAssetSchema = assetMetadataSchema.extend({ name: z.string().trim().min(1).max(160), source: assetSourceSchema }).superRefine(checkTarget);
export const uploadAssetSchema = assetMetadataSchema.extend({ kind: assetKindSchema }).superRefine(checkTarget);
export const updateAssetSchema = assetMetadataSchema.omit({ createId: true, assetId: true }).extend({ revision, archived: z.boolean().optional() }).strict();
export const assetPageSchema = z.object({ limit: z.int().min(1).max(100).default(24), cursor: z.string().min(1).max(2048).optional() }).strict();
export const assetQuerySchema = assetPageSchema.extend({ q: z.string().max(4000).default(""), kind: assetKindSchema.optional(), category: assetCategorySchema.optional(), group: z.string().max(160).optional(), tag: z.string().max(80).optional(), archived: z.boolean().default(false) }).strict();
export const assetVersionQuerySchema = z.object({ includeParameters: z.boolean().default(false), parametersOffset: z.int().nonnegative().default(0), parametersLimit: z.int().min(1).max(16000).default(8000) }).strict();
export type AssetSummary = Omit<AssetRecord, "versions" | "description"> & { description: string; versionCount: number; versionsOmitted: true };
export type AssetVersionSummary = Omit<AssetVersion, "parameters" | "filename"> & { parametersOmitted: boolean; reference: AssetReference };
export interface AssetPage { schemaVersion: 1; catalogRevision: string; assets: AssetSummary[]; total: number; hasMore: boolean; nextCursor?: string; nextAction: "get_asset" }
export interface AssetEnvelope { asset: AssetSummary; reference: AssetReference; nextAction: "save_reference_or_list_asset_versions" }
export interface AssetVersionPage { schemaVersion: 1; assetId: string; revision: number; versions: AssetVersionSummary[]; total: number; hasMore: boolean; nextCursor?: string; nextAction: "get_asset_version" }
export interface AssetVersionEnvelope { assetId: string; revision: number; version: AssetVersionSummary; parameters?: { encoding: "json"; totalChars: number; offset: number; text: string; hasMore: boolean; nextOffset?: number }; nextAction: "save_reference_or_read_parameters" }
