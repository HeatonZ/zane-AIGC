import assert from "node:assert/strict";
import test from "node:test";
import { aiOperations, AI_CONTRACT_VERSION } from "../ai/operations.js";
import path from "node:path";
import { readdir } from "node:fs/promises";
import { aiHarness, aiWorkspace } from "../testing/aiSupport.js";
import { deferred, id, until } from "../testing/testSupport.js";
import type { RunRecord } from "../domain/types.js";

const post = (base: string, route: string, body: unknown) => fetch(base + route, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

test("AI发布场景：发现、固定选项/默认值、纯预检、拒绝草稿并透传额外输入", async t => {
  const h = await aiHarness(t);
  const manifest = await (await fetch(h.base + "/api/v1/ai")).json() as { contractVersion: string; worker: { ready: boolean }; operations: unknown[] };
  assert.equal(manifest.contractVersion, AI_CONTRACT_VERSION); assert.equal(manifest.worker.ready, true); assert.equal(manifest.operations.length, aiOperations.length);
  const catalogue = await h.scenes.list(); assert.equal(catalogue.scenes[0].publishedVersionId, "version-a"); assert.equal(catalogue.scenes[1].publishedVersionId, null);
  const selected = await h.scenes.get("demo"); assert.notEqual(selected.workflow.name, "不能运行的草稿"); assert.deepEqual(selected.workflow.inputs[1].options, ["已发布值"]);
  const preview = await post(h.base, "/api/v1/scenes/demo/prepare", { versionId: "version-a", inputValues: {} }); assert.equal(preview.status, 200);
  const prepared = await preview.json() as { valid: boolean; inputValues: unknown; externalServicesChecked: boolean }; assert.equal(prepared.valid, true); assert.equal(prepared.externalServicesChecked, false); assert.deepEqual(prepared.inputValues, { flag: false, style: "已发布值" });
  assert.equal(h.store.listRuns(h.settings.projectDirectory).runs.length, 0);
  assert.deepEqual(await readdir(path.join(h.settings.projectDirectory, ".zane", "runs")).catch(() => []), []);
  const extra = await post(h.base, "/api/v1/scenes/demo/prepare", { versionId: "version-a", inputValues: { typo: true } }); assert.equal(extra.status, 200);
  assert.deepEqual((await extra.json() as { inputValues: unknown }).inputValues, { flag: false, style: "已发布值", typo: true });
  for (const input of [{ flag: "true" }, { style: "草稿值" }]) assert.equal((await post(h.base, "/api/v1/scenes/demo/prepare", { versionId: "version-a", inputValues: input })).status, 400);
  assert.equal((await post(h.base, "/api/v1/scenes/demo/runs", { inputValues: {}, runId: id("missing-version") })).status, 400);
  assert.equal((await fetch(h.base + "/api/v1/scenes/unpublished")).status, 409);
  assert.equal((await fetch(h.base + "/api/v1/scenes/missing")).status, 404);
  assert.equal((await fetch(h.base + "/api/v1/scenes/demo?versionId=missing")).status, 409);
});

test("AI场景运行：稳定ID、wait返回审核、旧review拒绝、完成输出保留发布来源", async t => {
  const calls: string[] = [];
  const h = await aiHarness(t, { review: true, executor: { kind: "fake", async execute({ step }) { calls.push(step.id); return { value: "ok" }; } } });
  const runId = id("ai-submit-review");
  const body = { versionId: "version-a", inputValues: {}, runId };
  const submitted = await post(h.base, "/api/v1/scenes/demo/runs", body); assert.equal(submitted.status, 202);
  const waiting = await (await fetch(h.base + "/api/v1/runs/" + runId + "/wait?timeoutSeconds=2")).json() as { status: string; timedOut: boolean; nextAction: string; pendingReview: { id: string } };
  assert.equal(waiting.status, "waiting"); assert.equal(waiting.timedOut, false); assert.equal(waiting.nextAction, "review"); assert.deepEqual(calls, ["first"]);
  const duplicate = await post(h.base, "/api/v1/scenes/demo/runs", body); assert.equal(duplicate.status, 409); assert.equal((await duplicate.json() as { code: string }).code, "RUN_ALREADY_EXISTS");
  assert.equal((await post(h.base, "/api/v1/runs/" + runId + "/resume", { runId: id("must-not-bypass") })).status, 409);
  const decision = { reviewId: waiting.pendingReview.id, action: "approve" };
  assert.equal((await post(h.base, "/api/v1/runs/" + runId + "/review", decision)).status, 202);
  await h.service.wait(h.settings.projectDirectory, runId);
  const old = await post(h.base, "/api/v1/runs/" + runId + "/review", decision); assert.equal(old.status, 409); assert.equal((await old.json() as { code: string }).code, "REVIEW_CONFLICT");
  const done = await (await fetch(h.base + "/api/v1/runs/" + runId)).json() as RunRecord;
  assert.equal(done.status, "completed"); assert.equal(done.workflow.publishedScene?.versionId, "version-a"); assert.equal(done.outputs[0].value, "ok"); assert.deepEqual(calls, ["first", "last"]);
});

test("AI预检后发布新版本不漂移；历史快照可固定，过期快照明确冲突", async t => {
  const h = await aiHarness(t);
  await h.scenes.prepare("demo", "version-a", {});
  const original = await h.workspace.get(); const desired = aiWorkspace();
  const versionA = desired.sceneVersions.demo.versions[0];
  desired.sceneVersions.demo.versions.push({ ...structuredClone(versionA), id: "version-b", version: "bbbbbbbb", workflow: { ...versionA.workflow, name: "第二版" } }); desired.sceneVersions.demo.publishedVersionId = "version-b";
  await h.workspace.merge(original, desired);
  assert.equal((await h.scenes.get("demo")).versionId, "version-b");
  assert.equal((await post(h.base, "/api/v1/scenes/demo/runs", { versionId: "version-a", inputValues: {}, runId: id("pinned-old-version") })).status, 202);
  const run = await h.service.wait(h.settings.projectDirectory, id("pinned-old-version")); assert.notEqual(run.workflowName, "第二版");
  const base = await h.workspace.get(); desired.sceneVersions.demo.versions.shift(); await h.workspace.merge(base, desired);
  const rejected = await post(h.base, "/api/v1/scenes/demo/runs", { versionId: "version-a", inputValues: {}, runId: id("removed-old-version") }); assert.equal(rejected.status, 409); assert.equal((await rejected.json() as { code: string }).code, "SCENE_VERSION_UNAVAILABLE");
});

test("AI预检拒绝无效素材版本、缺失能力与能力版本变化，不创建运行", async t => {
  const h = await aiHarness(t);
  const base = await h.workspace.get(); const desired = aiWorkspace();
  const version = desired.sceneVersions.demo.versions[0];
  version.workflow.inputs.push({ key: "images", type: "image_list", required: true } as typeof version.workflow.inputs[number]);
  await h.workspace.merge(base, desired);
  const bad = await post(h.base, "/api/v1/scenes/demo/prepare", { versionId: "version-a", inputValues: { images: [{ assetId: "absent", assetVersion: 1 }] } }); assert.equal(bad.status, 400); assert.equal((await bad.json() as { code: string }).code, "INVALID_ASSET_REFERENCE");
  const base2 = await h.workspace.get(); version.workflow.inputs.pop(); version.workflow.steps[0].capabilityId = "absent.capability"; await h.workspace.merge(base2, desired);
  const capability = await post(h.base, "/api/v1/scenes/demo/prepare", { versionId: "version-a", inputValues: {} }); assert.equal(capability.status, 400); assert.equal((await capability.json() as { code: string }).code, "UNSUPPORTED_CAPABILITY");
  const installed = h.executors.definitions().find(item => item.legacy.kind === "hermes")!;
  const base3 = await h.workspace.get(); version.workflow.steps[0] = { ...version.workflow.steps[0], kind: installed.legacy.kind, capabilityId: installed.id, capabilityVersion: "not-installed" }; await h.workspace.merge(base3, desired);
  const mismatch = await post(h.base, "/api/v1/scenes/demo/prepare", { versionId: "version-a", inputValues: {} }); assert.equal(mismatch.status, 409); assert.equal((await mismatch.json() as { code: string }).code, "CAPABILITY_VERSION_MISMATCH");
  assert.equal(h.store.listRuns(h.settings.projectDirectory).runs.length, 0);
});

test("有界等待超时/断开只释放订阅，不取消后台运行；事件历史分页连续", async t => {
  const gate = deferred<void>(); t.after(() => gate.resolve());
  const h = await aiHarness(t, { executor: { kind: "fake", async execute() { await gate.promise; return { value: "ok" }; } } });
  const runId = id("ai-wait-window"); await post(h.base, "/api/v1/scenes/demo/runs", { versionId: "version-a", inputValues: {}, runId });
  const immediate = await (await fetch(h.base + "/api/v1/runs/" + runId + "/wait?timeoutSeconds=0")).json() as { timedOut: boolean }; assert.equal(immediate.timedOut, true);
  assert.equal((await fetch(h.base + "/api/v1/runs/" + runId + "/wait?timeoutSeconds=31")).status, 400);
  const timeout = await (await fetch(h.base + "/api/v1/runs/" + runId + "/wait?timeoutSeconds=1")).json() as { timedOut: boolean; status: string }; assert.equal(timeout.timedOut, true); assert.equal(timeout.status, "running");
  assert.equal(h.service.metrics().subscribers, 0);
  const controller = new AbortController(); const disconnect = fetch(h.base + "/api/v1/runs/" + runId + "/wait?timeoutSeconds=30", { signal: controller.signal }).catch(() => undefined);
  await until(() => h.service.metrics().subscribers > 0); controller.abort(); await disconnect; await until(() => h.service.metrics().subscribers === 0);
  assert.equal((await h.service.getRun(h.settings.projectDirectory, runId))?.status, "running");
  gate.resolve(); await h.service.wait(h.settings.projectDirectory, runId);
  let after = 0; let more = true; const seen: number[] = [];
  while (more) { const page = await (await fetch(h.base + "/api/v1/runs/" + runId + "/events/history?after=" + after + "&limit=1")).json() as { events: Array<{ sequence: number }>; nextSequence: number; hasMore: boolean }; assert.ok(page.events.length <= 1); seen.push(...page.events.map(event => event.sequence)); after = page.nextSequence; more = page.hasMore; }
  assert.deepEqual(seen, h.store.events(h.settings.projectDirectory, runId).map(event => event.sequence));
  assert.equal((await fetch(h.base + "/api/v1/runs/" + runId + "/events/history?limit=0")).status, 400);
});
