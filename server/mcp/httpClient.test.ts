import assert from "node:assert/strict";
import test from "node:test";
import type { TestContext } from "node:test";
import { createServer } from "node:http";
import type { RequestListener } from "node:http";
import { WorkbenchHttpClient } from "./httpClient.js";
import { aiOperations, operationRequest } from "../ai/operations.js";
import { id } from "../testing/testSupport.js";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { productionHarness } from "../testing/productionSupport.js";
const op = (name: string) => aiOperations.find(operation => operation.name === name)!;
async function http(t: TestContext, handler: RequestListener) {
  const server = createServer(handler); server.listen(0, "127.0.0.1"); await new Promise<void>(resolve => server.once("listening", resolve));
  t.after(() => new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); }));
  return "http://127.0.0.1:" + (server.address() as { port: number }).port;
}

test("HTTP工具映射正确编码路径，来源ID不混入body，新runId留在body", () => {
  const request = operationRequest(op("resume_run"), { sourceRunId: id("source"), runId: id("target"), runTitle: "new" }); assert.equal(request.path, "/api/v1/runs/" + id("source") + "/resume"); assert.deepEqual(request.args, { runId: id("target"), runTitle: "new" });
  assert.equal(operationRequest(op("get_scene"), { sceneId: "name / 中文?", versionId: "a" }).path, "/api/v1/scenes/name%20%2F%20%E4%B8%AD%E6%96%87%3F");
});

test("HTTP提交响应丢失：一次POST，结果unknown携带原ID；查询对账不会生成第二次", async t => {
  let posts = 0; let accepted: unknown;
  const base = await http(t, async (req, res) => {
    if (req.method === "POST") { posts++; let body = ""; for await (const chunk of req) body += chunk; accepted = JSON.parse(body); res.destroy(); }
    else { res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify({ runId: (accepted as { runId: string }).runId, status: "queued" })); }
  });
  const client = new WorkbenchHttpClient(base);
  const runId = id("lost-http-response"); const result = await client.call(op("submit_scene"), { sceneId: "demo", versionId: "fixed", inputValues: {}, runId });
  assert.equal(result.ok, false); assert.equal(result.error?.outcome, "unknown"); assert.equal(result.error?.runId, runId); assert.match(result.error!.recovery, /禁止自动/); assert.equal(posts, 1);
  assert.equal((await client.call(op("get_run"), { runId })).ok, true); assert.equal(posts, 1);
});

test("HTTP错误透传code/requestId/Retry-After；重复ID不假装幂等成功", async t => {
  let preparing = true;
  const base = await http(t, (_req, res) => { res.writeHead(409, { "Content-Type": "application/json", "X-Request-ID": "request-42", "Retry-After": "1" }); res.end(JSON.stringify({ error: "conflict", code: preparing ? "RUN_PREPARING" : "RUN_ALREADY_EXISTS" })); });
  const client = new WorkbenchHttpClient(base); const runId = id("conflicting-run");
  const result = await client.call(op("get_run"), { runId }); assert.equal(result.error?.code, "RUN_PREPARING"); assert.equal(result.error?.retryAfterSeconds, 1); assert.equal(result.requestId, "request-42");
  preparing = false; const duplicate = await client.call(op("submit_scene"), { sceneId: "demo", versionId: "v", runId, inputValues: {} }); assert.equal(duplicate.ok, false); assert.equal(duplicate.error?.outcome, "rejected"); assert.match(duplicate.error!.recovery, /不是请求内容幂等重放成功/);
});

test("HTTP执行500/非JSON响应都是未知提交，不能自动重放", async t => {
  let html = false; let posts = 0;
  const base = await http(t, (_req, res) => { posts++; res.statusCode = html ? 200 : 500; res.end(html ? "<!doctype html>" : JSON.stringify({ error: "late failure", code: "INTERNAL_ERROR" })); });
  const client = new WorkbenchHttpClient(base); const input = { sceneId: "demo", versionId: "v", runId: id("uncertain-submit"), inputValues: {} };
  assert.equal((await client.call(op("submit_scene"), input)).error?.outcome, "unknown"); html = true;
  const malformed = await client.call(op("submit_scene"), input); assert.equal(malformed.error?.code, "INVALID_API_RESPONSE"); assert.equal(malformed.error?.outcome, "unknown"); assert.equal(posts, 2);
});

test("HTTP执行超时/取消不重放POST，纯查询超时只是read_failed", async t => {
  let posts = 0;
  const base = await http(t, (req) => { if (req.method === "POST") posts++; });
  const client = new WorkbenchHttpClient(base, 1000);
  const result = await client.call(op("submit_scene"), { sceneId: "demo", versionId: "v", runId: id("timeout-submit"), inputValues: {} }); assert.equal(result.error?.code, "API_TIMEOUT"); assert.equal(result.error?.outcome, "unknown"); assert.equal(posts, 1);
  const signal = new AbortController(); setTimeout(() => signal.abort(), 10);
  const read = await client.call(op("get_run"), { runId: id("timeout-read") }, signal.signal); assert.equal(read.error?.code, "CALL_ABORTED"); assert.equal(read.error?.outcome, "read_failed");
});

test("MCP后台地址和超时配置错误在启动阶段拒绝，不能用API路径代替根地址", () => {
  for (const value of ["file:///tmp", "http://127.0.0.1/api", "http://127.0.0.1/?q=a", "http://user:pass@127.0.0.1"]) assert.throws(() => new WorkbenchHttpClient(value));
  assert.throws(() => new WorkbenchHttpClient("http://127.0.0.1", 0)); assert.equal(new WorkbenchHttpClient("http://127.0.0.1:8799/").baseUrl, "http://127.0.0.1:8799");
});


test("HTTP发布响应丢失：保留publicationId恢复提示，不自动重放", async t => {
  let posts = 0; let accepted: Record<string, unknown> = {};
  const base = await http(t, async (req, res) => {
    if (req.method === "POST") { posts++; let body = ""; for await (const chunk of req) body += chunk; accepted = JSON.parse(body); res.destroy(); }
    else { res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify({ sceneId: "demo", versionId: accepted.publicationId })); }
  });
  const client = new WorkbenchHttpClient(base); const publicationId = id("lost-publication");
  const result = await client.call(op("publish_scene"), { sceneId: "demo", publicationId, revision: "a".repeat(64) });
  assert.equal(result.error?.outcome, "unknown"); assert.match(result.error!.recovery, new RegExp(publicationId)); assert.equal(posts, 1);
  const checked = await client.call(op("get_scene"), { sceneId: "demo", versionId: publicationId });
  assert.equal(checked.ok, true); assert.equal(posts, 1);
});

test("HTTP冲突details贯通MCP客户端，包含当前revision与恢复动作", async t => {
  const details = { currentRevision: "b".repeat(64), nextAction: "read_current_resource", conflicts: [{ path: "/scenes/demo/draft", reason: "revision_changed" }] };
  const base = await http(t, (_req, res) => { res.writeHead(409, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "配置已变化", code: "RESOURCE_REVISION_CONFLICT", details })); });
  const result = await new WorkbenchHttpClient(base).call(op("update_scene_draft"), { sceneId: "demo", revision: "a".repeat(64), scene: { id: "demo", title: "旧编辑" } });
  assert.equal(result.error?.outcome, "rejected"); assert.deepEqual(result.error?.details, details);
});


test("素材上传回执丢失：服务端只保存一版，MCP保留createId且只读对账不重传", async t => {
  const h = await productionHarness(t); let posts = 0;
  const createId = id("asset-upload-lost-response"); const file = path.join(h.root, "upload.png"); await writeFile(file, "isolated pixels");
  const base = await http(t, async (req, res) => {
    const url = new URL(req.url!, "http://localhost");
    if (req.method === "POST") {
      posts++; const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
      await h.assets.save({ createId: url.searchParams.get("createId"), name: "原ID素材", kind: "image" }, { bytes: Buffer.concat(chunks), filename: "upload.png" });
      res.destroy();
    } else { res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify(h.assets.detail(h.settings.projectDirectory, createId))); }
  });
  const client = new WorkbenchHttpClient(base); const lost = await client.call(op("upload_asset"), { createId, filePath: file, name: "原ID素材", kind: "image" });
  assert.equal(lost.error?.outcome, "unknown"); assert.equal(lost.error?.assetId, createId); assert.match(lost.error!.recovery, new RegExp(createId)); assert.equal(posts, 1);
  const checked = await client.call(op("get_asset"), { assetId: createId }); assert.equal(checked.ok, true); assert.equal((checked.data as { asset: { currentVersion: number } }).asset.currentVersion, 1); assert.equal(posts, 1); assert.equal(h.assets.catalog(h.settings.projectDirectory).total, 1);
});
