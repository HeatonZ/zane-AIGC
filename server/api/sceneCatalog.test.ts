import assert from "node:assert/strict";
import test from "node:test";
import { aiHarness } from "../testing/aiSupport.js";
import { HttpError } from "../errors.js";
import { randomUUID } from "node:crypto";
import { sceneDraftMatchesVersion } from "../../src/lib/sceneVersions";
import { readAuthoritativeWorkspace } from "../../src/lib/workspaceSync";
import type { SceneVersion } from "../../src/types";

const json = async (base: string, route: string) => { const response = await fetch(base + route); return { response, body: await response.json() as Record<string, any> }; };

test("网页权威快照、HTTP场景目录和草稿/发布对象同源；草稿改名不偷换发布版，读取不改变revision", async t => {
  const h = await aiHarness(t);
  const before = await h.workspace.get();
  const draft = await h.scenes.drafts.get("demo");
  const edited = await h.scenes.drafts.update("demo", { revision: draft.revision, scene: { id: "demo", title: "新的草稿名称" } });
  const current = readAuthoritativeWorkspace(await h.workspace.get());
  const catalog = await json(h.base, "/api/v1/scenes?limit=200");
  const authority = await json(h.base, "/api/workspace/status");
  assert.equal(catalog.response.headers.get("cache-control"), "no-store"); assert.equal(authority.response.headers.get("cache-control"), "no-store");
  assert.equal(authority.body.workspaceRevision, current.revision); assert.equal(catalog.body.workspaceRevision, current.revision);
  assert.deepEqual(catalog.body.scenes.map((item: any) => item.sceneId), current.scenes.map(item => item.id));
  const item = catalog.body.scenes[0]; const published = await h.scenes.get("demo");
  assert.equal(item.title, current.scenes[0].title); assert.equal(item.title, "新的草稿名称"); assert.equal(item.publishedTitle, "测试场景"); assert.equal(item.publishedTitle, (published.scene as any).title);
  assert.equal(item.draftRevision, edited.revision); assert.equal(item.draftMatchesPublished, edited.draftMatchesPublished); assert.equal(item.draftMatchesPublished, false);
  assert.equal(edited.view, "draft"); assert.equal(published.view, "published");
  assert.deepEqual((await h.workspace.get())?.sceneVersions, before?.sceneVersions);
  assert.equal((await h.workspace.get())?.revision, current.revision);
});

test("场景目录按权威排序分页，50默认/200上限边界；参数与跨页revision冲突不被静默忽略", async t => {
  const h = await aiHarness(t, { emptyWorkspace: true });
  await h.workspace.initialize({ format: "zane-studio.workspace/v1", scenes: Array.from({ length: 203 }, (_, index) => ({ id: "s" + index, title: "场景" + index })), workflows: {}, optionPresets: [], drafts: [], sceneVersions: {} });
  const first = await h.scenes.list(); assert.equal(first.scenes.length, 50); assert.equal(first.total, 203); assert.equal(first.hasMore, true);
  const second = await h.scenes.list({ limit: 200, cursor: first.nextCursor }); assert.equal(second.scenes.length, 153); assert.equal(second.hasMore, false); assert.equal(second.nextCursor, undefined);
  assert.deepEqual([...first.scenes, ...second.scenes].map(item => item.sceneId), Array.from({ length: 203 }, (_, index) => "s" + index));
  for (const query of ["limit=0", "limit=201", "limit=1.5", "limit=true", "limit=1&limit=2", "unknown=1", "cursor=invalid"]) assert.equal((await json(h.base, "/api/v1/scenes?" + query)).response.status, 400, query);
  for (const bad of [{ kind: "other", revision: 1, offset: 1 }, { kind: "scenes/v1", revision: 1, offset: 0 }, { kind: "scenes/v1", revision: 1, offset: 203 }]) {
    await assert.rejects(h.scenes.list({ cursor: Buffer.from(JSON.stringify(bad)).toString("base64url") }), error => error instanceof HttpError && error.status === 400);
  }
  const oldCursor = first.nextCursor;
  await h.workspace.mutateScoped(current => { current.scenes = [...current.scenes as unknown[]].reverse(); return { workspace: current, result: {} }; });
  await assert.rejects(h.scenes.list({ cursor: oldCursor }), error => error instanceof HttpError && error.status === 409 && error.code === "SCENE_PAGE_CHANGED");
  const fresh = await h.scenes.list({ limit: 1 }); assert.equal(fresh.scenes[0].sceneId, "s202");
});

test("空目录和空权威工作区不补内置场景；状态/目录查询不初始化或写入", async t => {
  const h = await aiHarness(t, { emptyWorkspace: true });
  assert.deepEqual(await h.workspace.status(), { authority: "sqlite", initialized: false, workspaceRevision: null, catalogView: "draft", executionView: "published" });
  const empty = await h.scenes.list(); assert.equal(empty.initialized, false); assert.equal(empty.hasMore, false); assert.equal(empty.total, 0); assert.deepEqual(empty.scenes, []); assert.equal(await h.workspace.get(), undefined);
  await h.workspace.initialize({ format: "zane-studio.workspace/v1", scenes: [], workflows: {}, optionPresets: [], drafts: [], sceneVersions: {} });
  assert.equal((await h.scenes.list()).initialized, true); assert.equal((await h.workspace.status()).workspaceRevision, 1); assert.equal((await h.workspace.get())?.revision, 1);
});

test("MCP编辑发布后的能力固定与源草稿比较，UI和API一致；旧revision和丢失发布响应按同ID对账", async t => {
  const h = await aiHarness(t, { emptyWorkspace: true });
  const created = await h.scenes.drafts.create({ scene: { id: "sync", title: "同源场景" }, workflow: { inputs: [], steps: [{ id: "test", name: "test", kind: "fake", outputs: [{ key: "value", type: "text" }] }], outputs: [{ key: "result", type: "text", sourceRef: "step.test.outputs.value" }] } });
  const publicationId = randomUUID();
  const published = await h.scenes.drafts.publish("sync", created.revision, publicationId);
  const replay = await h.scenes.drafts.publish("sync", created.revision, publicationId); assert.equal(replay.created, false); assert.equal(replay.versionId, published.versionId);
  const workspace = readAuthoritativeWorkspace(await h.workspace.get());
  const item = (await h.scenes.list()).scenes[0]; const draft = await h.scenes.drafts.get("sync");
  assert.equal(item.draftRevision, draft.revision); assert.equal(item.draftMatchesPublished, true);
  assert.equal(sceneDraftMatchesVersion(workspace.scenes[0], workspace.workflows.sync, [], workspace.sceneVersions.sync.versions[0] as SceneVersion), item.draftMatchesPublished);
  await assert.rejects(h.scenes.drafts.update("sync", { revision: created.revision, scene: { id: "sync", title: "旧快照覆盖" } }), error => error instanceof HttpError && error.status === 409);
  const deleted = await h.scenes.drafts.delete("sync", draft.revision); assert.equal(deleted.deleted, true); assert.deepEqual((await h.scenes.list()).scenes, []);
});
