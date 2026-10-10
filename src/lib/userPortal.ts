import { AccessApiError } from "./accessApi";

export interface ResultOutput {
  key: string;
  label: string;
  type: string;
  source?: { runId: string; stepId?: string; itemIndex?: number; outputKey: string };
  value?: unknown;
  valueOmitted?: boolean;
  omissionReason?: string;
  mediaReferences?: Array<{ url: string; source?: { mediaIndex: number } }>;
  valuePage: { hasMore: boolean; nextValueOffset?: number; offset?: number; total?: number; count?: number; pageSize?: number; kind?: string; complete?: boolean };
  valueBytes?: number;
}
export interface ResultPage {
  warnings?: string[];
  outputs?: ResultOutput[];
  items?: Array<{ index: number; status: string; startedAt?: string; durationMs?: number; error?: string; warnings?: string[]; outputs: ResultOutput[] }>;
  itemCount?: number;
  hasMore: boolean;
  revision?: string;
  total?: number;
  nextCursor?: string;
}
export interface ResultContext {
  stepId?: string;
  itemIndex?: number;
  outputKey?: string;
  valueOffset?: number;
  valueLimit?: number;
  textOffset?: number;
  textLimit?: number;
  maxValueBytes?: number;
}

// A definite rejection may release the ID. Transport/5xx errors and duplicate/preparing
// responses must retain it until the accepted task is reconciled.
export function isDefiniteRunRejection(error: unknown): boolean {
  return error instanceof AccessApiError && error.status >= 400 && error.status < 500
    && !["RUN_ALREADY_EXISTS", "RUN_PREPARING"].includes(error.code);
}
export function uploadedInput(current: unknown, type: string, reference: unknown): unknown {
  return /\[\]|_list|images|videos|audios/.test(type)
    ? [...(Array.isArray(current) ? current : []), reference] : reference;
}
export type UploadedMediaKind = "image" | "video" | "audio";
/** Field type decides the asset kind; list fields and single fields follow the same rule. */
export function mediaKindByType(type: string): UploadedMediaKind {
  return /audio/.test(type) ? "audio" : /video/.test(type) ? "video" : "image";
}
export function mediaKindLabel(kind: UploadedMediaKind): string {
  return kind === "image" ? "图片" : kind === "video" ? "视频" : "音频";
}
export function uploadedBatchNotice(uploaded: number, label: string): string {
  return uploaded > 1 ? `已上传 ${uploaded} 个${label}并添加到任务输入` : "媒体已上传并添加到任务输入";
}
/** A batch keeps every unconfirmed file visible instead of collapsing failures into one line. */
export function uploadFailureMessage(failures: string[], label: string): string {
  if (!failures.length) return "";
  return failures.length === 1 ? failures[0] : `有 ${failures.length} 个${label}上传失败：${failures.join("；")}`;
}
export function resultPath(runId: string, context: ResultContext, cursor?: string): string {
  const query = new URLSearchParams({ valueOffset: String(context.valueOffset ?? 0) });
  if (context.valueLimit) query.set("valueLimit", String(context.valueLimit));
  query.set("textLimit", String(context.textLimit ?? 8000));
  query.set("textOffset", String(context.textOffset ?? 0));
  if (context.maxValueBytes) query.set("maxValueBytes", String(context.maxValueBytes));
  if (context.outputKey) query.set("outputKey", context.outputKey);
  if (context.itemIndex !== undefined) query.set("itemIndex", String(context.itemIndex));
  if (cursor) query.set("cursor", cursor);
  return "/api/v1/self/runs/" + encodeURIComponent(runId)
    + (context.stepId ? "/steps/" + encodeURIComponent(context.stepId) : "/outputs") + "?" + query;
}
export function mergeResultPage(previous: ResultPage | undefined, next: ResultPage, context: ResultContext, cursor?: string): ResultPage {
  if (!cursor || !previous) return next;
  // Step pagination is over foreach items, not aggregate outputs. Do not duplicate
  // the aggregate fields when loading the next item page.
  return context.stepId
    ? { ...next, outputs: previous.outputs, items: [...(previous.items ?? []), ...(next.items ?? [])] }
    : { ...next, outputs: [...(previous.outputs ?? []), ...(next.outputs ?? [])] };
}
