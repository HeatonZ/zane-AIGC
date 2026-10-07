import type { JsonValue, RunStepInput, RunStep } from "./types.js";
export interface StepEdit {
  stepId: string; itemIndex?: number;
  /** Configuration objects are complete replacements, not merge patches, so clearing a field is preserved. */
  promptTemplate?: string; hermesProfile?: string; capabilityConfig?: Record<string, JsonValue>;
  inputs?: RunStepInput[]; comfyui?: RunStep["comfyui"];
}
export interface OutputEdit { stepId: string; itemIndex?: number; outputs: Record<string, JsonValue> }
export interface RerunRequest {
  feedback?: import("./feedbackContracts.js").StepFeedback[];
  inputOverrides?: Record<string, JsonValue>;
  stepOverrides?: StepEdit[];
  outputOverrides?: OutputEdit[];
  rerunSteps?: Array<{ stepId: string; itemIndexes?: number[] }>;
}
export interface RerunPlanStep {
  stepId: string; name: string; action: "reuse" | "run" | "replace"; reason: string;
  runItemIndexes?: number[]; reuseItemIndexes?: number[];
}
export interface RerunPlan { sourceRunId: string; steps: RerunPlanStep[]; changedInputKeys: string[] }
