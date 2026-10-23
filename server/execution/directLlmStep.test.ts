import assert from "node:assert/strict";
import test from "node:test";
import { runHermesStep } from "./hermesStep.js";
import { normalizeDirectLlmApiKey, normalizeDirectLlmApiKeyEnv, normalizeDirectLlmBaseUrl, normalizeDirectLlmModel, type DirectLlmTarget } from "../domain/directLlm.js";
import type { RunStep, SavedSettings } from "../domain/types.js";

const settings: SavedSettings = { enabledHermesProfiles: ["default"], comfyuiBaseUrl: "", projectDirectory: "", workflowTimeoutMinutes: 1 };
const keyEnv = "ZANE_TEST_DIRECT_LLM_KEY";
/** 明文密钥哨兵：任何日志、错误、请求体里出现它就说明护栏破了。 */
const plaintextKey = "sk-live-PLAINTEXT-SENTINEL-0f9a8b7c6d5e4f3a";
/** 1x1 PNG：真实 base64 附件构造路径，不需要任何外部服务。 */
const pngBytes = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+Xv1EAAAAASUVORK5CYII=", "base64");
const pngDataUrl = `data:image/png;base64,${pngBytes.toString("base64")}`;

interface Captured { url: string; method: string; headers: Record<string, string>; body: Record<string, unknown> }

function step(extra: Partial<RunStep> = {}): RunStep {
  return { id: "enhance", name: "提示词增强", kind: "capability", capabilityId: "core.llm", capabilityVersion: "1", promptTemplate: "改写这条指令", inputs: [], outputs: [{ key: "text", label: "文本", type: "text" }], ...extra };
}

/** 默认：用页面上保存的明文密钥（apiKey），同时给一个永远不会被读到的 apiKeyEnv，
 *  这样「优先级」也被隐式断言：只要 apiKey 非空就不该去看环境变量。 */
const directTarget = (extra: Partial<DirectLlmTarget> = {}): DirectLlmTarget => ({
  enabled: true, providerId: "local-ollama", protocol: "openai-chat", baseUrl: "http://127.0.0.1:11434/v1",
  apiKey: plaintextKey, apiKeyEnv: "ZANE_TEST_NEVER_READ_KEY_ENV", model: "qwen2.5-7b-instruct", ...extra,
});

/** Fake fetch: record every request; never reach a real provider.
 *  默认设置 HERMES_API_KEY/HERMES_API_BASE_URL 哨兵值：
 *   - 直连路径若误用 Hermes 凭证或网关地址，测试会立刻看到；
 *   - 「非直连」回归用例可以真正走到 Hermes 请求构造，而不依赖本机 Hermes Profile。
 *  两种通道的响应信封不同：Hermes 的轮询端点返回 {run_id,status,output}，
 *  直连提供商直接返回协议信封（OpenAI choices / Anthropic content），因此 hermesReply 可单独给。 */
async function captureRequests<T>(reply: string, status: number, run: () => Promise<T>, hermesReply = reply) {
  const originalFetch = globalThis.fetch;
  const original = { key: process.env.HERMES_API_KEY, base: process.env.HERMES_API_BASE_URL };
  const captured: Captured[] = [];
  process.env.HERMES_API_KEY = "hermes-key-must-not-be-used";
  process.env.HERMES_API_BASE_URL = "http://127.0.0.1:8642";
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    const url = String(input);
    captured.push({
      url, method: String(init?.method ?? "GET"),
      headers: Object.fromEntries(headers.entries()),
      body: init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {},
    });
    // Hermes 的 Runs 入口先 202 受理、再由轮询返回最终 output；直连提供商只有一个响应。
    if (url.endsWith("/v1/runs")) return new Response(JSON.stringify({ run_id: "run_test", status: "started" }), { status: 202, headers: { "Content-Type": "application/json" } });
    if (url.includes("/v1/runs/")) return new Response(JSON.stringify({ run_id: "run_test", status: "completed", output: hermesReply }), { status: 200, headers: { "Content-Type": "application/json" } });
    return new Response(reply, { status, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
  try { return { result: await run(), captured }; }
  finally {
    globalThis.fetch = originalFetch;
    for (const [name, value] of [["HERMES_API_KEY", original.key], ["HERMES_API_BASE_URL", original.base]] as const) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
  }
}

const ok = (content: string) => JSON.stringify({ choices: [{ message: { role: "assistant", content } }] });

test("直连模式（openai-chat）POST <baseUrl>/chat/completions，用页面上保存的明文密钥", async () => {
  const { result, captured } = await captureRequests(ok("{\"text\":\"直连结果\"}"), 200, () => runHermesStep(
    step(), {}, new Map(), new Map(), settings,
    undefined, undefined, undefined, undefined,
    { systemPrompt: "你是提示词增强器。", outputMode: "json", direct: directTarget() },
  ));
  assert.deepEqual(result, { text: "直连结果" });
  assert.equal(captured.length, 1);
  assert.equal(captured[0]!.url, "http://127.0.0.1:11434/v1/chat/completions", "必须打到 OpenAI 兼容补全端点");
  assert.equal(captured[0]!.method, "POST");
  assert.equal(captured[0]!.headers["authorization"], "Bearer " + plaintextKey, "密钥必须来自提供商保存的明文");
  assert.equal(captured[0]!.body.model, "qwen2.5-7b-instruct", "模型名必须取自提供商解析结果");
  assert.equal(captured[0]!.body.stream, false);
  // 直连不使用 hermesProvider/hermesModel 覆盖，也不发送 Runs API 的字段。
  assert.equal("input" in captured[0]!.body, false, "直连不能发送 Hermes /v1/runs 的 input 字段");
  assert.equal("provider" in captured[0]!.body, false);
  const messages = captured[0]!.body.messages as Array<{ role: string; content: unknown }>;
  assert.equal(messages.length, 2);
  assert.equal(messages[0]!.role, "system");
  assert.equal(messages[0]!.content, "你是提示词增强器。");
  assert.equal(messages[1]!.role, "user");
  // 明文密钥只能出现在鉴权头里：请求体（即运行输入/记录的来源）绝不能带上它。
  assert.doesNotMatch(JSON.stringify(captured[0]!.body), new RegExp(plaintextKey), "密钥不得进入请求体");
});

/** 上游消息属于不可信文本：除了先做通用脱敏、再抹掉本次实际使用的密钥，
 *  还要挡住「上游把收到的 key 原样回显、但前面没有任何 apiKey/Bearer 标签」的情况。 */
test("直连模式（anthropic）POST <baseUrl>/messages，用 x-api-key 与 anthropic-version，system 走顶层字段", async () => {
  const { result, captured } = await captureRequests(JSON.stringify({ content: [{ type: "text", text: "前半段" }, { type: "text", text: "后半段" }] }), 200, () => runHermesStep(
    step(), {}, new Map(), new Map(), settings,
    undefined, undefined, undefined, undefined,
    { systemPrompt: "你是提示词增强器。", outputMode: "text", direct: directTarget({ protocol: "anthropic", baseUrl: "https://api.anthropic.com/v1", providerId: "claude", model: "claude-sonnet-4" }) },
  ));
  // 多个 text 内容块必须拼接，不能只取第一块。
  assert.deepEqual(result, { text: "前半段后半段" });
  assert.equal(captured.length, 1);
  assert.equal(captured[0]!.url, "https://api.anthropic.com/v1/messages");
  assert.equal(captured[0]!.headers["x-api-key"], plaintextKey, "Anthropic 用 x-api-key 携带明文密钥");
  assert.equal(captured[0]!.headers["anthropic-version"], "2023-06-01");
  assert.equal("authorization" in captured[0]!.headers, false, "Anthropic 不能用 Authorization");
  assert.equal(captured[0]!.body.model, "claude-sonnet-4");
  assert.equal(captured[0]!.body.max_tokens, 4096);
  assert.equal(captured[0]!.body.system, "你是提示词增强器。", "system 必须是顶层字段，不能是 messages 条目");
  const messages = captured[0]!.body.messages as Array<{ role: string }>;
  assert.deepEqual(messages.map(message => message.role), ["user"], "system 不应出现在 messages 里");
});

test("密钥优先级：明文 apiKey 非空时不读 apiKeyEnv；为空时回退环境变量并正常工作", async () => {
  // 未设置 ZANE_TEST_NEVER_READ_KEY_ENV：如果实现错误地优先用环境变量，这里会直接失败。
  delete process.env.ZANE_TEST_NEVER_READ_KEY_ENV;
  const primary = await captureRequests(ok("{\"text\":\"ok\"}"), 200, () => runHermesStep(
    step(), {}, new Map(), new Map(), settings, undefined, undefined, undefined, undefined,
    { outputMode: "json", direct: directTarget() },
  ));
  assert.deepEqual(primary.result, { text: "ok" });
  assert.equal(primary.captured[0]!.headers["authorization"], "Bearer " + plaintextKey);

  const original = process.env[keyEnv];
  process.env[keyEnv] = "environment-fallback-secret";
  try {
    const fallback = await captureRequests(ok("{\"text\":\"ok\"}"), 200, () => runHermesStep(
      step(), {}, new Map(), new Map(), settings, undefined, undefined, undefined, undefined,
      { outputMode: "json", direct: directTarget({ apiKey: "", apiKeyEnv: keyEnv }) },
    ));
    assert.deepEqual(fallback.result, { text: "ok" });
    assert.equal(fallback.captured[0]!.headers["authorization"], "Bearer environment-fallback-secret", "apiKey 为空时必须回退到 apiKeyEnv");
  } finally {
    if (original === undefined) delete process.env[keyEnv]; else process.env[keyEnv] = original;
  }
});

test("直连图片附件按协议分别映射：OpenAI 用 image_url，Anthropic 用 base64 source 块", () => {
  const imagePart = { type: "image_url" as const, image_url: { url: pngDataUrl, detail: "high" as const } };
  return import("./directLlmProtocol.js").then(({ buildDirectLlmCompletionRequest }) => {
    const openAiBody = JSON.parse(buildDirectLlmCompletionRequest("openai-chat", "http://127.0.0.1:11434/v1", "k", "m", [{ role: "user", content: [imagePart] }]).body!) as Record<string, unknown>;
    const openAiParts = (openAiBody.messages as Array<{ content: Array<Record<string, unknown>> }>)[0]!.content;
    assert.deepEqual(openAiParts[0], { type: "image_url", image_url: { url: pngDataUrl, detail: "high" } });

    const anthropicBody = JSON.parse(buildDirectLlmCompletionRequest("anthropic", "https://api.anthropic.com/v1", "k", "m", [{ role: "user", content: [imagePart] }]).body!) as Record<string, unknown>;
    const anthropicParts = (anthropicBody.messages as Array<{ content: Array<Record<string, unknown>> }>)[0]!.content;
    assert.deepEqual(anthropicParts[0], {
      type: "image",
      source: { type: "base64", media_type: "image/png", data: pngBytes.toString("base64") },
    }, "Anthropic 必须用 base64 source 结构，且复用同一份编码而不是重新编码");

    // 非 data URL 的 http(s) 图片交给 Anthropic 的 url source；其它形态必须明确失败。
    const urlBody = JSON.parse(buildDirectLlmCompletionRequest("anthropic", "https://api.anthropic.com/v1", "k", "m", [{ role: "user", content: [{ type: "image_url", image_url: { url: "https://cdn.example.com/a.png", detail: "high" } }] }]).body!) as Record<string, unknown>;
    assert.deepEqual((urlBody.messages as Array<{ content: Array<Record<string, unknown>> }>)[0]!.content[0], { type: "image", source: { type: "url", url: "https://cdn.example.com/a.png" } });
    assert.throws(() => buildDirectLlmCompletionRequest("anthropic", "https://api.anthropic.com/v1", "k", "m", [{ role: "user", content: [{ type: "image_url", image_url: { url: "not-an-image", detail: "high" } }] }]), /图片附件/);
  });
});

test("直连字段不全时 0 次请求，且文案只说自己而不是 Hermes，也不泄露密钥", async () => {
  for (const [label, target, expected] of [
    ["未启用", directTarget({ enabled: false }), /直连模型提供商未启用/],
    ["缺地址", directTarget({ baseUrl: "" }), /未配置服务地址/],
    ["既无明文密钥也无环境变量名", directTarget({ apiKey: "", apiKeyEnv: "" }), /未配置 API 密钥/],
    ["缺模型名", directTarget({ model: "" }), /未配置模型名/],
  ] as const) {
    const { captured } = await captureRequests(ok("{}"), 200, async () => {
      await assert.rejects(
        () => runHermesStep(step(), {}, new Map(), new Map(), settings, undefined, undefined, undefined, undefined, { outputMode: "json", direct: target }),
        (error: Error) => {
          assert.match(error.message, expected, label);
          assert.doesNotMatch(error.message, /Hermes/, label + " 的直连失败文案不得提 Hermes");
          assert.doesNotMatch(error.message, new RegExp(plaintextKey), label + " 的错误消息不得含密钥明文");
          return true;
        },
      );
    });
    assert.equal(captured.length, 0, label + " 时不得发出任何请求");
  }
});

test("明文密钥为空且环境变量不存在时 0 次请求，文案说明缺什么且不含其他密钥", async () => {
  delete process.env.ZANE_TEST_MISSING_KEY_ENV;
  const { captured } = await captureRequests(ok("{}"), 200, async () => {
    await assert.rejects(
      () => runHermesStep(step(), {}, new Map(), new Map(), settings, undefined, undefined, undefined, undefined, { outputMode: "json", direct: directTarget({ apiKey: "", apiKeyEnv: "ZANE_TEST_MISSING_KEY_ENV" }) }),
      (error: Error) => {
        assert.match(error.message, /未配置 API 密钥/);
        assert.match(error.message, /ZANE_TEST_MISSING_KEY_ENV/, "文案要指出是哪个环境变量缺失");
        assert.doesNotMatch(error.message, /Hermes/);
        return true;
      },
    );
  });
  assert.equal(captured.length, 0, "缺少密钥时必须在上游请求之前失败");
});

test("直连 401/403/其它错误映射为认证失败/请求失败，上游回显的密钥被抹掉，且不自动重试", async () => {
  for (const [status, expected] of [[401, /认证失败/], [500, /请求失败/]] as const) {
    // 上游原样回显收到的密钥（现实里很常见），错误消息里绝不能带出来。
    // 第二种形态带 key=value 标签，用来说明通用脱敏规则也在生效。
    const { captured } = await captureRequests(JSON.stringify({ error: { message: "invalid key " + plaintextKey + " (apiKey=sk-live-abcdefghijklmnop)" } }), status, async () => {
      await assert.rejects(
        () => runHermesStep(step(), {}, new Map(), new Map(), settings, undefined, undefined, undefined, undefined, { outputMode: "json", direct: directTarget() }),
        (error: Error) => {
          assert.match(error.message, expected);
          assert.doesNotMatch(error.message, /Hermes/);
          assert.doesNotMatch(error.message, new RegExp(plaintextKey), "上游回显的密钥必须被抹掉");
          assert.doesNotMatch(error.message, /sk-live-abcdefghijklmnop/, "其它密钥形态也必须按通用规则脱敏");
          return true;
        },
      );
    });
    assert.equal(captured.length, 1, "补全非幂等：一次调用只允许一次请求");
  }
});

test("直连响应缺少文本内容时明确失败，不返回空串", async () => {
  await captureRequests(JSON.stringify({ choices: [{ message: {} }] }), 200, async () => {
    await assert.rejects(
      () => runHermesStep(step(), {}, new Map(), new Map(), settings, undefined, undefined, undefined, undefined, { outputMode: "json", direct: directTarget() }),
      /没有返回文本内容/,
    );
  });
});

test("直连路径完全不读 Hermes Profile：hermesProfile 无效也能执行，hermesProvider/hermesModel 被忽略", async () => {
  const { result, captured } = await captureRequests(ok("{\"text\":\"直连结果\"}"), 200, () => runHermesStep(
    step({ hermesProfile: "不存在的 Profile 名", hermesProvider: "custom:whatever", hermesModel: "some/model" }),
    {}, new Map(), new Map(), settings,
    undefined, undefined, undefined, undefined,
    { outputMode: "json", direct: directTarget() },
  ));
  assert.deepEqual(result, { text: "直连结果" }, "无效 Profile 不得阻断直连");
  assert.equal(captured.length, 1);
  assert.equal(captured[0]!.body.model, "qwen2.5-7b-instruct", "模型只能来自直连目标");
  assert.equal("provider" in captured[0]!.body, false, "hermesProvider 不得进入直连请求体");
});

test("不传 direct 时保持历史 Hermes 路径：请求打到 Hermes 网关，绝不碰提供商端点", async () => {
  // Hermes 通道的 output 字段承载模型回复文本；这里给一个合法的 JSON 输出。
  const { result, captured } = await captureRequests(ok("{}"), 200, () => runHermesStep(
    step({ hermesProfile: "default" }), {}, new Map(), new Map(), settings,
    undefined, undefined, undefined, undefined, { outputMode: "json" },
  ), "{\"text\":\"来自 Hermes\"}");
  assert.deepEqual(result, { text: "来自 Hermes" }, "非直连路径仍按同样的 JSON 契约解析回复");
  assert.ok(captured.length >= 1, "非直连路径必须发出 Hermes 请求");
  assert.equal(captured[0]!.url, "http://127.0.0.1:8642/v1/runs", "必须打到 Hermes 网关的 Runs 入口");
  assert.equal(captured[0]!.headers["authorization"], "Bearer hermes-key-must-not-be-used", "非直连路径使用 Hermes 网关密钥");
  assert.equal("providerId" in captured[0]!.body, false, "Hermes 请求体不得携带直连字段");
  assert.equal("input" in captured[0]!.body, true, "Hermes 用 input 承载消息");
});

test("非直连路径只用 Hermes 网关凭证，绝不使用任何提供商密钥", async () => {
  // 提供商明文密钥即使出现在环境变量里也不会被读：非直连路径只认 Hermes 网关密钥，
  // 因此这条断言与本机是否存在 Hermes Profile/.env 无关。
  const original = process.env.ZANE_TEST_NEVER_READ_KEY_ENV;
  process.env.ZANE_TEST_NEVER_READ_KEY_ENV = plaintextKey;
  try {
    const { captured } = await captureRequests(ok("{}"), 200, () => runHermesStep(
      step({ hermesProfile: "default" }), {}, new Map(), new Map(), settings,
      undefined, undefined, undefined, undefined, { outputMode: "json" },
    ), "{\"text\":\"来自 Hermes\"}");
    assert.ok(captured.length >= 1, "必须真的发出了 Hermes 请求，否则这条断言没有意义");
    for (const request of captured) {
      assert.doesNotMatch(JSON.stringify(request), new RegExp(plaintextKey), "非直连请求里不得出现提供商明文密钥");
    }
  } finally {
    if (original === undefined) delete process.env.ZANE_TEST_NEVER_READ_KEY_ENV; else process.env.ZANE_TEST_NEVER_READ_KEY_ENV = original;
  }
});

test("直连地址与密钥归一化：去掉末尾斜杠，拒绝内嵌凭证/查询串/非http，密钥只做长度与换行校验", () => {
  assert.equal(normalizeDirectLlmBaseUrl("http://127.0.0.1:11434/v1/"), "http://127.0.0.1:11434/v1");
  assert.equal(normalizeDirectLlmBaseUrl("  http://192.168.1.9:8080/v1//  "), "http://192.168.1.9:8080/v1");
  assert.equal(normalizeDirectLlmBaseUrl(""), "");
  assert.equal(normalizeDirectLlmBaseUrl("   "), "");
  for (const invalid of ["ftp://api.example.com/v1", "https://user:pass@api.example.com/v1", "https://api.example.com/v1?key=1", "https://api.example.com/v1#frag", "not-a-url"]) {
    assert.throws(() => normalizeDirectLlmBaseUrl(invalid), /直连模型提供商地址/, invalid);
  }
  assert.equal(normalizeDirectLlmApiKeyEnv(" DIRECT_LLM_API_KEY "), "DIRECT_LLM_API_KEY");
  assert.equal(normalizeDirectLlmApiKeyEnv(""), "");
  for (const invalid of ["direct_llm_api_key", "1KEY", "KEY-WITH-DASH", "A".repeat(129)]) {
    assert.throws(() => normalizeDirectLlmApiKeyEnv(invalid), /直连模型提供商 API 密钥环境变量名无效/, invalid);
  }
  // 明文密钥接受任意形态（它就是一份不透明字符串），只做长度与换行校验。
  assert.equal(normalizeDirectLlmApiKey("  " + plaintextKey + "  "), plaintextKey, "两端空白去掉");
  assert.equal(normalizeDirectLlmApiKey(""), "");
  assert.equal(normalizeDirectLlmApiKey("sk-ant-api03-anything-goes/+=="), "sk-ant-api03-anything-goes/+==");
  assert.throws(() => normalizeDirectLlmApiKey("bad\nkey"), /换行/);
  assert.throws(() => normalizeDirectLlmApiKey("k".repeat(513)), /过长/);
  assert.equal(normalizeDirectLlmModel(" gpt-4o-mini "), "gpt-4o-mini");
  assert.equal(normalizeDirectLlmModel(""), "");
  assert.throws(() => normalizeDirectLlmModel("bad\nmodel"), /控制字符/);
  assert.throws(() => normalizeDirectLlmModel("m".repeat(201)), /过长/);
});
