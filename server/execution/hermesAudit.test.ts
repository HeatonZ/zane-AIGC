import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { HERMES_AUDIT_OUTPUT_KEYS, HERMES_AUDIT_PROMPT_LIMIT_BYTES, buildHermesAuditPrompt, requestHermesAudit } from "./hermesAudit.js";

const response = (status: number, body: unknown) => new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const packet = { runId: "0b2ddab7-5c7c-4c66-9e62-56bf6d083f3b", status: "completed", steps: [{ stepId: "writer", agent: { promptAvailable: true, prompt: "PROMPT", promptPage: { total: 6 } } }] };

function withHermesEnvironment(t: TestContext) {
  const saved = { key: process.env.HERMES_API_KEY, base: process.env.HERMES_API_BASE_URL };
  process.env.HERMES_API_KEY = "isolated-qa-key";
  process.env.HERMES_API_BASE_URL = "http://127.0.0.1:8642";
  t.after(() => {
    if (saved.key === undefined) delete process.env.HERMES_API_KEY; else process.env.HERMES_API_KEY = saved.key;
    if (saved.base === undefined) delete process.env.HERMES_API_BASE_URL; else process.env.HERMES_API_BASE_URL = saved.base;
  });
}

test("质检提示词固定：系统角色 + 唯一JSON对象契约 + 证据包，专注点不能改写输出契约", () => {
  const { system, user } = buildHermesAuditPrompt(packet, { focus: "重点看镜头数", stepId: "writer" });
  assert.match(system, /独立第三方质检员/);
  assert.match(system, /不重写产物/);
  assert.match(system, /每条结论都必须能定位到具体步骤/);
  for (const key of HERMES_AUDIT_OUTPUT_KEYS) assert.match(user, new RegExp(key));
  assert.match(user, /只质检步骤 writer/);
  assert.match(user, /重点看镜头数/);
  assert.match(user, /已按字节预算截断/);
  assert.match(user, /PROMPT/);
  assert.doesNotMatch(system, /重点看镜头数/, "关注点只进入用户消息，不污染固定系统提示词");
});

test("直连质检走 Hermes runs 链路：system+user 两段消息、模型字段可覆盖，回复按严格契约解析", async t => {
  withHermesEnvironment(t);
  const originalFetch = globalThis.fetch;
  const calls: Array<{ url: string; body: Record<string, unknown>; authorization: string | null }> = [];
  let polls = 0;
  globalThis.fetch = (async (input, init) => {
    const url = String(input);
    calls.push({ url, body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>, authorization: new Headers(init?.headers).get("Authorization") });
    if (url.endsWith("/v1/runs")) return response(202, { run_id: "qa_run", status: "started" });
    polls += 1;
    return response(200, { run_id: "qa_run", status: "completed", output: JSON.stringify({ verdict: "warn", score: 60, summary: "整体可用", findings: [{ severity: "minor", message: "镜头数未对账", stepId: "writer" }], recommendations: ["写死镜头数"] }) });
  }) as typeof fetch;
  try {
    const result = await requestHermesAudit({ target: { profile: "default", provider: "custom:qa", model: "anthropic/claude-opus-5" }, packet, focus: "重点看镜头数", timeoutMs: 5_000 });
    assert.equal(calls.length, 2);
    assert.equal(calls[0]!.url, "http://127.0.0.1:8642/v1/runs");
    assert.equal(calls[0]!.authorization, "Bearer isolated-qa-key");
    assert.equal(calls[0]!.body.model, "anthropic/claude-opus-5", "模型覆盖要真的发出去");
    assert.equal(calls[0]!.body.provider, "custom:qa");
    const input = calls[0]!.body.input as Array<{ role: string; content: string }>;
    assert.deepEqual(input.map(item => item.role), ["system", "user"]);
    assert.match(input[1]!.content, /重点看镜头数/);
    assert.equal(polls, 1);
    assert.equal(result.value.verdict, "warn");
    assert.equal(result.repaired, false);
    assert.ok(result.promptBytes > 0);
    assert.match(result.raw, /整体可用/);
  } finally { globalThis.fetch = originalFetch; }
});

test("直连质检：未声明字段、非法JSON与过大证据包都在发出/采纳之前失败", async t => {
  withHermesEnvironment(t);
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async (input: unknown) => {
    calls += 1;
    const url = String(input);
    if (url.endsWith("/v1/runs")) return response(202, { run_id: "qa_run", status: "started" });
    // 多出一个未声明字段：严格契约必须拒绝，而不是悄悄采纳。
    return response(200, { run_id: "qa_run", status: "completed", output: JSON.stringify({ verdict: "pass", score: 90, summary: "ok", findings: [], recommendations: [], extra: true }) });
  }) as typeof fetch;
  try {
    await assert.rejects(() => requestHermesAudit({ target: { profile: "default" }, packet, timeoutMs: 5_000 }), (error: Error) => error.name === "HermesAuditOutputError" && /extra/.test(error.message));
    assert.equal(calls, 2, "解析失败仍然只有一次付费请求，不自动重投");
    calls = 0;
    const huge = { runId: packet.runId, blob: "x".repeat(HERMES_AUDIT_PROMPT_LIMIT_BYTES + 1) };
    await assert.rejects(() => requestHermesAudit({ target: { profile: "default" }, packet: huge, timeoutMs: 5_000 }), /质检证据包过大/);
    assert.equal(calls, 0, "证据包过大必须在发出付费请求之前失败");
  } finally { globalThis.fetch = originalFetch; }
});
