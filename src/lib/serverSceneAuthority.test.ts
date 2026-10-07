import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { createEmptyWorkspaceSnapshot, normalizeWorkspaceSnapshot } from "./workspaceStorage";
import { loadAuthoritativeWorkspace, parseRetainedWorkspaceEdits } from "./workspaceSync";
import { RetainedSaveQueue } from "./retainedSaveQueue";
import { getScene } from "../data/scenes";
import { sortWorkflowDrafts } from "./drafts";
import type { WorkspaceSnapshot } from "../types";

const workspace = (revision = 1): WorkspaceSnapshot => ({ ...createEmptyWorkspaceSnapshot(), revision, scenes: [{ id: "server-only", title: "服务端场景", shortTitle: "服务端", summary: "", description: "", cover: "", accent: "green", stages: [] }] });

test("启动占位及空初始化不读取浏览器场景或默认模板，查询空目录不补回默认场景", t => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", { configurable: true, get: () => { throw new Error("不能读取浏览器业务缓存"); } });
  t.after(() => { if (descriptor) Object.defineProperty(globalThis, "window", descriptor); else Reflect.deleteProperty(globalThis, "window"); });
  const first = createEmptyWorkspaceSnapshot(); const second = createEmptyWorkspaceSnapshot();
  assert.deepEqual(first, { format: "zane-studio.workspace/v1", scenes: [], workflows: {}, optionPresets: [], drafts: [], sceneVersions: {} });
  assert.notEqual(first.scenes, second.scenes);
  assert.equal(getScene("text_to_image", first.scenes).title, "已删除场景");
  assert.deepEqual(normalizeWorkspaceSnapshot({ ...workspace(), sceneVersions: undefined }, first).sceneVersions, {});
});

test("重载仅显示服务端场景，旧outbox不作为目录也不自动提交", async () => {
  const authority = workspace(7);
  const desired = { ...workspace(6), scenes: [{ ...authority.scenes[0], id: "browser-only", title: "不应复活的旧场景" }] };
  const retained = parseRetainedWorkspaceEdits(JSON.stringify([{ base: workspace(6), desired }]));
  let writes = 0;
  const queue = new RetainedSaveQueue<WorkspaceSnapshot>({ initial: retained, send: async () => { writes++; return desired; }, persist: () => {}, saved: () => {}, failed: () => {} });
  const loaded = await loadAuthoritativeWorkspace(async () => ({ workspace: authority }));
  assert.deepEqual(loaded?.scenes.map(scene => scene.id), ["server-only"]);
  assert.equal(writes, 0); assert.equal(queue.pendingCount, 1); assert.deepEqual(queue.latest, desired);
  const missing = await loadAuthoritativeWorkspace(async () => ({ workspace: null }));
  assert.equal(missing, null); assert.equal(writes, 0);
});

test("服务端不可用或快照不兼容时启动失败，不回退旧缓存、不隐式初始化", async () => {
  await assert.rejects(loadAuthoritativeWorkspace(async () => { throw new Error("server unavailable"); }), /server unavailable/);
  await assert.rejects(loadAuthoritativeWorkspace(async () => ({ workspace: { scenes: workspace().scenes } as WorkspaceSnapshot })), /权威工作区格式不兼容/);
});

test("outbox 是严格的待提交意图：坏JSON或坏条目不被静默过滤或转换为场景库", () => {
  assert.deepEqual(parseRetainedWorkspaceEdits(null), []);
  assert.throws(() => parseRetainedWorkspaceEdits("not-json"), /原始数据已保留/);
  assert.throws(() => parseRetainedWorkspaceEdits("{}"), /格式不兼容/);
  assert.throws(() => parseRetainedWorkspaceEdits(JSON.stringify([{ base: workspace(), desired: workspace() }, { base: null, desired: workspace() }])), /权威工作区格式不兼容/);
  const raw = JSON.stringify([{ base: workspace(), desired: workspace(2) }]);
  assert.equal(JSON.stringify(parseRetainedWorkspaceEdits(raw)), raw);
});

test("任务草稿是服务端数据的纯排序，不维护第二个浏览器数据库", () => {
  const drafts = [{ id: "old", createdAt: "2026-10-01T00:00:00Z" }, { id: "new", createdAt: "2026-10-04T00:00:00Z" }] as WorkspaceSnapshot["drafts"];
  assert.deepEqual(sortWorkflowDrafts(drafts).map(draft => draft.id), ["new", "old"]);
  assert.deepEqual(drafts.map(draft => draft.id), ["old", "new"]);
});

test("前端入口不再导入本地场景读写或在启动时应用/重放旧outbox", async () => {
  const app = await readFile(new URL("../App.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(app, /readLocalWorkspace|writeLocalWorkspace|defaultScenes|applyWorkspace\(outbox\.latest\)|await outbox\.retry\(\)/);
  assert.match(app, /initializeWorkspace\(createEmptyWorkspaceSnapshot\(\)\)/);
  assert.match(app, /loadAuthoritativeWorkspace\(loadWorkspace\)/);
  for (const path of ["sceneStorage.ts", "workflowStorage.ts", "workspaceStorage.ts", "drafts.ts"]) {
    assert.doesNotMatch(await readFile(new URL(path, import.meta.url), "utf8"), /localStorage|readScenes|writeScenes|readLocalWorkspace|writeLocalWorkspace/);
  }
});
