import type {
  ComfyUIWorkflowDetail,
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

export function runWorkflow(workflow: WorkflowDefinition, inputValues: Record<string, JsonValue>, signal?: AbortSignal) {
  return request<WorkflowRunResult>("/api/workflows/run", {
    method: "POST",
    signal,
    body: JSON.stringify({ workflow, inputValues }),
  });
}

export function loadWorkflowRuns() {
  return request<{ projectDirectory: string; runs: WorkflowRunHistoryItem[] }>("/api/workflows/runs");
}

export function loadWorkflowRun(runId: string) {
  return request<WorkflowRunRecord>(`/api/workflows/runs/${encodeURIComponent(runId)}`);
}
