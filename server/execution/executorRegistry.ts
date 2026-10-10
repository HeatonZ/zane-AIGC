import type { JsonValue, RunStep } from "../domain/types.js";
import type { StepExecutionContext } from "./workflowExecutor.js";
import { capabilityConfigErrors, capabilityForStep, capabilityUsage, readCapabilityConfig, writeCapabilityConfig } from "../capabilities/contracts.js";
import type { CapabilityDefinition } from "../capabilities/contracts.js";
import type { CapabilityPackage } from "../capabilities/package.js";
import { HttpError } from "../errors.js";
export interface StepExecutor { kind: string; execute(context: StepExecutionContext): Promise<Record<string, JsonValue>> }
export class ExecutorRegistry {
  private readonly executors = new Map<string, StepExecutor>();
  private readonly capabilities = new Map<string, CapabilityPackage>();
  register(executor: StepExecutor) {
    if (this.executors.has(executor.kind)) throw new Error("执行器重复：" + executor.kind);
    this.executors.set(executor.kind, executor);
    return this;
  }
  registerCapability(capability: CapabilityPackage) {
    const d = capability.definition;
    if (!d || !/^[a-zA-Z0-9_.-]+$/.test(d.id) || !d.version || !d.label || typeof capability.execute !== "function") throw new Error("能力包声明无效");
    if (d.usage && (typeof d.usage.whenToUse !== "string" || !d.usage.whenToUse.trim())) throw new Error("能力包适用范围声明无效：" + d.id);
    if (d.usage?.compatibilityOnly !== undefined && typeof d.usage.compatibilityOnly !== "boolean") throw new Error("能力包兼容范围声明无效：" + d.id);
    if (this.capabilities.has(d.id)) throw new Error("能力包重复：" + d.id);
    const legacyCollision = [...this.capabilities.values()].some((item) => d.legacy.kind !== "capability" && item.definition.legacy.kind === d.legacy.kind && item.definition.legacy.adapter === d.legacy.adapter);
    if (legacyCollision) throw new Error("旧步骤映射重复：" + d.id);
    for (const fields of [d.inputs, d.outputs, d.config]) if (new Set(fields.map((field) => field.key)).size !== fields.length) throw new Error("能力包字段重复：" + d.id);
    this.capabilities.set(d.id, { ...capability, definition: structuredClone({ ...d, usage: capabilityUsage(d) }) });
    return this;
  }
  definitions(): CapabilityDefinition[] { return [...this.capabilities.values()].map((item) => structuredClone(item.definition)); }
  supports(kind: string) { return this.executors.has(kind) || [...this.capabilities.values()].some((item) => item.definition.legacy.kind === kind); }
  private resolve(step: RunStep) {
    const definition = capabilityForStep(step, this.definitions());
    return definition ? this.capabilities.get(definition.id) : undefined;
  }
  prepareStep(step: RunStep): RunStep {
    const capability = this.resolve(step);
    if (!capability) {
      if (step.capabilityId || !this.executors.has(step.kind)) throw new HttpError(400, "未安装此能力：" + (step.capabilityId ?? step.comfyui?.adapter ?? step.kind), "UNSUPPORTED_CAPABILITY");
      return step;
    }
    const definition = capability.definition;
    if (step.kind !== definition.legacy.kind || (step.comfyui?.adapter ?? undefined) !== definition.legacy.adapter) throw new HttpError(400, "能力与步骤执行方式不匹配：" + definition.label, "CAPABILITY_MISMATCH");
    if (step.capabilityVersion && step.capabilityVersion !== definition.version) throw new HttpError(409, "能力版本已变化，请重新确认配置：" + definition.label, "CAPABILITY_VERSION_MISMATCH");
    let prepared = { ...step, capabilityId: definition.id, capabilityVersion: definition.version };
    for (const field of definition.config) {
      const value = readCapabilityConfig(prepared, field);
      if (value !== undefined) prepared = writeCapabilityConfig(prepared, field, value);
    }
    const errors = capabilityConfigErrors(prepared, definition);
    if (errors.length) throw new HttpError(400, definition.label + "：" + errors.join("；"), "INVALID_CAPABILITY_CONFIG");
    if (definition.legacy.kind === "capability") {
      for (const input of definition.inputs.filter((item) => item.required)) {
        const binding = prepared.inputs?.find((item) => item.key === input.key);
        if (!binding || (binding.valueSource === "literal" ? !binding.literalValue && binding.literalValue !== "0" : !binding.sourceRef)) throw new HttpError(400, definition.label + "缺少输入：" + input.label, "INVALID_CAPABILITY_INPUT");
      }
      if (definition.editor.editableOutputs === false || !definition.editor.editablePorts) for (const output of definition.outputs) if ((output.required !== false || prepared.outputs?.some(item => item.key === output.key)) && !prepared.outputs?.some((item) => item.key === output.key && item.type === output.type)) throw new HttpError(400, definition.label + "输出契约不匹配：" + output.key, "INVALID_CAPABILITY_OUTPUT");
    }
    try { capability.validate?.(prepared); }
    catch (error) {
      if (error instanceof HttpError) throw error;
      throw new HttpError(400, definition.label + "：" + (error instanceof Error ? error.message : String(error)), "INVALID_CAPABILITY_CONFIG");
    }
    return prepared;
  }
  async execute(context: StepExecutionContext) {
    const step = this.prepareStep(context.step);
    const capability = this.resolve(step);
    if (capability) return capability.execute({ ...context, step });
    const executor = this.executors.get(step.kind);
    if (!executor) throw new Error("暂不支持执行方式：" + step.kind);
    return executor.execute(context);
  }
}
