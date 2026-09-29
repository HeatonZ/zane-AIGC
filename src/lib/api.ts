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

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: { "Content-Type": "application/json", ...init?.headers },
  });

  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? `请求失败（${response.status}）`);
  }

  return response.json() as Promise<T>;
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

export function runWorkflow(workflow: WorkflowDefinition, inputValues: Record<string, JsonValue>, signal?: AbortSignal, runId?: string, resumeFromRunId?: string, runTitle?: string) {
  return request<WorkflowRunResult>("/api/workflows/run", {
    method: "POST",
    signal,
    body: JSON.stringify({ workflow, inputValues, ...(runId ? { runId } : {}), ...(resumeFromRunId ? { resumeFromRunId } : {}), ...(runTitle ? { runTitle } : {}) }),
  });
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

export function loadWorkflowRuns() {
  return request<{ projectDirectory: string; runs: WorkflowRunHistoryItem[] }>("/api/workflows/runs");
}

export function loadWorkflowRun(runId: string) {
  return request<WorkflowRunRecord>(`/api/workflows/runs/${encodeURIComponent(runId)}`);
}

export function cancelWorkflowRun(runId: string) {
  return request<{ runId: string; status: "cancelling" }>(`/api/workflows/runs/${encodeURIComponent(runId)}/cancel`, {
    method: "POST",
  });
}
