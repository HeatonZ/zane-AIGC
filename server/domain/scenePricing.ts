import * as z from "zod/v4";
import { HttpError } from "../errors.js";
import { splitWorkflowReference } from "./workflowValues.js";
import { CREDIT_UNITS_PER_POINT, formatPoints, fromUnits, hasAtMostTwoDecimals, normalizePoints, toUnits } from "./creditUnits.js";
import type { RunRecord, RunStep, RunWorkflowDefinition } from "./types.js";

/** 计费单位：per_call 每执行一次计一次；per_item 逐项步骤按成功项计。
 *  maxItems 是逐项来源无法在提交时解析（来源是前序步骤输出）时的预估上限；结算一次不会补扣。 */
const pricingStepSchema = z.object({
  unit: z.enum(["per_call", "per_item"]),
  credits: z.number().min(0).max(1_000_000).refine(hasAtMostTwoDecimals, "单价最多两位小数").describe("积分单价，最多两位小数（如 0.05）"),
  maxItems: z.int().min(1).max(1000).optional(),
}).strict();

export const scenePricingSchema = z.object({
  version: z.literal(1),
  base: z.number().min(0).max(1_000_000).refine(hasAtMostTwoDecimals, "基础分最多两位小数").default(0),
  steps: z.record(z.string().min(1).max(200), pricingStepSchema).default({}),
}).strict();
export type ScenePricing = z.output<typeof scenePricingSchema>;
export type ScenePricingStep = ScenePricing["steps"][string];

export { CREDIT_UNITS_PER_POINT, formatPoints, fromUnits, hasAtMostTwoDecimals, normalizePoints, toUnits };

/** 计划：提交时固化，结算与退还都以它为上限。 */
export interface RunCreditPlan {
  pricingVersion: number;
  base: number;
  total: number;
  steps: Record<string, { unit: "per_call" | "per_item"; credits: number; units: number; capped?: boolean }>;
}
export interface RunCreditSettlement {
  settledAt: string;
  charged: number;
  refunded: number;
  detail: Record<string, { charged: number; units: number }>;
}
export interface RunCreditRecord {
  plan: RunCreditPlan;
  /** 提交时固化的定价快照：续跑/重做按它重新预估，不跟随场景后续改价。 */
  pricing?: ScenePricing;
  settlement?: RunCreditSettlement;
}

/** 「会调外部服务」的步骤集合：与 aiSceneService.boundaries 的 externalSteps 同一口径。 */
export function isExternallyBilledStep(step: RunStep) {
  return step.kind === "hermes"
    || (step.kind === "comfyui" && step.capabilityId !== "media.video_concat" && step.comfyui?.adapter !== "video_concat")
    || step.capabilityId === "core.http_request"
    || step.capabilityId === "core.llm";
}

export function parseScenePricing(value: unknown): ScenePricing | undefined {
  if (value === undefined || value === null) return undefined;
  const parsed = scenePricingSchema.safeParse(value);
  if (!parsed.success) throw new HttpError(400, "场景定价格式无效：" + parsed.error.issues.map(issue => issue.path.join(".") + ": " + issue.message).join("; "), "INVALID_SCENE_PRICING");
  return parsed.data;
}

/** 发布期结构校验：定价只能落在外部步骤上；逐项计费必须能在提交时得到上限。 */
export function validateScenePricing(pricing: ScenePricing | undefined, workflow: RunWorkflowDefinition) {
  if (!pricing) return;
  const steps = new Map(workflow.steps.map(step => [step.id, step]));
  for (const [stepId, entry] of Object.entries(pricing.steps)) {
    const step = steps.get(stepId);
    if (!step) throw new HttpError(400, "定价引用了不存在的步骤：" + stepId, "INVALID_SCENE_PRICING", { stepId });
    if (!isExternallyBilledStep(step)) throw new HttpError(400, "只能为会调用外部服务的步骤定价：" + stepId, "INVALID_SCENE_PRICING", { stepId });
    if (entry.unit !== "per_item") continue;
    const forEach = step.execution?.mode === "for_each" || (workflow.execution?.mode === "for_each" && !step.execution?.mode);
    if (!forEach) continue;
    const sourceRef = step.execution?.sourceRef ?? workflow.execution?.sourceRef;
    const root = typeof sourceRef === "string" ? splitWorkflowReference(sourceRef)?.root : undefined;
    if (!root || !root.startsWith("input.")) {
      if (entry.maxItems === undefined) throw new HttpError(400, "逐项计费的前序来源步骤需要声明 maxItems 作为预估上限：" + stepId, "INVALID_SCENE_PRICING", { stepId, nextAction: "set_pricing_max_items" });
    }
  }
}

function forEachItemCount(workflow: RunWorkflowDefinition, step: RunStep, inputValues: Record<string, unknown>) {
  const mode = step.execution?.mode ?? workflow.execution?.mode ?? "once";
  if (mode !== "for_each") return { units: 1, resolved: true };
  const sourceRef = step.execution?.sourceRef ?? workflow.execution?.sourceRef;
  const root = typeof sourceRef === "string" ? splitWorkflowReference(sourceRef)?.root : undefined;
  const inputKey = root?.startsWith("input.") ? root.slice(6) : undefined;
  if (!inputKey) return { units: 0, resolved: false };
  const value = inputValues[inputKey];
  if (value === undefined || value === null || value === "") return { units: 0, resolved: true };
  return { units: Array.isArray(value) ? value.length : 1, resolved: true };
}

/** 提交前的上限价：per_call 计一次；per_item 按输入长度或 maxItems 上限。 */
export function planSceneCost(pricing: ScenePricing | undefined, workflow: RunWorkflowDefinition, inputValues: Record<string, unknown>): RunCreditPlan {
  const baseUnits = toUnits(pricing?.base ?? 0);
  const plan: RunCreditPlan = { pricingVersion: pricing?.version ?? 1, base: fromUnits(baseUnits), total: fromUnits(baseUnits), steps: {} };
  if (!pricing) return plan;
  let totalUnits = baseUnits;
  const steps = new Map(workflow.steps.map(step => [step.id, step]));
  for (const [stepId, entry] of Object.entries(pricing.steps)) {
    const step = steps.get(stepId);
    if (!step) continue;
    let units: number;
    let capped = false;
    if (entry.unit === "per_call") units = 1;
    else {
      const counted = forEachItemCount(workflow, step, inputValues);
      units = counted.resolved ? counted.units : 0;
      if (!counted.resolved || units > (entry.maxItems ?? Number.POSITIVE_INFINITY)) {
        units = entry.maxItems ?? units;
        capped = !counted.resolved;
      }
    }
    // 单价也归一到厘：计划会随运行快照长期保存，不能把浮点尾数固化进去。
    plan.steps[stepId] = { unit: entry.unit, credits: fromUnits(toUnits(entry.credits)), units, ...(capped ? { capped: true } : {}) };
    totalUnits += units * toUnits(entry.credits);
  }
  plan.total = fromUnits(totalUnits);
  return plan;
}

/** 结算：只有成功的产出落定；复用的步骤与项不重复计费；上限是计划价，永不补扣。 */
export function settleCreditPlan(run: RunRecord, plan: RunCreditPlan): RunCreditSettlement {
  const detail: RunCreditSettlement["detail"] = {};
  const planUnits = toUnits(plan.total);
  let chargedUnits = 0;
  const ran = run.steps.some(step => step.status !== "skipped");
  if (plan.base > 0 && ran) { const amountUnits = toUnits(plan.base); chargedUnits += amountUnits; detail["__base"] = { charged: fromUnits(amountUnits), units: 1 }; }
  for (const [stepId, entry] of Object.entries(plan.steps)) {
    const record = run.steps.find(step => step.stepId === stepId);
    if (!record || record.reusedFromRunId) { detail[stepId] = { charged: 0, units: 0 }; continue; }
    if (entry.unit === "per_call") {
      const billable = ["completed", "completed_with_errors"].includes(record.status) ? 1 : 0;
      const amountUnits = billable * toUnits(entry.credits);
      chargedUnits += amountUnits;
      detail[stepId] = { charged: fromUnits(amountUnits), units: billable };
      continue;
    }
    const completed = (record.items ?? []).filter(item => item.status === "completed" && !item.reusedFromRunId).length;
    const units = Math.min(completed, entry.units);
    const amountUnits = units * toUnits(entry.credits);
    chargedUnits += amountUnits;
    detail[stepId] = { charged: fromUnits(amountUnits), units };
  }
  const cappedUnits = Math.min(chargedUnits, planUnits);
  return { settledAt: new Date().toISOString(), charged: fromUnits(cappedUnits), refunded: fromUnits(Math.max(0, planUnits - cappedUnits)), detail };
}
