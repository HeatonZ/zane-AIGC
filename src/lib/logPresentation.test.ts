import assert from "node:assert/strict";
import test from "node:test";
import {
  correlateRequestIdentities, describeEvent, durationText, entryFacts, errorMessage, eventCategory, eventLabel,
  formatFieldValue, fullTime, logTime, narrativeFor, neighborEntries, normalizedEvent, orderedFieldEntries, parseOpsLine,
  requestRecords, resolveRunId, runContextRows, runStepRows, statusTone, summarizeLogEntries,
} from "./logPresentation.js";

const at = (sequence: number) => new Date(Date.UTC(2026, 9, 19, 8, 0, sequence)).toISOString();
const entry = (sequence: number, level: "info" | "warn" | "error", event: string, fields: Record<string, unknown>) => ({ sequence, time: at(sequence), level, event, fields });

test("日志重点：同一原因的失败合并成一组，而不是刷满整页", () => {
  // 真实窗口里同一个 403 重复了 17 次；逐条显示会把其它内容全部挤下去。
  const entries = Array.from({ length: 17 }, (_, index) => entry(index + 1, "warn", "http.error", { requestId: "r" + index, method: "GET", path: "/api/v1/self/runtime-release", status: 403, error: "此入口不接受管理员凭证" }));
  const digest = summarizeLogEntries(entries);
  assert.equal(digest.failures.length, 1, "同一请求同一原因应只有一组");
  assert.equal(digest.failures[0]!.count, 17);
  assert.match(digest.failures[0]!.detail, /GET \/api\/v1\/self\/runtime-release/);
  assert.match(digest.failures[0]!.detail, /HTTP 403/);
  assert.match(digest.failures[0]!.detail, /此入口不接受管理员凭证/);
  // 组内保留全部序号，展开后仍能逐条核对。
  assert.equal(digest.failures[0]!.sequences.length, 17);

  // 不同原因不能被合并：那样会隐藏真正的差异。
  const mixed = summarizeLogEntries([
    entry(1, "warn", "http.error", { method: "GET", path: "/a", status: 401, error: "未登录" }),
    entry(2, "warn", "http.error", { method: "GET", path: "/a", status: 500, error: "未登录" }),
    entry(3, "error", "run.execution_failed", { runId: "0b2ddab7-5c7c-4c66-9e62-56bf6d083f3b", error: "Hermes 超时" }),
  ]);
  assert.equal(mixed.failures.length, 3);
});

test("日志重点：成功的轮询心跳默认折叠，失败的心跳不被折叠", () => {
  const entries = [
    ...Array.from({ length: 10 }, (_, index) => entry(index + 1, "info", "http.request", { method: "GET", path: "/api/workspace/status", status: 200, durationMs: 12 })),
    ...Array.from({ length: 3 }, (_, index) => entry(index + 11, "info", "http.request", { method: "GET", path: "/api/v1/self/runtime-release", status: 200 })),
    entry(14, "info", "run.queued", { runId: "0b2ddab7-5c7c-4c66-9e62-56bf6d083f3b" }),
  ];
  const digest = summarizeLogEntries(entries);
  assert.equal(digest.heartbeatCount, 13);
  assert.equal(digest.noise.length, 2, "每个轮询路径各一行汇总");
  assert.equal(digest.visibleEntries.length, 1, "折叠后只剩真正的事件");
  assert.equal(digest.visibleEntries[0]!.event, "run.queued");

  // 失败的心跳是异常，必须留在失败段而不是被折进噪音。
  const failing = summarizeLogEntries([
    entry(1, "info", "http.request", { method: "GET", path: "/api/health", status: 200 }),
    entry(2, "warn", "http.error", { method: "GET", path: "/api/health", status: 503, error: "unavailable" }),
  ]);
  assert.equal(failing.heartbeatCount, 1);
  assert.equal(failing.failures.length, 1);
  assert.equal(failing.failures[0]!.count, 1);
  assert.match(failing.failures[0]!.detail, /HTTP 503/);

  // 非 GET 或非 2xx 的请求不是心跳；显式关闭折叠时全部可见。
  const disabled = summarizeLogEntries(entries, { collapseHeartbeats: false });
  assert.equal(disabled.heartbeatCount, 0);
  assert.equal(disabled.visibleEntries.length, entries.length);
});

test("日志重点：一次失败请求的两条条目（request+error）合成一件事", () => {
  // 真实窗口里失败请求同时写 http.request（带状态码）与 http.error（带原因），共享 requestId。
  // 不合并的话同一件事会显示成两行，其中一行还缺原因。
  const entries = [
    entry(1, "warn", "http.error", { requestId: "same", status: 403, error: "此入口不接受管理员凭证" }),
    entry(2, "info", "http.request", { requestId: "same", method: "GET", path: "/api/v1/self/runtime-release", status: 403 }),
  ];
  const digest = summarizeLogEntries(entries);
  assert.equal(digest.failures.length, 1, "同一 requestId 只能是一组");
  assert.equal(digest.failures[0]!.count, 2);
  assert.match(digest.failures[0]!.detail, /GET \/api\/v1\/self\/runtime-release/);
  assert.match(digest.failures[0]!.detail, /HTTP 403/);
  assert.match(digest.failures[0]!.detail, /此入口不接受管理员凭证/);
  // 两条都不再出现在「其余事件」里。
  assert.deepEqual(digest.visibleEntries, []);

  // 重复发生多次时仍然只有一组，计数按条目累计。
  const repeated = summarizeLogEntries([
    entry(1, "warn", "http.error", { requestId: "a", status: 403, error: "denied" }),
    entry(2, "info", "http.request", { requestId: "a", method: "GET", path: "/x", status: 403 }),
    entry(3, "warn", "http.error", { requestId: "b", status: 403, error: "denied" }),
    entry(4, "info", "http.request", { requestId: "b", method: "GET", path: "/x", status: 403 }),
  ]);
  assert.equal(repeated.failures.length, 1);
  assert.equal(repeated.failures[0]!.count, 4);
  assert.deepEqual(repeated.failures[0]!.sequences, [1, 2, 3, 4]);
});

test("日志重点：缺原因的同请求同状态码并入有原因的那组", () => {
  // http.error 的 requestId 已滚出窗口时，只剩 http.request 的 403 没有原因；
  // 它与有原因的那组是同一件事，单列一行只会多一条噪音。
  const entries = [
    entry(1, "info", "http.request", { requestId: "old", method: "GET", path: "/api/x", status: 403 }),
    entry(2, "warn", "http.error", { requestId: "new", status: 403, error: "denied" }),
    entry(3, "info", "http.request", { requestId: "new", method: "GET", path: "/api/x", status: 403 }),
  ];
  const digest = summarizeLogEntries(entries);
  assert.equal(digest.failures.length, 1);
  assert.equal(digest.failures[0]!.count, 3);
  // 显示文本取信息更全的那条：不能丢掉原因。
  assert.match(digest.failures[0]!.detail, /denied/);
  assert.match(digest.failures[0]!.detail, /HTTP 403/);
  assert.equal(digest.failures[0]!.firstSequence, 1);
  assert.equal(digest.failures[0]!.lastSequence, 3);
});

test("日志正文：一句话说清发生了什么，不出现路径与字段名", () => {
  // 这是页面的主要阅读内容：读者要知道「发生了什么」，不是「调了哪个接口」。
  assert.equal(narrativeFor("run.queued", { runId: "0b2ddab7-5c7c-4c66-9e62-56bf6d083f3b", sceneId: "commerce" }), "任务已进入队列（场景 commerce）");
  assert.equal(narrativeFor("run.started", {}), "任务开始执行");
  assert.equal(narrativeFor("run.completed", { durationMs: 125000 }), "任务已完成，用时 2 分 5 秒");
  assert.equal(narrativeFor("run.execution_failed", { error: "Hermes 网络连接失败" }), "任务执行失败：Hermes 网络连接失败");
  assert.equal(narrativeFor("step.started", { stepName: "出图" }), "开始执行步骤「出图」");
  assert.equal(narrativeFor("step.completed", { stepName: "出图", durationMs: 46620 }), "步骤「出图」完成，用时 47 秒");
  assert.equal(narrativeFor("step.failed", { stepName: "出图", error: "上游 500" }), "步骤「出图」失败：上游 500");
  assert.equal(narrativeFor("step.item.failed", { stepName: "出图", itemIndex: 1, error: "timeout" }), "第 2 项失败（出图）：timeout");
  assert.equal(narrativeFor("review.approve", { stepName: "出图" }), "人工确认通过，继续执行「出图」");
  assert.equal(narrativeFor("review.redo", { stepName: "出图" }), "人工退回，重新执行「出图」");
  assert.equal(narrativeFor("hermes.request_failed", { profile: "writer", errorMessage: "connect ECONNREFUSED" }), "调用 Hermes 失败：connect ECONNREFUSED（配置 writer）");
  assert.equal(narrativeFor("comfy.binding_remapped", { step: "出图" }), "ComfyUI 工作流节点已自动改接（步骤 出图）");
  assert.equal(narrativeFor("backend_ready", { pid: 1, port: 8799 }), "后台服务已就绪");
  assert.equal(narrativeFor("mcp.restarted", { workerPid: 12 }), "AI 工具服务已重启");

  // 接口调用即使出现，正文也只说结果，不暴露路径与参数。
  assert.equal(narrativeFor("http.request", { method: "GET", path: "/api/workspace/status", status: 200 }), "接口调用成功");
  assert.equal(narrativeFor("http.error", { method: "GET", path: "/api/v1/self/account", status: 401, code: "AUTH_REQUIRED", error: "请登录或配置AI凭证" }), "接口调用失败：请登录或配置AI凭证（AUTH_REQUIRED）");
  for (const text of [
    narrativeFor("http.request", { path: "/api/v1/runs", status: 500 }),
    narrativeFor("step.failed", { stepName: "出图", error: "x" }),
  ]) {
    assert.doesNotMatch(text, /\/api\//, "正文不应出现接口路径");
    assert.doesNotMatch(text, /requestId|stepId|durationMs/, "正文不应出现字段名");
  }

  // 未登记事件回退到「事件名 + 可读字段」，仍不丢信息。
  assert.match(narrativeFor("custom.thing", { alpha: "one" }), /custom\.thing/);
  assert.match(narrativeFor("custom.thing", { alpha: "one" }), /alpha=one/);
});

test("日志正文：时长说人话，不出现毫秒数", () => {
  assert.equal(durationText(120), "120 毫秒");
  assert.equal(durationText(1500), "1.5 秒");
  assert.equal(durationText(46620), "47 秒");
  assert.equal(durationText(65000), "1 分 5 秒");
  assert.equal(durationText(120000), "2 分钟");
  assert.equal(durationText(3700000), "1 小时 1 分");
  assert.equal(durationText(undefined), "未记录");
});

test("日志详情：一次请求的全部记录与前后日志都能取到", () => {
  const entries = [
    entry(1, "info", "http.request", { requestId: "r1", method: "GET", path: "/api/health", status: 200 }),
    entry(2, "warn", "http.error", { requestId: "r2", status: 409, error: "conflict" }),
    entry(3, "info", "http.request", { requestId: "r2", method: "POST", path: "/api/v1/runs", status: 409 }),
    entry(4, "info", "run.queued", { runId: "0b2ddab7-5c7c-4c66-9e62-56bf6d083f3b" }),
    entry(5, "info", "step.started", { runId: "0b2ddab7-5c7c-4c66-9e62-56bf6d083f3b", stepName: "出图" }),
  ];
  // 详情里要能同时看到同一次请求的 request 与 error 两条，而不是只有被点开的那一条。
  assert.deepEqual(requestRecords(entries, "r2").map(item => item.sequence), [2, 3]);
  assert.deepEqual(requestRecords(entries, "r1").map(item => item.sequence), [1]);
  // 不存在的 requestId 返回空，不编造记录。
  assert.deepEqual(requestRecords(entries, "missing"), []);

  // 前后日志给出上下文，各自按「离当前条最近优先」排序。
  const around = neighborEntries(entries, 3, 2);
  assert.deepEqual(around.before.map(item => item.sequence), [2, 1]);
  assert.deepEqual(around.after.map(item => item.sequence), [4, 5]);
  // 边界条目不越界。
  assert.deepEqual(neighborEntries(entries, 1, 2).before, []);
  assert.deepEqual(neighborEntries(entries, 5, 2).after, []);
  assert.deepEqual(neighborEntries(entries, 99, 2), { before: [], after: [] });
});

test("日志详情：运行ID优先取自身，续跑/修订条目回退到祖先", () => {
  assert.equal(resolveRunId({ runId: "a" }), "a");
  assert.equal(resolveRunId({ newRunId: "b", sourceRunId: "c" }), "b");
  assert.equal(resolveRunId({ sourceRunId: "c" }), "c");
  assert.equal(resolveRunId({ sceneId: "demo" }), undefined);
});

test("日志详情：运行上下文与步骤表把日志放回一次真实运行", () => {
  const rows = runContextRows({
    status: "failed", sceneId: "commerce", workflowName: "电商套图", runTitle: "第 3 批",
    startedAt: "2026-10-19T08:00:00.000Z", finishedAt: "2026-10-19T08:02:00.000Z", durationMs: 120000,
    submitter: { displayName: "运维", username: "ops" }, ownerUserId: "u1", resumedFromRunId: "prev-run",
  });
  const byLabel = new Map(rows.map(row => [row.label, row]));
  assert.equal(byLabel.get("状态")!.value, "failed");
  assert.equal(byLabel.get("状态")!.tone, "bad");
  assert.equal(byLabel.get("场景")!.value, "commerce");
  assert.equal(byLabel.get("流程")!.value, "电商套图");
  assert.equal(byLabel.get("标题")!.value, "第 3 批");
  assert.equal(byLabel.get("用时")!.value, "2 分 0 秒");
  assert.equal(byLabel.get("提交人")!.value, "运维（ops）");
  assert.equal(byLabel.get("续跑自")!.value, "prev-run");
  // 没有标题/提交人/血缘时不留空行。
  const minimal = runContextRows({ status: "completed", sceneId: "demo", workflowName: "w" });
  assert.deepEqual(minimal.map(row => row.label), ["状态", "场景", "流程", "开始", "结束", "用时"]);
  assert.equal(minimal[0]!.tone, "ok");
  assert.equal(minimal[3]!.value, "未开始");
  assert.equal(minimal[4]!.value, "未结束");

  const steps = runStepRows([
    { name: "图编辑", status: "skipped", capabilityId: "core.http_request" },
    { name: "图生成", status: "completed", capabilityId: "core.http_request", durationMs: 46620 },
    { name: "出图", status: "failed", durationMs: 1000, warnings: ["a", "b"] },
    { name: "未知", status: "completed" },
  ]);
  assert.deepEqual(steps.map(step => step.failed), [false, false, true, false]);
  assert.equal(steps[0]!.capability, "core.http_request");
  assert.equal(steps[1]!.duration, "46 秒");
  assert.equal(steps[2]!.status, "failed · 2 条警告");
  // 没有 capabilityId 时显示占位符，而不是 undefined。
  assert.equal(steps[3]!.capability, "—");
});

test("日志重点：摘要卡片的三个计数与分组一致", () => {
  const entries = [
    entry(1, "warn", "http.error", { method: "POST", path: "/api/v1/runs", status: 400, error: "bad json" }),
    entry(2, "warn", "http.error", { method: "POST", path: "/api/v1/runs", status: 400, error: "bad json" }),
    entry(3, "info", "http.request", { method: "GET", path: "/api/ready", status: 200 }),
    entry(4, "info", "step.completed", { runId: "0b2ddab7-5c7c-4c66-9e62-56bf6d083f3b", stepName: "出图", durationMs: 9 }),
  ];
  const digest = summarizeLogEntries(entries);
  assert.equal(digest.failures.reduce((sum, group) => sum + group.count, 0), 2);
  assert.equal(digest.heartbeatCount, 1);
  // 折叠掉的心跳不算「其余事件」；失败组已单独成段，也不重复计入。
  assert.deepEqual(digest.visibleEntries.map(item => item.sequence), [4]);
  // 分组（失败 + 心跳）按最近一条从新到旧，排障时最上面就是刚发生的事。
  assert.deepEqual(digest.groups.map(group => group.lastSequence), [3, 2]);
});

test("日志展示：事件名有中文标签与分类，未登记事件原样显示不猜名字", () => {
  assert.equal(eventLabel("run.execution_failed"), "运行执行失败");
  assert.equal(eventLabel("hermes.request_failed"), "Hermes 请求失败");
  // An unregistered event must show its real name; inventing a label would mislead.
  assert.equal(eventLabel("something.new"), "something.new");

  assert.equal(eventCategory("run.execution_failed").id, "run");
  assert.equal(eventCategory("http.request").id, "http");
  assert.equal(eventCategory("hermes.request_failed").id, "hermes");
  assert.equal(eventCategory("comfy.binding_remapped").id, "comfy");
  assert.equal(eventCategory("direct_llm.request_failed").id, "direct");
  assert.equal(eventCategory("backend_ready").id, "watchdog");
  assert.equal(eventCategory("mcp.worker_lost").id, "mcp");
  assert.equal(eventCategory("unknown.event").id, "other");
  // The category label is what the operator reads, so it must be Chinese, not the raw id.
  assert.equal(eventCategory("run.execution_failed").label, "运行");
});

test("日志展示：摘要优先给出排障所需的事实（请求行、错误原因、运行与场景）", () => {
  assert.equal(
    describeEvent("http.request", { requestId: "r1", method: "GET", path: "/api/v1/tasks", status: 200, durationMs: 12 }),
    "GET /api/v1/tasks → 200 · 12ms",
  );
  // 错误摘要必须先说「哪个请求」：只给 HTTP 401 无法判断是哪个接口失败。
  assert.equal(
    describeEvent("http.error", { requestId: "r1", method: "POST", path: "/api/v1/runs", status: 500, code: "INTERNAL_ERROR", error: "boom" }),
    "POST /api/v1/runs → HTTP 500 · boom（INTERNAL_ERROR）",
  );
  assert.equal(describeEvent("http.error", { status: 401, error: "请登录或配置AI凭证" }), "HTTP 401 · 请登录或配置AI凭证");
  assert.equal(describeEvent("http.error", { method: "GET", path: "/api/x", status: 403, code: "FORBIDDEN" }), "GET /api/x → HTTP 403 · FORBIDDEN");
  // Run events lead with a short id; the full id stays in the field list.
  assert.equal(describeEvent("run.queued", { runId: "0b2ddab7-5c7c-4c66-9e62-56bf6d083f3b", sceneId: "demo" }), "运行 0b2ddab7 · 场景 demo");
  assert.equal(describeEvent("run.execution_failed", { runId: "0b2ddab7-5c7c-4c66-9e62-56bf6d083f3b", error: "Hermes 网络连接失败" }), "运行 0b2ddab7 · Hermes 网络连接失败");
  assert.equal(describeEvent("hermes.request_failed", { profile: "writer", baseUrl: "http://127.0.0.1:8080", code: "ECONNREFUSED", errorMessage: "connect ECONNREFUSED" }), "writer · http://127.0.0.1:8080 · connect ECONNREFUSED（ECONNREFUSED）");
  assert.equal(describeEvent("server.public_user_listening", { host: "0.0.0.0", port: 8800, entryMode: "user-only" }), "0.0.0.0:8800 · user-only");
  assert.equal(describeEvent("server.mcp_reload_published", { contractVersion: "1.7.9" }), "契约版本 1.7.9");
  assert.equal(describeEvent("comfy.binding_remapped", { step: "出图", bindingKey: "positive", from: "196", to: "201" }), "步骤 出图 · positive · 196 → 201");
  assert.equal(describeEvent("direct_llm.provider_saved", { providerId: "p1", protocol: "openai-chat", enabled: true, credentialSource: "provider-apiKey" }), "p1 · openai-chat · 已启用 · provider-apiKey");
  assert.equal(describeEvent("local.export", { runId: "0b2ddab7-5c7c-4c66-9e62-56bf6d083f3b", written: 3, skipped: 1 }), "运行 0b2ddab7 · 写入 3 · 跳过 1");
  assert.equal(describeEvent("mcp.worker_lost", { workerPid: 4242 }), "工作进程 4242");
  assert.equal(describeEvent("backend_degraded", { port: 8799 }), "端口 8799 · 健康检查失败");
  // Step lifecycle entries are produced by the run service; they must name the step.
  assert.equal(describeEvent("step.completed", { stepName: "第一步", durationMs: 3 }), "步骤 第一步 · 3ms");
  assert.equal(describeEvent("step.failed", { stepName: "第二步", error: "upstream 500" }), "步骤 第二步 · upstream 500");
  assert.equal(describeEvent("step.item.failed", { stepName: "出图", itemIndex: 1, error: "timeout" }), "步骤 出图 · 第 2 项 · timeout");
});

test("日志展示：未知事件用字段摘要兜底，不返回空串让人猜", () => {
  const summary = describeEvent("custom.thing", { alpha: "one", beta: 2, gamma: true, delta: { deep: 1 }, epsilon: "ignored" });
  assert.match(summary, /alpha=one/);
  assert.match(summary, /beta=2/);
  assert.match(summary, /gamma=true/);
  // Scalar facts come before composite shapes, so a short summary stays useful.
  assert.ok(summary.indexOf("delta=") === -1 || summary.indexOf("delta=") > summary.indexOf("gamma="));
  // With room left, objects are summarised by shape rather than dumped inline.
  assert.match(describeEvent("custom.thing", { alpha: "one", delta: { deep: 1 } }), /delta=\{1 个字段\}/);
  // Long strings are clipped in the summary; the field list still shows the full value.
  const long = describeEvent("custom.thing", { note: "x".repeat(400) });
  assert.ok(long.length < 400, "摘要不应塞入完整长文本");
  assert.match(long, /…$/);
});

test("日志展示：展开字段按重要性排序，错误字段排在最前", () => {
  const keys = orderedFieldEntries({ requestId: "r1", path: "/x", method: "GET", status: 200, error: "boom", durationMs: 3, zzz: 1 }).map(([key]) => key);
  assert.equal(keys[0], "error");
  // Known diagnostic keys precede unknown extras; unknown keys keep a stable alphabetical tail.
  assert.ok(keys.indexOf("status") < keys.indexOf("requestId"));
  assert.equal(keys[keys.length - 1], "zzz");
  assert.deepEqual(orderedFieldEntries({ b: 1, a: 2 }).map(([key]) => key), ["a", "b"]);
});

test("日志展示：字段值区分标量与 JSON，对象格式化展示不丢信息", () => {
  assert.deepEqual(formatFieldValue("text"), { kind: "scalar", text: "text" });
  assert.deepEqual(formatFieldValue(12), { kind: "scalar", text: "12" });
  assert.deepEqual(formatFieldValue(false), { kind: "scalar", text: "false" });
  assert.deepEqual(formatFieldValue(null), { kind: "scalar", text: "null" });
  const json = formatFieldValue({ kind: "trailing_brace" });
  assert.equal(json.kind, "json");
  assert.equal(JSON.parse(json.text).kind, "trailing_brace");
});

test("日志展示：时间显示到毫秒并区分无效值", () => {
  // Same-second events are common; without milliseconds their order is unreadable.
  const value = "2026-10-19T08:04:02.636Z";
  assert.match(logTime(value), /^\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}$/);
  assert.match(fullTime(value), /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}$/);
  assert.equal(logTime("not-a-date"), "not-a-date");
  assert.equal(logTime(undefined), "无时间");
});

test("日志展示：HTTP 状态色调按成功/客户端错误/服务端错误区分", () => {
  assert.equal(statusTone(200), "ok");
  assert.equal(statusTone(404), "warn");
  assert.equal(statusTone(500), "error");
  assert.equal(statusTone(101), "");
});

test("日志展示：MCP supervisor 的裸事件补上命名空间，其余保持不变", () => {
  assert.equal(normalizedEvent("worker_lost", "zane-mcp-supervisor"), "mcp.worker_lost");
  assert.equal(normalizedEvent("worker_lost"), "worker_lost");
  // A real log event with a component field must not be rewritten.
  assert.equal(normalizedEvent("run.queued", "something-else"), "run.queued");
});

test("日志展示：失败条目在折叠状态就能给出请求与原因", () => {
  // 这正是用户反馈的问题：只看到「HTTP 401」却不知道是哪个请求。
  const facts = entryFacts({ requestId: "r1", method: "GET", path: "/api/v1/self/account", status: 401, code: "UNAUTHORIZED", error: "请登录或配置AI凭证" });
  assert.deepEqual(facts.request, { method: "GET", path: "/api/v1/self/account" });
  assert.equal(facts.status, 401);
  assert.equal(facts.code, "UNAUTHORIZED");
  assert.equal(facts.error, "请登录或配置AI凭证");
  assert.equal(errorMessage({ error: "boom" }), "boom");

  // 运行/步骤条目同样带出可点击的事实，不必展开。
  const runFacts = entryFacts({ runId: "0b2ddab7-5c7c-4c66-9e62-56bf6d083f3b", sceneId: "demo", stepName: "出图", itemIndex: 2, durationMs: 42 });
  assert.equal(runFacts.runId, "0b2ddab7");
  assert.equal(runFacts.sceneId, "demo");
  assert.equal(runFacts.stepName, "出图");
  assert.equal(runFacts.itemIndex, 2);
  assert.equal(runFacts.durationMs, 42);
});

test("日志展示：旧 http.error 通过 requestId 关联到同一次请求的方法与路径", () => {
  // 历史条目只有 requestId/status/error；同窗口的 http.request 带方法、路径与同一个 requestId。
  const entries = [
    { fields: { requestId: "r1", method: "GET", path: "/api/workspace/status", status: 200 } },
    { fields: { requestId: "r1", status: 500, error: "boom" } },
    { fields: { requestId: "r2", method: "POST", path: "/api/v1/runs" } },
  ];
  const identities = correlateRequestIdentities(entries);
  assert.deepEqual(identities.get("r1"), { method: "GET", path: "/api/workspace/status" });

  const facts = entryFacts({ requestId: "r1", status: 500, error: "boom" }, identities);
  assert.deepEqual(facts.request, { method: "GET", path: "/api/workspace/status" });

  // 自身带方法/路径时优先用自己的，不被关联结果覆盖。
  const own = entryFacts({ requestId: "r2", method: "PATCH", path: "/api/other" }, identities);
  assert.deepEqual(own.request, { method: "PATCH", path: "/api/other" });

  // 关联不到时明确留空，不编造路径。
  assert.equal(entryFacts({ requestId: "missing", status: 500 }).request, undefined);
  assert.equal(entryFacts({ status: 500 }).request, undefined);
});

test("运维日志：JSON 行结构化，普通行与非 JSON 行保留原文", () => {
  const structured = parseOpsLine({ lineNumber: 3, text: JSON.stringify({ time: "2026-10-19T08:04:02.636Z", level: "error", event: "http.error", status: 401, error: "请登录" }) });
  assert.ok(structured.parsed);
  assert.equal(structured.parsed.event, "http.error");
  assert.equal(structured.parsed.level, "error");
  assert.equal(structured.parsed.time, "2026-10-19T08:04:02.636Z");
  // Envelope keys are lifted out of fields so the field list shows only the payload.
  assert.deepEqual(structured.parsed.fields, { status: 401, error: "请登录" });

  const plain = parseOpsLine({ lineNumber: 1, text: "Production server listening on http://127.0.0.1:8799" });
  assert.equal(plain.parsed, undefined);
  assert.match(plain.raw, /Production server listening/);

  // A truncated line is not valid JSON any more; presenting it as structured would lose the cut.
  const truncated = parseOpsLine({ lineNumber: 9, text: "{\"event\":\"x\",\"big\":\"…[truncated]", truncated: true });
  assert.equal(truncated.parsed, undefined);
  assert.equal(truncated.truncated, true);

  // An object without an event name is not a log event; keep it verbatim.
  assert.equal(parseOpsLine({ lineNumber: 4, text: "{\"note\":\"no event\"}" }).parsed, undefined);
  assert.equal(parseOpsLine({ lineNumber: 5, text: "[1,2,3]" }).parsed, undefined);
  // A JSON string scalar is not an object.
  assert.equal(parseOpsLine({ lineNumber: 6, text: "\"just text\"" }).parsed, undefined);

  // MCP supervisor lines carry a component instead of a namespaced event.
  const mcp = parseOpsLine({ lineNumber: 7, text: JSON.stringify({ component: "zane-mcp-supervisor", event: "started", workerPid: 12 }) });
  assert.ok(mcp.parsed);
  assert.equal(normalizedEvent(mcp.parsed.event, mcp.parsed.component), "mcp.started");
  assert.equal(eventLabel("mcp.started"), "MCP 已启动");
});

test("日志展示：场景包的 log() 事件读出包内原话，并按 packageRunId 归到场景包分类", () => {
  // 包内 log() 写的是自由文本 message；日志页要直接显示它，而不是显示字段名。
  assert.equal(narrativeFor("scene_package.log", { message: "demo 包开始", packageRunId: "98439841-4f26-49e7-b339-a22437e9d834" }), "demo 包开始");
  assert.equal(eventCategory("scene_package.log").label, "场景包");
  assert.equal(eventLabel("scene_package.log"), "场景包运行日志");
  // 包运行失败与加载失败都要给出原因，否则运维只能看到事件名。
  assert.match(narrativeFor("scene_package.run_failed", { error: "场景包只能执行配置的执行器" }), /场景包只能执行配置的执行器/);
  assert.match(narrativeFor("scene_package.load_failed", { packageId: "broken", error: "Unexpected end of input" }), /broken.*Unexpected end of input/);
  // 未知事件仍然不猜名字。
  assert.equal(eventLabel("scene_package.unregistered"), "scene_package.unregistered");
});
