import { comfyOutputMediaCountsSchema } from "../domain/comfyOutputContracts.js";
import type { JsonValue, RunStep } from "../domain/types.js";
import { normalizeMediaList } from "../domain/workflowValues.js";
import { mediaKindFromWorkflowType } from "../runtimeValue.js";
export function prepareComfyOutputCounts(step: RunStep) {
  if (step.capabilityConfig?.outputMediaCounts === undefined) return {};
  const result = comfyOutputMediaCountsSchema.safeParse(step.capabilityConfig.outputMediaCounts);
  if (!result.success) throw new Error("ComfyUI输出媒体数量配置无效");
  for (const key of Object.keys(result.data)) if (!step.outputs?.some(output => output.key === key && mediaKindFromWorkflowType(output.type))) throw new Error("ComfyUI数量约束必须引用已声明媒体输出：" + key);
  return result.data;
}
export function validateComfyOutputCounts(step: RunStep, outputs: Record<string, JsonValue>) {
  for (const [key, expected] of Object.entries(prepareComfyOutputCounts(step))) {
    const actual = normalizeMediaList(outputs[key]).length;
    if (actual !== expected) throw new Error("ComfyUI输出" + key + "要求" + expected + "项媒体，实际" + actual + "项；不自动选择、截断或补齐");
  }
  return outputs;
}
