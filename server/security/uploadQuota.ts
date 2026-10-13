/** 上传配额：按用户限制单位时间内的上传次数与字节总量，防止单个账户占满磁盘。
 *  进程内计数（重启清零），与登录限流同属本机运维护栏；阈值可用环境变量调整。 */

const windowMs = 10 * 60_000;
const defaultMaxUploads = 60;
const defaultMaxBytes = 2 * 1024 * 1024 * 1024;

function boundedInt(raw: string | undefined, fallback: number, min: number, max: number) {
  const value = Number.parseInt(raw ?? "", 10);
  return Number.isSafeInteger(value) && value >= min && value <= max ? value : fallback;
}

export const uploadQuota = {
  maxUploads: boundedInt(process.env.ZANE_UPLOAD_MAX_PER_WINDOW, defaultMaxUploads, 1, 10_000),
  maxBytes: boundedInt(process.env.ZANE_UPLOAD_MAX_BYTES_PER_WINDOW, defaultMaxBytes, 1_000_000, 1024 ** 4),
  windowMs,
};

interface Usage { count: number; bytes: number; resetAt: number }

export class UploadQuotaLimiter {
  private readonly usage = new Map<string, Usage>();
  /** 计数与字节双限；超出抛 429（带 Retry-After 秒数），调用方在读取请求体之前先检查次数。 */
  check(userId: string, bytes: number) {
    const now = Date.now();
    const current = this.usage.get(userId);
    const entry = !current || current.resetAt <= now ? { count: 0, bytes: 0, resetAt: now + uploadQuota.windowMs } : current;
    if (entry.count + 1 > uploadQuota.maxUploads || entry.bytes + bytes > uploadQuota.maxBytes) {
      const retryAfterSeconds = Math.max(1, Math.ceil((entry.resetAt - now) / 1000));
      const error = new Error(`上传过于频繁或超出配额（每 ${Math.round(uploadQuota.windowMs / 60000)} 分钟最多 ${uploadQuota.maxUploads} 次 / ${Math.round(uploadQuota.maxBytes / 1024 / 1024)}MB）；请稍后重试`);
      Object.assign(error, { status: 429, code: "UPLOAD_QUOTA_EXCEEDED", retryAfterSeconds });
      this.usage.set(userId, entry);
      throw error;
    }
    entry.count += 1;
    entry.bytes += bytes;
    this.usage.set(userId, entry);
    if (this.usage.size > 1000) for (const [key, value] of this.usage) if (value.resetAt <= now) this.usage.delete(key);
  }
}
