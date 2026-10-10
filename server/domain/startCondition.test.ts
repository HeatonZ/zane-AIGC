import assert from "node:assert/strict";
import test from "node:test";
import { evaluateConditionExpression, evaluateConditionRule, conditionReferenceRoots, type ConditionRule } from "./startCondition.js";

const rule = (overrides: Partial<ConditionRule>): ConditionRule => ({ id: "r1", leftRef: "input.value", operator: "equals", valueSource: "literal", rightValue: "", rightRef: "", ...overrides });
const values: Record<string, unknown> = {
  "input.value": "ready",
  "input.count": 3,
  "input.flag": true,
  "input.list": ["a", "b"],
  "input.empty": [],
  "input.nothing": null,
  "input.payload": { key: "value" },
  "input.images": [{ filename: "a.png" }, { filename: "b.png" }],
  "step.analyzer.outputs.text": "清新自然",
};
const resolve = (reference: string) => values[reference];

test("条件规则：全部运算符与字面量类型推断", () => {
  assert.equal(evaluateConditionRule(rule({ operator: "equals", rightValue: "ready" }), resolve), true);
  assert.equal(evaluateConditionRule(rule({ operator: "equals", rightValue: "other" }), resolve), false);
  assert.equal(evaluateConditionRule(rule({ operator: "not_equals", rightValue: "other" }), resolve), true);
  assert.equal(evaluateConditionRule(rule({ leftRef: "input.count", operator: "greater_than", rightValue: "2" }), resolve, () => "number"), true);
  assert.equal(evaluateConditionRule(rule({ leftRef: "input.count", operator: "greater_or_equal", rightValue: "3" }), resolve, () => "number"), true);
  assert.equal(evaluateConditionRule(rule({ leftRef: "input.count", operator: "less_than", rightValue: "3" }), resolve, () => "number"), false);
  assert.equal(evaluateConditionRule(rule({ leftRef: "input.count", operator: "less_or_equal", rightValue: "3" }), resolve, () => "number"), true);
  assert.equal(evaluateConditionRule(rule({ leftRef: "input.flag", operator: "equals", rightValue: "true" }), resolve, () => "boolean"), true);
  assert.equal(evaluateConditionRule(rule({ leftRef: "input.list", operator: "contains", rightValue: "\"b\"" }), resolve, () => "json"), true);
  assert.equal(evaluateConditionRule(rule({ leftRef: "input.list", operator: "not_contains", rightValue: "\"c\"" }), resolve, () => "json"), true);
  assert.equal(evaluateConditionRule(rule({ leftRef: "input.value", operator: "contains", rightValue: "ead" }), resolve, () => "text"), true);
});

test("条件规则：empty/is_not_empty 覆盖空列表、null 与媒体投影", () => {
  assert.equal(evaluateConditionRule(rule({ leftRef: "input.images", operator: "is_not_empty" }), resolve), true);
  assert.equal(evaluateConditionRule(rule({ leftRef: "input.empty", operator: "is_empty" }), resolve), true);
  assert.equal(evaluateConditionRule(rule({ leftRef: "input.nothing", operator: "is_empty" }), resolve), true);
  assert.equal(evaluateConditionRule(rule({ leftRef: "input.payload", operator: "is_not_empty" }), resolve), true);
  assert.equal(evaluateConditionRule(rule({ leftRef: "input.missing", operator: "is_empty" }), resolve), true);
});

test("条件规则：引用比较与未知运算符", () => {
  assert.equal(evaluateConditionRule(rule({ leftRef: "input.value", operator: "equals", valueSource: "reference", rightRef: "step.analyzer.outputs.text", rightValue: "" }), resolve), false);
  assert.equal(evaluateConditionRule(rule({ leftRef: "step.analyzer.outputs.text", operator: "equals", valueSource: "reference", rightRef: "input.value", rightValue: "" }), resolve), false);
  assert.equal(evaluateConditionRule(rule({ leftRef: "step.analyzer.outputs.text", operator: "is_not_empty" }), resolve), true);
  assert.throws(() => evaluateConditionRule(rule({ operator: "like" as ConditionRule["operator"] }), resolve), /不支持的条件运算符/);
});

test("条件表达式：all/any 组合与引用收集", () => {
  const all = { match: "all" as const, rules: [rule({ leftRef: "input.value", operator: "is_not_empty" }), rule({ leftRef: "input.images", operator: "is_not_empty" })] };
  assert.equal(evaluateConditionExpression(all, resolve), true);
  const any = { match: "any" as const, rules: [rule({ leftRef: "input.value", operator: "equals", rightValue: "nope" }), rule({ leftRef: "input.images", operator: "is_not_empty" })] };
  assert.equal(evaluateConditionExpression(any, resolve), true);
  const none = { match: "all" as const, rules: [rule({ leftRef: "input.value", operator: "equals", rightValue: "nope" })] };
  assert.equal(evaluateConditionExpression(none, resolve), false);
  assert.deepEqual(conditionReferenceRoots({
    match: "all",
    rules: [
      rule({ leftRef: "input.value" }),
      rule({ leftRef: "step.analyzer.outputs.text", valueSource: "reference", rightRef: "input.other" }),
      rule({ leftRef: "iteration.item" }),
      rule({ leftRef: "bad-ref" }),
    ],
  }), ["input.value", "step.analyzer.outputs.text", "input.other", "iteration.item"]);
});