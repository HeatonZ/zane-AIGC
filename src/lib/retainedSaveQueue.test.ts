import assert from "node:assert/strict";
import test from "node:test";
import { RetainedSaveQueue, type PendingSave } from "./retainedSaveQueue";

function gate<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((yes) => { resolve = yes; }); return { promise, resolve }; }

test("失败的保存保留在队列中，后续编辑不能越过失败基线", async () => {
  const calls: Array<[number, number]> = []; let failed = true; let persisted: PendingSave<number>[] = []; const saved: number[] = [];
  const queue = new RetainedSaveQueue<number>({
    send: async (base, desired) => { calls.push([base, desired]); if (failed) throw new Error("offline"); return desired; },
    persist: (entries) => { persisted = structuredClone(entries); }, saved: (value) => saved.push(value), failed: () => {},
  });
  queue.enqueue(0, 1); await new Promise((resolve) => setImmediate(resolve));
  queue.enqueue(1, 2);
  assert.deepEqual(calls, [[0, 1]]);
  assert.deepEqual(persisted, [{ base: 0, desired: 2 }]);
  failed = false; await queue.retry();
  assert.deepEqual(calls, [[0, 1], [0, 2]]); assert.deepEqual(saved, [2]); assert.equal(queue.pendingCount, 0);
});

test("发送中的快照不可变，未发送的连续编辑可合并", async () => {
  const first = gate<number>(); const calls: Array<[number, number]> = [];
  const queue = new RetainedSaveQueue<number>({ send: async (base, desired) => { calls.push([base, desired]); return calls.length === 1 ? first.promise : desired; }, persist: () => {}, saved: () => {}, failed: () => {} });
  queue.enqueue(0, 1); queue.enqueue(1, 2); queue.enqueue(2, 3);
  assert.equal(queue.pendingCount, 2);
  first.resolve(1); await queue.retry();
  assert.deepEqual(calls, [[0, 1], [1, 3]]);
});

test("重载后保留的 outbox 仅显式恢复；存储失败时停止发送", async () => {
  let calls = 0; let quota = true; const errors: string[] = [];
  const queue = new RetainedSaveQueue<number>({ initial: [{ base: 1, desired: 2 }], send: async (_base, desired) => { ++calls; return desired; }, persist: () => { if (quota) throw new Error("quota"); }, saved: () => {}, failed: (error) => errors.push(error.message) });
  await queue.retry(); assert.equal(calls, 0); assert.equal(queue.latest, 2); assert.deepEqual(errors, ["quota"]);
  quota = false; await queue.retry(); assert.equal(calls, 1); assert.equal(queue.pendingCount, 0);
});

test("重载保存的意图不因后续enqueue自动发送，只有显式恢复才提交", async () => {
  const calls: Array<[number, number]> = [];
  const queue = new RetainedSaveQueue<number>({ initial: [{ base: 1, desired: 2 }], send: async (base, desired) => { calls.push([base, desired]); return desired; }, persist: () => {}, saved: () => {}, failed: () => {} });
  queue.enqueue(2, 3);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(calls, []);
  assert.equal(queue.pendingCount, 1);
  await queue.retry();
  assert.deepEqual(calls, [[1, 3]]);
});
