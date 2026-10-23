import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import path from "node:path";
import { randomFillSync } from "node:crypto";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import sharp from "sharp";
import { createLocalMediaRouter, localMediaSourceValue } from "./localMediaRoutes.js";
import { LocalExportService } from "../services/localExportSettings.js";
import { HttpError } from "../errors.js";
import { runArtifactPaths } from "../artifacts/runArtifacts.js";
import { temporaryDirectory } from "../testing/testSupport.js";
import type { RunRecord, SavedSettings } from "../domain/types.js";
import type { SqliteStore } from "../storage/sqliteStore.js";

/** Deterministic non-flat raster so a scaled derivative is actually smaller than the source. */
async function rasterPng(width = 64) {
  const raw = Buffer.alloc(width * width * 3);
  randomFillSync(raw);
  return sharp(raw, { raw: { width, height: width, channels: 3 } }).png().toBuffer();
}

const runId = "12345678-1234-4234-8234-123456789abc";

function runRecord(projectDirectory: string, steps: RunRecord["steps"]): RunRecord {
  return {
    runId, sceneId: "scene", workflowName: "本地媒体测试", inputValues: {}, status: "completed",
    createdAt: new Date().toISOString(), startedAt: new Date().toISOString(), outputs: [],
    artifacts: runArtifactPaths(projectDirectory, runId),
    workflow: { name: "本地媒体测试", inputs: [], steps: [], outputs: [] },
    steps,
  } as RunRecord;
}

/**
 * 真实 HTTP 路由 + 真实包含性校验，用最小身份中间件注入角色。
 * 包含性/逃逸/未配置根这类逻辑是本路由自己的职责，因此在这里用真实文件系统与真实
 * LocalExportService 校验；身份中间件本身由既有鉴权测试覆盖，不重复搭建账户与数据库。
 */
async function localMediaHarness(t: Parameters<typeof temporaryDirectory>[0], options: { configured?: boolean } = {}) {
  const base = await temporaryDirectory(t);
  const projectDirectory = path.join(base, "project");
  await mkdir(projectDirectory, { recursive: true });
  const exportsRoot = path.join(base, "exports");
  await mkdir(exportsRoot, { recursive: true });
  const settings: SavedSettings = { projectDirectory, comfyuiBaseUrl: "http://127.0.0.1:1", workflowTimeoutMinutes: 1, enabledHermesProfiles: [] };
  const runs = new Map<string, RunRecord>();
  // LocalExportService 只读取 SQLite 单例来取得根目录；这里用只读桩提供同一个根值。
  const store = { getDocument: () => (options.configured === false ? undefined : { id: "local-export", revision: 1, root: exportsRoot }) } as unknown as SqliteStore;
  const localExport = new LocalExportService(store, "");
  const app = express();
  app.use(express.json());
  app.use((request, response, next) => {
    // 角色由查询串显式给出，便于同时覆盖管理员、普通用户与未认证三种情形。
    const role = request.get("X-Test-Role");
    if (role === "admin") { response.locals.identity = { id: "admin", role: "admin" }; response.locals.authorizeAdmin = () => {}; }
    else if (role === "user") { response.locals.identity = { id: "user", role: "user" }; response.locals.authorizeAdmin = () => { throw new HttpError(403, "需要管理员权限", "ADMIN_REQUIRED"); }; }
    next();
  });
  app.use(createLocalMediaRouter({ loadSettings: async () => settings, getRun: (_project, id) => runs.get(id), localExport }));
  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(error instanceof HttpError ? error.status : 500).json({ error: (error as Error).message, code: error instanceof HttpError ? error.code : "INTERNAL_ERROR" });
  });
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => server.once("listening", resolve));
  t.after(() => new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); }));
  const origin = "http://127.0.0.1:" + (server.address() as { port: number }).port;
  return {
    base, projectDirectory, exportsRoot, runs,
    request: (suffix: string, role?: "admin" | "user") => fetch(origin + suffix, { headers: role ? { "X-Test-Role": role } : {} }),
  };
}

test("本地媒体：按坐标读取根目录内的真实文件，图片可缩放且非管理员拒绝", async (t) => {
  const h = await localMediaHarness(t);
  const image = await rasterPng();
  const directory = path.join(h.exportsRoot, "11", "角色");
  await mkdir(directory, { recursive: true });
  const characterPath = path.join(directory, "アーモンドアイ(ウマ娘).png");
  const reference = path.join(h.exportsRoot, "11", "1.png");
  await writeFile(characterPath, image);
  await writeFile(reference, image);
  await writeFile(path.join(h.exportsRoot, "11", "voice.wav"), "RIFF0000WAVE");

  h.runs.set(runId, runRecord(h.projectDirectory, [
    { stepId: "scan", name: "定位", status: "completed", outputs: { characterPath, reference: [reference], voice: path.join(h.exportsRoot, "11", "voice.wav") }, outputTypes: { characterPath: "text", reference: "json", voice: "text" } },
  ]));

  const own = (query: string, role: "admin" | "user" | "anonymous" = "admin") =>
    role === "anonymous"
      ? h.request(`/api/v1/runs/${runId}/local-media?${query}`)
      : h.request(`/api/v1/runs/${runId}/local-media?${query}`, role);

  // text 与 json 输出里的本地图都能取到真实字节（这正是 core.code 看不了图的那一类）。
  for (const query of ["outputKey=characterPath&stepId=scan&mediaIndex=0", "outputKey=reference&stepId=scan&mediaIndex=0"]) {
    const response = await own(query);
    assert.equal(response.status, 200, query);
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    assert.ok((await response.arrayBuffer()).byteLength > 0);
  }

  // 缩放派生图：仅显示用，权限与原文件一致。
  const scaled = await own("outputKey=characterPath&stepId=scan&mediaIndex=0&w=32");
  assert.equal(scaled.status, 200);
  assert.equal(scaled.headers.get("content-type"), "image/webp");

  // 非图片请求缩放时回退原字节。
  assert.equal((await own("outputKey=voice&stepId=scan&mediaIndex=0&w=32")).status, 200);

  // 越界坐标：此输出里没有第 1 个本地媒体。
  assert.equal((await own("outputKey=characterPath&stepId=scan&mediaIndex=1")).status, 404);
  // 未知输出/步骤/最终输出。
  assert.equal((await own("outputKey=missing&stepId=scan&mediaIndex=0")).status, 404);
  assert.equal((await own("outputKey=characterPath&stepId=missing&mediaIndex=0")).status, 404);
  assert.equal((await own("outputKey=missing&mediaIndex=0")).status, 404);
  // 缺少必填 outputKey、无效 mediaIndex/w、以及试图直接传路径作参数。
  for (const query of [
    "stepId=scan&mediaIndex=0",
    "outputKey=characterPath&stepId=scan&mediaIndex=-1",
    "outputKey=characterPath&stepId=scan&mediaIndex=0&w=8",
    "outputKey=characterPath&stepId=scan&mediaIndex=0&path=C:/secret.png",
    "outputKey=characterPath&stepId=scan&mediaIndex=0&runId=other",
  ]) assert.equal((await own(query)).status, 400, query);

  // 普通用户与未认证一律拒绝：这是管理员专属的本地文件查看通道。
  assert.equal((await own("outputKey=characterPath&stepId=scan&mediaIndex=0", "user")).status, 403);
  assert.equal((await own("outputKey=characterPath&stepId=scan&mediaIndex=0", "anonymous")).status, 403);
});

test("本地媒体：越界、目录遍历与符号链接逃逸都拒绝，未配置根目录时整条通道关闭", async (t) => {
  const h = await localMediaHarness(t);
  const image = await rasterPng(32);
  const inside = path.join(h.exportsRoot, "ok.png");
  await writeFile(inside, image);
  const outsideDirectory = path.join(h.base, "outside");
  await mkdir(outsideDirectory, { recursive: true });
  const outside = path.join(outsideDirectory, "secret.png");
  await writeFile(outside, image);

  // 根目录内的一个符号链接指向根外：必须拒绝，不能成为读取支点。
  const link = path.join(h.exportsRoot, "escape.png");
  let linkCreated = true;
  try { await symlink(outside, link, "file"); } catch { linkCreated = false; }

  const traversal = path.join(h.exportsRoot, "..", "outside", "secret.png");
  h.runs.set(runId, runRecord(h.projectDirectory, [
    { stepId: "escape", name: "逃逸", status: "completed", outputs: { outside, traversal, ignored: inside, ...(linkCreated ? { link } : {}) }, outputTypes: { outside: "text", traversal: "text", ignored: "text", link: "text" } },
  ]));

  const own = (query: string) => h.request(`/api/v1/runs/${runId}/local-media?${query}`, "admin");
  const denied = await own("outputKey=outside&stepId=escape&mediaIndex=0");
  assert.equal(denied.status, 400);
  assert.equal((await denied.json() as { code: string }).code, "FILE_OUTSIDE_ROOT");

  const escaped = await own("outputKey=traversal&stepId=escape&mediaIndex=0");
  assert.equal(escaped.status, 400);
  assert.equal((await escaped.json() as { code: string }).code, "FILE_OUTSIDE_ROOT");

  if (linkCreated) {
    const viaLink = await own("outputKey=link&stepId=escape&mediaIndex=0");
    assert.equal(viaLink.status, 400);
    assert.equal((await viaLink.json() as { code: string }).code, "FILE_OUTSIDE_ROOT");
  }

  // 根目录内不存在的文件：明确 404，不静默回退到别处。
  h.runs.set(runId, runRecord(h.projectDirectory, [
    { stepId: "missing", name: "缺失", status: "completed", outputs: { reference: [path.join(h.exportsRoot, "nope.png")] }, outputTypes: { reference: "json" } },
  ]));
  const missing = await own("outputKey=reference&stepId=missing&mediaIndex=0");
  assert.equal(missing.status, 404);
  assert.equal((await missing.json() as { code: string }).code, "LOCAL_MEDIA_NOT_FOUND");
});

test("本地媒体：未配置导出根目录时不做任何文件系统读取", async (t) => {
  const h = await localMediaHarness(t, { configured: false });
  const inside = path.join(h.exportsRoot, "ok.png");
  await writeFile(inside, await rasterPng(32));
  h.runs.set(runId, runRecord(h.projectDirectory, [
    { stepId: "scan", name: "定位", status: "completed", outputs: { reference: [inside] }, outputTypes: { reference: "json" } },
  ]));
  const response = await h.request(`/api/v1/runs/${runId}/local-media?outputKey=reference&stepId=scan&mediaIndex=0`, "admin");
  assert.equal(response.status, 400);
  assert.equal((await response.json() as { code: string }).code, "FILE_ACCESS_DISABLED");
});

test("本地媒体：路由在缺少管理员鉴权中间件时 fail closed", async (t) => {
  const base = await temporaryDirectory(t);
  const settings: SavedSettings = { projectDirectory: path.join(base, "project"), comfyuiBaseUrl: "", workflowTimeoutMinutes: 1, enabledHermesProfiles: [] };
  await mkdir(settings.projectDirectory, { recursive: true });
  const store = { getDocument: () => undefined } as unknown as SqliteStore;
  const app = express();
  // 故意不挂身份中间件：res.locals.authorizeAdmin 不存在时必须 403，而不是放行。
  app.use(createLocalMediaRouter({ loadSettings: async () => settings, getRun: () => undefined, localExport: new LocalExportService(store, "") }));
  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(error instanceof HttpError ? error.status : 500).json({ code: error instanceof HttpError ? error.code : "INTERNAL_ERROR" });
  });
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => server.once("listening", resolve));
  t.after(() => new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); }));
  const response = await fetch("http://127.0.0.1:" + (server.address() as { port: number }).port + `/api/v1/runs/${runId}/local-media?outputKey=a`);
  assert.equal(response.status, 403);
  assert.equal((await response.json() as { code: string }).code, "ADMIN_REQUIRED");
});

test("本地媒体坐标解析：最终输出与逐项输出，且最终输出不接受逐项序号", () => {
  const step = { stepId: "scan", name: "定位", status: "completed" as const, outputs: { reference: ["E:\\a.png"] }, outputTypes: { reference: "json" } };
  const item = { index: 1, value: null, status: "completed" as const, outputs: { reference: ["E:\\b.png"] } };
  const run = {
    ...runRecord("F:\\project", [{ ...step, items: [item] }]),
    outputs: [{ key: "result", label: "全部成图", type: "image_list", value: ["E:\\final.png"] }],
  } as RunRecord;

  assert.deepEqual(localMediaSourceValue(run, { outputKey: "result" }), ["E:\\final.png"]);
  assert.deepEqual(localMediaSourceValue(run, { stepId: "scan", outputKey: "reference" }), ["E:\\a.png"]);
  assert.deepEqual(localMediaSourceValue(run, { stepId: "scan", itemIndex: 1, outputKey: "reference" }), ["E:\\b.png"]);
  assert.throws(() => localMediaSourceValue(run, { itemIndex: 0, outputKey: "result" }), (error: unknown) => (error as HttpError).code === "INVALID_LOCAL_MEDIA_REQUEST");
  assert.throws(() => localMediaSourceValue(run, { stepId: "missing", outputKey: "reference" }), (error: unknown) => (error as HttpError).code === "LOCAL_MEDIA_NOT_FOUND");
  assert.throws(() => localMediaSourceValue(run, { stepId: "scan", itemIndex: 9, outputKey: "reference" }), (error: unknown) => (error as HttpError).code === "LOCAL_MEDIA_NOT_FOUND");
});
