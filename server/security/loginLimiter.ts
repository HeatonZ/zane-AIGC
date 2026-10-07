import { createHash } from "node:crypto";
import { HttpError } from "../errors.js";

export interface LoginLimitOptions {
  windowMs?: number;
  accountAttempts?: number;
  sourceAttempts?: number;
  maxConcurrent?: number;
  maxKeys?: number;
  now?: () => number;
}
interface Bucket { attempts: number; expiresAt: number }
const bounded = (value: number | undefined, fallback: number, min: number, max: number) => {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < min || result > max) throw new Error("Invalid login rate limit configuration");
  return result;
};

/** Operational, process-local counters only; accounts and credentials stay in the authoritative store. */
export class LoginLimiter {
  readonly windowMs: number;
  readonly accountAttempts: number;
  readonly sourceAttempts: number;
  readonly maxConcurrent: number;
  private readonly maxKeys: number;
  private readonly now: () => number;
  private readonly buckets = new Map<string, Bucket>();
  private active = 0;
  private lastPruned = 0;
  constructor(options: LoginLimitOptions = {}) {
    this.windowMs = bounded(options.windowMs, 15 * 60_000, 1000, 86_400_000);
    this.accountAttempts = bounded(options.accountAttempts, 8, 1, 1000);
    this.sourceAttempts = bounded(options.sourceAttempts, 30, 1, 10000);
    this.maxConcurrent = bounded(options.maxConcurrent, 4, 1, 64);
    this.maxKeys = bounded(options.maxKeys, 10000, 2, 100000);
    this.now = options.now ?? Date.now;
  }
  policy() {
    return { windowSeconds: this.windowMs / 1000, accountAttempts: this.accountAttempts, sourceAttempts: this.sourceAttempts, maxConcurrent: this.maxConcurrent, persistence: "process-local" as const, counted: "all_attempts" as const, source: "verified_request_ip" as const };
  }
  private reject(expiresAt: number, now: number): never {
    const retryAfterSeconds = Math.max(1, Math.ceil((expiresAt - now) / 1000));
    throw new HttpError(429, "登录尝试过于频繁，请稍后重试", "LOGIN_RATE_LIMITED", { retryAfterSeconds });
  }
  enter(username: string, clientAddress?: string, scope: "private" | "public-user" = "private"): () => void {
    const now = this.now();
    if (now - this.lastPruned >= Math.min(60_000, this.windowMs)) {
      for (const [key, bucket] of this.buckets) if (bucket.expiresAt <= now) this.buckets.delete(key);
      this.lastPruned = now;
    }
    const digest = (value: string) => createHash("sha256").update(value).digest("hex");
    // Do not consume unverified X-Forwarded-For or retain cleartext account names.
    const address = clientAddress?.replace(/^::ffff:/, "").toLowerCase();
    const keys = [ ...(address ? [{ key: scope + ":ip:" + digest(address), limit: this.sourceAttempts }] : []), { key: scope + ":account:" + digest(username.toLowerCase()), limit: this.accountAttempts } ];
    for (const { key, limit } of keys) {
      const bucket = this.buckets.get(key);
      if (bucket && bucket.expiresAt > now && bucket.attempts >= limit) this.reject(bucket.expiresAt, now);
    }
    if (this.active >= this.maxConcurrent) this.reject(now + 1000, now);
    const missing = keys.filter(({ key }) => !this.buckets.has(key)).length;
    if (this.buckets.size + missing > this.maxKeys) {
      // Fail closed rather than evicting live limits (which would allow username rotation to reset them).
      this.reject(now + this.windowMs, now);
    }
    for (const { key } of keys) {
      const previous = this.buckets.get(key);
      this.buckets.set(key, previous && previous.expiresAt > now ? { ...previous, attempts: previous.attempts + 1 } : { attempts: 1, expiresAt: now + this.windowMs });
    }
    this.active++;
    let released = false;
    return () => { if (!released) { released = true; this.active--; } };
  }
}
