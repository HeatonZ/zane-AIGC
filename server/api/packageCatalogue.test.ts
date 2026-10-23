import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import test, { type TestContext } from "node:test";

import express from "express";

import { aiHarness } from "../testing/aiSupport.js";
import { AccessService } from "../services/accessService.js";
import { UserPortalService } from "../services/userPortalService.js";
import { PackageService } from "../services/packageService.js";
import { PackageCatalogueService } from "../services/packageCatalogueService.js";
import { CodeScenePackageService } from "../services/codeScenePackageService.js";
import { CreditService } from "../services/creditService.js";
import { createAccessRouter, createAuthRouter } from "./accessRoutes.js";
import { HttpError } from "../errors.js";
import { until } from "../testing/testSupport.js";

/**
 * 用户面场景包唯一入口（P4）：代码子工程与历史配置型包在 `/api/v1/self/packages*` 合并成
 * 一个目录，同 packageId 代码包优先，运行记录按 packageRunId 归属分流。
 *
 * 这一组用真实 AiSceneService + RunService（fake 执行器）跑完整闭环，不用桩：
 * 提交 → 预扣 → 子运行 → 结算，全部走生产同一条代码路径。
 */

const password = "catalogue-password-2026";

const SUCCESS_CODE = `export default function create(framework) {
  return {
    async run({ inputs }) {
      const scene = await framework.scenes.run({ inputs });
      await framework.scenes.wait(scene.runId);
      const out = await framework.scenes.outputs(scene.runId);
      return { outputs: { sceneRunId: scene.runId, status: out.status } };
    },
  };
}`;

const FAILING_CODE = `export default function create() {
  return {
    async run() {
      throw new Error("包内部故意失败");
    },
  };
}`;

async function writePackage(projectDirectory: string, packageId: string, manifest: Record<string, unknown>, code: string) {
  const directory = path.join(projectDirectory, "scene-packages", packageId);
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, "package.json"), JSON.stringify({ zaneScenePackage: manifest }));
  await writeFile(path.join(directory, "index.mjs"), code);
}

async function harness(t: TestContext) {
  const h = await aiHarness(t);
  const credits = new CreditService(h.store);
  h.useCredits(credits);
  const access = new AccessService(h.store, h.workspace, "");
  const portal = new UserPortalService(access, h.scenes, h.service, credits);
  const config = new PackageService(h.store, h.scenes, h.service, access, credits);
  const code = new CodeScenePackageService({
    store: h.store,
    scenes: h.scenes,
    runs: h.service,
    assets: h.assets,
    credits,
    access,
    loadSettings: async () => h.settings,
  });
  const catalogue = new PackageCatalogueService(config, code);

  const app = express();
  app.use(express.json());
  app.use(createAuthRouter(access));
  app.use(access.middleware(async () => h.settings.projectDirectory));
  app.use(createAccessRouter(access, portal, credits, catalogue));
  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) =>
    res.status(error instanceof HttpError ? error.status : 500).json({
      error: (error as Error).message,
      code: error instanceof HttpError ? error.code : "INTERNAL_ERROR",
      ...(error instanceof HttpError && error.details ? { details: error.details } : {}),
    }));
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  t.after(() => new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); }));
  const base = "http://127.0.0.1:" + (server.address() as { port: number }).port;

  const api = async (route: string, token = "", body?: unknown) => {
    const response = await fetch(base + route, {
      method: body === undefined ? "GET" : "POST",
      headers: { ...(token ? { Authorization: "Bearer " + token } : {}), ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { response, data: (await response.json()) as Record<string, any> };
  };
  const createUser = async (name: string, role: "admin" | "user" = "user") => {
    const user = (await access.create({ userId: randomUUID(), username: name, displayName: name, password, role })).user;
    const session = await access.login(name, password);
    return { user, token: session.token, identity: access.authenticate(session.token) };
  };
  return { ...h, credits, access, portal, config, code, catalogue, base, api, createUser };
}

test("用户面目录：代码子工程与配置型包合并，同一 packageId 代码包优先且只出一条", async (t) => {
  const h = await harness(t);
  const user = await h.createUser("buyer");
  // 同一个 packageId 同时存在代码包与已发布的配置型包：这是「生图包等价替换」的形状。
  await writePackage(h.settings.projectDirectory, "ai_image", {
    title: "生图（代码包）", version: "1.0.0", summary: "写描述出图",
    executor: { sceneId: "demo", versionId: "version-a" },
    inputs: [{ key: "flag", type: "boolean", required: true }],
    pricing: { version: 1, base: 0, items: { generate: { unit: "per_call", credits: 0.05 } } },
  }, SUCCESS_CODE);
  await h.code.loadAll();

  const draft = await h.config.createDraft({
    id: "ai_image", title: "生图（配置型）",
    inputs: [{ key: "flag", type: "boolean", required: true }],
    items: [{ id: "only", name: "唯一项", sceneId: "demo", versionId: "version-a", inputs: [{ key: "flag", valueSource: "input", sourceRef: "input.flag" }] }],
  });
  await h.config.publish("ai_image", { revision: draft.package.revision, publicationId: "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb" });
  await h.access.setPackages({ userId: user.user.id, revision: h.access.get(user.user.id)!.revision, packageIds: ["ai_image"] }, new Set(["ai_image"]));

  const listed = await h.api("/api/v1/self/packages", user.token);
  assert.equal(listed.response.status, 200, JSON.stringify(listed.data));
  const items = listed.data.packages as Array<{ packageId: string; source: string; title: string }>;
  assert.equal(items.length, 1, "同一 packageId 只能有一条目录项：" + JSON.stringify(items));
  assert.equal(items[0]!.packageId, "ai_image");
  assert.equal(items[0]!.source, "code");
  assert.equal(items[0]!.title, "生图（代码包）");

  // 详情：走代码包，带 inputs 契约 + presentation（本包未声明页面 → 不返回 presentation，不伪造）。
  const detail = await h.api("/api/v1/self/packages/ai_image", user.token);
  assert.equal(detail.response.status, 200, JSON.stringify(detail.data));
  assert.equal(detail.data.source, "code");
  assert.equal(detail.data.version, "1.0.0");
  assert.deepEqual(detail.data.fields.map((field: { key: string }) => field.key), ["flag"]);
  assert.equal(detail.data.costPlan.total, 0.05);
  // 实现细节不下发：磁盘路径、入口文件、执行场景 ID 都不能出现在用户面。
  assert.ok(!("directory" in detail.data));
  assert.ok(!("executorSceneId" in detail.data));
});

test("代码包没有发布时回退到配置型包，不制造功能空洞", async (t) => {
  const h = await harness(t);
  const user = await h.createUser("buyer2");
  // 磁盘上没有 code_only 这个代码包，只有已发布的配置型同 ID 包。
  const draft = await h.config.createDraft({
    id: "code_only", title: "只有配置型",
    inputs: [{ key: "flag", type: "boolean", required: true }],
    items: [{ id: "only", name: "唯一项", sceneId: "demo", versionId: "version-a", inputs: [{ key: "flag", valueSource: "input", sourceRef: "input.flag" }] }],
  });
  await h.config.publish("code_only", { revision: draft.package.revision, publicationId: "cccccccc-3333-4333-8333-cccccccccccc" });
  await h.access.setPackages({ userId: user.user.id, revision: h.access.get(user.user.id)!.revision, packageIds: ["code_only"] }, new Set(["code_only"]));

  const listed = await h.api("/api/v1/self/packages", user.token);
  assert.equal(listed.response.status, 200, JSON.stringify(listed.data));
  const items = listed.data.packages as Array<{ packageId: string; source: string }>;
  assert.deepEqual(items.map((item) => [item.packageId, item.source]), [["code_only", "config"]]);
  const detail = await h.api("/api/v1/self/packages/code_only", user.token);
  assert.equal(detail.data.source, "config");
});

test("代码包提交：授权 + 预扣 + 子运行 + 结算，用户面读得到同一条运行", async (t) => {
  const h = await harness(t);
  const user = await h.createUser("buyer3");
  await writePackage(h.settings.projectDirectory, "gen", {
    title: "生成", version: "1.0.0",
    executor: { sceneId: "demo", versionId: "version-a" },
    inputs: [{ key: "flag", type: "boolean", required: true }],
    pricing: { version: 1, base: 0, items: { generate: { unit: "per_call", credits: 0.05 } } },
  }, SUCCESS_CODE);
  await h.code.loadAll();
  await h.access.setPackages({ userId: user.user.id, revision: h.access.get(user.user.id)!.revision, packageIds: ["gen"] }, new Set(["gen"]));
  // 100 分额度（管理员发码 → 用户兑换），与配置型包同一本账。
  const batch = h.credits.createBatch({ batchId: "batch-code-pkg", name: "测试", faceValue: 100, count: 1 });
  h.credits.redeem(user.user.id, batch.codes[0]);
  const before = h.credits.balance(user.user.id);

  const packageRunId = randomUUID();
  const submitted = await h.api("/api/v1/self/packages/gen/runs", user.token, { inputValues: { flag: true }, packageRunId });
  assert.equal(submitted.response.status, 202, JSON.stringify(submitted.data));
  assert.equal(submitted.data.packageRun.packageRunId, packageRunId);
  assert.equal(submitted.data.packageRun.source, "code");
  assert.equal(submitted.data.created, true);

  // 预扣发生：余额下降 0.05，占用 0.05（与配置型包同一账本）。
  const reserved = h.credits.balance(user.user.id);
  assert.equal(Number((before.balance - reserved.balance).toFixed(2)), 0.05);
  assert.equal(Number(reserved.reserved.toFixed(2)), 0.05);

  // 用户面能读到这条运行，且来源被标成 code（前端据此不需要猜）。
  const polled = await h.api("/api/v1/self/package-runs/" + packageRunId, user.token);
  assert.equal(polled.response.status, 200, JSON.stringify(polled.data));
  assert.equal(polled.data.source, "code");
  assert.equal(polled.data.packageId, "gen");

  await until(() => ["completed", "failed", "cancelled"].includes(
    h.store.getDocument<{ status: string }>(h.settings.projectDirectory, "codeScenePackageRuns", packageRunId)?.status ?? ""));
  const finished = await h.api("/api/v1/self/package-runs/" + packageRunId, user.token);
  assert.equal(finished.data.stage, "completed", JSON.stringify(finished.data));
  // 成功即结算：占用清零，实扣 0.05，退还 0。
  const settled = h.credits.balance(user.user.id);
  assert.equal(Number(settled.reserved.toFixed(2)), 0);
  assert.equal(Number((before.balance - settled.balance).toFixed(2)), 0.05);
  assert.equal(Number(finished.data.credit.settlement.charged.toFixed(2)), 0.05);
  assert.equal(Number(finished.data.credit.settlement.refunded.toFixed(2)), 0);

  // 同 ID 重放：不重复执行、不重复扣费。
  const replay = await h.api("/api/v1/self/packages/gen/runs", user.token, { inputValues: { flag: true }, packageRunId });
  assert.equal(replay.response.status, 202);
  assert.equal(replay.data.created, false);
  assert.equal(Number(h.credits.balance(user.user.id).balance.toFixed(2)), Number(settled.balance.toFixed(2)));

  // 本人的运行列表里能看到它（合并两个来源后仍按时间倒序）。
  const runs = await h.api("/api/v1/self/package-runs", user.token);
  assert.equal(runs.response.status, 200, JSON.stringify(runs.data));
  assert.deepEqual((runs.data.items as Array<{ packageRunId: string }>).map((item) => item.packageRunId), [packageRunId]);
});

test("代码包失败：全额退还预扣，不留悬空占用", async (t) => {
  const h = await harness(t);
  const user = await h.createUser("buyer4");
  await writePackage(h.settings.projectDirectory, "boom", {
    title: "会失败", version: "1.0.0",
    executor: { sceneId: "demo", versionId: "version-a" },
    inputs: [],
    pricing: { version: 1, base: 0, items: { generate: { unit: "per_call", credits: 0.05 } } },
  }, FAILING_CODE);
  await h.code.loadAll();
  await h.access.setPackages({ userId: user.user.id, revision: h.access.get(user.user.id)!.revision, packageIds: ["boom"] }, new Set(["boom"]));
  const batch = h.credits.createBatch({ batchId: "batch-code-fail", name: "测试", faceValue: 100, count: 1 });
  h.credits.redeem(user.user.id, batch.codes[0]);
  const before = h.credits.balance(user.user.id);

  const packageRunId = randomUUID();
  const submitted = await h.api("/api/v1/self/packages/boom/runs", user.token, { inputValues: {}, packageRunId });
  assert.equal(submitted.response.status, 202, JSON.stringify(submitted.data));
  await until(() => ["completed", "failed", "cancelled"].includes(
    h.store.getDocument<{ status: string }>(h.settings.projectDirectory, "codeScenePackageRuns", packageRunId)?.status ?? ""));

  const after = h.credits.balance(user.user.id);
  assert.equal(after.balance, before.balance, "失败必须全额退还预扣");
  assert.equal(after.reserved, 0, "失败后不能留下悬空占用");
  const failed = await h.api("/api/v1/self/package-runs/" + packageRunId, user.token);
  assert.equal(failed.data.stage, "failed");
  assert.equal(Number(failed.data.credit.settlement.charged.toFixed(2)), 0);
});

test("边界：未授权 403、越权读别人的 packageRunId 404、确认点对代码包明确拒绝", async (t) => {
  const h = await harness(t);
  const owner = await h.createUser("owner");
  const stranger = await h.createUser("stranger");
  await writePackage(h.settings.projectDirectory, "gen2", {
    title: "生成2", version: "1.0.0",
    executor: { sceneId: "demo", versionId: "version-a" },
    inputs: [],
  }, SUCCESS_CODE);
  await h.code.loadAll();
  await h.access.setPackages({ userId: owner.user.id, revision: h.access.get(owner.user.id)!.revision, packageIds: ["gen2"] }, new Set(["gen2"]));

  // 未授权用户：目录为空、详情 403、提交 403（授权单元仍是 packageIds）。
  const strangerList = await h.api("/api/v1/self/packages", stranger.token);
  assert.deepEqual((strangerList.data.packages as unknown[]).map((item: any) => item.packageId), []);
  assert.equal((await h.api("/api/v1/self/packages/gen2", stranger.token)).response.status, 403);
  assert.equal((await h.api("/api/v1/self/packages/gen2/runs", stranger.token, { inputValues: {} })).response.status, 403);

  const packageRunId = randomUUID();
  assert.equal((await h.api("/api/v1/self/packages/gen2/runs", owner.token, { inputValues: {}, packageRunId })).response.status, 202);
  await until(() => ["completed", "failed", "cancelled"].includes(
    h.store.getDocument<{ status: string }>(h.settings.projectDirectory, "codeScenePackageRuns", packageRunId)?.status ?? ""));

  // 越权：不区分「不存在」与「不是你的」，一律 404。
  for (const route of ["/api/v1/self/package-runs/" + packageRunId, "/api/v1/self/package-runs/" + packageRunId + "/outputs", "/api/v1/self/package-runs/" + packageRunId + "/inputs?limit=5"]) {
    const denied = await h.api(route, stranger.token);
    assert.equal(denied.response.status, 404, route + " → " + JSON.stringify(denied.data));
  }
  // 代码包没有「项完成等确认」的语义，宿主不引入第二套确认状态机。
  const confirm = await h.api("/api/v1/self/package-runs/" + packageRunId + "/items/run/confirm", owner.token, { packageRunId, itemId: "run", action: "approve" });
  assert.equal(confirm.response.status, 409, JSON.stringify(confirm.data));
  assert.equal(confirm.data.code, "PACKAGE_NOT_WAITING");
});

test("授权面：代码包 ID 可授予，CDK 自动授予覆盖代码包且不重复配置型同 ID", async (t) => {
  const h = await harness(t);
  await writePackage(h.settings.projectDirectory, "grantable", {
    title: "可授权", version: "1.0.0",
    executor: { sceneId: "demo", versionId: "version-a" },
    inputs: [],
  }, SUCCESS_CODE);
  await h.code.loadAll();
  const draft = await h.config.createDraft({
    id: "grantable", title: "同 ID 配置型",
    inputs: [{ key: "flag", type: "boolean", required: true }],
    items: [{ id: "only", name: "唯一项", sceneId: "demo", versionId: "version-a", inputs: [{ key: "flag", valueSource: "input", sourceRef: "input.flag" }] }],
  });
  await h.config.publish("grantable", { revision: draft.package.revision, publicationId: "dddddddd-4444-4444-8444-dddddddddddd" });

  const known = await h.catalogue.knownPackageIds();
  assert.ok(known.includes("grantable"), JSON.stringify(known));
  const grantable = await h.catalogue.grantablePackageIds();
  assert.deepEqual(grantable.filter((id) => id === "grantable"), ["grantable"], "同 ID 只能授予一次");
});

/** 行表单契约：`inputMode`/`itemFields` 必须原样到用户面，否则前端只能退回 JSON 文本域。 */
test("用户面投影透传行表单契约：inputMode=object_array 的字段带完整 itemFields，其它字段不带", async (t) => {
  const h = await harness(t);
  const user = await h.createUser("formbuyer");
  const itemFields = [
    { key: "index", label: "镜号", type: "number", required: true, minimum: 1, maximum: 999 },
    { key: "seconds", label: "这一镜秒数", type: "number", required: true, minimum: 1.3, maximum: 15 },
    { key: "prompt", label: "H3 提示词", type: "text", required: true },
    { key: "characters", label: "人物", type: "text", required: false },
    { key: "scenes", label: "场景编号", type: "text", required: false },
    { key: "props", label: "道具编号", type: "text", required: false },
    { key: "continuity", label: "续接上一镜", type: "select", required: false, options: ["", "context"] },
  ];
  await writePackage(h.settings.projectDirectory, "drama", {
    title: "短剧出片", version: "2.0.0",
    executor: { sceneId: "demo", versionId: "version-a" },
    inputs: [
      { key: "segment", type: "text", required: true },
      { key: "shots", type: "json", required: false, inputMode: "object_array", itemFields },
      { key: "brief", type: "textarea", required: false },
    ],
  }, SUCCESS_CODE);
  await h.code.loadAll();
  await h.access.setPackages({ userId: user.user.id, revision: h.access.get(user.user.id)!.revision, packageIds: ["drama"] }, new Set(["drama"]));

  const detail = await h.api("/api/v1/self/packages/drama", user.token);
  assert.equal(detail.response.status, 200, JSON.stringify(detail.data));
  const shots = (detail.data.fields as Array<Record<string, unknown>>).find((field) => field.key === "shots");
  assert.ok(shots, "详情必须带 shots 字段：" + JSON.stringify(detail.data.fields));
  assert.equal(shots.inputMode, "object_array");
  // 行字段必须逐项完整（key/label/type/required + 范围 + 选项），少一项前端就少一个格子。
  assert.deepEqual(shots.itemFields, itemFields);
  // 没声明行表单的字段不能被顺手加上 inputMode：那会让普通文本字段变成表格。
  for (const key of ["segment", "brief"]) {
    const field = (detail.data.fields as Array<Record<string, unknown>>).find((item) => item.key === key);
    assert.equal(field?.inputMode, undefined, key + " 不应带 inputMode");
    assert.equal(field?.itemFields, undefined, key + " 不应带 itemFields");
  }
});

/** 只读工程状态：包写进 framework.store 的账要能按身份读出来，写不进去、也读不到别人的。 */
test("包工程状态只读接口：本人可读原样账，未授权 403，无账 404，key 可选且非法 key 400", async (t) => {
  const h = await harness(t);
  const owner = await h.createUser("stateowner");
  const stranger = await h.createUser("statestranger");
  const writeState = `export default function create(framework) {
    return {
      async run() {
        await framework.store.set("episode", { activeEpisodeLabel: "我家猫有点大 #1", segments: ["s01", "s02"], bibleReady: true });
        return { ok: true };
      },
    };
  }`;
  await writePackage(h.settings.projectDirectory, "stated", {
    title: "有账的包", version: "1.0.0",
    executor: { sceneId: "demo", versionId: "version-a" },
    inputs: [],
  }, writeState);
  await writePackage(h.settings.projectDirectory, "blank", {
    title: "没账的包", version: "1.0.0",
    executor: { sceneId: "demo", versionId: "version-a" },
    inputs: [],
  }, SUCCESS_CODE);
  await h.code.loadAll();
  const revision = h.access.get(owner.user.id)!.revision;
  await h.access.setPackages({ userId: owner.user.id, revision, packageIds: ["stated", "blank"] }, new Set(["stated", "blank"]));
  await h.access.setPackages({ userId: stranger.user.id, revision: h.access.get(stranger.user.id)!.revision, packageIds: ["blank"] }, new Set(["blank"]));

  // 先真跑一次，让包自己写账——不手工塞库，否则测的就不是「包写的账能读出来」。
  const packageRunId = randomUUID();
  assert.equal((await h.api("/api/v1/self/packages/stated/runs", owner.token, { inputValues: {}, packageRunId })).response.status, 202);
  await until(() => ["completed", "failed", "cancelled"].includes(
    h.store.getDocument<{ status: string }>(h.settings.projectDirectory, "codeScenePackageRuns", packageRunId)?.status ?? ""));

  const state = await h.api("/api/v1/self/packages/stated/state", owner.token);
  assert.equal(state.response.status, 200, JSON.stringify(state.data));
  assert.equal(state.data.packageId, "stated");
  assert.equal(state.data.key, "episode");
  assert.equal(typeof state.data.revision, "number");
  assert.deepEqual(state.data.value, { activeEpisodeLabel: "我家猫有点大 #1", segments: ["s01", "s02"], bibleReady: true });
  // 按 key 指定同一条仍读得到；不存在的 key 是「这条账没有」，不是「服务没有」。
  assert.equal((await h.api("/api/v1/self/packages/stated/state?key=episode", owner.token)).response.status, 200);
  assert.equal((await h.api("/api/v1/self/packages/stated/state?key=nope", owner.token)).response.status, 404);
  assert.equal((await h.api("/api/v1/self/packages/stated/state?key=" + encodeURIComponent("bad key!"), owner.token)).response.status, 400);

  // 未授权的包：403（授权单元仍是 packageIds），读不到别人的账。
  assert.equal((await h.api("/api/v1/self/packages/stated/state", stranger.token)).response.status, 403);
  // 有权限但包还没写过账：404，让页面回落「整块不渲染」而不是报错。
  const empty = await h.api("/api/v1/self/packages/blank/state", owner.token);
  assert.equal(empty.response.status, 404, JSON.stringify(empty.data));
  assert.equal(empty.data.code, "PACKAGE_STATE_NOT_FOUND");
  // 只读：没有写入路由，POST 到同一路径不会改账。
  const writeAttempt = await fetch(h.base + "/api/v1/self/packages/stated/state", {
    method: "POST",
    headers: { Authorization: "Bearer " + owner.token, "Content-Type": "application/json" },
    body: JSON.stringify({ value: { segments: ["s99"] } }),
  });
  await writeAttempt.text();
  assert.ok([404, 405].includes(writeAttempt.status), "状态接口不得接受写入：" + writeAttempt.status);
  assert.deepEqual((await h.api("/api/v1/self/packages/stated/state", owner.token)).data.value, { activeEpisodeLabel: "我家猫有点大 #1", segments: ["s01", "s02"], bibleReady: true });
});
