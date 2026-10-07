import { canonicalJson, contentRevision } from "./sceneContent.js";
import { asRecord } from "./workflowValues.js";
import type { SceneDiffChange, SceneDiffSection, SceneDiffKind, SceneDiffValue } from "./sceneDiffContracts.js";

export interface RawSceneDiffChange extends Omit<SceneDiffChange, "before" | "after"> {
  before: unknown;
  after: unknown;
  beforePresent: boolean;
  afterPresent: boolean;
}
const labels: Record<string, string> = {
  scene: "场景信息", workflow: "流程", optionPresets: "选项预设", inputs: "输入", steps: "步骤", outputs: "输出",
  title: "场景名称", shortTitle: "简称", summary: "简介", description: "说明", cover: "封面", coverPosition: "封面位置", accent: "主题色", stages: "阶段",
  name: "名称", label: "显示名称", key: "变量 key", type: "类型", required: "必填", defaultValue: "默认值", options: "选项", optionPresetId: "选项预设引用", placeholder: "占位提示",
  kind: "执行方式", capabilityId: "能力", capabilityVersion: "能力版本", capabilityConfig: "能力配置", hermesProfile: "Hermes Profile", promptTemplate: "提示词模板",
  execution: "执行模式", mode: "模式", sourceRef: "来源引用", itemAlias: "逐项别名", indexAlias: "序号别名", valueSource: "取值方式", literalValue: "固定值",
  comfyui: "ComfyUI", workflowFile: "工作流文件", bindings: "节点绑定", nodeId: "节点 ID", property: "节点端口", inputName: "输入端口", outputIndex: "输出序号", direction: "方向", adapter: "适配器",
  sourceInputFormat: "来源输入格式", sourceOutputFormat: "来源输出格式", selection: "媒体选择", review: "审核", enabled: "启用", instruction: "审核说明",
  control: "条件判断", rules: "规则", match: "匹配方式", operator: "操作符", leftRef: "左值引用", rightValue: "右侧固定值", rightRef: "右值引用", runCondition: "运行条件", conditionStepId: "条件步骤", expectedResult: "期望结果",
};
const escapePath = (key: string) => key.replace(/~/g, "~0").replace(/\//g, "~1");
const equal = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);
const identityKey = (path: string) => path === "/optionPresets" || path.endsWith("/steps") || path.endsWith("/rules") ? "id" : path.endsWith("/bindings") ? "binding" : path.endsWith("/inputs") || path.endsWith("/outputs") ? "key" : undefined;
function keyed(array: unknown[], key: string) {
  const result = new Map<string, unknown>();
  for (const value of array) {
    const record = asRecord(value);
    const id = key === "binding" ? (typeof record?.direction === "string" && typeof record.key === "string" ? record.direction + ":" + record.key : undefined) : record?.[key];
    if (typeof id !== "string" || result.has(id)) return null;
    result.set(id, value);
  }
  return result;
}
type Context = { section: SceneDiffSection; objectId: string | null; objectLabel: string; trail: string[] };
export function buildSceneDiff(before: Record<string, unknown> | null, after: Record<string, unknown>): RawSceneDiffChange[] {
  const changes: RawSceneDiffChange[] = [];
  const emit = (path: string, context: Context, kind: SceneDiffKind, left: unknown, right: unknown, leftPresent: boolean, rightPresent: boolean, label?: string) => {
    changes.push({ changeId: contentRevision({ path, kind }).slice(0, 24), path, section: context.section, objectId: context.objectId, objectLabel: context.objectLabel, label: label ?? (context.trail.join(" › ") || "整体配置"), kind, before: left, after: right, beforePresent: leftPresent, afterPresent: rightPresent });
  };
  const visit = (left: unknown, right: unknown, path: string, context: Context, leftPresent = true, rightPresent = true) => {
    if ((!leftPresent && !rightPresent) || (leftPresent && rightPresent && equal(left, right))) return;
    if (!leftPresent || !rightPresent) { emit(path, context, leftPresent ? "removed" : "added", left, right, leftPresent, rightPresent); return; }
    const key = identityKey(path);
    if (key && Array.isArray(left) && Array.isArray(right)) {
      const a = keyed(left, key), b = keyed(right, key);
      if (a && b) {
        const leftIds = [...a.keys()], rightIds = [...b.keys()];
        if (!equal(leftIds.filter(id => b.has(id)), rightIds.filter(id => a.has(id)))) emit(path + "/@order", context, "reordered", leftIds, rightIds, true, true, "排列顺序");
        for (const id of new Set([...leftIds, ...rightIds])) {
          const oldItem = asRecord(a.get(id)), newItem = asRecord(b.get(id));
          const itemLabel = String(newItem?.name ?? newItem?.label ?? oldItem?.name ?? oldItem?.label ?? id);
          const rootCollection = ["/workflow/inputs", "/workflow/steps", "/workflow/outputs", "/optionPresets"].includes(path);
          visit(a.get(id), b.get(id), path + "/" + escapePath(id), rootCollection ? { ...context, objectId: id, objectLabel: itemLabel, trail: [] } : { ...context, trail: [...context.trail, itemLabel] }, a.has(id), b.has(id));
        }
        return;
      }
    }
    const a = asRecord(left), b = asRecord(right);
    if (a && b) {
      for (const field of [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()) {
        // Undefined has no representation in the persisted JSON snapshot.
        visit(a[field], b[field], path + "/" + escapePath(field), { ...context, trail: [...context.trail, labels[field] ?? field] }, a[field] !== undefined, b[field] !== undefined);
      }
      return;
    }
    emit(path, context, "changed", left, right, true, true);
  };
  for (const section of ["scene", "workflow", "optionPresets"] as const) {
    if (before?.[section] === undefined && after[section] === undefined) continue;
    if (section === "workflow" && asRecord(after.workflow) && (!before || asRecord(before.workflow))) {
      const a = asRecord(before?.workflow) ?? {}, b = asRecord(after.workflow)!;
      for (const field of [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()) {
        const group: SceneDiffSection = field === "inputs" || field === "steps" || field === "outputs" ? field : "workflow";
        // An unpublished scene is an explicit empty baseline, including keyed collections.
        visit(a[field] ?? (["inputs", "steps", "outputs"].includes(field) && !before ? [] : a[field]), b[field], "/workflow/" + escapePath(field), { section: group, objectId: null, objectLabel: labels[field] ?? "流程设置", trail: [labels[field] ?? field] }, !before && ["inputs", "steps", "outputs"].includes(field) || a[field] !== undefined, b[field] !== undefined);
      }
    } else {
      visit(before?.[section] ?? (section === "optionPresets" ? [] : undefined), after[section], "/" + section, { section, objectId: null, objectLabel: labels[section], trail: [labels[section]] }, Boolean(before) || section === "optionPresets", true);
    }
  }
  return changes;
}
export function diffValue(value: unknown, present: boolean, offset: number, limit: number): SceneDiffValue {
  const format = typeof value === "string" ? "text" : "json";
  const text = !present ? "" : format === "text" ? value as string : JSON.stringify(JSON.parse(canonicalJson(value)), null, 2);
  const chars = Array.from(text);
  const end = Math.min(chars.length, offset + limit);
  return { present, format, text: chars.slice(offset, end).join(""), totalChars: chars.length, offset, nextOffset: end < chars.length ? end : null, complete: end >= chars.length };
}
