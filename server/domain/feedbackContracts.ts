import type { JsonValue } from "./types.js";

export const feedbackMessageMaxLength = 10_000;

export interface StepFeedback {
  stepId: string;
  itemIndex?: number;
  message: string;
}

/** Server-captured rejected result; callers cannot supply or alter this snapshot. */
export interface StepFeedbackRecord extends StepFeedback {
  id: string;
  sourceRunId: string;
  createdAt: string;
  originalOutputs: Record<string, JsonValue>;
  sourceValue?: JsonValue;
  originalItems?: Array<{ index: number; value: JsonValue; outputs: Record<string, JsonValue> }>;
}

export interface HermesFeedbackContext {
  notes: Array<{ message: string; sourceRunId: string; createdAt: string }>;
  originalOutputs?: Record<string, JsonValue>;
}
