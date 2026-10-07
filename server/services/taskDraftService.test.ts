import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { readFile, writeFile } from "node:fs/promises";
import { harness } from "../testing/testSupport.js";
import { WorkspaceService, normalizeWorkspacePayload } from "./workspaceService.js";
import { TaskDraftService } from "./taskDraftService.js";
import { HttpError } from "../errors.js";
import { taskDraftEnvelopeSchema, taskDraftPageSchema } from "../ai/taskDraftSchemas.js";
const draft = (id: string, createdAt: string, isFavorite?: boolean) => ({ id, sceneId: "demo", title: id, summary: "长摘要".repeat(1000), inputValues: { text: "原输入" }, runResult: { runId: "recorded-run", steps: [{ arbitrary: "保留历史" }] }, createdAt, status: "draft", ...(isFavorite === undefined ? {} : { isFavorite }) });
const snapshot = (drafts: unknown[]) => ({ format: "zane-studio.workspace/v1", scenes: [], workflows: {}, optionPresets: [], sceneVersions: {}, drafts });
const conflict = (error: unknown) => error instanceof HttpError && error.status === 409 && error.code === "DRAFT_REVISION_CONFLICT";

test("任务草稿收藏使用原SQLite工作区，原内容/时间保留；丢失回执读原ID，取消收藏/同值/重启", async t => {
  const h = await harness(t); const mirror = path.join(h.root, "draft-workspace.json");
  const workspace = new WorkspaceService(h.store, mirror); const service = new TaskDraftService(workspace);
  await workspace.initialize(snapshot([draft("old", "2026-09-01"), draft("new", "2026-10-05")]));
  const original = await service.get("old"); assert.equal(original.draft.isFavorite, false);
  const saved = await service.setFavorite("old", { revision: original.revision, isFavorite: true }, () => {});
  assert.equal(saved.revision, original.revision + 1); taskDraftEnvelopeSchema.parse(saved);
  const stored = (h.store.getWorkspace()!.drafts as Record<string,unknown>[]).find(item => item.id === "old")!;
  assert.deepEqual(stored, { ...draft("old", "2026-09-01"), isFavorite: true });
  // Discard the receipt, then read the original ID without sending another write.
  assert.equal((await service.get("old")).draft.isFavorite, true);
  assert.equal((await service.get("old")).revision, saved.revision);
  const page = await service.list({ limit: 1 }, "admin"); taskDraftPageSchema.parse(page);
  assert.equal(page.items[0].id, "old"); assert.equal(page.items[0].summaryOmitted, true); assert.equal(page.items[0].inputValuesOmitted, true); assert.equal(page.items[0].runResultOmitted, true);
  assert.ok(!("summary" in page.items[0]) && !("inputValues" in page.items[0]) && !("runResult" in page.items[0]));
  const detail = await service.get("old"); taskDraftEnvelopeSchema.parse(detail); assert.deepEqual(detail.draft.inputValues, { text: "原输入" }); assert.equal(detail.draft.runId, "recorded-run");
  const noOp = await service.setFavorite("old", { revision: saved.revision, isFavorite: true }, () => {}); assert.equal(noOp.revision, saved.revision);
  const unfavorite = await service.setFavorite("old", { revision: saved.revision, isFavorite: false }, () => {});
  assert.equal((await service.list({}, "admin")).items[0].id, "new");
  assert.equal(JSON.parse(await readFile(mirror, "utf8")).revision, unfavorite.revision);
  await workspace.shutdown(); await writeFile(mirror, "{broken-export}");
  const restarted = new TaskDraftService(new WorkspaceService(h.store, mirror));
  assert.equal((await restarted.get("old")).draft.isFavorite, false); assert.equal((await restarted.get("old")).revision, unfavorite.revision);
});

test("收藏并发只有一个相同revision写入成功，失败不落库；权限在锁内复核", async t => {
  const h = await harness(t); const workspace = new WorkspaceService(h.store, path.join(h.root, "workspace.json")); const service = new TaskDraftService(workspace);
  await workspace.initialize(snapshot([draft("a", "2026-10-01"), draft("b", "2026-10-02")]));
  const before = await service.get("a");
  const results = await Promise.allSettled(["a", "b"].map(id => service.setFavorite(id, { revision: before.revision, isFavorite: true }, () => {})));
  assert.equal(results.filter(item => item.status === "fulfilled").length, 1); assert.equal(results.filter(item => item.status === "rejected" && conflict(item.reason)).length, 1);
  const current = await workspace.get();
  await assert.rejects(service.setFavorite("b", { revision: Number(current!.revision), isFavorite: true }, () => { throw new HttpError(403, "身份已经降级", "ADMIN_REQUIRED"); }), /身份已经降级/);
  assert.deepEqual(await workspace.get(), current);
  await assert.rejects(service.setFavorite("a", { revision: before.revision, isFavorite: true }, () => {}), conflict);
});

test("收藏分页无重复，列表变更旧游标409；游标身份/边界与无效参数", async t => {
  const h = await harness(t); const workspace = new WorkspaceService(h.store, path.join(h.root, "workspace.json")); const service = new TaskDraftService(workspace);
  await assert.rejects(service.list({}, "admin"), /尚未初始化/);
  await workspace.initialize(snapshot([draft("a", "2026-10-01", true), draft("b", "2026-10-02"), draft("c", "2026-10-03")]));
  const first = await service.list({ limit: 1 }, "admin"); const second = await service.list({ limit: 1, cursor: first.nextCursor }, "admin"); const third = await service.list({ limit: 1, cursor: second.nextCursor }, "admin");
  assert.deepEqual([first, second, third].flatMap(page => page.items.map(item => item.id)), ["a", "c", "b"]); assert.equal(third.hasMore, false);
  await assert.rejects(service.list({ cursor: first.nextCursor }, "another"), /游标无效/);
  await assert.rejects(service.list({ limit: 0 }, "admin"), /分页条数无效/);
  await assert.rejects(service.list({ cursor: "invalid" }, "admin"), /游标无效/);
  await assert.rejects(service.setFavorite("missing", { revision: 1, isFavorite: true }, () => {}), /不存在/);
  await assert.rejects(service.setFavorite("a", { revision: 1, isFavorite: "true" as unknown as boolean }, () => {}), /收藏参数无效/);
  await service.setFavorite("b", { revision: first.workspaceRevision, isFavorite: true }, () => {});
  await assert.rejects(service.list({ cursor: first.nextCursor }, "admin"), error => error instanceof HttpError && error.code === "ACCESS_PAGE_CHANGED");
});

test("旧编辑器保存草稿保留收藏，显式false才取消；无效收藏值拒绝", async t => {
  const h = await harness(t); const workspace = new WorkspaceService(h.store, path.join(h.root, "workspace.json"));
  const initial = await workspace.initialize(snapshot([draft("a", "2026-10-01", true)]));
  const edited = snapshot([{ ...draft("a", "2026-10-02"), title: "继续编辑" }]);
  const result = await workspace.merge(initial.workspace, edited);
  assert.equal((result.drafts as Record<string,unknown>[])[0].isFavorite, true);
  assert.equal((result.drafts as Record<string,unknown>[])[0].title, "继续编辑");
  assert.throws(() => normalizeWorkspacePayload(snapshot([{ id: "invalid", isFavorite: "false" }])), /必须是布尔值/);
});
