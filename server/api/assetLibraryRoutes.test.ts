import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import express from "express";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { aiHarness } from "../testing/aiSupport.js";
import { AccessService } from "../services/accessService.js";
import { createAssetRouter } from "./assetRoutes.js";
import { HttpError } from "../errors.js";
import { deferred, id, submission, workflow } from "../testing/testSupport.js";

async function harness(t: TestContext) {
  const h = await aiHarness(t, { executor: { kind: "fake", async execute() { return { image: ["data:image/png;base64,aXNvbGF0ZWQ="] }; } } });
  const access = new AccessService(h.store, h.workspace, "");
  const app = express(); app.use(express.json()); app.use(access.middleware(async () => h.settings.projectDirectory)); app.use(createAssetRouter(h.assets));
  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => res.status(error instanceof HttpError ? error.status : 500).json({ error: (error as Error).message, code: error instanceof HttpError ? error.code : "INTERNAL_ERROR", ...(error instanceof HttpError && error.details ? { details: error.details } : {}) }));
  const server = app.listen(0, "127.0.0.1"); await new Promise<void>(resolve => server.once("listening", resolve)); t.after(() => new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); }));
  const base = "http://127.0.0.1:" + (server.address() as { port: number }).port;
  async function account(name: string, role: "admin" | "user") {
    const user = (await access.create({ userId: randomUUID(), username: name, displayName: name, password: "asset-test-password", role })).user;
    const login = await access.login(name, "asset-test-password"); return { user, token: login.token, identity: access.authenticate(login.token) };
  }
  async function request(route: string, token: string, init: RequestInit = {}) { return fetch(base + route, { ...init, headers: { Authorization: "Bearer " + token, ...init.headers } }); }
  async function upload(token: string, createId: string, extra = "") { return request("/api/v1/assets/upload?createId=" + createId + "&kind=image&name=Hero" + extra, token, { method: "POST", headers: { "Content-Type": "application/octet-stream", "X-File-Name": "hero.png" }, body: "0123456789" }); }
  return { ...h, base, access, account, request, upload };
}

test("素材HTTP权限：管理员管理、身份归属、用户不能伪造/越权，HEAD/Range同权", async t => {
  const h = await harness(t); const admin = await h.account("admin", "admin"), user = await h.account("user", "user"); const assetId = randomUUID();
  assert.equal((await fetch(h.base + "/api/v1/assets")).status, 401);
  const uploaded = await h.upload(admin.token, assetId, "&description=rain&group=chapter&tags=%5B%22tag%22%5D"); assert.equal(uploaded.status, 201);
  const saved = await uploaded.json(); assert.equal(saved.asset.ownerUserId, admin.user.id); assert.equal(saved.asset.description, "rain"); assert.deepEqual(saved.asset.tags, ["tag"]); assert.equal(saved.asset.versions, undefined);
  for (const route of ["/api/v1/assets", "/api/v1/assets/" + assetId, "/api/v1/assets/" + assetId + "/versions", "/api/v1/assets/" + assetId + "/versions/1"]) assert.equal((await h.request(route, user.token)).status, 403, route);
  assert.equal((await h.upload(user.token, randomUUID())).status, 403);
  assert.equal((await h.request("/api/v1/assets/" + assetId, user.token, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ revision: 1, name: "steal" }) })).status, 403);
  const media = "/api/v1/assets/" + assetId + "/versions/1/media";
  for (const init of [{ method: "GET" }, { method: "HEAD" }, { headers: { Range: "bytes=2-5" } }]) assert.equal((await h.request(media, user.token, init)).status, 404);
  assert.equal((await h.request(media, admin.token, { method: "HEAD" })).headers.get("content-length"), "10"); assert.equal((await h.request(media, admin.token, { headers: { Range: "bytes=2-5" } })).status, 206);
  assert.equal((await h.upload(admin.token, randomUUID(), "&ownerUserId=" + user.user.id)).status, 400);
  for (const query of ["?limit=0", "?limit=101", "?archived=oops", "?kind=pdf", "?q=a&q=b"]) assert.equal((await h.request("/api/v1/assets" + query, admin.token)).status, 400);
  const owned = await h.assets.save({ name: "本人附件", kind: "image" }, { bytes: Buffer.from("input"), filename: "input.png" }, { assetId: randomUUID(), ownerUserId: user.user.id, authorize: () => { h.access.refresh(user.identity); } });
  assert.equal((await h.request(owned.reference.previewUrl!, user.token, { method: "HEAD" })).status, 200);
  const legacy = await h.assets.save({ name: "历史未归属", kind: "image" }, { bytes: Buffer.from("legacy"), filename: "legacy.png" }); assert.equal((await h.request(legacy.reference.previewUrl!, user.token)).status, 404);
});

test("素材HTTP：异步复制后的撤销会话不能落库，媒体异步读取前再次校验", async t => {
  const h = await harness(t); const admin = await h.account("admin", "admin");
  const started = deferred<void>(), gate = deferred<void>(), original = h.assets.storeStream.bind(h.assets);
  h.assets.storeStream = async (...args) => { const result = await original(...args); started.resolve(); await gate.promise; return result; };
  const assetId = randomUUID(); const pending = h.upload(admin.token, assetId); await started.promise;
  h.access.logout(admin.identity); gate.resolve(); assert.equal((await pending).status, 401); assert.equal(h.assets.get(h.settings.projectDirectory, assetId), undefined);
  h.assets.storeStream = original;
  const user = await h.account("user", "user"); const saved = await h.assets.save({ name: "附件", kind: "image" }, { bytes: Buffer.from("bytes"), filename: "input.png" }, { ownerUserId: user.user.id, assetId: randomUUID(), authorize: () => { h.access.refresh(user.identity); } });
  const mediaStarted = deferred<void>(), mediaGate = deferred<void>(), load = h.assets.loadSettings;
  Object.defineProperty(h.assets, "loadSettings", { value: async () => { mediaStarted.resolve(); await mediaGate.promise; return h.settings; }, configurable: true });
  const media = h.request(saved.reference.previewUrl!, user.token, { method: "HEAD" }); await mediaStarted.promise; h.access.logout(user.identity); mediaGate.resolve(); assert.equal((await media).status, 401);
  Object.defineProperty(h.assets, "loadSettings", { value: load });
});

test("真实stdio MCP素材库隔离闭环：上传/说明检索/版本/收藏/归档/冲突/权限", async t => {
  const h = await harness(t); const admin = await h.account("admin", "admin"), secondAdmin = await h.account("secondadmin", "admin"), user = await h.account("user", "user");
  async function connect(token: string) {
    const transport = new StdioClientTransport({ command: process.execPath, args: ["--import", "tsx", path.resolve("server/mcp/index.ts")], cwd: process.cwd(), env: { ...Object.fromEntries(Object.entries(process.env).filter((item): item is [string, string] => typeof item[1] === "string")), ZANE_BASE_URL: h.base, ZANE_API_TOKEN: token }, stderr: "pipe" });
    const client = new Client({ name: "asset-library-test", version: "1" }); await client.connect(transport); t.after(() => client.close());
    return async (name: string, args: Record<string, unknown> = {}) => {
      const result = await client.callTool({ name, arguments: args });
      if (!result.structuredContent) { assert.equal(result.isError, true); return { ok: false, data: undefined, error: { code: "MCP_INPUT_REJECTED", status: 400 } }; }
      return result.structuredContent as { ok: boolean; data: any; error?: { code: string; status: number } };
    };
  }
  const call = await connect(admin.token), denied = await connect(user.token);
  const file = path.join(h.root, "角色参考.png"); await writeFile(file, "isolated image"); const createId = randomUUID();
  const upload = await call("upload_asset", { createId, filePath: file, name: "角色", kind: "image", category: "character", description: "雨夜正面角色参考", group: "第一集", tags: ["角色", "雨夜"] }); assert.equal(upload.ok, true); assert.equal(upload.data.asset.id, createId); assert.deepEqual(upload.data.asset.tags, ["角色", "雨夜"]);
  const found = await call("list_assets", { q: "正面", group: "第一集", tag: "雨夜", limit: 1 }); assert.equal(found.data.assets[0].id, createId); assert.equal(found.data.assets[0].versionsOmitted, true);
  const reread = await call("get_asset", { assetId: createId }); assert.equal(reread.data.asset.revision, 1);
  assert.equal((await call("upload_asset", { createId, filePath: file, kind: "image" })).error?.code, "ASSET_ALREADY_EXISTS");
  const v2 = await call("upload_asset", { filePath: file, assetId: createId, revision: 1, name: "角色二版", kind: "image", description: "新说明", tags: ["更新"] }); assert.equal(v2.ok, true); assert.equal(v2.data.reference.assetVersion, 2); assert.equal(v2.data.asset.category, "character"); assert.equal(v2.data.asset.group, "第一集");
  const versions = await call("list_asset_versions", { assetId: createId, limit: 1 }); assert.equal(versions.data.versions[0].version, 2); assert.equal((await call("list_asset_versions", { assetId: createId, cursor: versions.data.nextCursor, limit: 1 })).data.versions[0].version, 1);
  assert.equal((await call("get_asset_version", { assetId: createId, version: 1 })).data.version.reference.assetVersion, 1);
  const extraId = randomUUID(); assert.equal((await call("upload_asset", { createId: extraId, filePath: file, kind: "image" })).ok, true);
  const page = (await call("list_assets", { limit: 1 })).data; assert.equal(page.hasMore, true);
  assert.equal((await call("list_assets", { limit: 1, cursor: page.nextCursor })).data.catalogRevision, page.catalogRevision);
  assert.equal((await h.request("/api/v1/assets?limit=1&cursor=" + page.nextCursor, secondAdmin.token)).status, 400);
  const edited = await call("update_asset", { assetId: createId, revision: 2, description: "适合雨夜对话", tags: [], archived: true }); assert.equal(edited.ok, true); assert.equal(edited.data.asset.description, "适合雨夜对话"); assert.equal(edited.data.asset.tags.length, 0);
  assert.equal((await call("update_asset", { assetId: createId, revision: 2, description: "过期写入" })).error?.code, "ASSET_CONFLICT");
  assert.equal((await call("list_assets", { cursor: page.nextCursor })).error?.code, "ASSET_PAGE_CHANGED");
  assert.equal((await call("list_assets")).data.total, 1); assert.equal((await call("list_assets", { archived: true })).data.total, 2);
  await h.service.start(); const definition = workflow([{ id: "image", name: "假媒体", kind: "fake", outputs: [{ key: "image", type: "image" }], promptTemplate: "雨夜人物" }]); const run = await h.service.submit(submission(id("mcp-asset-source"), definition)); await h.service.wait(h.settings.projectDirectory, run.runId);
  const saved = await call("save_asset", { createId: randomUUID(), name: "运行收藏", description: "来源说明", category: "scene", tags: ["来源"], source: { runId: run.runId, stepId: "image", outputKey: "image", mediaIndex: 0 } }); assert.equal(saved.ok, true);
  const source = await call("get_asset_version", { assetId: saved.data.asset.id, version: 1, includeParameters: true, parametersLimit: 10 }); assert.equal(source.data.version.source.runId, run.runId); assert.equal(source.data.parameters.hasMore, true);
  let text = source.data.parameters.text, offset = source.data.parameters.nextOffset;
  while (offset !== undefined) { const chunk = (await call("get_asset_version", { assetId: saved.data.asset.id, version: 1, includeParameters: true, parametersOffset: offset })).data.parameters; text += chunk.text; offset = chunk.nextOffset; } assert.equal(JSON.parse(text).step.promptTemplate, "雨夜人物");
  assert.equal((await denied("list_assets")).error?.code, "ADMIN_REQUIRED"); assert.equal((await denied("get_asset", { assetId: createId })).error?.code, "ADMIN_REQUIRED");
  assert.equal((await denied("upload_asset", { createId: randomUUID(), filePath: file, kind: "image" })).error?.code, "ADMIN_REQUIRED");
  const invalid = await call("update_asset", { assetId: createId, revision: 3, ownerUserId: user.user.id }); assert.equal(invalid.ok, false);
});
