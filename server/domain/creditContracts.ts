import * as z from "zod/v4";
import { id } from "../ai/schemas.js";
import { hasAtMostTwoDecimals } from "./creditUnits.js";

/** 积分账本条目：不可变流水，唯一事实来源；账户余额是它的物化值，同事务更新。
 *  cdk_refund 是「作废已兑换卡密时收回面值」的负向流水，与 cdk_redeem 成对出现。 */
export type CreditEntryKind = "cdk_redeem" | "cdk_refund" | "admin_grant" | "admin_adjust" | "run_reserve" | "run_settle";
export interface CreditEntry {
  entryId: string;
  userId: string;
  delta: number;
  balanceAfter: number;
  kind: CreditEntryKind;
  refType?: string;
  refId?: string;
  idempotencyKey: string;
  actorUserId?: string;
  note?: string;
  createdAt: string;
}
export interface CreditAccountRow { userId: string; balance: number; revision: number; updatedAt: string }

export type RedeemCodeStatus = "unused" | "redeemed" | "void";
export interface RedeemBatch {
  batchId: string;
  name: string;
  faceValue: number;
  codeCount: number;
  expiresAt?: string;
  createdBy?: string;
  createdAt: string;
  note?: string;
  /** 绑定的服务（包）ID：用这张卡登录后直接进入该服务。 */
  packageId?: string;
}
export interface RedeemCode {
  codeId: string;
  batchId: string;
  codeHash: string;
  /** 明文末四位，供人工核对；完整明文见 codePlain。 */
  codeHint: string;
  /** 完整卡密明文（管理员读接口可回读）；旧批次没有该列值时缺失，表示不可回读。 */
  codePlain?: string;
  faceValue: number;
  status: RedeemCodeStatus;
  redeemedBy?: string;
  redeemedAt?: string;
  redeemEntryId?: string;
  /** 作废时间与操作人；旧行或从未作废时缺失。 */
  voidedAt?: string;
  voidedBy?: string;
  /** 作废已兑换码时写入账本的回收流水 ID。 */
  refundEntryId?: string;
  /** 作废时实际从兑换人账户收回的积分；0 表示只作废未退分（reclaim=false 或未兑换码），缺失表示旧行未记录。 */
  reclaimedFaceValue?: number;
  expiresAt?: string;
  createdAt: string;
  /** 所属批次绑定的服务；没有绑定时用户登录后自己挑。 */
  packageId?: string;
}

export const creditLedgerQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.string().min(1).max(4000).optional(),
}).strict();
export type CreditLedgerQuery = z.output<typeof creditLedgerQuery>;

export const redeemCodeRequest = z.object({
  code: z.string().trim().min(8).max(128),
}).strict();

export const adjustUserCredits = z.object({
  userId: id,
  revision: z.int().nonnegative(),
  delta: z.int().min(-1_000_000).max(1_000_000).refine(value => value !== 0, "调整数量不能为 0"),
  note: z.string().trim().min(1).max(200),
}).strict();

export const createRedeemBatch = z.object({
  batchId: id,
  name: z.string().trim().min(1).max(160),
  faceValue: z.number().min(0.01).max(1_000_000).refine(hasAtMostTwoDecimals, "面值最多两位小数"),
  count: z.int().min(1).max(500),
  expiresAt: z.string().datetime().optional(),
  note: z.string().trim().max(500).optional(),
  packageId: id.optional().describe("绑定服务（包）ID：用这张卡登录后直接进入该服务；省略时用户登录后自己挑"),
}).strict();

export const redeemCodeKey = z.object({ codeId: id }).strict();

/** 批次键：批次明细与整批作废共用。 */
export const redeemBatchKey = z.object({ batchId: id }).strict();

/** 作废请求体：省略 reclaim 时按 true（退款场景默认收回面值）。 */
export const voidRedeemCodeRequest = z.object({
  reclaim: z.boolean().default(true).describe("已兑换的码是否从兑换人账户收回面值；默认 true。false 表示只作废不退分（例如线下已退款）"),
}).strict();

export const voidRedeemBatchRequest = z.object({
  reclaim: z.boolean().default(true).describe("true 时连已兑换的码一并作废并逐张收回面值；默认 true。未使用的码无论取值都会被作废"),
  includeRedeemed: z.boolean().default(true).describe("是否把已兑换的码纳入本次作废范围；默认 true。false 等同旧行为（只作废未使用的）"),
}).strict();

/** 兑换码正则化：去空白与连字符、统一大写；哈希才对规范化结果计算。 */
export function normalizeRedeemCode(code: string) {
  return code.replace(/[\s-]/g, "").toUpperCase();
}

/** 积分计费的机器契约：口径、时序、幂等与错误码的唯一事实来源。 */
export const CREDIT_CONTRACT = {
  version: "1",
  unit: "credits（服务定价单位，不是上游成本镜像：上游不回传 token 账单与 GPU 秒数）",
  precision: "金额最多两位小数；内部一律用「厘」整数（1 分 = 100 厘）做加减乘，只在接口与界面边界换算成分。单价、基础分、面值与调账数量超出两位小数在写入前被拒绝，不静默截断；余额、流水、预扣、结算与对账合计都不带浮点尾数。",
  pricingSource: "场景草稿 scene.pricing → 发布快照固化 → 运行提交时随 credit.pricing 固化",
  billableSteps: "hermes / comfyui（不含纯拼接 media.video_concat）/ core.http_request / core.llm；给本地步骤定价在发布校验被拒绝",
  units: { per_call: "每次调用计一次", per_item: "按成功项计；逐项来源为前序步骤输出时必须声明 maxItems 作为预估上限" },
  timing: {
    reserve: "submit 按上限价预扣，幂等键 run_reserve:<runId>；余额不足 402 CREDIT_INSUFFICIENT 且不进入队列；提交被拒绝时全额释放",
    settle: "运行到终态按实际成功产出结算，幂等键 run_settle:<runId>；差额按该运行自己的预扣金额退还（release 也走同一入口，全额退）",
    packageSettle: "包运行终态按已完成项的上限价结算，其余退还；幂等键 run_settle:<packageRunId>；charged ≤ 包预扣价",
    review: "waiting 不是终态、不结算；approve/redo 不二次收费（同一份预扣内）",
    resumeOrRerun: "新建运行并按来源运行固化的 pricing 重新预扣；复用步骤与逐项不重复计费（reusedFromRunId）",
  },
  charged: {
    included: "completed 的步骤（per_call）与 completed 的逐项（per_item）",
    excluded: "failed / skipped / cancelled / 复用项 / 缺失步骤",
    cap: "charged ≤ 预扣价；永不事后补扣",
  },
  ledger: {
    appendOnly: "credit_entries；余额 credit_accounts 是它的物化值，同一事务更新",
    kinds: ["cdk_redeem", "cdk_refund", "admin_grant", "admin_adjust", "run_reserve", "run_settle"],
    available: "available = balance；预扣已扣进 balance，reserved 只作对账不二次扣减",
  },
  redeem: {
    plaintext: "明文写入本机 SQLite，管理员可随时经 list_redeem_codes 回读；哈希与末四位继续保留，兑换校验走 sha256",
    idempotent: "同码重复提交返回 alreadyRedeemed，不重复加分",
    enumeration: "他人已用 / 不存在 / 已作废统一返回 REDEEM_CODE_INVALID",
    void: "单向幂等。未使用的码直接作废；已兑换的码也可作废（退款场景）：默认 reclaim=true 时按面值从兑换人账户收回，写一条 cdk_refund 负向流水（幂等键 cdk_refund:<codeId>）。余额不足不拒绝作废：扣到余额为 0 为止，未收回的差额在 shortfall 里如实返回（永不产生负余额，也不要求先充值）。reclaim=false 只作废不退分。作废后该码按不存在处理，不能再次兑换",
    voidBatch: "默认 includeRedeemed=true：未使用的全部作废，已兑换的逐张按 reclaim 收回，同样扣到余额为 0 为止；缺口合计在 shortfall、逐张缺口在 partial 里列出，不中断其余张。includeRedeemed=false 保留旧行为，只作废未使用的",
  },
  quota: {
    perUser: "ZANE_MAX_ACTIVE_RUNS_PER_USER（默认 0=不限制；排队+执行+等待审核都占用），超出 429 USER_RUN_LIMIT_REACHED",
    global: "ZANE_MAX_ACTIVE_RUNS 仍然生效",
  },
  outOfScope: ["管理员提交的运行", "历史运行（无定价记录，不补扣）", "积分表不进发布快照（快照只固化 pricing 规则）"],
} as const;
