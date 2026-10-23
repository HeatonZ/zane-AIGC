import { createHash, randomBytes, randomUUID } from "node:crypto";
import { HttpError } from "../errors.js";
import type { SqliteStore } from "../storage/sqliteStore.js";
import { normalizeRedeemCode } from "../domain/creditContracts.js";
import { log } from "../observability/logger.js";

/**
 * CDK 登录：卡即身份。
 *
 * - 第一次用一张未使用的卡：建一个账户、把卡绑定到该账户、把面值充进余额、补齐默认包授权。
 * - 同一张卡再来：回到同一个账户，历史、余额、任务都在。
 * - 已绑定给别人的卡：拒绝，不泄露该卡属于谁。
 *
 * 账号本身不是用户需要理解的概念：用户名/密码由服务端生成，用户只需要保管卡密。
 * 管理端仍用账号密码登录私有入口，两者互不影响。
 */
export interface CdkIdentity {
  userId: string;
  cardId: string;
  created: boolean;
  faceValue: number;
  notice: string;
  /** 卡绑定的服务：前端直接跳到它，不再让用户挑。 */
  packageId?: string;
}

const hash = (text: string) => createHash("sha256").update(text).digest("hex");

export class CdkLoginService {
  constructor(
    private readonly store: SqliteStore,
    private readonly createAccount: (input: { userId: string; username: string; displayName: string; password: string }) => Promise<{ id: string; revision: number }>,
    private readonly grantPackages: (userId: string, revision: number, packageIds: string[]) => Promise<unknown>,
    private readonly defaultPackageIds: () => string[],
  ) {}

  /** 只读：这张卡是新卡（可以直接开始）还是老卡（会回到原账户）？ */
  inspect(code: string) {
    const record = this.store.redeemCodeByHash(hash(normalizeRedeemCode(code)));
    if (!record) throw new HttpError(404, "卡密无效", "REDEEM_CODE_INVALID");
    if (record.status === "void") throw new HttpError(404, "卡密无效", "REDEEM_CODE_INVALID");
    if (record.expiresAt && record.expiresAt <= new Date().toISOString()) throw new HttpError(409, "卡密已过期", "REDEEM_CODE_EXPIRED");
    return {
      known: record.status === "redeemed",
      faceValue: record.faceValue,
      // 不返回绑定给了谁：那属于账号隐私。
      hint: record.codeHint,
      ...(record.packageId ? { packageId: record.packageId } : {}),
    };
  }

  /**
   * 用卡登录。mustCreate=false 时老卡直接回到原账户；true 时只接受新卡（用于「第一次使用」的显式路径）。
   * 幂等：同一张卡并发登录只会建一个账户（卡状态在事务里单向转换）。
   */
  async login(code: string, options: { displayName?: string } = {}): Promise<CdkIdentity> {
    const normalized = normalizeRedeemCode(code);
    if (!normalized) throw new HttpError(400, "请输入卡密", "INVALID_REDEEM_CODE");
    const digest = hash(normalized);
    const record = this.store.redeemCodeByHash(digest);
    if (!record || record.status === "void") throw new HttpError(404, "卡密无效", "REDEEM_CODE_INVALID");
    if (record.expiresAt && record.expiresAt <= new Date().toISOString()) throw new HttpError(409, "卡密已过期", "REDEEM_CODE_EXPIRED");

    if (record.status === "redeemed") {
      if (!record.redeemedBy) throw new HttpError(409, "卡密状态异常，请联系管理员", "REDEEM_CODE_STATE_INVALID");
      return { userId: record.redeemedBy, cardId: record.codeId, created: false, faceValue: record.faceValue, notice: "欢迎回来", ...(record.packageId ? { packageId: record.packageId } : {}) };
    }

    // 新卡：建账户 → 绑卡充值 → 默认服务授权。任一步失败都要能重试（卡尚未标记为已用）。
    const userId = randomUUID();
    const username = "c" + randomBytes(6).toString("hex");
    const password = randomBytes(24).toString("base64url");
    const displayName = options.displayName?.trim().slice(0, 40) || "创作者 " + record.codeHint;
    await this.createAccount({ userId, username, displayName, password });

    const redeemed = this.store.redeemCode(digest, userId);
    if (redeemed.status === "already") {
      // 并发下另一个请求先绑了这张卡：回到那个账户，不重复建号。
      if (redeemed.code.redeemedBy) return { userId: redeemed.code.redeemedBy, cardId: redeemed.code.codeId, created: false, faceValue: redeemed.code.faceValue, notice: "欢迎回来", ...(redeemed.code.packageId ? { packageId: redeemed.code.packageId } : {}) };
      throw new HttpError(409, "卡密状态异常，请联系管理员", "REDEEM_CODE_STATE_INVALID");
    }
    if (redeemed.status !== "redeemed") {
      // 建号成功但兑换失败（极罕见：过期或其他）：让用户重试，账户无卡也无余额，不造成损失。
      throw new HttpError(409, "卡密暂时无法完成兑换，请重试或联系管理员", "REDEEM_CODE_STATE_INVALID");
    }

    // 授权：卡绑定了服务就只开那一个（用户面只剩它，不需要挑）；否则按默认集合。
    const packageIds = record.packageId ? [record.packageId] : this.defaultPackageIds();
    if (packageIds.length) {
      const account = this.store.getDocument<{ revision: number }>("@zane-system", "users", userId);
      if (account) await this.grantPackages(userId, account.revision, packageIds).catch(error => log("warn", "cdk.grant_failed", { userId, error: String(error) }));
    }
    return {
      userId, cardId: record.codeId, created: true, faceValue: record.faceValue,
      notice: "已为你开通，余额 " + record.faceValue + " 积分",
      ...(record.packageId ? { packageId: record.packageId } : {}),
    };
  }
}
