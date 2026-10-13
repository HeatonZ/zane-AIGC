import assert from "node:assert/strict";
import test from "node:test";
import { UploadQuotaLimiter, uploadQuota } from "./uploadQuota.js";

test("上传配额：超出次数返回429并带Retry-After，用户之间互不影响", () => {
  const limiter = new UploadQuotaLimiter();
  for (let index = 0; index < uploadQuota.maxUploads; index += 1) limiter.check("user-a", 1);
  let thrown: (Error & { status?: number; code?: string; retryAfterSeconds?: number }) | undefined;
  try { limiter.check("user-a", 1); } catch (error) { thrown = error as typeof thrown; }
  assert.equal(thrown?.status, 429);
  assert.equal(thrown?.code, "UPLOAD_QUOTA_EXCEEDED");
  assert.ok((thrown?.retryAfterSeconds ?? 0) >= 1, "应给出重试等待秒数");
  // 其他用户不受影响。
  assert.doesNotThrow(() => limiter.check("user-b", 1));
});

test("上传配额：字节总量超限同样拒绝，小文件不受影响", () => {
  const limiter = new UploadQuotaLimiter();
  const half = Math.floor(uploadQuota.maxBytes / 2) + 1;
  limiter.check("user-bytes", half);
  assert.throws(() => limiter.check("user-bytes", half), (error: unknown) => (error as { code?: string }).code === "UPLOAD_QUOTA_EXCEEDED");
  assert.doesNotThrow(() => limiter.check("user-bytes-small", 1024));
});

test("上传配额：窗口过期后额度重置", () => {
  const limiter = new UploadQuotaLimiter();
  for (let index = 0; index < uploadQuota.maxUploads; index += 1) limiter.check("user-reset", 1);
  assert.throws(() => limiter.check("user-reset", 1));
  // 直接推进窗口起点，验证重置逻辑（不依赖真实等待）。
  const internals = limiter as unknown as { usage: Map<string, { count: number; bytes: number; resetAt: number }> };
  internals.usage.set("user-reset", { count: uploadQuota.maxUploads, bytes: 0, resetAt: Date.now() - 1 });
  assert.doesNotThrow(() => limiter.check("user-reset", 1));
});
