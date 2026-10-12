import type { JsonValue, RunStep } from "../domain/types.js";
import { externalizeRuntimeValue, resolveWorkflowReference, workflowReferenceRoot } from "../domain/workflowValues.js";

/** 原始类型直接比较；对象/数组与 NaN（stringify 后与 null 同值）保持原 stringify 语义。 */
function sameValue(left: JsonValue, right: JsonValue) {
  if (left === right) return true;
  const primitive = (value: JsonValue) => value === null || typeof value !== "object";
  if (primitive(left) && primitive(right)
    && !(typeof left === "number" && Number.isNaN(left)) && !(typeof right === "number" && Number.isNaN(right))) return false;
  return JSON.stringify(left) === JSON.stringify(right);
}

export function evaluateCondition(rule: NonNullable<RunStep["control"]>["rules"][number], inputs: Record<string, JsonValue>, stepValues: Map<string, Record<string, JsonValue>>, types: Map<string, string>) {
  const left = resolveWorkflowReference(rule.leftRef, inputs, stepValues);
  const leftType = types.get(workflowReferenceRoot(rule.leftRef)) ?? "text";
  const rightValue = rule.rightValue ?? "";
  const right = rule.valueSource === "reference"
    ? resolveWorkflowReference(rule.rightRef, inputs, stepValues)
    : leftType === "number" && rightValue.trim() !== ""
      ? Number(rightValue)
      : leftType === "boolean"
        ? rightValue === "true"
        : leftType === "json" && rightValue.trim() !== ""
          ? JSON.parse(rightValue) as JsonValue
          : rightValue;
  const comparableLeft = externalizeRuntimeValue(left);
  const comparableRight = externalizeRuntimeValue(right);
  switch (rule.operator) {
    case "equals": return sameValue(comparableLeft, comparableRight);
    case "not_equals": return !sameValue(comparableLeft, comparableRight);
    case "greater_than": return Number(comparableLeft) > Number(comparableRight);
    case "greater_or_equal": return Number(comparableLeft) >= Number(comparableRight);
    case "less_than": return Number(comparableLeft) < Number(comparableRight);
    case "less_or_equal": return Number(comparableLeft) <= Number(comparableRight);
    case "contains": return Array.isArray(comparableLeft) ? comparableLeft.some((item) => sameValue(item, comparableRight)) : typeof comparableLeft === "string" ? comparableLeft.includes(String(comparableRight ?? "")) : typeof comparableLeft === "object" && comparableLeft !== null ? String(comparableRight) in comparableLeft : false;
    case "not_contains": return Array.isArray(comparableLeft) ? !comparableLeft.some((item) => sameValue(item, comparableRight)) : typeof comparableLeft === "string" ? !comparableLeft.includes(String(comparableRight ?? "")) : typeof comparableLeft === "object" && comparableLeft !== null ? !(String(comparableRight) in comparableLeft) : true;
    case "is_empty": return comparableLeft === undefined || comparableLeft === null || comparableLeft === "" || (Array.isArray(comparableLeft) && comparableLeft.length === 0) || (typeof comparableLeft === "object" && comparableLeft !== null && Object.keys(comparableLeft).length === 0);
    case "is_not_empty": return !(comparableLeft === undefined || comparableLeft === null || comparableLeft === "" || (Array.isArray(comparableLeft) && comparableLeft.length === 0) || (typeof comparableLeft === "object" && comparableLeft !== null && Object.keys(comparableLeft).length === 0));
    default: throw new Error(`不支持的条件运算符：${rule.operator}`);
  }
}
