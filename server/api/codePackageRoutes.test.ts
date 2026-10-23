import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import express from "express";

import { createCodePackageRouter } from "./codePackageRoutes.js";
import { CodeScenePackageService } from "../services/codeScenePackageService.js";
import { HttpError } from "../errors.js";
import { SqliteStore } from "../storage/sqliteStore.js";

/**
 * 代码子工程操作面的接口级验收（P3）：运行入口 + 运行记录 + 归属校验 + 管理员边界。
 *
 * 这一组只依赖代码包服务与 RunService 窄接口，不碰配置型包与积分线，因此可以在
 * main 上独立运行——这也是它单独成文件的原因。
 */

const PROJECT = "project-a";

async function writePackage(root: string, packageId: string, manifest: Record<string, unknown>, entry = "index.mjs") {
  const directory = path.join(root, "scene-packages", packageId);
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, "package.json"), JSON.stringify({ zaneScenePackage: manifest }));
  // 包代码照规格 §3 写：每次场景执行都走 framework.scenes.run，归属由框架强制。
  await writeFile(path.join(directory, entry), `export default function create(framework) {
  return {
    async run({ inputs, log }) {
      log("info", "运行");
      const scene = await framework.scenes.run({ inputs });
      return { outputs: { ok: true, inputs, sceneId: scene.sceneId, runId: scene.runId } };
    },
  };
}`);
  return directory;
}

async function harness() {
  const directory = await mkdtemp(path.join(tmpdir(), "zane-code-pkg-routes-"));
  const store = new SqliteStore(path.join(directory, "meta.db"));
  const prepared: Array<{ sceneId: string; versionId: string; inputs: Record<string, unknown> }> = [];
  const submitted: Array<{ runId: string; runTitle: string; packageRunId?: string }> = [];
  const service = new CodeScenePackageService({
    store,
    scenes: {
      prepare: async (sceneId: string, versionId: string, inputs: Record<string, unknown>) => {
        prepared.push({ sceneId, versionId, inputs });
        return { workflow: { sceneId, steps: [] } as never, inputValues: inputs as never };
      },
    } as never,
    runs: {
      submit: async (input: { runId: string; runTitle: string; packageRunId?: string }) => {
        submitted.push(input);
        return { ...input, status: "completed" } as never;
      },
      wait: async () => ({ runId: "r", status: "completed", outputs: {} }) as never,
      cancel: async () => ({ runId: "r", status: "cancelled" }),
      getRun: async () => undefined,
    } as never,
    loadSettings: async () => ({ projectDirectory: path.join(directory, PROJECT) } as never),
    now: () => new Date("2026-10-23T02:00:00.000Z"),
  });

  const app = express();
  app.use(express.json());
  app.use((request, response, next) => {
    const role = request.get("X-Test-Role");
    if (role === "admin") { response.locals.identity = { id: "admin", role: "admin" }; response.locals.authorizeAdmin = () => ({ id: "admin", role: "admin" }); }
    else if (role === "user") { response.locals.identity = { id: "user", role: "user" }; response.locals.authorizeAdmin = () => { throw new HttpError(403, "需要管理员权限", "ADMIN_REQUIRED"); }; }
    else response.locals.authorizeAdmin = () => { throw new HttpError(401, "需要登录", "AUTH_REQUIRED"); };
    next();
  });
  app.use(createCodePackageRouter(service));
  app.use((error: unknown, _request: express.Request, response: express.Response, _next: express.NextFunction) => {
    response.status(error instanceof HttpError ? error.status : 500).json({ error: (error as Error).message, code: error instanceof HttpError ? error.code : "INTERNAL_ERROR", details: error instanceof HttpError ? error.details : undefined });
  });
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const origin = "http://127.0.0.1:" + (server.address() as { port: number }).port;
  const projectDirectory = path.join(directory, PROJECT);
  await mkdir(projectDirectory, { recursive: true });

  return {
    store, service, origin, projectDirectory, prepared, submitted,
    close: () => new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); }),
  };
}

const admin = { "X-Test-Role": "admin", "Content-Type": "application/json" };

test("提交运行走管理员路由：202 + packageRunId，运行记录可按包列表/查详情，非管理员 403", async (t) => {
  const h = await harness();
  t.after(() => h.close());
  await writePackage(h.projectDirectory, "demo", { title: "演示包", version: "1.0.0", executor: { sceneId: "demo-scene", versionId: "demo-v1" }, inputs: [{ key: "content", type: "text" }] });
  await h.service.loadAll();

  const accepted = await fetch(h.origin + "/api/v1/code-packages/demo/runs", { method: "POST", headers: admin, body: JSON.stringify({ inputs: { content: "剧情A" } }) });
  assert.equal(accepted.status, 202);
  const body = await accepted.json() as { packageRunId: string; status: string; executorSceneId: string; nextAction: string };
  assert.ok(body.packageRunId);
  assert.equal(body.status, "running");
  assert.equal(body.executorSceneId, "demo-scene");
  assert.equal(body.nextAction, "poll_package_run");
  // 包运行提交到 RunService 时必须带上 packageRunId，否则子运行无法按包归属。
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(h.submitted.length, 1);
  assert.equal(h.submitted[0]!.packageRunId, body.packageRunId);

  // 返回后立刻能查到这条记录（占位先于响应）。
  const detail = await fetch(h.origin + "/api/v1/code-packages/demo/runs/" + body.packageRunId, { headers: admin });
  assert.equal(detail.status, 200);
  const detailBody = await detail.json() as { packageRunId: string; packageId: string; status: string };
  assert.equal(detailBody.packageId, "demo");
  assert.ok(["running", "completed"].includes(detailBody.status));

  const list = await fetch(h.origin + "/api/v1/code-packages/demo/runs", { headers: admin });
  assert.equal(list.status, 200);
  const listBody = await list.json() as { packageId: string; runs: Array<{ packageRunId: string }>; hasMore: boolean };
  assert.equal(listBody.packageId, "demo");
  assert.deepEqual(listBody.runs.map((run) => run.packageRunId), [body.packageRunId]);

  // 别的包不能拿这个 packageRunId 读记录。
  await writePackage(h.projectDirectory, "other", { title: "另一个包", version: "1.0.0", executor: { sceneId: "demo-scene", versionId: "demo-v1" }, inputs: [] });
  await h.service.loadAll();
  const cross = await fetch(h.origin + "/api/v1/code-packages/other/runs/" + body.packageRunId, { headers: admin });
  assert.equal(cross.status, 404);
  assert.equal((await cross.json() as { code: string }).code, "PACKAGE_RUN_NOT_FOUND");

  // 管理员边界：普通用户与未登录都不能提交或读运行记录。
  const forbidden = await fetch(h.origin + "/api/v1/code-packages/demo/runs", { method: "POST", headers: { "X-Test-Role": "user", "Content-Type": "application/json" }, body: JSON.stringify({ inputs: {} }) });
  assert.equal(forbidden.status, 403);
  const anonymous = await fetch(h.origin + "/api/v1/code-packages/demo/runs");
  assert.equal(anonymous.status, 401);
});

test("归属强制：包代码传别的 sceneId 报 PACKAGE_EXECUTOR_MISMATCH，且不产生子运行", async (t) => {
  const h = await harness();
  t.after(() => h.close());
  const directory = path.join(h.projectDirectory, "scene-packages", "mismatch");
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, "package.json"), JSON.stringify({ zaneScenePackage: { title: "越权包", version: "1.0.0", executor: { sceneId: "demo-scene", versionId: "demo-v1" }, inputs: [] } }));
  await writeFile(path.join(directory, "index.mjs"), `export default function create(framework) {
  return { async run({ log }) { log("info", "越权"); return await framework.scenes.run({ sceneId: "other-scene" }); } };
}`);
  await h.service.loadAll();

  const accepted = await fetch(h.origin + "/api/v1/code-packages/mismatch/runs", { method: "POST", headers: admin, body: JSON.stringify({ inputs: {} }) });
  assert.equal(accepted.status, 202);
  const { packageRunId } = await accepted.json() as { packageRunId: string };
  await new Promise((resolve) => setTimeout(resolve, 50));

  const detail = await (await fetch(h.origin + "/api/v1/code-packages/mismatch/runs/" + packageRunId, { headers: admin })).json() as { status: string; errorCode?: string; runIds: string[] };
  assert.equal(detail.status, "failed");
  assert.equal(detail.errorCode, "PACKAGE_EXECUTOR_MISMATCH");
  // 关键：归属被拒的那次不得留下任何子运行，也没有向 RunService 提交任何东西。
  assert.deepEqual(detail.runIds, []);
  assert.equal(h.submitted.length, 0);
});

test("未加载成功的包不能提交，也不留运行记录", async (t) => {
  const h = await harness();
  t.after(() => h.close());
  await writePackage(h.projectDirectory, "broken", { title: "坏包", version: "1.0.0", executor: { sceneId: "demo-scene", versionId: "demo-v1" }, inputs: [] }, "index.mjs");
  await writeFile(path.join(h.projectDirectory, "scene-packages", "broken", "index.mjs"), "export async function run({ log }) {\n  log(\"x\")");
  await h.service.loadAll();

  const rejected = await fetch(h.origin + "/api/v1/code-packages/broken/runs", { method: "POST", headers: admin, body: JSON.stringify({ inputs: {} }) });
  assert.equal(rejected.status, 409);
  const body = await rejected.json() as { code: string };
  assert.equal(body.code, "PACKAGE_NOT_LOADED");

  const list = await (await fetch(h.origin + "/api/v1/code-packages/broken/runs", { headers: admin })).json() as { runs: unknown[] };
  assert.deepEqual(list.runs, []);
});

test("运行记录分页与状态筛选参数被服务端校验", async (t) => {
  const h = await harness();
  t.after(() => h.close());
  await writePackage(h.projectDirectory, "demo", { title: "演示包", version: "1.0.0", executor: { sceneId: "demo-scene", versionId: "demo-v1" }, inputs: [] });
  await h.service.loadAll();

  const badStatus = await fetch(h.origin + "/api/v1/code-packages/demo/runs?status=weird", { headers: admin });
  assert.equal(badStatus.status, 400);
  assert.equal((await badStatus.json() as { code: string }).code, "INVALID_PACKAGE_RUN_STATUS");

  const badLimit = await fetch(h.origin + "/api/v1/code-packages/demo/runs?limit=999", { headers: admin });
  assert.equal(badLimit.status, 400);

  const badCursor = await fetch(h.origin + "/api/v1/code-packages/demo/runs?cursor=nope", { headers: admin });
  assert.equal(badCursor.status, 400);
  assert.equal((await badCursor.json() as { code: string }).code, "INVALID_RUN_CURSOR");
});
