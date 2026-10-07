import * as z from "zod/v4";
import { runId } from "../ai/schemas.js";
import { accessPage } from "../ai/accessSchemas.js";

export const systemFeedbackStatus = z.enum(["pending", "processing", "resolved", "rejected"]);
export const systemFeedbackCategory = z.enum(["bug", "suggestion", "other"]);
export const createSystemFeedback = z.object({
  feedbackId: z.uuid(), title: z.string().trim().min(1).max(120),
  category: systemFeedbackCategory.default("bug"), description: z.string().trim().min(1).max(8000),
  runId: runId.optional(),
}).strict();
export const systemFeedbackKey = z.object({ feedbackId: runId }).strict();
export const systemFeedbackQuery = accessPage.extend({ status: systemFeedbackStatus.optional() }).strict();
export const handleSystemFeedback = systemFeedbackKey.extend({
  revision: z.int().positive(), status: systemFeedbackStatus,
  reply: z.string().trim().min(1).max(4000),
}).strict();
export const ownReviewRequest = z.object({ reviewId: z.string().min(1).max(200), action: z.enum(["approve", "redo"]) }).strict();

export const systemFeedbackSchema = z.object({
  id: z.uuid(), revision: z.int().positive(), userId: z.string(), submitterName: z.string(),
  title: z.string(), category: systemFeedbackCategory, description: z.string().max(8000), runId: runId.optional(),
  status: systemFeedbackStatus, reply: z.string().max(4000), handledBy: z.string().optional(),
  createdAt: z.string(), updatedAt: z.string(),
}).strict();
export type SystemFeedback = z.infer<typeof systemFeedbackSchema>;
export const systemFeedbackEnvelope = z.object({ feedback: systemFeedbackSchema, nextAction: z.enum(["get_own_system_feedback", "get_system_feedback", "handle_system_feedback"]) }).strict();
export const systemFeedbackPage = z.object({
  revision: z.string(), total: z.int().nonnegative(),
  items: z.array(systemFeedbackSchema.omit({ description: true, reply: true }).extend({ descriptionOmitted: z.literal(true), replyOmitted: z.literal(true) })),
  hasMore: z.boolean(), nextCursor: z.string().optional(), nextAction: z.enum(["get_own_system_feedback", "get_system_feedback"]),
}).strict();
