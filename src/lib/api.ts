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
    headers: { "Content-Type": "application/json", ...init?.headers },
  });

  if (!response.ok) {
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

export async function runWorkflow(workflow: WorkflowDefinition, inputValues: Record<string, JsonValue>, signal?: AbortSignal, runId?: string, resumeFromRunId?: string, runTitle?: string) {
  const submitted = await requestWithLegacyRoute<{ runId: string; status: "queued" } | WorkflowRunResult>("/api/v1/runs", "/api/workflows/run", {
    method: "POST",
    signal,
    body: JSON.stringify({ workflow, inputValues, ...(runId ? { runId } : {}), ...(resumeFromRunId ? { resumeFromRunId } : {}), ...(runTitle ? { runTitle } : {}) }),
  });
  // Old releases expose a synchronous endpoint whose response is already final.
  if (submitted.usedLegacyRoute) return submitted.value as WorkflowRunResult;
  const queued = submitted.value as { runId: string; status: "queued" };
  // Aborting this waiter does not cancel the durable server-side job.
  return new Promise<WorkflowRunResult>((resolve, reject) => {
    let stop = () => {};
    const abort = () => { stop(); reject(signal?.reason ?? new DOMException("等待运行结果已取消", "AbortError")); };
    const cleanup = () => { stop(); signal?.removeEventListener("abort", abort); };
    stop = subscribeWorkflowRun(queued.runId, (run) => {
      if (!["queued", "running", "cancelling"].includes(run.status)) { cleanup(); resolve(run); }
    }, (error, permanent) => { if (permanent) { cleanup(); reject(error); } });
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
  });
}

/** SSE reconnects by Last-Event-ID; old services fall back to low-frequency detail polling. */
export function subscribeWorkflowRun(runId: string, onRun: (run: WorkflowRunRecord) => void, onError?: (error: Error, permanent?: boolean) => void, options: { pendingSubmission?: boolean } = {}) {
  let disposed = false;
  let source: EventSource | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const controller = new AbortController();
  let attempts = 0;
  const stop = () => { disposed = true; controller.abort(); source?.close(); if (timer) clearTimeout(timer); };
  const retryLater = (delay: number) => {
    if (disposed || timer) return;
    timer = setTimeout(() => { timer = undefined; void connect(); }, delay);
  };
  const report = (run: WorkflowRunRecord) => {
    if (disposed) return;
    onRun(run);
    if (!["queued", "running", "cancelling"].includes(run.status)) stop();
  };
  async function connect() {
    try {
      const loaded = await requestWithLegacyRoute<WorkflowRunRecord>(`/api/v1/runs/${encodeURIComponent(runId)}`, legacyRunPath(runId), { signal: controller.signal });
      attempts = 0;
      report(loaded.value);
      if (disposed) return;
      if (loaded.usedLegacyRoute) {
        // Legacy releases have no SSE route; refresh this run's detail at low frequency.
        retryLater(10000);
        return;
      }
      source = new EventSource(`/api/v1/runs/${encodeURIComponent(runId)}/events`);
      source.onmessage = (message) => {
        if (disposed) return;
        try { const body = JSON.parse(message.data) as { run?: WorkflowRunRecord }; if (body.run) report(body.run); }
        catch { onError?.(new Error("运行进度事件格式无效")); }
      };
      source.onopen = () => { if (timer) { clearTimeout(timer); timer = undefined; } };
      source.onerror = () => {
        if (disposed) return;
        onError?.(new Error("运行进度连接中断，正在重连；后台任务不受影响"));
        // Low-frequency fallback for proxies without SSE; never rescan the run list.
        source?.close();
        retryLater(10000);
      };
    } catch (reason) {
      if (disposed) return;
      const error = reason instanceof Error ? reason : new Error("读取运行进度失败");
      const permanent = error instanceof ApiError && error.status >= 400 && error.status < 500
        && error.status !== 429 && !(error.status === 404 && options.pendingSubmission);
      if (permanent || ++attempts >= 60) { stop(); onError?.(error, true); }
      else { onError?.(error, false); retryLater(1000); }
    }
  }
  void connect();
  return stop;
}

export function loadWorkspace() {
  return request<{ workspace: WorkspaceSnapshot | null }>("/api/workspace");
}

export function initializeWorkspace(workspace: WorkspaceSnapshot) {
  return request<{ created: boolean; workspace: WorkspaceSnapshot }>("/api/workspace/initialize", {
    method: "POST",
    body: JSON.stringify(workspace),
  });
}

export function mergeWorkspace(base: WorkspaceSnapshot, workspace: WorkspaceSnapshot) {
  return request<{ workspace: WorkspaceSnapshot }>("/api/workspace/merge", {
    method: "POST",
    body: JSON.stringify({ base, workspace }),
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
