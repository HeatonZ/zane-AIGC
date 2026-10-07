import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { listAssets, listAssetVersions, getAssetVersion, uploadAsset, saveAsset, getAsset, ApiError } from "./api";
import { setCurrentActor, currentActorId } from "./accessApi";
import { pendingAssetWrites, clearAssetWrite } from "./assetWriteRecovery";
function browser(t: TestContext) {
  const originalFetch = globalThis.fetch, actor = currentActorId;
  const windowDescriptor = Object.getOwnPropertyDescriptor(globalThis, "window"), storageDescriptor = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  const data = new Map<string, string>(); const events = new EventTarget();
  Object.defineProperty(globalThis, "window", { configurable: true, value: { dispatchEvent: events.dispatchEvent.bind(events) } });
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => data.set(key, value) } });
  setCurrentActor("admin-a");
  t.after(() => { globalThis.fetch = originalFetch; setCurrentActor(actor); if (windowDescriptor) Object.defineProperty(globalThis, "window", windowDescriptor); else Reflect.deleteProperty(globalThis, "window"); if (storageDescriptor) Object.defineProperty(globalThis, "localStorage", storageDescriptor); else Reflect.deleteProperty(globalThis, "localStorage"); });
  return data;
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const createId = "00000000-0000-4000-8000-000000000111";
const asset = { id: createId, revision: 1, currentVersion: 1, versionCount: 1, versionsOmitted: true, description: "", name: "Hero", kind: "image", group: "", tags: [] };

test("素材前端：检索/版本分页参数透传，读取不写outbox", async t => {
  browser(t); const urls: URL[] = [];
  globalThis.fetch = (async (input, options) => { urls.push(new URL(String(input), "http://localhost")); assert.equal((options?.headers as Record<string, string>)["X-Zane-Actor"], "admin-a"); return json({ schemaVersion: 1, catalogRevision: "snapshot", assets: [], assetId: createId, revision: 1, versions: [], total: 0, hasMore: false, version: { version: 2, reference: { assetId: createId, assetVersion: 2 } } }); }) as typeof fetch;
  await listAssets({ q: "雨夜", kind: "image", group: "第一集", tag: "角色", limit: 1, cursor: "opaque" });
  await listAssetVersions(createId, { limit: 1, cursor: "versions-page" }); await getAssetVersion(createId, 2, { includeParameters: true, parametersOffset: 8000, parametersLimit: 1000 });
  assert.equal(urls[0].searchParams.get("q"), "雨夜"); assert.equal(urls[0].searchParams.get("group"), "第一集"); assert.equal(urls[0].searchParams.get("cursor"), "opaque"); assert.equal(urls[1].searchParams.get("cursor"), "versions-page"); assert.equal(urls[2].searchParams.get("parametersOffset"), "8000"); assert.equal(pendingAssetWrites().length, 0);
});

test("素材上传：说明和标签正确编码，发送前保留createId，确认响应后清除", async t => {
  browser(t); let count = 0;
  globalThis.fetch = (async (input) => { count++; const url = new URL(String(input), "http://localhost"); assert.equal(url.searchParams.get("createId"), createId); assert.equal(url.searchParams.get("description"), "雨夜用途"); assert.deepEqual(JSON.parse(url.searchParams.get("tags")!), ["角色", "雨夜"]); assert.equal(pendingAssetWrites()[0].assetId, createId); return json({ asset, reference: { assetId: createId, assetVersion: 1 } }, 201); }) as typeof fetch;
  await uploadAsset(new File(["pixels"], "hero.png", { type: "image/png" }), { createId, name: "Hero", kind: "image", category: "character", description: "雨夜用途", tags: ["角色", "雨夜"] }); assert.equal(count, 1); assert.equal(pendingAssetWrites().length, 0);
});

test("素材回执未知：按身份保留原ID，只读对账，不自动重放或换ID", async t => {
  browser(t); let writes = 0, reads = 0;
  const body = { createId, source: { runId: createId, outputKey: "image", mediaIndex: 0 }, name: "Hero", category: "material" };
  globalThis.fetch = (async (_input, options) => { if (options?.method === "POST") { writes++; throw new Error("response lost"); } reads++; return json({ asset, reference: { assetId: createId, assetVersion: 1 } }); }) as typeof fetch;
  await assert.rejects(saveAsset(body), /回执未确认/); const item = pendingAssetWrites()[0]; assert.equal(item.assetId, createId); assert.equal(writes, 1);
  await assert.rejects(saveAsset({ ...body, createId: "00000000-0000-4000-8000-000000000222" }), /不要重复上传/); assert.equal(writes, 1);
  setCurrentActor("admin-b"); assert.equal(pendingAssetWrites().length, 0); setCurrentActor("admin-a"); assert.equal(pendingAssetWrites()[0].assetId, createId);
  await getAsset(createId); assert.equal(reads, 1); assert.equal(writes, 1); assert.equal(pendingAssetWrites().length, 1); clearAssetWrite(item); assert.equal(pendingAssetWrites().length, 0);
});

test("素材响应解码失败保留防丢提示；已明确拒绝的冲突不残留；无效outbox不丢弃", async t => {
  const data = browser(t);
  globalThis.fetch = (async () => new Response("not-json", { status: 201 })) as typeof fetch;
  const file = new File(["pixels"], "hero.png"); const metadata = { createId, name: "Hero", kind: "image" as const, category: "material" };
  await assert.rejects(uploadAsset(file, metadata), /回执未确认/); clearAssetWrite(pendingAssetWrites()[0]);
  globalThis.fetch = (async () => json({ code: "ASSET_ALREADY_EXISTS", error: "ID已存在" }, 409)) as typeof fetch;
  await assert.rejects(uploadAsset(file, metadata), error => error instanceof ApiError && error.status === 409); assert.equal(pendingAssetWrites().length, 0);
  data.set("zane-asset-outbox/v1:admin-a", "not-json"); assert.throws(() => pendingAssetWrites()); assert.equal(data.get("zane-asset-outbox/v1:admin-a"), "not-json");
});


test("素材JSON回执缺少稳定对象/版本字段也视为未知写入，不错误宣称成功", async t => {
  browser(t); globalThis.fetch = (async () => json({ ok: true }, 201)) as typeof fetch;
  await assert.rejects(uploadAsset(new File(["pixels"], "hero.png"), { createId, name: "Hero", kind: "image", category: "material" }), /回执未确认/);
  assert.equal(pendingAssetWrites()[0].assetId, createId);
});
