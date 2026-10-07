import { accessApi, AccessApiError } from "./accessApi";
import { taskDraftEnvelopeSchema, ownDraftEnvelopeSchema, type DraftFavoriteRequest } from "../../server/ai/taskDraftSchemas";

async function envelope(path: string, options: RequestInit, actorId: string) {
  const value = await accessApi<unknown>(path, options, actorId);
  const parsed = taskDraftEnvelopeSchema.safeParse(value);
  if (!parsed.success) throw new AccessApiError("草稿回执格式无法确认，请按原ID读取对账。", 0, "RESPONSE_UNKNOWN");
  return parsed.data;
}
export function getTaskDraft(id: string, actorId: string) {
  return envelope("/api/v1/task-drafts/" + encodeURIComponent(id), { cache: "no-store" }, actorId);
}
async function ownEnvelope(path: string, options: RequestInit, actorId: string) {
  const value = await accessApi<unknown>(path, options, actorId);
  const parsed = ownDraftEnvelopeSchema.safeParse(value);
  if (!parsed.success) throw new AccessApiError("本人草稿回执格式无法确认，请按原ID读取对账。", 0, "RESPONSE_UNKNOWN");
  return parsed.data;
}
export function getOwnDraft(id: string, actorId: string) {
  return ownEnvelope("/api/v1/self/drafts/" + encodeURIComponent(id), { cache: "no-store" }, actorId);
}
export function setOwnDraftFavorite(id: string, input: DraftFavoriteRequest, actorId: string) {
  return ownEnvelope("/api/v1/self/drafts/" + encodeURIComponent(id) + "/favorite", { method: "PATCH", body: JSON.stringify(input) }, actorId);
}
export function setTaskDraftFavorite(id: string, input: DraftFavoriteRequest, actorId: string) {
  return envelope("/api/v1/task-drafts/" + encodeURIComponent(id) + "/favorite", { method: "PATCH", body: JSON.stringify(input) }, actorId);
}
