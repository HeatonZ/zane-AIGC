import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { aiHarness } from "../testing/aiSupport.js";
import { asRecord } from "../domain/workflowValues.js";
import { sceneVersionHash } from "../../src/lib/sceneVersions.js";
import { sceneContentHash, sceneContent } from "../domain/sceneContent.js";
import type { SceneModule, WorkflowDefinition, WorkflowOptionPreset } from "../../src/types.js";
const request = (base: string, route: string, body: unknown, method = "POST") => fetch(base + route, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const read = async (base: string, route: string) => { const response = await fetch(base + route); assert.equal(response.status, 200); return response.json() as Promise<Record<string, any>>; };
const flow = (name = "新业务") => ({ name, inputs: [{ key: "subject", type: "text", required: true, defaultValue: "测试输入" }], steps: [{ id: "first", name: "本地测试", kind: "fake", outputs: [{ key: "value", type: "text" }] }], outputs: [{ key: "result", label: "结果", type: "text", sourceRef: "step.first.outputs.value" }] });

test("AI单场景创建/读取/修改：不搬整工作区、不发布、不改变其他场景", async t => {
  const h = await aiHarness(t); const before = structuredClone((await h.workspace.get())!);
  const created = await request(h.base, "/api/v1/scenes", { scene: { id: "new-business", title: "新业务" }, workflow: flow() });
  assert.equal(created.status, 201); const draft = await created.json() as Record<string, any>;
  assert.equal(draft.publishedVersionId, null); assert.equal(draft.revision.length, 64); assert.deepEqual(draft.scene.stages, []); assert.ok(!("scenes" in draft));
  assert.equal((await fetch(h.base + "/api/v1/scenes/new-business")).status, 409);
  const duplicate = await request(h.base, "/api/v1/scenes", { scene: { id: "new-business", title: "新业务" }, workflow: flow() });
  assert.equal(duplicate.status, 409); assert.equal((await duplicate.json() as { code: string }).code, "SCENE_ALREADY_EXISTS");
  const update = await request(h.base, "/api/v1/scenes/new-business/draft", { revision: draft.revision, scene: { ...draft.scene, title: "更新标题" } }, "PATCH");
  assert.equal(update.status, 200); const changed = await update.json() as Record<string, any>; assert.notEqual(changed.revision, draft.revision); assert.equal(changed.workflow.name, "新业务");
  const after = (await h.workspace.get())!;
  assert.deepEqual((after.scenes as Array<Record<string, unknown>>).filter(scene => scene.id !== "new-business"), before.scenes);
  assert.deepEqual(asRecord(after.workflows)?.demo, asRecord(before.workflows)?.demo);
  assert.deepEqual(after.optionPresets, before.optionPresets); assert.deepEqual(asRecord(after.sceneVersions)?.demo, asRecord(before.sceneVersions)?.demo);
  assert.equal(h.store.listRuns(h.settings.projectDirectory).runs.length, 0);
});

test("AI单场景revision：允许无关场景并发，拒绝同场景/共享预设变化并返回明细", async t => {
  const h = await aiHarness(t); const draft = await read(h.base, "/api/v1/scenes/demo/draft");
  let base = (await h.workspace.get())!; let desired = structuredClone(base);
  (desired.scenes as Array<Record<string, unknown>>)[1].title = "其他设备编辑";
  await h.workspace.merge(base, desired);
  const accepted = await request(h.base, "/api/v1/scenes/demo/draft", { revision: draft.revision, scene: { ...draft.scene, title: "我的改动" } }, "PATCH");
  assert.equal(accepted.status, 200); const next = await accepted.json() as Record<string, any>;
  base = (await h.workspace.get())!; desired = structuredClone(base); (desired.scenes as Array<Record<string, unknown>>)[0].summary = "另一个设备的新内容"; await h.workspace.merge(base, desired);
  const rejected = await request(h.base, "/api/v1/scenes/demo/draft", { revision: next.revision, scene: { ...next.scene, title: "不应覆盖" } }, "PATCH");
  assert.equal(rejected.status, 409); const error = await rejected.json() as Record<string, any>; assert.equal(error.code, "RESOURCE_REVISION_CONFLICT"); assert.equal(error.details.nextAction, "read_current_resource"); assert.ok(error.details.conflicts.length);
  const current = await read(h.base, "/api/v1/scenes/demo/draft");
  const presetPage = await read(h.base, "/api/v1/option-presets"); const preset = presetPage.presets[0];
  assert.equal((await request(h.base, "/api/v1/option-presets", { revision: preset.revision, preset: { id: preset.id, name: preset.name, options: ["新共享选项"] } })).status, 200);
  const conflict = await request(h.base, "/api/v1/scenes/demo/validate", { revision: current.revision }); assert.equal(conflict.status, 409);
  assert.equal((await h.scenes.get("demo")).workflow.inputs[1].options?.[0], "已发布值");
});

test("AI发布：服务端哈希、固定快照、同publicationId去重、旧请求不重指向当前发布版", async t => {
  const h = await aiHarness(t);
  let response = await request(h.base, "/api/v1/scenes", { scene: { id: "publish-test", title: "发布测试" }, workflow: flow() }); const draft = await response.json() as Record<string, any>;
  response = await request(h.base, "/api/v1/scenes/publish-test/validate", { revision: draft.revision }); assert.equal(response.status, 200); assert.equal((await response.json() as { externalServicesChecked: boolean }).externalServicesChecked, false);
  const publicationId = randomUUID(); const publish = { revision: draft.revision, publicationId };
  response = await request(h.base, "/api/v1/scenes/publish-test/publish", publish); assert.equal(response.status, 201); const first = await response.json() as Record<string, any>; assert.equal(first.versionId, publicationId); assert.match(first.version, /^[a-f0-9]{8}$/);
  const snapshot = await read(h.base, "/api/v1/scenes/publish-test"); const stored = ((await h.workspace.get()) as any).sceneVersions["publish-test"].versions[0]; assert.equal(snapshot.version, sceneContentHash(sceneContent(stored.scene, stored.workflow, stored.optionPresets)));
  const revision = (await h.workspace.get())!.revision;
  response = await request(h.base, "/api/v1/scenes/publish-test/publish", publish); assert.equal(response.status, 200); assert.equal((await response.json() as { created: boolean }).created, false); assert.equal((await h.workspace.get())!.revision, revision);
  let current = await read(h.base, "/api/v1/scenes/publish-test/draft");
  response = await request(h.base, "/api/v1/scenes/publish-test/draft", { revision: current.revision, workflow: { ...current.workflow, name: "新版业务" } }, "PATCH"); current = await response.json() as Record<string, any>;
  const secondId = randomUUID(); response = await request(h.base, "/api/v1/scenes/publish-test/publish", { revision: current.revision, publicationId: secondId }); assert.equal(response.status, 201);
  response = await request(h.base, "/api/v1/scenes/publish-test/publish", publish); assert.equal(response.status, 200); assert.equal((await response.json() as { isCurrentPublished: boolean }).isCurrentPublished, false);
  assert.equal((await read(h.base, "/api/v1/scenes/publish-test")).versionId, secondId);
  assert.notEqual((await read(h.base, "/api/v1/scenes/publish-test?versionId=" + publicationId)).workflow.name, "新版业务");
  current = await read(h.base, "/api/v1/scenes/publish-test/draft"); response = await request(h.base, "/api/v1/scenes/publish-test/publish", { revision: current.revision, publicationId }); assert.equal(response.status, 409); assert.equal((await response.json() as { code: string }).code, "PUBLICATION_ID_CONFLICT");
  assert.equal(h.store.listRuns(h.settings.projectDirectory).runs.length, 0);
});

test("AI草稿校验：结构/引用/能力错误不发布、不执行，参数保留编辑器元数据", async t => {
  const h = await aiHarness(t);
  const invalid = flow(); invalid.outputs[0].sourceRef = "step.missing.outputs.value";
  let response = await request(h.base, "/api/v1/scenes", { scene: { id: "invalid-test", title: "错误测试", customMetadata: { source: "user" } }, workflow: invalid }); assert.equal(response.status, 201);
  let draft = await response.json() as Record<string, any>; assert.deepEqual(draft.scene.customMetadata, { source: "user" });
  response = await request(h.base, "/api/v1/scenes/invalid-test/publish", { revision: draft.revision, publicationId: randomUUID() }); assert.equal(response.status, 400); assert.equal((await response.json() as { code: string }).code, "INVALID_WORKFLOW_REFERENCE");
  const unsupported = flow(); unsupported.steps[0].kind = "not-installed";
  response = await request(h.base, "/api/v1/scenes/invalid-test/draft", { revision: draft.revision, workflow: unsupported }, "PATCH"); draft = await response.json() as Record<string, any>;
  response = await request(h.base, "/api/v1/scenes/invalid-test/validate", { revision: draft.revision }); assert.equal(response.status, 400); assert.equal((await response.json() as { code: string }).code, "UNSUPPORTED_CAPABILITY");
  assert.equal((await read(h.base, "/api/v1/scenes/invalid-test/draft")).publishedVersionId, null);
  assert.equal((await request(h.base, "/api/v1/scenes/invalid-test/draft", { revision: draft.revision, workflow: { ...flow(), sceneId: "other" } }, "PATCH")).status, 400);
  assert.equal(h.store.listRuns(h.settings.projectDirectory).runs.length, 0);
});

test("AI恢复发布版：冲突预设克隆重映射，不改共享预设或发布指针", async t => {
  const h = await aiHarness(t); const original = await read(h.base, "/api/v1/scenes/demo/draft");
  const response = await request(h.base, "/api/v1/scenes/demo/restore", { revision: original.revision, versionId: "version-a" }); assert.equal(response.status, 200);
  const restored = await response.json() as Record<string, any>; assert.equal(restored.createdPresetIds.length, 1); assert.notEqual(restored.workflow.inputs[1].optionPresetId, "style-options"); assert.equal(restored.publishedVersionId, "version-a");
  const presets = await read(h.base, "/api/v1/option-presets"); assert.deepEqual(presets.presets.find((item: any) => item.id === "style-options").options, ["草稿值"]);
  assert.deepEqual(presets.presets.find((item: any) => item.id === restored.workflow.inputs[1].optionPresetId).options, ["已发布值"]);
  assert.equal((await request(h.base, "/api/v1/scenes/demo/validate", { revision: restored.revision })).status, 200);
});

test("AI删除场景：revision保护，保留运行、素材与无关场景", async t => {
  const h = await aiHarness(t); const run = await h.service.submit({ runId: randomUUID(), workflow: (await h.scenes.prepare("demo", "version-a", {})).workflow, inputValues: { flag: false, style: "已发布值" } }); await h.service.wait(h.settings.projectDirectory, run.runId);
  const draft = await read(h.base, "/api/v1/scenes/demo/draft");
  const response = await request(h.base, "/api/v1/scenes/demo", { revision: draft.revision }, "DELETE"); assert.equal(response.status, 200);
  assert.ok(await h.service.getRun(h.settings.projectDirectory, run.runId)); assert.equal((await fetch(h.base + "/api/v1/scenes/demo/draft")).status, 404);
  assert.equal((await h.workspace.get())!.scenes instanceof Array, true); assert.equal((await read(h.base, "/api/v1/scenes")).scenes[0].sceneId, "unpublished");
});

test("AI共享预设：分页、创建更新revision、引用保护、发布快照隔离", async t => {
  const h = await aiHarness(t);
  assert.equal((await request(h.base, "/api/v1/option-presets", { preset: { id: "unused-a", name: "未使用A", options: ["a"] } })).status, 200);
  assert.equal((await request(h.base, "/api/v1/option-presets", { preset: { id: "unused-b", name: "未使用B", options: ["b"] } })).status, 200);
  const first = await read(h.base, "/api/v1/option-presets?limit=1"); assert.equal(first.presets.length, 1); assert.equal(first.hasMore, true);
  const second = await read(h.base, "/api/v1/option-presets?limit=1&cursor=" + encodeURIComponent(first.nextCursor)); assert.notEqual(second.presets[0].id, first.presets[0].id);
  const style = (await read(h.base, "/api/v1/option-presets?q=style-options")).presets[0];
  let response = await request(h.base, "/api/v1/option-presets/style-options", { revision: style.revision }, "DELETE"); assert.equal(response.status, 409); assert.deepEqual((await response.json() as Record<string, any>).details.sceneIds, ["demo"]);
  response = await request(h.base, "/api/v1/option-presets", { preset: { id: style.id, name: style.name, options: ["不能无revision覆盖"] } }); assert.equal(response.status, 409);
  const unused = (await read(h.base, "/api/v1/option-presets?q=unused-a")).presets[0]; response = await request(h.base, "/api/v1/option-presets/unused-a", { revision: unused.revision }, "DELETE"); assert.equal(response.status, 200);
  assert.equal((await h.scenes.get("demo")).workflow.inputs[1].options?.[0], "已发布值");
});

test("服务端发布内容哈希与现有UI完全兼容（键顺序、中文、关联预设）", () => {
  const scene = { id: "parity", title: "业务🧪", shortTitle: "业务", summary: "", description: "", cover: "", accent: "green", stages: [] } as SceneModule;
  const workflow = { ...flow(), sceneId: scene.id, inputs: [{ key: "style", type: "select", optionPresetId: "preset", options: ["旧值"], required: true }] } as unknown as WorkflowDefinition;
  const presets: WorkflowOptionPreset[] = [{ id: "unrelated", name: "无关", options: ["x"] }, { id: "preset", name: "风格", options: ["写实"] }];
  assert.equal(sceneContentHash(sceneContent(scene as unknown as Record<string, unknown>, workflow as unknown as Record<string, unknown>, presets)), sceneVersionHash(scene, workflow, presets));
});


test("AI同revision同时写入：一个成功一个冲突，不能丢失已接受编辑", async t => {
  const h = await aiHarness(t); const draft = await read(h.base, "/api/v1/scenes/demo/draft");
  const responses = await Promise.all(["并发A", "并发B"].map(title => request(h.base, "/api/v1/scenes/demo/draft", { revision: draft.revision, scene: { ...draft.scene, title } }, "PATCH")));
  assert.deepEqual(responses.map(response => response.status).sort(), [200, 409]);
  const winner = await responses.find(response => response.status === 200)!.json() as Record<string, any>;
  assert.equal((await read(h.base, "/api/v1/scenes/demo/draft")).scene.title, winner.scene.title);
});

test("AI极简工作流补全UI必要字段，预设禁止存回派生revision/引用关系", async t => {
  const h = await aiHarness(t); const minimal = flow(); const { name: _name, ...definition } = minimal;
  const response = await request(h.base, "/api/v1/scenes", { scene: { id: "minimal", title: "极简场景" }, workflow: definition });
  assert.equal(response.status, 201); const draft = await response.json() as Record<string, any>;
  assert.equal(draft.workflow.name, "minimal"); assert.equal(draft.workflow.steps[0].promptTemplate, "");
  const derived = { id: "invalid-preset", name: "不允许持久化派生字段", options: ["a"], revision: draft.revision, usedBySceneIds: ["demo"] };
  assert.equal((await request(h.base, "/api/v1/option-presets", { preset: derived })).status, 400);
  assert.equal((await read(h.base, "/api/v1/option-presets?q=invalid-preset")).presets.length, 0);
});

test("AI发布保持最近10版，重复旧回执不回退当前指针，过期ID不伪装永久幂等", async t => {
  const h = await aiHarness(t);
  let draft = await (await request(h.base, "/api/v1/scenes", { scene: { id: "retention", title: "保留策略" }, workflow: flow() })).json() as Record<string, any>;
  const requests: Array<{ revision: string; publicationId: string }> = [];
  for (let index = 0; index < 11; index++) {
    const body = { revision: draft.revision, publicationId: randomUUID() }; requests.push(body);
    assert.equal((await request(h.base, "/api/v1/scenes/retention/publish", body)).status, 201);
    draft = await read(h.base, "/api/v1/scenes/retention/draft");
  }
  assert.equal(draft.versions.length, 10); assert.equal(draft.publishedVersionId, requests[10].publicationId);
  assert.equal((await request(h.base, "/api/v1/scenes/retention/publish", requests[1])).status, 200);
  assert.equal((await read(h.base, "/api/v1/scenes/retention/draft")).publishedVersionId, requests[10].publicationId);
  assert.equal((await request(h.base, "/api/v1/scenes/retention/publish", requests[0])).status, 409);
  const missing = await fetch(h.base + "/api/v1/scenes/retention?versionId=" + requests[0].publicationId);
  assert.equal(missing.status, 409); assert.equal((await missing.json() as { code: string }).code, "SCENE_VERSION_UNAVAILABLE");
});


test("AI直接创建首个场景：原子初始化空工作区，不要求先传全量模板", async t => {
  const h = await aiHarness(t, { emptyWorkspace: true }); assert.equal(await h.workspace.get(), undefined);
  const response = await request(h.base, "/api/v1/scenes", { scene: { id: "first-scene", title: "首次业务" }, workflow: flow() });
  assert.equal(response.status, 201); const draft = await response.json() as Record<string, any>;
  assert.equal(draft.publishedVersionId, null); assert.equal((await h.workspace.get())!.format, "zane-studio.workspace/v1");
  assert.equal((await request(h.base, "/api/v1/scenes/first-scene/validate", { revision: draft.revision })).status, 200);
  assert.equal(h.store.listRuns(h.settings.projectDirectory).runs.length, 0);
});


test("HTTP场景标题独立于流程名；改名须显式发布且固定版本及丢失回执对账不改历史", async t => {
  const h = await aiHarness(t);
  const sceneId = "reference-title-regression";
  const route = "/api/v1/scenes/" + sceneId;
  const created = await request(h.base, "/api/v1/scenes", {
    scene: { id: sceneId, title: "AI参考生视频" }, workflow: flow("AI文生视频流程"),
  });
  assert.equal(created.status, 201);
  const draft = await created.json() as Record<string, any>;
  const publicationId = randomUUID();
  const publishArgs = { revision: draft.revision, publicationId };
  assert.equal((await request(h.base, route + "/publish", publishArgs)).status, 201);
  const original = await (await fetch(h.base + route + "?versionId=" + publicationId)).json() as Record<string, any>;
  assert.equal(original.scene.title, "AI参考生视频");
  assert.equal(original.workflow.name, "AI文生视频流程");
  const publishedDraft = await (await fetch(h.base + route + "/draft")).json() as Record<string, any>;
  const changed = await request(h.base, route + "/draft", {
    revision: publishedDraft.revision, scene: { ...publishedDraft.scene, title: "参考生视频新标题" },
  }, "PATCH");
  assert.equal(changed.status, 200);
  const renamed = await changed.json() as Record<string, any>;
  assert.equal(renamed.scene.title, "参考生视频新标题");
  assert.equal(renamed.workflow.name, original.workflow.name);
  assert.equal(renamed.draftMatchesPublished, false);
  assert.equal((await request(h.base, route + "/draft", { revision: publishedDraft.revision, scene: publishedDraft.scene }, "PATCH")).status, 409);
  assert.equal((await request(h.base, route + "/draft", { revision: renamed.revision, scene: { id: sceneId, title: 42 } }, "PATCH")).status, 400);
  const catalog = await (await fetch(h.base + "/api/v1/scenes?limit=200")).json() as Record<string, any>;
  const item = catalog.scenes.find((item: any) => item.sceneId === sceneId);
  assert.equal(item.title, renamed.scene.title);
  assert.equal(item.publishedTitle, original.scene.title);
  const beforeRepublish = await (await fetch(h.base + route)).json() as Record<string, any>;
  assert.equal(beforeRepublish.versionId, original.versionId);
  assert.deepEqual(beforeRepublish.scene, original.scene);
  assert.deepEqual(beforeRepublish.workflow, original.workflow);
  const renamedPublicationId = randomUUID();
  assert.equal((await request(h.base, route + "/publish", { revision: renamed.revision, publicationId: renamedPublicationId })).status, 201);
  const current = await (await fetch(h.base + route)).json() as Record<string, any>;
  assert.equal(current.scene.title, renamed.scene.title);
  assert.equal(current.workflow.name, original.workflow.name);
  const replay = await (await request(h.base, route + "/publish", publishArgs)).json() as Record<string, any>;
  assert.equal(replay.created, false);
  assert.equal(replay.isCurrentPublished, false);
  assert.equal((await (await fetch(h.base + route)).json() as Record<string, any>).versionId, renamedPublicationId);
  const historical = await (await fetch(h.base + route + "?versionId=" + publicationId)).json() as Record<string, any>;
  assert.deepEqual(historical.scene, original.scene);
  assert.deepEqual(historical.workflow, original.workflow);
});
