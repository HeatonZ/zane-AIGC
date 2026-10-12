/** Generic condition rules shared by every step's start condition and the legacy
 * condition step. Browser-safe: no Node dependencies. */
import type { JsonValue } from "./types.js";
import { externalizeRuntimeValue, splitWorkflowReference, workflowReferenceRoot } from "./workflowValues.js";

export const CONDITION_OPERATORS = ["equals", "not_equals", "greater_than", "greater_or_equal", "less_than", "less_or_equal", "contains", "not_contains", "is_empty", "is_not_empty"] as const;
export type ConditionOperator = (typeof CONDITION_OPERATORS)[number];
export interface ConditionRule {
  id: string;
  leftRef: string;
  operator: ConditionOperator;
  valueSource: "literal" | "reference";
  /** 字面量规则的右侧值；草稿校验允许省略（含只看左值的 is_empty/is_not_empty），运行时按空串处理。 */
  rightValue?: string;
  rightRef?: string;
}
export interface ConditionExpression { match: "all" | "any"; rules: ConditionRule[] }
/** Resolve a workflow reference (input.* / step.*.outputs.* / iteration.*) to its value. */
export type ConditionResolver = (reference: string) => unknown;

export function isConditionOperator(value: unknown): value is ConditionOperator {
  return typeof value === "string" && (CONDITION_OPERATORS as readonly string[]).includes(value);
}
function literalRightValue(rule: ConditionRule, leftType: string): JsonValue | string {
  const rightValue = rule.rightValue ?? "";
  if (rightValue.trim() === "") return "";
  if (leftType === "number") return Number(rightValue);
  if (leftType === "boolean") return rightValue === "true";
  if (leftType === "json") return JSON.parse(rightValue) as JsonValue;
  return rightValue;
}
function isEmptyValue(value: unknown) {
  return value === undefined || value === null || value === "" || (Array.isArray(value) && value.length === 0) || (typeof value === "object" && !Array.isArray(value) && Object.keys(value as object).length === 0);
}
/** Evaluate one rule; the resolver decides how references are read (inputs, step outputs, iteration values). */
export function evaluateConditionRule(rule: ConditionRule, resolve: ConditionResolver, typeOf: (reference: string) => string | undefined = () => "text"): boolean {
  const left = resolve(rule.leftRef);
  const leftType = typeOf(rule.leftRef) ?? "text";
  const right = rule.valueSource === "reference" ? resolve(rule.rightRef ?? "") : literalRightValue(rule, leftType);
  const comparableLeft = externalizeRuntimeValue(left) as JsonValue;
  const comparableRight = externalizeRuntimeValue(right) as JsonValue;
  switch (rule.operator) {
    case "equals": return JSON.stringify(comparableLeft) === JSON.stringify(comparableRight);
    case "not_equals": return JSON.stringify(comparableLeft) !== JSON.stringify(comparableRight);
    case "greater_than": return Number(comparableLeft) > Number(comparableRight);
    case "greater_or_equal": return Number(comparableLeft) >= Number(comparableRight);
    case "less_than": return Number(comparableLeft) < Number(comparableRight);
    case "less_or_equal": return Number(comparableLeft) <= Number(comparableRight);
    case "contains": return Array.isArray(comparableLeft) ? comparableLeft.some((item) => JSON.stringify(item) === JSON.stringify(comparableRight)) : typeof comparableLeft === "string" ? comparableLeft.includes(String(comparableRight)) : false;
    case "not_contains": return Array.isArray(comparableLeft) ? !comparableLeft.some((item) => JSON.stringify(item) === JSON.stringify(comparableRight)) : typeof comparableLeft === "string" ? !comparableLeft.includes(String(comparableRight)) : true;
    case "is_empty": return isEmptyValue(comparableLeft);
    case "is_not_empty": return !isEmptyValue(comparableLeft);
    default: throw new Error("不支持的条件运算符：" + String(rule.operator));
  }
}
/** Evaluate a whole expression; empty rules are caller-visible so validation can reject them. */
export function evaluateConditionExpression(expression: ConditionExpression, resolve: ConditionResolver, typeOf?: (reference: string) => string | undefined): boolean {
  const results = expression.rules.map((rule) => evaluateConditionRule(rule, resolve, typeOf));
  return expression.match === "any" ? results.some(Boolean) : results.every(Boolean);
}
/** Reference roots (input.<key> / step.<id>) a condition depends on, for validation and rerun planning. */
export function conditionReferenceRoots(expression: ConditionExpression | undefined): string[] {
  const refs: string[] = [];
  for (const rule of expression?.rules ?? []) {
    for (const value of [rule.leftRef, rule.valueSource === "reference" ? rule.rightRef : ""]) {
      if (value && splitWorkflowReference(value)) refs.push(workflowReferenceRoot(value));
    }
  }
  return refs;
}