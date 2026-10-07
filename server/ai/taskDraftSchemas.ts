import * as z from "zod/v4";
import { values } from "./schemas.js";

/** An explicit target state, never a toggle; the revision is from the corresponding draft read. */
export const draftFavoriteRequest = z.object({
  revision: z.int().positive().describe("管理端用 get_task_draft 返回的工作区 revision；本人草稿用自身 revision。旧 revision 返回409，先读取原ID对账。"),
  isFavorite: z.boolean().describe("true收藏并置顶，false取消收藏；不改变草稿内容或最近保存时间。"),
}).strict();
export type DraftFavoriteRequest = z.output<typeof draftFavoriteRequest>;

export const taskDraftSchema = z.object({
  id: z.string(), revision: z.int().positive(), sceneId: z.string(), title: z.string(), runTitle: z.string().optional(),
  createdAt: z.string(), status: z.enum(["draft", "completed", "failed"]), isFavorite: z.boolean(),
  summary: z.string().optional(), inputValues: values.optional(), runId: z.string().optional(),
  summaryOmitted: z.boolean(), inputValuesOmitted: z.boolean(), runResultOmitted: z.boolean(),
}).strict();
export const taskDraftEnvelopeSchema = z.object({
  draft: taskDraftSchema, revision: z.int().positive(), nextAction: z.literal("get_task_draft"),
}).strict();
export const taskDraftPageSchema = z.object({
  items: z.array(taskDraftSchema), revision: z.string(), workspaceRevision: z.int().positive(), total: z.int().nonnegative(),
  hasMore: z.boolean(), nextCursor: z.string().optional(), nextAction: z.literal("get_task_draft"),
}).strict();
export type TaskDraftEnvelope = z.output<typeof taskDraftEnvelopeSchema>;

/** Full owned-draft reads/mutations (the metadata list explicitly omits inputValues). */
export const ownDraftEnvelopeSchema = z.object({
  draft: z.object({
    id: z.string().min(1), revision: z.int().positive(), userId: z.string().min(1), sceneId: z.string(), versionId: z.string(),
    title: z.string(), updatedAt: z.string(), isFavorite: z.boolean(), inputValues: values,
  }).strict(),
  nextAction: z.string().optional(),
}).strict();
