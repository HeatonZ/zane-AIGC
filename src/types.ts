export type SceneId = string;

export type PageId = "home" | "history" | "runs" | "assets" | "connections" | "studio" | "flows";

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
  runTitle?: string;
  summary: string;
  inputValues?: Record<string, JsonValue>;
  createdAt: string;
  status: "draft" | "completed" | "failed";
  runResult?: WorkflowRunResult;
}

export interface WorkspaceSnapshot {
  format: "zane-studio.workspace/v1";
  scenes: SceneModule[];
  workflows: Record<SceneId, WorkflowDefinition>;
  optionPresets: WorkflowOptionPreset[];
  drafts: WorkflowDraft[];
  sceneVersions: Record<SceneId, SceneVersionRecord>;
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
  projectDirectory: string;
  workflowTimeoutMinutes: number;
}

export type SceneDetails = Omit<SceneModule, "id">;

export interface HermesProfile {
  id: string;
  isDefault: boolean;
}

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

export interface ComfyImageAttachment {
  id: string;
  filename: string;
  subfolder: string;
  type: "input";
  url: string;
}

export interface ComfyAudioAttachment {
  id: string;
  filename: string;
  subfolder: string;
  type: "input";
  url: string;
}

export type WorkflowFieldType = "text" | "textarea" | "number" | "boolean" | "select" | "image" | "image_list" | "audio" | "video" | "json";
export type WorkflowStepKind = "hermes" | "comfyui" | "manual" | "control";
export type WorkflowVariableType = Exclude<WorkflowFieldType, "textarea" | "select" | "audio">;
export type WorkflowValueSource = "literal" | "reference";

export type WorkflowConditionOperator =
  | "equals"
  | "not_equals"
  | "greater_than"
  | "greater_or_equal"
  | "less_than"
  | "less_or_equal"
  | "contains"
  | "not_contains"
  | "is_empty"
  | "is_not_empty";

export interface WorkflowConditionRule {
  id: string;
  leftRef: string;
  operator: WorkflowConditionOperator;
  valueSource: "literal" | "reference";
  rightValue: string;
  rightRef: string;
}

export interface WorkflowControlConfig {
  type: "condition";
  match: "all" | "any";
  rules: WorkflowConditionRule[];
}

export interface WorkflowRunCondition {
  conditionStepId: string;
  expectedResult: boolean;
}

export interface WorkflowInputField {
  key: string;
  label: string;
  type: WorkflowFieldType;
  required: boolean;
  placeholder?: string;
  options?: string[];
  optionPresetId?: string;
}

export interface WorkflowOptionPreset {
  id: string;
  name: string;
  options: string[];
}

export interface SceneVersion {
  id: string;
  version: string;
  publishedAt: string;
  scene: SceneModule;
  workflow: WorkflowDefinition;
  optionPresets: WorkflowOptionPreset[];
}

export interface SceneVersionRecord {
  publishedVersionId: string | null;
  versions: SceneVersion[];
}

export interface WorkflowStepInput {
  key: string;
  label: string;
  sourceRef: string;
  valueSource?: WorkflowValueSource;
  literalValue?: string;
  literalType?: WorkflowVariableType;
}

export interface WorkflowStepOutput {
  key: string;
  label: string;
  description?: string;
  type: WorkflowVariableType;
}

export interface WorkflowStepDefinition {
  id: string;
  name: string;
  kind: WorkflowStepKind;
  hermesProfile?: string;
  inputs: WorkflowStepInput[];
  outputs: WorkflowStepOutput[];
  promptTemplate: string;
  execution?: WorkflowExecutionConfig;
  comfyui?: ComfyUIWorkflowConfig;
  control?: WorkflowControlConfig;
  runCondition?: WorkflowRunCondition;
}

export interface ComfyUIBinding {
  key: string;
  label: string;
  direction: "input" | "output";
  nodeId: string;
  property: string;
  type: WorkflowVariableType;
  options?: string[];
  required?: boolean;
  sourceRef?: string;
  valueSource?: WorkflowValueSource;
  literalValue?: string;
  sourceInputFormat?: {
    type: WorkflowFieldType;
    required: boolean;
    options?: string[];
    optionPresetId?: string;
  };
  sourceOutputFormat?: {
    stepId: string;
    outputKey: string;
    type: WorkflowVariableType;
  };
}

export interface ComfyUIWorkflowConfig {
  workflowFile: string;
  bindings: ComfyUIBinding[];
}

export interface WorkflowOutputField {
  key: string;
  label: string;
  type: WorkflowVariableType;
  sourceRef: string;
}

export type WorkflowExecutionMode = "once" | "for_each";
export type WorkflowIterationErrorPolicy = "continue" | "stop";

export interface WorkflowExecutionConfig {
  mode: WorkflowExecutionMode;
  sourceRef?: string;
  onError?: WorkflowIterationErrorPolicy;
}

export interface WorkflowDefinition {
  sceneId: SceneId;
  name: string;
  inputs: WorkflowInputField[];
  steps: WorkflowStepDefinition[];
  outputs: WorkflowOutputField[];
  execution?: WorkflowExecutionConfig;
}

export interface WorkflowRunStepResult {
  stepId: string;
  name: string;
  status: "running" | "completed" | "skipped" | "failed" | "cancelled";
  message?: string;
  inputs?: Record<string, JsonValue>;
  inputLabels?: Record<string, string>;
  outputs?: Record<string, JsonValue>;
  outputLabels?: Record<string, string>;
  outputTypes?: Record<string, string>;
  items?: WorkflowRunStepItemResult[];
}

export interface WorkflowRunStepItemResult {
  index: number;
  value: JsonValue;
  status: "running" | "completed" | "skipped" | "failed" | "cancelled";
  inputs?: Record<string, JsonValue>;
  outputs?: Record<string, JsonValue>;
  error?: string;
}

export interface WorkflowRunOutput {
  key: string;
  label: string;
  type: WorkflowVariableType;
  value: JsonValue;
}

export type WorkflowRunItemStatus = "running" | "completed" | "failed" | "cancelled";

export interface WorkflowRunItemResult {
  index: number;
  value: JsonValue;
  status: WorkflowRunItemStatus;
  steps: WorkflowRunStepResult[];
  outputs: WorkflowRunOutput[];
  error?: string;
}

export interface WorkflowRunResult {
  runId: string;
  status: "running" | "completed" | "failed" | "cancelled";
  steps: WorkflowRunStepResult[];
  outputs: WorkflowRunOutput[];
  items?: WorkflowRunItemResult[];
  error?: string;
  cancellationReason?: string;
  startedAt?: string;
  finishedAt?: string;
  durationMs?: number;
  archiveWarnings?: string[];
  resumedFromRunId?: string;
  artifacts?: WorkflowRunArtifacts;
}

export interface WorkflowRunArtifacts {
  directory: string;
  inputs: string;
  workflow: string;
  runtime: string;
  output: string;
}

export interface WorkflowRunHistoryItem {
  runId: string;
  sceneId: SceneId;
  workflowName: string;
  runTitle?: string;
  status: WorkflowRunResult["status"];
  startedAt: string;
  finishedAt?: string;
  durationMs?: number;
  stepCount: number;
  outputCount: number;
  error?: string;
  artifacts: WorkflowRunArtifacts;
}

export interface WorkflowRunRecord extends WorkflowRunResult {
  sceneId: SceneId;
  workflowName: string;
  runTitle?: string;
  inputValues: Record<string, JsonValue>;
  workflow?: WorkflowDefinition;
}

export interface ComfyUIWorkflowSummary {
  filename: string;
  size?: number;
  modified?: number;
}

export interface ComfyUIWorkflowNode {
  id: string;
  type: string;
  inputProperties: string[];
  outputProperties: string[];
}

export interface ComfyUIPropertyInfo {
  name: string;
  type: WorkflowVariableType;
  options?: string[];
  required?: boolean;
}

export interface ComfyUINodeInfo {
  type: string;
  inputs: ComfyUIPropertyInfo[];
  outputs: ComfyUIPropertyInfo[];
}

export interface ComfyUIWorkflowDetail {
  filename: string;
  format: "ui" | "api" | "unknown";
  converted?: boolean;
  nodes: ComfyUIWorkflowNode[];
}
