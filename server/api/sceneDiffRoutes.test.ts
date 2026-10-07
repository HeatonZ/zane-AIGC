import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { aiHarness } from "../testing/aiSupport.js";
import { sceneDiffPageSchema, sceneDiffValuePageSchema } from "../ai/sceneDiffSchemas.js";
import { asRecord } from "../domain/workflowValues.js";
import type { SceneDiffPage, SceneDiffValuePage } from "../domain/sceneDiffContracts.js";
async function read<T>(base: string, route: string): Promise<T> {
  const response = await fetch(base + route); assert.equal(response.status, 200, await response.clone().text()); return response.json() as Promise<T>;
}
const route = "/api/v1/scenes/demo/draft/diff";

test("HTTP diff：当前发布快照而非上一版本，关联预设固定、内容哈希核对、分页/值契约且只读", async t => {
  let executed = 0;
  const h = await aiHarness(t, { executor: { kind: "fake", async execute() { executed++; return { value: "unexpected" }; } } });
  const before = await h.workspace.get();
  const first = await read<SceneDiffPage>(h.base, route + "?limit=1&valueLimit=2");
  assert.equal(sceneDiffPageSchema.safeParse(first).success, true);
  assert.equal(first.baseline?.versionId, "version-a"); assert.equal(first.hasChanges, true);
  assert.equal(first.changes.length, 1); assert.ok(first.hasMore); assert.ok(first.total >= 3);
  const pages = [...first.changes]; let current = first;
  while (current.nextCursor) {
    current = await read<SceneDiffPage>(h.base, route + "?limit=1&revision=" + first.revision + "&cursor=" + current.nextCursor);
    assert.equal(current.revision, first.revision); pages.push(...current.changes);
  }
  assert.equal(pages.length, first.total); assert.equal(new Set(pages.map(item => item.changeId)).size, first.total);
  const preset = pages.find(item => item.path === "/optionPresets/style-options/options")!;
  assert.ok(preset.before.text.includes("已发布值")); assert.ok(preset.after.text.includes("草稿值"));
  const change = first.changes[0], side = change.before.complete ? "after" : "before";
  const value = await read<SceneDiffValuePage>(h.base, route + "/value?" + new URLSearchParams({ revision: first.revision, changeId: change.changeId, side, offset: "0", limit: "2" }));
  assert.equal(sceneDiffValuePageSchema.safeParse(value).success, true); assert.equal(value.value.complete, false);
  const all = await read<SceneDiffPage>(h.base, route + "?contentHash=" + first.contentHash);
  assert.equal(all.revision, first.revision);
  assert.deepEqual(await h.workspace.get(), before); assert.equal(executed, 0); assert.equal(h.store.listRuns(h.settings.projectDirectory).runs.length, 0);
  // Lost read response: retry the same revision, no extra side effects.
  assert.deepEqual(await read<SceneDiffPage>(h.base, route + "?revision=" + first.revision), all);
});

test("HTTP diff：无关场景/预设不失效，草稿/当前发布变化后旧revision/游标/值读取409", async t => {
  const h = await aiHarness(t);
  const first = await read<SceneDiffPage>(h.base, route + "?limit=1");
  const other = await h.scenes.drafts.get("unpublished");
  await h.scenes.drafts.update("unpublished", { revision: other.revision, scene: { id: "unpublished", title: "无关改动" } });
  await h.scenes.drafts.savePreset({ id: "unused", name: "未引用", options: ["忽略"] });
  assert.equal((await read<SceneDiffPage>(h.base, route + "?revision=" + first.revision)).revision, first.revision);
  const draft = await h.scenes.drafts.get("demo");
  await h.scenes.drafts.update("demo", { revision: draft.revision, scene: { id: "demo", title: "已改变" } });
  for (const query of ["?revision=" + first.revision, "?cursor=" + first.nextCursor, "/value?revision=" + first.revision + "&changeId=" + first.changes[0].changeId + "&side=before"]) {
    const response = await fetch(h.base + route + query); assert.equal(response.status, 409); assert.equal((await response.json()).code, "SCENE_DIFF_CHANGED");
  }
  const newDraft = await h.scenes.drafts.get("demo");
  const beforePublish = await read<SceneDiffPage>(h.base, route);
  const ws = await h.workspace.get(); const next = structuredClone(ws!);
  // Change only the publication pointer to an existing second snapshot.
  const record = asRecord(asRecord(next.sceneVersions)?.demo)!;
  const old = structuredClone((record.versions as Array<Record<string, unknown>>)[0]);
  old.id = "version-b"; record.versions = [...record.versions as unknown[], old]; record.publishedVersionId = "version-b";
  await h.workspace.merge(ws, next);
  const stale = await fetch(h.base + route + "?revision=" + beforePublish.revision); assert.equal(stale.status, 409);
  assert.equal((await read<SceneDiffPage>(h.base, route)).baseline?.versionId, "version-b");
  assert.equal(newDraft.scene.title, "已改变");
});

test("HTTP diff：无效参数/跨场景游标/未知值/越界拒绝；服务端未初始化不补默认", async t => {
  const h = await aiHarness(t);
  for (const suffix of ["?limit=0", "?limit=101", "?limit=1.5", "?valueLimit=0", "?valueLimit=32769", "?revision=bad", "?contentHash=no", "?unknown=yes", "?cursor=not-json", "?limit=1&limit=2"]) {
    assert.equal((await fetch(h.base + route + suffix)).status, 400, suffix);
  }
  const first = await read<SceneDiffPage>(h.base, route + "?limit=1");
  assert.equal((await fetch(h.base + "/api/v1/scenes/unpublished/draft/diff?cursor=" + first.nextCursor)).status, 400);
  const mismatch = await fetch(h.base + route + "?contentHash=00000000"); assert.equal(mismatch.status, 409); assert.equal((await mismatch.json()).code, "SCENE_DRAFT_CHANGED");
  const args = "?revision=" + first.revision + "&changeId=" + first.changes[0].changeId + "&side=before";
  assert.equal((await fetch(h.base + route + "/value" + args + "&offset=999999")).status, 400);
  assert.equal((await fetch(h.base + route + "/value" + args.replace(first.changes[0].changeId, "0".repeat(24)))).status, 404);
  assert.equal((await fetch(h.base + route + "/value?side=before")).status, 400);
  assert.equal((await fetch(h.base + "/api/v1/scenes/missing/draft/diff")).status, 404);
  const empty = await aiHarness(t, { emptyWorkspace: true });
  assert.equal((await fetch(empty.base + route)).status, 409); assert.ok(!await empty.workspace.get());
});

test("发布能力固定不虚报差异；未发布空基线，损坏基线不静默忽略", async t => {
  const h = await aiHarness(t);
  const made = await h.scenes.drafts.create({ scene: { id: "local", title: "条件" }, workflow: { inputs: [{ key: "flag", type: "boolean", defaultValue: true }], steps: [{ id: "condition", name: "判断", kind: "control", control: { type: "condition", match: "all", rules: [{ id: "rule", leftRef: "input.flag", operator: "equals", valueSource: "literal", rightValue: "true" }] }, outputs: [{ key: "result", type: "boolean" }] }], outputs: [{ key: "result", type: "boolean", sourceRef: "step.condition.outputs.result" }] } });
  const url = "/api/v1/scenes/local/draft/diff";
  const unpublished = await read<SceneDiffPage>(h.base, url); assert.equal(unpublished.baseline, null); assert.ok(unpublished.changes.every(item => item.kind === "added"));
  // Browser/legacy publication without capability pins must also show no drift.
  const legacyBase = await h.workspace.get(), legacyNext = structuredClone(legacyBase!);
  const legacyRecord = asRecord(asRecord(legacyNext.sceneVersions)?.local)!;
  const legacyId = randomUUID();
  legacyRecord.publishedVersionId = legacyId;
  legacyRecord.versions = [{ id: legacyId, version: made.contentHash, publishedAt: new Date().toISOString(), scene: made.scene, workflow: made.workflow, optionPresets: made.optionPresets }];
  await h.workspace.merge(legacyBase, legacyNext);
  assert.equal((await read<SceneDiffPage>(h.base, url)).total, 0);
  const legacyDraft = await h.scenes.drafts.get("local");
  await h.scenes.drafts.publish("local", legacyDraft.revision, randomUUID());
  const matched = await read<SceneDiffPage>(h.base, url); assert.equal(matched.total, 0); assert.equal(matched.hasChanges, false); assert.deepEqual(matched.preparationWarnings, []);
  const draft = await h.scenes.drafts.get("local");
  await h.scenes.drafts.update("local", { revision: draft.revision, workflow: { ...draft.workflow!, inputs: [{ ...((draft.workflow!.inputs as Array<Record<string, unknown>>)[0]), label: "新标签" }] } as never });
  const changed = await read<SceneDiffPage>(h.base, url); assert.equal(changed.total, 1); assert.equal(changed.changes[0].path, "/workflow/inputs/flag/label");
  const ws = await h.workspace.get(); const next = structuredClone(ws!); asRecord(asRecord(next.sceneVersions)?.local)!.publishedVersionId = "missing-version";
  await h.workspace.merge(ws, next);
  const broken = await fetch(h.base + url); assert.equal(broken.status, 409); assert.equal((await broken.json()).code, "SCENE_VERSION_UNAVAILABLE");
});

test("大值预算/Unicode续读；无效能力仍可只读预览警告", async t => {
  const h = await aiHarness(t);
  const long = "😀长提示词\n".repeat(12000);
  const draft = await h.scenes.drafts.get("demo");
  const wf = structuredClone(draft.workflow!);
  (wf.steps as Array<Record<string, unknown>>).forEach(step => { step.promptTemplate = long; step.kind = "not-installed"; });
  await h.scenes.drafts.update("demo", { revision: draft.revision, workflow: wf as never });
  const first = await read<SceneDiffPage>(h.base, route + "?valueLimit=32768");
  assert.ok(first.preparationWarnings.length); assert.equal(first.valueBudgetChars, 65536);
  assert.ok(first.changes.reduce((count, item) => count + Array.from(item.before.text).length + Array.from(item.after.text).length, 0) <= 65536);
  assert.equal(first.hasMore, true);
  const prompt = first.changes.find(item => item.path.endsWith("/promptTemplate"))!;
  assert.equal(prompt.after.complete, false);
  let text = prompt.after.text, offset = prompt.after.nextOffset;
  while (offset !== null) {
    const page = await read<SceneDiffValuePage>(h.base, route + "/value?" + new URLSearchParams({ revision: first.revision, changeId: prompt.changeId, side: "after", offset: String(offset), limit: "32768" }));
    text += page.value.text; offset = page.value.nextOffset;
  }
  assert.equal(text, long);
  const next = await read<SceneDiffPage>(h.base, route + "?cursor=" + first.nextCursor + "&revision=" + first.revision); assert.ok(next.changes.length > 0);
});
