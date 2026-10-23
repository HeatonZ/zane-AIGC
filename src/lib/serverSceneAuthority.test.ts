import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { createEmptyWorkspaceSnapshot, normalizeWorkspaceSnapshot } from "./workspaceStorage";
import { loadAuthoritativeWorkspace } from "./workspaceSync";
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

test("重载只显示服务端场景：浏览器不再保存待提交副本，也不会复活旧场景", async () => {
  const authority = workspace(7);
  const loaded = await loadAuthoritativeWorkspace(async () => ({ workspace: authority }));
  assert.deepEqual(loaded?.scenes.map(scene => scene.id), ["server-only"]);
  let writes = 0;
  const queue = new RetainedSaveQueue<WorkspaceSnapshot>({ send: async (_base, desired) => { writes++; return desired; }, saved: () => {}, failed: () => {} });
  assert.equal(queue.pendingCount, 0, "新建队列没有任何待提交内容");
  const missing = await loadAuthoritativeWorkspace(async () => ({ workspace: null }));
  assert.equal(missing, null); assert.equal(writes, 0);
});

test("服务端不可用或快照不兼容时启动失败，不回退旧缓存、不隐式初始化", async () => {
  await assert.rejects(loadAuthoritativeWorkspace(async () => { throw new Error("server unavailable"); }), /server unavailable/);
  await assert.rejects(loadAuthoritativeWorkspace(async () => ({ workspace: { scenes: workspace().scenes } as WorkspaceSnapshot })), /权威工作区格式不兼容/);
});

test("前端不再读写任何本地配置副本", async () => {
  const app = await readFile(new URL("../App.tsx", import.meta.url), "utf8");
  // 只允许启动时清理旧版本残留键；不得再有 setItem 或恢复/重放逻辑。
  assert.doesNotMatch(app, /localStorage\.setItem/);
  assert.doesNotMatch(app, /parseRetainedWorkspaceEdits|restoredWorkspaceEditsRef|outboxReadErrorRef|LegacyConfigRecovery/);
  assert.match(app, /config-outbox:v2:/, "旧版本残留键仍应被清理");
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

test("低频页面按需加载，入口包不为未访问的页面付出体积", async () => {
  const app = await readFile(new URL("../App.tsx", import.meta.url), "utf8");
  for (const page of ["Logs", "UserManagement", "CreditManagement", "Tasks", "WorkflowRuns", "Library", "PackageManagement", "Studio", "History", "Connections", "SystemFeedback", "FlowDesigner"]) {
    assert.match(app, new RegExp(`const ${page} = lazy\\(\\(\\) => import\\("\\./features/${page}"\\)\\)`), `${page} 应改为 lazy 加载`);
    assert.doesNotMatch(app, new RegExp(`import ${page} from "\\./features/${page}"`), `${page} 不应再静态导入`);
  }
  // 懒加载组件必须有 Suspense 兜底，否则切换页面会抛错而不是显示加载态。
  assert.match(app, /<Suspense fallback=\{pageLoading\("正在加载页面…"\)\}>/);
  // 落地页仍是同步导入：它是首屏本身，拆包只会多一次往返。
  assert.match(app, /import Dashboard from "\.\/features\/Dashboard"/);
});
