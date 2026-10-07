import * as z from "zod/v4";
const diffRevision = z.string().regex(/^[a-f0-9]{64}$/).describe("差异预览返回的revision；不是草稿revision或工作区数字revision。配置/发布/能力变化后409，重新读取第一页");
export const sceneDiffQuery = z.object({
  contentHash: z.string().regex(/^[a-f0-9]{8}$/).optional().describe("可选：界面草稿的contentHash；与服务端未一致时409，等待保存或重读，不以旧快照预览"),
  revision: diffRevision.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().min(1).max(4096).optional(),
  valueLimit: z.coerce.number().int().min(1).max(32768).default(4000).describe("每项每侧最多Unicode码点；complete:false明确表示未读完，使用get_scene_draft_diff_value分段续读"),
}).strict();
export const sceneDiffValueQuery = z.object({
  revision: diffRevision,
  changeId: z.string().regex(/^[a-f0-9]{24}$/),
  side: z.enum(["before", "after"]),
  offset: z.coerce.number().int().nonnegative().default(0),
  limit: z.coerce.number().int().min(1).max(32768).default(4000),
}).strict();
export type SceneDiffQuery = z.output<typeof sceneDiffQuery>;
export type SceneDiffValueQuery = z.output<typeof sceneDiffValueQuery>;

export const sceneDiffValueSchema = z.object({ present: z.boolean(), format: z.enum(["text", "json"]), text: z.string(), totalChars: z.int().nonnegative(), offset: z.int().nonnegative(), nextOffset: z.int().nonnegative().nullable(), complete: z.boolean() }).strict();
export const sceneDiffPageSchema = z.object({
  sceneId: z.string(), revision: diffRevision, draftRevision: z.string().regex(/^[a-f0-9]{64}$/), contentHash: z.string(),
  baseline: z.object({ versionId: z.string(), version: z.string(), publishedAt: z.string() }).strict().nullable(),
  comparisonBasis: z.literal("publication-ready").describe("草稿步骤按发布时相同本地能力配置规范化，与固定快照比较；不是完整发布校验，不能据此执行"),
  preparationWarnings: z.array(z.object({ stepId: z.string(), message: z.string() }).strict()),
  hasChanges: z.boolean(), summary: z.object({ added: z.int().nonnegative(), removed: z.int().nonnegative(), changed: z.int().nonnegative(), reordered: z.int().nonnegative() }).strict(), total: z.int().nonnegative(),
  valueBudgetChars: z.literal(65536).describe("单页值文本总码点预算；可能提前分页或分段，hasMore/complete明确返回，不静默截断"),
  changes: z.array(z.object({ changeId: z.string(), path: z.string().describe("按稳定对象ID/key定位的语义路径；不是数组下标JSON Patch"), section: z.enum(["scene", "workflow", "inputs", "steps", "outputs", "optionPresets"]), objectId: z.string().nullable(), objectLabel: z.string(), label: z.string(), kind: z.enum(["added", "removed", "changed", "reordered"]), before: sceneDiffValueSchema, after: sceneDiffValueSchema }).strict()),
  hasMore: z.boolean(), nextCursor: z.string().nullable(), nextAction: z.enum(["read_more_changes", "validate_scene_draft", "get_scene"]),
}).strict();
export const sceneDiffValuePageSchema = z.object({ sceneId: z.string(), revision: diffRevision, changeId: z.string(), side: z.enum(["before", "after"]), value: sceneDiffValueSchema, nextAction: z.enum(["read_more_value", "get_scene_draft_diff"]) }).strict();
