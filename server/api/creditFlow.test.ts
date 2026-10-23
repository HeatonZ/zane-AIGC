import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import path from "node:path";
import { CreditService } from "../services/creditService.js";
import { AccessService } from "../services/accessService.js";
import { UserPortalService } from "../services/userPortalService.js";
import { AiSceneService } from "../services/aiSceneService.js";
import { WorkspaceService } from "../services/workspaceService.js";
import { createAccessRouter } from "../api/accessRoutes.js";
import { productionHarness } from "../testing/productionSupport.js";
import { aiWorkspace } from "../testing/aiSupport.js";
import { HttpError } from "../errors.js";

/**
 * 积分闭环（真实 HTTP，隔离临时项目）：
 * 余额不足 402 → 兑换卡密 → 预检看到上限价 → 提交预扣 → 结算按成功项退还 → 流水可读。
 * 不调用任何外部模型。
 */
test("积分闭环：余额不足、兑换、预检上限价、预扣与结算、流水", async t => {
  const h = await productionHarness(t);
  const workspace = new WorkspaceService(h.store, path.join(h.root, "workspace.json"));
  const snapshot = aiWorkspace();
  // 给场景加定价：首个步骤按次 5 分，第二个步骤按次 10 分，运行基础 3 分。
  const published = (snapshot.sceneVersions as Record<string, { versions: Array<Record<string, unknown>> }>).demo.versions[0];
  published.scene = { ...(published.scene as Record<string, unknown>), pricing: { version: 1, base: 3, steps: { first: { unit: "per_call", credits: 5 }, last: { unit: "per_call", credits: 10 } } } };
  await workspace.initialize(snapshot);
  await h.service.start();
  t.after(() => workspace.shutdown());

  const credits = new CreditService(h.store);
  h.useCredits(credits);
  const access = new AccessService(h.store, workspace);
  await access.create({ userId: "admin-1", username: "admin", displayName: "管理员", password: "password12345", role: "admin" });
  const user = await access.create({ userId: "user-1", username: "buyer", displayName: "买家", password: "password12345", role: "user" });
  await access.setScenes({ userId: user.user.id, revision: user.user.revision, sceneIds: ["demo"] });
  const scenes = new AiSceneService(workspace, h.executors, h.assets, async () => h.settings);
  const portal = new UserPortalService(access, scenes, h.service, credits);

  // 真实身份中间件：与生产一致（会话 cookie/Bearer → identity → 管理员校验）。
  const adminLogin = await access.login("admin", "password12345", { clientAddress: "127.0.0.1" });
  const userLogin = await access.login("buyer", "password12345", { clientAddress: "127.0.0.1" });
  const userIdentity = access.authenticate(userLogin.token);
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { res.locals.identity = access.authenticate(String(req.get("authorization") ?? "").replace(/^Bearer /, "") || adminLogin.token); res.locals.authorizeAdmin = () => access.refresh(res.locals.identity); next(); });
  app.use(createAccessRouter(access, portal, credits));
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => server.once("listening", resolve));
  t.after(() => new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); }));
  const base = "http://127.0.0.1:" + (server.address() as { port: number }).port;

  // 预检：上限价 = 3 + 5 + 10 = 18，余额 0。
  const prepared = await portal.prepare(userIdentity, { sceneId: "demo", versionId: "version-a", inputValues: { flag: true } });
  assert.equal(prepared.costPlan.total, 18);
  assert.equal(prepared.credits?.available, 0);

  // 余额不足：402，不进入队列。
  await assert.rejects(
    portal.submit(userIdentity, { sceneId: "demo", versionId: "version-a", inputValues: { flag: true }, runId: "11111111-1111-4111-8111-111111111111" }),
    (error: unknown) => error instanceof HttpError && error.code === "CREDIT_INSUFFICIENT" && error.details?.required === 18,
  );
  assert.equal(h.store.getRun(h.settings.projectDirectory, "11111111-1111-4111-8111-111111111111"), undefined);

  // 兑换 100 分（管理员发码 → 用户兑换）。
  const batch = credits.createBatch({ batchId: "batch-e2e", name: "测试", faceValue: 100, count: 1 });
  const redeemed = credits.redeem(user.user.id, batch.codes[0]);
  assert.equal(redeemed.faceValue, 100);
  assert.equal(credits.balance(user.user.id).balance, 100);

  // 提交：预扣 18，余额降到 82，reserved 18；预扣已扣进余额，可用同样是 82。
  const submitted = await portal.submit(userIdentity, { sceneId: "demo", versionId: "version-a", inputValues: { flag: true }, runId: "22222222-2222-4222-8222-222222222222" });
  assert.equal(submitted.status, "queued");
  const afterReserve = credits.balance(user.user.id);
  assert.equal(afterReserve.balance, 82);
  assert.equal(afterReserve.reserved, 18);
  assert.equal(afterReserve.available, 82);

  // 跑完：结算只按成功步骤计费，这里两个 fake 步骤都成功 → 18 全收，退还 0。
  const done = await h.service.wait(h.settings.projectDirectory, "22222222-2222-4222-8222-222222222222");
  assert.equal(done.status, "completed");
  const run = h.store.getRun(h.settings.projectDirectory, "22222222-2222-4222-8222-222222222222")!;
  assert.ok(run.credit?.settlement, "终态必须写入结算");
  assert.equal(run.credit!.settlement!.charged, 18);
  assert.equal(run.credit!.settlement!.refunded, 0);
  const afterSettle = credits.balance(user.user.id);
  assert.equal(afterSettle.balance, 82);
  assert.equal(afterSettle.reserved, 0);

  // 流水可读：兑换、预扣、结算各一条。
  const ledger = credits.ledger(user.user.id, { limit: 20 });
  const kinds = ledger.items.map(item => item.kind);
  assert.ok(kinds.includes("cdk_redeem"));
  assert.ok(kinds.includes("run_reserve"));
  assert.ok(kinds.includes("run_settle"));
  assert.deepEqual(h.store.creditIntegrity().mismatches, []);

  // 部分失败：逐项步骤第 2 项失败 → 只收成功的 1 项，其余退还（结算口径与执行器无关）。
  const partialPlan = { pricingVersion: 1, base: 0, total: 20, steps: { shots: { unit: "per_item" as const, credits: 10, units: 2 } } };
  credits.reserve(user.user.id, "33333333-3333-4333-8333-333333333333", partialPlan);
  const partial = { ...h.store.getRun(h.settings.projectDirectory, "22222222-2222-4222-8222-222222222222")!, runId: "33333333-3333-4333-8333-333333333333", ownerUserId: user.user.id, credit: { plan: partialPlan }, steps: [{ stepId: "shots", name: "shots", status: "completed_with_errors" as const, items: [{ index: 0, value: "a", status: "completed" as const }, { index: 1, value: "b", status: "failed" as const }] }] };
  const partialSettlement = credits.settle(partial);
  assert.equal(partialSettlement?.charged, 10);
  assert.equal(partialSettlement?.refunded, 10);
  assert.equal(credits.balance(user.user.id).balance, 82 - 10);

  // 管理员通过 HTTP 发码：新建也返回 200（用 created 区分），响应带明文，之后仍可在明细回读。
  const createBody = { batchId: "batch-http", name: "HTTP 批次", faceValue: 50, count: 2 };
  const response = await fetch(base + "/api/v1/redeem-batches", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(createBody) });
  assert.equal(response.status, 200);
  const issued = await response.json() as { codes: string[]; created: boolean; warning: string };
  assert.equal(issued.created, true);
  assert.equal(issued.codes.length, 2);
  assert.match(issued.warning, /明细|回读/);
  // 同 batchId 重复提交是幂等回执：同样 200、created=false、返回同一份明文，不再报 409。
  const replayResponse = await fetch(base + "/api/v1/redeem-batches", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(createBody) });
  assert.equal(replayResponse.status, 200);
  const replay = await replayResponse.json() as { codes: string[]; created: boolean; batch: { createdAt: string } };
  assert.equal(replay.created, false);
  assert.deepEqual(replay.codes, issued.codes);
  // 批次列表是计数视图，不夹带明文（明文只在创建响应与批次明细接口出现）。
  const listed = await (await fetch(base + "/api/v1/redeem-batches")).json() as { batches: Array<{ batchId: string; unused: number }> };
  assert.ok(!JSON.stringify(listed).includes(issued.codes[0]), "批次列表不得夹带明文");
  assert.equal(listed.batches.find(item => item.batchId === "batch-http")?.unused, 2);
  assert.equal(listed.batches.filter(item => item.batchId === "batch-http").length, 1, "重复提交不得多建批次");

  // 批次明细：逐张回读完整明文（管理端需要发放与核对），哈希仍不外露。
  const detailResponse = await fetch(base + "/api/v1/redeem-batches/batch-http/codes");
  assert.equal(detailResponse.status, 200);
  const detail = await detailResponse.json() as { codes: Array<{ codeId: string; codeHint: string; status: string; code?: string }>; counts: { unused: number }; recoverable: boolean };
  assert.equal(detail.codes.length, 2);
  assert.equal(detail.counts.unused, 2);
  assert.equal(detail.recoverable, true);
  assert.deepEqual(detail.codes.map(code => code.code), issued.codes, "明细必须能回读完整卡密");
  assert.equal(detail.codes[0].codeHint, issued.codes[0].slice(-4));
  assert.ok(!JSON.stringify(detail).includes("codeHash"));

  const voidOne = await fetch(base + "/api/v1/redeem-codes/" + encodeURIComponent(detail.codes[0].codeId) + "/void", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  assert.equal(voidOne.status, 200);
  const afterVoidOne = await (await fetch(base + "/api/v1/redeem-batches/batch-http/codes")).json() as { counts: { unused: number; voided: number } };
  assert.deepEqual(afterVoidOne.counts, { unused: 1, redeemed: 0, voided: 1 });

  // 整批作废：只作废剩余未使用的，重复调用作废 0 张。
  const voidBatchResponse = await fetch(base + "/api/v1/redeem-batches/batch-http/void", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  assert.equal(voidBatchResponse.status, 200);
  const voided = await voidBatchResponse.json() as { voided: number; counts: { unused: number; voided: number } };
  assert.equal(voided.voided, 1);
  assert.deepEqual(voided.counts, { unused: 0, redeemed: 0, voided: 2 });
  const voidReplay = await (await fetch(base + "/api/v1/redeem-batches/batch-http/void", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).json() as { voided: number };
  assert.equal(voidReplay.voided, 0);
  assert.equal((await fetch(base + "/api/v1/redeem-batches/batch-missing/codes")).status, 404);

  // 已兑换的码也能作废（退款）：HTTP 默认 reclaim=true，收回面值并记录作废人。
  const refundBatch = credits.createBatch({ batchId: "batch-refund-http", name: "退款 HTTP", faceValue: 30, count: 1 });
  credits.redeem(user.user.id, refundBatch.codes[0]);
  assert.equal(credits.balance(user.user.id).balance, 102);
  const refundCode = (await (await fetch(base + "/api/v1/redeem-batches/batch-refund-http/codes")).json() as { codes: Array<{ codeId: string; status: string }> }).codes[0];
  const refunded = await fetch(base + "/api/v1/redeem-codes/" + encodeURIComponent(refundCode.codeId) + "/void", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ reclaim: true }) });
  assert.equal(refunded.status, 200);
  const refundedBody = await refunded.json() as { reclaimed: number; shortfall: number; redeemedBy?: string; status: string };
  assert.equal(refundedBody.status, "void");
  assert.equal(refundedBody.reclaimed, 30);
  assert.equal(refundedBody.shortfall, 0);
  assert.equal(refundedBody.redeemedBy, user.user.id);
  assert.equal(credits.balance(user.user.id).balance, 72, "收回后余额回到兑换前");
  // 作废请求体带未知字段必须被拒绝，不能静默忽略。
  const unknownField = await fetch(base + "/api/v1/redeem-codes/" + encodeURIComponent(refundCode.codeId) + "/void", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ reclaim: true, force: true }) });
  assert.equal(unknownField.status, 400);
  // 已作废的码重复调用幂等。
  const refundReplay = await (await fetch(base + "/api/v1/redeem-codes/" + encodeURIComponent(refundCode.codeId) + "/void", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).json() as { alreadyVoid: boolean; reclaimed: number; shortfall: number };
  assert.equal(refundReplay.alreadyVoid, true);
  assert.equal(refundReplay.reclaimed, 0);
  assert.equal(refundReplay.shortfall, 0);

  // 余额不足：扣到 0 照样作废，缺口在 shortfall 返回（不拒绝、不要求先充值）。
  const poorBatch = credits.createBatch({ batchId: "batch-poor-http", name: "余额不足 HTTP", faceValue: 100, count: 1 });
  credits.redeem(user.user.id, poorBatch.codes[0]);
  h.store.applyCreditDelta({ userId: user.user.id, delta: -h.store.creditAccount(user.user.id)!.balance + 25, kind: "admin_adjust", idempotencyKey: "drain-poor", note: "测试消耗" });
  assert.equal(credits.balance(user.user.id).balance, 25);
  const poorCode = (await (await fetch(base + "/api/v1/redeem-batches/batch-poor-http/codes")).json() as { codes: Array<{ codeId: string }> }).codes[0];
  const poorResponse = await fetch(base + "/api/v1/redeem-codes/" + encodeURIComponent(poorCode.codeId) + "/void", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  assert.equal(poorResponse.status, 200, "余额不足不能阻止作废");
  const poorBody = await poorResponse.json() as { reclaimed: number; shortfall: number; status: string };
  assert.equal(poorBody.status, "void");
  assert.equal(poorBody.reclaimed, 25);
  assert.equal(poorBody.shortfall, 75);
  assert.equal(credits.balance(user.user.id).balance, 0, "扣到 0 为止，不产生负余额");
  assert.deepEqual(h.store.creditIntegrity().mismatches, []);
});
