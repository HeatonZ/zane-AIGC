import { createHash, randomBytes } from "node:crypto";
import { HttpError } from "../errors.js";
import type { SqliteStore } from "../storage/sqliteStore.js";
import type { CreditLedgerQuery, RedeemBatch } from "../domain/creditContracts.js";
import { normalizeRedeemCode, type RedeemCode } from "../domain/creditContracts.js";
import type { RunCreditPlan, RunCreditRecord } from "../domain/scenePricing.js";
import { settleCreditPlan } from "../domain/scenePricing.js";
import { formatPoints, fromUnits, normalizePoints, toUnits } from "../domain/creditUnits.js";
import type { RunRecord } from "../domain/types.js";
import { log } from "../observability/logger.js";

/** 兑换码空间：20 字符 Crockford base32 ≈ 100 bit，无需额外盐即可安全哈希。 */
const CODE_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const CODE_LENGTH = 20;

function hashCode(code: string) {
  return createHash("sha256").update(normalizeRedeemCode(code)).digest("hex");
}
function newCode() {
  const bytes = randomBytes(CODE_LENGTH);
  let value = "";
  for (let index = 0; index < CODE_LENGTH; index += 1) value += CODE_ALPHABET[bytes[index] % CODE_ALPHABET.length];
  return value.match(/.{1,5}/g)!.join("-");
}

export interface CreditBalance { balance: number; reserved: number; available: number; revision: number }

/** 积分账户与兑换码的唯一业务入口；所有写入经 SqliteStore 的原子账本方法。 */
export class CreditService {
  /**
   * 卡密作废后的身份收敛钩子。由 index.ts 注入 AccessService，避免 CreditService 直接依赖账户服务；
   * 未注入时（测试或未接线）只作废卡，不改账户。用取值函数是因为 AccessService 在 index.ts 中
   * 晚于本服务创建，直接传实例会拿到 undefined。
   */
  constructor(readonly store: SqliteStore, private identity?: () => { suspendWithoutActiveCard(userId: string, actorId?: string): { suspended: boolean }; reactivateForCard(userId: string): { reactivated: boolean } } | undefined) {}

  /** 由 index.ts 在 AccessService 创建后接线；测试可省略，此时只作废卡、不改账户。 */
  bindIdentity(identity: { suspendWithoutActiveCard(userId: string, actorId?: string): { suspended: boolean }; reactivateForCard(userId: string): { reactivated: boolean } }) {
    this.identity = () => identity;
  }

  /** 兑换码对应的兑换人：作废时用来决定是否需要停用账户。 */
  private redeemedOwners(codeIds: string[]) {
    const owners = new Set<string>();
    for (const codeId of codeIds) {
      const code = this.store.redeemCodeById(codeId);
      if (code?.redeemedBy) owners.add(code.redeemedBy);
    }
    return owners;
  }

  /**
   * 余额三件套：账面、未结预扣、可用。
   *
   * 关键事实：`reserve()` 是真扣款（delta 为负，直接减 `balance`），预扣金额**已经**体现在
   * `balance` 里。所以 `available` 就是 `balance` 本身，不能再减一次 `reserved`——
   * 那会把同一笔预扣扣两遍：预扣 0.05 时页面显示少 0.10，结算后 reserved 归零又「回升」0.05，
   * 用户看到的就是「提交扣 0.1、跑完退 0.05」的假象。账本始终是对的，错的是这个派生值。
   *
   * `reserved` 仍然保留并如实返回：它是「有哪些预扣还没结清」的对账信号（reconciliation 用它
   * 点名漏结算的运行），只是不再参与可用余额的计算。
   */
  balance(userId: string): CreditBalance {
    const account = this.store.creditAccount(userId);
    const reserved = this.store.reservedCredits(userId).total;
    const balance = account?.balance ?? 0;
    return { balance, reserved, available: balance, revision: account?.revision ?? 0 };
  }

  /** 提交前预扣：上限价一次扣足；差额在结算时退还，永不事后补扣。 */
  reserve(userId: string, runId: string, plan: RunCreditPlan) {
    const total = normalizePoints(plan.total);
    if (total <= 0) return { reserved: 0 as const, balance: this.balance(userId) };
    const result = this.store.applyCreditDelta({ userId, delta: -total, kind: "run_reserve", idempotencyKey: "run_reserve:" + runId, refType: "run", refId: runId, note: "运行预扣上限 " + formatPoints(total) });
    if (!result.applied && "insufficient" in result) {
      const current = this.balance(userId);
      throw new HttpError(402, "积分不足：本次最多需要 " + formatPoints(total) + " 分，当前可用 " + formatPoints(current.available) + " 分", "CREDIT_INSUFFICIENT", {
        required: total, balance: current.balance, reserved: current.reserved, available: current.available, shortfall: fromUnits(Math.max(0, toUnits(total) - toUnits(current.available))), nextAction: "redeem_code",
      });
    }
    return { reserved: total as number, balance: this.balance(userId) };
  }

  /** 提交被业务拒绝时**全额退还**预扣：退回的金额来自该运行自己的预扣流水，
   *  因此不会多退（预扣可能因幂等重放而只发生过一次）。 */
  release(userId: string, runId: string, reason: string) {
    return this.settleReserved(userId, runId, 0, "提交未接受，预扣全额退还：" + reason);
  }

  /**
   * 按实际消耗结清一笔预扣：refund = 预扣金额 − 实扣。幂等键保证重复调用只结一次。
   * 这是单运行与包运行共用的唯一结算入口——两者都只能**退**，永不补扣。
   */
  private settleReserved(userId: string, refId: string, charged: number, note: string) {
    const reserved = this.store.reservedForRef(userId, refId);
    if (reserved <= 0) return { charged: 0, refunded: 0, reserved: 0 };
    const cappedUnits = Math.min(Math.max(0, toUnits(charged)), toUnits(reserved));
    const refundedUnits = toUnits(reserved) - cappedUnits;
    const result = this.store.applyCreditDelta({ userId, delta: fromUnits(refundedUnits), kind: "run_settle", idempotencyKey: "run_settle:" + refId, refType: "run", refId, note });
    return { charged: fromUnits(cappedUnits), refunded: fromUnits(refundedUnits), reserved, applied: result.applied };
  }

  /** 包运行结算：按已完成项计费，退还其余。charged 上限就是包预扣价。 */
  settlePackage(userId: string, packageRunId: string, charged: number, total: number) {
    const capped = fromUnits(Math.min(Math.max(0, toUnits(charged)), Math.max(0, toUnits(total))));
    const result = this.settleReserved(userId, packageRunId, capped, "包运行结算：实扣 " + formatPoints(capped) + "，退还 " + formatPoints(Math.max(0, toUnits(total) - toUnits(capped))));
    return { ...result, charged: capped, refunded: fromUnits(Math.max(0, toUnits(total) - toUnits(capped))) };
  }

  /** 终态结算：按步骤与逐项成功状态计费，退还未消耗部分。幂等键保证重复调用不重复结算。 */
  settle(run: RunRecord) {
    const credit = run.credit;
    if (!credit?.plan || !run.ownerUserId) return undefined;
    if (credit.settlement) return undefined;
    const settlement = settleCreditPlan(run, credit.plan);
    try {
      this.store.applyCreditDelta({ userId: run.ownerUserId, delta: settlement.refunded, kind: "run_settle", idempotencyKey: "run_settle:" + run.runId, refType: "run", refId: run.runId, note: "结算：实扣 " + formatPoints(settlement.charged) + "，退还 " + formatPoints(settlement.refunded) });
    } catch (error) {
      log("error", "credit.settle_failed", { runId: run.runId, userId: run.ownerUserId, error: String(error) });
      return undefined;
    }
    return settlement;
  }

  ledger(userId: string, query: CreditLedgerQuery) {
    let before: { createdAt: string; entryId: string } | undefined;
    if (query.cursor) {
      try {
        const decoded = JSON.parse(Buffer.from(query.cursor, "base64url").toString("utf8")) as { createdAt?: unknown; entryId?: unknown };
        if (typeof decoded.createdAt !== "string" || typeof decoded.entryId !== "string") throw new Error("bad cursor");
        before = { createdAt: decoded.createdAt, entryId: decoded.entryId };
      } catch { throw new HttpError(400, "积分流水分页游标无效", "INVALID_CREDIT_CURSOR"); }
    }
    const page = this.store.listCreditEntries(userId, { ...(before ? { before } : {}), limit: query.limit });
    return {
      items: page.entries,
      hasMore: Boolean(page.nextCursor),
      ...(page.nextCursor ? { nextCursor: Buffer.from(JSON.stringify(page.nextCursor)).toString("base64url") } : {}),
      balance: this.balance(userId),
      nextAction: page.nextCursor ? "read_more_entries" : "get_own_credits",
    };
  }

  /** 兑换：同码重复提交返回既有回执；不存在/已作废/他人已用返回同一错误，避免枚举。 */
  redeem(userId: string, code: string) {
    if (!code.trim()) throw new HttpError(400, "请输入兑换码", "INVALID_REDEEM_CODE");
    const result = this.store.redeemCode(hashCode(code), userId);
    if (result.status === "not_found") throw new HttpError(404, "兑换码无效", "REDEEM_CODE_INVALID");
    if (result.status === "expired") throw new HttpError(409, "兑换码已过期", "REDEEM_CODE_EXPIRED");
    if (result.status === "already") {
      if (result.code.redeemedBy !== userId) throw new HttpError(409, "兑换码已被使用", "REDEEM_CODE_USED");
      return { redeemed: false, alreadyRedeemed: true, faceValue: result.code.faceValue, redeemedAt: result.code.redeemedAt, balance: this.balance(userId), nextAction: "get_own_credits" };
    }
    // 兑换成功即恢复身份：此前因卡作废被停用的账户拿到新卡后可以继续使用。
    this.identity?.()?.reactivateForCard(userId);
    return { redeemed: true, alreadyRedeemed: false, faceValue: result.code.faceValue, redeemedAt: result.code.redeemedAt, balance: this.balance(userId), nextAction: "get_own_credits" };
  }

  /**
   * 发码是**幂等**的：同一个 batchId 重复提交直接返回既有批次与它的卡密明文，
   * created=false，不新建、不重复计费。这样回执丢失后重试、或误点两次都得到同一份结果。
   * 参数与既有批次不一致时仍按原批次返回，并在 warning 里点名差异，不悄悄改数据。
   */
  createBatch(input: { batchId: string; name: string; faceValue: number; count: number; expiresAt?: string; note?: string; packageId?: string }, actorId?: string) {
    const existing = this.store.redeemBatchList().find(batch => batch.batchId === input.batchId);
    if (existing) {
      const codes = this.store.listRedeemCodes(existing.batchId).map(code => code.codePlain).filter((code): code is string => Boolean(code));
      const differences = [
        existing.name !== input.name ? "名称" : "",
        existing.faceValue !== input.faceValue ? "面值" : "",
        existing.codeCount !== input.count ? "数量" : "",
      ].filter(Boolean);
      return {
        batch: existing, codes, created: false,
        recoverable: codes.length === existing.codeCount,
        warning: "批次 " + existing.batchId + " 已存在，返回原批次结果（未新建）。"
          + (differences.length ? "本次提交的" + differences.join("、") + "与既有批次不同，仍以原批次为准。" : "")
          + (codes.length < existing.codeCount ? "该批次创建于明文存储上线前，卡密明文不可回读。" : ""),
        nextAction: "list_redeem_codes",
      };
    }
    if (input.expiresAt && Date.parse(input.expiresAt) <= Date.now()) throw new HttpError(400, "有效期必须晚于当前时间", "INVALID_REDEEM_EXPIRY");
    const batch: RedeemBatch = { batchId: input.batchId, name: input.name, faceValue: input.faceValue, codeCount: input.count, ...(input.expiresAt ? { expiresAt: input.expiresAt } : {}), ...(actorId ? { createdBy: actorId } : {}), createdAt: new Date().toISOString(), ...(input.note ? { note: input.note } : {}), ...(input.packageId ? { packageId: input.packageId } : {}) };
    // 明文写入库中以便管理端随时回读（运营发放、客服核对）；哈希仍用于兑换校验。
    const plaintext = Array.from({ length: input.count }, () => newCode());
    this.store.insertRedeemBatch(batch, plaintext.map((code, index) => ({ codeId: input.batchId + "-" + String(index + 1).padStart(4, "0"), codeHash: hashCode(code), codeHint: code.slice(-4), codePlain: code })));
    return { batch, codes: plaintext, created: true, recoverable: true, warning: "卡密明文已保存，可随时在批次明细中回读；仍建议创建后立即下载一份留存。", nextAction: "list_redeem_codes" };
  }

  listBatches() { return { batches: this.store.redeemBatchList(), nextAction: "create_redeem_batch" }; }

  /**
   * 批次明细：逐张码的 ID、**完整明文**、状态与兑换人/时间，供运营发放与客服核对。
   * 旧批次（明文列上线前创建）没有明文，明确标记 recoverable=false 而不是回空串。
   */
  listCodes(batchId: string) {
    const batch = this.store.redeemBatchList().find(item => item.batchId === batchId);
    if (!batch) throw new HttpError(404, "卡密批次不存在", "REDEEM_BATCH_NOT_FOUND");
    const records = this.store.listRedeemCodes(batchId);
    const codes = records.map(code => ({
      codeId: code.codeId, codeHint: code.codeHint, status: code.status, faceValue: code.faceValue,
      ...(code.codePlain ? { code: code.codePlain } : {}),
      recoverable: Boolean(code.codePlain),
      ...(code.redeemedBy ? { redeemedBy: code.redeemedBy } : {}),
      ...(code.redeemedAt ? { redeemedAt: code.redeemedAt } : {}),
      ...(code.expiresAt ? { expiresAt: code.expiresAt } : {}),
      createdAt: code.createdAt,
    }));
    return {
      batch, codes,
      counts: { unused: batch.unused, redeemed: batch.redeemed, voided: batch.voided },
      /** 该批次是否还能回读明文；false 表示创建于明文存储上线前，只能作废重发。 */
      recoverable: records.every(code => Boolean(code.codePlain)),
      nextAction: batch.unused > 0 ? "void_redeem_code" : "list_redeem_batches",
    };
  }

  /**
   * 整批作废。默认把已兑换的码也纳入范围并逐张收回面值（退款场景）。
   * 余额不足的码照样作废，只扣到余额为 0，缺口合计在 shortfall 里报告。
   */
  voidBatch(batchId: string, options: { reclaim?: boolean; includeRedeemed?: boolean; actorId?: string } = {}) {
    const reclaim = options.reclaim !== false;
    const includeRedeemed = options.includeRedeemed !== false;
    // 先记下受影响账户，再作废：作废后 code.redeemedBy 仍保留，但这里提前取更直接。
    const owners = this.redeemedOwners(this.store.listRedeemCodes(batchId).filter(code => code.status === "redeemed").map(code => code.codeId));
    const result = this.store.voidRedeemBatch(batchId, { reclaim, includeRedeemed, ...(options.actorId ? { actorUserId: options.actorId } : {}) });
    if (result.status === "not_found") throw new HttpError(404, "卡密批次不存在", "REDEEM_BATCH_NOT_FOUND");
    const suspendedUsers = this.suspendWithoutActiveCard(owners, options.actorId);
    const partial = result.partial ?? [];
    const shortfall = result.shortfall ?? 0;
    return {
      batchId, voided: result.voided, reclaimed: result.reclaimed ?? 0, shortfall, counts: result.counts,
      ...(partial.length ? { partial } : {}),
      ...(suspendedUsers.length ? { suspendedUsers } : {}),
      note: shortfall > 0
        ? "已全部作废；其中 " + partial.length + " 张因余额不足未收回全款，合计缺口 " + formatPoints(shortfall) + " 分（已扣至余额为 0）"
        : !includeRedeemed && result.counts.redeemed > 0
          ? "已兑换的 " + result.counts.redeemed + " 张按 includeRedeemed=false 保持有效；如需退款作废请传 includeRedeemed=true"
          : undefined,
      nextAction: "list_redeem_codes",
    };
  }

  /** 单张作废。已兑换的码默认按面值收回，扣到余额为 0 为止，缺口如实返回。 */
  voidCode(codeId: string, options: { reclaim?: boolean; actorId?: string } = {}) {
    const reclaim = options.reclaim !== false;
    const owners = this.redeemedOwners([codeId]);
    const result = this.store.voidRedeemCode(codeId, { reclaim, ...(options.actorId ? { actorUserId: options.actorId } : {}) });
    if (result.status === "not_found") throw new HttpError(404, "兑换码不存在", "REDEEM_CODE_NOT_FOUND");
    const suspendedUsers = this.suspendWithoutActiveCard(owners, options.actorId);
    const shortfall = result.shortfall ?? 0;
    return {
      codeId, status: "void" as const, alreadyVoid: result.status === "void",
      reclaimed: result.reclaimed ?? 0, shortfall,
      ...(result.code.redeemedBy ? { redeemedBy: result.code.redeemedBy } : {}),
      ...(suspendedUsers.length ? { suspendedUsers } : {}),
      ...(shortfall > 0 ? { note: "兑换人余额不足，已扣至余额为 0；未收回 " + formatPoints(shortfall) + " 分" } : {}),
      nextAction: "list_redeem_batches",
    };
  }

  /** 卡作废后停用不再持有有效卡的用户；返回真正被停用的用户ID。 */
  private suspendWithoutActiveCard(owners: ReadonlySet<string>, actorId?: string) {
    const identity = this.identity?.();
    if (!identity || !owners.size) return [] as string[];
    const suspended: string[] = [];
    for (const userId of owners) if (identity.suspendWithoutActiveCard(userId, actorId).suspended) suspended.push(userId);
    return suspended;
  }

  adjust(input: { userId: string; revision: number; delta: number; note: string }, actorId?: string, authorize?: () => void) {
    authorize?.();
    const account = this.store.creditAccount(input.userId);
    if ((account?.revision ?? 0) !== input.revision) throw new HttpError(409, "积分账户已变化，请重新读取", "CREDIT_REVISION_CONFLICT", { currentRevision: account?.revision ?? 0 });
    const result = this.store.applyCreditDelta({ userId: input.userId, delta: input.delta, kind: input.delta > 0 ? "admin_grant" : "admin_adjust", idempotencyKey: "admin_adjust:" + randomBytes(12).toString("hex"), refType: "user", refId: input.userId, ...(actorId ? { actorUserId: actorId } : {}), note: input.note });
    if (!result.applied && "insufficient" in result) throw new HttpError(409, "调整后余额不能为负", "CREDIT_INSUFFICIENT", { balance: this.balance(input.userId).balance });
    return { entry: result.entry, balance: this.balance(input.userId), nextAction: "get_user" };
  }

  /**
   * 账本对账（只读）：余额 vs 流水累计 vs 未结算预扣。这是"上一个 bug 发现不了"的解药——
   * 结算写错时余额与流水仍然一致（都错），所以必须同时看 reserved 与 overRefunded。
   * 只报告事实与计数，不自动修复：修复必须由人决定。
   */
  reconciliation() {
    const report = this.store.creditReconciliation();
    return {
      ...report,
      healthy: report.mismatchedBalances.length === 0 && report.overRefunded.length === 0,
      interpretation: {
        balanceMatchesLedger: "余额是流水的物化值，不一致说明有人绕过账本直接改余额",
        reserved: "已预扣但尚未结清的单据合计；长期不下降说明漏结算（例如运行终态没有触发结算）",
        overRefunded: "同一单据的退款超过预扣，只有手工改库或代码缺陷才会出现",
      },
      nextAction: report.mismatchedBalances.length || report.overRefunded.length ? "inspect_credit_ledger" : "get_own_credits",
    };
  }

  /** 结算所需的运行记录字段：只在有定价时才需要。 */
  static creditRecord(plan: RunCreditPlan): RunCreditRecord { return { plan }; }
}

export type { RedeemCode };
