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
  selection?: { mode: "all" | "item" | "for_each"; index?: number };
}

export interface RunStep {
  id: string;
  name: string;
  kind: string;
  hermesProfile?: string;
  inputs?: RunStepInput[];
  outputs?: RunStepOutput[];
  promptTemplate?: string;
  execution?: {
    mode?: "once" | "for_each";
    sourceRef?: string;
    onError?: "continue" | "stop";
    maxConcurrency?: number;
  };
  comfyui?: {
    workflowFile: string;
    bindings?: RunComfyBinding[];
    adapter?: "h3_long_video" | "commerce_pack" | "long_text_video" | "video_concat";
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
  runCondition?: { conditionStepId: string; expectedResult: boolean };
}

export interface RunWorkflowDefinition {
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
  stepId: string;
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
  status: "completed" | "failed" | "cancelled";
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

export type RunStatus = "queued" | "running" | "cancelling" | "completed" | "failed" | "cancelled" | "stale";
export interface RunRecord {
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
  resumedFromRunId?: string;
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
