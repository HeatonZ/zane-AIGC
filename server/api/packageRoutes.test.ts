import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import express from "express";

import { createPackageRouter } from "./packageRoutes.js";
import { CodeScenePackageService } from "../services/codeScenePackageService.js";
import { HttpError } from "../errors.js";
import { SqliteStore } from "../storage/sqliteStore.js";
import type { PackageService } from "../services/packageService.js";

/**
 * 管理端配置面（规格 §6 / §8.7）的接口级验收：
 * 列表要同时给出代码包与配置型包并带加载状态；改执行场景必须写进配置、重启/重新加载后生效；
 * 禁用后不加载；revision 冲突与「执行场景必填」都要在服务端拒绝，而不是只在界面上拦。
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
  const directory = await mkdtemp(path.join(tmpdir(), "zane-code-pkg-"));
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
  const packages = { listDrafts: async () => ({ packages: [{ id: "config-1", revision: 2, title: "配置包", inputs: [], items: [] }], nextAction: "get_package_draft" }) } as unknown as PackageService;

  const app = express();
  app.use(express.json());
  app.use((request, response, next) => {
    const role = request.get("X-Test-Role");
    if (role === "admin") { response.locals.identity = { id: "admin", role: "admin" }; response.locals.authorizeAdmin = () => ({ id: "admin", role: "admin" }); }
    else if (role === "user") { response.locals.identity = { id: "user", role: "user" }; response.locals.authorizeAdmin = () => { throw new HttpError(403, "需要管理员权限", "ADMIN_REQUIRED"); }; }
    next();
  });
  app.use(createPackageRouter(packages, service));
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

test("管理端目录遇到同 ID 的代码包与配置型包时只返回代码包，不重复列出", async (t) => {
  const h = await harness();
  t.after(() => h.close());
  await writePackage(h.projectDirectory, "ai_image", { title: "生图", version: "1.0.0", executor: { sceneId: "demo-scene", versionId: "v1" }, inputs: [] });
  await h.service.loadAll();
  // 配置型里留着同 ID 的历史草稿（真实库里就是这样：ai_image 既是代码包又是旧配置包）。
  const packages = { listDrafts: async () => ({ packages: [{ id: "ai_image", revision: 9, title: "生图", inputs: [], items: [] }], nextAction: "get_package_draft" }) } as unknown as PackageService;
  const app = express();
  app.use(express.json());
  app.use((_request, response, next) => { response.locals.identity = { id: "admin", role: "admin" }; response.locals.authorizeAdmin = () => ({ id: "admin", role: "admin" }); next(); });
  app.use(createPackageRouter(packages, h.service));
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  t.after(() => new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); }));
  const origin = "http://127.0.0.1:" + (server.address() as { port: number }).port;

  const body = await (await fetch(origin + "/api/v1/packages", { headers: admin })).json() as { packages: Array<Record<string, unknown>> };
  const sameId = body.packages.filter((item) => (item.packageId ?? item.id) === "ai_image");
  assert.equal(sameId.length, 1);
  assert.equal(sameId[0].source, "code");
  assert.equal(body.packages.filter((item) => item.source === "config").length, 0);
});

test("配置型包已下线：写入口返回 410，只读目录与历史草稿仍可查", async (t) => {
  const h = await harness();
  t.after(() => h.close());
  // 历史草稿仍在库里（真实库：ai_image 既是代码包又是旧配置包），只读必须还能列出来。
  const packages = {
    listDrafts: async () => ({ packages: [{ id: "legacy-config", revision: 3, title: "旧配置包", inputs: [], items: [] }], nextAction: "get_package_draft" }),
    getDraft: async (id: string) => ({ id, revision: 3, title: "旧配置包", inputs: [], items: [] }),
    createDraft: async () => { throw new Error("配置型写入口不应被调用"); },
    updateDraft: async () => { throw new Error("配置型写入口不应被调用"); },
    publish: async () => { throw new Error("配置型写入口不应被调用"); },
  } as unknown as PackageService;
  const app = express();
  app.use(express.json());
  app.use((_request, response, next) => { response.locals.identity = { id: "admin", role: "admin" }; response.locals.authorizeAdmin = () => ({ id: "admin", role: "admin" }); next(); });
  app.use(createPackageRouter(packages, h.service));
  app.use((error: unknown, _request: express.Request, response: express.Response, _next: express.NextFunction) => {
    response.status(error instanceof HttpError ? error.status : 500).json({ error: (error as Error).message, code: error instanceof HttpError ? error.code : "INTERNAL_ERROR" });
  });
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  t.after(() => new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); }));
  const origin = "http://127.0.0.1:" + (server.address() as { port: number }).port;

  // 只读：目录里还能看到历史配置型草稿，详情也读得到。
  const listed = await (await fetch(origin + "/api/v1/packages", { headers: admin })).json() as { packages: Array<Record<string, unknown>> };
  assert.equal(listed.packages.filter((item) => item.source === "config").length, 1);
  assert.equal((await fetch(origin + "/api/v1/packages/legacy-config", { headers: admin })).status, 200);

  // 写入口：新建 / 改草稿 / 发布全部 410，且不触达 PackageService 的写方法。
  for (const [method, path] of [["POST", "/api/v1/packages"], ["PATCH", "/api/v1/packages/legacy-config"], ["POST", "/api/v1/packages/legacy-config/publish"]] as const) {
    const response = await fetch(origin + path, { method, headers: admin, body: "{}" });
    assert.equal(response.status, 410, method + " " + path + " 应返回 410");
    assert.equal((await response.json() as { code: string }).code, "CONFIG_PACKAGE_RETIRED");
  }
});

test("管理端目录同时给出代码包与配置型包，代码包带加载状态与代码路径", async (t) => {
  const h = await harness();
  t.after(() => h.close());
  const directory = await writePackage(h.projectDirectory, "demo", { title: "演示包", version: "1.0.0", executor: { sceneId: "demo-scene", versionId: "v1" }, inputs: [{ key: "content", label: "剧情", type: "text", required: true }] });
  await h.service.loadAll();

  const response = await fetch(h.origin + "/api/v1/packages", { headers: admin });
  assert.equal(response.status, 200);
  const body = await response.json() as { packages: Array<Record<string, unknown>>; codePackages: Array<Record<string, unknown>> };

  const code = body.packages.filter((item) => item.source === "code");
  const config = body.packages.filter((item) => item.source === "config");
  assert.equal(code.length, 1);
  assert.equal(config.length, 1);
  assert.equal(code[0].packageId, "demo");
  assert.equal(code[0].status, "ok");
  assert.equal(code[0].directory, directory);
  assert.equal(code[0].entryPath, path.join(directory, "index.mjs"));
  assert.equal(code[0].enabled, true);
  assert.deepEqual(code[0].executor, { sceneId: "demo-scene", versionId: "v1" });
  assert.equal(body.codePackages.length, 1);

  // 加载失败的包也要出现在列表里，带原因。
  await mkdir(path.join(h.projectDirectory, "scene-packages", "broken"), { recursive: true });
  await writeFile(path.join(h.projectDirectory, "scene-packages", "broken", "package.json"), JSON.stringify({ zaneScenePackage: { title: "坏包", version: "1", executor: { sceneId: "demo-scene", versionId: "v1" } } }));
  await writeFile(path.join(h.projectDirectory, "scene-packages", "broken", "index.mjs"), "export default function (");
  await h.service.reload("broken");
  const after = await (await fetch(h.origin + "/api/v1/code-packages", { headers: admin })).json() as { packages: Array<Record<string, unknown>> };
  const broken = after.packages.find((item) => item.packageId === "broken")!;
  assert.equal(broken.status, "error");
  assert.match(String(broken.error), /Unexpected end of input|Unexpected token|Unexpected/);
});

test("改执行场景后重新加载才生效；revision 冲突与缺执行场景被服务端拒绝", async (t) => {
  const h = await harness();
  t.after(() => h.close());
  // package.json 不写 executor：必须由管理端配置提供（规格 §2）。
  await writePackage(h.projectDirectory, "demo", { title: "演示包", version: "1.0.0" });
  const loaded = await h.service.loadAll();
  assert.equal(loaded.packages[0].status, "error");
  assert.match(String(loaded.packages[0].error), /执行场景/);

  // 启用状态下不给执行场景 → 400，配置不落库。
  const missing = await fetch(h.origin + "/api/v1/code-packages/demo", { method: "PATCH", headers: admin, body: JSON.stringify({ revision: 0, enabled: true }) });
  assert.equal(missing.status, 400);
  assert.equal((await missing.json() as { code: string }).code, "CODE_PACKAGE_EXECUTOR_REQUIRED");

  const saved = await fetch(h.origin + "/api/v1/code-packages/demo", {
    method: "PATCH", headers: admin,
    body: JSON.stringify({ revision: 0, enabled: true, executor: { sceneId: "scene-b", versionId: "version-b" }, inputs: [{ key: "content", label: "剧情正文", required: true }] }),
  });
  assert.equal(saved.status, 200);
  const savedBody = await saved.json() as { package: Record<string, unknown>; nextAction: string };
  assert.equal(savedBody.nextAction, "reload_code_package");
  assert.equal(savedBody.package.revision, 1);
  assert.deepEqual(savedBody.package.executor, { sceneId: "scene-b", versionId: "version-b" });

  // 旧 revision 再写一次 → 409（不盲重试）。
  const stale = await fetch(h.origin + "/api/v1/code-packages/demo", { method: "PATCH", headers: admin, body: JSON.stringify({ revision: 0, enabled: false }) });
  assert.equal(stale.status, 409);
  assert.equal((await stale.json() as { code: string }).code, "CODE_PACKAGE_REVISION_CONFLICT");

  // 重新加载后生效：代码里不传 sceneId，框架用管理端配置的 scene-b。
  const reloaded = await fetch(h.origin + "/api/v1/code-packages/demo/reload", { method: "POST", headers: admin });
  assert.equal(reloaded.status, 200);
  const reloadBody = await reloaded.json() as { package: Record<string, unknown> };
  assert.equal(reloadBody.package.status, "ok");
  assert.deepEqual(reloadBody.package.executor, { sceneId: "scene-b", versionId: "version-b" });

  const result = await h.service.invoke("demo", { inputs: { content: "hi" } });
  assert.equal(result.status, "completed");
  assert.equal(h.prepared.at(-1)?.sceneId, "scene-b");
  assert.equal(h.prepared.at(-1)?.versionId, "version-b");
  assert.equal(h.submitted.at(-1)?.packageRunId, result.packageRunId);
});

test("禁用后不加载、不再出现在可用目录；重新启用 + 重新加载恢复", async (t) => {
  const h = await harness();
  t.after(() => h.close());
  await writePackage(h.projectDirectory, "demo", { title: "演示包", version: "1.0.0", executor: { sceneId: "demo-scene", versionId: "v1" } });
  await h.service.loadAll();

  const disabled = await fetch(h.origin + "/api/v1/code-packages/demo", { method: "PATCH", headers: admin, body: JSON.stringify({ revision: 0, enabled: false }) });
  assert.equal(disabled.status, 200);
  assert.equal((await disabled.json() as { package: Record<string, unknown> }).package.status, "disabled");

  await assert.rejects(h.service.invoke("demo"), (error: unknown) => error instanceof HttpError && error.code === "PACKAGE_NOT_LOADED");

  const listed = await (await fetch(h.origin + "/api/v1/code-packages", { headers: admin })).json() as { packages: Array<Record<string, unknown>> };
  assert.equal(listed.packages[0].status, "disabled");
  assert.equal(listed.packages[0].enabled, false);

  const enabled = await fetch(h.origin + "/api/v1/code-packages/demo", { method: "PATCH", headers: admin, body: JSON.stringify({ revision: 1, enabled: true }) });
  assert.equal(enabled.status, 200);
  const reloaded = await (await fetch(h.origin + "/api/v1/code-packages/demo/reload", { method: "POST", headers: admin })).json() as { package: Record<string, unknown> };
  assert.equal(reloaded.package.status, "ok");
  const result = await h.service.invoke("demo", {});
  assert.equal(result.status, "completed");
});

test("非管理员不能读取或修改代码包配置", async (t) => {
  const h = await harness();
  t.after(() => h.close());
  await writePackage(h.projectDirectory, "demo", { title: "演示包", version: "1.0.0", executor: { sceneId: "demo-scene", versionId: "v1" } });
  await h.service.loadAll();

  const list = await fetch(h.origin + "/api/v1/code-packages", { headers: { "X-Test-Role": "user" } });
  assert.equal(list.status, 403);
  const patch = await fetch(h.origin + "/api/v1/code-packages/demo", { method: "PATCH", headers: { "X-Test-Role": "user", "Content-Type": "application/json" }, body: JSON.stringify({ revision: 0, enabled: false }) });
  assert.equal(patch.status, 403);
});

test("提交运行走管理员路由：202 + packageRunId，运行记录可按包列表/查详情，非管理员 403", async (t) => {
  const h = await harness();
  t.after(() => h.close());
  await writePackage(h.projectDirectory, "demo", { title: "演示包", version: "1.0.0", executor: { sceneId: "demo-scene", versionId: "v1" }, inputs: [{ key: "content", label: "剧情", type: "text", required: true }] });
  await writePackage(h.projectDirectory, "broken", { title: "坏包", version: "1.0.0", executor: { sceneId: "demo-scene", versionId: "v1" } });
  await writeFile(path.join(h.projectDirectory, "scene-packages", "broken", "index.mjs"), "export default function (");
  await h.service.loadAll();

  // 提交：202 + 立刻可查的 packageRunId。
  const submitted = await fetch(h.origin + "/api/v1/code-packages/demo/runs", { method: "POST", headers: admin, body: JSON.stringify({ inputs: { content: "hi" } }) });
  assert.equal(submitted.status, 202);
  const accepted = await submitted.json() as { packageRunId: string; packageId: string; status: string; executorSceneId: string; nextAction: string };
  assert.match(accepted.packageRunId, /^[a-f0-9-]{36}$/);
  assert.equal(accepted.packageId, "demo");
  assert.equal(accepted.status, "running");
  assert.equal(accepted.executorSceneId, "demo-scene");
  assert.equal(accepted.nextAction, "poll_package_run");

  // 轮询到终态：入口契约里的 inputs 要真的传到包内。
  let detail: { status: string; runIds: string[]; result?: { outputs?: { inputs?: { content?: string }; sceneId?: string } } } = { status: "running", runIds: [] };
  for (let attempt = 0; attempt < 200 && detail.status === "running"; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    const response = await fetch(h.origin + "/api/v1/code-packages/demo/runs/" + accepted.packageRunId, { headers: admin });
    assert.equal(response.status, 200);
    detail = await response.json() as typeof detail;
  }
  assert.equal(detail.status, "completed");
  assert.equal(detail.runIds.length, 1);
  assert.deepEqual(detail.result?.outputs?.inputs, { content: "hi" });
  assert.equal(detail.result?.outputs?.sceneId, "demo-scene");

  // 列表：按包归属，带 packageRunId 与执行场景。
  const listed = await fetch(h.origin + "/api/v1/code-packages/demo/runs", { headers: admin });
  assert.equal(listed.status, 200);
  assert.equal(listed.headers.get("cache-control"), "no-store");
  const listBody = await listed.json() as { packageId: string; runs: Array<Record<string, unknown>>; hasMore: boolean };
  assert.equal(listBody.packageId, "demo");
  assert.equal(listBody.runs.length, 1);
  assert.equal(listBody.runs[0].id, accepted.packageRunId);
  assert.equal(listBody.runs[0].executorSceneId, "demo-scene");
  assert.equal(listBody.hasMore, false);

  // 加载失败的包不能提交运行 → 409，且不是 500。
  const broken = await fetch(h.origin + "/api/v1/code-packages/broken/runs", { method: "POST", headers: admin, body: JSON.stringify({}) });
  assert.equal(broken.status, 409);
  assert.equal((await broken.json() as { code: string }).code, "PACKAGE_NOT_LOADED");

  // 不存在的包 → 404。
  const missing = await fetch(h.origin + "/api/v1/code-packages/nope/runs", { method: "POST", headers: admin, body: JSON.stringify({}) });
  assert.equal(missing.status, 404);

  // 状态筛选参数非法 → 400。
  const badStatus = await fetch(h.origin + "/api/v1/code-packages/demo/runs?status=weird", { headers: admin });
  assert.equal(badStatus.status, 400);
  assert.equal((await badStatus.json() as { code: string }).code, "INVALID_PACKAGE_RUN_STATUS");

  // 跨包读详情 → 404。
  const cross = await fetch(h.origin + "/api/v1/code-packages/broken/runs/" + accepted.packageRunId, { headers: admin });
  assert.equal(cross.status, 404);

  // 非管理员三条路由全 403。
  const userHeaders = { "X-Test-Role": "user", "Content-Type": "application/json" };
  assert.equal((await fetch(h.origin + "/api/v1/code-packages/demo/runs", { method: "POST", headers: userHeaders, body: "{}" })).status, 403);
  assert.equal((await fetch(h.origin + "/api/v1/code-packages/demo/runs", { headers: userHeaders })).status, 403);
  assert.equal((await fetch(h.origin + "/api/v1/code-packages/demo/runs/" + accepted.packageRunId, { headers: userHeaders })).status, 403);
});
