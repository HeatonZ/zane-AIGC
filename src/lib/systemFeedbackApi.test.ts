import assert from "node:assert/strict";
import test from "node:test";
import { decodeEnvelope, feedbackPath, readFeedback, writeFeedback, listFeedback } from "./systemFeedbackApi";
import { AccessApiError } from "./accessApi";
const id = "0b2ddab7-5c7c-4c66-9e62-56bf6d083f3b";
const envelope = { feedback: { id, revision: 1, userId: "user-a", submitterName: "用户", title: "问题", category: "bug", description: "完整描述", status: "pending", reply: "", createdAt: "2026-10-05T00:00:00Z", updatedAt: "2026-10-05T00:00:00Z" }, nextAction: "get_own_system_feedback" };

test("系统反馈回执必须有同一ID和完整机器结构，错误JSON不伪装成成功", () => {
  assert.equal(decodeEnvelope(envelope, id).feedback.description, "完整描述");
  for (const value of [{}, { feedback: { id } }, { ...envelope, feedback: { ...envelope.feedback, id: "1b2ddab7-5c7c-4c66-9e62-56bf6d083f3b" } }]) {
    assert.throws(() => decodeEnvelope(value, id), (e: unknown) => e instanceof AccessApiError && e.code === "RESPONSE_UNKNOWN");
  }
});
test("系统反馈UI API：按身份发送原ID；响应未知不自动重放，对账只读，分页参数和省略标记保留", async t => {
  const original = globalThis.fetch; const calls: Array<{ url: string; method: string; actor: string | null; body?: string }> = [];
  let response: unknown = {};
  globalThis.fetch = async (url, options) => {
    calls.push({ url: String(url), method: options?.method ?? "GET", actor: new Headers(options?.headers).get("X-Zane-Actor"), body: options?.body as string | undefined });
    return new Response(JSON.stringify(response), { status: 200, headers: { "Content-Type": "application/json" } });
  };
  t.after(() => { globalThis.fetch = original; });
  await assert.rejects(writeFeedback("user-a", feedbackPath(false), id, { feedbackId: id, title: "问题", description: "描述" }), /原ID对账/);
  assert.equal(calls.length, 1); assert.equal(calls[0].actor, "user-a"); assert.equal(JSON.parse(calls[0].body!).feedbackId, id);
  response = envelope; assert.equal((await readFeedback("user-a", false, id)).feedback.id, id);
  assert.equal(calls.length, 2); assert.equal(calls[1].method, "GET"); assert.equal(calls[1].url, feedbackPath(false, id));
  const { description: _description, reply: _reply, ...summary } = envelope.feedback;
  response = { revision: "hash", total: 2, hasMore: true, nextCursor: "next", items: [{ ...summary, descriptionOmitted: true, replyOmitted: true }], nextAction: "get_system_feedback" };
  const page = await listFeedback("admin", true, "pending", "cursor");
  assert.equal(page.items[0].descriptionOmitted, true); assert.equal(page.nextCursor, "next"); assert.equal(calls[2].actor, "admin");
  const url = new URL(calls[2].url, "http://localhost"); assert.equal(url.searchParams.get("status"), "pending"); assert.equal(url.searchParams.get("cursor"), "cursor");
  response = { items: [] }; await assert.rejects(listFeedback("user-a", false, ""), /反馈列表无法读取/);
});
