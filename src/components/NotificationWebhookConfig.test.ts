import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { loadNotificationWebhook, relayNotification, saveNotificationWebhook, testNotificationWebhook } from "../lib/api";
import { notificationWebhookUrlError, validAggregateSeconds } from "./NotificationWebhookConfig";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

test("通知UI校验：只接受 http(s) 完整地址，聚合窗口 5–300 整数", () => {
  for (const value of ["", "  "]) assert.equal(notificationWebhookUrlError(value), "");
  for (const value of ["https://discord.com/api/webhooks/1/token", "http://127.0.0.1:9000/hook"]) assert.equal(notificationWebhookUrlError(value), "", value);
  for (const value of ["ftp://example.com/hook", "not a url", "https://user:pass@example.com/hook", "https://example.com/hook#x", "https://example.com/hook\nnext"]) {
    assert.ok(notificationWebhookUrlError(value), value);
  }
  for (const value of ["", "4", "301", "1.5", "abc"]) assert.equal(validAggregateSeconds(value), false, value);
  for (const value of ["5", "30", "300"]) assert.equal(validAggregateSeconds(value), true, value);
});

test("通知UI客户端：读取快照、url三态写入、测试失败不自动重试", async () => {
  const calls: Array<{ path: string; init?: RequestInit }> = [];
  globalThis.fetch = async (input, init) => {
    calls.push({ path: String(input), init });
    if (String(input).endsWith("/test")) return new Response(JSON.stringify({ attempted: true, sent: false, status: 0, error: "network" }), { headers: { "Content-Type": "application/json" } });
    return new Response(JSON.stringify({ revision: 2, enabled: true }), { headers: { "Content-Type": "application/json" } });
  };
  assert.deepEqual(await loadNotificationWebhook(), { revision: 2, enabled: true });
  assert.equal(calls[0].path, "/api/v1/settings/notification-webhook");
  assert.equal(calls[0].init?.method, undefined, "GET 不带 method");

  await saveNotificationWebhook({ revision: 2, events: ["run.completed"] });
  assert.equal(calls[1].init?.method, "PATCH");
  assert.deepEqual(JSON.parse(calls[1].init?.body as string), { revision: 2, events: ["run.completed"] }, "省略 url 表示保持已保存地址");
  await saveNotificationWebhook({ revision: 2, url: "" });
  assert.deepEqual(JSON.parse(calls[2].init?.body as string), { revision: 2, url: "" }, "空串表示清除");
  await saveNotificationWebhook({ revision: 2, url: "https://example.com/hook" });
  assert.deepEqual(JSON.parse(calls[3].init?.body as string), { revision: 2, url: "https://example.com/hook" }, "非空表示替换");

  const result = await testNotificationWebhook();
  assert.equal(result.sent, false);
  assert.equal(calls[4].init?.method, "POST");
  assert.equal(calls.length, 5, "测试只发一次，不自动重试");

  // 写失败（409/回执丢失）不得重放。
  for (const mode of ["conflict", "lost"] as const) {
    let writes = 0;
    globalThis.fetch = async () => {
      writes++;
      if (mode === "lost") throw new TypeError("receipt lost");
      return new Response(JSON.stringify({ error: "changed", code: "RESOURCE_REVISION_CONFLICT" }), { status: 409, headers: { "Content-Type": "application/json" } });
    };
    await assert.rejects(saveNotificationWebhook({ revision: 2, events: ["run.completed"] }));
    assert.equal(writes, 1);
  }
});

test("入站转发客户端：relayNotification 直接 POST，不自动重试", async () => {
  const calls: Array<{ path: string; init?: RequestInit }> = [];
  globalThis.fetch = async (input, init) => {
    calls.push({ path: String(input), init });
    return new Response(JSON.stringify({ relayed: false, status: 404, target: "https://…hook", webhookFormat: "discord", chars: 3, truncated: false, attemptedAt: "2026-10-19T00:00:00.000Z", error: "目标返回 HTTP 404" }), { headers: { "Content-Type": "application/json" } });
  };
  const result = await relayNotification({ text: "hi", title: "T" });
  assert.equal(result.relayed, false);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].path, "/api/v1/settings/notification-webhook/relay");
  assert.equal(calls[0].init?.method, "POST");
  assert.deepEqual(JSON.parse(calls[0].init?.body as string), { text: "hi", title: "T" });
});
