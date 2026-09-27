import type {
  ComfyUIWorkflowDetail,
  ComfyUIWorkflowSummary,
  ConnectionSettings,
  ConnectorState,
  HermesProfile,
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

export function loadComfyUIWorkflow(filename: string) {
  return request<ComfyUIWorkflowDetail>(`/api/comfyui/workflow?filename=${encodeURIComponent(filename)}`);
}
