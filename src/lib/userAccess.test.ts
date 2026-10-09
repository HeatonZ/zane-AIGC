import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { RetainedSaveQueue } from "./retainedSaveQueue";
import { deferred } from "../../server/testing/testSupport";
test("暂存/发布成功等待服务端回执；失败不能以乐观状态冒充已保存",async()=>{const gate=deferred<number>();let saved=0;const queue=new RetainedSaveQueue<number>({send:async()=>gate.promise,persist:()=>{},saved:()=>{saved++;},failed:()=>{}});queue.enqueue(0,1);let confirmed=false;const wait=queue.waitForSaved().then(()=>{confirmed=true;});await Promise.resolve();assert.equal(confirmed,false);assert.equal(saved,0);gate.resolve(1);await wait;assert.equal(confirmed,true);const failed=new RetainedSaveQueue<number>({send:async()=>{throw new Error("lost response");},persist:()=>{},saved:()=>{},failed:()=>{}});failed.enqueue(0,1);await assert.rejects(failed.waitForSaved(),/尚未确认/);assert.equal(failed.pendingCount,1);});
test("管理端/用户端独立入口；旧场景库不恢复；管理保存意图按身份隔离",async()=>{const [root,app,sidebar,designer,portal]=await Promise.all(["src/Application.tsx","src/App.tsx","src/components/Sidebar.tsx","src/features/FlowDesigner.tsx","src/features/UserPortal.tsx"].map(path=>readFile(path,"utf8")));assert.match(root,/role === "admin"/);assert.match(app,/config-outbox:v2:.*userId/);assert.match(app,/mergeWorkspace\(base, desired, userId\)/);assert.doesNotMatch(sidebar,/共享工作区|个人空间|工作区切换/);assert.doesNotMatch(designer,/"暂存已保存"/);assert.match(designer,/await onPublish/);assert.match(portal,/\/api\/v1\/self\//);assert.doesNotMatch(portal,/\/api\/workspace|FlowDesigner|WorkflowRunPanel/);});
test("用户端不提供 AI 凭证入口；凭证能力仍由服务端 HTTP/MCP 提供，管理端保留凭证管理",async()=>{const [portal,admin,routes,operations]=await Promise.all(["src/features/UserPortal.tsx","src/features/UserManagement.tsx","server/api/accessRoutes.ts","server/ai/operations.ts"].map(path=>readFile(path,"utf8")));assert.doesNotMatch(portal,/AccountTokens|账户与AI接入|"account"/);assert.match(admin,/AccountTokens/);assert.match(routes,/\/api\/v1\/self\/tokens/);assert.match(operations,/create_own_token|revoke_own_token/);});

import { AccessApiError, accessApi } from "./accessApi";
import { isDefiniteRunRejection, uploadedInput, resultPath, mergeResultPage, type ResultPage } from "./userPortal";
test("提交/续跑的明确拒绝释放意图；丢回执、5xx、重复/准备中保留原ID", () => {
  assert.equal(isDefiniteRunRejection(new AccessApiError("revoked", 403, "SCENE_ACCESS_DENIED")), true);
  assert.equal(isDefiniteRunRejection(new AccessApiError("invalid state", 409, "RUN_NOT_RESUMABLE")), true);
  for (const [status, code] of [[0, "RESPONSE_UNKNOWN"], [500, "INTERNAL_ERROR"], [409, "RUN_ALREADY_EXISTS"], [409, "RUN_PREPARING"]] as const) {
    assert.equal(isDefiniteRunRejection(new AccessApiError("uncertain", status, code)), false);
  }
});
test("媒体上传成功与原ID对账使用同一引用合并规则，不破坏列表字段", () => {
  const first = { assetId: "first", assetVersion: 1 }, second = { assetId: "second", assetVersion: 1 };
  assert.deepEqual(uploadedInput([first], "images", second), [first, second]);
  assert.deepEqual(uploadedInput(undefined, "image_list", second), [second]);
  assert.deepEqual(uploadedInput(first, "image", second), second);
});
test("逐项输出分段携带itemIndex=0，逐项下一页不重复聚合输出", () => {
  const context = { stepId: "foreach", itemIndex: 0, outputKey: "values", valueOffset: 20 };
  const route = new URL(resultPath("run", context), "http://localhost");
  assert.equal(route.searchParams.get("itemIndex"), "0");
  assert.equal(route.searchParams.get("valueOffset"), "20");
  const output = { key: "values", label: "业务输出", type: "json", valuePage: { hasMore: false } };
  const first: ResultPage = { outputs: [output], items: [{ index: 0, status: "completed", outputs: [output] }], hasMore: true };
  const second: ResultPage = { outputs: [output], items: [{ index: 1, status: "completed", outputs: [output] }], hasMore: false };
  const merged = mergeResultPage(first, second, { stepId: "foreach" }, "cursor");
  assert.equal(merged.outputs?.length, 1); assert.equal(merged.items?.length, 2);
  assert.equal(mergeResultPage(first, second, {}, "cursor").outputs?.length, 2);
  assert.deepEqual(mergeResultPage(first, second, {}, undefined), second);
});
test("成功HTTP响应无法解码时视为回执未知，不能误判创建失败或宣称保存成功", async t => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response("{invalid", { status: 200, headers: { "Content-Type": "application/json" } });
  t.after(() => { globalThis.fetch = original; });
  await assert.rejects(accessApi("/api/v1/self/drafts"), (error: unknown) => error instanceof AccessApiError && error.code === "RESPONSE_UNKNOWN");
});

test("登录限流与错误脱敏的客户端契约：读取请求ID/重试秒数且不自动重放", async t => {
  const original = globalThis.fetch; let calls = 0;
  globalThis.fetch = async () => { calls++; return new Response(JSON.stringify({ error: "登录尝试过于频繁", code: "LOGIN_RATE_LIMITED", requestId: "req-body" }), { status: 429, headers: { "Content-Type": "application/json", "Retry-After": "12", "X-Request-ID": "req-header" } }); };
  t.after(() => { globalThis.fetch = original; });
  await assert.rejects(accessApi("/api/auth/login", { method: "POST", body: JSON.stringify({ username: "test", password: "wrong" }) }), error => error instanceof AccessApiError && error.code === "LOGIN_RATE_LIMITED" && error.retryAfterSeconds === 12 && error.requestId === "req-header" && /12秒/.test(error.message));
  assert.equal(calls, 1);
});
test("用户入口未初始化不显示创建管理员；不向公网用户提供切换管理视图", async () => {
  const root = await readFile("src/Application.tsx", "utf8");
  assert.match(root, /publicOnly && initialized === false/);
  assert.match(root, /此入口不提供管理员初始化/);
  assert.match(root, /onAdmin=\{user.role === "admin" && !publicOnly/);
  assert.match(root, /setPublicOnly\(status.entryMode === "user-only"\)/);
});
