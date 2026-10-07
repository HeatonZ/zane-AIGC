import assert from "node:assert/strict";
import test from "node:test";
import { taskConcurrencyHarness } from "../testing/taskConcurrencySupport.js";
import { taskConcurrencySettingsSchema } from "../domain/taskConcurrencyContracts.js";

test("并发HTTP：管理员共享读写、无效字段/分页拒绝、同时旧revision仅一次成功、不生成", async t => {
  const h = await taskConcurrencyHarness(t);
  const read = await h.request(); assert.equal(read.status, 200); assert.equal(read.headers.get("cache-control"), "no-store");
  const initial = taskConcurrencySettingsSchema.parse(await read.json()); assert.equal(initial.revision, 0);
  for (const token of ["", h.user.token]) {
    assert.equal((await h.request(token)).status, token ? 403 : 401);
    assert.equal((await h.request(token, { revision: 0, maxActiveRuns: 4 })).status, token ? 403 : 401);
  }
  for (const suffix of ["?limit=1", "?cursor=old", "?projectDirectory=other", "?userId=admin"]) assert.equal((await h.request(h.admin.token, undefined, suffix)).status, 400);
  for (const maxActiveRuns of [0, 33, 1.5, "2", null]) assert.equal((await h.request(h.admin.token, { revision: 0, maxActiveRuns })).status, 400);
  assert.equal((await h.request(h.admin.token, { revision: 0, maxActiveRuns: 3, ownerUserId: "spoof" })).status, 400);
  const writes = await Promise.all([3, 4].map(maxActiveRuns => h.request(h.admin.token, { revision: 0, maxActiveRuns })));
  assert.deepEqual(writes.map(response => response.status).sort(), [200, 409]);
  // Simulate a discarded successful receipt. Read back instead of replaying it.
  const current = taskConcurrencySettingsSchema.parse(await (await h.request()).json());
  assert.equal(current.id, initial.id); assert.equal(current.revision, 1); assert.ok([3, 4].includes(current.maxActiveRuns));
  assert.equal(h.service.metrics().maxActiveRuns, current.maxActiveRuns);
  assert.equal(h.store.listRuns(h.settings.projectDirectory).runs.length, 0); assert.equal(h.executions, 0);
});

test("并发权限：管理员凭证失效后不可继续写入配置", async t => {
  const h = await taskConcurrencyHarness(t);
  await h.access.create({ userId: "backup-admin", username: "backupadmin", displayName: "backup", password: "isolated-concurrency-password", role: "admin" });
  h.access.update({ userId: h.admin.user.id, revision: h.admin.user.revision, role: "user" });
  assert.equal((await h.request(h.admin.token, { revision: 0, maxActiveRuns: 6 })).status, 401);
  assert.equal(h.config.read().revision, 0);
});
