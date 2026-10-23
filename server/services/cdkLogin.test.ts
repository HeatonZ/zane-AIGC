import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { AccessService } from "../services/accessService.js";
import { CreditService } from "../services/creditService.js";
import { CdkLoginService } from "../services/cdkLoginService.js";
import { WorkspaceService } from "../services/workspaceService.js";
import { SqliteStore } from "../storage/sqliteStore.js";
import { temporaryDirectory } from "../testing/testSupport.js";
import { HttpError } from "../errors.js";

/** 卡即身份：第一次用卡开账户，同一张卡回到同一账户，绑定的服务自动授权。 */
async function harness(t: Parameters<typeof temporaryDirectory>[0]) {
  let store: SqliteStore | undefined;
  const root = await temporaryDirectory(t, () => store?.close());
  store = new SqliteStore(path.join(root, "metadata.db"));
  const workspace = new WorkspaceService(store, path.join(root, "workspace.json"));
  t.after(() => workspace.shutdown());
  const access = new AccessService(store, workspace);
  const credits = new CreditService(store);
  credits.bindIdentity(access);
  // 生产里可授权集合不止一个包：只有两个包时，「只授一个却拿到全部」的泄漏才看得见。
  const allGrantable = ["ai_image", "drama_episode"];
  const grants: Array<string[] | undefined> = [];
  const cdk = new CdkLoginService(
    store,
    async input => (await access.create({ ...input, role: "user" })).user,
    // 忠实模拟 server/index.ts 的注入：把收到的列表写进账户。第三个参数为 undefined 表示
    // 旧实现（忽略入参、按全量可授权集合授权）——回归用例必须在旧形态下也能跑起来并失败。
    async (userId, _revision, packageIds) => {
      grants.push(packageIds);
      const ids = packageIds ?? allGrantable;
      const account = access.get(userId);
      // 旧形态下入参 revision 会被忽略；测试桩统一按账号当前 revision 写入，避免把并发语义混进回归点。
      const grant = ids.filter(id => allGrantable.includes(id));
      if (!grant.length) return undefined;
      return access.setPackages({ userId, revision: account.revision, packageIds: grant }, new Set(grant), undefined, "@cdk");
    },
    () => [],
  );
  return { store, workspace, access, credits, cdk, grants };
}

test("CDK 登录：新卡开账户、绑定的服务自动授权、余额到账", async t => {
  const h = await harness(t);
  const batch = h.credits.createBatch({ batchId: "b1", name: "首期", faceValue: 5, count: 1, packageId: "ai_image" });
  const code = batch.codes[0];

  // 只读校验：新卡，带出绑定服务。
  const inspected = h.cdk.inspect(code);
  assert.equal(inspected.known, false);
  assert.equal(inspected.faceValue, 5);
  assert.equal(inspected.packageId, "ai_image");

  const identity = await h.cdk.login(code, { displayName: "小美" });
  assert.equal(identity.created, true);
  assert.equal(identity.packageId, "ai_image");
  assert.equal(identity.faceValue, 5);

  // 账户已建、余额到账、只授权了绑定的服务。
  const account = h.access.get(identity.userId);
  assert.equal(account.role, "user");
  assert.equal(account.displayName, "小美");
  assert.deepEqual(account.packageIds, ["ai_image"]);
  assert.equal(h.credits.balance(identity.userId).balance, 5);
  assert.equal(h.grants.length, 1, "开号只授权一次");
  assert.deepEqual(h.grants[0], ["ai_image"], "第三个参数就是卡绑定的包");

  // 会话可以正常签发（与密码登录同一条路径）。
  const session = h.access.issueSession(identity.userId);
  assert.ok(session.token.length > 20);
  assert.equal(h.access.authenticate(session.token).id, identity.userId);
});

test("CDK 登录：同一张卡回到同一账户，不重复开号也不重复充值", async t => {
  const h = await harness(t);
  const code = h.credits.createBatch({ batchId: "b2", name: "首期", faceValue: 5, count: 1, packageId: "ai_image" }).codes[0];
  const first = await h.cdk.login(code);
  const before = h.credits.balance(first.userId).balance;

  const second = await h.cdk.login(code);
  assert.equal(second.created, false);
  assert.equal(second.userId, first.userId);
  assert.equal(second.packageId, "ai_image", "回访时也要带出绑定服务");
  assert.equal(h.credits.balance(first.userId).balance, before, "回访不应重复充值");
  assert.equal(h.access.list({}).items.filter(user => user.role === "user").length, 1, "不应建第二个账户");
});

test("CDK 登录：无效卡、过期卡、作废卡都被拒绝且不建账户", async t => {
  const h = await harness(t);
  for (const code of ["ZZZZZ-ZZZZZ-ZZZZZ-ZZZZZ", ""]) {
    await assert.rejects(h.cdk.login(code), (error: unknown) => error instanceof HttpError && ["REDEEM_CODE_INVALID", "INVALID_REDEEM_CODE"].includes(error.code));
  }
  // 发码侧就拒绝过去的时间：过期卡不可能被发出去，登录侧因此只需处理「发出去之后才过期」。
  assert.throws(() => h.credits.createBatch({ batchId: "b3", name: "过期", faceValue: 5, count: 1, expiresAt: new Date(Date.now() - 60_000).toISOString() }), /有效期/);
  assert.equal(h.access.list({}).items.length, 0, "失败的登录不应留下账户");
});

test("CDK 登录：只绑定一个服务的卡只拿到那一个包，不泄漏其它可授权包", async t => {
  const h = await harness(t);
  // 故意选非首个（不是最可能被当成默认值）的包：忽略入参按全量授权的旧实现在这里必然失败。
  const code = h.credits.createBatch({ batchId: "b-bound-episode", name: "剧集", faceValue: 5, count: 1, packageId: "drama_episode" }).codes[0];
  const identity = await h.cdk.login(code);
  assert.equal(identity.packageId, "drama_episode");
  assert.deepEqual(h.access.get(identity.userId).packageIds, ["drama_episode"], "账户只应有卡绑定的那一个包");
  assert.equal(h.grants.length, 1, "开号只授权一次");
  assert.deepEqual(h.grants[0], ["drama_episode"], "第三个参数必须是卡绑定的包");
  assert.ok(!(h.grants[0] ?? []).includes("ai_image"), "不能顺带授予其它可授权包");
});

test("CDK 登录：未绑定服务的卡按生产默认集合（空）授权，不发起授权调用", async t => {
  const h = await harness(t);
  const code = h.credits.createBatch({ batchId: "b5", name: "通用", faceValue: 2, count: 1 }).codes[0];
  const inspected = h.cdk.inspect(code);
  assert.equal(inspected.packageId, undefined);
  const identity = await h.cdk.login(code);
  assert.equal(identity.packageId, undefined);
  // server/index.ts 的 defaultPackageIds 返回 []：不绑服务的卡不自动开任何包。
  assert.deepEqual(h.access.get(identity.userId).packageIds, [], "默认集合为空");
  assert.equal(h.grants.length, 0, "默认集合为空时不应发起授权调用");
});

test("卡作废后：最后一枚有效卡消失即停用用户并让旧会话失效；兑换新卡后恢复", async t => {
  const h = await harness(t);
  const code = h.credits.createBatch({ batchId: "b-suspend", name: "停用", faceValue: 20, count: 1, packageId: "ai_image" }).codes[0];
  const identity = await h.cdk.login(code);
  const session = h.access.issueSession(identity.userId);
  assert.equal(h.access.authenticate(session.token).id, identity.userId);

  const record = h.store.listRedeemCodes("b-suspend")[0];
  const voided = h.credits.voidCode(record.codeId, { actorId: "@operator" });
  assert.deepEqual(voided.suspendedUsers, [identity.userId], "没有有效卡就必须停用账户");
  assert.equal(h.access.get(identity.userId).enabled, false);
  // 旧会话立即失效，而不是等 24 小时过期。
  assert.throws(() => h.access.authenticate(session.token), (error: unknown) => error instanceof HttpError && ["AUTH_REQUIRED", "ACCOUNT_DISABLED"].includes(error.code));
  // 作废的卡也不能再登录。
  await assert.rejects(h.cdk.login(code), (error: unknown) => error instanceof HttpError && error.code === "REDEEM_CODE_INVALID");

  // 拿到新卡后恢复：兑换成功即重新启用，可以再次登录。
  const fresh = h.credits.createBatch({ batchId: "b-revive", name: "复活", faceValue: 10, count: 1, packageId: "ai_image" }).codes[0];
  h.credits.redeem(identity.userId, fresh);
  assert.equal(h.access.get(identity.userId).enabled, true);
  const revived = await h.cdk.login(fresh);
  assert.equal(revived.userId, identity.userId);
});

test("多卡用户：作废其中一张不会停用账户", async t => {
  const h = await harness(t);
  const first = h.credits.createBatch({ batchId: "b-multi-1", name: "一", faceValue: 10, count: 1 }).codes[0];
  const identity = await h.cdk.login(first);
  // 同一账户再兑换一张新卡。
  const second = h.credits.createBatch({ batchId: "b-multi-2", name: "二", faceValue: 10, count: 1 }).codes[0];
  h.credits.redeem(identity.userId, second);

  const record = h.store.listRedeemCodes("b-multi-1")[0];
  const voided = h.credits.voidCode(record.codeId);
  assert.deepEqual(voided.suspendedUsers ?? [], [], "还有有效卡就不能停用");
  assert.equal(h.access.get(identity.userId).enabled, true);
});
