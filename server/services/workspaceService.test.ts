import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { readFile, writeFile, readdir } from "node:fs/promises";
import { harness } from "../testing/testSupport.js";
import { mergeWorkspacePayload, normalizeWorkspacePayload, WorkspaceService } from "./workspaceService.js";
import { HttpError } from "../errors.js";
import { readJsonFile, writeJsonFile } from "../storage/jsonFileStore.js";

const workspace = () => ({ format: "zane-studio.workspace/v1", scenes: [{ id: "one", title: "一" }, { id: "two", title: "二" }], workflows: { one: { name: "流程" } }, drafts: [], optionPresets: [], sceneVersions: {} });

test("旧 JSON 仅迁移一次，SQLite revision 是权威来源", async (t) => {
  const { root, store } = await harness(t);
  const filename = path.join(root, "workspace.json");
  await writeJsonFile(filename, workspace());
  const service = new WorkspaceService(store, filename);
  assert.equal((await service.get())?.revision, 1);
  await writeFile(filename, "{corrupted mirror");
  assert.equal((await service.get())?.revision, 1);
});

test("损坏 JSON 停止迁移，不悄悄初始化默认配置", async (t) => {
  const { root, store } = await harness(t);
  const filename = path.join(root, "workspace.json");
  await writeFile(filename, "{broken");
  const service = new WorkspaceService(store, filename);
  await assert.rejects(service.initialize(workspace()), /停止迁移/);
  assert.equal(store.getWorkspace(), undefined);
  assert.equal(await readFile(filename, "utf8"), "{broken");
});

test("不同实体的并发编辑合并，同一实体冲突返回 409 并保持 revision", async (t) => {
  const { root, store } = await harness(t);
  const service = new WorkspaceService(store, path.join(root, "workspace.json"));
  const initialized = await service.initialize(workspace());
  assert.equal(initialized.created, true);
  const base = initialized.workspace;
  const left = workspace(); left.scenes[0].title = "编辑一";
  const right = workspace(); right.scenes[1].title = "编辑二";
  await Promise.all([service.merge(base, left), service.merge(base, right)]);
  const current = await service.get();
  assert.equal(current?.revision, 3);
  assert.deepEqual(current?.scenes, [{ id: "one", title: "编辑一" }, { id: "two", title: "编辑二" }]);
  const conflicting = workspace(); conflicting.scenes[0].title = "另一设备的一";
  await assert.rejects(service.merge(base, conflicting), (error) => error instanceof HttpError && error.status === 409 && error.code === "WORKSPACE_CONFLICT");
  assert.equal((await service.get())?.revision, 3);
});

test("SQLite 事务失败回滚；原子 JSON 并发写入始终留下完整文件", async (t) => {
  const { root, store } = await harness(t);
  assert.throws(() => store.transaction(() => { store.saveWorkspace(workspace()); throw new Error("rollback"); }), /rollback/);
  assert.equal(store.getWorkspace(), undefined);
  const filename = path.join(root, "atomic.json");
  await Promise.all(Array.from({ length: 12 }, (_, index) => writeJsonFile(filename, { index, values: Array(50).fill(index) })));
  const saved = await readJsonFile(filename);
  assert.ok(Array.isArray(saved?.values) && saved.values.every((value: number) => value === saved.index));
  assert.equal((await readdir(root)).filter((name) => name.endsWith(".tmp")).length, 0);
});

test("工作区关闭后不再提交迟到事务", async (t) => {
  const { root, store } = await harness(t);
  const service = new WorkspaceService(store, path.join(root, "workspace.json"));
  await service.initialize(workspace());
  await service.shutdown();
  await assert.rejects(service.merge(workspace(), workspace()), (error) => error instanceof HttpError && error.status === 503);
});

test("无效/重复的实体 ID 返回 400，不静默丢弃配置", async (t) => {
  const { root, store } = await harness(t);
  const service = new WorkspaceService(store, path.join(root, "workspace.json"));
  await assert.rejects(service.initialize({ ...workspace(), scenes: [null] }), (error) => error instanceof HttpError && error.status === 400);
  await assert.rejects(service.initialize({ ...workspace(), scenes: [{ id: "same" }, { id: "same" }] }), (error) => error instanceof HttpError && error.status === 400);
  assert.equal(store.getWorkspace(), undefined);
});


function orderedWorkspace(...sceneIds: string[]) {
  return normalizeWorkspacePayload({ ...workspace(), scenes: sceneIds.map((id) => ({ id, title: id })) });
}

function sceneOrder(value: unknown) {
  return normalizeWorkspacePayload(value).scenes.map((scene) => (scene as { id: string }).id);
}

test("场景纯排序保存到 SQLite 和 JSON 镜像，重新加载不恢复旧顺序", async (t) => {
  const { root, store } = await harness(t);
  const filename = path.join(root, "workspace.json");
  const service = new WorkspaceService(store, filename);
  const initial = orderedWorkspace("one", "two", "three");
  const { workspace: base } = await service.initialize(initial);
  const desired = { ...initial, scenes: [initial.scenes[1], initial.scenes[2], initial.scenes[0]] };
  const result = await service.merge(base, desired);
  assert.deepEqual(sceneOrder(result), ["two", "three", "one"]);
  assert.deepEqual(result.workflows, initial.workflows);
  assert.deepEqual(result.sceneVersions, initial.sceneVersions);
  assert.deepEqual(result.optionPresets, initial.optionPresets);
  assert.deepEqual(result.drafts, initial.drafts);
  assert.deepEqual((await readJsonFile(filename))?.scenes, desired.scenes);
  const reloaded = new WorkspaceService(store, filename);
  assert.deepEqual((await reloaded.get())?.scenes, desired.scenes);
});

test("只编辑场景内容时保留另一设备已保存的场景排序", () => {
  const base = orderedWorkspace("one", "two", "three");
  const desired = structuredClone(base);
  desired.scenes[0] = { id: "one", title: "更新名称" };
  const current = orderedWorkspace("three", "one", "two");
  const merged = mergeWorkspacePayload(base, desired, current);
  assert.deepEqual(sceneOrder(merged), ["three", "one", "two"]);
  assert.deepEqual(merged.scenes[1], { id: "one", title: "更新名称" });
});

test("场景排序合并并发内容编辑、新增和删除，不覆盖内容或复活已删除场景", () => {
  const base = orderedWorkspace("one", "two", "three", "four");
  const desired = orderedWorkspace("four", "two", "three", "one");
  const current = orderedWorkspace("one", "three", "four", "new");
  current.scenes[1] = { id: "three", title: "另一设备编辑" };
  const merged = mergeWorkspacePayload(base, desired, current);
  assert.deepEqual(sceneOrder(merged), ["four", "three", "one", "new"]);
  assert.deepEqual(merged.scenes[1], { id: "three", title: "另一设备编辑" });
});

test("新增和删除本身不被误判为排序，不重置已保存的顺序", () => {
  const base = orderedWorkspace("one", "two", "three");
  const desired = orderedWorkspace("one", "three", "new");
  const current = orderedWorkspace("three", "one", "two");
  assert.deepEqual(sceneOrder(mergeWorkspacePayload(base, desired, current)), ["three", "one", "new"]);
});

test("重复提交相同排序可合并；不同设备的冲突排序返回 409", () => {
  const base = orderedWorkspace("one", "two", "three");
  const desired = orderedWorkspace("three", "one", "two");
  assert.deepEqual(sceneOrder(mergeWorkspacePayload(base, desired, desired)), ["three", "one", "two"]);
  assert.throws(
    () => mergeWorkspacePayload(base, desired, orderedWorkspace("two", "one", "three")),
    (error) => error instanceof HttpError && error.status === 409 && error.code === "WORKSPACE_CONFLICT" && error.message.includes("场景顺序"),
  );
});

test("场景排序冲突不提交部分修改，SQLite revision 和 JSON 镜像保持原样", async (t) => {
  const { root, store } = await harness(t);
  const filename = path.join(root, "workspace.json");
  const service = new WorkspaceService(store, filename);
  const initial = orderedWorkspace("one", "two", "three");
  const { workspace: base } = await service.initialize(initial);
  const saved = await service.merge(base, orderedWorkspace("two", "one", "three"));
  const conflicting = orderedWorkspace("three", "one", "two");
  conflicting.workflows.one = { name: "不应提交的内容" };
  await assert.rejects(service.merge(base, conflicting), (error) => error instanceof HttpError && error.status === 409);
  assert.deepEqual(await service.get(), saved);
  assert.deepEqual(await readJsonFile(filename), saved);
});


test("新增场景后立即排序的合并保存保留新场景位置，离线重试不退回列表末尾", () => {
  const base = orderedWorkspace("one", "two", "three");
  const desired = orderedWorkspace("new", "one", "two", "three");
  const current = orderedWorkspace("one", "two", "three", "other");
  assert.deepEqual(sceneOrder(mergeWorkspacePayload(base, desired, current)), ["new", "one", "two", "three", "other"]);
  const appended = orderedWorkspace("one", "two", "three", "new");
  const reorderedCurrent = orderedWorkspace("three", "one", "two", "other");
  assert.deepEqual(sceneOrder(mergeWorkspacePayload(base, appended, reorderedCurrent)), ["three", "one", "two", "other", "new"]);
});
