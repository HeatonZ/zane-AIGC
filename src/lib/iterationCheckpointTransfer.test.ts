import test from "node:test";
import assert from "node:assert/strict";
import { createScenePackage, parseScenePackage } from "./sceneTransfer";
import { defaultScenes } from "../data/scenes";
import { defaultWorkflows } from "../data/workflows";
import type { WorkflowDefinition, WorkflowExecutionConfig } from "../types";

/** 循环内审核点与并发引用必须穿过场景包导入导出，不能被白名单静默丢掉。 */
function packageWith(execution: Partial<WorkflowExecutionConfig>) {
  const scene = structuredClone(defaultScenes.find(item => item.id === "commerce_ai")!);
  const workflow = structuredClone(defaultWorkflows.commerce_ai) as WorkflowDefinition;
  const step = workflow.steps.find(item => item.execution?.mode === "for_each") ?? workflow.steps[0]!;
  step.execution = { mode: "for_each", sourceRef: "input.cards", ...execution };
  return { step, raw: createScenePackage(scene, workflow, []) };
}

test("场景包导入导出保留循环内审核点与并发引用", () => {
  const { step, raw } = packageWith({ reviewAfterItems: 2, maxConcurrencyRef: "input.concurrency" });
  const restored = parseScenePackage(raw).workflow.steps.find(item => item.id === step.id)!;
  assert.equal(restored.execution?.reviewAfterItems, 2);
  assert.equal(restored.execution?.maxConcurrencyRef, "input.concurrency");
  const again = parseScenePackage(createScenePackage(structuredClone(defaultScenes.find(item => item.id === "commerce_ai")!), parseScenePackage(raw).workflow, []));
  assert.equal(again.workflow.steps.find(item => item.id === step.id)!.execution?.reviewAfterItems, 2);
});

test("场景包拒绝非法并发引用与循环内审核点，不静默丢弃", () => {
  const cases: Array<[Partial<WorkflowExecutionConfig>, RegExp]> = [
    [{ maxConcurrency: 2, maxConcurrencyRef: "input.concurrency" }, /不能同时配置/],
    [{ maxConcurrencyRef: "step.plan.outputs.cards" }, /并发引用无效/],
    [{ maxConcurrencyRef: "input." }, /并发引用无效/],
    [{ reviewAfterItems: 0 }, /循环内审核点无效/],
    [{ reviewAfterItems: 2.5 }, /循环内审核点无效/],
  ];
  for (const [execution, pattern] of cases) {
    const { raw } = packageWith(execution);
    assert.throws(() => parseScenePackage(raw), pattern, JSON.stringify(execution));
  }
  const once = packageWith({ reviewAfterItems: 2 });
  once.raw.workflow.steps.find(item => item.id === once.step.id)!.execution = { mode: "once", reviewAfterItems: 2 } as WorkflowExecutionConfig;
  assert.throws(() => parseScenePackage(once.raw), /仅支持 for_each/);
});
