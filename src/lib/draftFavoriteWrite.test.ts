import assert from "node:assert/strict";
import test from "node:test";
import { AccessApiError } from "./accessApi.js";
import { DraftFavoriteUnconfirmedError, writeDraftFavorite } from "./draftFavoriteWrite.js";

test("收藏成功只写一次，不多余读取", async () => {
  let writes = 0; let reads = 0;
  const result = await writeDraftFavorite({ isFavorite: true, write: async () => { writes++; return { isFavorite: true }; }, read: async () => { reads++; return { isFavorite: true }; }, favorite: value => value.isFavorite });
  assert.equal(result.outcome, "saved"); assert.equal(writes, 1); assert.equal(reads, 0);
});
test("收藏回执丢失按原ID读取已完成状态，不重放写入；未生效明确未保存", async () => {
  for (const actual of [true, false]) {
    let writes = 0; let reads = 0;
    const result = await writeDraftFavorite({ isFavorite: true, write: async () => { writes++; throw new AccessApiError("unknown", 0); }, read: async () => { reads++; return { id: "original", isFavorite: actual, revision: 2 }; }, favorite: value => value.isFavorite });
    assert.equal(result.snapshot.id, "original"); assert.equal(result.outcome, actual ? "reconciled" : "not_saved"); assert.equal(writes, 1); assert.equal(reads, 1);
  }
});
test("旧revision冲突即使目标状态相同也不假报成功；读取失败后阻止盲重试", async () => {
  let writes = 0;
  const result = await writeDraftFavorite({ isFavorite: true, write: async () => { writes++; throw new AccessApiError("stale", 409); }, read: async () => ({ isFavorite: true }), favorite: value => value.isFavorite });
  assert.equal(result.outcome, "not_saved"); assert.ok(result.error); assert.equal(writes, 1);
  await assert.rejects(writeDraftFavorite({ isFavorite: false, write: async () => { throw new AccessApiError("unknown", 0); }, read: async (): Promise<{isFavorite: boolean}> => { throw new Error("offline"); }, favorite: value => value.isFavorite }), DraftFavoriteUnconfirmedError);
});
test("确定的无权限/无效参数失败不读也不重放", async () => {
  let reads = 0;
  await assert.rejects(writeDraftFavorite({ isFavorite: true, write: async () => { throw new AccessApiError("forbidden", 403); }, read: async () => { reads++; return { isFavorite: true }; }, favorite: value => value.isFavorite }), /forbidden/);
  assert.equal(reads, 0);
});

test("上游5xx也可能已写入，必须按原ID读取而不是当作确定失败重投", async () => {
  let writes = 0; let reads = 0;
  const result = await writeDraftFavorite({ isFavorite: true, write: async () => { writes++; throw new AccessApiError("gateway", 502); }, read: async () => { reads++; return { isFavorite: true }; }, favorite: value => value.isFavorite });
  assert.equal(result.outcome, "reconciled"); assert.equal(writes, 1); assert.equal(reads, 1);
  await assert.rejects(writeDraftFavorite({ isFavorite: true, write: async () => { throw new AccessApiError("server", 500); }, read: async (): Promise<{isFavorite:boolean}> => { throw new Error("offline"); }, favorite: value => value.isFavorite }), DraftFavoriteUnconfirmedError);
});
