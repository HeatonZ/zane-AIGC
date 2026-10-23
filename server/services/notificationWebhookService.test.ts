import assert from "node:assert/strict";
import test from "node:test";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { TestContext } from "node:test";
import { NotificationWebhookService } from "./notificationWebhookService.js";
import { SqliteStore } from "../storage/sqliteStore.js";
import { HttpError } from "../errors.js";
import { maskNotificationWebhookUrl, normalizeNotificationWebhookUrl, notificationWebhookSettingsSchema } from "../domain/notificationWebhook.js";

const authorize = () => {};

/** 通知服务只依赖 SQLite 与网络；用 :memory: 库加本地接收端，不触碰临时目录或真实平台。 */
async function service(t: TestContext) {
  const store = new SqliteStore(":memory:");
  t.after(() => store.close());
  const notifications = new NotificationWebhookService(store);
  t.after(() => notifications.shutdown());
  return { store, notifications };
}

function capture() {
  const received: Array<{ url: string; body: unknown }> = [];
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      received.push({ url: request.url ?? "", body: JSON.parse(Buffer.concat(chunks).toString("utf8") || "null") });
      response.writeHead(204).end();
    });
  });
  return { server, received };
}

async function listen(server: ReturnType<typeof createServer>) {
  server.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => server.once("listening", resolve));
  return "http://127.0.0.1:" + (server.address() as { port: number }).port;
}

test("通知地址：只接受 http(s)，拒绝凭据/片段/控制字符；读接口只回末4位掩码", () => {
  assert.equal(normalizeNotificationWebhookUrl("  https://discord.com/api/webhooks/1/token  "), "https://discord.com/api/webhooks/1/token");
  assert.equal(normalizeNotificationWebhookUrl(""), "");
  for (const invalid of ["ftp://example.com/hook", "not a url", "https://user:pass@example.com/hook", "https://example.com/hook#frag", "https://example.com/hook\nnext"]) {
    assert.throws(() => normalizeNotificationWebhookUrl(invalid), /Webhook 地址/, invalid);
  }
  const masked = maskNotificationWebhookUrl("https://discord.com/api/webhooks/123456789012345678/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
  assert.ok(masked.startsWith("https://discord.com/api/webhooks/"));
  assert.ok(masked.endsWith("…aaaa"));
  assert.ok(!masked.includes("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"), "掩码不得包含完整 token");
  assert.equal(maskNotificationWebhookUrl("https://example.com/hook?token=abcdefgh&x=1"), "https://example.com/hook?token=…&x=…");
  assert.equal(maskNotificationWebhookUrl(""), "");
});

test("通知配置：只读不落库、严格参数、url三态、启用前置条件、旧revision冲突、跨连接持久化", async t => {
  const { store, notifications } = await service(t);
  const initial = notifications.read();
  assert.ok(notificationWebhookSettingsSchema.safeParse(initial).success);
  assert.equal(initial.revision, 0);
  assert.equal(initial.enabled, false);
  assert.equal(initial.configured, false);
  assert.deepEqual(initial.events, ["run.waiting", "run.completed", "run.failed", "run.cancelled", "run.stale"]);
  assert.deepEqual(store.listDocuments("@zane-system", "settings"), []);

  for (const invalid of [{}, { revision: -1, url: "https://example.com/h" }, { revision: 0, url: 42 }, { revision: 0, aggregateSeconds: 4 }, { revision: 0, aggregateSeconds: 301 }, { revision: 0, aggregateSeconds: 1.5 }, { revision: 0, events: ["run.checkpoint"] }, { revision: 0, webhookFormat: "teams" }, { revision: 0, url: "https://example.com/h", owner: "spoof" }]) {
    assert.throws(() => notifications.update(invalid, authorize), error => error instanceof HttpError && error.status === 400);
  }
  // 启用但没有地址 / 没有事件：明确拒绝，而不是保存一个「看起来开启」的配置。
  assert.throws(() => notifications.update({ revision: 0, enabled: true }, authorize), error => error instanceof HttpError && error.status === 400);
  assert.equal(notifications.read().revision, 0);

  const saved = notifications.update({ revision: 0, enabled: true, url: "https://example.com/hook/secret-token", events: ["run.completed", "run.failed", "run.completed"], aggregateSeconds: 10 }, authorize);
  assert.equal(saved.revision, 1);
  assert.equal(saved.enabled, true);
  assert.equal(saved.hasUrl, true);
  assert.ok(saved.urlMasked.endsWith("oken"));
  assert.deepEqual(saved.events, ["run.completed", "run.failed"], "事件按固定白名单顺序去重保存");
  assert.equal(saved.aggregateSeconds, 10);
  assert.ok(!JSON.stringify(saved).includes("secret-token"), "读接口不得回显明文地址");
  assert.throws(() => notifications.update({ revision: 0, events: ["run.failed"] }, authorize), error => error instanceof HttpError && error.code === "RESOURCE_REVISION_CONFLICT");

  // 省略 url = 保持；空串 = 清除并同时关闭；只改事件不会清空地址。
  const kept = notifications.update({ revision: 1, events: ["run.failed"] }, authorize);
  assert.equal(kept.hasUrl, true);
  assert.deepEqual(kept.events, ["run.failed"]);
  const cleared = notifications.update({ revision: 2, url: "" }, authorize);
  assert.equal(cleared.hasUrl, false);
  assert.equal(cleared.enabled, false);

  const other = new NotificationWebhookService(store);
  try {
    const restarted = other.read();
    assert.equal(restarted.revision, 3);
    assert.equal(restarted.hasUrl, false);
    assert.equal(restarted.enabled, false);
  } finally { other.shutdown(); }
});

test("通知聚合：窗口到期合并投递，discord载荷禁用提及，成功计入统计且不影响调用方", async t => {
  const { notifications } = await service(t);
  const { server, received } = capture();
  const base = await listen(server);
  t.after(() => new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); }));
  notifications.update({ revision: 0, enabled: true, url: base + "/hook", events: ["run.completed", "run.failed", "step.failed"], aggregateSeconds: 5 }, authorize);

  const run = { runId: "11111111-2222-4333-8444-555555555555", sceneId: "demo", status: "completed", runTitle: "测试任务", workflowName: "流程", steps: [{ stepId: "writer", name: "写作" }] };
  notifications.observe(run, [
    { type: "run.queued", at: "2026-10-19T00:00:00.000Z" },
    { type: "run.completed", at: "2026-10-19T00:00:01.000Z" },
    { type: "step.failed", at: "2026-10-19T00:00:02.000Z", stepId: "writer", payload: { index: 0 } },
    { type: "run.checkpoint", at: "2026-10-19T00:00:03.000Z" },
  ]);
  assert.equal(notifications.read().delivery.pendingEvents, 2, "只入队白名单内事件，且 observe 不发送");
  assert.equal(received.length, 0);

  await (notifications as unknown as { flush(): Promise<void> }).flush();
  assert.equal(received.length, 1);
  const payload = received[0]!.body as { content: string; allowed_mentions: { parse: string[] } };
  assert.deepEqual(payload.allowed_mentions, { parse: [] });
  assert.match(payload.content, /已完成/);
  assert.match(payload.content, /步骤失败/);
  assert.match(payload.content, /写作（第 1 项）/);
  assert.ok(!payload.content.includes("已排队"), "白名单外事件不得出现");
  const delivery = notifications.read().delivery;
  assert.equal(delivery.pendingEvents, 0);
  assert.equal(delivery.deliveredMessages, 1);
  assert.equal(delivery.deliveredEvents, 2);
  assert.equal(delivery.failedMessages, 0);
});

test("通知失败：目标4xx不重试、只记统计，失败后不重排队也不影响后续窗口", async t => {
  const { notifications } = await service(t);
  let attempts = 0;
  const server = createServer((_request, response) => { attempts += 1; response.writeHead(404).end(); });
  const base = await listen(server);
  t.after(() => new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); }));
  notifications.update({ revision: 0, enabled: true, url: base + "/missing", events: ["run.failed"], aggregateSeconds: 5 }, authorize);
  notifications.observe({ runId: "11111111-2222-4333-8444-555555555555", sceneId: "demo", status: "failed", error: "boom" }, [{ type: "run.failed", at: "2026-10-19T00:00:00.000Z" }]);
  await (notifications as unknown as { flush(): Promise<void> }).flush();
  assert.equal(attempts, 1, "4xx 是确定性失败，不重试");
  const delivery = notifications.read().delivery;
  assert.equal(delivery.failedMessages, 1);
  assert.equal(delivery.droppedEvents, 1);
  assert.equal(delivery.pendingEvents, 0);
  assert.match(delivery.lastError ?? "", /404/);

  // 恢复后新事件仍能送达：失败不会让服务进入永久不可用状态。
  const { server: healthy, received } = capture();
  const healthyBase = await listen(healthy);
  t.after(() => new Promise<void>(resolve => { healthy.close(() => resolve()); healthy.closeAllConnections(); }));
  notifications.update({ revision: 1, url: healthyBase + "/hook" }, authorize);
  notifications.observe({ runId: "11111111-2222-4333-8444-555555555555", sceneId: "demo", status: "failed" }, [{ type: "run.failed", at: "2026-10-19T00:00:05.000Z" }]);
  await (notifications as unknown as { flush(): Promise<void> }).flush();
  assert.equal(received.length, 1);
  assert.equal(notifications.read().delivery.failedMessages, 1);
  assert.equal(notifications.read().delivery.deliveredMessages, 1);
});

test("通知测试：未配置时明确拒绝；配置后真实发送固定内容并返回脱敏回执", async t => {
  const { notifications } = await service(t);
  await assert.rejects(notifications.test(authorize), error => error instanceof HttpError && error.code === "NOTIFICATION_WEBHOOK_NOT_CONFIGURED");
  const { server, received } = capture();
  const base = await listen(server);
  t.after(() => new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); }));
  notifications.update({ revision: 0, url: base + "/hook", webhookFormat: "generic" }, authorize);
  const result = await notifications.test(authorize);
  assert.equal(result.sent, true);
  assert.equal(result.status, 204);
  assert.ok(result.urlMasked.endsWith("hook"));
  const body = received[0]!.body as { source: string; text: string; events: Array<{ type: string }> };
  assert.equal(body.source, "zane-workbench");
  assert.match(body.text, /工作台通知测试/);
  assert.equal(body.events[0]!.type, "notification.test");
  assert.equal(notifications.read().delivery.deliveredMessages, 0, "测试不计入运行事件统计");
});

test("通知关闭/未启用时 observe 不入队，也不产生任何请求", async t => {
  const { notifications } = await service(t);
  const { server, received } = capture();
  const base = await listen(server);
  t.after(() => new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); }));
  notifications.update({ revision: 0, url: base + "/hook", enabled: false }, authorize);
  notifications.observe({ runId: "11111111-2222-4333-8444-555555555555", sceneId: "demo", status: "completed" }, [{ type: "run.completed", at: "2026-10-19T00:00:00.000Z" }]);
  await (notifications as unknown as { flush(): Promise<void> }).flush();
  assert.equal(received.length, 0);
  assert.equal(notifications.read().delivery.pendingEvents, 0);
  assert.equal(notifications.read().delivery.deliveredEvents, 0);
});

test("平台适配器：同一批事件按目标平台拼装不同载荷，并按平台上限截断", async t => {
  const { notifications } = await service(t);
  const bodies: Array<{ url: string; body: Record<string, unknown>; contentType: string | undefined }> = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      bodies.push({ url: request.url ?? "", body: JSON.parse(Buffer.concat(chunks).toString("utf8")), contentType: request.headers["content-type"] });
      response.writeHead(204).end();
    });
  });
  const base = await listen(server);
  t.after(() => new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); }));

  const event = (): Parameters<NotificationWebhookService["observe"]>[1][number] => ({ type: "run.completed", at: "2026-10-19T00:00:00.000Z" });
  const run = { runId: "11111111-2222-4333-8444-555555555555", sceneId: "demo", status: "completed", runTitle: "任务" };

  for (const format of ["discord", "slack", "feishu", "generic"] as const) {
    const revision = notifications.read().revision;
    notifications.update({ revision, enabled: true, url: base + "/" + format, webhookFormat: format }, authorize);
    notifications.observe(run, [event()]);
    await (notifications as unknown as { flush(): Promise<void> }).flush();
  }
  assert.equal(bodies.length, 4);
  assert.equal(bodies.every(item => item.contentType === "application/json"), true);
  const byUrl = Object.fromEntries(bodies.map(item => [item.url, item.body]));
  assert.deepEqual(byUrl["/discord"], { content: "【已完成】任务\n运行：11111111\n场景：demo", allowed_mentions: { parse: [] } });
  assert.deepEqual(byUrl["/slack"], { text: "【已完成】任务\n运行：11111111\n场景：demo", unfurl_links: false, unfurl_media: false });
  assert.deepEqual(byUrl["/feishu"], { msg_type: "text", content: { text: "【已完成】任务\n运行：11111111\n场景：demo" } });
  assert.equal((byUrl["/generic"] as { source: string }).source, "zane-workbench");
  assert.equal(((byUrl["/generic"] as { events: unknown[] }).events).length, 1);
  // 平台上限进入读接口，界面与 AI 直接可用。
  assert.deepEqual(notifications.read().formats.map(item => [item.id, item.maxChars]), [["discord", 1900], ["slack", 2900], ["feishu", 3500], ["generic", 1900]]);
});

test("平台限流：429 读 Retry-After/retry_after 退避后重试一次，成功即计入送达", async t => {
  const { notifications } = await service(t);
  let attempts = 0;
  const server = createServer((request, response) => {
    attempts += 1;
    request.resume();
    if (attempts === 1) {
      response.writeHead(429, { "Retry-After": "0", "Content-Type": "application/json" });
      response.end(JSON.stringify({ retry_after: 0, global: false }));
      return;
    }
    response.writeHead(204).end();
  });
  const base = await listen(server);
  t.after(() => new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); }));
  notifications.update({ revision: 0, enabled: true, url: base + "/hook", events: ["run.completed"] }, authorize);
  notifications.observe({ runId: "11111111-2222-4333-8444-555555555555", sceneId: "demo", status: "completed" }, [{ type: "run.completed", at: "2026-10-19T00:00:00.000Z" }]);
  await (notifications as unknown as { flush(): Promise<void> }).flush();
  assert.equal(attempts, 2, "429 是可恢复限流：退避后重试一次");
  const delivery = notifications.read().delivery;
  assert.equal(delivery.deliveredMessages, 1);
  assert.equal(delivery.failedMessages, 0);
});

test("正文超长：按平台上限截断并明确标记，不静默丢弃", async t => {
  const { notifications } = await service(t);
  const received: string[] = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => { received.push(JSON.parse(Buffer.concat(chunks).toString("utf8")).content); response.writeHead(204).end(); });
  });
  const base = await listen(server);
  t.after(() => new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); }));
  notifications.update({ revision: 0, enabled: true, url: base + "/hook", webhookFormat: "discord", events: ["run.completed"] }, authorize);
  // 单事件正文受错误摘要长度限制；用满 10 个事件的聚合批次越过 discord 的 1900 字上限。
  const events = Array.from({ length: 10 }, () => ({ type: "run.completed" as const, at: "2026-10-19T00:00:00.000Z" }));
  notifications.observe({ runId: "11111111-2222-4333-8444-555555555555", sceneId: "demo", status: "completed", runTitle: "超长标题".repeat(40), error: "错".repeat(4000) }, events);
  await (notifications as unknown as { flush(): Promise<void> }).flush();
  assert.equal(received.length, 1, "10 个事件仍在单条消息内");
  assert.ok(received[0]!.length <= 1920, "正文必须落在平台上限附近：" + received[0]!.length);
  assert.match(received[0]!, /…（已截断）/);
});

test("入站转发：未启用404、凭证错误401、正确凭证按平台适配器转发并返回回执", async t => {
  const { notifications } = await service(t);
  const received: Array<Record<string, unknown>> = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => { received.push(JSON.parse(Buffer.concat(chunks).toString("utf8"))); response.writeHead(204).end(); });
  });
  const base = await listen(server);
  t.after(() => new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); }));

  // 未启用：即使凭证正确也 404，不暴露该路径是否存在。
  await assert.rejects(notifications.relay({ text: "hi" }, "x".repeat(32)), error => error instanceof HttpError && error.status === 404 && error.code === "RELAY_NOT_ENABLED");

  const token = "relay-token-abcdefghijklmnopqrstuvwxyz";
  notifications.update({ revision: 0, url: base + "/hook", webhookFormat: "discord", relayEnabled: true, relayToken: token }, authorize);
  const state = notifications.read();
  assert.equal(state.relay.enabled, true);
  assert.equal(state.relay.configured, true);
  assert.ok(state.relay.tokenMasked.endsWith("wxyz"));
  assert.ok(!JSON.stringify(state).includes(token), "读接口不得回显 relay 凭证");

  for (const wrong of [undefined, "", "short", "x".repeat(token.length)]) {
    await assert.rejects(notifications.relay({ text: "hi" }, wrong), error => error instanceof HttpError && error.status === 401 && error.code === "RELAY_TOKEN_INVALID");
  }
  await assert.rejects(notifications.relay({ text: "" }, token), error => error instanceof HttpError && error.status === 400);
  // 多出来的键被忽略而不是拒收：目标是服务端固定的，请求体写 url/target 不会改变投递目标。
  assert.equal((await notifications.relay({ text: "hi", url: "https://evil.example", target: "https://evil.example" }, token)).relayed, true);

  const receipt = await notifications.relay({ text: "构建完成", title: "CI", source: "jenkins" }, token);
  assert.equal(receipt.relayed, true);
  assert.equal(receipt.status, 204);
  assert.equal(receipt.webhookFormat, "discord");
  assert.equal(receipt.truncated, false);
  assert.ok(receipt.target.endsWith("hook"));
  assert.equal(received.length, 2, "前面那条带 url/target 的请求也成功投递了，但目标仍是服务端配置");
  assert.equal(received.at(-1)!.content, "**CI**\n构建完成");
  assert.deepEqual(received.at(-1)!.allowed_mentions, { parse: [] });
  assert.equal(notifications.read().delivery.relayedMessages, 2);

  // 关闭入站转发后立刻不可用（凭证仍保留）。
  const revision = notifications.read().revision;
  notifications.update({ revision, relayEnabled: false }, authorize);
  await assert.rejects(notifications.relay({ text: "hi" }, token), error => error instanceof HttpError && error.status === 404);
});

test("入站转发：超长正文按平台上限截断并标记，管理员转发不需要 relay 凭证", async t => {
  const { notifications } = await service(t);
  const received: string[] = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => { received.push(JSON.parse(Buffer.concat(chunks).toString("utf8")).content.text); response.writeHead(204).end(); });
  });
  const base = await listen(server);
  t.after(() => new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); }));

  notifications.update({ revision: 0, url: base + "/hook", webhookFormat: "feishu" }, authorize);
  const receipt = await notifications.relayAsAdmin({ text: "长".repeat(4000) }, authorize);
  assert.equal(receipt.relayed, true);
  assert.equal(receipt.truncated, true);
  assert.ok(receipt.chars <= 3500 + 20, "飞书上限 3500：" + receipt.chars);
  assert.match(received[0]!, /…（已截断）/);
  // 管理员转发不依赖 relay 开关，但没有目标地址时必须明确失败。
  const revision = notifications.read().revision;
  notifications.update({ revision, url: "" }, authorize);
  await assert.rejects(notifications.relayAsAdmin({ text: "hi" }, authorize), error => error instanceof HttpError && error.code === "NOTIFICATION_WEBHOOK_NOT_CONFIGURED");
});

test("入站转发兜底：纯文本/任意JSON/表单/别家载荷都能提取正文，只有空内容被拒", async t => {
  const { notifications } = await service(t);
  const received: string[] = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => { received.push(JSON.parse(Buffer.concat(chunks).toString("utf8")).content); response.writeHead(204).end(); });
  });
  const base = await listen(server);
  t.after(() => new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); }));

  const token = "relay-fallback-token-abcdefghijkl";
  notifications.update({ revision: 0, url: base + "/hook", webhookFormat: "discord", relayEnabled: true, relayToken: token }, authorize);

  // 1. 纯文本（最常见的「不规则调用」）
  assert.equal((await notifications.relay("部署完成 ✅\n第二行", token, "text/plain")).relayed, true);
  assert.equal(received.at(-1), "部署完成 ✅\n第二行");

  // 2. 任意 JSON：字段名不认识也要接住，取不到就序列化整个对象
  assert.equal((await notifications.relay('{"foo":"bar","n":42}', token, "application/json")).relayed, true);
  assert.match(received.at(-1)!, /"foo": "bar"/);

  // 3. 常见字段名
  for (const [payload, expected] of [
    [{ message: "来自 message" }, "来自 message"],
    [{ content: "来自 content" }, "来自 content"],
    [{ subject: "标题", body: "正文" }, "**标题**\n正文"],
    [{ data: { text: "嵌套 text" } }, "嵌套 text"],
    [{ payload: { message: "嵌套 message" } }, "嵌套 message"],
  ] as const) {
    assert.equal((await notifications.relay(payload, token)).relayed, true);
    assert.equal(received.at(-1), expected);
  }

  // 4. 飞书原生载荷 {msg_type, content:{text}}
  await notifications.relay({ msg_type: "text", content: { text: "飞书原生" } }, token);
  assert.equal(received.at(-1), "飞书原生");

  // 5. 表单
  await notifications.relay("text=表单正文&title=表单标题", token, "application/x-www-form-urlencoded");
  assert.equal(received.at(-1), "**表单标题**\n表单正文");

  // 6. 数组：序列化保留
  await notifications.relay([{ a: 1 }, { b: 2 }], token);
  assert.match(received.at(-1)!, /"a": 1/);

  // 7. 只有真正空内容才拒绝，并且说明是空内容
  for (const empty of ["", "   ", {}, [], null, undefined]) {
    await assert.rejects(notifications.relay(empty, token), error => error instanceof HttpError && error.status === 400 && /转发内容为空/.test(error.message), JSON.stringify(empty));
  }

  // 8. 声明 JSON 但语法坏了：按纯文本转发，不拒收
  await notifications.relay("{这不是合法JSON", token, "application/json");
  assert.equal(received.at(-1), "{这不是合法JSON");
});

test("入站转发兜底：超长纯文本按平台上限截断而不是拒绝", async t => {
  const { notifications } = await service(t);
  const received: string[] = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => { received.push(JSON.parse(Buffer.concat(chunks).toString("utf8")).content); response.writeHead(204).end(); });
  });
  const base = await listen(server);
  t.after(() => new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); }));
  notifications.update({ revision: 0, url: base + "/hook", webhookFormat: "discord", relayEnabled: true, relayToken: "relay-long-text-token-abcdefghij" }, authorize);
  const receipt = await notifications.relay("字".repeat(19000), "relay-long-text-token-abcdefghij", "text/plain");
  assert.equal(receipt.relayed, true);
  assert.equal(receipt.truncated, true);
  assert.ok(receipt.chars <= 1920, "按 discord 上限截断：" + receipt.chars);
  assert.match(received[0]!, /…（已截断）/);
});

test("入站转发凭证：relay token 与 ZANE_ADMIN_TOKEN 任一匹配即可，其余一律401", async t => {
  const store = new SqliteStore(":memory:");
  t.after(() => store.close());
  const operatorToken = "operator-token-for-relay-tests-0123456789";
  const notifications = new NotificationWebhookService(store, operatorToken);
  t.after(() => notifications.shutdown());
  const received: unknown[] = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => { received.push(JSON.parse(Buffer.concat(chunks).toString("utf8"))); response.writeHead(204).end(); });
  });
  const base = await listen(server);
  t.after(() => new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); }));

  const relayToken = "relay-token-both-modes-abcdefghij";
  notifications.update({ revision: 0, url: base + "/hook", relayEnabled: true, relayToken }, authorize);

  // relay token 可用
  assert.equal((await notifications.relay({ text: "relay" }, relayToken)).relayed, true);
  // 运维凭证也可用（不需要单独配 relay token）
  assert.equal((await notifications.relay({ text: "operator" }, operatorToken)).relayed, true);
  // 其它一律拒绝
  for (const wrong of [undefined, "", "short", "x".repeat(operatorToken.length), relayToken.slice(0, -1)]) {
    await assert.rejects(notifications.relay({ text: "x" }, wrong), error => error instanceof HttpError && error.status === 401);
  }
  assert.equal(received.length, 2);

  // 清空 relayToken 会关闭入口（没有凭证即不启用），这是 update 的既有语义。
  const revision = notifications.read().revision;
  notifications.update({ revision, relayToken: "" }, authorize);
  await assert.rejects(notifications.relay({ text: "x" }, operatorToken), error => error instanceof HttpError && error.status === 404);
  await assert.rejects(notifications.relay({ text: "x" }, relayToken), error => error instanceof HttpError && error.status === 404);
});
