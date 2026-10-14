import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { localExportHarness } from "../testing/localExportSupport.js";
import { localExportSettingsSchema } from "../domain/localExport.js";

test("本地导出HTTP：管理员共享读写、默认关闭、无效路径与旧revision拒绝、不生成", async t => {
  const h = await localExportHarness(t);
  const read = await h.request();
  assert.equal(read.status, 200); assert.equal(read.headers.get("cache-control"), "no-store");
  const initial = localExportSettingsSchema.parse(await read.json());
  assert.equal(initial.revision, 0); assert.equal(initial.root, ""); assert.equal(initial.enabled, false);
  assert.equal(initial.appliesTo, "core.code.localExport"); assert.equal(initial.scope, "system");
  // 普通用户与未认证调用不可读写管理员配置（fail closed）。
  for (const token of ["", h.user.token]) {
    assert.equal((await h.request(token)).status, token ? 403 : 401);
    assert.equal((await h.request(token, { revision: 0, root: h.exportsRoot })).status, token ? 403 : 401);
  }
  for (const suffix of ["?limit=1", "?cursor=old", "?root=E%3A%5Cx"]) assert.equal((await h.request(h.admin.token, undefined, suffix)).status, 400);
  // 相对路径、盘符根、错类型 root、缺失 revision 与多余字段都拒绝，且不改动已保存值。
  for (const root of ["relative/dir", path.parse(h.root).root, 5, null]) {
    assert.equal((await h.request(h.admin.token, { revision: 0, root })).status, 400, String(root));
  }
  assert.equal((await h.request(h.admin.token, { revision: 0 })).status, 400);
  assert.equal((await h.request(h.admin.token, { revision: 0, root: h.exportsRoot, ownerUserId: "spoof" })).status, 400);
  assert.equal(h.config.read().revision, 0);
  // 并发写同一 revision 只能有一次成功，另一次是明确冲突。
  const second = path.join(h.root, "exports-2");
  const writes = await Promise.all([h.exportsRoot, second].map(root => h.request(h.admin.token, { revision: 0, root })));
  assert.deepEqual(writes.map(response => response.status).sort(), [200, 409]);
  // 回执丢失：读同一单例对账，而不是重放写入。
  const current = localExportSettingsSchema.parse(await (await h.request()).json());
  assert.equal(current.id, initial.id); assert.equal(current.revision, 1); assert.equal(current.enabled, true);
  assert.ok([h.exportsRoot, second].map(item => path.resolve(item)).includes(current.root));
  assert.equal(h.config.root(), current.root);
  assert.equal((await h.request(h.admin.token, { revision: 0, root: h.exportsRoot })).status, 409);
  assert.equal(h.store.listRuns(h.settings.projectDirectory).runs.length, 0, "配置不生成运行");
  assert.equal(h.executions, 0, "配置不执行步骤");
  // 空串关闭该能力。
  const closed = localExportSettingsSchema.parse(await (await h.request(h.admin.token, { revision: 1, root: "" })).json());
  assert.equal(closed.revision, 2); assert.equal(closed.enabled, false); assert.equal(h.config.root(), "");
});

test("本地导出HTTP：管理员凭证失效后不可继续写入配置", async t => {
  const h = await localExportHarness(t);
  await h.access.create({ userId: "backup-admin", username: "backupadmin", displayName: "backup", password: "isolated-local-export-password", role: "admin" });
  h.access.update({ userId: h.admin.user.id, revision: h.admin.user.revision, role: "user" });
  assert.equal((await h.request(h.admin.token, { revision: 0, root: h.exportsRoot })).status, 401);
  assert.equal(h.config.read().revision, 0);
});
