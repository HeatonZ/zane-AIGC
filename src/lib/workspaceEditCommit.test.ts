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
import { readAuthoritativeWorkspace, retainWorkspaceReferences } from "./workspaceSync.js";
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
  const queue = new RetainedSaveQueue<WorkspaceSnapshot>({
    send: async (previous, desired) => {
      const response = await fetch(base + "/api/workspace/merge", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ base: previous, workspace: desired }) });
      const body = await response.json() as { workspace?: WorkspaceSnapshot; error?: string; code?: string };
      if (!response.ok) throw new Error(body.error + " [" + body.code + "]");
      return readAuthoritativeWorkspace(body.workspace);
    },
    persist: entries => { pendingCount = entries.length; },
    saved: (value, remaining) => { if (!remaining) { apply(value); syncError = ""; } },
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
  await onServer(base);
  return { workspace, scenes, queue, current: () => current, edit, status, base };
}

test("第三方请求JSON配置编辑不在同revision被回退：落库、立即产生差异并可发布", async t => {
  const c = await client(t, async () => {});
  assert.equal(c.status().hasUnpublishedChanges, false, "发布后草稿与发布版一致");

  // 用户编辑 JSON 配置并 blur：本机必须立刻保留，而不是被当成同一服务端快照丢弃
  c.edit({ prompt: "{{prompt}}", size: "1024x1024" });
  const committed = c.status();
  assert.deepEqual(JSON.parse(committed.bodyTemplate), { prompt: "{{prompt}}", size: "1024x1024" }, "本机应立即看到刚编辑的JSON配置");
  assert.equal(committed.hasUnpublishedChanges, true, "编辑后必须立刻出现未发布差异");
  assert.equal(committed.saveStatus, "saving");

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
