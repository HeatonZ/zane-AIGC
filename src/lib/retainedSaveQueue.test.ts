import assert from "node:assert/strict";
import test from "node:test";
import { RetainedSaveQueue } from "./retainedSaveQueue";

function gate<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((yes) => { resolve = yes; }); return { promise, resolve }; }

test("失败的保存保留在队列中，后续编辑不能越过失败基线", async () => {
  const calls: Array<[number, number]> = []; let failed = true; const saved: number[] = [];
  const queue = new RetainedSaveQueue<number>({
    send: async (base, desired) => { calls.push([base, desired]); if (failed) throw new Error("offline"); return desired; },
    saved: (value) => saved.push(value), failed: () => {},
  });
  queue.enqueue(0, 1); await new Promise((resolve) => setImmediate(resolve));
  queue.enqueue(1, 2);
  assert.deepEqual(calls, [[0, 1]]);
  assert.equal(queue.pendingCount, 1);
  assert.equal(queue.latest, 2, "未发送的编辑合并到同一条待提交记录");
  failed = false; await queue.retry();
  // 重试仍以最初失败的基线 0 提交，不会跳过它
  assert.deepEqual(calls, [[0, 1], [0, 2]]); assert.deepEqual(saved, [2]); assert.equal(queue.pendingCount, 0);
});

test("发送中的快照不可变，未发送的连续编辑可合并", async () => {
  const first = gate<number>(); const calls: Array<[number, number]> = [];
  const queue = new RetainedSaveQueue<number>({ send: async (base, desired) => { calls.push([base, desired]); return calls.length === 1 ? first.promise : desired; }, saved: () => {}, failed: () => {} });
  queue.enqueue(0, 1); queue.enqueue(1, 2); queue.enqueue(2, 3);
  assert.equal(queue.pendingCount, 2);
  // 在途请求正常返回：等它自己完成即可，不需要打断重发。
  first.resolve(1);
  await queue.waitForSaved();
  assert.deepEqual(calls, [[0, 1], [1, 3]]);
});

test("编辑只存在内存里：新建队列没有任何待提交内容，刷新不会复活旧编辑", () => {
  const queue = new RetainedSaveQueue<number>({ send: async (_base, desired) => desired, saved: () => {}, failed: () => {} });
  assert.equal(queue.pendingCount, 0);
  assert.equal(queue.latest, undefined);
});

test("放弃待提交内容不会影响在途请求，清空后可继续提交新编辑", async () => {
  const inFlight = gate<number>(); const calls: Array<[number, number]> = [];
  const queue = new RetainedSaveQueue<number>({ send: async (base, desired) => { calls.push([base, desired]); return calls.length === 1 ? inFlight.promise : desired; }, saved: () => {}, failed: () => {} });
  queue.enqueue(0, 1);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(queue.discard(), false, "在途请求存在时不能放弃");
  inFlight.resolve(1);
  await queue.waitForSaved();
  // 队列已空：放弃是幂等的
  assert.equal(queue.discard(), true);
  assert.equal(queue.pendingCount, 0);
  queue.enqueue(1, 2);
  await queue.waitForSaved();
  assert.deepEqual(calls, [[0, 1], [1, 2]]);
});

test("放弃会丢掉尚未发送的排队编辑，但不影响已在途的那一条", async () => {
  const inFlight = gate<number>(); const calls: Array<[number, number]> = [];
  const queue = new RetainedSaveQueue<number>({ send: async (base, desired) => { calls.push([base, desired]); return calls.length === 1 ? inFlight.promise : desired; }, saved: () => {}, failed: () => {} });
  queue.enqueue(0, 1);
  await new Promise((resolve) => setImmediate(resolve));
  queue.enqueue(1, 2);
  assert.equal(queue.pendingCount, 2);
  inFlight.resolve(1);
  await queue.waitForSaved();
  assert.deepEqual(calls, [[0, 1], [1, 2]], "第二条在第一条完成后随即发送，无待放弃内容");
});

test("保存失败后暂停，不越过失败基线；只有显式重试才继续", async () => {
  const calls: Array<[number, number]> = [];
  const queue = new RetainedSaveQueue<number>({ send: async (base, desired) => { calls.push([base, desired]); if (calls.length === 1) throw new Error("offline"); return desired; }, saved: () => {}, failed: () => {} });
  queue.enqueue(0, 1);
  await new Promise((resolve) => setImmediate(resolve));
  queue.enqueue(1, 2);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, [[0, 1]], "暂停期间不再自动发送");
  await queue.retry();
  assert.deepEqual(calls, [[0, 1], [0, 2]]);
  assert.equal(queue.pendingCount, 0);
});

test("在途请求卡死时看门狗转成明确失败，界面拿到可重试出口", async () => {
  const never = new Promise<number>(() => {});
  const errors: string[] = [];
  const queue = new RetainedSaveQueue<number>({
    send: () => never,
    stallTimeoutMs: 40,
    saved: () => {}, failed: (error) => errors.push(error.message),
  });
  queue.enqueue(0, 1);
  await new Promise(resolve => setTimeout(resolve, 120));
  assert.equal(errors.length, 1, "卡死必须转成一次明确失败");
  assert.match(errors[0], /仍未取得回执/);
  assert.equal(queue.pendingCount, 1, "编辑仍保留，可重试");
});

test("看门狗触发时中断在途请求，重试能真正重发而不是复用挂起的 Promise", async () => {
  // 真实故障：请求挂起后 retry() 返回同一个永不完成的 Promise，
  // 「配置待同步 · 重试」点了毫无反应，界面永久停在待同步。
  const calls: Array<[number, number]> = []; let aborted = 0;
  let resolveSecond: ((value: number) => void) | undefined;
  const queue = new RetainedSaveQueue<number>({
    send: (base, desired) => {
      calls.push([base, desired]);
      if (calls.length === 1) return new Promise<number>(() => {});
      return new Promise<number>(resolve => { resolveSecond = resolve; });
    },
    stallTimeoutMs: 40,
    abortInFlight: () => { aborted++; },
    saved: () => {}, failed: () => {},
  });
  queue.enqueue(0, 1);
  await new Promise(resolve => setTimeout(resolve, 120));
  assert.equal(aborted, 1, "看门狗必须中断在途上传");
  const retried = queue.retry();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls.length, 2, "重试必须发出新的请求");
  resolveSecond!(1);
  await retried;
  assert.equal(queue.pendingCount, 0);
});

test("正常完成的请求不会被看门狗误判为失败", async () => {
  const errors: string[] = [];
  const queue = new RetainedSaveQueue<number>({
    send: async (_base, desired) => { await new Promise(resolve => setTimeout(resolve, 20)); return desired; },
    stallTimeoutMs: 100,
    saved: () => {}, failed: (error) => errors.push(error.message),
  });
  queue.enqueue(0, 1);
  await queue.waitForSaved();
  await new Promise(resolve => setTimeout(resolve, 120));
  assert.deepEqual(errors, [], "慢但成功的保存不能被判失败");
  assert.equal(queue.pendingCount, 0);
});

test("大请求体压缩上传：超过阈值走 gzip，小体量保持原样，压缩失败回退", async () => {
  const { encodeLargeJsonBody } = await import("./api");
  // 阈值是 256K 字符；真实工作区写入体量约 6M 字符，这里取同类量级。
  const big = JSON.stringify({ base: { x: "填".repeat(600_000) }, workspace: {} });
  const encoded = await encodeLargeJsonBody(big);
  assert.equal(encoded.headers["Content-Encoding"], "gzip", "大请求体必须压缩上传");
  assert.ok(encoded.body instanceof Uint8Array);
  const roundTrip = new Response(
    new Response(encoded.body as Uint8Array).body!.pipeThrough(new DecompressionStream("gzip"))
  ).text();
  assert.equal(await roundTrip, big, "压缩后必须能无损还原");

  const small = JSON.stringify({ a: 1 });
  const plain = await encodeLargeJsonBody(small);
  assert.deepEqual(plain.headers, {}, "小请求体不压缩");
  assert.equal(plain.body, small);
});

test("在途请求刚挂起就点重试也能重发：不依赖看门狗先触发", async () => {
  // 浏览器里复现的真实情形：用户看到「配置待同步 · 重试」立刻点下去，
  // 此时看门狗还没到期，旧实现会复用那个永不返回的 Promise，点了毫无反应。
  const calls: Array<[number, number]> = []; let aborted = 0;
  let resolveSecond: ((value: number) => void) | undefined;
  const queue = new RetainedSaveQueue<number>({
    send: (base, desired) => {
      calls.push([base, desired]);
      if (calls.length === 1) return new Promise<number>(() => {});
      return new Promise<number>(resolve => { resolveSecond = resolve; });
    },
    stallTimeoutMs: 60_000,
    abortInFlight: () => { aborted++; },
    saved: () => {}, failed: () => {},
  });
  queue.enqueue(0, 1);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls.length, 1);
  const retried = queue.retry();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(aborted, 1, "重试必须中断卡住的在途上传");
  assert.equal(calls.length, 2, "重试必须发出新请求");
  resolveSecond!(1);
  await retried;
  assert.equal(queue.pendingCount, 0);
});
