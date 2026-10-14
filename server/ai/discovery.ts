import type { AI_FOUNDATION_FEATURES } from "./features.js";
import type { AiOperation } from "./operations.js";
import * as z from "zod/v4";

/**
 * Discovery projections. `get_workbench` is read on every session and used to cost ~81KB,
 * because it re-sent every tool description and every feature essay even though MCP clients
 * already receive the same text from `tools/list` and `zane://openapi`. The summary projection
 * keeps the routing/effect/role facts and drops only prose, and it always says so explicitly
 * instead of silently returning a thinner object.
 */
export type CatalogueDetail = "summary" | "full";
export const catalogueDetailQuery = z.object({
  detail: z.enum(["summary", "full"]).default("summary").describe("目录详细度。summary（默认）返回路由、副作用与权限事实并明确标记省略的说明文本，用于降低每次发现成本；full 返回与契约版本完全一致的完整说明。两者都是只读发现，不发布、不执行。"),
}).strict();
export const CATALOGUE_SUMMARY_OMISSION = {
  descriptionsOmitted: true,
  omissionReason: "summary（默认）省略 features/operations 的说明文本以降低每次发现成本，只保留路由、副作用与权限事实；这不是字段缺失或空值。完整说明用 detail=full，或读 MCP tools/list、zane://openapi、list_capabilities。",
  fullDetail: "/api/v1/ai?detail=full",
} as const;

export interface CatalogueOperation {
  name: string; path: string; method: AiOperation["method"]; effect: AiOperation["effect"]; access: "authenticated" | "admin"; description?: string;
}
export interface CatalogueFeature { id: string; operations: readonly string[]; description?: string }

export function catalogueOperations(operations: readonly AiOperation[], detail: CatalogueDetail): CatalogueOperation[] {
  return operations.map(operation => ({
    name: operation.name, path: operation.path, method: operation.method,
    effect: operation.effect, access: operation.access ?? "admin",
    ...(detail === "full" ? { description: operation.description } : {}),
  }));
}
export function catalogueFeatures(features: typeof AI_FOUNDATION_FEATURES, detail: CatalogueDetail): CatalogueFeature[] {
  return features.map(feature => ({ id: feature.id, operations: feature.operations, ...(detail === "full" ? { description: feature.description } : {}) }));
}
