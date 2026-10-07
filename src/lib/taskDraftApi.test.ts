import assert from "node:assert/strict";
import test from "node:test";
import { getOwnDraft, setOwnDraftFavorite, getTaskDraft, setTaskDraftFavorite } from "./taskDraftApi.js";
import { writeDraftFavorite, DraftFavoriteUnconfirmedError } from "./draftFavoriteWrite.js";

const response = (value: unknown) => new Response(JSON.stringify(value), { status: 200, headers: { "Content-Type": "application/json" } });
for (const own of [false, true]) test(`${own ? "本人" : "管理端"}收藏客户端：无效成功回执按原ID读取，不重放、保留身份和revision`, async t => {
  const id = "original-draft", actor = "actor";
  const draft = own
    ? { id, userId: actor, revision: 2, sceneId: "demo", versionId: "version", title: "草稿", updatedAt: "2026-10-05", inputValues: { text: "保留" }, isFavorite: true }
    : { id, revision: 2, sceneId: "demo", title: "草稿", createdAt: "2026-10-05", status: "draft", isFavorite: true, summaryOmitted: false, inputValuesOmitted: false, runResultOmitted: false };
  const envelope = own ? { draft } : { draft, revision: 2, nextAction: "get_task_draft" };
  const calls: Array<{ path: string; method: string; actor: string | null; body?: unknown }> = [];
  t.mock.method(globalThis, "fetch", async (input: string, options: RequestInit = {}) => {
    const method = options.method ?? "GET";
    calls.push({ path: input, method, actor: new Headers(options.headers).get("X-Zane-Actor"), ...(options.body ? { body: JSON.parse(String(options.body)) } : {}) });
    return response(method === "PATCH" ? { malformedSuccess: true } : envelope);
  });
  const mutation = { revision: 1, isFavorite: true };
  const result = own
    ? await writeDraftFavorite({ isFavorite: true, write: () => setOwnDraftFavorite(id, mutation, actor), read: () => getOwnDraft(id, actor), favorite: value => value.draft.isFavorite })
    : await writeDraftFavorite({ isFavorite: true, write: () => setTaskDraftFavorite(id, mutation, actor), read: () => getTaskDraft(id, actor), favorite: value => value.draft.isFavorite });
  assert.equal(result.outcome, "reconciled"); assert.equal(result.snapshot.draft.id, id);
  assert.deepEqual(calls.map(call => call.method), ["PATCH", "GET"]);
  assert.equal(calls[0].path, calls[1].path + "/favorite"); assert.deepEqual(calls[0].body, mutation);
  assert.ok(calls.every(call => call.actor === actor));
});
test("成功回执及对账都不可解析时明确unknown，不允许将空值当未收藏", async t => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => { calls++; return response({ invalid: true }); });
  await assert.rejects(writeDraftFavorite({ isFavorite: true, write: () => setTaskDraftFavorite("stable", { revision: 1, isFavorite: true }, "actor"), read: () => getTaskDraft("stable", "actor"), favorite: value => value.draft.isFavorite }), DraftFavoriteUnconfirmedError);
  assert.equal(calls, 2);
});
