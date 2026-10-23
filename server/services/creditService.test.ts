import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SqliteStore } from "../storage/sqliteStore.js";
import { CreditService } from "./creditService.js";
import { planSceneCost, settleCreditPlan, validateScenePricing, toUnits, fromUnits, formatPoints, hasAtMostTwoDecimals, parseScenePricing, type ScenePricing } from "../domain/scenePricing.js";
import { createRedeemBatch } from "../domain/creditContracts.js";
import type { RunRecord, RunStep } from "../domain/types.js";
import { HttpError } from "../errors.js";

async function withStore<T>(run: (store: SqliteStore) => Promise<T> | T): Promise<T> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "zane-credit-"));
  const store = new SqliteStore(path.join(directory, "zane.db"));
  try { return await run(store); }
  finally { store.close(); await rm(directory, { recursive: true, force: true }); }
}

const workflow = (steps: RunStep[]) => ({ inputs: [{ key: "items", type: "text" }], steps, outputs: [] }) as unknown as import("../domain/types.js").RunWorkflowDefinition;
const runRecord = (steps: RunRecord["steps"], runId = "11111111-1111-4111-8111-111111111111"): RunRecord => ({ runId, sceneId: "demo", workflowName: "demo", status: "completed", createdAt: new Date().toISOString(), startedAt: new Date().toISOString(), steps, outputs: [], artifacts: { directory: "", inputs: "", workflow: "", runtime: "", output: "" }, inputValues: {}, workflow: { inputs: [], steps: [], outputs: [] } });

test("积分账本：入账、扣减、幂等与余额不为负", async () => {
  await withStore(store => {
    const credits = new CreditService(store);
    const userId = "user-1";
    const grant = store.applyCreditDelta({ userId, delta: 100, kind: "admin_grant", idempotencyKey: "grant-1", note: "测试" });
    assert.equal(grant.applied, true);
    assert.equal(credits.balance(userId).balance, 100);

    // 同一幂等键重复调用：返回既有条目，余额不变。
    const replay = store.applyCreditDelta({ userId, delta: 100, kind: "admin_grant", idempotencyKey: "grant-1" });
    assert.equal(replay.applied, false);
    assert.equal(credits.balance(userId).balance, 100);

    // 余额不足：不落账、不出现负余额。
    const overdraft = store.applyCreditDelta({ userId, delta: -200, kind: "run_reserve", idempotencyKey: "reserve-x" });
    assert.equal(overdraft.applied, false);
    assert.ok("insufficient" in overdraft);
    assert.equal(credits.balance(userId).balance, 100);

    // 账本自检：余额 == 流水累计。
    assert.deepEqual(store.creditIntegrity().mismatches, []);
    assert.deepEqual(store.creditIntegrity(userId).mismatches, []);
  });
});

test("预扣与结算：失败/跳过/取消退还，成功项计费，charged 不超过预扣", async () => {
  await withStore(store => {
    const credits = new CreditService(store);
    const userId = "user-2";
    store.applyCreditDelta({ userId, delta: 1000, kind: "admin_grant", idempotencyKey: "g" });
    const plan = { pricingVersion: 1, base: 10, total: 10 + 5 + 3 * 20, steps: { llm: { unit: "per_call" as const, credits: 5, units: 1 }, shots: { unit: "per_item" as const, credits: 20, units: 3 } } };

    credits.reserve(userId, "run-a", plan);
    const reserved = credits.balance(userId);
    assert.equal(reserved.balance, 1000 - plan.total);
    assert.equal(reserved.reserved, plan.total);
    assert.equal(reserved.available, reserved.balance - plan.total);

    // 2/3 张图成功、文本步骤成功：只收 base + llm + 2 张。
    const run = { ...runRecord([
      { stepId: "llm", name: "llm", status: "completed" },
      { stepId: "shots", name: "shots", status: "completed_with_errors", items: [
        { index: 0, value: 0, status: "completed" }, { index: 1, value: 1, status: "completed" }, { index: 2, value: 2, status: "failed" },
      ] },
    ], "run-a"), ownerUserId: userId, credit: { plan } } as RunRecord;
    const settlement = credits.settle(run);
    assert.ok(settlement);
    assert.equal(settlement.charged, 10 + 5 + 40);
    assert.equal(settlement.refunded, plan.total - 55);
    assert.equal(credits.balance(userId).balance, 1000 - 55);
    assert.equal(credits.balance(userId).reserved, 0);

    // 重复结算不重复退款：幂等键保证第二次只是回读既有条目，余额不变。
    const replayRun = { ...run, credit: { plan, settlement } } as RunRecord;
    assert.equal(credits.settle(replayRun), undefined);
    assert.equal(credits.balance(userId).balance, 1000 - 55);
    assert.deepEqual(store.creditIntegrity().mismatches, []);
  });
});

test("结算：整步跳过与复用步骤不计费，取消的运行只收已完成部分", async () => {
  const plan = { pricingVersion: 1, base: 0, total: 5 + 20, steps: { llm: { unit: "per_call" as const, credits: 5, units: 1 }, shots: { unit: "per_item" as const, credits: 20, units: 1 } } };
  const skipped = settleCreditPlan(runRecord([
    { stepId: "llm", name: "llm", status: "skipped" },
    { stepId: "shots", name: "shots", status: "completed", items: [{ index: 0, value: 0, status: "completed" }] },
  ]), plan);
  assert.equal(skipped.charged, 20);
  assert.equal(skipped.refunded, 5);

  const reused = settleCreditPlan(runRecord([
    { stepId: "llm", name: "llm", status: "completed", reusedFromRunId: "22222222-2222-4222-8222-222222222222" },
    { stepId: "shots", name: "shots", status: "completed", items: [{ index: 0, value: 0, status: "completed", reusedFromRunId: "22222222-2222-4222-8222-222222222222" }] },
  ]), plan);
  assert.equal(reused.charged, 0);
  assert.equal(reused.refunded, 25);
});

test("上限价：逐项来源按输入长度计算，前序来源用 maxItems 封顶", () => {
  const pricing: ScenePricing = { version: 1, base: 5, steps: {
    writer: { unit: "per_call", credits: 2 },
    shots: { unit: "per_item", credits: 10, maxItems: 4 },
  } };
  const workflowValue = workflow([
    { id: "writer", name: "writer", kind: "hermes" },
    { id: "shots", name: "shots", kind: "comfyui", execution: { mode: "for_each", sourceRef: "step.writer.outputs.shots" } },
  ]);
  const plan = planSceneCost(pricing, workflowValue, {});
  assert.equal(plan.total, 5 + 2 + 40);
  assert.equal(plan.steps.shots.units, 4);
  assert.equal(plan.steps.shots.capped, true);

  const inputSourced = workflow([
    { id: "writer", name: "writer", kind: "hermes" },
    { id: "shots", name: "shots", kind: "comfyui", execution: { mode: "for_each", sourceRef: "input.items" } },
  ]);
  const sized = planSceneCost(pricing, inputSourced, { items: ["a", "b"] });
  assert.equal(sized.steps.shots.units, 2);
  assert.equal(sized.total, 5 + 2 + 20);
});

test("发布校验：只能给外部步骤定价，逐项前序来源必须声明 maxItems", () => {
  const flow = workflow([
    { id: "writer", name: "writer", kind: "hermes" },
    { id: "code", name: "code", kind: "capability", capabilityId: "core.code" },
    { id: "shots", name: "shots", kind: "comfyui", execution: { mode: "for_each", sourceRef: "step.writer.outputs.shots" } },
  ]);
  assert.doesNotThrow(() => validateScenePricing({ version: 1, base: 0, steps: { writer: { unit: "per_call", credits: 1 } } }, flow));
  assert.throws(() => validateScenePricing({ version: 1, base: 0, steps: { code: { unit: "per_call", credits: 1 } } }, flow), /只能为会调用外部服务的步骤定价/);
  assert.throws(() => validateScenePricing({ version: 1, base: 0, steps: { missing: { unit: "per_call", credits: 1 } } }, flow), /不存在的步骤/);
  assert.throws(() => validateScenePricing({ version: 1, base: 0, steps: { shots: { unit: "per_item", credits: 1 } } }, flow), /maxItems/);
  assert.doesNotThrow(() => validateScenePricing({ version: 1, base: 0, steps: { shots: { unit: "per_item", credits: 1, maxItems: 2 } } }, flow));
});

test("兑换：幂等、他人已用与无效码统一拒绝", async () => {
  await withStore(store => {
    const credits = new CreditService(store);
    const batch = credits.createBatch({ batchId: "batch-1", name: "首期", faceValue: 100, count: 2 });
    assert.equal(batch.codes.length, 2);
    assert.match(batch.codes[0], /^[0-9A-Z]{5}(-[0-9A-Z]{5}){3}$/);
    // 明文不落库：库里只有哈希与末四位。
    const stored = store.listRedeemCodes("batch-1");
    assert.equal(stored.length, 2);
    assert.equal(stored[0].codeHint, batch.codes[0].slice(-4));
    assert.equal(stored[0].codeHash.length, 64);
    assert.ok(!stored[0].codeHash.includes(batch.codes[0].replace(/-/g, "")));

    const first = credits.redeem("user-a", batch.codes[0]);
    assert.equal(first.redeemed, true);
    assert.equal(first.faceValue, 100);
    assert.equal(credits.balance("user-a").balance, 100);

    // 同一用户重复兑换：返回已兑换回执，不重复加分。
    const again = credits.redeem("user-a", batch.codes[0]);
    assert.equal(again.redeemed, false);
    assert.equal(again.alreadyRedeemed, true);
    assert.equal(credits.balance("user-a").balance, 100);

    // 他人已用 / 不存在：同一个错误码，防枚举。
    for (const code of [batch.codes[0], "ZZZZZ-ZZZZZ-ZZZZZ-ZZZZZ"]) {
      assert.throws(() => credits.redeem("user-b", code), (error: unknown) => error instanceof HttpError && ["REDEEM_CODE_USED", "REDEEM_CODE_INVALID"].includes(error.code));
    }
    assert.equal(credits.balance("user-b").balance, 0);

    // 未使用的码直接作废，且作废后不可兑换。
    const codes = store.listRedeemCodes("batch-1");
    const unused = codes.find(code => code.status === "unused")!;
    assert.equal(credits.voidCode(unused.codeId).status, "void");
    assert.throws(() => credits.redeem("user-c", batch.codes.find(code => code.slice(-4) === unused.codeHint)!), /无效/);
    assert.deepEqual(store.creditIntegrity().mismatches, []);
  });
});

test("发码幂等：同 batchId 重复提交返回原批次与同一份明文，不新建", async () => {
  await withStore(store => {
    const credits = new CreditService(store);
    const first = credits.createBatch({ batchId: "batch-idem", name: "首期", faceValue: 20, count: 2 });
    assert.equal(first.created, true);
    assert.equal(first.codes.length, 2);

    // 同参数重复提交：回执与首次一致，但 created=false，且库里仍只有 2 张码。
    const replay = credits.createBatch({ batchId: "batch-idem", name: "首期", faceValue: 20, count: 2 });
    assert.equal(replay.created, false);
    assert.deepEqual(replay.codes, first.codes);
    assert.equal(replay.batch.createdAt, first.batch.createdAt);
    assert.equal(store.listRedeemCodes("batch-idem").length, 2);
    assert.equal(store.redeemBatchList().filter(batch => batch.batchId === "batch-idem").length, 1);

    // 参数不同也以原批次为准，并点名差异；绝不悄悄改数据或补发。
    const conflict = credits.createBatch({ batchId: "batch-idem", name: "改了名", faceValue: 999, count: 5 });
    assert.equal(conflict.created, false);
    assert.equal(conflict.batch.name, "首期");
    assert.equal(conflict.batch.faceValue, 20);
    assert.equal(conflict.batch.codeCount, 2);
    assert.match(conflict.warning, /名称、面值、数量/);
    assert.equal(store.listRedeemCodes("batch-idem").length, 2);
    // 原明文仍可正常兑换。
    assert.equal(credits.redeem("user-idem", replay.codes[0]).redeemed, true);
  });
});

test("批次明细：逐张回读完整明文，未知批次 404", async () => {
  await withStore(store => {
    const credits = new CreditService(store);
    const batch = credits.createBatch({ batchId: "batch-detail", name: "明细", faceValue: 30, count: 3 });
    credits.redeem("user-x", batch.codes[0]);

    const detail = credits.listCodes("batch-detail");
    assert.equal(detail.codes.length, 3);
    assert.equal(detail.recoverable, true);
    assert.deepEqual(detail.counts, { unused: 2, redeemed: 1, voided: 0 });
    // 明文可随时回读，且与创建响应逐字一致。
    assert.deepEqual(detail.codes.map(code => code.code), batch.codes);
    const redeemed = detail.codes.find(code => code.status === "redeemed")!;
    assert.equal(redeemed.redeemedBy, "user-x");
    assert.ok(redeemed.redeemedAt);
    assert.equal(redeemed.codeHint, batch.codes[0].slice(-4));
    // 哈希仍然不对外暴露。
    assert.ok(!JSON.stringify(detail).includes("codeHash"));

    assert.throws(() => credits.listCodes("batch-missing"), (error: unknown) => error instanceof HttpError && error.code === "REDEEM_BATCH_NOT_FOUND");
  });
});

test("旧批次（明文列上线前）明确标记不可回读，不伪造明文", async () => {
  await withStore(store => {
    const credits = new CreditService(store);
    credits.createBatch({ batchId: "batch-legacy", name: "旧批", faceValue: 10, count: 2 });
    // 模拟升级前的数据：只有哈希与末四位，没有明文。
    (store as unknown as { database: { prepare(sql: string): { run(...args: unknown[]): unknown } } }).database
      .prepare("UPDATE redeem_codes SET code_plain = NULL WHERE batch_id = ?").run("batch-legacy");

    const detail = credits.listCodes("batch-legacy");
    assert.equal(detail.recoverable, false);
    for (const code of detail.codes) {
      assert.equal(code.recoverable, false);
      assert.equal(code.code, undefined, "不可回读时不能编造明文");
      assert.equal(code.codeHint.length, 4);
    }
    // 旧批次仍然可以正常作废。
    assert.equal(credits.voidBatch("batch-legacy").voided, 2);
  });
});

test("作废已兑换的卡：收回面值、写 cdk_refund 流水、幂等且作废后不可再兑换", async () => {
  await withStore(store => {
    const credits = new CreditService(store);
    const batch = credits.createBatch({ batchId: "batch-refund", name: "退款", faceValue: 40, count: 1 });
    credits.redeem("user-r", batch.codes[0]);
    assert.equal(credits.balance("user-r").balance, 40);

    const code = store.listRedeemCodes("batch-refund")[0];
    const voided = credits.voidCode(code.codeId, { actorId: "admin-1" });
    assert.equal(voided.status, "void");
    assert.equal(voided.alreadyVoid, false);
    assert.equal(voided.reclaimed, 40);
    assert.equal(voided.redeemedBy, "user-r");
    assert.equal(credits.balance("user-r").balance, 0, "面值必须真的从兑换人账户收回");

    // 账本：兑换与收回成对出现，余额仍等于流水累计。
    const kinds = credits.ledger("user-r", { limit: 20 }).items.map(item => item.kind);
    assert.deepEqual(kinds.sort(), ["cdk_redeem", "cdk_refund"]);
    assert.deepEqual(store.creditIntegrity().mismatches, []);

    // 码上记录了作废人、收回金额与流水 ID。
    const after = store.listRedeemCodes("batch-refund")[0];
    assert.equal(after.status, "void");
    assert.equal(after.voidedBy, "admin-1");
    assert.ok(after.voidedAt);
    assert.equal(after.reclaimedFaceValue, 40);
    assert.ok(after.refundEntryId);

    // 幂等：重复作废不再扣分。
    const replay = credits.voidCode(code.codeId, { actorId: "admin-1" });
    assert.equal(replay.alreadyVoid, true);
    assert.equal(replay.reclaimed, 0);
    assert.equal(credits.balance("user-r").balance, 0);

    // 作废后按不存在处理，不能再次兑换。
    assert.throws(() => credits.redeem("user-r", batch.codes[0]), (error: unknown) => error instanceof HttpError && error.code === "REDEEM_CODE_INVALID");
    assert.throws(() => credits.redeem("user-other", batch.codes[0]), (error: unknown) => error instanceof HttpError && error.code === "REDEEM_CODE_INVALID");
    assert.deepEqual(store.creditIntegrity().mismatches, []);
  });
});

test("作废已兑换的卡：余额不足就扣到 0 照样作废，缺口如实返回；reclaim=false 只作废不退分", async () => {
  await withStore(store => {
    const credits = new CreditService(store);
    const batch = credits.createBatch({ batchId: "batch-short", name: "余额不足", faceValue: 50, count: 2 });
    credits.redeem("user-s", batch.codes[0]);
    // 用户把积分花掉一部分，余额只剩 20。
    store.applyCreditDelta({ userId: "user-s", delta: -30, kind: "admin_adjust", idempotencyKey: "spend-s", note: "测试消耗" });
    assert.equal(credits.balance("user-s").balance, 20);

    const code = store.listRedeemCodes("batch-short").find(item => item.status === "redeemed")!;
    // 不拒绝、不要求先充值：扣到 0 为止，卡照常作废，差额明确返回。
    const voided = credits.voidCode(code.codeId);
    assert.equal(voided.status, "void");
    assert.equal(voided.reclaimed, 20);
    assert.equal(voided.shortfall, 30);
    assert.equal(voided.redeemedBy, "user-s");
    assert.match(voided.note ?? "", /余额不足/);
    assert.equal(credits.balance("user-s").balance, 0, "只扣到 0，不产生负余额");
    assert.equal(store.listRedeemCodes("batch-short").find(item => item.codeId === code.codeId)!.status, "void");
    assert.deepEqual(store.creditIntegrity().mismatches, []);

    // 重复调用幂等：不再扣分。
    const replay = credits.voidCode(code.codeId);
    assert.equal(replay.alreadyVoid, true);
    assert.equal(replay.reclaimed, 0);
    assert.equal(credits.balance("user-s").balance, 0);

    // reclaim=false：只让卡失效，不动余额。
    const batch2 = credits.createBatch({ batchId: "batch-no-reclaim", name: "不退分", faceValue: 50, count: 1 });
    credits.redeem("user-t", batch2.codes[0]);
    const plain = credits.voidCode(store.listRedeemCodes("batch-no-reclaim")[0].codeId, { reclaim: false });
    assert.equal(plain.status, "void");
    assert.equal(plain.reclaimed, 0);
    assert.equal(plain.shortfall, 50);
    assert.equal(credits.balance("user-t").balance, 50, "reclaim=false 不动余额");
    assert.deepEqual(store.creditIntegrity().mismatches, []);
  });
});

test("整批作废：默认含已兑换并逐张收回，余额不足的扣到 0 并列出缺口；includeRedeemed=false 退回旧行为", async () => {
  await withStore(store => {
    const credits = new CreditService(store);
    const batch = credits.createBatch({ batchId: "batch-void", name: "整批", faceValue: 10, count: 3 });
    credits.redeem("user-v", batch.codes[0]);
    credits.redeem("user-poor", batch.codes[1]);
    store.applyCreditDelta({ userId: "user-poor", delta: -10, kind: "admin_adjust", idempotencyKey: "spend-poor", note: "花光" });

    const first = credits.voidBatch("batch-void");
    // 三张全部作废：未用 1 张、余额充足 1 张、余额不足 1 张（扣到 0 并报缺口）。
    assert.equal(first.voided, 3);
    assert.equal(first.reclaimed, 10);
    assert.equal(first.shortfall, 10);
    assert.equal(first.partial?.length, 1);
    assert.equal(first.partial?.[0].shortfall, 10);
    assert.deepEqual(first.counts, { unused: 0, redeemed: 0, voided: 3 });
    assert.equal(credits.balance("user-v").balance, 0, "已兑换且余额足够的必须收回");
    assert.equal(credits.balance("user-poor").balance, 0, "余额不足的扣到 0，卡仍然作废");
    assert.match(first.note ?? "", /缺口/);
    assert.deepEqual(store.creditIntegrity().mismatches, []);

    // 重复调用：已作废的不再处理，不再扣分。
    const replay = credits.voidBatch("batch-void");
    assert.equal(replay.voided, 0);
    assert.equal(replay.reclaimed, 0);
    assert.equal(replay.shortfall, 0);
    assert.equal(replay.partial?.length ?? 0, 0);

    // includeRedeemed=false：只作废未使用的，已兑换保持有效。
    const batch2 = credits.createBatch({ batchId: "batch-legacy-behavior", name: "旧行为", faceValue: 10, count: 2 });
    credits.redeem("user-old", batch2.codes[0]);
    const legacy = credits.voidBatch("batch-legacy-behavior", { includeRedeemed: false });
    assert.equal(legacy.voided, 1);
    assert.equal(legacy.reclaimed, 0);
    assert.deepEqual(legacy.counts, { unused: 0, redeemed: 1, voided: 1 });
    assert.equal(credits.balance("user-old").balance, 10, "旧行为不回滚余额");
    assert.match(legacy.note ?? "", /includeRedeemed=false/);

    assert.throws(() => credits.voidBatch("batch-missing"), (error: unknown) => error instanceof HttpError && error.code === "REDEEM_BATCH_NOT_FOUND");
  });
});

test("调账：revision 保护，余额不能为负", async () => {
  await withStore(store => {
    const credits = new CreditService(store);
    const granted = credits.adjust({ userId: "user-d", revision: 0, delta: 50, note: "客服补偿" });
    assert.equal(granted.balance.balance, 50);
    assert.throws(() => credits.adjust({ userId: "user-d", revision: 0, delta: 10, note: "旧 revision" }), (error: unknown) => error instanceof HttpError && error.code === "CREDIT_REVISION_CONFLICT");
    assert.throws(() => credits.adjust({ userId: "user-d", revision: granted.balance.revision, delta: -100, note: "超额回收" }), (error: unknown) => error instanceof HttpError && error.code === "CREDIT_INSUFFICIENT");
    assert.equal(credits.balance("user-d").balance, 50);
  });
});

test("并发提交只够一次额度：一个成功，另一个 402，余额不为负", async () => {
  await withStore(store => {
    const credits = new CreditService(store);
    store.applyCreditDelta({ userId: "user-e", delta: 30, kind: "admin_grant", idempotencyKey: "g-e" });
    const plan = { pricingVersion: 1, base: 0, total: 30, steps: { llm: { unit: "per_call" as const, credits: 30, units: 1 } } };
    credits.reserve("user-e", "run-e1", plan);
    assert.throws(() => credits.reserve("user-e", "run-e2", plan), (error: unknown) => error instanceof HttpError && error.code === "CREDIT_INSUFFICIENT" && error.details?.shortfall === 30);
    assert.equal(credits.balance("user-e").balance, 0);
  });
});

test("提交被拒时预扣真正退还（不是只写一条 0 金额流水）", async () => {
  await withStore(store => {
    const credits = new CreditService(store);
    const userId = "user-release";
    store.applyCreditDelta({ userId, delta: 100, kind: "admin_grant", idempotencyKey: "g-release" });
    const plan = { pricingVersion: 1, base: 0, total: 40, steps: { llm: { unit: "per_call" as const, credits: 40, units: 1 } } };
    credits.reserve(userId, "run-release", plan);
    assert.equal(credits.balance(userId).balance, 60);
    assert.equal(credits.balance(userId).reserved, 40);

    credits.release(userId, "run-release", "提交被业务拒绝");
    assert.equal(credits.balance(userId).balance, 100, "预扣必须真的退回余额");
    assert.equal(credits.balance(userId).reserved, 0);
    assert.deepEqual(store.creditIntegrity().mismatches, []);

    // 重复释放：幂等，不会多退。
    credits.release(userId, "run-release", "重复调用");
    assert.equal(credits.balance(userId).balance, 100);
  });
});

test("包级精确结算：只收已完成项，其余退还；重复结算不多退", async () => {
  await withStore(store => {
    const credits = new CreditService(store);
    const userId = "user-package";
    store.applyCreditDelta({ userId, delta: 200, kind: "admin_grant", idempotencyKey: "g-pkg" });
    // 包上限：项 a 5 分 + 项 b 7 分 = 12 分。
    const plan = { pricingVersion: 1, base: 0, total: 12, steps: {
      "a.step": { unit: "per_call" as const, credits: 5, units: 1 },
      "b.step": { unit: "per_call" as const, credits: 7, units: 1 },
    } };
    credits.reserve(userId, "pkg-run-1", plan);
    assert.equal(credits.balance(userId).balance, 188);

    // 只有 a 完成 → 收 5，退 7。
    const settled = credits.settlePackage(userId, "pkg-run-1", 5, 12);
    assert.equal(settled.charged, 5);
    assert.equal(settled.refunded, 7);
    assert.equal(credits.balance(userId).balance, 195);
    assert.equal(credits.balance(userId).reserved, 0);

    // 重复结算：幂等键挡住，不再退款。
    const replay = credits.settlePackage(userId, "pkg-run-1", 5, 12);
    assert.equal(replay.refunded, 7, "回执仍然报告应有退款额，但余额不变");
    assert.equal(credits.balance(userId).balance, 195);
    assert.deepEqual(store.creditIntegrity().mismatches, []);
  });
});

test("包级结算不会超过预扣：实扣大于上限时按上限收", async () => {
  await withStore(store => {
    const credits = new CreditService(store);
    const userId = "user-cap";
    store.applyCreditDelta({ userId, delta: 50, kind: "admin_grant", idempotencyKey: "g-cap" });
    credits.reserve(userId, "pkg-run-cap", { pricingVersion: 1, base: 0, total: 10, steps: { "a.s": { unit: "per_call" as const, credits: 10, units: 1 } } });
    const settled = credits.settlePackage(userId, "pkg-run-cap", 999, 10);
    assert.equal(settled.charged, 10);
    assert.equal(settled.refunded, 0);
    assert.equal(credits.balance(userId).balance, 40);
  });
});

test("对账：余额绕过账本、退款超预扣、漏结算都能被点名", async () => {
  await withStore(store => {
    const credits = new CreditService(store);
    // 正常账户：预扣后结算，对账健康。
    store.applyCreditDelta({ userId: "ok", delta: 100, kind: "admin_grant", idempotencyKey: "g-ok" });
    credits.reserve("ok", "run-ok", { pricingVersion: 1, base: 0, total: 30, steps: { s: { unit: "per_call", credits: 30, units: 1 } } });
    credits.release("ok", "run-ok", "取消");
    let report = credits.reconciliation();
    assert.equal(report.healthy, true);
    assert.equal(report.totals.reserved, 0);
    assert.equal(report.accounts.find(row => row.userId === "ok")?.balance, 100);

    // 漏结算：预扣后一直不结清 → reserved 不下降，被点名。
    store.applyCreditDelta({ userId: "stuck", delta: 100, kind: "admin_grant", idempotencyKey: "g-stuck" });
    credits.reserve("stuck", "run-stuck", { pricingVersion: 1, base: 0, total: 40, steps: { s: { unit: "per_call", credits: 40, units: 1 } } });
    report = credits.reconciliation();
    const stuck = report.accounts.find(row => row.userId === "stuck")!;
    assert.equal(stuck.reserved, 40);
    assert.equal(stuck.reservedRefs, 1);
    // 余额已经扣过预扣（100-40=60），available 再减去未结预扣 40 = 20：
    // 这正是「预扣占着但还没结清」的样子——对账要同时看 reserved 与 available。
    assert.equal(stuck.balance, 60);
    assert.equal(stuck.available, 20);
    assert.equal(report.totals.usersWithReserved, 1);

    // 绕过账本直接改余额 → 余额≠流水累计。
    store.applyCreditDelta({ userId: "drift", delta: 10, kind: "admin_grant", idempotencyKey: "g-drift" });
    // 用第二条 grant 制造"流水比余额多"的不一致（模拟有人手工改库）。
    store.applyCreditDelta({ userId: "drift", delta: 5, kind: "admin_grant", idempotencyKey: "g-drift-2" });
    // 直接改余额列（仅测试：模拟绕过账本的写入）。
    (store as unknown as { database: { prepare(sql: string): { run(...args: unknown[]): unknown } } }).database
      .prepare("UPDATE credit_accounts SET balance = balance - 5 WHERE user_id = ?").run("drift");
    report = credits.reconciliation();
    assert.equal(report.healthy, false);
    assert.ok(report.mismatchedBalances.some(row => row.userId === "drift"), "余额与流水不一致必须被点名");

    // 退款超过预扣 → overRefunded 点名。
    store.applyCreditDelta({ userId: "over", delta: 100, kind: "admin_grant", idempotencyKey: "g-over" });
    credits.reserve("over", "run-over", { pricingVersion: 1, base: 0, total: 10, steps: { s: { unit: "per_call", credits: 10, units: 1 } } });
    credits.release("over", "run-over", "第一次释放");
    credits.release("over", "run-over", "重复释放（幂等，不应多退）");
    report = credits.reconciliation();
    assert.equal(report.overRefunded.length, 0, "幂等释放不应产生超额退款");
    assert.equal(credits.balance("over").balance, 100);
  });
});

test("小数定价：0.05 分按厘精确结算，不产生浮点误差", async () => {
  await withStore(store => {
    const credits = new CreditService(store);
    const userId = "user-cent";
    store.applyCreditDelta({ userId, delta: 1, kind: "admin_grant", idempotencyKey: "g-cent" });
    // 0.05 分 × 3 次调用：浮点会得到 0.15000000000000002，厘域必须是 15 厘 = 0.15 分。
    const plan = planSceneCost({ version: 1, base: 0, steps: { gen: { unit: "per_call", credits: 0.05 } } }, {
      inputs: [], outputs: [], steps: [{ id: "gen", name: "gen", kind: "hermes" }],
    } as never, {});
    assert.equal(plan.total, 0.05);
    assert.equal(toUnits(plan.total), 5);

    credits.reserve(userId, "run-cent", plan);
    assert.equal(credits.balance(userId).balance, 0.95);
    assert.equal(credits.balance(userId).reserved, 0.05);

    const run = { ...runRecord([{ stepId: "gen", name: "gen", status: "completed" }], "run-cent"), ownerUserId: userId, credit: { plan } } as RunRecord;
    const settlement = credits.settle(run);
    assert.equal(settlement?.charged, 0.05);
    assert.equal(settlement?.refunded, 0);
    assert.equal(credits.balance(userId).balance, 0.95);
    assert.deepEqual(store.creditIntegrity().mismatches, []);

    // 余额不足判定也按厘：把余额花到 0.04 分后，0.05 分的单价就付不起。
    store.applyCreditDelta({ userId, delta: -0.91, kind: "admin_adjust", idempotencyKey: "g-cent-drain" });
    assert.equal(credits.balance(userId).balance, 0.04);
    assert.throws(
      () => credits.reserve(userId, "run-cent-2", plan),
      (error: unknown) => error instanceof HttpError && error.code === "CREDIT_INSUFFICIENT" && Math.abs(Number(error.details?.shortfall ?? 0) - 0.01) < 1e-9,
    );
    assert.equal(credits.balance(userId).balance, 0.04);
  });
});

test("金额格式化：对外两位小数、去掉多余的零", () => {
  assert.equal(formatPoints(0.05), "0.05");
  assert.equal(formatPoints(12), "12");
  assert.equal(formatPoints(12.5), "12.5");
  assert.equal(formatPoints(0), "0");
  assert.equal(formatPoints(0.30000000000000004), "0.3");
  assert.equal(formatPoints(-0.05), "-0.05");
  assert.equal(toUnits(0.05), 5);
  assert.equal(fromUnits(5), 0.05);
});

test("精度回归：多笔小额乘加、余额减法与结算都不留浮点尾数", async () => {
  await withStore(store => {
    const credits = new CreditService(store);
    const userId = "user-precision";
    // 0.1 + 0.2 在浮点里是 0.30000000000000004；账本必须落在 0.3。
    store.applyCreditDelta({ userId, delta: 0.1, kind: "admin_grant", idempotencyKey: "p-1" });
    store.applyCreditDelta({ userId, delta: 0.2, kind: "admin_grant", idempotencyKey: "p-2" });
    assert.equal(credits.balance(userId).balance, 0.3);

    // 0.05 × 3 = 0.15000000000000002；计划价、预扣与流水都必须是 0.15。
    const plan = planSceneCost({ version: 1, base: 0, steps: { gen: { unit: "per_item", credits: 0.05, maxItems: 3 } } }, {
      inputs: [{ key: "items", type: "text" }], outputs: [], steps: [{ id: "gen", name: "gen", kind: "hermes", execution: { mode: "for_each", sourceRef: "input.items" } }],
    } as never, { items: ["a", "b", "c"] });
    assert.equal(plan.total, 0.15);
    assert.equal(plan.steps.gen.credits, 0.05);

    credits.reserve(userId, "run-precision", plan);
    assert.equal(credits.balance(userId).balance, 0.15);
    // 0.3 − 0.15 在浮点里是 0.14999999999999997：余额与占用都必须按厘相减。
    assert.equal(credits.balance(userId).reserved, 0.15);
    assert.equal(credits.balance(userId).available, 0, "预扣后余额正好被占用，可用为 0（不是 0.30000000000000004 这类尾数）");

    // 部分成功：3 项里成功 2 项 → 收 0.1，退 0.05，余额回到 0.2。
    const run = {
      ...runRecord([{ stepId: "gen", name: "gen", status: "completed_with_errors", items: [
        { index: 0, value: "a", status: "completed" }, { index: 1, value: "b", status: "completed" }, { index: 2, value: "c", status: "failed" },
      ] }], "run-precision"),
      ownerUserId: userId, credit: { plan },
    } as RunRecord;
    const settlement = credits.settle(run);
    assert.equal(settlement?.charged, 0.1);
    assert.equal(settlement?.refunded, 0.05);
    assert.equal(credits.balance(userId).balance, 0.2);
    assert.equal(credits.balance(userId).reserved, 0);

    // 流水与对账合计同样不带尾数。
    const ledger = credits.ledger(userId, { limit: 20 });
    assert.deepEqual(ledger.items.map(entry => entry.delta), [0.05, -0.15, 0.2, 0.1]);
    const report = credits.reconciliation();
    assert.equal(report.totals.balance, 0.2);
    assert.deepEqual(store.creditIntegrity().mismatches, []);
  });
});

test("精度校验：超出两位小数的单价、基础分与卡密面值在写入前被拒绝", async () => {
  // 0.145 与 1.005 在浮点乘 100 后是 14.4999…/100.4999…，旧判据会放行并静默截断。
  assert.equal(hasAtMostTwoDecimals(0.145), false);
  assert.equal(hasAtMostTwoDecimals(1.005), false);
  assert.equal(hasAtMostTwoDecimals(0.05), true);
  assert.equal(hasAtMostTwoDecimals(12.34), true);
  assert.equal(hasAtMostTwoDecimals(0.1 + 0.2), true, "二进制尾数不算第三位小数");
  assert.throws(() => parseScenePricing({ version: 1, base: 0, steps: { gen: { unit: "per_call", credits: 0.145 } } }), /最多两位小数/);
  assert.throws(() => parseScenePricing({ version: 1, base: 1.005, steps: {} }), /最多两位小数/);

  const batch = createRedeemBatch.safeParse({ batchId: "batch-precision", name: "精度", faceValue: 10.005, count: 1 });
  assert.equal(batch.success, false, "面值三位小数必须拒绝，不能四舍五入成另一个价格");
  assert.equal(createRedeemBatch.safeParse({ batchId: "batch-precision", name: "精度", faceValue: 10.05, count: 1 }).success, true);
});

test("调账响应：entry.delta/balanceAfter 与余额都是分，不是库里的厘", async () => {
  await withStore(store => {
    const credits = new CreditService(store);
    // 0.05 分入账：库里存 5 厘，对外必须是 0.05 分。
    const granted = credits.adjust({ userId: "user-entry", revision: 0, delta: 0.05, note: "补偿" });
    assert.equal(granted.entry.delta, 0.05);
    assert.equal(granted.entry.balanceAfter, 0.05);
    assert.equal(granted.balance.balance, 0.05);

    const ledger = credits.ledger("user-entry", { limit: 20 });
    assert.equal(ledger.items[0].delta, 0.05);
    assert.equal(ledger.items[0].balanceAfter, 0.05);
    assert.deepEqual(store.creditIntegrity().mismatches, []);
  });
});
