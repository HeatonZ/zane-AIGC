import test from "node:test";
import assert from "node:assert/strict";
import { productionHarness } from "../testing/productionSupport.js";
import { id, submission, workflow } from "../testing/testSupport.js";
import { resolveIterationConcurrency } from "../domain/iterationConcurrency.js";
import { externalizeRuntimeValue } from "../domain/workflowValues.js";
import { HttpError } from "../errors.js";
import type { JsonValue, RunStep } from "../domain/types.js";

/** Fake for_each step that records execution order and peak concurrency. */
function countingExecutor() {
  const calls: number[] = [];
  let active = 0;
  let maxActive = 0;
  return {
    calls, get maxActive() { return maxActive; },
    executor: {
      kind: "fake",
      async execute({ inputValues }: { inputValues: Record<string, JsonValue> }) {
        if (inputValues["iteration.item"] === undefined) return { value: "non-iteration" };
        const item = Number(externalizeRuntimeValue(inputValues["iteration.item"]));
        calls.push(item);
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise(resolve => setTimeout(resolve, 10));
        active -= 1;
        return { value: String(item) };
      },
    },
  };
}

/** Deterministic concurrency probe: every dispatched worker blocks until `expected` workers are in
 *  flight, so a lower effective concurrency fails fast instead of depending on timing. */
function barrierExecutor(expected: number) {
  const calls: number[] = [];
  let active = 0;
  let maxActive = 0;
  let release!: () => void;
  const reached = new Promise<void>(resolve => { release = resolve; });
  return {
    calls, get maxActive() { return maxActive; },
    executor: {
      kind: "fake",
      async execute({ inputValues }: { inputValues: Record<string, JsonValue> }) {
        if (inputValues["iteration.item"] === undefined) return { value: "non-iteration" };
        const item = Number(externalizeRuntimeValue(inputValues["iteration.item"]));
        calls.push(item);
        active += 1;
        maxActive = Math.max(maxActive, active);
        if (active >= expected) release();
        await Promise.race([
          reached,
          new Promise((_resolve, reject) => setTimeout(() => reject(new Error(`并发未达到 ${expected}：实际最多 ${maxActive}`)), 4000)),
        ]);
        active -= 1;
        return { value: String(item) };
      },
    },
  };
}

function batchStep(execution: RunStep["execution"], extra: Partial<RunStep> = {}): RunStep {
  return { id: "batch", name: "整批", kind: "fake", execution, outputs: [{ key: "value", type: "text" }], ...extra };
}

const items = (count: number) => Array.from({ length: count }, (_value, index) => index);

test("循环内审核点：第2项后暂停，批准后继续剩余项且不重复前段", async t => {
  const counter = countingExecutor();
  const h = await productionHarness(t, counter.executor); await h.service.start();
  const definition = workflow([
    batchStep({ mode: "for_each", sourceRef: "input.items", maxConcurrency: 2, reviewAfterItems: 2 }),
    { id: "tail", name: "尾步", kind: "fake", outputs: [{ key: "value", type: "text" }] },
  ]);
  definition.inputs = [{ key: "items", type: "json", required: true }];
  const run = await h.service.submit(submission(id("checkpoint-basic"), definition, { items: items(10) }));
  const waiting = await h.service.wait(h.settings.projectDirectory, run.runId);
  assert.equal(waiting.status, "waiting");
  assert.equal(waiting.finishedAt, undefined);
  assert.equal(waiting.pendingReview?.scope, "batch_items");
  assert.equal(waiting.pendingReview?.afterItems, 2);
  assert.equal(waiting.steps[0].status, "running");
  assert.equal(waiting.steps[0].finishedAt, undefined);
  assert.deepEqual(waiting.steps[0].items?.map(item => item.index), [0, 1]);
  // The checkpoint is a scheduling barrier: nothing at or after item 2 was dispatched yet.
  assert.deepEqual([...counter.calls].sort((left, right) => left - right), [0, 1]);
  // 峰值并发只断言上界：executeStep 之前要先串行写 checkpoint，两项是否恰好重叠取决于时序，
  // 不能拿它当正确性判据（精确并发由“并发10”用例的闸门确定性验证）。
  assert.ok(counter.maxActive <= 2, `确认点前并发不得超过步骤上限：${counter.maxActive}`);

  await h.service.review(h.settings.projectDirectory, run.runId, { reviewId: waiting.pendingReview!.id, action: "approve" });
  const done = await h.service.wait(h.settings.projectDirectory, run.runId);
  assert.equal(done.status, "completed");
  assert.equal(counter.calls.length, 10, "已确认的前段不能重新生成");
  assert.deepEqual([...counter.calls].sort((left, right) => left - right), items(10));
  assert.deepEqual(done.steps[0].items?.map(item => item.index), items(10));
  assert.equal(done.steps[0].status, "completed");
  assert.equal(done.reviewHistory?.length, 1);
});

test("循环内审核点退回：只重做截止该点的那一段并再次暂停", async t => {
  const counter = countingExecutor();
  const h = await productionHarness(t, counter.executor); await h.service.start();
  const definition = workflow([batchStep({ mode: "for_each", sourceRef: "input.items", maxConcurrency: 2, reviewAfterItems: 2 })]);
  definition.inputs = [{ key: "items", type: "json", required: true }];
  const run = await h.service.submit(submission(id("checkpoint-redo"), definition, { items: items(6) }));
  const first = await h.service.wait(h.settings.projectDirectory, run.runId);
  assert.equal(first.pendingReview?.scope, "batch_items");
  await h.service.review(h.settings.projectDirectory, run.runId, { reviewId: first.pendingReview!.id, action: "redo" });
  const again = await h.service.wait(h.settings.projectDirectory, run.runId);
  assert.equal(again.status, "waiting");
  assert.notEqual(again.pendingReview!.id, first.pendingReview!.id);
  assert.equal(again.pendingReview?.scope, "batch_items");
  assert.equal(again.pendingReview?.afterItems, 2);
  assert.deepEqual(again.steps[0].items?.map(item => item.index), [0, 1]);
  // Only the confirmed segment was regenerated; items 2..5 were never dispatched.
  assert.deepEqual([...counter.calls].sort((left, right) => left - right), [0, 0, 1, 1]);
  await h.service.review(h.settings.projectDirectory, run.runId, { reviewId: again.pendingReview!.id, action: "approve" });
  const done = await h.service.wait(h.settings.projectDirectory, run.runId);
  assert.equal(done.status, "completed");
  assert.equal(counter.calls.length, 8);
  assert.equal(done.pendingReview, undefined);
});

test("循环内审核点与步骤结尾审核独立：中途确认后跑完仍可在步骤边界暂停", async t => {
  const counter = countingExecutor();
  const h = await productionHarness(t, counter.executor); await h.service.start();
  const definition = workflow([
    batchStep({ mode: "for_each", sourceRef: "input.items", maxConcurrency: 1, reviewAfterItems: 2 }, { review: { enabled: true, instruction: "看这两张" } }),
    { id: "tail", name: "尾步", kind: "fake", outputs: [{ key: "value", type: "text" }] },
  ]);
  definition.inputs = [{ key: "items", type: "json", required: true }];
  const run = await h.service.submit(submission(id("checkpoint-plus-step-review"), definition, { items: items(4) }));
  const first = await h.service.wait(h.settings.projectDirectory, run.runId);
  assert.equal(first.pendingReview?.scope, "batch_items");
  assert.equal(first.pendingReview?.instruction, "看这两张");
  await h.service.review(h.settings.projectDirectory, run.runId, { reviewId: first.pendingReview!.id, action: "approve" });
  const second = await h.service.wait(h.settings.projectDirectory, run.runId);
  assert.equal(second.status, "waiting");
  assert.equal(second.pendingReview?.scope, undefined);
  assert.equal(second.pendingReview?.afterItems, undefined);
  assert.equal(second.steps[0].status, "completed");
  assert.equal(counter.calls.length, 4);
  await h.service.review(h.settings.projectDirectory, run.runId, { reviewId: second.pendingReview!.id, action: "approve" });
  const done = await h.service.wait(h.settings.projectDirectory, run.runId);
  assert.equal(done.status, "completed");
  assert.equal(counter.calls.length, 4, "步骤边界确认不重复生成");
});

test("审核点不小于遍历项数时不暂停，并在步骤上留下提示", async t => {
  const counter = countingExecutor();
  const h = await productionHarness(t, counter.executor); await h.service.start();
  const definition = workflow([batchStep({ mode: "for_each", sourceRef: "input.items", maxConcurrency: 2, reviewAfterItems: 5 })]);
  definition.inputs = [{ key: "items", type: "json", required: true }];
  const run = await h.service.submit(submission(id("checkpoint-out-of-range"), definition, { items: items(3) }));
  const done = await h.service.wait(h.settings.projectDirectory, run.runId);
  assert.equal(done.status, "completed");
  assert.equal(done.pendingReview, undefined);
  assert.ok(done.steps[0].warnings?.some(warning => /审核点第 5 项未触发/.test(warning)), JSON.stringify(done.steps[0].warnings));
});

test("onError=stop 的段内失败按失败处理，不伪装成循环内确认", async t => {
  const h = await productionHarness(t, {
    kind: "fake",
    async execute({ inputValues }: { inputValues: Record<string, JsonValue> }) {
      const item = Number(externalizeRuntimeValue(inputValues["iteration.item"]));
      if (item === 1) throw new Error("第2项失败");
      return { value: String(item) };
    },
  }); await h.service.start();
  const definition = workflow([batchStep({ mode: "for_each", sourceRef: "input.items", maxConcurrency: 1, onError: "stop", reviewAfterItems: 2 })]);
  definition.inputs = [{ key: "items", type: "json", required: true }];
  const run = await h.service.submit(submission(id("checkpoint-stop"), definition, { items: items(4) }));
  const failed = await h.service.wait(h.settings.projectDirectory, run.runId);
  assert.equal(failed.status, "failed");
  assert.equal(failed.pendingReview, undefined);
  assert.equal(failed.steps[0].status, "failed");
});

test("并发引用跟随数字输入；留空表示不限制，只受项数上限约束", async t => {
  // 6 items with concurrency 3: exactly 3 workers may be in flight, never 4.
  const limited = barrierExecutor(3);
  const h = await productionHarness(t, limited.executor); await h.service.start();
  const definition = workflow([batchStep({ mode: "for_each", sourceRef: "input.items", maxConcurrencyRef: "input.concurrency" })]);
  definition.inputs = [{ key: "items", type: "json", required: true }, { key: "concurrency", type: "number", required: false }];
  const capped = await h.service.submit(submission(id("concurrency-ref-limited"), definition, { items: items(6), concurrency: 3 }));
  assert.equal((await h.service.wait(h.settings.projectDirectory, capped.runId)).status, "completed");
  assert.equal(limited.maxActive, 3, "并发必须跟随输入值且不超过它");
  assert.equal(limited.calls.length, 6);

  // An empty value means "no configured limit": every item of this batch runs at once.
  const unlimited = barrierExecutor(6);
  const h2 = await productionHarness(t, unlimited.executor); await h2.service.start();
  const definition2 = workflow([batchStep({ mode: "for_each", sourceRef: "input.items", maxConcurrencyRef: "input.concurrency" })]);
  definition2.inputs = definition.inputs;
  const open = await h2.service.submit(submission(id("concurrency-ref-empty"), definition2, { items: items(6) }));
  assert.equal((await h2.service.wait(h2.settings.projectDirectory, open.runId)).status, "completed");
  assert.equal(unlimited.maxActive, 6, "留空等于不限制，只受遍历项数上限约束");
});

test("非法并发值在提交期直接拒绝，不进入执行", async t => {
  const counter = countingExecutor();
  const h = await productionHarness(t, counter.executor); await h.service.start();
  const definition = workflow([batchStep({ mode: "for_each", sourceRef: "input.items", maxConcurrencyRef: "input.concurrency" })]);
  definition.inputs = [{ key: "items", type: "json", required: true }, { key: "concurrency", type: "number", required: false }];
  for (const bad of [0, -1, 2.5, 33]) {
    await assert.rejects(
      h.service.submit(submission(id(`concurrency-ref-bad-${bad}`), definition, { items: items(3), concurrency: bad })),
      (error: unknown) => error instanceof HttpError && error.status === 400 && error.code === "INVALID_ITERATION_CONCURRENCY",
      `并发 ${bad} 必须被拒绝`,
    );
  }
  assert.deepEqual(counter.calls, []);
});

test("并发引用必须指向已声明的数字输入，且与静态并发互斥", async t => {
  const h = await productionHarness(t); await h.service.start();
  const definition = workflow([batchStep({ mode: "for_each", sourceRef: "input.items", maxConcurrency: 2, maxConcurrencyRef: "input.concurrency" })]);
  definition.inputs = [{ key: "items", type: "json", required: true }, { key: "concurrency", type: "number", required: false }];
  await assert.rejects(h.service.submit(submission(id("concurrency-ref-conflict"), definition, { items: items(2), concurrency: 2 })), /不能同时配置/);

  const textRef = workflow([batchStep({ mode: "for_each", sourceRef: "input.items", maxConcurrencyRef: "input.label" })]);
  textRef.inputs = [{ key: "items", type: "json", required: true }, { key: "label", type: "text", required: false }];
  await assert.rejects(h.service.submit(submission(id("concurrency-ref-text"), textRef, { items: items(2), label: "3" })), /数字输入/);

  const missing = workflow([batchStep({ mode: "for_each", sourceRef: "input.items", maxConcurrencyRef: "input.unknown" })]);
  missing.inputs = [{ key: "items", type: "json", required: true }];
  await assert.rejects(h.service.submit(submission(id("concurrency-ref-missing"), missing, { items: items(2) })), /数字输入/);

  const onceStep = workflow([batchStep({ mode: "once", maxConcurrencyRef: "input.concurrency" })]);
  onceStep.inputs = [{ key: "concurrency", type: "number", required: false }];
  await assert.rejects(h.service.submit(submission(id("concurrency-ref-once"), onceStep, { concurrency: 2 })), /for_each/);
});

test("并发10 + 第2项审核点：确认时恰好2张，批准后剩余项按全部并发继续", async t => {
  const calls: number[] = [];
  let active = 0;
  let maxActive = 0;
  let exhaustRemaining = false;
  let release!: () => void;
  const allRemainingInFlight = new Promise<void>(resolve => { release = resolve; });
  const h = await productionHarness(t, {
    kind: "fake",
    async execute({ inputValues }: { inputValues: Record<string, JsonValue> }) {
      if (inputValues["iteration.item"] === undefined) return { value: "non-iteration" };
      const item = Number(externalizeRuntimeValue(inputValues["iteration.item"]));
      calls.push(item);
      active += 1;
      maxActive = Math.max(maxActive, active);
      if (exhaustRemaining) {
        // 4 项剩余：只有真的同时放行 4 个并发，这个闸门才会打开；串行或只放 2 个都会超时失败。
        if (active >= 4) release();
        await Promise.race([
          allRemainingInFlight,
          new Promise((_resolve, reject) => setTimeout(() => reject(new Error(`剩余项并发不足：最多 ${maxActive} 个同时在飞`)), 4000)),
        ]);
      } else {
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      active -= 1;
      return { value: String(item) };
    },
  }); await h.service.start();
  const definition = workflow([batchStep({ mode: "for_each", sourceRef: "input.items", onError: "continue", maxConcurrency: 10, reviewAfterItems: 2 })]);
  definition.inputs = [{ key: "items", type: "json", required: true }];
  const run = await h.service.submit(submission(id("checkpoint-concurrency-10"), definition, { items: items(6) }));
  const waiting = await h.service.wait(h.settings.projectDirectory, run.runId);
  assert.equal(waiting.status, "waiting");
  assert.equal(waiting.pendingReview?.afterItems, 2);
  // 关键：并发是 10，但确认点前只派发 2 项——没有第 3 张被提前生成、也没有多花钱。
  assert.deepEqual(waiting.steps[0].items?.map(item => item.index), [0, 1]);
  assert.deepEqual([...calls].sort((left, right) => left - right), [0, 1]);
  assert.ok(maxActive <= 2, `确认点前并发被屏障限制在 2，而不是 10：实际 ${maxActive}`);
  exhaustRemaining = true;
  await h.service.review(h.settings.projectDirectory, run.runId, { reviewId: waiting.pendingReview!.id, action: "approve" });
  const done = await h.service.wait(h.settings.projectDirectory, run.runId);
  assert.equal(done.status, "completed");
  assert.equal(calls.length, 6, "前 2 张复用，不重复生成");
  assert.deepEqual([...calls].sort((left, right) => left - right), items(6));
  assert.equal(maxActive, 4, "批准后剩余 4 项全部同时在飞（步骤并发 10 生效）");
});

test("确认点前段有失败项：仍然停下确认，批准后补跑失败项、复用成功项", async t => {
  const calls: number[] = [];
  let failFirst = true;
  const h = await productionHarness(t, {
    kind: "fake",
    async execute({ inputValues }: { inputValues: Record<string, JsonValue> }) {
      if (inputValues["iteration.item"] === undefined) return { value: "non-iteration" };
      const item = Number(externalizeRuntimeValue(inputValues["iteration.item"]));
      calls.push(item);
      if (item === 0 && failFirst) throw new Error("第1张失败");
      return { value: String(item) };
    },
  }); await h.service.start();
  const definition = workflow([batchStep({ mode: "for_each", sourceRef: "input.items", onError: "continue", maxConcurrency: 2, reviewAfterItems: 2 })]);
  definition.inputs = [{ key: "items", type: "json", required: true }];
  const run = await h.service.submit(submission(id("checkpoint-segment-failure"), definition, { items: items(4) }));
  const waiting = await h.service.wait(h.settings.projectDirectory, run.runId);
  // onError=continue 的段内失败不是硬停止：批次挂起等确认，失败项如实留在逐项记录里。
  assert.equal(waiting.status, "waiting");
  assert.equal(waiting.pendingReview?.scope, "batch_items");
  assert.deepEqual(waiting.steps[0].items?.map(item => `${item.index}:${item.status}`), ["0:failed", "1:completed"]);
  assert.ok(waiting.steps[0].warnings?.some(warning => /有逐项失败/.test(warning)), JSON.stringify(waiting.steps[0].warnings));
  failFirst = false;
  await h.service.review(h.settings.projectDirectory, run.runId, { reviewId: waiting.pendingReview!.id, action: "approve" });
  const done = await h.service.wait(h.settings.projectDirectory, run.runId);
  assert.equal(done.status, "completed");
  // 第 1 张补跑（没有已完成结果可复用），第 2 张复用不重跑，其余继续。
  assert.equal(calls.filter(item => item === 1).length, 1, "已完成项不重复生成");
  assert.deepEqual([...calls].sort((left, right) => left - right), [0, 0, 1, 2, 3]);
  assert.ok(done.steps[0].warnings?.some(warning => /失败，会随本次续跑重新执行/.test(warning)), JSON.stringify(done.steps[0].warnings));
});

test("并发解析器直接拒绝非数字与越界值", () => {
  const step = batchStep({ mode: "for_each", sourceRef: "input.items", maxConcurrencyRef: "input.concurrency" }) as RunStep;
  assert.equal(resolveIterationConcurrency(step, { concurrency: 4 } as Record<string, JsonValue>).value, 4);
  assert.deepEqual(resolveIterationConcurrency(step, {} as Record<string, JsonValue>), { value: 32, unlimited: true, source: "reference" });
  assert.equal(resolveIterationConcurrency(batchStep({ mode: "for_each", sourceRef: "input.items" }) as RunStep, {} as Record<string, JsonValue>).value, 1);
  assert.equal(resolveIterationConcurrency(batchStep({ mode: "for_each", sourceRef: "input.items", maxConcurrency: 8, carry: { outputKey: "value" } }) as RunStep, {} as Record<string, JsonValue>).value, 1);
  for (const bad of ["3", 0, 33, 1.5, true]) {
    assert.throws(() => resolveIterationConcurrency(step, { concurrency: bad as JsonValue } as Record<string, JsonValue>), (error: unknown) => error instanceof HttpError && error.code === "INVALID_ITERATION_CONCURRENCY");
  }
});
