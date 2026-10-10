import { sceneDiffPageSchema, sceneDiffValuePageSchema } from "../../server/ai/sceneDiffSchemas";
import type { SceneDiffPage, SceneDiffValuePage } from "../../server/domain/sceneDiffContracts";
import { currentActorId } from "./accessApi";
import type {
  ComfyUIWorkflowDetail,
  ComfyAudioAttachment,
  ComfyImageAttachment,
  ComfyUINodeInfo,
  ComfyUIWorkflowSummary,
  ConnectionSettings,
  ConnectorState,
  HermesProfile,
  JsonValue,
  WorkflowDefinition,
  WorkflowRunHistoryItem,
  WorkflowRunRecord,
  WorkflowRunResult,
  WorkspaceSnapshot,
} from "../types";

import type { AssetSource, AssetKind, ClipSelection, ClipCandidate } from "../../server/domain/productionContracts";

import type { AssetPage, AssetEnvelope, AssetSummary, AssetVersionPage, AssetVersionEnvelope } from "../../server/domain/assetLibraryContracts";
import { readAssetPage, readAssetEnvelope, readAssetMutation, readAssetVersionPage, readAssetVersion } from "./assetLibraryResponse";
import { beginAssetWrite, clearAssetWrite } from "./assetWriteRecovery";
import { readAuthoritativeWorkspace, type WorkspaceClientStatus } from "./workspaceSync";

export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code?: string,
    public readonly routeUnavailable = false,
  ) { super(message); }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: { "Content-Type": "application/json", ...(currentActorId ? { "X-Zane-Actor": currentActorId } : {}), ...init?.headers },
  });

  if (!response.ok) {
    if (response.status === 401 && typeof window !== "undefined") window.dispatchEvent(new Event("zane-auth-required"));
    const contentType = response.headers.get("content-type") ?? "";
    let body: { error?: string; code?: string } | null = null;
    if (contentType.includes("application/json")) body = await response.json().catch(() => null) as { error?: string; code?: string } | null;
    else await response.text().catch(() => "");
    throw new ApiError(
      body?.error ?? `请求失败（${response.status}）`,
      response.status,
      body?.code,
      response.status === 404 && !contentType.includes("application/json"),
    );
  }

  return response.json() as Promise<T>;
}

async function requestWithLegacyRoute<T>(path: string, legacyPath: string, init?: RequestInit) {
  try {
    return { value: await request<T>(path, init), usedLegacyRoute: false };
  } catch (error) {
    // Old servers answer unknown /api/v1 routes with Express' HTML 404. Keep
    // JSON 404s intact because they mean the requested run is genuinely absent.
    if (!(error instanceof ApiError) || !error.routeUnavailable) throw error;
    return { value: await request<T>(legacyPath, init), usedLegacyRoute: true };
  }
}

function legacyRunPath(runId: string) {
  return `/api/workflows/runs/${encodeURIComponent(runId)}`;
}

export async function loadWorkflowCapabilities() {
  type Page = import("./capabilities").CapabilityCatalogPage;
  let cursor: string | undefined;
  let first: Page | undefined;
  const capabilities: Page["capabilities"] = [];
  const seenCursors = new Set<string>();
  const seenIds = new Set<string>();
  do {
    const query = new URLSearchParams({ limit: "100" });
    if (cursor) query.set("cursor", cursor);
    const page = await request<Page>("/api/v1/capabilities?" + query);
    if (first && page.revision !== first.revision) throw new ApiError("能力目录在分页期间变化，请重新加载", 409, "CAPABILITY_PAGE_CHANGED");
    first ??= page;
    for (const item of page.capabilities) {
      if (seenIds.has(item.id)) throw new ApiError("能力目录包含重复ID，未使用不完整目录", 502, "INVALID_CAPABILITY_PAGE");
      seenIds.add(item.id); capabilities.push(item);
    }
    if (!page.hasMore) return { ...first, capabilities, hasMore: false, nextCursor: undefined };
    if (!page.revision || !page.nextCursor || seenCursors.has(page.nextCursor)) throw new ApiError("能力目录分页回执无效，未使用不完整目录", 502, "INVALID_CAPABILITY_PAGE");
    cursor = page.nextCursor; seenCursors.add(cursor);
  } while (cursor);
  throw new ApiError("能力目录加载未完成", 502, "INVALID_CAPABILITY_PAGE");
}

async function requestRerun<T>(path: string, init: RequestInit): Promise<T> {
  try { return await request<T>(path, init); }
  catch (error) {
    if (error instanceof ApiError && error.routeUnavailable) {
      throw new ApiError("当前服务尚不支持局部重做，请构建并重启服务后再试；不会回退为整流程重跑", error.status, "RERUN_UNAVAILABLE", true);
    }
    throw error;
  }
}

export function previewWorkflowRerun(sourceRunId: string, changes: import("../../server/domain/rerunContracts.js").RerunRequest, signal?: AbortSignal) {
  return requestRerun<import("../../server/domain/rerunContracts.js").RerunPlan>("/api/v1/runs/" + encodeURIComponent(sourceRunId) + "/rerun/preview", { method: "POST", signal, body: JSON.stringify({ changes }) });
}
export function submitWorkflowRerun(sourceRunId: string, changes: import("../../server/domain/rerunContracts.js").RerunRequest, runId?: string, runTitle?: string) {
  return requestRerun<{ runId: string; status: "queued"; rerunPlan: import("../../server/domain/rerunContracts.js").RerunPlan }>("/api/v1/runs/" + encodeURIComponent(sourceRunId) + "/rerun", { method: "POST", body: JSON.stringify({ changes, ...(runId ? { runId } : {}), ...(runTitle ? { runTitle } : {}) }) });
}

export async function loadSceneDraftDiff(sceneId: string, query: { contentHash?: string; revision?: string; cursor?: string; limit?: number; valueLimit?: number } = {}, signal?: AbortSignal): Promise<SceneDiffPage> {
  const params = new URLSearchParams(Object.entries(query).filter(([, value]) => value !== undefined).map(([key, value]) => [key, String(value)]));
  try {
    const result = sceneDiffPageSchema.safeParse(await request<unknown>("/api/v1/scenes/" + encodeURIComponent(sceneId) + "/draft/diff?" + params, { signal }));
    if (!result.success || result.data.sceneId !== sceneId || (query.revision && result.data.revision !== query.revision) || (query.contentHash && result.data.contentHash !== query.contentHash)) throw new ApiError("差异预览回执无效，请重新读取", 502, "INVALID_SCENE_DIFF_RESPONSE");
    return result.data;
  } catch (error) {
    if (error instanceof ApiError && error.routeUnavailable) throw new ApiError("当前后台尚不支持差异预览，需要升级工作台后台；不会使用浏览器快照代替", error.status, "SCENE_DIFF_UNAVAILABLE", true);
    throw error;
  }
}
export async function loadSceneDraftDiffValue(sceneId: string, query: { revision: string; changeId: string; side: "before" | "after"; offset: number; limit?: number }, signal?: AbortSignal): Promise<SceneDiffValuePage> {
  const params = new URLSearchParams(Object.entries(query).filter(([, value]) => value !== undefined).map(([key, value]) => [key, String(value)]));
  const result = sceneDiffValuePageSchema.safeParse(await request<unknown>("/api/v1/scenes/" + encodeURIComponent(sceneId) + "/draft/diff/value?" + params, { signal }));
  if (!result.success || result.data.sceneId !== sceneId || result.data.revision !== query.revision || result.data.changeId !== query.changeId || result.data.side !== query.side || result.data.value.offset !== query.offset) throw new ApiError("差异值回执无效，未拼接不同快照的内容", 502, "INVALID_SCENE_DIFF_RESPONSE");
  return result.data;
}

export function loadConnectionSettings() {
  return request<ConnectionSettings>("/api/settings");
}

export function loadHermesProfiles() {
  return request<HermesProfile[]>("/api/hermes/profiles");
}

export function saveConnectionSettings(input: {
  enabledHermesProfiles: string[];
  comfyuiBaseUrl: string;
  projectDirectory: string;
  workflowTimeoutMinutes: number;
}) {
  return request<ConnectionSettings>("/api/settings", {
    method: "PUT",
    body: JSON.stringify(input),
  });
}

export function checkConnections(enabledHermesProfiles?: string[]) {
  return request<ConnectorState[]>("/api/integrations/check", {
    method: "POST",
    body: JSON.stringify({ enabledHermesProfiles }),
  });
}

export function loadComfyUIWorkflows() {
  return request<ComfyUIWorkflowSummary[]>("/api/comfyui/workflows");
}

export async function pickLocalMediaFile(type: "image" | "video") {
  const result = await request<{ path: string | null }>("/api/files/pick", {
    method: "POST",
    body: JSON.stringify({ type }),
  });
  return result.path;
}

export function loadComfyUIWorkflow(filename: string) {
  return request<ComfyUIWorkflowDetail>(`/api/comfyui/workflow?filename=${encodeURIComponent(filename)}`);
}

export function loadComfyUINodeInfo(nodeType: string) {
  return request<ComfyUINodeInfo>(`/api/comfyui/node-info?type=${encodeURIComponent(nodeType)}`);
}

export async function runWorkflow(workflow: WorkflowDefinition, inputValues: Record<string, JsonValue>, signal?: AbortSignal, runId?: string, resumeFromRunId?: string, runTitle?: string, onSubmitted?: () => void) {
  if (signal?.aborted) throw signal.reason ?? new DOMException("等待运行结果已取消", "AbortError");
  let submitted;
  try {
    submitted = await requestWithLegacyRoute<{ runId: string; status: "queued" } | WorkflowRunResult>("/api/v1/runs", "/api/workflows/run", {
      method: "POST", signal,
      body: JSON.stringify({ workflow, inputValues, ...(runId ? { runId } : {}), ...(resumeFromRunId ? { resumeFromRunId } : {}), ...(runTitle ? { runTitle } : {}) }),
    });
  } catch (error) {
    if (!runId || signal?.aborted || (error instanceof ApiError && error.status >= 400 && error.status < 500)) throw error;
    // The POST may have committed before its response was lost. Reconcile by ID, never POST again.
    return waitForWorkflowRun(runId, signal, { pendingSubmission: true, onFirstRun: onSubmitted });
  }
  onSubmitted?.();
  // Old releases expose a synchronous endpoint whose response is already final.
  if (submitted.usedLegacyRoute) return submitted.value as WorkflowRunResult;
  return waitForWorkflowRun(submitted.value.runId, signal);
}

export function waitForWorkflowRun(runId: string, signal?: AbortSignal, options: { pendingSubmission?: boolean; onFirstRun?: () => void } = {}) {
  if (signal?.aborted) return Promise.reject(signal.reason ?? new DOMException("等待运行结果已取消", "AbortError"));
  // Aborting this waiter does not cancel the durable server-side job.
  return new Promise<WorkflowRunResult>((resolve, reject) => {
    let stop = () => {}; let observed = false; let settled = false;
    const cleanup = () => { stop(); signal?.removeEventListener("abort", abort); };
    const fail = (error: unknown) => { if (settled) return; settled = true; cleanup(); reject(error); };
    const abort = () => fail(signal?.reason ?? new DOMException("等待运行结果已取消", "AbortError"));
    stop = subscribeWorkflowRun(runId, (run) => {
      if (!observed) { observed = true; try { options.onFirstRun?.(); } catch (error) { fail(error); return; } }
      if (!["queued", "running", "cancelling"].includes(run.status)) { settled = true; cleanup(); resolve(run); }
    }, (error, permanent) => {
      if (!permanent) return;
      fail(options.pendingSubmission && !observed
        ? new ApiError("提交结果暂时无法确认（运行 " + runId + "）。请先查看运行记录，不要重复提交生成。", error instanceof ApiError ? error.status : 503, "RUN_SUBMISSION_UNCONFIRMED")
        : error);
    }, { pendingSubmission: options.pendingSubmission });
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
  });
}

/** Reconnect using the durable SSE cursor; old services fall back to detail polling. */
export function subscribeWorkflowRun(runId: string, onRun: (run: WorkflowRunRecord) => void, onError?: (error: Error, permanent?: boolean) => void, options: { pendingSubmission?: boolean } = {}) {
  let disposed = false; let observed = false;
  let source: EventSource | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const controller = new AbortController();
  let attempts = 0; let lastSequence = 0;
  const stop = () => { disposed = true; controller.abort(); source?.close(); source = undefined; if (timer) clearTimeout(timer); timer = undefined; };
  const retryLater = (delay: number) => {
    if (disposed || timer) return;
    timer = setTimeout(() => { timer = undefined; void connect(); }, delay);
  };
  const report = (run: WorkflowRunRecord) => {
    if (disposed) return;
    observed = true; onRun(run);
    if (!["queued", "running", "cancelling"].includes(run.status)) stop();
  };
  async function connect() {
    if (disposed) return;
    try {
      const reader = new AbortController();
      const abortRead = () => reader.abort(controller.signal.reason);
      controller.signal.addEventListener("abort", abortRead, { once: true });
      const timeout = setTimeout(() => reader.abort(new Error("读取运行进度超时，正在重试；后台任务不受影响")), 15000);
      let loaded;
      try { loaded = await requestWithLegacyRoute<WorkflowRunRecord>(
        "/api/v1/runs/" + encodeURIComponent(runId), legacyRunPath(runId), { signal: reader.signal }); }
      finally { clearTimeout(timeout); controller.signal.removeEventListener("abort", abortRead); }
      if (disposed) return;
      attempts = 0; report(loaded.value);
      if (disposed) return;
      if (loaded.usedLegacyRoute) { retryLater(10000); return; }
      const stream = new EventSource("/api/v1/runs/" + encodeURIComponent(runId) + "/events" + (lastSequence ? "?after=" + lastSequence : ""));
      source = stream;
      stream.onmessage = message => {
        if (disposed || source !== stream) return;
        try {
          const body = JSON.parse(message.data) as { run?: WorkflowRunRecord };
          const sequence = Number(message.lastEventId);
          if (message.lastEventId && Number.isSafeInteger(sequence) && sequence >= 0) {
            if (sequence < lastSequence) return;
            lastSequence = sequence;
          }
          if (body.run) report(body.run);
        } catch { onError?.(new Error("运行进度事件格式无效"), false); }
      };
      stream.onopen = () => { if (disposed || source !== stream) return; if (timer) { clearTimeout(timer); timer = undefined; } };
      stream.onerror = () => {
        if (disposed || source !== stream) return;
        stream.close(); source = undefined;
        onError?.(new Error("运行进度连接中断，正在重连；后台任务不受影响"), false);
        // Low-frequency fallback for proxies without SSE; never rescan the run list.
        retryLater(10000);
      };
    } catch (reason) {
      if (disposed) return;
      const error = reason instanceof Error ? reason : new Error("读取运行进度失败");
      const permanent = error instanceof ApiError && error.status >= 400 && error.status < 500
        && error.status !== 429 && error.code !== "RUN_PREPARING"
        && !(error.status === 404 && options.pendingSubmission && !observed);
      attempts += 1;
      // A known durable job is not failed by a long outage; only unconfirmed submissions are bounded.
      if (permanent || (!observed && attempts >= 60)) { stop(); onError?.(error, true); }
      else { onError?.(error, false); retryLater(Math.min(10000, 1000 * 2 ** Math.min(attempts - 1, 4))); }
    }
  }
  void connect();
  return stop;
}

async function productionRequest<T>(path: string, init?: RequestInit): Promise<T> {
  try { return await request<T>(path,init); }
  catch (error) { if (error instanceof ApiError && error.routeUnavailable) throw new ApiError("当前后台尚未提供素材、确认或选片接口，请重启更新后的服务",error.status,"PRODUCTION_ROUTES_UNAVAILABLE",true); throw error; }
}

export function listClipSelections(runId?: string, signal?: AbortSignal) { return productionRequest<{ selections: ClipSelection[] }>("/api/v1/clip-selections" + (runId ? "?runId=" + encodeURIComponent(runId) : ""), { signal }); }
export function loadClipSelection(id: string, signal?: AbortSignal) { return productionRequest<{ selection: ClipSelection }>("/api/v1/clip-selections/" + id, { signal }); }
export function createClipSelection(body: { sourceRunId: string; stepId: string; outputKey: string; name: string }) { return productionRequest<{ selection: ClipSelection }>("/api/v1/clip-selections", { method: "POST", body: JSON.stringify(body) }); }
export function loadClipCandidates(id: string, signal?: AbortSignal) { return productionRequest<{ shots: Array<{ shotId: string; candidates: ClipCandidate[] }> }>("/api/v1/clip-selections/" + id + "/candidates", { signal }); }
export function updateClipSelection(id: string, body: { revision: number; shotId?: string; source?: AssetSource | null; shotOrder?: string[]; name?: string }) { return productionRequest<{ selection: ClipSelection }>("/api/v1/clip-selections/" + id, { method: "PATCH", body: JSON.stringify(body) }); }
export function composeClipSelection(id: string, revision: number) { return productionRequest<{ runId: string; status: string; selection: ClipSelection }>("/api/v1/clip-selections/" + id + "/compose", { method: "POST", body: JSON.stringify({ revision }) }); }

export function reviewWorkflowRun(runId: string, body: { reviewId: string; action: "approve" | "redo"; feedback?: string; outputs?: Record<string,JsonValue>; stepChanges?: Record<string, unknown> }) {
  return productionRequest<{ runId: string; status: string }>("/api/v1/runs/" + runId + "/review", { method: "POST", body: JSON.stringify(body) });
}

export function listAssets(query: { q?: string; kind?: string; category?: string; group?: string; tag?: string; archived?: boolean; limit?: number; cursor?: string } = {}, signal?: AbortSignal) {
  const params = new URLSearchParams(Object.entries(query).filter(([,value]) => value !== undefined && value !== "").map(([key,value]) => [key, String(value)]));
  return productionRequest<AssetPage>("/api/v1/assets?" + params, { signal, cache: "no-store" }).then(readAssetPage);
}
export function getAsset(id: string, signal?: AbortSignal) { return productionRequest<AssetEnvelope>("/api/v1/assets/" + encodeURIComponent(id), { signal, cache: "no-store" }).then(readAssetEnvelope); }
export function listAssetVersions(id: string, query: { limit?: number; cursor?: string } = {}, signal?: AbortSignal) {
  const params = new URLSearchParams(Object.entries(query).filter(([,value]) => value !== undefined).map(([key,value]) => [key, String(value)]));
  return productionRequest<AssetVersionPage>("/api/v1/assets/" + encodeURIComponent(id) + "/versions?" + params, { signal, cache: "no-store" }).then(readAssetVersionPage);
}
export function getAssetVersion(id: string, version: number, query: { includeParameters?: boolean; parametersOffset?: number; parametersLimit?: number } = {}, signal?: AbortSignal) {
  const params = new URLSearchParams(Object.entries(query).filter(([,value]) => value !== undefined).map(([key,value]) => [key, String(value)]));
  return productionRequest<AssetVersionEnvelope>("/api/v1/assets/" + encodeURIComponent(id) + "/versions/" + version + "?" + params, { signal, cache: "no-store" }).then(readAssetVersion);
}
async function trackedAssetWrite<T>(operation: "upload" | "save" | "update", target: { assetId?: string; createId?: string; revision?: number }, send: () => Promise<T>) {
  const id = target.assetId ?? target.createId;
  if (!id) throw new Error("请先保存素材createId，再发送新建请求。");
  const pending = beginAssetWrite(operation, id, target.createId, target.revision);
  try { const result = await send(); clearAssetWrite(pending); return result; }
  catch (error) {
    if (error instanceof ApiError && error.status >= 400 && error.status < 500) { clearAssetWrite(pending); throw error; }
    throw new Error((error as Error).message + "；素材回执未确认，已保留ID=" + id + "。到素材库读取对账，不要重复提交。");
  }
}
export function saveAsset(body: { source: AssetSource; name: string; category: string; description?: string; group?: string; tags?: string[]; createId?: string; assetId?: string; revision?: number }) { return trackedAssetWrite("save", body, () => productionRequest<AssetEnvelope>("/api/v1/assets", { method: "POST", body: JSON.stringify(body) }).then(readAssetEnvelope)); }
export function updateAsset(id: string, body: Record<string, unknown>) { return trackedAssetWrite("update", { assetId: id, revision: Number(body.revision) }, () => productionRequest<{ asset: AssetSummary; nextAction: string }>("/api/v1/assets/" + encodeURIComponent(id), { method: "PATCH", body: JSON.stringify(body) }).then(readAssetMutation)); }
export function uploadAsset(file: File, metadata: { name: string; kind: AssetKind; category: string; description?: string; group?: string; tags?: string[]; createId?: string; assetId?: string; revision?: number }) {
  const params = new URLSearchParams(Object.entries(metadata).filter(([,value]) => value !== undefined).map(([key,value]) => [key, Array.isArray(value) ? JSON.stringify(value) : String(value)]));
  return trackedAssetWrite("upload", metadata, () => productionRequest<AssetEnvelope>("/api/v1/assets/upload?" + params, { method: "POST", headers: { "Content-Type": "application/octet-stream", "X-File-Name": encodeURIComponent(file.name) }, body: file }).then(readAssetEnvelope));
}

export async function loadWorkspaceStatus(): Promise<WorkspaceClientStatus> {
  try {
    const status = await request<import("../../server/domain/workspaceContracts").WorkspaceStatus>("/api/workspace/status", { cache: "no-store" });
    return { ...status, readMode: "metadata" };
  } catch (error) {
    // Only a missing status route on an older server may use its existing authority
    // snapshot. Never mask outages, read a mirror or pretend a new API is deployed.
    if (!(error instanceof ApiError) || error.status !== 404) throw error;
    const response = await loadWorkspace();
    const workspace = response.workspace ? readAuthoritativeWorkspace(response.workspace) : null;
    return { authority: "sqlite", initialized: Boolean(workspace), workspaceRevision: workspace?.revision ?? null, catalogView: "draft", executionView: "published", readMode: "legacy-snapshot" };
  }
}

export function loadWorkspace() {
  return request<{ workspace: WorkspaceSnapshot | null }>("/api/workspace", { cache: "no-store" });
}

export function initializeWorkspace(workspace: WorkspaceSnapshot) {
  return request<{ created: boolean; workspace: WorkspaceSnapshot }>("/api/workspace/initialize", {
    method: "POST",
    body: JSON.stringify(workspace),
  });
}

export function mergeWorkspace(base: WorkspaceSnapshot, workspace: WorkspaceSnapshot, actorId?: string) {
  return request<{ workspace: WorkspaceSnapshot }>("/api/workspace/merge", {
    method: "POST",
    body: JSON.stringify({ base, workspace }),
    ...(actorId ? { headers: { "X-Zane-Actor": actorId } } : {}),
  });
}

export async function uploadComfyUIImage(file: File): Promise<ComfyImageAttachment> {
  const response = await fetch("/api/comfyui/upload-image", {
    method: "POST",
    headers: {
      "Content-Type": "application/octet-stream",
      "X-File-Name": encodeURIComponent(file.name),
      "X-File-Type": file.type || "application/octet-stream",
    },
    body: await file.arrayBuffer(),
  });
  const body = await response.json().catch(() => null) as (ComfyImageAttachment | { error?: string } | null);
  if (!response.ok || !body || !("filename" in body)) {
    throw new Error(body && "error" in body ? body.error ?? "上传图片失败" : `上传图片失败（${response.status}）`);
  }
  return body;
}

export async function uploadComfyUIAudio(file: File): Promise<ComfyAudioAttachment> {
  const response = await fetch("/api/comfyui/upload-audio", {
    method: "POST",
    headers: {
      "Content-Type": "application/octet-stream",
      "X-File-Name": encodeURIComponent(file.name),
      "X-File-Type": file.type || "application/octet-stream",
    },
    body: await file.arrayBuffer(),
  });
  const body = await response.json().catch(() => null) as (ComfyAudioAttachment | { error?: string } | null);
  if (!response.ok || !body || !("filename" in body)) {
    throw new Error(body && "error" in body ? body.error ?? "上传音频失败" : `上传音频失败（${response.status}）`);
  }
  return body;
}

export function loadWorkflowRuns(cursor?: string) {
  const query = `?limit=50${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
  return requestWithLegacyRoute<{ projectDirectory: string; runs: WorkflowRunHistoryItem[]; nextCursor?: string }>(`/api/v1/runs${query}`, `/api/workflows/runs${query}`).then(({ value }) => value);
}

export function loadWorkflowRun(runId: string) {
  return requestWithLegacyRoute<WorkflowRunRecord>(`/api/v1/runs/${encodeURIComponent(runId)}`, legacyRunPath(runId)).then(({ value }) => value);
}

export function cancelWorkflowRun(runId: string) {
  return requestWithLegacyRoute<{ runId: string; status: "cancelling" }>(`/api/v1/runs/${encodeURIComponent(runId)}/cancel`, `${legacyRunPath(runId)}/cancel`, {
    method: "POST",
  }).then(({ value }) => value);
}

export function loadTaskConcurrency() {
  return request<import("../types").TaskConcurrencySettings>("/api/v1/settings/task-concurrency");
}
export function saveTaskConcurrency(input: { revision: number; maxActiveRuns: number }) {
  // Never retry a configuration write. A lost receipt must be reconciled with GET first.
  return request<import("../types").TaskConcurrencySettings>("/api/v1/settings/task-concurrency", { method: "PATCH", body: JSON.stringify(input) });
}
