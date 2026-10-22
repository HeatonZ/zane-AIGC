import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { AiSceneService } from "./aiSceneService.js";
import { CodeScenePackageService } from "./codeScenePackageService.js";
import { WorkspaceService } from "./workspaceService.js";
import { HttpError } from "../errors.js";
import { productionHarness } from "../testing/productionSupport.js";
import { temporaryDirectory } from "../testing/testSupport.js";

const SCENE_ID = "package-executor-scene";
const VERSION_ID = "package-executor-v1";

function manifest(title: string, overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    zaneScenePackage: {
      title,
      version: "1.0.0",
      executor: { sceneId: SCENE_ID, versionId: VERSION_ID },
      entry: "index.mjs",
      ...overrides,
    },
  });
}

async function writePackage(project: string, packageId: string, files: Record<string, string>) {
  const directory = path.join(project, "scene-packages", packageId);
  await mkdir(directory, { recursive: true });
  for (const [name, contents] of Object.entries(files)) await writeFile(path.join(directory, name), contents, "utf8");
}

test("good and syntax-bad packages load independently; reload recovers one package", async (t) => {
  let store: import("../storage/sqliteStore.js").SqliteStore | undefined;
  const root = await temporaryDirectory(t, () => store?.close());
  const project = path.join(root, "project");
  await mkdir(project, { recursive: true });
  await writePackage(project, "good", {
    "package.json": manifest("好包"),
    "index.mjs": "export default (framework) => ({ run: async () => ({ hasFramework: typeof framework.scenes.run === 'function', hasStore: typeof framework.store.set === 'function' }) });",
  });
  await writePackage(project, "broken", {
    "package.json": manifest("坏包"),
    // Deliberately unparsable: must not stop `good` from loading.
    "index.mjs": "export default function ( {",
  });

  const { SqliteStore } = await import("../storage/sqliteStore.js");
  store = new SqliteStore(path.join(root, "metadata.db"));
  const service = new CodeScenePackageService({
    store,
    scenes: { prepare: async () => ({ workflow: {}, inputValues: {} }) } as never,
    runs: { submit: async () => ({}), wait: async () => ({}), cancel: async () => ({}), getRun: async () => undefined } as never,
    loadSettings: async () => ({ projectDirectory: project, comfyuiBaseUrl: "", workflowTimeoutMinutes: 1, enabledHermesProfiles: [] }),
  });

  const loaded = await service.loadAll();
  assert.equal(loaded.loaded, 1);
  assert.equal(loaded.failed, 1);
  assert.equal(service.get("good")?.status, "ok");
  assert.equal(service.get("broken")?.status, "error");
  assert.ok(service.get("broken")?.error, "失败包必须记录安全错误字符串");

  const invoked = await service.invoke("good");
  assert.equal(invoked.status, "completed");
  assert.deepEqual(invoked.result, { hasFramework: true, hasStore: true });

  // 修好后单独重载：不需要重启进程，也不影响已加载的包。
  await writeFile(path.join(project, "scene-packages", "broken", "index.mjs"), "export default () => ({ run: async () => ({ fixed: true }) });", "utf8");
  const reloaded = await service.reload("broken");
  assert.equal(reloaded.status, "ok");
  assert.deepEqual((await service.invoke("broken")).result, { fixed: true });
  assert.equal(service.get("good")?.status, "ok");

  await assert.rejects(service.reload("bad id"), (error: unknown) => error instanceof HttpError && error.code === "INVALID_PACKAGE_ID");
});

test("scenes.run forces the configured executor and stamps packageRunId/title/owner", async (t) => {
  const h = await productionHarness(t, {
    kind: "fake",
    async execute({ inputValues }) { return { value: "产出：" + String(inputValues.seed ?? "") }; },
  });
  await h.service.start();
  const workspace = new WorkspaceService(h.store, path.join(h.root, "workspace.json"));
  t.after(() => workspace.shutdown());
  const scene = { id: SCENE_ID, title: "包执行场景", summary: "", description: "", cover: "", accent: "green", stages: [] };
  const workflow = {
    sceneId: SCENE_ID,
    name: "包执行场景",
    inputs: [{ key: "seed", type: "text" }],
    steps: [{ id: "step-one", name: "第一步", kind: "fake", outputs: [{ key: "value", type: "text" }] }],
    outputs: [{ key: "value", type: "text", sourceRef: "step.step-one.outputs.value" }],
  };
  await workspace.initialize({
    format: "zane-studio.workspace/v1",
    scenes: [scene],
    workflows: { [SCENE_ID]: workflow },
    optionPresets: [],
    drafts: [],
    sceneVersions: { [SCENE_ID]: { publishedVersionId: VERSION_ID, versions: [{ id: VERSION_ID, version: "abc12345", publishedAt: "2026-10-01T00:00:00.000Z", scene, workflow, optionPresets: [] }] } },
  });
  const scenes = new AiSceneService(workspace, h.executors, h.assets, async () => h.settings);
  const service = new CodeScenePackageService({
    store: h.store,
    scenes,
    runs: h.service,
    assets: h.assets,
    loadSettings: async () => h.settings,
  });

  const project = h.settings.projectDirectory;
  await writePackage(project, "demo", {
    "package.json": manifest("演示包"),
    "index.mjs": `export default (framework) => ({ run: async () => {
      const scene = await framework.scenes.run({ inputs: { seed: "包输入" }, title: "第一镜" });
      const finished = await framework.scenes.wait(scene.runId);
      return { runId: scene.runId, status: finished.status, packageRunId: framework.env.packageRunId, projectDirectory: framework.env.projectDirectory };
    } });`,
  });
  const loaded = await service.loadAll();
  assert.equal(loaded.loaded, 1);
  assert.equal(loaded.failed, 0);

  const invoked = await service.invoke("demo");
  assert.equal(invoked.status, "completed");
  const result = invoked.result as { runId: string; status: string; packageRunId: string; projectDirectory: string };
  assert.equal(result.status, "completed");
  assert.equal(result.projectDirectory, project);
  assert.equal(result.packageRunId, invoked.packageRunId);

  const run = h.store.getRun(project, result.runId);
  assert.ok(run, "应通过 RunService 创建普通子运行");
  assert.equal(run.sceneId, SCENE_ID);
  assert.equal(run.runTitle, "演示包 · 第一镜");
  assert.equal(run.packageRunId, invoked.packageRunId);
  assert.equal(run.ownerUserId, "@operator");
  assert.equal(run.inputValues.seed, "包输入");
  assert.equal(run.outputs[0]?.value, "产出：包输入");

  const packageRun = await service.getPackageRun(invoked.packageRunId);
  assert.equal(packageRun?.status, "completed");
  assert.deepEqual(packageRun?.runIds, [result.runId]);
});

test("wrong sceneId/versionId returns PACKAGE_EXECUTOR_MISMATCH and creates no RunService submissions", async (t) => {
  const h = await productionHarness(t);
  await h.service.start();
  const workspace = new WorkspaceService(h.store, path.join(h.root, "workspace.json"));
  t.after(() => workspace.shutdown());
  const scene = { id: SCENE_ID, title: "包执行场景", summary: "", description: "", cover: "", accent: "green", stages: [] };
  const workflow = { sceneId: SCENE_ID, name: "包执行场景", inputs: [], steps: [{ id: "step-one", name: "第一步", kind: "fake", outputs: [{ key: "value", type: "text" }] }], outputs: [{ key: "value", type: "text", sourceRef: "step.step-one.outputs.value" }] };
  await workspace.initialize({
    format: "zane-studio.workspace/v1",
    scenes: [scene],
    workflows: { [SCENE_ID]: workflow },
    optionPresets: [],
    drafts: [],
    sceneVersions: { [SCENE_ID]: { publishedVersionId: VERSION_ID, versions: [{ id: VERSION_ID, version: "abc12345", publishedAt: "2026-10-01T00:00:00.000Z", scene, workflow, optionPresets: [] }] } },
  });
  const scenes = new AiSceneService(workspace, h.executors, h.assets, async () => h.settings);
  const service = new CodeScenePackageService({ store: h.store, scenes, runs: h.service, assets: h.assets, loadSettings: async () => h.settings });

  const project = h.settings.projectDirectory;
  await writePackage(project, "spoof", {
    "package.json": manifest("伪造归属"),
    "index.mjs": `export default (framework) => ({ run: async () => { await framework.scenes.run({ sceneId: "another-scene", inputs: {} }); return { ok: true }; } });`,
  });
  await writePackage(project, "catch-all", {
    "package.json": manifest("捕获错误"),
    "index.mjs": `export default (framework) => ({ run: async () => {
      const codes = {};
      try { await framework.scenes.run({ sceneId: "another-scene" }); } catch (error) { codes.sceneId = error.code; }
      try { await framework.scenes.run({ versionId: "another-version" }); } catch (error) { codes.versionId = error.code; }
      try { await framework.scenes.run({ sceneId: "another-scene", inputs: { seed: "x" } }); } catch (error) { codes.nested = error.code; }
      return codes;
    } });`,
  });
  await service.loadAll();

  const spoofed = await service.invoke("spoof");
  assert.equal(spoofed.status, "failed");
  assert.equal(spoofed.errorCode, "PACKAGE_EXECUTOR_MISMATCH");
  assert.deepEqual(spoofed.runIds, []);
  const spoofedRecord = await service.getPackageRun(spoofed.packageRunId);
  assert.equal(spoofedRecord?.status, "failed");
  assert.equal(spoofedRecord?.errorCode, "PACKAGE_EXECUTOR_MISMATCH");

  const caught = await service.invoke("catch-all");
  assert.equal(caught.status, "completed");
  assert.deepEqual(caught.result, { sceneId: "PACKAGE_EXECUTOR_MISMATCH", versionId: "PACKAGE_EXECUTOR_MISMATCH", nested: "PACKAGE_EXECUTOR_MISMATCH" });

  // 任何不匹配都在创建子运行之前拒绝：没有 RunService 提交，也没有运行记录。
  assert.equal(h.store.listRuns(project).runs.length, 0);
});

test("package async throw yields failed package run and package status error while another package still runs", async (t) => {
  let store: import("../storage/sqliteStore.js").SqliteStore | undefined;
  const root = await temporaryDirectory(t, () => store?.close());
  const project = path.join(root, "project");
  await mkdir(project, { recursive: true });
  await writePackage(project, "throws", {
    "package.json": manifest("异步失败"),
    "index.mjs": "export default () => ({ run: async () => { await Promise.resolve(); throw new Error('包内异步失败'); } });",
  });
  await writePackage(project, "works", {
    "package.json": manifest("正常包"),
    "index.mjs": "export default () => ({ run: async () => ({ ok: true }) });",
  });

  const { SqliteStore } = await import("../storage/sqliteStore.js");
  store = new SqliteStore(path.join(root, "metadata.db"));
  const service = new CodeScenePackageService({
    store,
    scenes: { prepare: async () => ({ workflow: {}, inputValues: {} }) } as never,
    runs: { submit: async () => ({}), wait: async () => ({}), cancel: async () => ({}), getRun: async () => undefined } as never,
    loadSettings: async () => ({ projectDirectory: project, comfyuiBaseUrl: "", workflowTimeoutMinutes: 1, enabledHermesProfiles: [] }),
  });
  await service.loadAll();

  const uncaughtBefore = process.listenerCount("uncaughtException");
  const unhandledBefore = process.listenerCount("unhandledRejection");

  const failed = await service.invoke("throws");
  assert.equal(failed.status, "failed");
  assert.match(failed.error ?? "", /包内异步失败/);
  assert.equal(failed.errorCode, "PACKAGE_RUN_FAILED");
  const packageRun = await service.getPackageRun(failed.packageRunId);
  assert.equal(packageRun?.status, "failed");
  assert.match(packageRun?.error ?? "", /包内异步失败/);
  assert.equal(service.get("throws")?.status, "error");
  assert.ok(service.get("throws")?.error);

  // 服务仍可用：另一个包照常执行。
  assert.deepEqual((await service.invoke("works")).result, { ok: true });

  // 入口契约：run() 必须直接拿到 log 函数与 runId/signal（规格 §3），否则照规格写的包首行就崩。
  await writePackage(project, "contract", {
    "package.json": manifest("入口契约"),
    "index.mjs": "export default () => ({ run: async ({ runId, signal, log, inputs }) => { log('info', 'contract log ok'); return { hasLog: typeof log === 'function', runIdIsString: typeof runId === 'string' && runId.length === 36, signalIsAbort: typeof signal?.addEventListener === 'function', inputs }; } });",
  });
  await service.loadAll();
  const contract = await service.invoke("contract", { inputs: { content: "x" } });
  assert.equal(contract.status, "completed");
  assert.deepEqual(contract.result, { hasLog: true, runIdIsString: true, signalIsAbort: true, inputs: { content: "x" } });

  // 绝不能安装进程级监听器来“兜住”包内异步错误。
  assert.equal(process.listenerCount("uncaughtException"), uncaughtBefore);
  assert.equal(process.listenerCount("unhandledRejection"), unhandledBefore);
});
