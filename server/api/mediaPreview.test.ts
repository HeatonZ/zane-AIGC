import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import path from "node:path";
import { randomFillSync, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import sharp from "sharp";
import { AccessService } from "../services/accessService.js";
import { HttpError } from "../errors.js";
import { runArtifactPaths } from "../artifacts/runArtifacts.js";
import { harness, id, submission, workflow } from "../testing/testSupport.js";
import { aiHarness } from "../testing/aiSupport.js";
import { createMediaRouter } from "./mediaRoutes.js";
import { createAssetRouter } from "./assetRoutes.js";

/** Deterministic non-flat raster so the derivative is actually smaller than the source. */
async function rasterPng(width = 1024) {
  const raw = Buffer.alloc(width * width * 3);
  randomFillSync(raw);
  return sharp(raw, { raw: { width, height: width, channels: 3 } }).png().toBuffer();
}

test("归档媒体预览：WebP 缩放、非图片回退原图、非法宽度拒绝、缓存复用", async (t) => {
  const { settings } = await harness(t);
  const runId = id("preview-run");
  const directory = path.join(runArtifactPaths(settings.projectDirectory, runId).directory, "outputs", "media");
  await mkdir(directory, { recursive: true });
  const source = await rasterPng();
  await writeFile(path.join(directory, "frame.png"), source);
  await writeFile(path.join(directory, "clip.mp4"), "0123456789");
  const app = express();
  app.use(createMediaRouter(async () => settings));
  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => res.status(error instanceof HttpError ? error.status : 500).json({ error: (error as Error).message, code: error instanceof HttpError ? error.code : "INTERNAL_ERROR" }));
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => server.once("listening", resolve));
  t.after(() => new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); }));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

  const preview = await fetch(`${base}/api/v1/runs/${runId}/media/frame.png/preview`);
  assert.equal(preview.status, 200);
  assert.match(preview.headers.get("content-type") ?? "", /^image\/webp/);
  assert.match(preview.headers.get("cache-control") ?? "", /private/);
  const derived = Buffer.from(await preview.arrayBuffer());
  assert.ok(derived.length < source.length / 2, `预览应显著小于原图：${derived.length} / ${source.length}`);
  assert.equal((await sharp(derived).metadata()).width, 512);

  const narrow = await fetch(`${base}/api/v1/runs/${runId}/media/frame.png/preview?w=64`);
  assert.equal(narrow.status, 200);
  assert.ok((await sharp(Buffer.from(await narrow.arrayBuffer())).metadata()).width! <= 64);
  for (const width of ["abc", "0", "99999", "1&w=2", ""]) {
    const rejected = await fetch(`${base}/api/v1/runs/${runId}/media/frame.png/preview?w=${width}`);
    assert.equal(rejected.status, 400, width);
    assert.equal((await rejected.json() as { code?: string }).code, "INVALID_PREVIEW_WIDTH");
  }

  const video = await fetch(`${base}/api/v1/runs/${runId}/media/clip.mp4/preview`);
  assert.equal(video.status, 200);
  assert.match(video.headers.get("content-type") ?? "", /^video\/mp4/);
  assert.equal(await video.text(), "0123456789");

  assert.equal((await fetch(`${base}/api/v1/runs/${runId}/media/absent.png/preview`)).status, 404);
  const legacy = await fetch(`${base}/api/workflows/runs/${runId}/media/frame.png/preview`);
  assert.equal(legacy.status, 200);
  assert.match(legacy.headers.get("content-type") ?? "", /^image\/webp/);
  const head = await fetch(`${base}/api/v1/runs/${runId}/media/frame.png/preview`, { method: "HEAD" });
  assert.equal(head.status, 200);
  assert.equal(await head.text(), "");
  assert.ok(preview.headers.get("etag"), "预览带 ETag，与原媒体一致");
  const cached = await fetch(`${base}/api/v1/runs/${runId}/media/frame.png/preview`);
  assert.equal(Buffer.from(await cached.arrayBuffer()).length, derived.length, "命中缓存后字节一致");
  const original = await fetch(`${base}/api/v1/runs/${runId}/media/frame.png`);
  assert.equal(original.status, 200);
  assert.match(original.headers.get("content-type") ?? "", /^image\/png/);
  assert.equal(Buffer.from(await original.arrayBuffer()).length, source.length, "原图路由不受预览影响");
});

test("预览权限与原媒体一致：本人与管理员可读，他人 404，output-media 支持缩放", async (t) => {
  const h = await aiHarness(t);
  const access = new AccessService(h.store, h.workspace, "");
  const app = express();
  app.use(express.json());
  app.use(access.middleware(async () => h.settings.projectDirectory));
  app.use(createAssetRouter(h.assets));
  app.use(createMediaRouter(async () => h.settings));
  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => res.status(error instanceof HttpError ? error.status : 500).json({ error: (error as Error).message, code: error instanceof HttpError ? error.code : "INTERNAL_ERROR" }));
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => server.once("listening", resolve));
  t.after(() => new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); }));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  async function account(name: string, role: "admin" | "user") {
    const user = (await access.create({ userId: randomUUID(), username: name, displayName: name, password: "preview-test-password", role })).user;
    const login = await access.login(name, "preview-test-password");
    return { user, token: login.token, identity: access.authenticate(login.token) };
  }
  const request = (route: string, token: string, init: RequestInit = {}) => fetch(base + route, { ...init, headers: { Authorization: "Bearer " + token, ...init.headers } });
  const admin = await account("preview-admin", "admin"), owner = await account("preview-owner", "user"), stranger = await account("preview-stranger", "user");
  const image = await rasterPng(256);

  const assetId = randomUUID();
  const saved = await h.assets.save({ name: "本人图片", kind: "image" }, { bytes: image, filename: "owned.png" }, { assetId, ownerUserId: owner.user.id, authorize: () => { access.refresh(owner.identity); } });
  assert.equal(saved.asset.id, assetId);
  assert.equal(saved.asset.ownerUserId, owner.user.id);
  const assetPreview = `/api/v1/assets/${assetId}/versions/1/preview`;
  assert.equal((await request(assetPreview, owner.token)).status, 200);
  assert.equal((await request(assetPreview, stranger.token)).status, 404);
  assert.equal((await request(assetPreview, admin.token, { method: "HEAD" })).status, 200);
  assert.equal((await request(assetPreview.replace("/preview", "/media"), stranger.token)).status, 404);

  const runId = id("owned-preview-run");
  await h.service.submit(submission(runId, workflow()));
  await h.service.wait(h.settings.projectDirectory, runId);
  await access.setScenes({ userId: owner.user.id, revision: 1, sceneIds: ["demo"] });
  const mediaDirectory = path.join(runArtifactPaths(h.settings.projectDirectory, runId).directory, "outputs", "media");
  await mkdir(mediaDirectory, { recursive: true });
  await writeFile(path.join(mediaDirectory, "shot.png"), image);
  const record = h.store.getRun(h.settings.projectDirectory, runId)!;
  record.ownerUserId = owner.user.id;
  record.sceneId = "demo";
  record.outputs = [{ key: "images", label: "图片", type: "image_list", value: [`/api/v1/runs/${runId}/media/shot.png`] }];
  h.store.saveRun(h.settings.projectDirectory, record, []);

  const runPreview = `/api/v1/runs/${runId}/media/shot.png/preview`;
  const ownPreview = await request(runPreview, owner.token);
  assert.equal(ownPreview.status, 200);
  assert.match(ownPreview.headers.get("content-type") ?? "", /^image\/webp/);
  assert.ok(Buffer.from(await ownPreview.arrayBuffer()).length < image.length);
  assert.equal((await request(runPreview, stranger.token)).status, 404);
  assert.equal((await request(runPreview, admin.token, { method: "HEAD" })).status, 200);
  assert.equal((await request(`/api/v1/runs/${runId}/media/shot.png`, stranger.token)).status, 404);

  const scaled = await request(`/api/v1/runs/${runId}/output-media?outputKey=images&mediaIndex=0&w=512`, owner.token);
  assert.equal(scaled.status, 200);
  assert.match(scaled.headers.get("content-type") ?? "", /^image\/webp/);
  const full = await request(`/api/v1/runs/${runId}/output-media?outputKey=images&mediaIndex=0`, owner.token);
  assert.equal(full.status, 200);
  assert.match(full.headers.get("content-type") ?? "", /^image\/png/);
  assert.equal(Buffer.from(await full.arrayBuffer()).length, image.length, "不带 w 仍返回原图");
  const invalid = await request(`/api/v1/runs/${runId}/output-media?outputKey=images&mediaIndex=0&w=-1`, owner.token);
  assert.equal(invalid.status, 400);
});
