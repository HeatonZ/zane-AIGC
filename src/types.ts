export type SceneId = "comic" | "commerce";

export type PageId = "home" | "history" | "assets" | "connections" | "studio" | "flows";

export interface SceneModule {
  id: SceneId;
  title: string;
  shortTitle: string;
  summary: string;
  description: string;
  cover: string;
  coverPosition?: string;
  accent: "green" | "coral";
  stages: string[];
}

export interface WorkflowDraft {
  id: string;
  sceneId: SceneId;
  title: string;
  summary: string;
  inputValues?: Record<string, string | number>;
  createdAt: string;
  status: "draft";
}

export type ConnectionStatus = "connected" | "not_configured" | "disconnected";

export interface ConnectorState {
  id: "hermes" | "comfyui";
  name: string;
  status: ConnectionStatus;
  message: string;
  checkedAt?: string;
}

export interface ConnectionSettings {
  enabledHermesProfiles: string[];
  comfyuiBaseUrl: string;
}

export interface HermesProfile {
  id: string;
  isDefault: boolean;
}

export type WorkflowFieldType = "text" | "textarea" | "number" | "select";
export type WorkflowStepKind = "hermes" | "comfyui_image" | "comfyui_video" | "manual";

export interface WorkflowInputField {
  key: string;
  label: string;
  type: WorkflowFieldType;
  required: boolean;
  placeholder?: string;
  options?: string[];
}

export interface WorkflowStepInput {
  key: string;
  label: string;
  sourceRef: string;
}

export interface WorkflowStepOutput {
  key: string;
  label: string;
  type: "text" | "image" | "video" | "json";
}

export interface WorkflowStepDefinition {
  id: string;
  name: string;
  kind: WorkflowStepKind;
  hermesProfile?: string;
  inputs: WorkflowStepInput[];
  outputs: WorkflowStepOutput[];
  promptTemplate: string;
}

export interface WorkflowOutputField {
  key: string;
  label: string;
  type: "text" | "image" | "video" | "json";
  sourceRef: string;
}

export interface WorkflowDefinition {
  sceneId: SceneId;
  name: string;
  inputs: WorkflowInputField[];
  steps: WorkflowStepDefinition[];
  outputs: WorkflowOutputField[];
}
