import type { WorkflowMediaRole } from "./workflowMediaRoles.js";
import type { RuntimeMediaValue } from "../runtimeValue.js";

export interface SavedSettings {
  enabledHermesProfiles: string[];
  comfyuiBaseUrl: string;
  projectDirectory: string;
  workflowTimeoutMinutes: number;
}

export interface HermesProfile {
  id: string;
  isDefault: boolean;
}

export interface HermesApiConnection {
  baseUrl: string;
  apiKey: string;
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
  type: "text" | "number" | "boolean" | "image_list" | "video_list" | "audio_list" | "json";
  options?: string[];
  required?: boolean;
}

export interface ComfyUINodeInfo {
  type: string;
  inputs: ComfyUIPropertyInfo[];
  outputs: ComfyUIPropertyInfo[];
}

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue } | RuntimeMediaValue;

export interface RunInputField {
  mediaRole?: WorkflowMediaRole;
  key: string;
  type: string;
  required?: boolean;
  options?: string[];
}

export interface RunStepOutput {
  key: string;
  label?: string;
  description?: string;
  type: string;
}

export interface RunComfyBinding {
  mediaRole?: WorkflowMediaRole;
  key: string;
  label?: string;
  direction: "input" | "output";
  nodeId: string;
  property: string;
  type: string;
  options?: string[];
  required?: boolean;
  sourceRef?: string;
  valueSource?: "literal" | "reference";
  literalValue?: string;
  selection?: { mode: "all" | "item" | "for_each"; index?: number };
}

export interface RunStepInput {
  key: string;
  label?: string;
  sourceRef?: string;
  valueSource?: "literal" | "reference";
  literalValue?: string;
  literalType?: string;
  referenceType?: "image_list" | "video_list" | "audio_list";
  selection?: { mode: "all" | "item" | "for_each"; index?: number };
}

export interface RunStep {
  id: string;
  name: string;
  kind: string;
  capabilityId?: string;
  capabilityVersion?: string;
  capabilityConfig?: Record<string, JsonValue>;
  hermesProfile?: string;
  inputs?: RunStepInput[];
  outputs?: RunStepOutput[];
  promptTemplate?: string;
  execution?: {
    mode?: "once" | "for_each";
    sourceRef?: string;
    onError?: "continue" | "stop";
    maxConcurrency?: number;
    carry?: import("./iterationCarry.js").IterationCarry;
  };
  comfyui?: {
    workflowFile: string;
    bindings?: RunComfyBinding[];
    adapter?: string;
    h3LongVideo?: {
      planRef: string;
      promptRowsRef: string;
      referenceImagesRef: string;
      materialNoteRef?: string;
    };
  };
  control?: {
    type: "condition";
    match: "all" | "any";
    rules: Array<{
      id: string;
      leftRef: string;
      operator: string;
      valueSource: "literal" | "reference";
      rightValue: string;
      rightRef: string;
    }>;
  };
  review?: { enabled: boolean; instruction?: string };
  runCondition?: { conditionStepId: string; expectedResult: boolean };
}

export interface RunWorkflowDefinition {
  /** Source published snapshot; reruns may edit this workflow after taking the snapshot. */
  publishedScene?: { versionId: string; version: string; publishedAt: string };
  sceneId?: string;
  name?: string;
  inputs: RunInputField[];
  steps: RunStep[];
  outputs: Array<{ key: string; label?: string; type: string; sourceRef: string; selection?: { mode: "all" | "item" | "for_each"; index?: number } }>;
  execution?: {
    mode?: "once" | "for_each";
    sourceRef?: string;
    onError?: "continue" | "stop";
    maxConcurrency?: number;
  };
}

export interface RunStepRecord {
  warnings?: string[];
  review?: { status: "pending" | "approved"; id: string; decidedAt?: string };
  reusedFromRunId?: string;
  replaced?: boolean;
  stepId: string;
  capabilityId?: string;
  capabilityVersion?: string;
  name: string;
  status: "running" | "completed" | "skipped" | "failed" | "cancelled";
  message?: string;
  inputs?: Record<string, JsonValue>;
  inputLabels?: Record<string, string>;
  outputs?: Record<string, JsonValue>;
  outputLabels?: Record<string, string>;
  outputTypes?: Record<string, string>;
  items?: RunStepItemRecord[];
}

export interface RunStepItemRecord {
  warnings?: string[];
  reusedFromRunId?: string;
  replaced?: boolean;
  stepSnapshot?: RunStep;
  index: number;
  value: JsonValue;
  status: "running" | "completed" | "skipped" | "failed" | "cancelled";
  inputs?: Record<string, JsonValue>;
  outputs?: Record<string, JsonValue>;
  error?: string;
}

export interface RunItemResult {
  index: number;
  value: JsonValue;
  status: "completed" | "failed" | "cancelled" | "waiting";
  steps: RunStepRecord[];
  outputs: Array<{ key: string; label: string; type: string; value: JsonValue }>;
  error?: string;
}

export interface RunArtifactPaths {
  directory: string;
  inputs: string;
  workflow: string;
  runtime: string;
  output: string;
}

export type RunStatus = "waiting" | "queued" | "running" | "cancelling" | "completed" | "failed" | "cancelled" | "stale";
export interface RunSubmitter {
  userId: string;
  username: string;
  displayName: string;
}
export interface RunRecord {
  ownerUserId?: string;
  /** Snapshot of the authenticated account that submitted this run. Legacy runs may omit it. */
  submitter?: RunSubmitter;
  runId: string;
  sceneId: string;
  workflowName: string;
  runTitle?: string;
  status: RunStatus;
  createdAt: string;
  startedAt: string;
  finishedAt?: string;
  durationMs?: number;
  steps: RunStepRecord[];
  outputs: Array<{ key: string; label: string; type: string; value: JsonValue }>;
  error?: string;
  cancellationReason?: string;
  archiveWarnings?: string[];
  pendingReview?: import("./productionContracts.js").PendingReview;
  reviewHistory?: import("./productionContracts.js").ReviewDecision[];
  feedbackHistory?: import("./feedbackContracts.js").StepFeedbackRecord[];
  resumedFromRunId?: string;
  rerunFromRunId?: string;
  rerunPlan?: import("./rerunContracts.js").RerunPlan;
  rerunRequest?: import("./rerunContracts.js").RerunRequest;
  artifacts: RunArtifactPaths;
  inputValues: Record<string, JsonValue>;
  workflow: RunWorkflowDefinition;
}
export interface RunEvent {
  runId: string;
  sequence: number;
  type: string;
  at: string;
  stepId?: string;
  payload?: Record<string, unknown>;
}
export function isActiveRunStatus(status: RunStatus) {
  return status === "queued" || status === "running" || status === "cancelling";
}
