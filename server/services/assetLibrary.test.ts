import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { productionHarness } from "../testing/productionSupport.js";
import { id } from "../testing/testSupport.js";
import { HttpError } from "../errors.js";
const isCode = (code: string) => (error: unknown) => error instanceof HttpError && error.code === code;

test("素材库：说明/分组/标签搜索、摘要、游标边界及目录变化", async t => {
  const h = await productionHarness(t), project = h.settings.projectDirectory;
  assert.equal(h.assets.catalog(project).total, 0);
  const records = [];
  for (let i = 0; i < 3; i++) records.push((await h.assets.save({ createId: id("catalog-" + i), name: "素材" + i, kind: "image", category: "character", description: "雨夜街头参考", group: "第一集", tags: ["雨夜", "主角"] }, { bytes: Buffer.from("pixels-" + i), filename: "hero.png" })).asset);
  const first = h.assets.catalog(project, { q: "雨夜街头", category: "character", group: "第一集", tag: "主角", limit: 1 }, "admin-a");
  assert.equal(first.total, 3); assert.equal(first.assets.length, 1); assert.equal(first.hasMore, true); assert.equal(first.assets[0].versionsOmitted, true); assert.ok(!("versions" in first.assets[0])); assert.equal(first.assets[0].description, "雨夜街头参考");
  const second = h.assets.catalog(project, { q: "雨夜街头", category: "character", group: "第一集", tag: "主角", limit: 1, cursor: first.nextCursor }, "admin-a");
  assert.equal(second.catalogRevision, first.catalogRevision); assert.notEqual(second.assets[0].id, first.assets[0].id);
  const third = h.assets.catalog(project, { q: "雨夜街头", category: "character", group: "第一集", tag: "主角", limit: 1, cursor: second.nextCursor }, "admin-a"); assert.equal(third.hasMore, false); assert.equal(third.nextCursor, undefined);
  assert.throws(() => h.assets.catalog(project, { cursor: first.nextCursor }, "admin-a"), isCode("INVALID_ASSET_CURSOR"));
  assert.throws(() => h.assets.catalog(project, { q: "雨夜街头", category: "character", group: "第一集", tag: "主角", cursor: first.nextCursor }, "admin-b"), isCode("INVALID_ASSET_CURSOR"));
  for (const query of [{ limit: 0 }, { limit: 101 }, { kind: "document" }, { archived: "false" }, { cursor: "broken" }, { arbitrary: true }]) assert.throws(() => h.assets.catalog(project, query), error => error instanceof HttpError && error.status === 400);
  const last = records[2]; await h.assets.update(last.id, { revision: last.revision, archived: true });
  assert.throws(() => h.assets.catalog(project, { q: "雨夜街头", category: "character", group: "第一集", tag: "主角", cursor: first.nextCursor }, "admin-a"), isCode("ASSET_PAGE_CHANGED"));
  assert.equal(h.assets.catalog(project).total, 2); assert.equal(h.assets.catalog(project, { archived: true }).total, 3);
});

test("素材库：稳定创建ID并发、旧revision及历史固定引用", async t => {
  const h = await productionHarness(t), project = h.settings.projectDirectory;
  const createId = id("shared-create");
  const body = { createId, name: "雨夜角色", kind: "image", description: "第一版" };
  const results = await Promise.allSettled([h.assets.save(body, { bytes: Buffer.from("first"), filename: "first.png" }), h.assets.save(body, { bytes: Buffer.from("second"), filename: "second.png" })]);
  assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
  const rejected = results.find(result => result.status === "rejected") as PromiseRejectedResult; assert.ok(isCode("ASSET_ALREADY_EXISTS")(rejected.reason));
  const asset = h.assets.detail(project, createId).asset; assert.equal(asset.currentVersion, 1); assert.equal(asset.revision, 1); assert.equal(h.assets.catalog(project).total, 1);
  await assert.rejects(h.assets.save(body, { bytes: Buffer.from("duplicate"), filename: "third.png" }), isCode("ASSET_ALREADY_EXISTS"));
  const old = await readFile(h.assets.file(project, createId, 1));
  const appended = await h.assets.save({ assetId: createId, revision: asset.revision, kind: "image", name: "雨夜角色", description: "第二版" }, { bytes: Buffer.from("v2"), filename: "second.png" });
  assert.equal(appended.asset.currentVersion, 2); assert.deepEqual(await readFile(h.assets.file(project, createId, 1)), old);
  await assert.rejects(h.assets.update(createId, { revision: asset.revision, description: "覆盖" }), isCode("ASSET_CONFLICT"));
  const updated = await h.assets.update(createId, { revision: appended.asset.revision, archived: true, tags: ["固定"] }); assert.equal(updated.description, "第二版");
  assert.ok(await h.assets.resolveValue(project, "image", { assetId: createId, assetVersion: 1 }));
  const page = h.assets.versionsPage(project, createId, { limit: 1 }, "admin"); assert.equal(page.versions[0].version, 2);
  assert.equal(h.assets.versionsPage(project, createId, { limit: 1, cursor: page.nextCursor }, "admin").versions[0].version, 1);
  await h.assets.update(createId, { revision: updated.revision, archived: false });
  assert.throws(() => h.assets.versionsPage(project, createId, { cursor: page.nextCursor }, "admin"), isCode("ASSET_PAGE_CHANGED"));
});

test("素材库：大生成参数明确省略/分段，非法字段不静默截断", async t => {
  const h = await productionHarness(t), project = h.settings.projectDirectory;
  const { asset } = await h.assets.save({ name: "参数素材", kind: "image" }, { bytes: Buffer.from("image"), filename: "image.png" });
  const parameters = { prompt: "雨夜人物".repeat(6000) };
  h.assets.put(project, { ...asset, versions: [{ ...asset.versions[0], parameters }] }, asset.revision);
  const page = h.assets.versionsPage(project, asset.id); assert.equal(page.versions[0].parametersOmitted, true); assert.ok(!("parameters" in page.versions[0]));
  const summary = h.assets.versionDetail(project, asset.id, 1); assert.equal(summary.parameters, undefined);
  let json = "", offset = 0;
  for (;;) { const result = h.assets.versionDetail(project, asset.id, 1, { includeParameters: true, parametersOffset: offset, parametersLimit: 999 }).parameters!; assert.ok(result.text.length <= 999); json += result.text; if (!result.hasMore) break; offset = result.nextOffset!; }
  assert.deepEqual(JSON.parse(json), parameters);
  assert.throws(() => h.assets.versionDetail(project, asset.id, 1, { includeParameters: true, parametersOffset: 999999 }), isCode("INVALID_ASSET_REQUEST"));
  assert.throws(() => h.assets.versionDetail(project, asset.id, 1, { parametersOffset: 1 }), isCode("INVALID_ASSET_REQUEST"));
  assert.throws(() => h.assets.versionDetail(project, asset.id, 4), isCode("ASSET_VERSION_NOT_FOUND"));
  const revision = h.assets.get(project, asset.id)!.revision;
  for (const body of [{ description: "x".repeat(4001) }, { tags: [1] }, { tags: Array(31).fill("tag") }, { tags: ["x".repeat(81)] }, { ownerUserId: "spoof" }, { archived: "yes" }, { name: " " }]) await assert.rejects(h.assets.update(asset.id, { revision, ...body }), isCode("INVALID_ASSET_REQUEST"));
  assert.equal(h.assets.get(project, asset.id)!.revision, revision);
});
