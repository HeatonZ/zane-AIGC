import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { RetainedSaveQueue } from "./retainedSaveQueue";
import { deferred } from "../../server/testing/testSupport";
test("暂存/发布成功等待服务端回执；失败不能以乐观状态冒充已保存",async()=>{const gate=deferred<number>();let saved=0;const queue=new RetainedSaveQueue<number>({send:async()=>gate.promise,saved:()=>{saved++;},failed:()=>{}});queue.enqueue(0,1);let confirmed=false;const wait=queue.waitForSaved().then(()=>{confirmed=true;});await Promise.resolve();assert.equal(confirmed,false);assert.equal(saved,0);gate.resolve(1);await wait;assert.equal(confirmed,true);const failed=new RetainedSaveQueue<number>({send:async()=>{throw new Error("lost response");},saved:()=>{},failed:()=>{}});failed.enqueue(0,1);await assert.rejects(failed.waitForSaved(),/尚未确认/);assert.equal(failed.pendingCount,1);});
test("管理端/用户端独立入口；旧场景库不恢复；管理保存意图按身份隔离",async()=>{const [root,app,sidebar,designer,portal]=await Promise.all(["src/Application.tsx","src/App.tsx","src/components/Sidebar.tsx","src/features/FlowDesigner.tsx","src/features/UserPortal.tsx"].map(path=>readFile(path,"utf8")));assert.match(root,/role === "admin"/);assert.match(app,/mergeWorkspace\(patch\.base, patch\.workspace, userId/);assert.doesNotMatch(app,/localStorage\.setItem/, "编辑只存内存并立即提交服务端，不再写本地副本");assert.doesNotMatch(sidebar,/共享工作区|个人空间|工作区切换/);assert.doesNotMatch(designer,/"暂存已保存"/);assert.match(designer,/await onPublish/);assert.match(portal,/\/api\/v1\/self\//);assert.doesNotMatch(portal,/\/api\/workspace|FlowDesigner|WorkflowRunPanel/);});
test("用户端不提供 AI 凭证入口；凭证能力仍由服务端 HTTP/MCP 提供，管理端保留凭证管理",async()=>{const [portal,admin,routes,operations]=await Promise.all(["src/features/UserPortal.tsx","src/features/UserManagement.tsx","server/api/accessRoutes.ts","server/ai/operations.ts"].map(path=>readFile(path,"utf8")));
  // 守卫的是「凭证管理组件/文案不得进入用户端」，不是禁止出现 account 这个词：
  // 用户端有自己的「账户」页（积分、兑换、退出），与 AI 凭证是两件事。
  assert.doesNotMatch(portal,/AccountTokens|账户与AI接入|api\/v1\/self\/tokens/);
  assert.match(admin,/AccountTokens/);
  assert.match(routes,/\/api\/v1\/self\/tokens/);
  assert.match(operations,/create_own_token|revoke_own_token/);});

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
  // 公网入口是一个独立分支，且其中不含管理/密码登录路径。
  assert.match(root, /if \(publicOnly\) \{/);
  assert.match(root, /onAdmin=\{user.role === "admin" && !publicOnly/);
  const publicBranch = root.slice(root.indexOf("if (publicOnly) {"));
  assert.ok(!/管理员登录|adminLogin/.test(publicBranch), "公网入口不得提供管理员登录入口");
  assert.match(publicBranch, /CdkLogin/);
  assert.match(root, /setPublicOnly\(status.entryMode === "user-only"\)/);
});

test("管理端卡密是独立页面，且能触达逐张明细与作废（不退回只读计数）", async () => {
  const [sidebar, app, credits, admin, routes] = await Promise.all([
    "src/components/Sidebar.tsx", "src/App.tsx", "src/features/CreditManagement.tsx", "src/features/UserManagement.tsx", "server/api/accessRoutes.ts",
  ].map(path => readFile(path, "utf8")));
  // 独立入口：侧边栏与路由都要有 credits 页，不再埋在用户管理底部。
  assert.match(sidebar, /onNavigate\("credits"\)/);
  assert.match(app, /page === "credits" && <CreditManagement/);
  assert.doesNotMatch(admin, /CreditManagement/, "用户管理页不应再重复渲染卡密区块");
  // 逐张明细与两条作废路径必须由界面真实调用，而不只是存在接口。
  assert.match(credits, /\/redeem-batches\/" \+ encodeURIComponent\(target\) \+ "\/codes/);
  assert.match(credits, /\/redeem-codes\/" \+ encodeURIComponent\(code\.codeId\) \+ "\/void/);
  assert.match(credits, /\/redeem-batches\/" \+ encodeURIComponent\(detail\.batch\.batchId\) \+ "\/void/);
  assert.match(routes, /\/api\/v1\/redeem-batches\/:batchId\/codes/);
  assert.match(routes, /\/api\/v1\/redeem-batches\/:batchId\/void/);
  // 明细必须把完整卡密显示出来（用户要求「页面能看到卡密是什么」），并提供复制与整批导出；
  // 旧批次不可回读时要明确提示，不能显示成空白。
  assert.match(credits, /code\.code \?\?/);
  assert.match(credits, /copyCode/);
  assert.match(credits, /导出本批卡密/);
  assert.match(credits, /不可回读/);
  // 已兑换的码也要能作废（退款场景）：按钮只排除已作废，并明确提示会收回面值。
  assert.match(credits, /code\.status === "void"/);
  assert.doesNotMatch(credits, /code\.status !== "unused"/, "已兑换的码必须可以作废，不能只在 unused 时启用");
  assert.match(credits, /作废并收回/);
  assert.match(credits, /reclaim: true/);
});

test("发码：同批次ID返回原结果，成功后才轮换新ID", async () => {
  const credits = await readFile("src/features/CreditManagement.tsx", "utf8");
  // 批次ID是幂等键：不能在组件挂载时固定，成功后必须轮换，否则下一批会拿到原批次结果。
  assert.doesNotMatch(credits, /const \[batchId\] = useState\(/, "批次ID必须是可变状态，成功后可轮换");
  assert.match(credits, /setBatchId\(crypto\.randomUUID\(\)\)/, "成功生成后必须轮换新的批次ID");
  assert.match(credits, /pendingBatchId/, "回执未确认时沿用原ID重试，拿到的是同一份结果");
  // 服务端把同 ID 重复提交当幂等回执（created=false），不再抛 409。
  const service = await readFile("server/services/creditService.ts", "utf8");
  assert.doesNotMatch(service, /REDEEM_BATCH_EXISTS/, "同 ID 重复提交必须返回原批次，而不是报错");
  assert.match(service, /created: false/);
  // 界面要如实提示「未新建」，不能让用户以为又发了一批。
  assert.match(credits, /未新建/);
});
