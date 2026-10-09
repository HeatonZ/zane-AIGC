export class AccessApiError extends Error { constructor(message: string, public status: number, public code = "", public requestId?: string, public retryAfterSeconds?: number) { super(message); } }
export let currentActorId = "";
export function setCurrentActor(id: string) { currentActorId = id; }

export async function accessApi<T>(path: string, options: RequestInit = {}, actorId = currentActorId): Promise<T> {
  const headers = new Headers(options.headers);
  if (options.body && !(options.body instanceof File) && !(options.body instanceof Blob)) headers.set("Content-Type", "application/json");
  if (actorId) headers.set("X-Zane-Actor", actorId);
  let response: Response;
  try { response = await fetch(path,{ ...options,headers,credentials:"same-origin" }); } catch { throw new AccessApiError("请求回执未取得。写入可能已完成，请按原ID读取对账，不要重复提交。",0,"RESPONSE_UNKNOWN"); }
  const data = await response.json().catch(() => undefined);
  if (!response.ok) { if (response.status === 401) window.dispatchEvent(new Event("zane-auth-required")); const retry = Number(response.headers.get("Retry-After")); const requestId = response.headers.get("X-Request-ID") ?? data?.requestId; const message = (data?.error ?? `请求失败 ${response.status}`) + (response.status === 429 && retry > 0 && Number.isFinite(retry) ? `（请在${Math.ceil(retry)}秒后重试）` : "") + (response.status >= 500 && requestId ? `（请求ID：${requestId}）` : ""); throw new AccessApiError(message,response.status,data?.code,requestId,retry > 0 && Number.isFinite(retry) ? retry : undefined); }
  if (data === undefined) throw new AccessApiError("成功响应无法读取。写入可能已完成，请按原ID对账，不要重复提交。",0,"RESPONSE_UNKNOWN");
  return data as T;
}
export async function accessMedia(path: string, actorId = currentActorId, signal?: AbortSignal): Promise<Blob> {
  const headers = new Headers();
  if (actorId) headers.set("X-Zane-Actor", actorId);
  let response: Response;
  try { response = await fetch(path, { headers, credentials: "same-origin", signal }); }
  catch (error) {
    if (signal?.aborted) throw error;
    throw new AccessApiError("图片读取请求未能连接到工作台", 0, "MEDIA_REQUEST_FAILED");
  }
  if (!response.ok) {
    if (response.status === 401) window.dispatchEvent(new Event("zane-auth-required"));
    const contentType = response.headers.get("content-type") ?? "";
    const data = contentType.includes("application/json")
      ? await response.json().catch(() => undefined) as { error?: string; code?: string; requestId?: string } | undefined
      : undefined;
    throw new AccessApiError(data?.error ?? `图片读取失败（${response.status}）`, response.status, data?.code, response.headers.get("X-Request-ID") ?? data?.requestId);
  }
  return response.blob();
}
export const jsonBody = (value: unknown): RequestInit => ({method:"POST",body:JSON.stringify(value)});
export interface AccessPage<T> { items:T[]; total?:number; hasMore:boolean; nextCursor?:string; revision?:string }
export type OwnAssetPage = import("../../server/domain/assetLibraryContracts").OwnAssetPage;
export function listOwnAssets(query: { limit?: number; cursor?: string; q?: string; kind?: import("../../server/domain/productionContracts").AssetKind }, actorId = currentActorId, signal?: AbortSignal) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) if (value !== undefined) params.set(key, String(value));
  return accessApi<OwnAssetPage>("/api/v1/self/assets?" + params.toString(), { signal }, actorId);
}
export type Account = import("../../server/services/accessService").UserAccount;
export interface AvailableScene { sceneId:string; title:string; summary:string; versionId:string; version:string }
export interface UserScene extends AvailableScene { description:string; fields:Array<{key:string;label:string;type:import("../types").WorkflowFieldType;required:boolean;hidden:boolean;minimum?:number;maximum?:number;placeholder?:string;options?:string[];inputMode?:"object_array";itemFields?:import("../types").WorkflowObjectArrayItemField[]}>; inputDefaults:Record<string,unknown>; notices:string[] }
export type OwnRun = import("../../server/services/runDetailService").BusinessRun;
export interface OwnDraft { id:string;revision:number;sceneId:string;versionId:string;title:string;runTitle?:string;inputValues:Record<string,unknown>;updatedAt:string;isFavorite:boolean }
