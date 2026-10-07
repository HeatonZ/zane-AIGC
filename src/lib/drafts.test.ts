import assert from "node:assert/strict";
import test from "node:test";
import { sortWorkflowDrafts, sortOwnDrafts } from "./drafts.js";
import type { WorkflowDraft } from "../types.js";
const draft = (id: string, createdAt: string, isFavorite?: boolean): WorkflowDraft => ({ id, sceneId: "demo", title: id, summary: id, status: "draft", createdAt, ...(isFavorite === undefined ? {} : { isFavorite }) });

test("收藏置顶，组内最近保存，同时间按稳定ID排序，旧草稿未收藏；不修改输入数组", () => {
  const values = [draft("new", "2026-10-05"), draft("z", "2026-09-01", true), draft("a", "2026-09-01", true), draft("old", "2026-08-01", false)];
  const before = structuredClone(values);
  assert.deepEqual(sortWorkflowDrafts(values).map(item => item.id), ["a", "z", "new", "old"]);
  assert.deepEqual(values, before);
  assert.deepEqual(sortWorkflowDrafts([]), []);
});
test("取消收藏恢复原来的保存时间顺序；继续编辑的收藏草稿仍置顶", () => {
  const values = [draft("favorite", "2026-01-01", true), draft("recent", "2026-10-05")];
  assert.equal(sortWorkflowDrafts(values)[0].id, "favorite");
  assert.equal(sortWorkflowDrafts(values.map(item => ({ ...item, isFavorite: false })))[0].id, "recent");
});

test("本人收藏确认后立即按updatedAt置顶，即使后续列表刷新失败也不留在旧位置", () => {
  const loaded = [ { id: "recent", updatedAt: "2026-10-05", isFavorite: false }, { id: "old", updatedAt: "2026-09-01", isFavorite: false } ];
  const confirmed = loaded.map(item => item.id === "old" ? { ...item, isFavorite: true } : item);
  assert.deepEqual(sortOwnDrafts(confirmed).map(item => item.id), ["old", "recent"]);
  assert.equal(loaded[0].id, "recent"); assert.equal(loaded[1].isFavorite, false);
});
