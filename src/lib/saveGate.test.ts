import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { publishBlockedReason, savePhase, saveWaitMessage, saveWaitTimeoutMs } from "./saveGate";

test("保存状态只有三种语义：等待、未确认、就绪", () => {
  assert.equal(savePhase("saved", false), "ready");
  assert.equal(savePhase("saved", true), "ready", "已确认的保存不受超时影响");
  assert.equal(savePhase("saving", false), "pending");
  assert.equal(savePhase("failed", false), "unconfirmed");
  // 真实故障：请求丢失或排队时 saving 永不结束；超时后必须变成需要用户对账的状态。
  assert.equal(savePhase("saving", true), "unconfirmed");
});

test("差异弹窗的等待文案在超时后给出可执行的下一步，而不是无限等待", () => {
  assert.equal(saveWaitMessage("saved", false), "");
  assert.match(saveWaitMessage("saving", false), /等待服务端确认/);
  const stalled = saveWaitMessage("saving", true);
  assert.match(stalled, new RegExp(String(Math.round(saveWaitTimeoutMs / 1000)) + " 秒"));
  assert.match(stalled, /重试/);
  assert.match(stalled, /刷新配置/);
  assert.ok(!/等待服务端确认后自动加载/.test(stalled), "超时后不得继续显示自动等待");
  assert.match(saveWaitMessage("failed", false), /保存尚未确认/);
});

test("发布只在保存明确失败时被拦；保存中允许继续（发布在队列里等回执）", () => {
  assert.equal(publishBlockedReason("saved"), "");
  assert.equal(publishBlockedReason("saving"), "", "一次点击发布依赖 saving 时继续入队");
  assert.match(publishBlockedReason("failed"), /重试|读取服务端配置/);
});

test("发布前检查保存状态，且发布版本不在回执前写入本机", async () => {
  const [designer, app] = await Promise.all([readFile(new URL("../features/FlowDesigner.tsx", import.meta.url), "utf8"), readFile(new URL("../App.tsx", import.meta.url), "utf8")]);
  // 按钮用 aria-disabled，点击仍会进入 publish()：必须自己拦住失败的保存。
  assert.match(designer, /if \(saveStatus === "failed"\)/);
  assert.match(designer, /publishBlockedReason|saveStatus === "failed"/);
  // 发布版本必须先等回执：commitWorkspace 会 applyWorkspace，失败时界面会留下假版本号。
  const publishFn = app.slice(app.indexOf("async function publishWorkspaceScene"), app.indexOf("function applyWorkspaceSceneVersion"));
  assert.ok(publishFn.includes("stageWorkspace"), "发布必须走只提交、不先应用的路径");
  assert.ok(!publishFn.includes("commitWorkspace("), "发布不得使用会先写本机的 commitWorkspace");
  assert.match(app, /function stageWorkspace\(/, "需要只入队不应用本机的提交路径");
  const stageFn = app.slice(app.indexOf("function stageWorkspace("), app.indexOf("useEffect(() => {", app.indexOf("function stageWorkspace(")));
  assert.ok(!stageFn.includes("applyWorkspace("), "stageWorkspace 不得先应用本机状态");
  assert.match(stageFn, /enqueue\(workspaceRef\.current/, "stageWorkspace 以当前权威快照为基线入队");
});

test("待同步但没有错误时，顶栏也提供重试与对账入口", async () => {
  const app = await readFile(new URL("../App.tsx", import.meta.url), "utf8");
  // 旧界面只在 workspaceSyncError 非空时渲染按钮，导致「编辑待同步」时无任何出口。
  assert.ok(app.includes("workspacePendingCount > 0 && <>"), "待同步状态必须渲染操作按钮");
  assert.ok(app.includes("配置待同步 · 重试"));
  assert.ok(app.includes("!workspaceSyncError && workspaceSaveStalled"));
  assert.ok(app.includes("保存未确认 · 重试"));
  // 停滞状态必须真的改变 saveStatus，否则发布与差异仍会无限等待。
  assert.match(app, /workspaceSyncError \|\| workspaceSaveStalled \? "failed"/);
});
