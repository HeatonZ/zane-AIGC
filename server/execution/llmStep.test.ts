import assert from "node:assert/strict";
import test from "node:test";
import { runHermesStep } from "./hermesStep.js";
import type { RunStep, SavedSettings } from "../domain/types.js";

const settings: SavedSettings = { enabledHermesProfiles: ["default"], comfyuiBaseUrl: "", projectDirectory: "", workflowTimeoutMinutes: 1 };

function step(extra: Partial<RunStep> = {}): RunStep {
  return { id: "enhance", name: "提示词增强", kind: "capability", capabilityId: "core.llm", capabilityVersion: "1", hermesProfile: "default", promptTemplate: "改写这条指令", inputs: [], outputs: [{ key: "text", label: "文本", type: "text" }], ...extra };
}

/** Capture the exact request bodies the step runner sends, then complete the run. */
async function captureBodies(reply: string, run: () => Promise<unknown>) {
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.HERMES_API_KEY;
  const originalBase = process.env.HERMES_API_BASE_URL;
  const bodies: Array<Record<string, unknown>> = [];
  process.env.HERMES_API_KEY = "test-key";
  process.env.HERMES_API_BASE_URL = "http://127.0.0.1:8642";
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/v1/runs")) {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response(JSON.stringify({ run_id: "run_test", status: "started" }), { status: 202, headers: { "Content-Type": "application/json" } });
    }
    return new Response(JSON.stringify({ run_id: "run_test", status: "completed", output: reply }), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
  try {
    return { result: await run(), bodies };
  } finally {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.HERMES_API_KEY; else process.env.HERMES_API_KEY = originalKey;
    if (originalBase === undefined) delete process.env.HERMES_API_BASE_URL; else process.env.HERMES_API_BASE_URL = originalBase;
  }
}

const messagesOf = (body: Record<string, unknown>) => body.input as Array<{ role: string; content: unknown }>;

test("core.llm 把系统指令作为独立 system 消息发送，user 消息只含任务提示词", async () => {
  const { bodies } = await captureBodies("{\"text\":\"ok\"}", () => runHermesStep(
    step(), {}, new Map(), new Map(), settings,
    undefined, undefined, undefined, undefined,
    { systemPrompt: "你是提示词增强器。", outputMode: "json" },
  ));
  assert.equal(bodies.length, 1);
  const messages = messagesOf(bodies[0]!);
  assert.equal(messages.length, 2, "应当恰好有 system + user 两条消息");
  assert.equal(messages[0]!.role, "system");
  assert.equal(messages[0]!.content, "你是提示词增强器。");
  assert.equal(messages[1]!.role, "user");
  assert.match(String(messages[1]!.content), /改写这条指令/);
  // 输出要求属于 user 消息，不能混进 system。
  assert.match(String(messages[1]!.content), /输出要求/);
});

test("core.llm 省略系统指令时请求体与普通 Hermes 调用一致（只有 user 一条）", async () => {
  const { bodies } = await captureBodies("{\"text\":\"ok\"}", () => runHermesStep(
    step(), {}, new Map(), new Map(), settings,
    undefined, undefined, undefined, undefined,
    { outputMode: "json" },
  ));
  const messages = messagesOf(bodies[0]!);
  assert.equal(messages.length, 1);
  assert.equal(messages[0]!.role, "user");
});

test("text 模式原样返回模型回复，不做 JSON 解析也不裁剪首尾空白", async () => {
  const raw = "  第一行提示词\n第二行提示词  ";
  const { result } = await captureBodies(raw, () => runHermesStep(
    step(), {}, new Map(), new Map(), settings,
    undefined, undefined, undefined, undefined,
    { systemPrompt: "sys", outputMode: "text" },
  ));
  assert.deepEqual(result, { text: raw });
});

test("text 模式的 user 消息不附加 JSON 输出要求", async () => {
  const { bodies } = await captureBodies("任意文本", () => runHermesStep(
    step(), {}, new Map(), new Map(), settings,
    undefined, undefined, undefined, undefined,
    { outputMode: "text" },
  ));
  const userContent = String(messagesOf(bodies[0]!)[0]!.content);
  assert.doesNotMatch(userContent, /只输出一个 JSON 对象/);
  assert.match(userContent, /改写这条指令/);
});

test("text 模式要求恰好一个 text 输出，否则在发出请求前失败", async () => {
  for (const outputs of [
    [{ key: "a", type: "text" }, { key: "b", type: "text" }],
    [{ key: "value", type: "json" }],
    [],
  ]) {
    const { bodies } = await captureBodies("x", async () => {
      await assert.rejects(() => runHermesStep(
        step({ outputs }), {}, new Map(), new Map(), settings,
        undefined, undefined, undefined, undefined,
        { outputMode: "text" },
      ), /纯文本输出模式只支持恰好一个 text 输出|至少需要定义一个步骤输出/);
    });
    assert.equal(bodies.length, 0, "契约不合法时不得发出付费请求");
  }
});

test("json 模式仍按声明端口校验，缺失字段判为失败", async () => {
  await captureBodies("{\"other\":\"x\"}", async () => {
    await assert.rejects(() => runHermesStep(
      step(), {}, new Map(), new Map(), settings,
      undefined, undefined, undefined, undefined,
      { outputMode: "json" },
    ), /缺少字段|未声明字段/);
  });
});
