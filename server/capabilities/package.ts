import type { CapabilityDefinition } from "./contracts.js";
import type { JsonValue, RunStep } from "../domain/types.js";
import type { StepExecutionContext } from "../execution/workflowExecutor.js";
export interface CapabilityPackage {
  definition: CapabilityDefinition;
  execute(context: StepExecutionContext): Promise<Record<string, JsonValue>>;
  validate?(step: RunStep): void;
}
export interface CapabilityRuntime {
  hermes(context: StepExecutionContext): Promise<Record<string, JsonValue>>;
  condition(context: StepExecutionContext): Promise<Record<string, JsonValue>>;
  comfyui(context: StepExecutionContext, transform?: ComfyPromptTransform): Promise<Record<string, JsonValue>>;
}
export interface ComfyPromptState { graph: Record<string, Record<string, unknown>>; context: StepExecutionContext; baseUrl: string }
export type ComfyPromptTransform = (state: ComfyPromptState) => Promise<{ graph: Record<string, Record<string, unknown>>; outputs?: Record<string, JsonValue> }>;
export type CapabilityFactory = (runtime: CapabilityRuntime) => CapabilityPackage | CapabilityPackage[] | Promise<CapabilityPackage | CapabilityPackage[]>;
