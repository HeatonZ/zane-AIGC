import assert from "node:assert/strict";
import test from "node:test";
import type { RunRecord, RunWorkflowDefinition } from "../domain/types.js";
import { asRecord } from "../domain/workflowValues.js";
import { completedStepResult, rebuildStepExecutionContext, resolveStepExecutionContextInputs } from "./stepContextRebuild.js";
import { id } from "../testing/testSupport.js";

function mediaOf(value: unknown): { kind: string; count: number } | undefined {
  const record = asRecord(value);
  if (record?.__zaneRuntime !== "media") return undefined;
  return { kind: String(record.mediaKind), count: Array.isArray(record.items) ? record.items.length : 0 };
}

function run(workflow: RunWorkflowDefinition, steps: RunRecord["steps"], inputValues: RunRecord["inputValues"]): RunRecord {
  return {
    runId: id("context-rebuild-run"), sceneId: "test-scene", workflowName: "上下文重建", status: "completed",
    createdAt: "2026-10-17T00:00:00.000Z", startedAt: "2026-10-17T00:00:00.000Z", finishedAt: "2026-10-17T00:01:00.000Z",
    workflow, inputValues, steps,
    outputs: [], artifacts: { directory: "F:/runs/rebuild", inputs: "", workflow: "", runtime: "", output: "" },
  };
}

const workflow: RunWorkflowDefinition = {
  sceneId: "test-scene", name: "上下文重建", inputs: [
    { key: "brief", type: "text", required: true },
    { key: "refs", type: "image_list", required: false },
  ], outputs: [],
  steps: [
    { id: "writer", name: "编剧", kind: "hermes", hermesProfile: "default", inputs: [{ key: "brief", sourceRef: "input.brief" }], outputs: [{ key: "storyboard", type: "json" }] },
    { id: "render", name: "生成", kind: "hermes", hermesProfile: "default", hermesProvider: "custom:chat", hermesModel: "gpt-x", inputs: [{ key: "storyboard", sourceRef: "step.writer.outputs.storyboard" }, { key: "refs", sourceRef: "input.refs" }], outputs: [{ key: "image", type: "image_list" }] },
  ],
};

test("重建执行期上下文：媒体输入包回 runtime 形态、上游步骤值可被引用解析", () => {
  const source = run(workflow, [
    { stepId: "writer", name: "编剧", status: "completed", outputs: { storyboard: { shots: 3 } } },
    { stepId: "render", name: "生成", status: "completed", outputs: { image: ["F:/runs/rebuild/outputs/media/render-0.png"] } },
  ], { brief: "三镜短片", refs: [{ assetId: "asset-1", assetVersion: 2, path: "F:/runs/rebuild/inputs/files/ref-0.png" }] });
  const before = structuredClone(source);

  const context = rebuildStepExecutionContext(source, "render");
  assert.deepEqual(mediaOf(context.inputs.refs), { kind: "image", count: 1 }, "媒体输入必须包回 runtime 媒体值，否则模板与附件构造拿不到图");
  assert.equal(context.inputs.brief, "三镜短片");
  assert.deepEqual(context.values.get("writer"), { storyboard: { shots: 3 } });
  assert.equal(context.types.get("step.writer.outputs.storyboard"), "json");
  assert.equal(context.itemIndex, undefined);
  assert.deepEqual(source, before, "重建是只读的：不能改写运行记录");

  const step = source.workflow.steps[1]!;
  assert.deepEqual(resolveStepExecutionContextInputs(step, context), {
    storyboard: { shots: 3 },
    refs: context.inputs.refs,
  });
  // 目标步骤自己的旧结果不进可引用表：它是被修订的对象，不是上游。
  assert.equal(context.values.has("render"), false);
});

test("重建逐项上下文：来源项与 iteration.item 按执行期同一规则注入", () => {
  const iterative: RunWorkflowDefinition = {
    sceneId: "test-scene", name: "逐项", inputs: [{ key: "items", type: "json", required: true }], outputs: [],
    steps: [{ id: "shot", name: "逐镜", kind: "hermes", hermesProfile: "default", inputs: [{ key: "item", sourceRef: "iteration.item" }], outputs: [{ key: "text", type: "text" }], execution: { mode: "for_each", sourceRef: "input.items" } }],
  };
  const source = run(iterative, [
    { stepId: "shot", name: "逐镜", status: "completed_with_errors", outputs: { text: ["甲", null] }, items: [
      { index: 0, value: "甲", status: "completed", outputs: { text: "甲" } },
      { index: 1, value: "乙", status: "failed" },
    ] },
  ], { items: ["甲", "乙"] });

  const context = rebuildStepExecutionContext(source, "shot", 0);
  assert.equal(context.itemIndex, 0);
  assert.deepEqual(context.iterationItems, ["甲", "乙"]);
  assert.equal(context.inputs["iteration.item"], "甲");
  // 执行期会把来源字段本身也替换成当前项：模板同时引用 input.items 与 iteration.item 时必须一致。
  assert.deepEqual(context.inputs.items, "甲");
  assert.deepEqual(resolveStepExecutionContextInputs(source.workflow.steps[0]!, context), { item: "甲" });

  assert.throws(() => rebuildStepExecutionContext(source, "shot", 2), /超出该步骤的来源范围/);
  assert.throws(() => rebuildStepExecutionContext(source, "missing"), /没有找到此步骤/);
  const nonArray = structuredClone(source);
  nonArray.inputValues = { items: "不是数组" };
  assert.throws(() => rebuildStepExecutionContext(nonArray, "shot", 0), /来源必须是数组/);
  const flat = structuredClone(source);
  flat.workflow.steps[0]!.execution = undefined;
  assert.throws(() => rebuildStepExecutionContext(flat, "shot", 0), /不是逐项步骤/);
});

test("已完成结果的判定与重做链路同一口径：整步要有输出、逐项要有该项输出", () => {
  const source = run(workflow, [
    { stepId: "writer", name: "编剧", status: "completed", outputs: { storyboard: { shots: 3 } } },
    { stepId: "render", name: "生成", status: "failed", outputs: {} },
  ], { brief: "三镜短片" });
  assert.ok(completedStepResult(source, "writer"));
  assert.equal(completedStepResult(source, "render"), undefined, "没有输出的步骤不算可反馈结果");
  assert.equal(completedStepResult(source, "writer", 0), undefined, "非逐项步骤不能按项取结果");
});
