import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { PackageService } from "../services/packageService.js";
import { CreditService } from "../services/creditService.js";
import { AccessService } from "../services/accessService.js";
import { AiSceneService } from "../services/aiSceneService.js";
import { WorkspaceService } from "../services/workspaceService.js";
import { productionHarness } from "../testing/productionSupport.js";
import { HttpError } from "../errors.js";
import { runInputQuery } from "../ai/accessSchemas.js";

/**
 * 包闭环：发布自包含快照 → 包授权 → 预检上限价 → 预扣 → 逐项串行 → 项间传递 → 确认点 → 包级结算。
 * 使用 fake 执行器，不调用任何外部模型。
 */
test("场景包闭环：自包含快照、串行推进、项间传递、确认点与包级资金", async t => {
  const h = await productionHarness(t, {
    kind: "fake",
    async execute({ step, inputValues }) {
      // 第 2 项（consumer）应收到第 1 项（producer）的产出。
      return { value: step.id === "producer" ? "上游产出" : "收到：" + String(inputValues.seed ?? "") };
    },
  });
  const workspace = new WorkspaceService(h.store, path.join(h.root, "workspace.json"));
  const sceneA = {
    id: "producer-scene", title: "上游场景", summary: "", description: "", cover: "", accent: "green", stages: [],
    pricing: { version: 1, base: 0, steps: { producer: { unit: "per_call", credits: 5 } } },
  };
  const sceneB = {
    id: "consumer-scene", title: "下游场景", summary: "", description: "", cover: "", accent: "green", stages: [],
    pricing: { version: 1, base: 0, steps: { consumer: { unit: "per_call", credits: 7 } } },
  };
  const workflowA = { sceneId: "producer-scene", name: "a", inputs: [], steps: [{ id: "producer", name: "上游", kind: "fake", outputs: [{ key: "value", type: "text" }] }], outputs: [{ key: "value", type: "text", sourceRef: "step.producer.outputs.value" }] };
  const workflowB = { sceneId: "consumer-scene", name: "b", inputs: [{ key: "seed", type: "text", required: true }], steps: [{ id: "consumer", name: "下游", kind: "fake", outputs: [{ key: "value", type: "text" }] }], outputs: [{ key: "value", type: "text", sourceRef: "step.consumer.outputs.value" }] };
  await workspace.initialize({
    format: "zane-studio.workspace/v1",
    scenes: [sceneA, sceneB],
    workflows: { "producer-scene": workflowA, "consumer-scene": workflowB },
    optionPresets: [],
    drafts: [],
    sceneVersions: {
      "producer-scene": { publishedVersionId: "va", versions: [{ id: "va", version: "aaaa1111", publishedAt: "2026-10-01T00:00:00.000Z", scene: sceneA, workflow: workflowA, optionPresets: [] }] },
      "consumer-scene": { publishedVersionId: "vb", versions: [{ id: "vb", version: "bbbb2222", publishedAt: "2026-10-01T00:00:00.000Z", scene: sceneB, workflow: workflowB, optionPresets: [] }] },
    },
  });
  await h.service.start();
  t.after(() => workspace.shutdown());

  const credits = new CreditService(h.store);
  h.useCredits(credits);
  const access = new AccessService(h.store, workspace);
  const scenes = new AiSceneService(workspace, h.executors, h.assets, async () => h.settings);
  const packages = new PackageService(h.store, scenes, h.service, access, credits);

  await access.create({ userId: "admin-1", username: "admin", displayName: "管理员", password: "password12345", role: "admin" });
  const buyer = await access.create({ userId: "buyer-1", username: "buyer", displayName: "买家", password: "password12345", role: "user" });
  await access.setPackages({ userId: buyer.user.id, revision: buyer.user.revision, packageIds: ["pipeline"] }, new Set(["pipeline"]));
  const login = await access.login("buyer", "password12345", { clientAddress: "127.0.0.1" });
  const identity = access.authenticate(login.token);
  credits.adjust({ userId: buyer.user.id, revision: 0, delta: 100, note: "测试额度" });

  // 建包：上游产出 → 下游 seed（项间传递），下游完成后需要人工确认。
  const created = await packages.createDraft({
    id: "pipeline", title: "两段流水线", summary: "上游生成，下游消费",
    inputs: [],
    items: [
      { id: "up", name: "上游", sceneId: "producer-scene", versionId: "va", inputs: [] },
      { id: "down", name: "下游", sceneId: "consumer-scene", versionId: "vb", inputs: [{ key: "seed", valueSource: "previous", sourceRef: "up.value" }], confirmAfter: true },
    ],
  });
  assert.equal(created.package.items.length, 2);

  // 更新草稿：revision 是元数据而不是文档字段，不能被 strict 校验当成未识别键。
  const updated = await packages.updateDraft("pipeline", { revision: created.package.revision, title: "两段流水线（改）" });
  assert.equal(updated.package.title, "两段流水线（改）");
  assert.equal(updated.package.revision, created.package.revision + 1);

  // 服务定价只能引用包内项；不存在的项ID必须拒绝，避免静默不收费。
  await assert.rejects(
    packages.updateDraft("pipeline", { revision: updated.package.revision, pricing: { version: 1, base: 0, items: { ghost: { unit: "per_call", credits: 1 } } } }),
    (error: unknown) => error instanceof HttpError && error.code === "INVALID_PACKAGE",
  );

  // 发布：快照自包含（内嵌组件 workflow）。
  const published = await packages.publish("pipeline", { revision: updated.package.revision, publicationId: "11111111-1111-4111-8111-111111111111" });
  assert.equal(published.created, true);
  assert.ok(published.version.items[0].workflow.steps.length, "包版本必须内嵌组件工作流");

  // 重复发布同一 publicationId：幂等回执，不产生第二版。
  const replay = await packages.publish("pipeline", { revision: updated.package.revision, publicationId: "11111111-1111-4111-8111-111111111111" });
  assert.equal(replay.created, false);

  // 预检：上限价 = 5 + 7 = 12。
  const prepared = await packages.prepare(identity, "pipeline", { versionId: published.version.versionId, inputValues: {} });
  assert.equal(prepared.costPlan.total, 12);
  assert.equal(prepared.credits?.available, 100);

  // 提交：预扣 12，上游立即开始。
  const submitted = await packages.submit(identity, "pipeline", { versionId: published.version.versionId, inputValues: {}, packageRunId: "22222222-2222-4222-8222-222222222222" });
  assert.equal(submitted.created, true);
  assert.equal(credits.balance(buyer.user.id).balance, 88);

  // 等待：上游完成 → 下游执行 → 下游完成后停在确认点。
  // 用户面只拿到服务级进度；内部项与子运行ID属于实现细节，管理员视图才可见。
  let view = submitted.packageRun;
  for (let attempt = 0; attempt < 60 && view.status !== "waiting_confirm"; attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, 100));
    view = await packages.getRun(identity, "22222222-2222-4222-8222-222222222222");
  }
  assert.equal(view.status, "waiting_confirm", "confirmAfter 项完成后必须停下等待确认");
  const serviceView = view as { confirmation?: { step: number }; items?: unknown };
  assert.equal(serviceView.confirmation?.step, 2, "用户看到的是「第 2 步等你确认」，不是组件名");
  assert.equal(serviceView.items, undefined, "用户视图不得下发组件名、步骤名与子运行ID");

  const adminLogin = await access.login("admin", "password12345", { clientAddress: "127.0.0.1" });
  const adminIdentity = access.authenticate(adminLogin.token);
  const adminView = (await packages.getRun(adminIdentity, "22222222-2222-4222-8222-222222222222")) as unknown as { items: Array<{ itemId: string; status: string; runId?: string }> };
  const downItem = adminView.items.find(item => item.itemId === "down")!;
  assert.equal(downItem.status, "waiting_confirm");

  // 项间传递真的生效：下游收到的 seed 是上游产出。
  const downRun = h.store.getRun(h.settings.projectDirectory, downItem.runId!)!;
  assert.equal(downRun.inputValues.seed, "上游产出");

  // approve：继续剩余项并结算；charged = 5 + 7。
  const approved = await packages.confirmItem(identity, { packageRunId: "22222222-2222-4222-8222-222222222222", itemId: "down", action: "approve" });
  assert.ok(approved.packageRun);
  await new Promise(resolve => setTimeout(resolve, 300));
  const final = await packages.getRun(identity, "22222222-2222-4222-8222-222222222222");
  assert.ok(["completed", "running"].includes(final.status), "approve 后应继续推进到终态：" + final.status);
  assert.equal(credits.balance(buyer.user.id).balance, 88, "包级资金一次预扣，子运行不重复扣费");

  // 包级精确结算：两项都完成 → 收满 12 分，余额 88；settlement 记录必须写入。
  const settledView = await packages.getRun(identity, "22222222-2222-4222-8222-222222222222");
  assert.ok(settledView.credit?.settlement, "包运行终态必须写入结算记录");
  assert.equal(settledView.credit!.settlement!.charged, 12);
  assert.equal(settledView.credit!.settlement!.refunded, 0);
  assert.equal(credits.balance(buyer.user.id).balance, 88);
  assert.equal(credits.balance(buyer.user.id).reserved, 0, "结算后不应再有未结算预扣");
  assert.deepEqual(h.store.creditIntegrity().mismatches, []);

  // 授权边界：没有包授权的用户不能读/提交。
  const outsider = await access.create({ userId: "outsider", username: "outsider", displayName: "外部", password: "password12345", role: "user" });
  const outsiderLogin = await access.login("outsider", "password12345", { clientAddress: "127.0.0.1" });
  const outsiderIdentity = access.authenticate(outsiderLogin.token);
  await assert.rejects(packages.getAvailable(outsiderIdentity, "pipeline"), (error: unknown) => error instanceof HttpError && error.code === "PACKAGE_ACCESS_DENIED");
  await assert.rejects(packages.getRun(outsiderIdentity, "22222222-2222-4222-8222-222222222222"), (error: unknown) => error instanceof HttpError && error.status === 404);
  assert.equal(outsider.user.packageIds?.length, 0);

  // 快照自包含：把组件场景从工作区删掉后，已发布的包仍可读取与预检。
  const snapshot = await workspace.get();
  await workspace.mutateScoped(current => {
    current.scenes = (current.scenes as Array<Record<string, unknown>>).filter(scene => scene.id !== "consumer-scene");
    return { workspace: current, result: {} };
  });
  assert.ok(snapshot);
  const stillAvailable = await packages.getAvailable(identity, "pipeline", published.version.versionId);
  assert.equal(stillAvailable.steps.length, 2);
});

/**
 * 服务定价独立于内部场景：包配置自己的 pricing 后，按服务价计费，
 * 不随组件场景的定价（含无定价）变化——包是 SaaS 服务，场景只是它的调度单元。
 */
test("服务自定价优先于组件场景定价", async t => {
  const h = await productionHarness(t, { kind: "fake", async execute() { return { value: "ok" }; } });
  const workspace = new WorkspaceService(h.store, path.join(h.root, "workspace.json"));
  // 组件场景没有任何定价：旧逻辑下包会变成免费。
  const sceneA = { id: "free-scene", title: "无定价场景", summary: "", description: "", cover: "", accent: "green", stages: [] };
  const workflowA = { sceneId: "free-scene", name: "a", inputs: [], steps: [{ id: "run", name: "执行", kind: "fake", outputs: [{ key: "value", type: "text" }] }], outputs: [{ key: "value", type: "text", sourceRef: "step.run.outputs.value" }] };
  await workspace.initialize({
    format: "zane-studio.workspace/v1",
    scenes: [sceneA],
    workflows: { "free-scene": workflowA },
    optionPresets: [], drafts: [],
    sceneVersions: { "free-scene": { publishedVersionId: "v1", versions: [{ id: "v1", version: "cccc3333", publishedAt: "2026-10-01T00:00:00.000Z", scene: sceneA, workflow: workflowA, optionPresets: [] }] } },
  });
  await h.service.start();
  t.after(() => workspace.shutdown());

  const credits = new CreditService(h.store);
  h.useCredits(credits);
  const access = new AccessService(h.store, workspace);
  const scenes = new AiSceneService(workspace, h.executors, h.assets, async () => h.settings);
  const packages = new PackageService(h.store, scenes, h.service, access, credits);

  await access.create({ userId: "admin-2", username: "admin2", displayName: "管理员", password: "password12345", role: "admin" });
  const buyer = await access.create({ userId: "buyer-2", username: "buyer2", displayName: "买家", password: "password12345", role: "user" });
  await access.setPackages({ userId: buyer.user.id, revision: buyer.user.revision, packageIds: ["svc"] }, new Set(["svc"]));
  const login = await access.login("buyer2", "password12345", { clientAddress: "127.0.0.1" });
  const identity = access.authenticate(login.token);
  credits.adjust({ userId: buyer.user.id, revision: 0, delta: 100, note: "测试额度" });

  // 服务自己定价：每项 3 分 + 基础 2 分。
  const created = await packages.createDraft({
    id: "svc", title: "独立服务", inputs: [],
    items: [{ id: "step1", name: "第一步", sceneId: "free-scene", versionId: "v1", inputs: [] }],
    pricing: { version: 1, base: 2, items: { step1: { unit: "per_call", credits: 3 } } },
  });
  const published = await packages.publish("svc", { revision: created.package.revision, publicationId: "33333333-3333-4333-8333-333333333333" });
  assert.equal(published.version.pricing.source, "package", "配置了服务定价就必须按服务价固化");

  const prepared = await packages.prepare(identity, "svc", { versionId: published.version.versionId, inputValues: {} });
  assert.equal(prepared.costPlan.total, 5, "服务定价 = base 2 + 项 3，且不受组件场景无定价影响");

  // 未配置服务定价时仍回退组件定价（旧包兼容）。
  const legacy = await packages.createDraft({
    id: "legacy-svc", title: "旧服务", inputs: [],
    items: [{ id: "step1", name: "第一步", sceneId: "free-scene", versionId: "v1", inputs: [] }],
  });
  const legacyPublished = await packages.publish("legacy-svc", { revision: legacy.package.revision, publicationId: "44444444-4444-4444-8444-444444444444" });
  assert.equal(legacyPublished.version.pricing.source, "component");
  await access.setPackages({ userId: buyer.user.id, revision: access.get(buyer.user.id)!.revision, packageIds: ["svc", "legacy-svc"] }, new Set(["svc", "legacy-svc"]));
  const legacyPrepared = await packages.prepare(identity, "legacy-svc", { versionId: legacyPublished.version.versionId, inputValues: {} });
  assert.equal(legacyPrepared.costPlan.total, 0, "组件无定价且服务未定价时仍为 0（旧行为）");
});

/**
 * 包定价精度：服务定价的 base 与各项单价都是两位小数，包级上限价、预扣、逐项计费与结算
 * 都必须在整数厘域累加——直接对 0.05 这类分数求和会出现 0.15000000000000002。
 */
test("包定价小数：上限价、预扣与包级结算不带浮点尾数", async t => {
  const h = await productionHarness(t, { kind: "fake", async execute() { return { value: "ok" }; } });
  const workspace = new WorkspaceService(h.store, path.join(h.root, "workspace.json"));
  const sceneA = { id: "cent-scene", title: "小额场景", summary: "", description: "", cover: "", accent: "green", stages: [] };
  const workflowA = { sceneId: "cent-scene", name: "a", inputs: [], steps: [{ id: "run", name: "执行", kind: "fake", outputs: [{ key: "value", type: "text" }] }], outputs: [{ key: "value", type: "text", sourceRef: "step.run.outputs.value" }] };
  await workspace.initialize({
    format: "zane-studio.workspace/v1",
    scenes: [sceneA],
    workflows: { "cent-scene": workflowA },
    optionPresets: [], drafts: [],
    sceneVersions: { "cent-scene": { publishedVersionId: "v1", versions: [{ id: "v1", version: "dddd4444", publishedAt: "2026-10-01T00:00:00.000Z", scene: sceneA, workflow: workflowA, optionPresets: [] }] } },
  });
  await h.service.start();
  t.after(() => workspace.shutdown());

  const credits = new CreditService(h.store);
  h.useCredits(credits);
  const access = new AccessService(h.store, workspace);
  const scenes = new AiSceneService(workspace, h.executors, h.assets, async () => h.settings);
  const packages = new PackageService(h.store, scenes, h.service, access, credits);

  await access.create({ userId: "admin-3", username: "admin3", displayName: "管理员", password: "password12345", role: "admin" });
  const buyer = await access.create({ userId: "buyer-3", username: "buyer3", displayName: "买家", password: "password12345", role: "user" });
  await access.setPackages({ userId: buyer.user.id, revision: buyer.user.revision, packageIds: ["cent-svc"] }, new Set(["cent-svc"]));
  const login = await access.login("buyer3", "password12345", { clientAddress: "127.0.0.1" });
  const identity = access.authenticate(login.token);
  credits.adjust({ userId: buyer.user.id, revision: 0, delta: 1, note: "测试额度" });

  // 基础 0.05 + 三项各 0.05 = 0.2（浮点会得到 0.20000000000000004）。
  const created = await packages.createDraft({
    id: "cent-svc", title: "小额服务", inputs: [],
    items: [
      { id: "a", name: "第一步", sceneId: "cent-scene", versionId: "v1", inputs: [] },
      { id: "b", name: "第二步", sceneId: "cent-scene", versionId: "v1", inputs: [] },
      { id: "c", name: "第三步", sceneId: "cent-scene", versionId: "v1", inputs: [] },
    ],
    pricing: { version: 1, base: 0.05, items: { a: { unit: "per_call", credits: 0.05 }, b: { unit: "per_call", credits: 0.05 }, c: { unit: "per_call", credits: 0.05 } } },
  });
  const published = await packages.publish("cent-svc", { revision: created.package.revision, publicationId: "55555555-5555-4555-8555-555555555555" });

  const prepared = await packages.prepare(identity, "cent-svc", { versionId: published.version.versionId, inputValues: {} });
  assert.equal(prepared.costPlan.total, 0.2);
  assert.equal(prepared.costPlan.base, 0.05);
  assert.equal(prepared.costPlan.steps.a.credits, 0.05);

  const submitted = await packages.submit(identity, "cent-svc", { versionId: published.version.versionId, inputValues: {}, packageRunId: "66666666-6666-4666-8666-666666666666" });
  assert.ok(submitted.packageRun);
  // 预扣 0.2：余额 1 → 0.8，占用 0.2；预扣已扣进余额，可用同样是 0.8，都是精确两位小数。
  const held = credits.balance(buyer.user.id);
  assert.equal(held.balance, 0.8);
  assert.equal(held.reserved, 0.2);
  assert.equal(held.available, 0.8);

  // 跑完三项：包级结算按已完成项计费。这里只断言精度——0.05×3 必须是 0.15，
  // 而不是 0.15000000000000002；base 是否参与包级实扣是另一条既有口径，本次不改。
  let view = submitted.packageRun;
  for (let attempt = 0; attempt < 60 && !["completed", "completed_with_errors", "failed"].includes(view.status); attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, 100));
    view = await packages.getRun(identity, "66666666-6666-4666-8666-666666666666");
  }
  assert.equal(view.status, "completed");
  assert.equal(view.credit?.total, 0.2);
  assert.equal(view.credit?.settlement?.charged, 0.15);
  assert.equal(view.credit?.settlement?.refunded, 0.05);
  assert.equal(credits.balance(buyer.user.id).balance, 0.85);
  assert.equal(credits.balance(buyer.user.id).reserved, 0);
  assert.deepEqual(h.store.creditIntegrity().mismatches, []);
});

/**
 * 服务运行原始输入：字段取该次运行固化的包发布快照、值取提交时快照。
 * 分页/省略/媒体投影与单次运行一致；改版不影响历史；非本人一律 404。
 */
test("服务运行原始输入：固定快照、分页与省略、媒体只给固定引用、改版不影响", async t => {
  const h = await productionHarness(t, { kind: "fake", async execute() { return { value: "ok" }; } });
  const workspace = new WorkspaceService(h.store, path.join(h.root, "workspace.json"));
  const scene = { id: "input-scene", title: "输入场景", summary: "", description: "", cover: "", accent: "green", stages: [] };
  const workflow = {
    sceneId: "input-scene", name: "a",
    inputs: [
      { key: "brief", type: "text", required: true, label: "画面描述" },
      { key: "count", type: "number", minimum: 1, maximum: 4 },
      { key: "reference", type: "image" },
    ],
    steps: [{ id: "run", name: "执行", kind: "fake", outputs: [{ key: "value", type: "text" }] }],
    outputs: [{ key: "value", type: "text", sourceRef: "step.run.outputs.value" }],
  };
  await workspace.initialize({
    format: "zane-studio.workspace/v1",
    scenes: [scene],
    workflows: { "input-scene": workflow },
    optionPresets: [], drafts: [],
    sceneVersions: { "input-scene": { publishedVersionId: "v1", versions: [{ id: "v1", version: "eeee5555", publishedAt: "2026-10-01T00:00:00.000Z", scene, workflow, optionPresets: [] }] } },
  });
  await h.service.start();
  t.after(() => workspace.shutdown());

  const access = new AccessService(h.store, workspace);
  const scenes = new AiSceneService(workspace, h.executors, h.assets, async () => h.settings);
  const packages = new PackageService(h.store, scenes, h.service, access);

  await access.create({ userId: "admin-in", username: "adminin", displayName: "管理员", password: "password12345", role: "admin" });
  const buyer = await access.create({ userId: "buyer-in", username: "buyerin", displayName: "买家", password: "password12345", role: "user" });
  await access.setPackages({ userId: buyer.user.id, revision: buyer.user.revision, packageIds: ["input-svc"] }, new Set(["input-svc"]));
  const identity = access.authenticate((await access.login("buyerin", "password12345", { clientAddress: "127.0.0.1" })).token);
  // 媒体用本人固定素材：服务运行输入必须只回 assetId+assetVersion，不带本机路径。
  const picture = await h.assets.save({ name: "参考图", kind: "image" }, { bytes: Buffer.from("picture"), filename: "ref.png" }, { ownerUserId: buyer.user.id, authorize: () => undefined });

  const created = await packages.createDraft({
    id: "input-svc", title: "输入服务",
    inputs: workflow.inputs.map(field => ({ ...field })),
    items: [{ id: "only", name: "唯一项", sceneId: "input-scene", versionId: "v1", inputs: workflow.inputs.map(field => ({ key: field.key, valueSource: "input", sourceRef: "input." + field.key })) }],
  });
  const published = await packages.publish("input-svc", { revision: created.package.revision, publicationId: "77777777-7777-4777-8777-777777777777" });
  const brief = "长".repeat(2500);
  // 与网页上传回执一致：带 assetName/previewUrl 的固定素材引用（包级校验要求可读定位）。
  const values = { brief, count: 3, reference: picture.reference };
  const submitted = await packages.submit(identity, "input-svc", { versionId: published.version.versionId, inputValues: values, packageRunId: "88888888-8888-4888-8888-888888888888" });
  assert.ok(submitted.packageRun);

  const page = await packages.inputs(identity, "88888888-8888-4888-8888-888888888888", runInputQuery.parse({ valueLimit: "10" }));
  assert.equal(page.packageId, "input-svc");
  assert.equal(page.runId, "88888888-8888-4888-8888-888888888888");
  assert.deepEqual(page.inputs.map(field => field.key), ["brief", "count", "reference"]);
  const briefField = page.inputs.find(field => field.key === "brief")!;
  assert.equal(briefField.valuePage.kind, "string");
  assert.equal(briefField.valuePage.total, 2500);
  assert.equal(briefField.valuePage.count, 10, "valueLimit 必须按码点分段，不是整段返回");
  assert.equal(briefField.valuePage.hasMore, true);
  assert.equal(typeof briefField.value, "string");
  assert.equal((briefField.value as string).length, 10);
  // 第二段接着读，拼起来必须等于原值（不能静默截断）。
  const rest = await packages.inputs(identity, "88888888-8888-4888-8888-888888888888", runInputQuery.parse({ inputKey: "brief", valueOffset: "10", valueLimit: "8192" }));
  assert.equal((rest.inputs[0].value as string), brief.slice(10));

  const media = page.inputs.find(field => field.key === "reference")!;
  // 固定引用 + 展示名；不带 path/previewUrl 之类的定位信息。
  assert.deepEqual(media.value, { assetId: picture.asset.id, assetVersion: 1, assetName: "参考图" });
  assert.ok(!JSON.stringify(media.value).includes(h.settings.projectDirectory), "不得返回本机路径");

  // 元数据模式：明确标记省略，而不是当成空值。
  const metadata = await packages.inputs(identity, "88888888-8888-4888-8888-888888888888", runInputQuery.parse({ includeValues: false }));
  assert.ok(metadata.inputs.every(field => field.valueOmitted === true && field.omissionReason === "metadata_only"));

  // 重新发布新字段后，历史运行仍按当时的快照显示（不把新字段/新默认值投影到过去）。
  // revision 取发布后重新读取的草稿值，不自己推算（publish 也会推进 revision）。
  const currentDraft = await packages.getDraft("input-svc");
  const nextDraft = await packages.updateDraft("input-svc", { revision: currentDraft.package.revision, inputs: [...workflow.inputs.map(field => ({ ...field })), { key: "extra", type: "text", defaultValue: "新字段" }] });
  await packages.publish("input-svc", { revision: nextDraft.package.revision, publicationId: "99999999-9999-4999-8999-999999999999" });
  const afterRepublish = await packages.inputs(identity, "88888888-8888-4888-8888-888888888888", runInputQuery.parse({}));
  assert.deepEqual(afterRepublish.inputs.map(field => field.key), ["brief", "count", "reference"], "历史运行不得出现重新发布后才有的字段");

  // 归属隔离：他人读同一条服务运行一律 404，不暴露存在性。
  const outsider = await access.create({ userId: "outsider-in", username: "outsiderin", displayName: "外部", password: "password12345", role: "user" });
  const outsiderIdentity = access.authenticate((await access.login("outsiderin", "password12345", { clientAddress: "127.0.0.1" })).token);
  assert.equal(outsider.user.packageIds?.length, 0);
  await assert.rejects(packages.inputs(outsiderIdentity, "88888888-8888-4888-8888-888888888888", runInputQuery.parse({})), (error: unknown) => error instanceof HttpError && error.status === 404);
  await assert.rejects(packages.inputs(identity, "88888888-8888-4888-8888-888888888888", runInputQuery.parse({ inputKey: "missing" })), (error: unknown) => error instanceof HttpError && error.status === 404 && error.code === "INPUT_NOT_AVAILABLE");
});
