import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { AccessService } from "../services/accessService.js";
import { CreditService } from "../services/creditService.js";
import { WorkspaceService } from "../services/workspaceService.js";
import { SqliteStore } from "../storage/sqliteStore.js";
import { temporaryDirectory } from "../testing/testSupport.js";
import { HttpError } from "../errors.js";
import { maxActiveRunsPerUser, selfSignupEnabled, signupGrantCredits } from "../config.js";

test("自助注册：建普通用户、空场景授权、不自动送场景；用户名冲突可对账", async t => {
  let store: SqliteStore | undefined;
  const root = await temporaryDirectory(t, () => store?.close());
  store = new SqliteStore(path.join(root, "metadata.db"));
  const workspace = new WorkspaceService(store, path.join(root, "workspace.json"));
  t.after(() => workspace.shutdown());
  const access = new AccessService(store, workspace);

  const user = await access.register({ userId: "reg-1", username: "newbie", displayName: "新用户", password: "password12345" }, { clientAddress: "127.0.0.1" });
  assert.equal(user.role, "user");
  assert.deepEqual(user.sceneIds, []);
  assert.equal(user.enabled, true);

  // 重复用户名：409 且提示按原 ID 对账，不静默创建第二个账号。
  await assert.rejects(
    access.register({ userId: "reg-2", username: "NEWBIE", displayName: "重复", password: "password12345" }, { clientAddress: "127.0.0.1" }),
    (error: unknown) => error instanceof HttpError && error.code === "USER_ALREADY_EXISTS",
  );
  assert.equal(access.list({}).items.length, 1);
});

test("配置默认值：自助注册关闭、注册赠送为 0、单账户在跑不限制", () => {
  // 这三项是 SaaS 上线的安全默认：默认关闭注册、默认不送积分、默认不额外限制。
  assert.equal(selfSignupEnabled, false);
  assert.equal(signupGrantCredits, 0);
  assert.equal(maxActiveRunsPerUser, 0);
});

test("租户在跑上限：只统计本人且含等待审核的运行", async t => {
  let store: SqliteStore | undefined;
  const root = await temporaryDirectory(t, () => store?.close());
  store = new SqliteStore(path.join(root, "metadata.db"));
  const project = path.join(root, "project");
  const base = { sceneId: "demo", workflowName: "demo", createdAt: new Date().toISOString(), startedAt: new Date().toISOString(), steps: [], outputs: [], inputValues: {}, workflow: { inputs: [], steps: [], outputs: [] }, artifacts: { directory: project, inputs: "", workflow: "", runtime: "", output: "" } };
  for (const [index, status] of ["queued", "running", "waiting", "completed"].entries()) {
    const runId = `00000000-0000-4000-8000-00000000000${index}`;
    store.createRun(project, { ...base, runId, status, ownerUserId: "user-a" } as never, {});
  }
  store.createRun(project, { ...base, runId: "00000000-0000-4000-8000-000000000009", status: "running", ownerUserId: "user-b" } as never, {});
  assert.equal(store.activeRunsForOwner(project, "user-a"), 3, "排队/执行/等待审核都算占用，已完成不算");
  assert.equal(store.activeRunsForOwner(project, "user-b"), 1);
  assert.equal(store.activeRunsForOwner(project, "user-c"), 0);
});

test("积分与项目解耦：换项目目录后账户余额仍在", async t => {
  let store: SqliteStore | undefined;
  const root = await temporaryDirectory(t, () => store?.close());
  store = new SqliteStore(path.join(root, "metadata.db"));
  const credits = new CreditService(store);
  credits.adjust({ userId: "user-x", revision: 0, delta: 42, note: "首期" });
  // 账户表没有 project_directory：这是刻意的，积分是平台货币而不是项目资产。
  assert.equal(credits.balance("user-x").balance, 42);
  assert.deepEqual(store.creditIntegrity("user-x").mismatches, []);
});
