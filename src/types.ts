import type { WorkflowMediaRole } from "../server/domain/workflowMediaRoles.js";
export type { WorkflowMediaRole };

export type SceneId = string;

export type PageId = "home" | "history" | "runs" | "assets" | "connections" | "studio" | "flows" | "users" | "feedback";

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
  isFavorite?: boolean;
  status: "draft" | "completed" | "failed";
  runResult?: WorkflowRunResult;
}

export interface WorkspaceSnapshot {
  revision?: number;
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

/**
 * Runtime media contract: image and video values are tagged collections whose
 * `items` array is always flat. The legacy `image`/`video` type names remain
 * in workflow definitions for compatibility; they describe the item kind,
 * not a scalar runtime value.
 */
export type WorkflowMediaKind = "image" | "video" | "audio";
export type WorkflowMediaLocator =
  | { type: "path"; value: string }
  | { type: "url"; value: string }
  | { type: "comfy"; filename: string; subfolder: string; location: "input" | "output" };

export interface WorkflowMediaItem {
  id: string;
  kind: WorkflowMediaKind;
  locator: WorkflowMediaLocator;
  filename?: string;
  mimeType?: string;
}

export interface WorkflowMediaValue {
  kind: "media";
  __zaneRuntime: "media";
  mediaKind: WorkflowMediaKind;
  items: WorkflowMediaItem[];
}

export type WorkflowMediaSelection =
  | { mode: "all" }
  | { mode: "item"; index: number }
  | { mode: "for_each" };

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

export type WorkflowMediaListType = "image_list" | "video_list" | "audio_list";
export type WorkflowLegacyMediaType = "image" | "video" | "audio";
export type WorkflowFieldType = "text" | "textarea" | "number" | "boolean" | "select" | WorkflowMediaListType | WorkflowLegacyMediaType | "json";
export interface WorkflowObjectArrayItemField {
  key: string;
  label: string;
  type: "text" | "number" | "boolean" | "select";
  required: boolean;
  minimum?: number;
  maximum?: number;
  placeholder?: string;
  options?: string[];
}
export type WorkflowStepKind = "hermes" | "comfyui" | "manual" | "control" | "capability";
export type WorkflowVariableType = Exclude<WorkflowFieldType, "textarea" | "select">;
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
  mediaRole?: WorkflowMediaRole;
  key: string;
  label: string;
  type: WorkflowFieldType;
  required: boolean;
  minimum?: number;
  maximum?: number;
  /** Hides the field from scene input forms while retaining it in the input contract and workflow. */
  hidden?: boolean;
  placeholder?: string;
  options?: string[];
  optionPresetId?: string;
  defaultValue?: JsonValue;
  /** Renders a json array as a repeatable row form and validates every row against itemFields. */
  inputMode?: "object_array";
  itemFields?: WorkflowObjectArrayItemField[];
}

export interface WorkflowOptionPreset {
  id: string;
  name: string;
  options: string[];
}

export interface SceneVersion {
  publication?: { expectedRevision: string; draftContentHash: string };
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
  referenceType?: "image_list" | "video_list" | "audio_list";
  selection?: WorkflowMediaSelection;
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
  capabilityId?: string;
  capabilityVersion?: string;
  capabilityConfig?: Record<string, JsonValue>;
  hermesProfile?: string;
  inputs: WorkflowStepInput[];
  outputs: WorkflowStepOutput[];
  promptTemplate: string;
  execution?: WorkflowExecutionConfig;
  comfyui?: ComfyUIWorkflowConfig;
  control?: WorkflowControlConfig;
  review?: { enabled: boolean; instruction?: string };
  runCondition?: WorkflowRunCondition;
}

export interface ComfyUIBinding {
  mediaRole?: WorkflowMediaRole;
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
  selection?: WorkflowMediaSelection;
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
  adapter?: string;
  h3LongVideo?: {
    planRef: string;
    promptRowsRef: string;
    referenceImagesRef: string;
    materialNoteRef?: string;
  };
}

export interface WorkflowOutputField {
  key: string;
  label: string;
  type: WorkflowVariableType;
  sourceRef: string;
  selection?: WorkflowMediaSelection;
}

export type WorkflowExecutionMode = "once" | "for_each";
export type WorkflowIterationErrorPolicy = "continue" | "stop";

export interface WorkflowExecutionConfig {
  mode: WorkflowExecutionMode;
  sourceRef?: string;
  onError?: WorkflowIterationErrorPolicy;
  maxConcurrency?: number;
  carry?: { outputKey: string; initialSourceRef?: string };
}

export interface WorkflowDefinition {
  sceneId: SceneId;
  name: string;
  inputs: WorkflowInputField[];
  steps: WorkflowStepDefinition[];
  outputs: WorkflowOutputField[];
  execution?: Omit<WorkflowExecutionConfig, "carry">;
}

export interface WorkflowRunStepResult {
  warnings?: string[];
  review?: { status: "pending" | "approved"; id: string; decidedAt?: string };
  reusedFromRunId?: string;
  replaced?: boolean;
  stepId: string;
  capabilityId?: string;
  capabilityVersion?: string;
  name: string;
  status: "running" | "completed" | "skipped" | "failed" | "cancelled";
  startedAt?: string;
  finishedAt?: string;
  durationMs?: number;
  message?: string;
  inputs?: Record<string, JsonValue>;
  inputLabels?: Record<string, string>;
  agentPrompt?: string;
  agentResponse?: string;
  outputs?: Record<string, JsonValue>;
  outputLabels?: Record<string, string>;
  outputTypes?: Record<string, string>;
  items?: WorkflowRunStepItemResult[];
}

export interface WorkflowRunStepItemResult {
  warnings?: string[];
  reusedFromRunId?: string;
  replaced?: boolean;
  stepSnapshot?: WorkflowStepDefinition;
  index: number;
  value: JsonValue;
  status: "running" | "completed" | "skipped" | "failed" | "cancelled";
  startedAt?: string;
  finishedAt?: string;
  durationMs?: number;
  inputs?: Record<string, JsonValue>;
  agentPrompt?: string;
  agentResponse?: string;
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

export type WorkflowRunStatus = "waiting" | "queued" | "running" | "cancelling" | "completed" | "failed" | "cancelled" | "stale";

export interface WorkflowRunResult {
  runId: string;
  status: WorkflowRunStatus;
  steps: WorkflowRunStepResult[];
  outputs: WorkflowRunOutput[];
  items?: WorkflowRunItemResult[];
  error?: string;
  cancellationReason?: string;
  startedAt?: string;
  finishedAt?: string;
  durationMs?: number;
  archiveWarnings?: string[];
  pendingReview?: import("../server/domain/productionContracts").PendingReview;
  reviewHistory?: import("../server/domain/productionContracts").ReviewDecision[];
  feedbackHistory?: import("../server/domain/feedbackContracts.js").StepFeedbackRecord[];
  resumedFromRunId?: string;
  rerunFromRunId?: string;
  rerunPlan?: import("../server/domain/rerunContracts.js").RerunPlan;
  rerunRequest?: import("../server/domain/rerunContracts.js").RerunRequest;
  artifacts?: WorkflowRunArtifacts;
}

export interface WorkflowRunArtifacts {
  directory: string;
  inputs: string;
  workflow: string;
  runtime: string;
  output: string;
}

export interface WorkflowRunSubmitter {
  userId: string;
  username: string;
  displayName: string;
}

export interface WorkflowRunHistoryItem {
  ownerUserId?: string;
  submitter?: WorkflowRunSubmitter;
  createdAt?: string;
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
  ownerUserId?: string;
  submitter?: WorkflowRunSubmitter;
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

/** Administrator-only, system-wide scheduler configuration; never cached in localStorage. */
export interface TaskConcurrencySettings {
  format: "zane-studio.task-concurrency/v1";
  id: "task-concurrency";
  revision: number;
  maxActiveRuns: number;
  defaultMaxActiveRuns: number;
  source: "environment" | "saved";
  scope: "system";
  applyPolicy: "immediate_without_interrupting_active_runs";
  worker: { active: number; queued: number; preparing: number };
  nextAction: "update_with_revision";
}
