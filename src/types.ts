export type SceneId = "comic" | "commerce" | "text_to_image";

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
  inputValues?: Record<string, JsonValue>;
  createdAt: string;
  status: "draft" | "completed" | "failed";
  runResult?: WorkflowRunResult;
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

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

export type WorkflowFieldType = "text" | "textarea" | "number" | "boolean" | "select" | "image" | "video" | "json";
export type WorkflowStepKind = "hermes" | "comfyui" | "manual" | "control";
export type WorkflowVariableType = Exclude<WorkflowFieldType, "textarea" | "select">;

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
}

export interface WorkflowStepInput {
  key: string;
  label: string;
  sourceRef: string;
}

export interface WorkflowStepOutput {
  key: string;
  label: string;
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
  sourceRef?: string;
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

export interface WorkflowDefinition {
  sceneId: SceneId;
  name: string;
  inputs: WorkflowInputField[];
  steps: WorkflowStepDefinition[];
  outputs: WorkflowOutputField[];
}

export interface WorkflowRunStepResult {
  stepId: string;
  name: string;
  status: "completed" | "skipped" | "failed";
  message?: string;
  outputs?: Record<string, JsonValue>;
}

export interface WorkflowRunOutput {
  key: string;
  label: string;
  type: WorkflowVariableType;
  value: JsonValue;
}

export interface WorkflowRunResult {
  runId: string;
  status: "completed" | "failed";
  steps: WorkflowRunStepResult[];
  outputs: WorkflowRunOutput[];
  error?: string;
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

export interface ComfyUIWorkflowDetail {
  filename: string;
  format: "ui" | "api" | "unknown";
  nodes: ComfyUIWorkflowNode[];
}
