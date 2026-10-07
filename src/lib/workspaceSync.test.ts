import assert from "node:assert/strict";
import test from "node:test";
import { readAuthoritativeWorkspace, retainWorkspaceReferences, replaceWorkspaceFromAuthority, WorkspaceSynchronizer } from "./workspaceSync";
import { normalizeWorkspaceSnapshot } from "./workspaceStorage";
import { RetainedSaveQueue } from "./retainedSaveQueue";
import { sceneDraftMatchesVersion, sceneVersionHash } from "./sceneVersions";
import { deferred } from "../../server/testing/testSupport";
import type { WorkspaceSnapshot, SceneModule } from "../types";
import type { WorkspaceStatus } from "../../server/domain/workspaceContracts";

const scene = (id: string, title = id): SceneModule => ({ id, title, shortTitle: title, summary: "", description: "", cover: "", accent: "green", stages: [] });
function snapshot(revision = 1): WorkspaceSnapshot {
  const flow = { sceneId: "one", name: "流程", inputs: [], steps: [], outputs: [] };
  return { format: "zane-studio.workspace/v1", revision, scenes: [scene("one")], workflows: { one: flow }, optionPresets: [], drafts: [], sceneVersions: { one: { publishedVersionId: "old-version", versions: [{ id: "old-version", version: "aabbccdd", publishedAt: "2026-10-01T00:00:00.000Z", scene: scene("one"), workflow: flow, optionPresets: [] }] } } };
}
const status = (revision: number): WorkspaceStatus => ({ authority: "sqlite", initialized: true, workspaceRevision: revision, catalogView: "draft", executionView: "published" });
function harness() {
  let current = snapshot(); let remote = snapshot(2); let blocked = false; let fullReads = 0; let statusReads = 0;
  const errors: Error[] = []; const observed: WorkspaceStatus[] = [];
  const options = {
    current: () => current, blocked: () => blocked,
    readStatus: async () => { statusReads++; return status(remote.revision!); },
    readWorkspace: async () => { fullReads++; return { workspace: remote }; },
    observed: (value: WorkspaceStatus) => observed.push(value),
    apply: (value: WorkspaceSnapshot) => { current = retainWorkspaceReferences(current, value); },
    failed: (error: Error) => errors.push(error),
  };
  return { options, errors, observed, sync: new WorkspaceSynchronizer(options), get current() { return current; }, set current(value: WorkspaceSnapshot) { current = value; }, get remote() { return remote; }, set remote(value: WorkspaceSnapshot) { remote = value; }, set blocked(value: boolean) { blocked = value; }, get fullReads() { return fullReads; }, get statusReads() { return statusReads; } };
}

test("权威读取保持顺序、完整发布快照与哈希，不从本地补回已删除场景或自动发布", () => {
  const local = snapshot(); const remote = snapshot(7);
  remote.scenes = []; remote.workflows = {}; remote.sceneVersions = {};
  const normalized = normalizeWorkspaceSnapshot(remote, local);
  assert.deepEqual(normalized, remote); assert.deepEqual(readAuthoritativeWorkspace(remote), remote);
  const original = snapshot(9); original.sceneVersions.one.versions[0].workflow.inputs = [{ key: "image", label: "图", type: "image", required: false }];
  const before = structuredClone(original);
  assert.deepEqual(readAuthoritativeWorkspace(original), before);
  assert.deepEqual(normalizeWorkspaceSnapshot(original, local), before);
  assert.equal(readAuthoritativeWorkspace(original).sceneVersions.one.versions[0].version, "aabbccdd");
  assert.throws(() => readAuthoritativeWorkspace({ scenes: local.scenes }), /不会使用本机默认场景替代/);
  const legacy = { ...snapshot(), sceneVersions: undefined };
  assert.deepEqual(readAuthoritativeWorkspace(legacy).sceneVersions, {});
});

test("外部增删、编辑、排序与发布变更自动同步；相同revision仅读元数据，不重复读取完整工作区", async () => {
  const h = harness(); const oldWorkflow = h.current.workflows.one; const oldVersion = h.current.sceneVersions.one;
  h.remote.scenes = [scene("new"), scene("one", "AI新名称")];
  assert.equal(await h.sync.refresh(), "applied"); assert.deepEqual(h.current.scenes.map(item => item.id), ["new", "one"]);
  assert.equal(h.current.workflows.one, oldWorkflow); assert.equal(h.current.sceneVersions.one, oldVersion);
  assert.equal(await h.sync.refresh(), "unchanged"); assert.equal(h.fullReads, 1); assert.equal(h.statusReads, 2);
  h.remote = { ...snapshot(3), scenes: [], workflows: {}, sceneVersions: {} };
  assert.equal(await h.sync.refresh(), "applied"); assert.deepEqual(h.current.scenes, []);
  h.remote = snapshot(4); h.remote.sceneVersions.one.publishedVersionId = null;
  assert.equal(await h.sync.refresh(), "applied"); assert.equal(h.current.sceneVersions.one.publishedVersionId, null);
});

test("未同步队列、字段编辑、对话框或创作表单只提示更新；退出编辑后同步且不改变发布快照", async () => {
  const h = harness(); h.blocked = true; const before = h.current;
  assert.equal(await h.sync.refresh(), "deferred"); assert.equal(h.current, before); assert.equal(h.fullReads, 0); assert.equal(h.observed[0].workspaceRevision, 2);
  h.blocked = false; assert.equal(await h.sync.refresh(), "applied");
});

test("在元数据或完整快照读取期间产生本机编辑/保存回执，不被滞后响应覆盖", async () => {
  const h = harness(); const metadata = deferred<WorkspaceStatus>();
  const sync = new WorkspaceSynchronizer({ ...h.options, readStatus: () => metadata.promise });
  const request = sync.refresh(); h.current = { ...h.current, scenes: [scene("one", "本机未同步编辑")] };
  metadata.resolve(status(2)); assert.equal(await request, "deferred"); assert.equal(h.current.scenes[0].title, "本机未同步编辑");
  const response = deferred<{ workspace: WorkspaceSnapshot | null }>(); let requested = false;
  const full = new WorkspaceSynchronizer({ ...h.options, readWorkspace: () => { requested = true; return response.promise; } });
  const reading = full.refresh(); await Promise.resolve(); assert.equal(requested, true);
  h.current = snapshot(5); response.resolve({ workspace: snapshot(2) });
  assert.equal(await reading, "deferred"); assert.equal(h.current.revision, 5);
});

test("完整读取时进入编辑/新写入，响应丢失和断线均保留当前快照；恢复后按当前revision对账", async () => {
  const h = harness(); const response = deferred<{ workspace: WorkspaceSnapshot | null }>();
  const full = new WorkspaceSynchronizer({ ...h.options, readWorkspace: () => response.promise });
  const request = full.refresh(); await Promise.resolve(); h.blocked = true; response.resolve({ workspace: h.remote });
  assert.equal(await request, "deferred"); assert.equal(h.current.revision, 1);
  h.blocked = false;
  const offline = new WorkspaceSynchronizer({ ...h.options, readStatus: async () => { throw new Error("连接中断"); } });
  assert.equal(await offline.refresh(), "failed"); assert.equal(h.current.revision, 1); assert.match(h.errors[0].message, /连接中断/);
  assert.equal(await h.sync.refresh(), "applied"); assert.equal(h.current.revision, 2);
});

test("重叠轮询只发一个请求；已退出页面的滞后响应、消失的权威工作区和不兼容后台不覆盖缓存", async () => {
  const h = harness(); const response = deferred<WorkspaceStatus>(); let reads = 0;
  const sync = new WorkspaceSynchronizer({ ...h.options, readStatus: () => { reads++; return response.promise; } });
  const one = sync.refresh(); const two = sync.refresh(); assert.equal(one, two); assert.equal(reads, 1);
  sync.stop(); response.resolve(status(2)); assert.equal(await one, "stale"); assert.equal(h.fullReads, 0);
  const missing = new WorkspaceSynchronizer({ ...h.options, readStatus: async () => ({ ...status(1), initialized: false, workspaceRevision: null }) });
  assert.equal(await missing.refresh(), "missing"); assert.equal(h.current.revision, 1);
  const incompatible = new WorkspaceSynchronizer({ ...h.options, readStatus: async () => ({ ...status(2), authority: "other" }) as unknown as WorkspaceStatus });
  assert.equal(await incompatible.refresh(), "failed"); assert.equal(h.current.revision, 1);
});

test("UI与AI按相同canonical内容比较草稿发布差异，字段键顺序不误报，能力固定保留源草稿标记", () => {
  const value = snapshot(); const version = value.sceneVersions.one.versions[0];
  const reordered = { ...value.scenes[0] }; delete (reordered as Partial<SceneModule>).title; reordered.title = value.scenes[0].title;
  assert.equal(sceneDraftMatchesVersion(reordered, value.workflows.one, [], version), true);
  version.version = "00000000";
  assert.equal(sceneDraftMatchesVersion(value.scenes[0], value.workflows.one, [], version), true);
  assert.equal(sceneDraftMatchesVersion(scene("one", "新草稿"), value.workflows.one, [], version), false);
  version.publication = { expectedRevision: "0".repeat(64), draftContentHash: sceneVersionHash(value.scenes[0], value.workflows.one, []) };
  version.workflow = { ...version.workflow, name: "发布时固定能力配置后的流程" };
  assert.equal(sceneDraftMatchesVersion(value.scenes[0], value.workflows.one, [], version), true);
  assert.equal(sceneDraftMatchesVersion(scene("one", "新的编辑"), value.workflows.one, [], version), false);
});


test("手动读取响应丢失/失败不丢弃outbox，读取成功前有新编辑也保留；只有确认的成功读取可以替换", async () => {
  let current = snapshot(); let persisted: unknown; let applied = 0;
  const queue = new RetainedSaveQueue<WorkspaceSnapshot>({ initial: [{ base: current, desired: { ...current, scenes: [scene("one", "本机编辑")] } }], send: async () => { throw new Error("不应发送"); }, persist: entries => { persisted = structuredClone(entries); }, saved: () => {}, failed: () => {} });
  const options = { current: () => current, queue, discardPending: true, apply: (value: WorkspaceSnapshot) => { current = value; applied++; } };
  await assert.rejects(replaceWorkspaceFromAuthority({ ...options, readWorkspace: async () => { throw new Error("响应丢失"); } }), /响应丢失/);
  assert.equal(queue.pendingCount, 1); assert.equal(applied, 0);
  const delayed = deferred<{ workspace: WorkspaceSnapshot | null }>();
  const request = replaceWorkspaceFromAuthority({ ...options, readWorkspace: () => delayed.promise });
  current = { ...current, scenes: [scene("one", "读取中产生的新编辑")] }; delayed.resolve({ workspace: snapshot(2) });
  await assert.rejects(request, /新编辑/); assert.equal(queue.pendingCount, 1); assert.equal(applied, 0);
  await replaceWorkspaceFromAuthority({ ...options, readWorkspace: async () => ({ workspace: snapshot(3) }) });
  assert.equal(queue.pendingCount, 0); assert.deepEqual(persisted, []); assert.equal(applied, 1); assert.equal(current.revision, 3);
});

test("手动替换不能越过在途写入，本地存储清除失败也保留队列和原内容", async () => {
  const before = snapshot(); const desired = snapshot(2); const inFlight = deferred<WorkspaceSnapshot>(); let failStorage = false;
  const queue = new RetainedSaveQueue<WorkspaceSnapshot>({ send: () => inFlight.promise, persist: () => { if (failStorage) throw new Error("存储失败"); }, saved: () => {}, failed: () => {} });
  queue.enqueue(before, desired);
  let applied = false;
  await assert.rejects(replaceWorkspaceFromAuthority({ current: () => desired, queue, discardPending: true, readWorkspace: async () => ({ workspace: snapshot(3) }), apply: () => { applied = true; } }), /配置请求在提交/);
  assert.equal(applied, false); assert.equal(queue.pendingCount, 1);
  inFlight.resolve(desired); await queue.retry(); assert.equal(queue.pendingCount, 0);
  const retained = new RetainedSaveQueue<WorkspaceSnapshot>({ initial: [{ base: before, desired }], send: async () => desired, persist: () => { throw new Error("存储失败"); }, saved: () => {}, failed: () => {} });
  assert.equal(retained.discard(), false); assert.equal(retained.pendingCount, 1); assert.equal(retained.latest, desired);
});


test("手动刷新读取期间产生未入outbox的表单输入或切换页面，不能丢弃队列和重置表单", async () => {
  const value = snapshot(); const queue = new RetainedSaveQueue<WorkspaceSnapshot>({ initial: [{ base: value, desired: snapshot(2) }], send: async () => value, persist: () => {}, saved: () => {}, failed: () => {} });
  const response = deferred<{ workspace: WorkspaceSnapshot | null }>(); let canApply = true; let applied = false;
  const request = replaceWorkspaceFromAuthority({ current: () => value, queue, discardPending: true, canApply: () => canApply, readWorkspace: () => response.promise, apply: () => { applied = true; } });
  canApply = false; response.resolve({ workspace: snapshot(3) });
  await assert.rejects(request, /新编辑/); assert.equal(applied, false); assert.equal(queue.pendingCount, 1);
});
