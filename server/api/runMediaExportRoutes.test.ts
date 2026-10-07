import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import express from "express";
import { mkdir, writeFile, truncate } from "node:fs/promises";
import path from "node:path";
import { createRunMediaExportRouter } from "./runMediaExportRoutes.js";
import { RunMediaExportService } from "../services/runMediaExportService.js";
import { harness, id, submission } from "../testing/testSupport.js";
import { runArtifactPaths } from "../artifacts/runArtifacts.js";
import { HttpError } from "../errors.js";
import { runMediaExportSchema } from "../domain/runMediaExportContracts.js";
import type { JsonValue, RunRecord } from "../domain/types.js";
async function fixture(t: TestContext) {
  const h = await harness(t); const runId = id(t.name); const seed = await h.service.submit(submission(runId));
  const run: RunRecord = { ...seed, status: "completed", steps: [], outputs: [] }; const runs = new Map([[runId, run]]);
  const service = new RunMediaExportService(async () => h.settings, async (_project, key) => runs.get(key));
  const app = express(); app.use(createRunMediaExportRouter(service));
  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => { if (res.headersSent) { res.destroy(); return; } res.status(error instanceof HttpError ? error.status : 500).json({ error: String(error), code: error instanceof HttpError ? error.code : "INTERNAL_ERROR" }); });
  const server = app.listen(0, "127.0.0.1"); await new Promise<void>(resolve => server.once("listening", resolve));
  t.after(() => new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); }));
  const base = "http://127.0.0.1:" + (server.address() as { port: number }).port;
  async function image(source = runId, name = "fixture.png") { const dir = path.join(runArtifactPaths(h.settings.projectDirectory, source).directory, "outputs", "media"); await mkdir(dir, { recursive: true }); const file = path.join(dir, name); await writeFile(file, Buffer.from("isolated image fixture")); return { file, value: { filename: name, url: "/api/workflows/runs/" + source + "/media/" + encodeURIComponent(name) } }; }
  const output = (value: JsonValue) => { run.outputs = [{ key: "images", label: "images", type: "image_list", value }]; };
  const metadata = () => fetch(base + "/api/v1/runs/" + runId + "/media-export?outputKey=images");
  return { ...h, runId, run, runs, base, service, image, output, metadata };
}
test("通用媒体导出：明确元数据、ZIP清单、HEAD、旧revision与无副作用读取", async t => {
  const h = await fixture(t); const a = await h.image(); const b = await h.image(h.runId, "second.jpg"); h.output([a.value, b.value]);
  const response = await h.metadata(); assert.equal(response.status, 200); const data = runMediaExportSchema.parse(await response.json());
  assert.equal(data.fileCount, 2); assert.equal(data.incomplete, false); assert.equal(data.schemaVersion, 1); assert.ok(!("files" in data));
  assert.equal((await fetch(h.base + data.downloadUrl, { method: "HEAD" })).status, 200);
  const zip = await fetch(h.base + data.downloadUrl); assert.equal(zip.status, 200); const bytes = Buffer.from(await zip.arrayBuffer());
  assert.equal(bytes.readUInt32LE(0), 0x04034b50); assert.ok(bytes.includes(Buffer.from("001-images.png"))); assert.ok(bytes.includes(Buffer.from("002-images.jpg"))); assert.ok(bytes.includes(Buffer.from("manifest.json")));
  assert.equal((await fetch(h.base + data.downloadUrl.replace(data.revision, "0".repeat(64)))).status, 409);
  await writeFile(b.file, Buffer.from("updated local fixture contents")); assert.equal((await fetch(h.base + data.downloadUrl)).status, 409);
  assert.equal((await fetch(h.base + "/api/v1/runs/" + h.runId + "/media-export?outputKey=images&path=secret")).status, 400);
  assert.equal((await fetch(h.base + "/api/v1/runs/" + h.runId + "/media.zip?outputKey=images")).status, 400);
});
test("通用媒体导出：待审核拒绝，失败步骤仅导出已完成项并标记不完整", async t => {
  const h = await fixture(t); const a = await h.image(); h.output([a.value]); h.run.status = "waiting"; assert.equal((await h.metadata()).status, 409);
  h.run.status = "failed"; h.run.steps = [{ stepId: "generate", name: "generate", status: "failed", outputTypes: { images: "image_list" }, items: [{ index: 0, status: "completed", value: { id: "first" }, outputs: { images: [a.value] } }, { index: 1, status: "failed", value: { id: "second" }, error: "mock failure" }] }];
  const result = await h.service.prepare(h.runId, { outputKey: "images", stepId: "generate" }); assert.equal(result.data.fileCount, 1); assert.equal(result.data.incomplete, true);
  await assert.rejects(h.service.prepare(h.runId, { outputKey: "images", stepId: "generate", itemIndex: 1 }), /没有已完成/);
  await assert.rejects(h.service.prepare(h.runId, { outputKey: "images", itemIndex: 0 }), /需要stepId/);
});
test("通用媒体导出：拒绝路径、远程URL、未知来源、越界文件和过大媒体；授权祖先可复用", async t => {
  const h = await fixture(t); const ancestorId = id("media-ancestor"); const ancestor = { ...h.run, runId: ancestorId }; h.runs.set(ancestorId, ancestor);
  const a = await h.image(ancestorId); h.output([a.value]); assert.equal((await h.metadata()).status, 400);
  h.run.rerunFromRunId = ancestorId; const authorizations: string[] = [];
  const allowed = await h.service.prepare(h.runId, { outputKey: "images" }, run => authorizations.push(run.runId)); assert.equal(allowed.data.fileCount, 1); assert.ok(authorizations.includes(ancestorId));
  await assert.rejects(h.service.prepare(h.runId, { outputKey: "images" }, run => { if (run.runId === ancestorId) throw new HttpError(404, "禁止祖先访问"); }), /禁止祖先访问/);
  for (const value of ["C:/private/key.txt", "https://example.invalid/image.png", { ...a.value, url: "/api/workflows/runs/" + ancestorId + "/media/..%2Fsecret.png" }]) { h.output([value]); assert.equal((await h.metadata()).status, 400); }
  h.output([a.value]); await truncate(a.file, 33 * 1024 * 1024); assert.equal((await h.metadata()).status, 413);
});


test("通用媒体导出在异步文件核对后重验所有祖先授权，不只校验当前运行", async t => {
  const h = await fixture(t); const ancestorId = id(t.name + "ancestor"); const ancestor = { ...h.run, runId: ancestorId, sceneId: "other-scene" }; h.runs.set(ancestorId, ancestor); h.run.rerunFromRunId = ancestorId;
  const media = await h.image(ancestorId); h.output([media.value]); let reads = 0;
  await assert.rejects(h.service.prepare(h.runId, { outputKey: "images" }, run => { if (run.runId === ancestorId && ++reads === 2) throw new HttpError(403, "祖先场景授权已撤销", "SCENE_ACCESS_DENIED"); }), /祖先场景授权已撤销/);
  assert.equal(reads, 2);
});
