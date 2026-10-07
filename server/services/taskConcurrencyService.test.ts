import assert from "node:assert/strict";
import test from "node:test";
import { harness, deferred, until, submission, id } from "../testing/testSupport.js";
import { TaskConcurrencyService } from "./taskConcurrencyService.js";
import { SqliteStore } from "../storage/sqliteStore.js";
import { HttpError } from "../errors.js";
import { waitForAbortable } from "../execution/cancellation.js";
import { taskConcurrencySettingsSchema } from "../domain/taskConcurrencyContracts.js";

const authorize = () => {};
test("并发配置：只读不初始化、严格参数、旧revision冲突、回执丢失同ID对账、跨连接持久化", async t => {
  const h = await harness(t);
  let notifications = 0;
  const config = new TaskConcurrencyService(h.store, 2, () => h.service.metrics(), () => notifications++);
  const initial = config.read();
  assert.ok(taskConcurrencySettingsSchema.safeParse(initial).success);
  assert.equal(initial.revision, 0); assert.equal(initial.maxActiveRuns, 2); assert.equal(initial.source, "environment");
  assert.deepEqual(h.store.listDocuments("@zane-system", "settings"), []);
  for (const invalid of [{}, { revision: 0 }, { revision: 0, maxActiveRuns: 0 }, { revision: 0, maxActiveRuns: 33 }, { revision: 0, maxActiveRuns: 1.5 }, { revision: 0, maxActiveRuns: "2" }, { revision: -1, maxActiveRuns: 2 }, { revision: "0", maxActiveRuns: 2 }, { revision: 0, maxActiveRuns: 2, ownerUserId: "other" }]) {
    assert.throws(() => config.update(invalid, authorize), error => error instanceof HttpError && error.status === 400);
  }
  assert.equal(config.read().revision, 0); assert.equal(notifications, 0);
  // Discard the write receipt; query the same singleton instead of repeating the write.
  config.update({ revision: 0, maxActiveRuns: 32 }, authorize);
  const current = config.read(); assert.equal(current.id, initial.id); assert.equal(current.revision, 1); assert.equal(current.maxActiveRuns, 32);
  assert.throws(() => config.update({ revision: 0, maxActiveRuns: 1 }, authorize), error => error instanceof HttpError && error.code === "RESOURCE_REVISION_CONFLICT");
  assert.deepEqual(config.read(), current); assert.equal(notifications, 1);
  const otherStore = new SqliteStore(h.store.filename);
  try {
    const afterRestart = new TaskConcurrencyService(otherStore, 5, () => h.service.metrics(), authorize);
    assert.equal(afterRestart.getLimit(), 32); assert.equal(afterRestart.read().source, "saved"); assert.equal(afterRestart.read().defaultMaxActiveRuns, 5);
    afterRestart.update({ revision: 1, maxActiveRuns: 1 }, authorize);
    assert.throws(() => config.update({ revision: 1, maxActiveRuns: 2 }, authorize), error => error instanceof HttpError && error.status === 409);
    assert.equal(config.getLimit(), 1); assert.equal(config.read().revision, 2);
  } finally { otherStore.close(); }
  assert.throws(() => config.update({ revision: 2, maxActiveRuns: 3 }, () => { throw new HttpError(403, "revoked", "ADMIN_REQUIRED"); }), error => error instanceof HttpError && error.status === 403);
  assert.equal(config.read().revision, 2);
});

test("调高即时放行、调低不取消在途任务；全部提交入口复用同一全局队列", async t => {
  let config: TaskConcurrencyService | undefined;
  const entered: string[] = [];
  const gates = new Map<string, ReturnType<typeof deferred<void>>>();
  const h = await harness(t, { getMaxActiveRuns: () => config?.getLimit() ?? 1, executor: { kind: "fake", async execute({ runId, signal }) {
    entered.push(runId);
    await waitForAbortable(gates.get(runId)!.promise, signal);
    return { value: runId };
  } } });
  config = new TaskConcurrencyService(h.store, 1, () => h.service.metrics(), () => h.service.refreshConcurrency());
  await h.service.start();
  const ids = ["one", "two", "three", "four"].map(name => id("concurrency-" + name));
  for (const runId of ids) { gates.set(runId, deferred<void>()); await h.service.submit(submission(runId)); }
  await until(() => entered.length === 1);
  assert.equal(h.service.metrics().queued, 3);
  config.update({ revision: 0, maxActiveRuns: 3 }, authorize);
  await until(() => entered.length === 3);
  assert.equal(h.service.metrics().active, 3); assert.equal(h.service.metrics().queued, 1);
  config.update({ revision: 1, maxActiveRuns: 1 }, authorize);
  assert.equal(h.service.metrics().active, 3); assert.equal(h.service.metrics().maxActiveRuns, 1);
  gates.get(ids[0])!.resolve();
  await h.service.wait(h.settings.projectDirectory, ids[0]); await until(() => h.service.metrics().active === 2);
  assert.equal(entered.length, 3); assert.equal(h.service.metrics().queued, 1);
  gates.get(ids[1])!.resolve();
  await h.service.wait(h.settings.projectDirectory, ids[1]); await until(() => h.service.metrics().active === 1);
  assert.equal(entered.length, 3);
  gates.get(ids[2])!.resolve();
  await until(() => entered.length === 4);
  assert.equal(h.service.metrics().active, 1); assert.equal(h.service.metrics().queued, 0);
  gates.get(ids[3])!.resolve();
  for (const runId of ids) assert.equal((await h.service.wait(h.settings.projectDirectory, runId)).status, "completed");
});
