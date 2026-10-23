import type { CapabilityDefinition } from "./contracts.js";
import type { JsonValue, RunStep } from "../domain/types.js";
import type { StepExecutionContext } from "../execution/workflowExecutor.js";
import type { HermesStepOptions } from "../execution/hermesStep.js";
import type { DirectLlmStepSelection, DirectLlmTarget } from "../domain/directLlm.js";
export interface CapabilityPackage {
  definition: CapabilityDefinition;
  execute(context: StepExecutionContext): Promise<Record<string, JsonValue>>;
  validate?(step: RunStep): void;
}
export interface CapabilityRuntime {
  /** Optional options let core.llm add a system-role message and a raw-text output mode. */
  hermes(context: StepExecutionContext, options?: HermesStepOptions): Promise<Record<string, JsonValue>>;
  condition(context: StepExecutionContext): Promise<Record<string, JsonValue>>;
  comfyui(context: StepExecutionContext, transform?: ComfyPromptTransform): Promise<Record<string, JsonValue>>;
  /** Optional for package-only catalogs; the production runtime injects the guarded HTTPS transport. */
  thirdPartyRequest?(context: StepExecutionContext): Promise<Record<string, JsonValue>>;
  /** core.llm 的直连目标：从权威提供商注册表按 providerId + 可选 model 解析，只含环境变量名，不含密钥值。
   *  省略 providerId 时解析保留的默认提供商，让 1.5.39 已发布快照继续可用。 */
  directLlm?(selection: DirectLlmStepSelection): DirectLlmTarget;
}
export interface ComfyPromptState { graph: Record<string, Record<string, unknown>>; workflow: unknown; context: StepExecutionContext; baseUrl: string; timeoutMs: number; request(route: string, init?: RequestInit, signal?: AbortSignal): Promise<unknown> }
export type ComfyPromptTransform = (state: ComfyPromptState) => Promise<{ graph?: Record<string, Record<string, unknown>>; outputs?: Record<string, JsonValue> }>;
export type CapabilityFactory = (runtime: CapabilityRuntime) => CapabilityPackage | CapabilityPackage[] | Promise<CapabilityPackage | CapabilityPackage[]>;
