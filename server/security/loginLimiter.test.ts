import assert from "node:assert/strict";
import test from "node:test";
import { LoginLimiter } from "./loginLimiter.js";
import { HttpError } from "../errors.js";
import { errorResponse, redactErrorText } from "./errorHandler.js";
const limited = (error: unknown) => error instanceof HttpError && error.status === 429 && error.code === "LOGIN_RATE_LIMITED" && Number(error.details?.retryAfterSeconds) >= 1;

test("登录限流：账号忽略大小写、窗口到期恢复、成功也计数；被拒绝不延长锁定", () => {
  let now = 1000; const limiter = new LoginLimiter({ now: () => now, windowMs: 2000, accountAttempts: 2, sourceAttempts: 10 });
  limiter.enter("Alice", "10.0.0.1")(); limiter.enter("ALICE", "10.0.0.2")();
  assert.throws(() => limiter.enter("alice", "10.0.0.3"), limited);
  now = 2999; assert.throws(() => limiter.enter("alice", "10.0.0.4"), limited);
  now = 3000; limiter.enter("alice", "10.0.0.1")();
});
test("登录限流：可信来源跨账号限流、公私计数隔离、IPv4映射一致", () => {
  const limiter = new LoginLimiter({ sourceAttempts: 2 });
  limiter.enter("one", "::ffff:127.0.0.1", "public-user")(); limiter.enter("two", "127.0.0.1", "public-user")();
  assert.throws(() => limiter.enter("three", "127.0.0.1", "public-user"), limited);
  limiter.enter("three", "127.0.0.1", "private")();
});
test("登录限流：密码计算并行上限、释放幂等、有界内存不驱逐有效限制", () => {
  const limiter = new LoginLimiter({ maxConcurrent: 1, maxKeys: 2 }); const release = limiter.enter("one", "127.0.0.1");
  assert.throws(() => limiter.enter("two", "127.0.0.1"), limited);
  release(); release(); limiter.enter("one", "127.0.0.1")();
  assert.throws(() => limiter.enter("two", "127.0.0.1"), limited);
});
test("登录限流：拒绝无效配置；过期桶回收而非永久耗尽", () => {
  for (const options of [{ accountAttempts: 0 }, { sourceAttempts: NaN }, { windowMs: 999 }, { maxConcurrent: 65 }, { maxKeys: 1 }]) assert.throws(() => new LoginLimiter(options));
  let now = 1000; const limiter = new LoginLimiter({ now: () => now, windowMs: 1000, maxKeys: 2 });
  limiter.enter("first", "127.0.0.1")(); assert.throws(() => limiter.enter("second", "127.0.0.1"), limited);
  now = 2000; limiter.enter("second", "127.0.0.1")();
});
test("错误脱敏：未知异常/JSON解析不泄漏，保留requestId和稳定状态码", () => {
  const secret = "password=SECRET Bearer TOP_SECRET E:\\private\\key.txt https://internal.example/path";
  const result = errorResponse(new Error(secret), true, "request-test");
  assert.equal(result.status, 500); assert.equal(result.body.code, "INTERNAL_ERROR"); assert.equal(result.body.requestId, "request-test");
  assert.doesNotMatch(JSON.stringify(result), /SECRET|private|internal\.example/);
  const parser = Object.assign(new Error(secret), { status: 400, type: "entity.parse.failed" });
  assert.equal(errorResponse(parser, true).body.code, "INVALID_JSON"); assert.doesNotMatch(JSON.stringify(errorResponse(parser, true)), /SECRET/);
  assert.equal(errorResponse(null, true).status, 500); assert.equal(errorResponse({ status: 200 }, true).status, 500);
  assert.equal(errorResponse(new Error(secret), false).body.error, secret);
});
test("错误脱敏：保留revision冲突及Retry-After信息，清理域错误内的路径和凭证", () => {
  const conflict = errorResponse(new HttpError(409, "版本冲突 token=SECRET E:\\private\\key.txt /etc/private.key", "DRAFT_REVISION_CONFLICT", { currentRevision: 3, token: "SECRET", nested: { path: "/home/private/key", expectedRevision: 2 } }), true);
  assert.equal(conflict.body.code, "DRAFT_REVISION_CONFLICT"); assert.equal((conflict.body.details as any).currentRevision, 3);
  assert.equal((conflict.body.details as any).nested.expectedRevision, 2); assert.doesNotMatch(JSON.stringify(conflict), /SECRET|private|etc\//);
  assert.equal(errorResponse(new HttpError(429, "稍后", "LOGIN_RATE_LIMITED", { retryAfterSeconds: 5 }), true).retryAfterSeconds, 5);
  assert.equal(errorResponse(new HttpError(429, "稍后", "LOGIN_RATE_LIMITED", { retryAfterSeconds: -1 }), true).retryAfterSeconds, undefined);
  assert.doesNotMatch(redactErrorText("api_key=SECRET Authorization: Bearer TOP_SECRET https://host/a?token=SECRET"), /SECRET|host\/a/);
  assert.doesNotMatch(redactErrorText('password="SECRET WITH SPACES" api_key="SECRET TWO"'), /SECRET|WITH SPACES|TWO/);
});
