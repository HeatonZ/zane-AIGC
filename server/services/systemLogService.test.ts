import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { HttpError } from "../errors.js";
import { LogBuffer } from "../observability/logger.js";
import { redactLogFields, redactLogText } from "../observability/logRedaction.js";
import { SystemLogService } from "../services/systemLogService.js";
import { opsLogQuery, systemLogQuery } from "../domain/systemLogContracts.js";

const runId = "0b2ddab7-5c7c-4c66-9e62-56bf6d083f3b";

test("日志脱敏：凭证/密钥键与文本形态都被替换，URL查询串脱敏但保留主机与路径", () => {
  const { fields, truncated } = redactLogFields({
    password: "hunter2",
    authorization: "Bearer abc",
    apiKey: "sk-live-123",
    nested: { refreshToken: "rt-1", token: "t-1" },
    // A real diagnostic value: the operator needs the host and path to know which service failed.
    baseUrl: "http://127.0.0.1:8188/view?filename=shot.png&token=leak",
    note: "failed with api_key=sk-inline and Authorization: Bearer xyz",
    error: "E:\\projects\\demo\\run.json not found",
  });
  assert.equal(fields.password, "[REDACTED]");
  assert.equal(fields.authorization, "[REDACTED]");
  assert.equal(fields.apiKey, "[REDACTED]");
  assert.deepEqual(fields.nested, { refreshToken: "[REDACTED]", token: "[REDACTED]" });
  // Query strings can carry signed tokens; the host/path stay so the failure is still locatable.
  assert.equal(fields.baseUrl, "http://127.0.0.1:8188/view[REDACTED_QUERY]");
  assert.doesNotMatch(String(fields.note), /sk-inline|xyz/);
  // Absolute paths are deliberately KEPT: this surface is admin-only and paths are the value.
  assert.match(String(fields.error), /E:\\projects\\demo/);
  assert.equal(truncated, false);
});

test("日志脱敏：URL userinfo 与内联密钥不再出现；超长值裁剪并显式标记", () => {
  assert.equal(redactLogText("https://user:pw@example.test/api"), "https://example.test/api");
  assert.doesNotMatch(redactLogText("secret=abcdef123456"), /abcdef123456/);
  const { fields, truncated } = redactLogFields({ big: "x".repeat(50_000) });
  assert.equal(truncated, true);
  assert.match(String(fields.big), /\[truncated\]$/);
  assert.ok(String(fields.big).length < 50_000);
});

test("日志脱敏：保留密钥字段名与引号，脱敏后仍是合法JSON且单标记", () => {
  // Regression: blanking the whole `"apiKey":"sk-…"` token used to leave `,"[REDACTED_SECRET],`,
  // which malformed the line AND destroyed the useful fact that an apiKey field was present.
  const line = JSON.stringify({ level: "error", event: "backend_degraded", apiKey: "sk-live-1", url: "http://127.0.0.1:8799/x?token=t" });
  const redacted = redactLogText(line);
  assert.doesNotMatch(redacted, /sk-live-1/);
  assert.doesNotMatch(redacted, /token=t/);
  // The key name survives, so an operator can still see which field was a credential.
  assert.match(redacted, /"apiKey":"\[REDACTED\]"/);
  // And the line is still parseable JSON, which is how this surface is actually read.
  const parsed = JSON.parse(redacted) as Record<string, unknown>;
  assert.equal(parsed.apiKey, "[REDACTED]");
  assert.equal(parsed.event, "backend_degraded");

  // Auth-scheme values collapse to a single marker instead of leaving a dangling "Bearer".
  const auth = redactLogText("authorization=Bearer abc123");
  assert.doesNotMatch(auth, /abc123/);
  assert.doesNotMatch(auth, /Bearer/);
  assert.equal(auth, "authorization=[REDACTED]");
  assert.equal(redactLogText("Authorization: Bearer xyz"), "Authorization: [REDACTED]");
  // Single-quoted and bare forms keep their own shape.
  assert.equal(redactLogText("password='p'"), "password='[REDACTED]'");
  assert.equal(redactLogText("token=abc"), "token=[REDACTED]");
  // Non-secret keys are untouched so diagnostics stay readable.
  assert.equal(redactLogText("runId=0b2ddab7-5c7c-4c66-9e62-56bf6d083f3b"), "runId=0b2ddab7-5c7c-4c66-9e62-56bf6d083f3b");
});

test("日志缓冲：容量有界、dropped计数、sequence单调，snapshot是副本", () => {
  const buffer = new LogBuffer(3);
  for (const level of ["info", "warn", "error", "info", "warn"] as const) buffer.append(level, "evt", { level });
  const snapshot = buffer.snapshot();
  assert.equal(snapshot.capacity, 3);
  assert.equal(snapshot.size, 3);
  assert.equal(snapshot.dropped, 2);
  assert.deepEqual(snapshot.entries.map(entry => entry.sequence), [3, 4, 5]);
  assert.throws(() => new LogBuffer(0));
  // Mutating the copy must not reach into the buffer.
  snapshot.entries.pop();
  assert.equal(buffer.snapshot().size, 3);
});

function seeded() {
  const buffer = new LogBuffer(50);
  buffer.append("info", "http.request", { requestId: "r1", method: "GET", path: "/api/health", status: 200 });
  buffer.append("info", "run.queued", { runId, sceneId: "demo" });
  buffer.append("warn", "hermes.output_json_repaired", { stepId: "aixg", runId, repair: { kind: "trailing_brace" } });
  buffer.append("error", "run.execution_failed", { runId, error: "Hermes 网络连接失败（http://127.0.0.1:8080）" });
  buffer.append("info", "workspace.migrated_from_json", { revision: 7, sceneId: "other" });
  return buffer;
}

test("日志服务：等级为最低等级语义、事件前缀、runId/sceneId/关键字筛选都生效", () => {
  const service = new SystemLogService(seeded());
  const all = service.listProcess(systemLogQuery.parse({}));
  assert.equal(all.total, 5);
  // Newest first: the operator wants the most recent failure at the top.
  assert.equal(all.entries[0]!.event, "workspace.migrated_from_json");
  assert.deepEqual(all.levelsAvailable, ["info", "warn", "error"]);

  // level is a FLOOR, matching ZANE_LOG_LEVEL, not an exact match.
  assert.deepEqual(service.listProcess(systemLogQuery.parse({ level: "warn" })).entries.map(e => e.level).sort(), ["error", "warn"]);
  assert.equal(service.listProcess(systemLogQuery.parse({ level: "error" })).total, 1);

  // Prefix, not substring: "run." matches run.* but not workspace.*.
  const runEvents = service.listProcess(systemLogQuery.parse({ event: "run." }));
  assert.deepEqual(runEvents.entries.map(e => e.event).sort(), ["run.execution_failed", "run.queued"]);

  assert.equal(service.listProcess(systemLogQuery.parse({ runId })).total, 3);
  assert.equal(service.listProcess(systemLogQuery.parse({ sceneId: "demo" })).total, 1);
  assert.equal(service.listProcess(systemLogQuery.parse({ q: "trailing_brace" })).total, 1);
  assert.equal(service.listProcess(systemLogQuery.parse({ q: "HTTP.REQUEST" })).total, 1, "关键字匹配应大小写不敏感");
  assert.equal(service.listProcess(systemLogQuery.parse({ runId, level: "error" })).total, 1);
});

test("日志服务：excludeEvent 在服务端排除纯接口调用，逗号分隔多前缀", () => {
  const buffer = new LogBuffer(20);
  buffer.append("info", "http.request", { method: "GET", path: "/api/workspace/status", status: 200 });
  buffer.append("info", "http.request", { method: "GET", path: "/api/ready", status: 200 });
  buffer.append("warn", "http.error", { status: 401, error: "请登录" });
  buffer.append("info", "run.queued", { runId, sceneId: "demo" });
  buffer.append("info", "step.completed", { runId, stepName: "出图" });
  const service = new SystemLogService(buffer);

  // 默认页面用它把「只有路径和状态码」的调用挡掉，只留业务事件与失败。
  const business = service.listProcess(systemLogQuery.parse({ excludeEvent: "http.request" }));
  assert.deepEqual(business.entries.map(entry => entry.event).sort(), ["http.error", "run.queued", "step.completed"]);

  // 多前缀、带空格、空段都不能误伤。
  const broad = service.listProcess(systemLogQuery.parse({ excludeEvent: " http.request , , step. " }));
  assert.deepEqual(broad.entries.map(entry => entry.event).sort(), ["http.error", "run.queued"]);

  // event 与 excludeEvent 同时给出：先包含再排除。
  assert.equal(service.listProcess(systemLogQuery.parse({ event: "http.", excludeEvent: "http.request" })).total, 1);
  // 前缀匹配不是子串匹配：http.request 不应被 "request" 命中。
  assert.equal(service.listProcess(systemLogQuery.parse({ excludeEvent: "request" })).total, 5);
  // 空串不是合法参数（客户端不传该键即不过滤），会被 schema 明确拒绝而不是静默清空窗口。
  assert.equal(systemLogQuery.safeParse({ excludeEvent: "" }).success, false);
});

test("日志服务：runId同时匹配sourceRunId/newRunId，让修订与续跑链聚得起来", () => {
  const buffer = new LogBuffer(10);
  buffer.append("info", "run.rerun", { sourceRunId: runId });
  buffer.append("info", "run.resume", { newRunId: runId });
  buffer.append("info", "run.other", { runId: "ffffffff-ffff-4fff-8fff-ffffffffffff" });
  const service = new SystemLogService(buffer);
  assert.deepEqual(service.listProcess(systemLogQuery.parse({ runId })).entries.map(e => e.event).sort(), ["run.rerun", "run.resume"]);
});

test("日志服务：游标按sequence定位——继续追加不影响翻页，条目被挤出才409", () => {
  const buffer = seeded();
  const service = new SystemLogService(buffer);
  const first = service.listProcess(systemLogQuery.parse({ limit: 2 }));
  assert.equal(first.entries.length, 2);
  assert.equal(first.hasMore, true);
  assert.equal(first.total, 5);
  assert.ok(first.nextCursor);

  // THE critical property: reading this log appends entries (http.request). Appends must NOT
  // invalidate the cursor and must NOT shift, duplicate or skip pages.
  buffer.append("info", "http.request", { path: "/api/v1/maintenance/logs" });
  buffer.append("info", "http.request", { path: "/api/v1/maintenance/logs" });
  const second = service.listProcess(systemLogQuery.parse({ limit: 2, cursor: first.nextCursor! }));
  assert.equal(second.entries.length, 2);
  assert.equal(second.hasMore, true);
  // No overlap with the first page and no skipped entries: the anchor held.
  const overlap = first.entries.map(e => e.sequence).filter(id => second.entries.some(e => e.sequence === id));
  assert.deepEqual(overlap, []);
  assert.equal(Math.max(...second.entries.map(e => e.sequence)), Math.min(...first.entries.map(e => e.sequence)) - 1);

  const third = service.listProcess(systemLogQuery.parse({ limit: 2, cursor: second.nextCursor! }));
  assert.equal(third.entries.length, 1);
  assert.equal(third.hasMore, false);
  assert.equal(third.nextCursor, undefined);
  // Every original entry is reachable exactly once across the three pages.
  const seen = [...first.entries, ...second.entries, ...third.entries].map(e => e.sequence);
  assert.equal(new Set(seen).size, seen.length);
  assert.equal(seen.length, 5);

  // Eviction moves the oldest retained boundary, so unread entries really are gone -> 409.
  const small = new LogBuffer(4);
  for (let index = 0; index < 4; index += 1) small.append("info", "run.event", { index });
  const smallService = new SystemLogService(small);
  const page = smallService.listProcess(systemLogQuery.parse({ limit: 2 }));
  assert.ok(page.nextCursor);
  small.append("error", "run.execution_failed", { index: 99 });
  small.append("error", "run.execution_failed", { index: 100 });
  assert.throws(() => smallService.listProcess(systemLogQuery.parse({ limit: 2, cursor: page.nextCursor! })), (error: unknown) => {
    assert.ok(error instanceof HttpError);
    assert.equal(error.status, 409);
    assert.equal(error.code, "LOG_PAGE_CHANGED");
    assert.ok(error.details?.retainedFromSequence);
    return true;
  });
  // After a 409 the caller re-reads the first page rather than splicing snapshots.
  const refreshed = smallService.listProcess(systemLogQuery.parse({ limit: 2 }));
  assert.equal(refreshed.entries.length, 2);
  assert.ok(refreshed.buffer.dropped > 0);

  // A cursor issued under one filter set is a 400, not silently reinterpreted.
  const other = service.listProcess(systemLogQuery.parse({ limit: 2, level: "info" }));
  assert.ok(other.nextCursor);
  assert.throws(() => service.listProcess(systemLogQuery.parse({ limit: 2, level: "warn", cursor: other.nextCursor! })), (error: unknown) => error instanceof HttpError && error.status === 400 && error.code === "INVALID_LOG_CURSOR");
});

test("日志服务：非法游标与非法参数明确拒绝，不静默返回空页", async () => {
  const service = new SystemLogService(seeded());
  for (const cursor of ["not-base64", Buffer.from(JSON.stringify({ format: "system-log-page/v1", revision: "a".repeat(64), offset: 0 })).toString("base64url")]) {
    assert.throws(() => service.listProcess(systemLogQuery.parse({ cursor })), (error: unknown) => error instanceof HttpError && (error.status === 400 || error.status === 409));
  }
  // The declared query schema is the first gate; the HTTP router turns these into 400 responses.
  for (const invalid of [{ limit: 0 }, { limit: 201 }, { level: "debug" }, { runId: "not-a-uuid" }, { file: "watchdog.log" }, { unknownKey: 1 }]) {
    assert.equal(systemLogQuery.safeParse(invalid).success, false, "应拒绝：" + JSON.stringify(invalid));
  }
  // The service re-validates its own input, so a caller that bypasses the router schema still
  // gets a 400 instead of an unfiltered page.
  for (const invalid of [{ limit: 0 }, { level: "debug" }, { runId: "not-a-uuid" }]) {
    assert.throws(() => service.listProcess(invalid as never), (error: unknown) => error instanceof HttpError && error.status === 400);
  }
  // readOpsFile is async and validates before touching the filesystem, so a non-allowlisted
  // name is rejected on the contract rather than incidentally by a failed stat.
  for (const file of ["zane.db", "../../zane.db", "watchdog.log.bak"]) {
    await assert.rejects(service.readOpsFile({ file } as never), (error: unknown) => error instanceof HttpError && error.status === 400);
  }
});
test("日志服务：缓冲清空(dropped)如实上报，不把挤出当成未产生", () => {
  const buffer = new LogBuffer(2);
  for (let index = 0; index < 5; index += 1) buffer.append("info", "run.event", { index });
  const page = new SystemLogService(buffer).listProcess(systemLogQuery.parse({}));
  assert.equal(page.buffer.dropped, 3);
  assert.equal(page.buffer.size, 2);
  assert.equal(page.buffer.capacity, 2);
  assert.equal(page.buffer.retainedFromSequence, 4);
  assert.equal(page.total, 2);
});

test("日志服务：自观测回归——每次读取都追加http.request时，翻页仍然可用", () => {
  // This is the production shape: the HTTP request that reads the log is itself logged, so the
  // entry set grows on every call. A set-hash cursor would 409 on every continuation and make
  // pagination useless; this pins the append-safe behaviour end to end.
  const buffer = new LogBuffer(100);
  for (let index = 0; index < 25; index += 1) buffer.append("info", "run.event", { index });
  const service = new SystemLogService(buffer);

  const collected: number[] = [];
  let cursor: string | undefined;
  let pages = 0;
  do {
    // Simulate the router's own request logging between pages.
    buffer.append("info", "http.request", { path: "/api/v1/maintenance/logs", status: 200 });
    const page = service.listProcess(systemLogQuery.parse({ limit: 10, event: "run.", ...(cursor ? { cursor } : {}) }));
    collected.push(...page.entries.map(entry => entry.sequence));
    cursor = page.nextCursor;
    pages += 1;
    assert.ok(pages <= 10, "翻页不应无限循环");
  } while (cursor);

  // All 25 run.* entries are read exactly once, newest first, despite 3 interleaved read-entries.
  assert.equal(collected.length, 25);
  assert.equal(new Set(collected).size, 25);
  assert.deepEqual(collected, [...collected].sort((left, right) => right - left));
  assert.equal(pages, 3);
});

test("运维日志：白名单文件尾部可读，越界文件名与任意路径都拒绝", async t => {
  const directory = await mkdtemp(path.join(tmpdir(), "zane-logs-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(path.join(directory, "watchdog.log"), ["{\"event\":\"ok\"}", "plain line one", "{\"level\":\"error\",\"event\":\"backend_degraded\"}", "plain line two", "{\"level\":\"warn\",\"event\":\"upgrade_in_progress_skip\"}"].join("\n"), "utf8");
  await writeFile(path.join(directory, "watchdog-server.log"), "server line", "utf8");
  const service = new SystemLogService(new LogBuffer(10), directory);

  const page = await service.readOpsFile(opsLogQuery.parse({ file: "watchdog.log" }));
  assert.equal(page.source, "ops");
  assert.equal(page.lines.length, 5);
  assert.equal(page.complete, true);
  assert.equal(page.scannedWholeFile, true);
  assert.equal(page.missing, false);
  assert.deepEqual(page.lines.map(line => line.lineNumber), [1, 2, 3, 4, 5]);
  assert.deepEqual(page.available.sort(), ["watchdog-server.log", "watchdog.log"]);

  const tail = await service.readOpsFile(opsLogQuery.parse({ file: "watchdog.log", tailLines: 2 }));
  assert.equal(tail.lines.length, 2);
  // Tail keeps the newest lines and reports the file as NOT complete.
  assert.deepEqual(tail.lines.map(line => line.lineNumber), [4, 5]);
  assert.equal(tail.complete, false);
  assert.equal(tail.totalLines, 5);

  // level filter keys off the structured "level" field; non-JSON lines drop out when it is set.
  const errors = await service.readOpsFile(opsLogQuery.parse({ file: "watchdog.log", level: "error" }));
  assert.deepEqual(errors.lines.map(line => line.text), ["{\"level\":\"error\",\"event\":\"backend_degraded\"}"]);

  const keyword = await service.readOpsFile(opsLogQuery.parse({ file: "watchdog.log", q: "PLAIN LINE" }));
  assert.equal(keyword.lines.length, 2, "关键字匹配应大小写不敏感");

  // Path traversal and allowlist misses are 400, never a read outside the data directory.
  for (const file of ["../../etc/passwd", "..\\..\\zane.db", "zane.db", "/etc/passwd", "watchdog.log.bak"]) {
    assert.throws(() => opsLogQuery.parse({ file }), "应拒绝非白名单文件名：" + file);
  }
  await assert.rejects(
    // Bypassing the schema must still not be able to name an arbitrary path.
    service.readOpsFile({ file: "../../zane.db" } as never),
    (error: unknown) => error instanceof HttpError && error.status === 400,
  );
});

test("运维日志：文件不存在返回missing而不是失败，读取失败才是错误", async t => {
  const directory = await mkdtemp(path.join(tmpdir(), "zane-logs-missing-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const service = new SystemLogService(new LogBuffer(10), directory);
  const page = await service.readOpsFile(opsLogQuery.parse({ file: "server.stderr.log" }));
  assert.equal(page.missing, true);
  assert.equal(page.complete, false);
  assert.deepEqual(page.lines, []);
  assert.deepEqual(page.available, []);
  // No data directory configured at all is the same honest "missing", not a 500.
  const unconfigured = await new SystemLogService(new LogBuffer(10), "").readOpsFile(opsLogQuery.parse({ file: "watchdog.log" }));
  assert.equal(unconfigured.missing, true);
});

test("运维日志：超长行裁剪并标记；字节窗口只扫描尾部时明确声明", async t => {
  const directory = await mkdtemp(path.join(tmpdir(), "zane-logs-long-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(path.join(directory, "server.stdout.log"), ["short line", "y".repeat(6000)].join("\n"), "utf8");
  const service = new SystemLogService(new LogBuffer(10), directory);
  const page = await service.readOpsFile(opsLogQuery.parse({ file: "server.stdout.log" }));
  assert.equal(page.truncated, true);
  assert.equal(page.lines[1]!.truncated, true);
  assert.match(page.lines[1]!.text, /\[truncated\]$/);
  // Redaction applies to ops lines too: credentials must not be readable through this route.
  await writeFile(path.join(directory, "server.stderr.log"), "token=supersecretvalue", "utf8");
  const redacted = await service.readOpsFile(opsLogQuery.parse({ file: "server.stderr.log" }));
  assert.doesNotMatch(redacted.lines[0]!.text, /supersecretvalue/);
});

test("运维日志：UTF-8 BOM 被剥离，首行仍是可解析JSON", async t => {
  // Windows tooling often writes a BOM. Left in place it makes the first line look like it starts
  // with a stray glyph and breaks JSON parsing of the very line an operator is trying to read.
  const directory = await mkdtemp(path.join(tmpdir(), "zane-logs-bom-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const first = JSON.stringify({ level: "error", event: "backend_degraded", apiKey: "sk-bom-leak" });
  await writeFile(path.join(directory, "watchdog.log"), "\uFEFF" + first + "\n" + JSON.stringify({ event: "second" }) + "\n", "utf8");
  const page = await new SystemLogService(new LogBuffer(10), directory).readOpsFile(opsLogQuery.parse({ file: "watchdog.log" }));
  assert.equal(page.lines.length, 2);
  assert.doesNotMatch(page.lines[0]!.text, /^\uFEFF/, "首行不应保留 BOM");
  const parsed = JSON.parse(page.lines[0]!.text) as Record<string, unknown>;
  assert.equal(parsed.event, "backend_degraded");
  assert.equal(parsed.apiKey, "[REDACTED]");
  // The level filter reads that same structured field, so it must still match through the BOM.
  const errors = await new SystemLogService(new LogBuffer(10), directory).readOpsFile(opsLogQuery.parse({ file: "watchdog.log", level: "error" }));
  assert.deepEqual(errors.lines.map(line => line.lineNumber), [1]);
});

test("日志服务：按 packageRunId 聚起一次包运行的全部日志，且不与 runId 混淆", () => {
  const packageRunId = "98439841-4f26-49e7-b339-a22437e9d834";
  const otherPackageRunId = "4185d11e-273f-4d71-93a8-d571bbe70876";
  const buffer = new LogBuffer(20);
  // 包内 log() 直接写的事件。
  buffer.append("info", "scene_package.log", { packageId: "demo", packageRunId, message: "包开始" });
  // 包提交的子运行：run.queued/run.completed 由场景包服务透传 packageRunId 打标。
  buffer.append("info", "run.queued", { runId, sceneId: "demo", packageRunId });
  buffer.append("info", "run.completed", { runId, packageRunId, durationMs: 12 });
  buffer.append("error", "scene_package.run_failed", { packageId: "demo", packageRunId, error: "包内异步失败" });
  // 干扰项：别的包运行、以及普通运行（没有 packageRunId）。
  buffer.append("info", "scene_package.log", { packageId: "other", packageRunId: otherPackageRunId, message: "别人的包" });
  buffer.append("info", "run.queued", { runId: "ffffffff-ffff-4fff-8fff-ffffffffffff", sceneId: "demo" });
  const service = new SystemLogService(buffer);

  const mine = service.listProcess(systemLogQuery.parse({ packageRunId }));
  assert.deepEqual(mine.entries.map(entry => entry.event).sort(), ["run.completed", "run.queued", "scene_package.log", "scene_package.run_failed"]);
  assert.equal(service.listProcess(systemLogQuery.parse({ packageRunId: otherPackageRunId })).total, 1);

  // 与 runId 同时给出：两个条件都要满足（不是并集）。
  assert.equal(service.listProcess(systemLogQuery.parse({ packageRunId, runId })).total, 2);
  assert.equal(service.listProcess(systemLogQuery.parse({ packageRunId, runId: "ffffffff-ffff-4fff-8fff-ffffffffffff" })).total, 0);

  // 大小写不敏感，与 runId 的处理一致。
  assert.equal(service.listProcess(systemLogQuery.parse({ packageRunId: packageRunId.toUpperCase() })).total, 4);

  // 非法形态在契约层就被拒，不会静默返回空页。
  assert.equal(systemLogQuery.safeParse({ packageRunId: "not-a-uuid" }).success, false);
  assert.equal(systemLogQuery.safeParse({ packageRunId: "" }).success, false);
  // 未给该参数时不过滤（保持既有行为）。
  assert.equal(service.listProcess(systemLogQuery.parse({})).total, 6);
});
