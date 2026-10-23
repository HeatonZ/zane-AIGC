import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { harness } from "../testing/testSupport.js";
import { WorkspaceService } from "../services/workspaceService.js";
import { AccessService } from "../services/accessService.js";
import { NotificationWebhookService } from "../services/notificationWebhookService.js";
import { createNotificationRelayRouter, createNotificationWebhookRouter } from "./notificationWebhookRoutes.js";
import { notificationWebhookSettingsSchema, notificationWebhookTestResultSchema } from "../domain/notificationWebhook.js";
import { HttpError } from "../errors.js";
import { createServer } from "node:http";

async function notificationHarness(t: Parameters<typeof harness>[0]) {
  const h = await harness(t);
  const workspace = new WorkspaceService(h.store, path.join(h.root, "workspace.json"));
  t.after(() => workspace.shutdown());
  const access = new AccessService(h.store, workspace, "");
  async function createUser(username: string, role: "admin" | "user") {
    const user = (await access.create({ userId: randomUUID(), username, displayName: username, password: "isolated-notification-password", role })).user;
    const session = await access.login(username, "isolated-notification-password");
    return { ...session, user };
  }
  const admin = await createUser("admin", "admin");
  const user = await createUser("user", "user");
  const notifications = new NotificationWebhookService(h.store);
  t.after(() => notifications.shutdown());
  const app = express();
  // 与生产装配同序：入站转发在 express.json 之前，自己读原始文本；其余路由用 JSON 解析。
  app.use(createNotificationRelayRouter(notifications));
  app.use(express.json());
  app.use(access.middleware(async () => h.settings.projectDirectory));
  app.use(createNotificationWebhookRouter(notifications));
  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(error instanceof HttpError ? error.status : 500).json({ error: (error as Error).message, code: error instanceof HttpError ? error.code : "INTERNAL_ERROR" });
  });
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => server.once("listening", resolve));
  t.after(() => new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); }));
  const base = "http://127.0.0.1:" + (server.address() as { port: number }).port;
  async function request(token = admin.token, body?: unknown, suffix = "", method?: string) {
    return fetch(base + "/api/v1/settings/notification-webhook" + suffix, { method: method ?? (body === undefined ? "GET" : "PATCH"), headers: { "Content-Type": "application/json", ...(token ? { Authorization: "Bearer " + token } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  }
  return { ...h, base, access, admin, user, notifications, request };
}

test("通知HTTP：管理员读写、普通用户/匿名拒绝、单例不接受查询参数、不生成", async t => {
  const h = await notificationHarness(t);
  const read = await h.request();
  assert.equal(read.status, 200);
  assert.equal(read.headers.get("cache-control"), "no-store");
  const initial = notificationWebhookSettingsSchema.parse(await read.json());
  assert.equal(initial.revision, 0);
  assert.equal(initial.enabled, false);
  for (const token of ["", h.user.token]) {
    assert.equal((await h.request(token)).status, token ? 403 : 401);
    assert.equal((await h.request(token, { revision: 0, url: "https://example.com/hook" })).status, token ? 403 : 401);
    assert.equal((await h.request(token, undefined, "/test", "POST")).status, token ? 403 : 401);
  }
  for (const suffix of ["?limit=1", "?userId=admin", "?scope=user"]) assert.equal((await h.request(h.admin.token, undefined, suffix)).status, 400);
  for (const body of [{ revision: 0, url: "ftp://example.com/hook" }, { revision: 0, aggregateSeconds: 2 }, { revision: 0, events: ["run.checkpoint"] }, { revision: 0, url: "https://example.com/hook", ownerUserId: "spoof" }]) {
    assert.equal((await h.request(h.admin.token, body)).status, 400);
  }
  const writes = await Promise.all([1, 2].map(() => h.request(h.admin.token, { revision: 0, enabled: false, url: "https://example.com/hook/secret-token", events: ["run.completed"] })));
  assert.deepEqual(writes.map(response => response.status).sort(), [200, 409]);
  // 回执丢失：读回同一单例对账，不重放写入。
  const current = notificationWebhookSettingsSchema.parse(await (await h.request()).json());
  assert.equal(current.revision, 1);
  assert.equal(current.hasUrl, true);
  assert.ok(!JSON.stringify(current).includes("secret-token"));
  assert.equal(h.store.listRuns(h.settings.projectDirectory).runs.length, 0);
});

test("通知HTTP测试：未配置返回400，配置后真实发送并返回具名回执", async t => {
  const h = await notificationHarness(t);
  assert.equal((await h.request(h.admin.token, undefined, "/test", "POST")).status, 400);
  const received: unknown[] = [];
  const receiver = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => { received.push(JSON.parse(Buffer.concat(chunks).toString("utf8"))); response.writeHead(204).end(); });
  });
  receiver.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => receiver.once("listening", resolve));
  t.after(() => new Promise<void>(resolve => { receiver.close(() => resolve()); receiver.closeAllConnections(); }));
  const base = "http://127.0.0.1:" + (receiver.address() as { port: number }).port;
  assert.equal((await h.request(h.admin.token, { revision: 0, url: base + "/hook", enabled: true })).status, 200);
  const tested = await h.request(h.admin.token, undefined, "/test", "POST");
  assert.equal(tested.status, 200);
  const result = notificationWebhookTestResultSchema.parse(await tested.json());
  assert.equal(result.sent, true);
  assert.equal(result.status, 204);
  assert.ok(result.urlMasked.endsWith("hook"));
  assert.equal(received.length, 1);
  assert.match((received[0] as { content: string }).content, /工作台通知测试/);
});

test("入站转发HTTP：不挂管理员中间件，未启用404、错误凭证401、正确凭证转发成功", async t => {
  const h = await notificationHarness(t);
  const received: unknown[] = [];
  const receiver = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => { received.push(JSON.parse(Buffer.concat(chunks).toString("utf8"))); response.writeHead(204).end(); });
  });
  receiver.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => receiver.once("listening", resolve));
  t.after(() => new Promise<void>(resolve => { receiver.close(() => resolve()); receiver.closeAllConnections(); }));
  const target = "http://127.0.0.1:" + (receiver.address() as { port: number }).port;

  // 未启用：即使不带任何凭证也是 404，不暴露路径存在性。
  assert.equal((await fetch(h.base + "/api/v1/hooks/relay", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: "hi" }) })).status, 404);

  const token = "relay-http-token-abcdefghijklmnop";
  assert.equal((await h.request(h.admin.token, { revision: 0, url: target + "/hook", relayEnabled: true, relayToken: token })).status, 200);
  const relay = (authorization?: string, body: unknown = { text: "构建完成", title: "CI" }) => fetch(h.base + "/api/v1/hooks/relay", { method: "POST", headers: { "Content-Type": "application/json", ...(authorization ? { Authorization: authorization } : {}) }, body: JSON.stringify(body) });

  assert.equal((await relay()).status, 401, "缺少凭证");
  assert.equal((await relay("Bearer wrong-token-abcdefghijklmnop")).status, 401);
  // 用管理员会话/凭证调入站转发也无效：它只认 relay token（但这不构成安全缺口，因为目标固定）。
  assert.equal((await relay("Bearer " + h.admin.token)).status, 401);
  // 请求体里的 target/url 被忽略：目标始终是服务端配置的那一个（多余字段不拒收，兜底优先）。
  const injected = await relay("Bearer " + token, { text: "hi", target: "https://evil.example", url: "https://evil.example" });
  assert.equal(injected.status, 200);
  assert.ok(((await injected.json()) as { target: string }).target.endsWith("/hook"), "目标不得被请求体改写");

  const ok = await relay("Bearer " + token);
  assert.equal(ok.status, 200);
  const receipt = await ok.json() as { relayed: boolean; status: number; chars: number };
  assert.equal(receipt.relayed, true);
  assert.equal(receipt.status, 204);
  assert.equal(received.length, 2, "注入 target 的那次也投递了，但目标仍是服务端配置");

  // 管理员入口不需要 relay token。
  const adminRelay = await fetch(h.base + "/api/v1/settings/notification-webhook/relay", { method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer " + h.admin.token }, body: JSON.stringify({ text: "管理员转发" }) });
  assert.equal(adminRelay.status, 200);
  assert.equal(((await adminRelay.json()) as { relayed: boolean }).relayed, true);
  // 普通用户不能走管理员入口。
  assert.equal((await fetch(h.base + "/api/v1/settings/notification-webhook/relay", { method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer " + h.user.token }, body: JSON.stringify({ text: "x" }) })).status, 403);
  // 入站转发不接受查询参数。
  assert.equal((await fetch(h.base + "/api/v1/hooks/relay?target=x", { method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer " + token }, body: JSON.stringify({ text: "x" }) })).status, 400);
});

test("入站转发兜底HTTP：纯文本与坏JSON都接住，不依赖全局express.json", async t => {
  const h = await notificationHarness(t);
  const received: string[] = [];
  const receiver = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => { received.push(JSON.parse(Buffer.concat(chunks).toString("utf8")).content); response.writeHead(204).end(); });
  });
  receiver.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => receiver.once("listening", resolve));
  t.after(() => new Promise<void>(resolve => { receiver.close(() => resolve()); receiver.closeAllConnections(); }));
  const target = "http://127.0.0.1:" + (receiver.address() as { port: number }).port;
  const token = "relay-lenient-http-token-abcdefgh";
  assert.equal((await h.request(h.admin.token, { revision: 0, url: target + "/hook", relayEnabled: true, relayToken: token })).status, 200);

  const post = (body: string, contentType: string) => fetch(h.base + "/api/v1/hooks/relay", {
    method: "POST", headers: { "Content-Type": contentType, Authorization: "Bearer " + token }, body,
  });

  // 纯文本（text/plain）——旧实现会被 express.json 判 400。
  assert.equal((await post("纯文本第一行\n第二行", "text/plain")).status, 200);
  assert.equal(received.at(-1), "纯文本第一行\n第二行");
  // 声明 JSON 但语法坏掉——旧实现会在进入路由前 400。
  const broken = await post("{不是合法JSON", "application/json");
  assert.equal(broken.status, 200, "坏 JSON 应按纯文本转发而不是被拒");
  assert.equal(received.at(-1), "{不是合法JSON");
  // 表单
  assert.equal((await post("text=表单正文&title=表单标题", "application/x-www-form-urlencoded")).status, 200);
  assert.equal(received.at(-1), "**表单标题**\n表单正文");
  // 空内容才拒绝，且说明是空内容
  const empty = await post("", "text/plain");
  assert.equal(empty.status, 400);
  assert.match(((await empty.json()) as { error: string }).error, /转发内容为空/);
});
