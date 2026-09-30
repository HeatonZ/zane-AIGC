import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import express from "express";
import { mkdir, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import { createCommercePackRouter } from "./commercePackRoutes.js";
import { harness, id, submission } from "../testing/testSupport.js";
import { runArtifactPaths } from "../artifacts/runArtifacts.js";
import { HttpError } from "../errors.js";
import type { JsonValue, RunRecord } from "../domain/types.js";

async function fixture(t: TestContext) {
  const h = await harness(t);
  const runId = id(`commerce-zip-${t.name}`);
  const seed = await h.service.submit(submission(runId));
  const run: RunRecord = { ...seed, status: "completed", steps: [], outputs: [] };
  const runs = new Map([[runId, run]]);
  const app = express();
  app.use(createCommercePackRouter(async () => h.settings, async (_project, key) => runs.get(key)));
  app.use((error: unknown, _request: express.Request, response: express.Response, _next: express.NextFunction) => {
    if (response.headersSent) { response.destroy(); return; }
    response.status(error instanceof HttpError ? error.status : 500).json({ error: String(error) });
  });
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  t.after(() => new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); }));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  async function image(sourceRunId = runId, platform = "taobao") {
    const directory = path.join(runArtifactPaths(h.settings.projectDirectory, sourceRunId).directory, "outputs", "media");
    await mkdir(directory, { recursive: true });
    const file = path.join(directory, `commerce-${platform}-hero.jpg`);
    await writeFile(file, Buffer.from("fixture JPEG"));
    return { format: "zane-commerce-pack/item-v1", sourceRunId, outputFile: `outputs/media/commerce-${platform}-hero.jpg`, exportName: `${platform}/01-hero.jpg` };
  }
  function rows(value: JsonValue) { run.outputs = [{ key: "commerce_manifest", label: "清单", type: "json", value }]; }
  const download = (key = runId) => fetch(`${base}/api/v1/runs/${key}/commerce-pack.zip`);
  return { ...h, run, runId, runs, image, rows, download };
}

// Independent consumer of the central directory; does not call our ZIP writer.
function unpackStore(buffer: Buffer) {
  assert.equal(buffer.readUInt32LE(buffer.length - 22), 0x06054b50);
  const count = buffer.readUInt16LE(buffer.length - 12);
  const files = new Map<string, Buffer>();
  let offset = buffer.readUInt32LE(buffer.length - 6);
  for (let index = 0; index < count; index++) {
    assert.equal(buffer.readUInt32LE(offset), 0x02014b50);
    assert.equal(buffer.readUInt16LE(offset + 10), 0);
    const length = buffer.readUInt32LE(offset + 24);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const name = buffer.subarray(offset + 46, offset + 46 + nameLength).toString("utf8");
    const local = buffer.readUInt32LE(offset + 42);
    assert.equal(buffer.readUInt32LE(local), 0x04034b50);
    const start = local + 30 + buffer.readUInt16LE(local + 26) + buffer.readUInt16LE(local + 28);
    files.set(name, buffer.subarray(start, start + length));
    offset += 46 + nameLength + buffer.readUInt16LE(offset + 30) + buffer.readUInt16LE(offset + 32);
  }
  assert.equal(files.size, count);
  return files;
}

test("电商下载HTTP：按平台打包，包含清单和人工复核说明", async (t) => {
  const h = await fixture(t);
  h.rows([await h.image(), await h.image(h.runId, "jd")]);
  const response = await h.download();
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "application/zip");
  assert.match(response.headers.get("content-disposition")!, /attachment; filename="commerce-pack-/);
  const files = unpackStore(Buffer.from(await response.arrayBuffer()));
  assert.deepEqual([...files.keys()], ["jd/01-hero.jpg", "taobao/01-hero.jpg", "manifest.json", "REVIEW.txt"]);
  assert.equal(files.get("taobao/01-hero.jpg")!.toString(), "fixture JPEG");
  const manifest = JSON.parse(files.get("manifest.json")!.toString());
  assert.equal(manifest.totalImages, 2); assert.equal(manifest.incomplete, false); assert.equal(manifest.reviewRequired, true);
  assert.match(files.get("REVIEW.txt")!.toString(), /不代表平台审核通过/);
});

test("电商下载HTTP：活动记录、无图记录和不存在的文件不能导出", async (t) => {
  const h = await fixture(t);
  for (const status of ["queued", "running", "cancelling"] as const) { h.run.status = status; assert.equal((await h.download()).status, 409); }
  h.run.status = "completed";
  assert.equal((await h.download()).status, 404);
  assert.equal((await h.download(id("no-commerce-run"))).status, 404);
  assert.equal((await h.download("bad-id")).status, 400);
  const row = await h.image(); h.rows([row]);
  await rm(path.join(h.run.artifacts.directory, row.outputFile));
  assert.equal((await h.download()).status, 404);
});

test("电商下载HTTP：拒绝路径穿越、跨来源和重复导出名", async (t) => {
  const h = await fixture(t); const row = await h.image();
  for (const bad of [
    { ...row, outputFile: "../secret.jpg" },
    { ...row, exportName: "../01-hero.jpg" },
    { ...row, sourceRunId: id("unrelated-commerce-run") },
  ]) { h.rows([bad]); assert.equal((await h.download()).status, 400); }
  h.rows([row, row]); assert.equal((await h.download()).status, 400);
});

test("电商下载HTTP：失败/取消可导出成功项，续跑可引用祖先成图", async (t) => {
  const h = await fixture(t);
  const parentId = id("commerce-zip-parent");
  h.runs.set(parentId, { ...h.run, runId: parentId, status: "failed" });
  const row = await h.image(parentId);
  h.run.status = "cancelled";
  h.run.resumedFromRunId = parentId;
  h.run.steps = [{ stepId: "render_pack", name: "套图", status: "cancelled", items: [
    { index: 0, value: "hero", status: "completed", outputs: { commerce_manifest: [row] } },
    { index: 1, value: "detail", status: "cancelled", error: "用户取消" },
  ] }];
  const response = await h.download(); assert.equal(response.status, 200);
  const files = unpackStore(Buffer.from(await response.arrayBuffer()));
  const manifest = JSON.parse(files.get("manifest.json")!.toString());
  assert.equal(manifest.incomplete, true); assert.equal(manifest.totalImages, 1);
  assert.equal(manifest.images[0].sourceRunId, parentId); assert.equal(manifest.failures[0].shot, "detail");
  h.run.status = "failed"; assert.equal((await h.download()).status, 200);
});
