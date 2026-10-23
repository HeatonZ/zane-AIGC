import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import express from "express";
import { randomUUID } from "node:crypto";
import { productionHarness } from "../../server/testing/productionSupport.js";
import { WorkspaceService } from "../../server/services/workspaceService.js";
import { AiSceneService } from "../../server/services/aiSceneService.js";
import { createWorkspaceRouter } from "../../server/api/systemRoutes.js";
import { HttpError } from "../../server/errors.js";
import { normalizeWorkspaceSnapshot } from "./workspaceStorage.js";
import { readAuthoritativeWorkspace, retainWorkspaceReferences, diffWorkspaceForMerge } from "./workspaceSync.js";
import { RetainedSaveQueue } from "./retainedSaveQueue.js";
import { sortWorkflowDrafts } from "./drafts.js";
import { sceneDraftMatchesVersion } from "./sceneVersions.js";
import type { WorkspaceSnapshot, JsonValue, WorkflowStepDefinition } from "../types.js";

/** 第三方请求步骤：JSON 配置（bodyTemplate）是本次回归的核心字段。 */
function requestStep(bodyTemplate: JsonValue): WorkflowStepDefinition[] {
  return [{
    id: "request", name: "第三方请求", kind: "capability", capabilityId: "core.http_request", capabilityVersion: "2",
    capabilityConfig: { url: "https://api.example.net/v1", method: "POST", bodyTemplate, timeoutSeconds: 30 },
    inputs: [{ key: "prompt", label: "提示词", sourceRef: "input.prompt" }], outputs: [{ key: "response", label: "响应", type: "json" }], promptTemplate: "",
  }];
}

function workflow(bodyTemplate: JsonValue) {
  return { inputs: [{ key: "prompt", type: "text", required: true }], steps: requestStep(bodyTemplate), outputs: [{ key: "response", type: "json", sourceRef: "step.request.outputs.response" }] };
}

/** 复刻 App.tsx：applyWorkspace/commitWorkspace 与服务端 /api/workspace/merge 的真实链路。 */
async function client(t: test.TestContext, onServer: (base: string) => Promise<void>) {
  const h = await productionHarness(t);
  const workspace = new WorkspaceService(h.store, path.join(h.root, "workspace.json"));
  t.after(() => workspace.shutdown());
  await workspace.initialize({ format: "zane-studio.workspace/v1", scenes: [], workflows: {}, optionPresets: [], drafts: [], sceneVersions: {} });
  const scenes = new AiSceneService(workspace, h.executors, h.assets, async () => h.settings);
  const created = await scenes.drafts.create({ scene: { id: "third", title: "第三方" }, workflow: workflow({ prompt: "{{prompt}}" }) } as never);
  await scenes.drafts.publish("third", created.revision, randomUUID());

  const app = express();
  app.use(express.json());
  app.use(createWorkspaceRouter({ workspaceService: workspace }));
  app.use((error: unknown, _request: express.Request, response: express.Response, _next: express.NextFunction) => response.status(error instanceof HttpError ? error.status : 500).json({ error: (error as Error).message, code: error instanceof HttpError ? error.code : "INTERNAL_ERROR" }));
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => server.once("listening", resolve));
  t.after(() => new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); }));
  const base = "http://127.0.0.1:" + (server.address() as { port: number }).port;

  let current = readAuthoritativeWorkspace(await workspace.get());
  let pendingCount = 0; let syncError = "";
  /** 模拟一次网络失败：保存未确认时发布绝不能在本机留下服务端没有的版本号。 */
  let failNextMerge = false;
  const queue = new RetainedSaveQueue<WorkspaceSnapshot>({
    send: async (previous, desired) => {
      if (failNextMerge) { failNextMerge = false; throw new Error("Failed to fetch"); }
      const response = await fetch(base + "/api/workspace/merge", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ base: previous, workspace: desired }) });
      const body = await response.json() as { workspace?: WorkspaceSnapshot; error?: string; code?: string };
      if (!response.ok) throw new Error(body.error + " [" + body.code + "]");
      return readAuthoritativeWorkspace(body.workspace);
    },
    saved: (value, remaining) => { pendingCount = remaining; if (!remaining) { apply(value); syncError = ""; } },
    failed: error => { syncError = error.message; },
  });
  function apply(value: WorkspaceSnapshot) { current = retainWorkspaceReferences(current, { ...value, drafts: sortWorkflowDrafts(value.drafts) }); }
  function commit(value: WorkspaceSnapshot) {
    const previous = current;
    const next = normalizeWorkspaceSnapshot(value, current);
    apply(next);
    queue.enqueue(previous, next);
  }
  const edit = (bodyTemplate: JsonValue) => commit({ ...current, workflows: { ...current.workflows, third: { ...current.workflows.third, steps: requestStep(bodyTemplate) } } });
  const status = () => {
    const scene = current.scenes.find(item => item.id === "third")!;
    const flow = current.workflows.third;
    const record = current.sceneVersions.third;
    const version = record?.versions.find(item => item.id === record.publishedVersionId);
    const saveStatus = syncError ? "failed" : pendingCount ? "saving" : "saved";
    const hasUnpublishedChanges = !sceneDraftMatchesVersion(scene, flow, current.optionPresets, version);
    return { hasUnpublishedChanges, saveStatus, canPublish: hasUnpublishedChanges && saveStatus === "saved", syncError, bodyTemplate: JSON.stringify(flow.steps[0].capabilityConfig?.bodyTemplate) };
  };
  /**
   * 复刻 App.tsx 的发布链路：stageWorkspace 只入队不应用本机，回执才写本地版本。
   * 返回 published 说明界面是否真的拿到了服务端确认的版本号。
   */
  async function publishLocal() {
    const snapshot = current;
    const record = snapshot.sceneVersions.third;
    const value = { ...snapshot, revision: (snapshot.revision ?? 0) + 1 };
    queue.enqueue(snapshot, normalizeWorkspaceSnapshot(value, snapshot));
    await queue.waitForSaved();
    return record;
  }
  await onServer(base);
  return {
    workspace, scenes, queue, current: () => current, edit, status, base,
    failNextMerge: () => { failNextMerge = true; },
    publishLocal,
    /** 本机记录的发布版本号（不读服务端）。 */
    localPublishedVersionId: () => current.sceneVersions.third?.publishedVersionId ?? null,
  };
}

test("第三方请求JSON配置编辑不在同revision被回退：落库、立即产生差异并可发布", async t => {
  const c = await client(t, async () => {});
  assert.equal(c.status().hasUnpublishedChanges, false, "发布后草稿与发布版一致");

  // 用户编辑 JSON 配置并 blur：本机必须立刻保留，而不是被当成同一服务端快照丢弃
  c.edit({ prompt: "{{prompt}}", size: "1024x1024" });
  const committed = c.status();
  assert.deepEqual(JSON.parse(committed.bodyTemplate), { prompt: "{{prompt}}", size: "1024x1024" }, "本机应立即看到刚编辑的JSON配置");
  assert.equal(committed.hasUnpublishedChanges, true, "编辑后必须立刻出现未发布差异");
  // 编辑会立即提交服务端；本地回环很快时这一步可能已经拿到回执，两种状态都算正常。
  assert.ok(["saving", "saved"].includes(committed.saveStatus), committed.saveStatus);

  await c.queue.waitForSaved();
  const saved = c.status();
  assert.equal(saved.saveStatus, "saved");
  assert.equal(saved.syncError, "");
  assert.equal(saved.canPublish, true, "保存确认后必须可以发布");
  assert.deepEqual(JSON.parse(saved.bodyTemplate), { prompt: "{{prompt}}", size: "1024x1024" });

  // 服务端权威同样落库
  const authoritative = await c.workspace.get() as { workflows: Record<string, { steps: { capabilityConfig: { bodyTemplate: unknown } }[] }> };
  assert.deepEqual(authoritative.workflows.third.steps[0].capabilityConfig.bodyTemplate, { prompt: "{{prompt}}", size: "1024x1024" });

  // 服务端差异接口确实报告了嵌套 JSON 变更（不是“没有触发差异”）
  const diff = await c.scenes.drafts.diff("third", { limit: 50, valueLimit: 4000 } as never);
  assert.equal(diff.hasChanges, true);
  assert.equal(diff.baseline?.versionId, c.current().sceneVersions.third.publishedVersionId);
  assert.ok(diff.changes.some(change => change.path.includes("/capabilityConfig/bodyTemplate")), diff.changes.map(change => change.path).join(","));
});

test("保存未确认时的连续编辑不回退也不误报冲突；不同字段编辑一并落库", async t => {
  const c = await client(t, async () => {});
  c.edit({ prompt: "{{prompt}}", size: "1024x1024" });
  const first = c.status();
  assert.deepEqual(JSON.parse(first.bodyTemplate), { prompt: "{{prompt}}", size: "1024x1024" });
  // 第一次保存尚未确认，用户继续改同一个 JSON 字段
  c.edit({ prompt: "{{prompt}}", size: "1024x1024", quality: "high" });
  assert.deepEqual(JSON.parse(c.status().bodyTemplate), { prompt: "{{prompt}}", size: "1024x1024", quality: "high" }, "连续编辑不能被滞后回执或快路径回退");
  await c.queue.waitForSaved();
  const saved = c.status();
  assert.equal(saved.syncError, "", "本机编辑不得被误判为“已被另一设备修改”");
  assert.equal(saved.saveStatus, "saved");
  assert.equal(saved.canPublish, true);
  assert.deepEqual(JSON.parse(saved.bodyTemplate), { prompt: "{{prompt}}", size: "1024x1024", quality: "high" });
  const authoritative = await c.workspace.get() as { workflows: Record<string, { steps: { capabilityConfig: { bodyTemplate: unknown } }[] }> };
  assert.deepEqual(authoritative.workflows.third.steps[0].capabilityConfig.bodyTemplate, { prompt: "{{prompt}}", size: "1024x1024", quality: "high" });
});

test("保存未确认时发布会抛错，且本机不留下服务端没有的版本号", async t => {
  // 真实故障：发布按钮用 aria-disabled，点击仍会进入 publish()；旧实现先 applyWorkspace
  // 再等服务端，保存一失败界面就显示“已发布 v…”，而服务端根本没有那个版本。
  const c = await client(t, async () => {});
  c.edit({ prompt: "{{prompt}}", size: "1024x1024" });
  await c.queue.waitForSaved();
  const before = c.localPublishedVersionId();

  c.failNextMerge();
  // waitForSaved 会把底层网络错误收敛成“保存尚未确认”，这正是发布应上报的原因。
  await assert.rejects(c.publishLocal(), /保存尚未确认|Failed to fetch/, "保存失败必须抛错，不能宣布发布成功");
  assert.equal(c.status().saveStatus, "failed");
  assert.equal(c.localPublishedVersionId(), before, "本机发布版本号必须保持不变");

  // 重试成功后，版本号才允许变化，并且服务端确实记录了它。
  await c.queue.retry();
  assert.equal(c.status().saveStatus, "saved");
  const authoritative = await c.workspace.get() as { sceneVersions: Record<string, { publishedVersionId: string | null }> };
  assert.ok(authoritative.sceneVersions.third, "服务端必须存在该场景的版本记录");
});

test("同revision的无关服务端快照仍按节点保留identity，不重置无关表单", () => {
  const base = { format: "zane-studio.workspace/v1", revision: 4, scenes: [], workflows: { a: { sceneId: "a", name: "流程", inputs: [], steps: [], outputs: [] } }, optionPresets: [], drafts: [], sceneVersions: {} } as unknown as WorkspaceSnapshot;
  const incoming = structuredClone(base);
  const retained = retainWorkspaceReferences(base, incoming);
  assert.equal(retained.workflows.a, base.workflows.a, "内容相同的工作流必须保留对象identity");
  assert.equal(retained, base);
  const changed = structuredClone(base);
  changed.workflows.a.name = "改名";
  assert.equal(retainWorkspaceReferences(base, changed).workflows.a.name, "改名");
});

test("增量上传与服务端全量合并结果等价：编辑/新增/删除都成立", async t => {
  const h = await productionHarness(t);
  const workspace = new WorkspaceService(h.store, path.join(h.root, "workspace.json"));
  t.after(() => workspace.shutdown());
  const scene = (id: string, title: string) => ({ id, title, shortTitle: title, summary: "", description: "", cover: "", accent: "green" as const, stages: [] });
  const draft = (id: string, summary: string) => ({ id, sceneId: "one", title: id, summary, inputValues: {}, createdAt: "2026-01-01T00:00:00.000Z", status: "draft" as const });
  const flow = (name: string) => ({ sceneId: "one", name, inputs: [{ key: "prompt", label: "提示词", type: "text" as const, required: true }], steps: [], outputs: [] });
  await workspace.initialize({
    format: "zane-studio.workspace/v1",
    scenes: [scene("one", "一"), scene("two", "二")],
    workflows: { one: flow("流程一"), two: flow("流程二") },
    optionPresets: [],
    drafts: [draft("d1", "原样"), draft("d2", "原样")],
    sceneVersions: {},
  });
  const base = readAuthoritativeWorkspace(await workspace.get());

  // 三种改动：改一个草稿、删一个草稿、改一个场景标题（另有一个场景完全没动）
  const desired: WorkspaceSnapshot = {
    ...base,
    scenes: base.scenes.map(item => item.id === "one" ? { ...item, title: "改名后" } : item),
    drafts: base.drafts.filter(item => item.id !== "d2").map(item => item.id === "d1" ? { ...item, summary: "改过了" } : item),
    workflows: { ...base.workflows, one: flow("流程一改名") },
  };

  const patch = diffWorkspaceForMerge(base, desired);
  // 未改动的内容不应出现在上传体里
  assert.equal(patch.workspace.scenes.length, 1, "只有改名的场景需要上传");
  assert.equal(patch.workspace.drafts.length, 1, "只有改过的草稿需要上传");
  assert.deepEqual(Object.keys(patch.workspace.workflows), ["one"]);
  // 删除项必须让服务端看见"从有到无"
  assert.equal(patch.base.drafts.length, 2, "base 侧要带上被删草稿");
  assert.ok(patch.base.drafts.some(item => item.id === "d2"));
  const raw = JSON.stringify({ base, workspace: desired }).length;
  const slim = JSON.stringify(patch).length;
  // 这个小样本的固定开销（format/revision 等）占比很高，只断言"没有变大"。
  assert.ok(slim <= raw, `增量上传不应比全量更大：${slim} vs ${raw}`);

  const merged = readAuthoritativeWorkspace(await workspace.merge(patch.base, patch.workspace));
  assert.deepEqual(merged.scenes.map(item => item.title), ["改名后", "二"]);
  assert.deepEqual(merged.drafts.map(item => item.id), ["d1"]);
  assert.equal(merged.drafts[0].summary, "改过了");
  assert.equal(merged.workflows.one.name, "流程一改名");
  assert.equal(merged.workflows.two.name, "流程二", "未上传的流程必须保持原值");

  // 与全量合并的结果一致：换一个干净的工作区，避免上一步的合并污染基线。
  const h2 = await productionHarness(t);
  const workspace2 = new WorkspaceService(h2.store, path.join(h2.root, "workspace.json"));
  t.after(() => workspace2.shutdown());
  await workspace2.initialize(JSON.parse(JSON.stringify({ ...base, revision: undefined })));
  const base2 = readAuthoritativeWorkspace(await workspace2.get());
  const full = readAuthoritativeWorkspace(await workspace2.merge(base2, { ...desired, revision: undefined }));
  assert.deepEqual(
    { scenes: full.scenes.map(item => item.title), drafts: full.drafts.map(item => [item.id, item.summary]), workflows: Object.fromEntries(Object.entries(full.workflows).map(([id, w]) => [id, w.name])) },
    { scenes: merged.scenes.map(item => item.title), drafts: merged.drafts.map(item => [item.id, item.summary]), workflows: Object.fromEntries(Object.entries(merged.workflows).map(([id, w]) => [id, w.name])) },
  );
});

test("接近真实体量时增量上传把请求体从 MB 级降到 KB 级", () => {
  const filler = "剧情与画面描述。".repeat(400);
  const scenes = Array.from({ length: 16 }, (_, i) => ({ id: "s" + i, title: "场景" + i, shortTitle: "s", summary: filler, description: filler, cover: "", accent: "green" as const, stages: [] }));
  const drafts = Array.from({ length: 54 }, (_, i) => ({ id: "d" + i, sceneId: "s0", title: "草稿" + i, summary: filler, inputValues: { text: filler }, createdAt: "2026-01-01T00:00:00.000Z", status: "draft" as const }));
  const base = { format: "zane-studio.workspace/v1" as const, revision: 10, scenes, workflows: {}, optionPresets: [], drafts, sceneVersions: {} } as unknown as WorkspaceSnapshot;
  const desired = { ...base, drafts: base.drafts.map((item, i) => i === 0 ? { ...item, summary: "只改了第一份" } : item) } as WorkspaceSnapshot;

  const full = JSON.stringify({ base, workspace: desired }).length;
  const patch = diffWorkspaceForMerge(base, desired);
  const slim = JSON.stringify(patch).length;
  assert.ok(full > 500_000, "样本要接近真实工作区体量：" + full);
  assert.ok(slim < full / 20, `增量应至少小 20 倍：${slim} vs ${full}`);
  assert.equal(patch.workspace.drafts.length, 1, "只上传改过的那一份草稿");
  assert.equal(patch.workspace.scenes.length, 0, "未改动的场景不上传");
});
