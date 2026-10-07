import { accessApi, AccessApiError, jsonBody } from "./accessApi";
import { systemFeedbackEnvelope, systemFeedbackPage } from "../../server/domain/systemFeedbackContracts";
import type * as z from "zod/v4";
export type FeedbackEnvelope = z.infer<typeof systemFeedbackEnvelope>;
export type FeedbackPage = z.infer<typeof systemFeedbackPage>;
export function feedbackPath(admin: boolean, id?: string) {
  return (admin ? "/api/v1/system-feedback" : "/api/v1/self/system-feedback") + (id ? "/" + encodeURIComponent(id) : "");
}
export async function readFeedback(userId: string, admin: boolean, id: string) {
  return decodeEnvelope(await accessApi(feedbackPath(admin, id), {}, userId), id);
}
export function decodeEnvelope(value: unknown, id: string): FeedbackEnvelope {
  const result = systemFeedbackEnvelope.safeParse(value);
  if (!result.success || result.data.feedback.id !== id) throw new AccessApiError("反馈回执无法核验；请读取原ID对账，不重复写入。", 0, "RESPONSE_UNKNOWN");
  return result.data;
}
export async function writeFeedback(userId: string, path: string, id: string, body: unknown) {
  return decodeEnvelope(await accessApi(path, jsonBody(body), userId), id);
}
export async function listFeedback(userId: string, admin: boolean, status: string, cursor?: string): Promise<FeedbackPage> {
  const query = new URLSearchParams({ limit: "30", ...(status ? { status } : {}), ...(cursor ? { cursor } : {}) });
  const result = systemFeedbackPage.safeParse(await accessApi(feedbackPath(admin) + "?" + query, {}, userId));
  if (!result.success) throw new AccessApiError("反馈列表无法读取，请重新刷新。", 0, "RESPONSE_UNKNOWN");
  return result.data;
}
