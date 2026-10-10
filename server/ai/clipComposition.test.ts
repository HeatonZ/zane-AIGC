import assert from "node:assert/strict";
import test from "node:test";
import { productionHarness } from "../testing/productionSupport.js";
import { ClipSelectionService } from "../services/clipSelectionService.js";
import type { RunService } from "../services/runService.js";
import type { ClipSelection } from "../domain/productionContracts.js";
import type { RunRecord, RunWorkflowDefinition } from "../domain/types.js";
import { id } from "../testing/testSupport.js";

test("选片合成提交客户端固定runId，清单lastRunId可对账；旧revision不再执行", async t => {
  const h = await productionHarness(t); let calls = 0; let received: Record<string, unknown> | undefined;
  const runs = { async submit(raw: unknown): Promise<RunRecord> { calls++; received = raw as Record<string, unknown>; return { runId: received.runId as string, status: "queued", sceneId: "demo", workflowName: "合成", createdAt: "now", startedAt: "now", steps: [], outputs: [], inputValues: received.inputValues as RunRecord["inputValues"], workflow: received.workflow as RunWorkflowDefinition, artifacts: { directory: "", inputs: "", workflow: "", runtime: "", output: "" } }; } } as unknown as RunService;
  const clips = new ClipSelectionService(h.assets, runs);
  const source = { runId: id("composition-source"), stepId: "video", outputKey: "clips", mediaIndex: 0, itemIndex: 0 };
  const selection: ClipSelection = { id: id("composition-selection"), revision: 0, name: "完整选片", sourceRunId: source.runId, sceneId: "demo", generationStepId: "video", outputKey: "clips", createdAt: "now", updatedAt: "now", shots: [{ shotId: "shot-a", index: 0, value: { index: 1 }, choice: { shotId: "shot-a", source, assetId: "asset-fixed", assetVersion: 2 } }] };
  const saved = clips.put(h.settings.projectDirectory, selection, 0);
  const runId = id("composition-stable-id"); const composed = await clips.compose(saved.id, { revision: saved.revision, runId });
  assert.equal(received!.runId, runId); assert.equal(composed.runId, runId); assert.equal(composed.selection.lastRunId, runId); assert.equal(calls, 1);
  const workflow = received!.workflow as RunWorkflowDefinition; assert.equal(workflow.steps.length, 1); assert.equal(workflow.steps[0]!.capabilityId, "core.code"); assert.equal(workflow.steps[0]!.kind, "capability"); assert.equal(workflow.steps[0]!.comfyui, undefined); assert.ok(String(workflow.steps[0]!.capabilityConfig?.code ?? "").includes("不能静默漏掉片段或乱序")); assert.deepEqual((workflow.steps[0]!.outputs ?? []).map(output => [output.key, output.type]), [["video", "video_list"], ["manifest", "json"]]);
  assert.deepEqual((received!.inputValues as { clips: unknown[] }).clips, [{ assetId: "asset-fixed", assetVersion: 2 }]);
  await assert.rejects(clips.compose(saved.id, { revision: saved.revision, runId }), /已变化/); assert.equal(calls, 1);
});
