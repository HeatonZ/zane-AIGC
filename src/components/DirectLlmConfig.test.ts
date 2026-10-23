import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { afterEach, test } from "node:test";
import { createDirectLlmProvider, loadDirectLlmProviders, queryDirectLlmModels, updateDirectLlmProvider } from "../lib/api";
import { directLlmApiKeyEnvError, directLlmApiKeyError, directLlmBaseUrlError, directLlmModelLines, directLlmProviderIdError, directLlmProtocolOptions } from "./DirectLlmConfig";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

/** 明文密钥哨兵：任何请求体、回执或界面文案里出现它就说明护栏破了。 */
const plaintextKey = "sk-live-UI-PLAINTEXT-SENTINEL-7a6b5c4d3e2f";

test("直连UI校验：允许本机与内网地址，拒绝内嵌凭证、查询串与非法协议", () => {
  for (const value of ["", "   "]) assert.equal(directLlmBaseUrlError(value), "", JSON.stringify(value));
  for (const value of ["http://127.0.0.1:11434/v1", "http://localhost:8000/v1", "http://192.168.1.9:8080/v1", "https://api.example.com/v1", "https://api.example.com/v1/"]) {
    assert.equal(directLlmBaseUrlError(value), "", value);
  }
  for (const value of ["not-a-url", "ftp://api.example.com/v1", "https://user:pass@api.example.com/v1", "https://api.example.com/v1?key=1", "https://api.example.com/v1#x"]) {
    const message = directLlmBaseUrlError(value);
    assert.notEqual(message, "", value);
    // 文案只描述规则，不回显整串，更不能把内嵌凭证原样吐回来。
    assert.doesNotMatch(message, /user:pass/, value);
  }
});

test("直连UI校验：明文密钥直接填写、只做长度与换行校验，不回显内容", () => {
  assert.equal(directLlmApiKeyError(""), "", "留空是合法的：它表示保持已保存的密钥");
  assert.equal(directLlmApiKeyError("   "), "", "只有空白等同留空");
  assert.equal(directLlmApiKeyError(plaintextKey), "");
  assert.equal(directLlmApiKeyError("sk-ant-api03-with/symbols+=="), "", "任意形态的令牌都必须被接受");
  assert.equal(directLlmApiKeyError("k".repeat(512)), "");
  const tooLong = directLlmApiKeyError("k".repeat(513));
  assert.match(tooLong, /过长/);
  assert.doesNotMatch(tooLong, new RegExp("k".repeat(20)), "错误信息不得回显密钥片段");
  const newline = directLlmApiKeyError("sk-live-" + plaintextKey + "\nsecond-line");
  assert.match(newline, /换行/);
  assert.doesNotMatch(newline, new RegExp(plaintextKey));
});

test("直连UI校验：环境变量回退只接受变量名，密钥字符串一律被拒", () => {
  assert.equal(directLlmApiKeyEnvError(""), "");
  assert.equal(directLlmApiKeyEnvError("  "), "");
  assert.equal(directLlmApiKeyEnvError("DIRECT_LLM_API_KEY"), "");
  assert.equal(directLlmApiKeyEnvError("OPENAI_API_KEY"), "");
  for (const value of ["direct_llm_api_key", "1KEY", plaintextKey, "KEY-DASH", "A".repeat(129)]) {
    const message = directLlmApiKeyEnvError(value);
    assert.notEqual(message, "", value);
    assert.match(message, /环境变量名/, value);
    // 校验信息只描述规则，不把提交的字符串回显出来。
    assert.doesNotMatch(message, new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), value);
  }
});

test("直连UI校验：提供商 ID 与协议选项", () => {
  assert.notEqual(directLlmProviderIdError(""), "");
  assert.equal(directLlmProviderIdError("local-ollama"), "");
  assert.equal(directLlmProviderIdError(" 9f8e7d6c-5b4a-3210 "), "");
  assert.notEqual(directLlmProviderIdError("-starts-with-dash"), "");
  assert.notEqual(directLlmProviderIdError("has space"), "");
  assert.deepEqual(directLlmProtocolOptions.map(option => option.value), ["openai-chat", "anthropic"]);
  // 两种协议的实际请求路径必须写在提示里，用户不必去翻文档。
  assert.match(directLlmProtocolOptions[0]!.hint, /chat\/completions/);
  assert.match(directLlmProtocolOptions[1]!.hint, /messages/);
});

test("直连UI：模型输入按行拆分、去空白去重并保持顺序", () => {
  assert.deepEqual(directLlmModelLines(""), []);
  assert.deepEqual(directLlmModelLines("  \n \n"), []);
  assert.deepEqual(directLlmModelLines("gpt-4o-mini\n qwen2.5-7b-instruct \ngpt-4o-mini"), ["gpt-4o-mini", "qwen2.5-7b-instruct"]);
});

test("直连UI客户端：读取分页目录，新建/更新带 revision，明文密钥只在不留空时提交", async () => {
  const calls: Array<{ path: string; init?: RequestInit }> = [];
  const provider = { format: "zane-studio.direct-llm-provider/v1", providerId: "p1", name: "P1", protocol: "openai-chat", baseUrl: "http://127.0.0.1:11434/v1", apiKeyEnv: "", hasApiKey: true, credential: { configured: true, source: "provider-apiKey", apiKeyMasked: "••••••••2f", lastFour: "2f", plaintextAtRest: true, notes: "" }, models: ["m1"], modelsFetchedAt: null, enabled: true, revision: 2, origin: "saved", reservedDefault: false, configured: true, hasModels: true, secretStorage: "local_sqlite_plaintext", apiKeyEnvPattern: "^[A-Z]...", providerIdPattern: "^[a-zA-Z0-9]...", scope: "system", appliesTo: "core.llm.direct", request: { method: "POST", endpointSuffix: "/chat/completions", modelsEndpointSuffix: "/models", authentication: "Authorization: Bearer 头", retries: 0, timeoutSource: "workflowTimeoutMinutes" }, nextAction: "update_with_revision" };
  globalThis.fetch = async (input, init) => {
    calls.push({ path: String(input), init });
    const payload = String(init?.method ?? "GET") === "GET" && !String(input).includes("/models")
      ? { format: "zane-studio.direct-llm-provider-list/v1", revision: "abc123", total: 1, providers: [provider], hasMore: false, protocols: ["openai-chat", "anthropic"], providerIdPattern: "^[a-zA-Z0-9]...", apiKeyEnvPattern: "^[A-Z]...", apiKeyMaxLength: 512, reservedDefaultProviderId: "direct-llm-default", secretStorage: "local_sqlite_plaintext", secretStorageNotice: "密钥明文保存在本机 SQLite", nextAction: "create_or_update_provider_with_revision" }
      : provider;
    return new Response(JSON.stringify(payload), { headers: { "Content-Type": "application/json" } });
  };
  const loaded = await loadDirectLlmProviders({ limit: 50 });
  assert.equal(calls[0].path, "/api/v1/settings/direct-llm/providers?limit=50");
  assert.equal(loaded.providers[0]!.providerId, "p1");
  assert.equal(loaded.providers[0]!.hasApiKey, true);

  // 编辑时留空密钥 → 请求体里不出现 apiKey 字段 → 服务端保持原值。
  await updateDirectLlmProvider("p1", { revision: 2, name: "P1 改名", protocol: "openai-chat", baseUrl: "http://127.0.0.1:11434/v1", apiKeyEnv: "", models: ["m1"], enabled: true });
  assert.equal(calls[1].init?.method, "PATCH");
  const keepBody = JSON.parse(calls[1].init?.body as string) as Record<string, unknown>;
  assert.equal("apiKey" in keepBody, false, "留空必须省略 apiKey 字段，而不是提交空串");
  assert.equal(keepBody.revision, 2);
  assert.equal(keepBody.name, "P1 改名");

  // 填写新密钥 → 提交明文（这是用户明确选择的直填方式）。
  await updateDirectLlmProvider("p1", { revision: 3, name: "P1", protocol: "anthropic", baseUrl: "https://api.anthropic.com/v1", apiKey: plaintextKey, models: ["claude-sonnet-4"], enabled: true });
  assert.equal((JSON.parse(calls[2].init?.body as string) as Record<string, unknown>).apiKey, plaintextKey);

  // 新建：providerId 由客户端预生成并保存；省略 apiKeyEnv 时不带该字段。
  await createDirectLlmProvider({ providerId: "p2", name: "P2", protocol: "openai-chat", baseUrl: "http://127.0.0.1:11434/v1", apiKey: plaintextKey, enabled: false });
  assert.equal(calls[3].init?.method, "POST");
  assert.equal(calls[3].path, "/api/v1/settings/direct-llm/providers");
  const createBody = JSON.parse(calls[3].init?.body as string) as Record<string, unknown>;
  assert.equal("apiKeyEnv" in createBody, false, "未填回退变量名时不应提交空串");

  // 查询模型是一次真实的上游 GET，客户端必须只发一次、且不自动重放。
  let queries = 0;
  globalThis.fetch = async () => {
    queries++;
    return new Response(JSON.stringify({ format: "zane-studio.direct-llm-models/v1", providerId: "p1", revision: 3, fetched: ["m2"], added: [], models: ["m2"], modelsFetchedAt: new Date().toISOString(), nextAction: "use_model_ids_in_step_or_provider" }), { headers: { "Content-Type": "application/json" } });
  };
  const queried = await queryDirectLlmModels("p1");
  assert.equal(queries, 1);
  assert.deepEqual(queried.models, ["m2"]);
});

test("直连UI客户端：冲突与回执丢失都不自动重放写入", async () => {
  for (const mode of ["conflict", "lost"] as const) {
    let writes = 0;
    globalThis.fetch = async () => {
      writes++;
      if (mode === "lost") throw new TypeError("receipt lost");
      return new Response(JSON.stringify({ error: "changed", code: "RESOURCE_REVISION_CONFLICT" }), { status: 409, headers: { "Content-Type": "application/json" } });
    };
    await assert.rejects(updateDirectLlmProvider("p1", { revision: 2, name: "P1", protocol: "openai-chat", baseUrl: "http://127.0.0.1:11434/v1", apiKey: plaintextKey, enabled: true }));
    assert.equal(writes, 1, mode + " 不得自动重放写入");
  }
});

test("直连配置区：明文密钥只在 password 输入框里填写，且明确写清存储风险与「留空即保持」", async () => {
  const source = await readFile(new URL("./DirectLlmConfig.tsx", import.meta.url), "utf8");
  // 密钥必须能在页面上直接填写，并且不回填到界面。
  assert.match(source, /type="password"/, "密钥需要在页面上直接填写");
  assert.match(source, /autoComplete="new-password"/, "避免浏览器自动填充回填明文");
  assert.match(source, /apiKey: ""/, "编辑已有提供商时密钥框必须留空（加密钥永不回填）");
  // 必须写清存储事实与三态语义，不把风险藏起来。
  assert.match(source, /明文保存在本机 SQLite/);
  assert.match(source, /请自行保护数据目录/);
  assert.match(source, /留空即保持原值/, "必须说明留空不会清空密钥");
  assert.match(source, /清除已保存密钥/, "必须提供显式清除入口");
  // 环境变量回退只填变量名。
  assert.match(source, /这里只填<b>变量名<\/b>/);
  // 省略字段而不是传 undefined 值：JSON.stringify 会把 undefined 丢掉，但显式过滤更明确。
  assert.match(source, /typedKey \? \{ apiKey: typedKey \} : \{\}/);
});
