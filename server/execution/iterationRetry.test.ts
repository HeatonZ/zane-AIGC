import assert from "node:assert/strict";
import test from "node:test";
import { HttpError } from "../errors.js";
import type { JsonValue, RunWorkflowDefinition } from "../domain/types.js";
import { validateWorkflowShape } from "../domain/workflowValidation.js";
import { iterationRetryPolicy, itemRetryDelayMs, MAX_ITEM_RETRIES } from "../domain/iterationRetry.js";
import { isTransientItemFailure } from "./itemRetry.js";
import { parseHermesOutput, HermesOutputParseError } from "./hermesOutput.js";
import { HermesTransientError } from "../hermesTransport.js";
import { workflowDocument } from "../ai/sceneSchemas.js";
import { harness, workflow, submission, id, until, deferred } from "../testing/testSupport.js";

/**
 * `execution.itemRetries` (for_each only): one transient upstream hiccup must not fail the whole
 * pipeline, while deterministic failures still fail on the first attempt.
 */

const loopWorkflow = (execution: Record<string, unknown>, extra: { carry?: boolean } = {}): RunWorkflowDefinition => {
  const flow = workflow([{
    id: "loop", name: "逐项", kind: "fake",
    inputs: extra.carry ? [{ key: "previous", sourceRef: "iteration.previous" }, { key: "item", sourceRef: "iteration.item" }] : [],
    outputs: [{ key: "value", type: "json" }],
    execution: { mode: "for_each", sourceRef: "input.items", ...execution } as never,
  }]);
  flow.inputs = [{ key: "items", type: "json", required: true }];
  flow.outputs[0].type = "json";
  flow.outputs[0].sourceRef = "step.loop.outputs.value";
  return flow;
};

test("瞬时失败一次后重试成功：该项 completed、步骤 completed，且重试进 warnings", async (t) => {
  let calls = 0;
  const h = await harness(t, { executor: { kind: "fake", async execute() {
    calls += 1;
    if (calls === 1) throw new HermesTransientError("Hermes API 请求失败：429 上游限流", 429);
    return { value: "ok" };
  } } });
  await h.service.start();
  await h.service.submit(submission(id("retry-success"), loopWorkflow({ itemRetries: 2, itemRetryDelaySeconds: 0 }), { items: [1] }));
  const result = await h.service.wait(h.settings.projectDirectory, id("retry-success"));
  assert.equal(result.status, "completed", result.error);
  assert.equal(calls, 2);
  assert.equal(result.steps[0].status, "completed");
  const item = result.steps[0].items![0]!;
  assert.equal(item.status, "completed");
  assert.deepEqual(item.outputs, { value: "ok" });
  assert.equal(item.warnings?.length, 1);
  assert.match(item.warnings![0]!, /第 1 项第 1 次尝试遇到瞬时失败：Hermes API 请求失败：429 上游限流；0 秒后重试第 2 次/);
  assert.match(item.warnings![0]!, /可能计费/);
  assert.equal(item.error, undefined, "成功重试后不得残留失败原因");
});

test("确定性失败不重试：只调用一次并走原失败路径", async (t) => {
  let calls = 0;
  const h = await harness(t, { executor: { kind: "fake", async execute() {
    calls += 1;
    throw new Error("Hermes Profile「writer」API 密钥认证失败");
  } } });
  await h.service.start();
  await h.service.submit(submission(id("retry-deterministic"), loopWorkflow({ itemRetries: 3, itemRetryDelaySeconds: 0 }), { items: [1] }));
  const result = await h.service.wait(h.settings.projectDirectory, id("retry-deterministic"));
  assert.equal(result.status, "failed");
  assert.equal(calls, 1, "鉴权类失败必须只尝试一次");
  const item = result.steps[0].items![0]!;
  assert.equal(item.status, "failed");
  assert.match(item.error!, /认证失败/);
  assert.equal(item.warnings, undefined, "未发生重试时不得写入重试提示");
});

test("重试耗尽后走原 stop 路径：失败项与整步 failed，错误取最后一次", async (t) => {
  let calls = 0;
  const h = await harness(t, { executor: { kind: "fake", async execute() {
    calls += 1;
    throw new HermesTransientError(`Hermes API 请求失败：第 ${calls} 次上游 503`, 503);
  } } });
  await h.service.start();
  await h.service.submit(submission(id("retry-exhausted"), loopWorkflow({ itemRetries: 2, itemRetryDelaySeconds: 0, onError: "stop" }), { items: [1, 2] }));
  const result = await h.service.wait(h.settings.projectDirectory, id("retry-exhausted"));
  assert.equal(result.status, "failed");
  // Item 0 exhausts 1 + 2 attempts, then onError:stop halts scheduling so item 1 never starts.
  assert.equal(calls, 3);
  assert.equal(result.steps[0].status, "failed");
  assert.equal(result.steps[0].items!.length, 1, "stop 之后不得派发后继项");
  const item = result.steps[0].items![0]!;
  assert.equal(item.status, "failed");
  assert.match(item.error!, /第 3 次上游 503/);
  assert.equal(item.warnings?.length, 2, "每次重试各留一条提示");
});

test("carry + 重试组合：重试仍在单项内部，串行状态链不被破坏", async (t) => {
  let calls = 0;
  const seen: JsonValue[] = [];
  const flow = loopWorkflow({ itemRetries: 1, itemRetryDelaySeconds: 0, carry: { outputKey: "value" } }, { carry: true });
  const h = await harness(t, { executor: { kind: "fake", async execute(c) {
    calls += 1;
    seen.push(c.inputValues["iteration.previous"] as JsonValue);
    // The first attempt of the second item is transient: the retry must not restart the chain.
    if (calls === 3) throw new HermesTransientError("Hermes API 请求超时（单步上限 30 分钟）");
    const previous = (c.inputValues["iteration.previous"] as { sum?: number } | null)?.sum ?? 0;
    return { value: { sum: previous + Number(c.inputValues["iteration.item"]) } };
  } } });
  await h.service.start();
  await h.service.submit(submission(id("retry-carry"), flow, { items: [1, 2, 3] }));
  const result = await h.service.wait(h.settings.projectDirectory, id("retry-carry"));
  assert.equal(result.status, "completed", result.error);
  assert.equal(calls, 4);
  assert.deepEqual(result.outputs[0]?.value, [{ sum: 1 }, { sum: 3 }, { sum: 6 }]);
  assert.deepEqual(result.steps[0].items!.map((item) => item.status), ["completed", "completed", "completed"]);
  assert.equal(result.steps[0].items![2]!.warnings?.length, 1);
  // The retried attempt sees the same predecessor state: the chain was never restarted.
  assert.deepEqual(seen[2], { sum: 3 });
  assert.deepEqual(seen[3], { sum: 3 });
});

test("重试等待期间取消：立刻中止，不再发起下一次尝试", async (t) => {
  const entered = deferred<void>();
  let calls = 0;
  const h = await harness(t, { executor: { kind: "fake", async execute() {
    calls += 1;
    entered.resolve();
    throw new HermesTransientError("Hermes API 请求失败：503 上游不可用", 503);
  } } });
  await h.service.start();
  await h.service.submit(submission(id("retry-cancel"), loopWorkflow({ itemRetries: 3, itemRetryDelaySeconds: 30 }), { items: [1] }));
  await entered.promise;
  await until(() => calls === 1);
  const started = Date.now();
  await h.service.cancel(h.settings.projectDirectory, id("retry-cancel"));
  const result = await h.service.wait(h.settings.projectDirectory, id("retry-cancel"));
  assert.equal(result.status, "cancelled");
  assert.ok(Date.now() - started < 5_000, "取消必须打断 30 秒的等待");
  assert.equal(calls, 1, "取消后不得再调用模型");
  assert.equal(result.steps[0].items![0]!.status, "cancelled");
});

test("省略新字段时行为与改动前一致：单次尝试、无重试提示、原错误原样保留", async (t) => {
  const runOnce = async (label: string, execution: Record<string, unknown>) => {
    let calls = 0;
    const h = await harness(t, { executor: { kind: "fake", async execute() { calls += 1; throw new Error("步骤执行失败：确定性错误"); } } });
    await h.service.start();
    await h.service.submit(submission(id(label), loopWorkflow(execution), { items: [1] }));
    const result = await h.service.wait(h.settings.projectDirectory, id(label));
    return { calls, status: result.status, item: result.steps[0].items![0]!, stepStatus: result.steps[0].status };
  };
  const omitted = await runOnce("retry-omitted", {});
  const zero = await runOnce("retry-zero", { itemRetries: 0 });
  assert.equal(omitted.calls, 1);
  assert.equal(zero.calls, 1);
  assert.equal(omitted.status, "failed");
  assert.equal(omitted.stepStatus, "failed");
  assert.equal(omitted.item.status, "failed");
  assert.equal(omitted.item.error, "步骤执行失败：确定性错误");
  assert.equal(omitted.item.warnings, undefined);
  // itemRetries: 0 is the same shape as omitting it: nothing about the record changes.
  assert.deepEqual(
    { status: zero.item.status, error: zero.item.error, warnings: zero.item.warnings, outputs: zero.item.outputs },
    { status: omitted.item.status, error: omitted.item.error, warnings: omitted.item.warnings, outputs: omitted.item.outputs },
  );
  // The policy itself is the historical single attempt when the fields are absent.
  assert.deepEqual(iterationRetryPolicy(undefined), { attempts: 0, delayMs: 5_000 });
  assert.deepEqual(iterationRetryPolicy({}), { attempts: 0, delayMs: 5_000 });
});

test("校验边界：负数/小数/超上限/非数字/非for_each一律 400，不静默回退", () => {
  const invalidCases: Array<[Record<string, unknown>, RegExp]> = [
    [{ itemRetries: -1 }, /逐项重试次数/],
    [{ itemRetries: 1.5 }, /逐项重试次数/],
    [{ itemRetries: MAX_ITEM_RETRIES + 1 }, /逐项重试次数/],
    [{ itemRetries: "2" }, /逐项重试次数/],
    [{ itemRetries: Number.NaN }, /逐项重试次数/],
    [{ itemRetryDelaySeconds: -1 }, /逐项重试等待秒数/],
    [{ itemRetryDelaySeconds: 0.5 }, /逐项重试等待秒数/],
    [{ itemRetryDelaySeconds: 61 }, /逐项重试等待秒数/],
    [{ itemRetryDelaySeconds: "5" }, /逐项重试等待秒数/],
  ];
  for (const [config, pattern] of invalidCases) {
    const flow = loopWorkflow(config);
    assert.throws(() => validateWorkflowShape(flow as unknown as Record<string, unknown>), (error: unknown) => {
      assert.ok(error instanceof HttpError);
      assert.equal(error.status, 400, JSON.stringify(config));
      assert.match(error.message, pattern);
      return true;
    }, JSON.stringify(config));
  }
  // Both fields are for_each-only; a `once` step must reject them instead of ignoring them.
  for (const config of [{ itemRetries: 2 }, { itemRetryDelaySeconds: 10 }]) {
    const flow = loopWorkflow({ mode: "once", ...config });
    assert.throws(() => validateWorkflowShape(flow as unknown as Record<string, unknown>), (error: unknown) => {
      assert.ok(error instanceof HttpError);
      assert.equal(error.status, 400);
      assert.match(error.message, /仅支持步骤级for_each/);
      return true;
    }, JSON.stringify(config));
  }
  // Valid bounds are accepted (0..3 retries, 0..60 seconds).
  for (const config of [{ itemRetries: 0 }, { itemRetries: 3 }, { itemRetryDelaySeconds: 0 }, { itemRetryDelaySeconds: 60 }, { itemRetries: 2, itemRetryDelaySeconds: 7 }]) {
    assert.doesNotThrow(() => validateWorkflowShape(loopWorkflow(config) as unknown as Record<string, unknown>), JSON.stringify(config));
  }
});

test("AI 契约层同样拒绝越界值：草稿 schema 不静默回退", () => {
  const document = (execution: Record<string, unknown>) => ({
    name: "流程", inputs: [{ key: "items", type: "json", required: true }],
    steps: [{ id: "loop", name: "逐项", kind: "hermes", hermesProfile: "writer", promptTemplate: "x", outputs: [{ key: "prompt", type: "text" }], execution: { mode: "for_each", sourceRef: "input.items", ...execution } }],
    outputs: [{ key: "prompt", type: "text", sourceRef: "step.loop.outputs.prompt" }],
  });
  for (const execution of [{ itemRetries: -1 }, { itemRetries: 4 }, { itemRetries: 1.5 }, { itemRetryDelaySeconds: 61 }, { itemRetryDelaySeconds: -1 }, { itemRetryDelaySeconds: 0.5 }]) {
    assert.equal(workflowDocument.safeParse(document(execution)).success, false, JSON.stringify(execution));
  }
  assert.equal(workflowDocument.safeParse(document({ itemRetries: 2, itemRetryDelaySeconds: 3 })).success, true);
  assert.equal(workflowDocument.safeParse(document({})).success, true, "省略时保持历史行为");
});

test("本次故障串判为可重试：上游断流的输出解析失败带 transient 标记", () => {
  // 复刻 run eb150e13 的真实形状：上游流式残段在 position 2276 处写入裸 CRLF，随后从头重出
  // 第二个 {"prompt":...}。同一形状在真实样本上给出的就是这条消息（已实测）。
  const prefix = '{"prompt":"';
  const residual = prefix + "a".repeat(2276 - prefix.length) + "\r\n";
  let captured: unknown;
  try {
    parseHermesOutput(residual + '{"prompt":"完整的第二次输出"}', ["prompt"]);
  } catch (error) {
    captured = error;
  }
  // The streamed-residual family may repair this exact sample; if it still fails, the failure
  // must carry the stream-artifact signature and therefore be classed retryable.
  if (captured !== undefined) {
    assert.ok(captured instanceof HermesOutputParseError);
    assert.equal(captured.transient, true);
    assert.equal(isTransientItemFailure(captured), true);
  }
  // A cut-off root (no re-emission) is the other half of the same upstream signature.
  let cutOff: unknown;
  try {
    parseHermesOutput(prefix + "a".repeat(40), ["prompt"]);
  } catch (error) {
    cutOff = error;
  }
  assert.ok(cutOff instanceof HermesOutputParseError);
  assert.equal(cutOff.transient, true);
  assert.equal(isTransientItemFailure(cutOff), true);
  // The real failure message the executor saw keeps its published wording.
  assert.match(cutOff.message, /^Hermes 输出 JSON 格式无效：/);
  assert.match(cutOff.message, /；未截断内容或自动重试模型$/);
  // Content-level garbage is a deterministic defect: never retried.
  let contentLevel: unknown;
  try {
    parseHermesOutput("这不是 JSON 输出", ["prompt"]);
  } catch (error) {
    contentLevel = error;
  }
  assert.ok(contentLevel instanceof HermesOutputParseError);
  assert.equal(isTransientItemFailure(contentLevel), false);
});

test("判类只认机器标记：鉴权/参数/取消/直连与 ComfyUI 失败都不重试", () => {
  assert.equal(isTransientItemFailure(new HermesTransientError("503", 503)), true);
  assert.equal(isTransientItemFailure(new Error("Hermes Profile「writer」API 密钥认证失败")), false);
  assert.equal(isTransientItemFailure(new HttpError(400, "参数无效", "INVALID_WORKFLOW")), false);
  assert.equal(isTransientItemFailure(new Error("Hermes 输出缺少字段：prompt")), false);
  assert.equal(isTransientItemFailure(new Error("ComfyUI 请求超时（单步上限 30 分钟）")), false);
  assert.equal(isTransientItemFailure(new Error("直连模型提供商请求超时（单步上限 30 分钟）")), false);
  const abort = new Error("运行已取消");
  abort.name = "AbortError";
  assert.equal(isTransientItemFailure(abort), false, "取消永不重试，即使传输层标了 transient");
  assert.equal(isTransientItemFailure(undefined), false);
  // Backoff is exponential and capped at 60s.
  assert.deepEqual([1, 2, 3, 4, 5, 6].map((attempt) => itemRetryDelayMs(attempt, 5_000)), [5_000, 10_000, 20_000, 40_000, 60_000, 60_000]);
});

test("执行器用真实 Hermes 瞬时错误类型重试，非瞬时错误一次即停", async (t) => {
  // 与 hermesStep 抛出的类型一致（HermesTransientError 由 408/429/5xx、断连、超时构造）。
  const errors = [
    new HermesTransientError("Hermes API 请求失败：429 Upstream rate limited", 429),
    new HermesTransientError("Hermes 网络连接失败（http://127.0.0.1:8080）：ECONNRESET"),
    new HermesTransientError("Hermes API 请求超时（单步上限 30 分钟）"),
  ];
  for (const [index, transient] of errors.entries()) {
    let calls = 0;
    const h = await harness(t, { executor: { kind: "hermes", async execute() {
      calls += 1;
      if (calls === 1) throw transient;
      return { prompt: "ok" };
    } } });
    await h.service.start();
    const flow = loopWorkflow({ itemRetries: 1, itemRetryDelaySeconds: 0 });
    flow.steps[0]!.kind = "hermes";
    flow.steps[0]!.hermesProfile = "writer";
    flow.steps[0]!.outputs = [{ key: "prompt", type: "text" }];
    flow.outputs[0]!.sourceRef = "step.loop.outputs.prompt";
    await h.service.submit(submission(id(`retry-hermes-${index}`), flow, { items: [1] }));
    const result = await h.service.wait(h.settings.projectDirectory, id(`retry-hermes-${index}`));
    assert.equal(result.status, "completed", transient.message);
    assert.equal(calls, 2);
  }
});
