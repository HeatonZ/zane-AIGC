import assert from "node:assert/strict";
import test from "node:test";
import { directLlmProviderListSchema, directLlmProviderSchema } from "../domain/directLlm.js";
import { HttpError } from "../errors.js";
import { directLlmHarness, installFetch } from "../testing/directLlmSupport.js";
import { systemLogBuffer } from "../observability/logger.js";

const keyEnv = "ZANE_TEST_DIRECT_LLM_KEY";
const base = "http://127.0.0.1:11434/v1";
/** 明文密钥哨兵：任何读接口、日志、运行记录、快照里出现它就说明护栏破了。 */
const plaintextKey = "sk-live-STORED-PLAINTEXT-SENTINEL-9f8e7d6c5b4a";

/** 假上游：按 URL 选择响应，绝不访问真实网络。 */
function upstream(t: Parameters<typeof installFetch>[0], answer: (url: string) => { status?: number; body: string }) {
  return installFetch(t, (url) => answer(url));
}

/** 进程内日志缓冲的当前内容（脱敏后的投影），用于断言密钥不落日志。 */
function logText(): string {
  return JSON.stringify(systemLogBuffer.snapshot().entries);
}

test("提供商注册表：空目录为 revision 字符串且 total 0，默认提供商不存在就不伪造记录", async t => {
  const h = await directLlmHarness(t);
  const list = h.config.read();
  assert.equal(list.total, 0);
  assert.deepEqual(list.providers, []);
  assert.equal(list.hasMore, false);
  assert.equal(typeof list.revision, "string");
  assert.deepEqual(list.protocols, ["openai-chat", "anthropic"]);
  assert.equal(list.secretStorage, "local_sqlite_plaintext");
  assert.match(list.secretStorageNotice, /明文保存在本机 SQLite/, "列表必须明确说明密钥以明文入库");
  assert.deepEqual(directLlmProviderListSchema.parse(list), list);
  // 没有配置任何东西时，未声明的 providerId 解析为「未启用」，而不是猜一个默认。
  const target = h.config.target(undefined, undefined);
  assert.equal(target.enabled, false);
  assert.equal(target.providerId, "direct-llm-default");
  assert.equal(target.protocol, "openai-chat");
  assert.equal(target.apiKey, "");
});

test("提供商 CRUD：新建带 revision 1，读取一致；重复 providerId 返回 409 且不覆盖已有配置", async t => {
  const h = await directLlmHarness(t);
  const created = h.config.create({ providerId: "local-ollama", name: " 本机 Ollama ", protocol: "openai-chat", baseUrl: base + "/", apiKey: " " + plaintextKey + " ", models: ["qwen2.5-7b-instruct", "qwen2.5-7b-instruct", " llama3 "], enabled: true }, () => undefined);
  assert.equal(created.revision, 1);
  assert.equal(created.name, "本机 Ollama", "名称两端空白必须去掉");
  assert.equal(created.baseUrl, base, "末尾斜杠必须去掉");
  assert.equal(created.apiKeyEnv, "");
  assert.equal(created.hasApiKey, true);
  assert.deepEqual(created.models, ["qwen2.5-7b-instruct", "llama3"], "模型列表必须去重并去空白");
  assert.equal(created.origin, "saved");
  assert.equal(created.reservedDefault, false);
  assert.equal(created.configured, true);
  assert.equal(created.modelsFetchedAt, null);
  assert.deepEqual(directLlmProviderSchema.parse(created), created);
  // 读回绝不回显明文：只有布尔与末尾 4 位掩码。
  assert.doesNotMatch(JSON.stringify(created), new RegExp(plaintextKey), "读接口绝不能回显密钥明文");
  assert.equal(created.credential.source, "provider-apiKey");
  assert.equal(created.credential.plaintextAtRest, true);
  assert.equal(created.credential.lastFour, plaintextKey.slice(-4));
  assert.match(created.credential.apiKeyMasked, /•/);
  assert.deepEqual(h.config.get("local-ollama"), created, "读取必须与写入回执一致");

  assert.throws(() => h.config.create({ providerId: "local-ollama", name: "覆盖尝试", protocol: "anthropic", baseUrl: "https://other.example.com", apiKey: "other-key", enabled: true }, () => undefined), (error: HttpError) => {
    assert.equal(error.status, 409);
    assert.equal(error.code, "PROVIDER_ALREADY_EXISTS");
    assert.match(error.message, /get_direct_llm_provider/);
    return true;
  });
  assert.deepEqual(h.config.get("local-ollama"), created, "重复创建不得覆盖已有配置");
});

test("密钥三态：省略=保持（只改名称不清空）、显式空串=清除、非空=替换", async t => {
  const h = await directLlmHarness(t);
  const created = h.config.create({ providerId: "p1", name: "P1", protocol: "openai-chat", baseUrl: base, apiKey: plaintextKey, models: ["m1"], enabled: true }, () => undefined);
  assert.equal(created.hasApiKey, true);

  // 1) 省略 apiKey：只改名称，密钥必须保持不变。
  const renamed = h.config.update("p1", { revision: created.revision, name: "P1 改名", protocol: "openai-chat", baseUrl: base, enabled: true }, () => undefined);
  assert.equal(renamed.hasApiKey, true, "省略 apiKey 时必须保持已保存的密钥");
  assert.equal(renamed.credential.lastFour, plaintextKey.slice(-4), "末尾 4 位不变才能证明是同一份密钥");
  assert.equal(h.config.target("p1", undefined).apiKey, plaintextKey, "落库的明文密钥不变");
  assert.equal(renamed.credential.configured, true, "只改名称不得把配置判为不可用");

  // 2) 显式空串：清除密钥。清除必须与「关闭」同时提交，否则会存出「已启用但没有密钥」的坏配置。
  assert.throws(() => h.config.update("p1", { revision: renamed.revision, name: "P1 改名", protocol: "openai-chat", baseUrl: base, apiKey: "", enabled: true }, () => undefined), (error: HttpError) => {
    assert.equal(error.status, 400);
    assert.match(error.message, /API 密钥/);
    return true;
  });
  assert.equal(h.config.get("p1").hasApiKey, true, "被拒绝的清除不得生效");
  const cleared = h.config.update("p1", { revision: renamed.revision, name: "P1 改名", protocol: "openai-chat", baseUrl: base, apiKey: "", enabled: false }, () => undefined);
  assert.equal(cleared.hasApiKey, false, "显式空串必须清除密钥");
  assert.equal(cleared.credential.source, "unset");
  assert.equal(cleared.credential.apiKeyMasked, "");
  assert.equal(cleared.credential.configured, false, "没有密钥后不得报告 configured");
  assert.equal(h.config.target("p1", undefined).apiKey, "");
  assert.equal(h.store.listDocuments<{ apiKey: string }>("@zane-system", "settings")[0]!.apiKey, "", "清除必须真的落库为空串");

  // 3) 非空字符串：替换（不与旧值拼接）。
  const replaced = h.config.update("p1", { revision: cleared.revision, name: "P1 改名", protocol: "openai-chat", baseUrl: base, apiKey: "second-key-value", enabled: true }, () => undefined);
  assert.equal(replaced.hasApiKey, true);
  assert.equal(h.config.target("p1", undefined).apiKey, "second-key-value", "替换不得拼接旧值");
  assert.equal(replaced.credential.lastFour, "alue");
  // 清除或替换都不回显明文。
  assert.doesNotMatch(JSON.stringify([renamed, cleared, replaced]), new RegExp(plaintextKey));
});

test("启用校验：必须有密钥（明文或环境变量之一），缺名称/地址/密钥时 400 且不落库", async t => {
  const h = await directLlmHarness(t);
  const created = h.config.create({ providerId: "p1", name: "P1", protocol: "openai-chat", baseUrl: base, apiKey: plaintextKey, models: ["m1"], enabled: false }, () => undefined);
  for (const invalid of [
    { name: "", baseUrl: base },
    { name: "P1", baseUrl: "not-a-url" },
    { name: "P1", baseUrl: base, apiKey: "", apiKeyEnv: "" },
    { name: "P1", baseUrl: base, apiKeyEnv: "lowercase-name" },
  ]) {
    assert.throws(() => h.config.update("p1", { revision: created.revision, protocol: "openai-chat", enabled: true, ...invalid }, () => undefined), (error: HttpError) => {
      assert.equal(error.status, 400);
      assert.equal(error.code, "INVALID_DIRECT_LLM_REQUEST");
      assert.doesNotMatch(error.message, new RegExp(plaintextKey), "校验错误不得回显密钥");
      return true;
    });
  }
  assert.equal(h.config.get("p1").revision, created.revision, "无效写入不得改变 revision");
  // 关闭状态下允许字段不全（保留一份「先存着、稍后启用」的草稿）。
  const partial = h.config.update("p1", { revision: created.revision, name: "", protocol: "openai-chat", baseUrl: "", apiKey: "", enabled: false }, () => undefined);
  assert.equal(partial.enabled, false);
  assert.equal(partial.credential.configured, false);
});

test("明文密钥：读接口不回显，但直连请求与模型查询确实用它", async t => {
  const h = await directLlmHarness(t);
  const created = h.config.create({ providerId: "p1", name: "P1", protocol: "anthropic", baseUrl: base, apiKey: plaintextKey, models: ["m1"], enabled: true }, () => undefined);
  assert.doesNotMatch(JSON.stringify(created), new RegExp(plaintextKey));
  assert.doesNotMatch(JSON.stringify(h.config.read()), new RegExp(plaintextKey), "列表也必须掩码");
  assert.doesNotMatch(JSON.stringify(h.config.contract()), new RegExp(plaintextKey), "契约自检也必须掩码");
  // 运行期目标里才有明文：它只交给 worker。
  assert.equal(h.config.target("p1", undefined).apiKey, plaintextKey);

  const captured = upstream(t, () => ({ body: JSON.stringify({ data: [{ id: "m2" }] }) }));
  const result = await h.config.queryModels("p1", () => undefined);
  assert.equal(captured.length, 1);
  assert.equal(captured[0]!.headers["x-api-key"], plaintextKey, "模型查询必须用保存的明文密钥");
  assert.deepEqual(result.models, ["m2", "m1"]);
  assert.doesNotMatch(JSON.stringify(result), new RegExp(plaintextKey), "模型查询回执必须掩码");
});

test("密钥回退：apiKey 为空但有 apiKeyEnv 时从 process.env 读取并可正常工作", async t => {
  const h = await directLlmHarness(t);
  const created = h.config.create({ providerId: "p1", name: "P1", protocol: "openai-chat", baseUrl: base, apiKeyEnv: keyEnv, models: ["m1"], enabled: true }, () => undefined);
  assert.equal(created.hasApiKey, false);
  assert.equal(created.apiKeyEnv, keyEnv, "回退时只保存变量名");
  // 环境里有值 → configured；没有 → 不算可用，但仍然是合法配置。
  const previous = process.env[keyEnv];
  delete process.env[keyEnv];
  try {
    assert.equal(h.config.get("p1").credential.configured, false, "环境变量缺失时不得报告可用");
    assert.equal(h.config.get("p1").credential.source, "environment");
    const captured = upstream(t, () => ({ body: JSON.stringify({ data: [{ id: "x" }] }) }));
    await assert.rejects(() => h.config.queryModels("p1", () => undefined), /未配置 API 密钥/);
    assert.equal(captured.length, 0, "缺少密钥值时不得发出上游请求");

    process.env[keyEnv] = "environment-fallback-secret";
    assert.equal(h.config.get("p1").credential.configured, true);
    const ok = upstream(t, () => ({ body: JSON.stringify({ data: [{ id: "x" }] }) }));
    await h.config.queryModels("p1", () => undefined);
    assert.equal(ok[0]!.headers["authorization"], "Bearer environment-fallback-secret", "回退必须从 process.env 取到值");
  } finally {
    if (previous === undefined) delete process.env[keyEnv]; else process.env[keyEnv] = previous;
  }
});

test("明文密钥不落日志：保存/更新/删除/查询都只记录「有密钥」与来源", async t => {
  const h = await directLlmHarness(t);
  const created = h.config.create({ providerId: "p1", name: "P1", protocol: "openai-chat", baseUrl: base, apiKey: plaintextKey, models: ["m1"], enabled: true }, () => undefined);
  h.config.update("p1", { revision: created.revision, name: "P1 v2", protocol: "openai-chat", baseUrl: base, apiKey: "replacement-" + plaintextKey, enabled: true }, () => undefined);
  upstream(t, () => ({ body: JSON.stringify({ data: [{ id: "m2" }] }) }));
  await h.config.queryModels("p1", () => undefined);
  const text = logText();
  assert.match(text, /direct_llm\./, "至少要留下 provider_saved 之类的运维事实");
  assert.doesNotMatch(text, new RegExp(plaintextKey), "日志缓冲绝不能含密钥明文");
  assert.doesNotMatch(text, /replacement-/, "替换密钥同样不得落日志");
  assert.match(text, /provider-apiKey/, "日志只记录来源类别");
});

test("落库文档：明文密钥存在 apiKey 字段里，且没有其它密钥形态字段", async t => {
  const h = await directLlmHarness(t);
  h.config.create({ providerId: "p1", name: "P1", protocol: "openai-chat", baseUrl: base, apiKey: plaintextKey, apiKeyEnv: keyEnv, models: ["m1"], enabled: true }, () => undefined);
  const stored = h.store.listDocuments<Record<string, unknown>>("@zane-system", "settings");
  assert.equal(stored.length, 1);
  assert.deepEqual(Object.keys(stored[0]!).sort(), ["apiKey", "apiKeyEnv", "baseUrl", "enabled", "id", "models", "modelsFetchedAt", "name", "protocol", "providerId", "revision"], "落库字段必须恰好是这些");
  // 明文入库是产品选择，因此这里**断言它确实被存下来了**（这正是用户要求的行为）。
  assert.equal(stored[0]!.apiKey, plaintextKey, "明文密钥按用户要求以明文落库");
  assert.equal(stored[0]!.apiKeyEnv, keyEnv, "回退变量名同样保留");
  // 但没有额外的密钥形态字段（例如 token/secret/authorization）。
  assert.doesNotMatch(JSON.stringify(Object.keys(stored[0]!)), /token|secret|authorization|bearer/i);
});

test("提供商 CRUD：旧 revision 冲突且不覆盖；并发写只有一个成功", async t => {
  const h = await directLlmHarness(t);
  const created = h.config.create({ providerId: "p1", name: "P1", protocol: "openai-chat", baseUrl: base, apiKey: plaintextKey, models: ["m1"], enabled: true }, () => undefined);
  const updated = h.config.update("p1", { revision: created.revision, name: "P1 v2", protocol: "openai-chat", baseUrl: base, enabled: true }, () => undefined);
  assert.throws(() => h.config.update("p1", { revision: created.revision, name: "旧 revision 覆盖", protocol: "openai-chat", baseUrl: "https://other.example.com", apiKey: "old-revision-key", enabled: true }, () => undefined), (error: HttpError) => {
    assert.equal(error.status, 409);
    assert.equal(error.code, "RESOURCE_REVISION_CONFLICT");
    assert.match(error.message, /重新读取/);
    return true;
  });
  assert.deepEqual(h.config.get("p1"), updated, "冲突不得改写已保存配置");
  assert.equal(h.config.target("p1", undefined).apiKey, plaintextKey, "冲突写入的密钥不得生效");
  // 并发：两个写者拿着同一 revision，只有一个能成功。
  const results = [0, 1].map((index) => {
    try {
      h.config.update("p1", { revision: updated.revision, name: "并发 " + index, protocol: "openai-chat", baseUrl: base, models: ["m" + index], enabled: true }, () => undefined);
      return "ok";
    } catch (error) {
      return (error as HttpError).code;
    }
  });
  assert.equal(results.filter(result => result === "ok").length, 1, "并发写只能有一个成功：" + JSON.stringify(results));
  assert.equal(results.filter(result => result === "RESOURCE_REVISION_CONFLICT").length, 1);
});

test("提供商 CRUD：删除是 revision 保护且不级联；保留的默认提供商拒绝删除", async t => {
  const h = await directLlmHarness(t);
  const created = h.config.create({ providerId: "p2", name: "P2", protocol: "openai-chat", baseUrl: base, apiKey: plaintextKey, enabled: true }, () => undefined);
  assert.throws(() => h.config.remove("p2", { revision: created.revision + 5 }, () => undefined), (error: HttpError) => {
    assert.equal(error.status, 409);
    assert.equal(error.code, "RESOURCE_REVISION_CONFLICT");
    return true;
  });
  assert.equal(h.config.get("p2").hasApiKey, true, "冲突删除不得移除配置");
  assert.deepEqual(h.config.remove("p2", { revision: created.revision }, () => undefined), { providerId: "p2", deleted: true, nextAction: "list_direct_llm_providers" });
  assert.throws(() => h.config.get("p2"), (error: HttpError) => {
    assert.equal(error.status, 404);
    assert.equal(error.code, "DIRECT_LLM_PROVIDER_NOT_FOUND");
    return true;
  });
  assert.deepEqual(h.store.listDocuments("@zane-system", "settings"), [], "删除必须移除该文档（含其中的明文密钥）");
  // 保留的默认提供商不能删除：它承载 1.5.39 单例与环境默认值。
  assert.throws(() => h.config.remove("direct-llm-default", { revision: 0 }, () => undefined), (error: HttpError) => {
    assert.equal(error.status, 400);
    assert.match(error.message, /不能删除/);
    return true;
  });
});

test("提供商列表：分页游标绑定 revision，目录变化后 409 要求重读第一页", async t => {
  const h = await directLlmHarness(t);
  for (const providerId of ["p1", "p2", "p3"]) h.config.create({ providerId, name: providerId, protocol: "openai-chat", baseUrl: base, apiKey: plaintextKey, models: [providerId + "-model"], enabled: true }, () => undefined);
  const first = h.config.read({ limit: 2 });
  assert.equal(first.total, 3);
  assert.equal(first.providers.length, 2);
  assert.equal(first.hasMore, true);
  assert.ok(first.nextCursor);
  const second = h.config.read({ limit: 2, cursor: first.nextCursor });
  assert.deepEqual(second.providers.map(provider => provider.providerId), ["p3"], "续页不能重复第一页的记录");
  assert.equal(second.hasMore, false);
  assert.equal(second.nextCursor, undefined);
  // 目录变化：旧游标必须失效，而不是拼接两个目录快照。
  h.config.create({ providerId: "p4", name: "p4", protocol: "openai-chat", baseUrl: base, apiKey: plaintextKey, enabled: true }, () => undefined);
  assert.throws(() => h.config.read({ limit: 2, cursor: first.nextCursor }), (error: HttpError) => {
    assert.equal(error.status, 409);
    assert.equal(error.code, "DIRECT_LLM_PROVIDER_PAGE_CHANGED");
    return true;
  });
  assert.throws(() => h.config.read({ limit: 2, cursor: "not-a-cursor" }), (error: HttpError) => {
    assert.equal(error.status, 400);
    return true;
  });
  // q 过滤按 ID/名称/模型匹配；无命中时 total 0 但 revision 是稳定字符串。
  assert.deepEqual(h.config.read({ q: "p3-model" }).providers.map(provider => provider.providerId), ["p3"]);
  assert.equal(h.config.read({ q: "不存在的关键词" }).total, 0);
});

test("模型查询：成功时合并去重并缓存，手填项不丢失，revision 递增", async t => {
  const h = await directLlmHarness(t);
  const created = h.config.create({ providerId: "p1", name: "P1", protocol: "openai-chat", baseUrl: base, apiKey: plaintextKey, models: ["hand-typed-only", "shared-model"], enabled: true }, () => undefined);
  const captured = upstream(t, (url) => url.endsWith("/models")
    ? { body: JSON.stringify({ data: [{ id: "shared-model" }, { id: "upstream-a" }, { id: "upstream-a" }, { id: "upstream-b" }] }) }
    : { status: 500, body: "{}" });
  const result = await h.config.queryModels("p1", () => undefined);
  assert.equal(captured.length, 1, "查询只发一次 GET");
  assert.equal(captured[0]!.method, "GET");
  assert.equal(captured[0]!.url, base + "/models");
  assert.equal(captured[0]!.headers["authorization"], "Bearer " + plaintextKey);
  assert.deepEqual(result.fetched, ["shared-model", "upstream-a", "upstream-b"], "上游列表按顺序去重");
  assert.deepEqual(result.added, ["hand-typed-only"], "上游没有的手填项必须保留并单独列出");
  assert.deepEqual(result.models, ["shared-model", "upstream-a", "upstream-b", "hand-typed-only"]);
  assert.equal(result.revision, created.revision + 1);
  assert.ok(Date.parse(result.modelsFetchedAt) > 0);
  const reloaded = h.config.get("p1");
  assert.deepEqual(reloaded.models, result.models);
  assert.equal(reloaded.modelsFetchedAt, result.modelsFetchedAt);
  // 缓存合并不得丢掉明文密钥。
  assert.equal(reloaded.hasApiKey, true);
  assert.equal(h.config.target("p1", undefined).apiKey, plaintextKey);
  // 二次查询：缓存命中同样的上游顺序，不重复、不丢手填项。
  const again = await h.config.queryModels("p1", () => undefined);
  assert.deepEqual(again.models, result.models);
});

test("模型查询：上游真正返回空数组时不清空本地手填模型", async t => {
  const h = await directLlmHarness(t);
  h.config.create({ providerId: "p1", name: "P1", protocol: "openai-chat", baseUrl: base, apiKey: plaintextKey, models: ["hand-typed-only"], enabled: true }, () => undefined);
  upstream(t, () => ({ body: JSON.stringify({ data: [] }) }));
  const result = await h.config.queryModels("p1", () => undefined);
  assert.deepEqual(result.fetched, []);
  assert.deepEqual(result.added, ["hand-typed-only"]);
  assert.deepEqual(result.models, ["hand-typed-only"], "空结果不得清空本地列表");
  assert.notEqual(h.config.get("p1").modelsFetchedAt, null);
});

test("模型查询失败：认证失败、上游错误、不支持列模型都明确报错且不写缓存，也不泄露密钥", async t => {
  const cases: Array<[number, string, RegExp]> = [
    [401, JSON.stringify({ error: { message: "bad key " + plaintextKey } }), /认证失败/],
    [500, JSON.stringify({ error: { message: "boom " + plaintextKey } }), /请求失败|查询模型失败/],
    [404, "{}", /该协议不支持列模型/],
    [405, "{}", /该协议不支持列模型/],
  ];
  for (const [status, body, expected] of cases) {
    const h = await directLlmHarness(t);
    const created = h.config.create({ providerId: "p1", name: "P1", protocol: "anthropic", baseUrl: base, apiKey: plaintextKey, models: ["hand-typed-only"], enabled: true }, () => undefined);
    upstream(t, () => ({ status, body }));
    await assert.rejects(() => h.config.queryModels("p1", () => undefined), (error: Error) => {
      assert.match(error.message, expected, "HTTP " + status);
      assert.doesNotMatch(error.message, new RegExp(plaintextKey), "上游回显的密钥必须被抹掉（HTTP " + status + "）");
      return true;
    });
    const after = h.config.get("p1");
    assert.deepEqual(after.models, ["hand-typed-only"], "失败不得改写模型列表（HTTP " + status + "）");
    assert.equal(after.modelsFetchedAt, null, "失败不得写入缓存时间（HTTP " + status + "）");
    assert.equal(after.revision, created.revision, "失败不得改变 revision（HTTP " + status + "）");
    assert.equal(after.hasApiKey, true, "失败不得丢掉已保存的密钥（HTTP " + status + "）");
  }
});

test("模型查询失败：信封不可识别时报「不支持列模型」，绝不用空列表冒充成功", async t => {
  const h = await directLlmHarness(t);
  h.config.create({ providerId: "p1", name: "P1", protocol: "openai-chat", baseUrl: base, apiKey: plaintextKey, models: ["hand-typed-only"], enabled: true }, () => undefined);
  upstream(t, () => ({ body: JSON.stringify({ object: "list", models: ["a"] }) }));
  await assert.rejects(() => h.config.queryModels("p1", () => undefined), /该协议不支持列模型/);
  assert.deepEqual(h.config.get("p1").models, ["hand-typed-only"]);
});

test("模型查询：查询期间并发改动返回 409，本次结果不写入", async t => {
  const h = await directLlmHarness(t);
  h.config.create({ providerId: "p2", name: "P2", protocol: "openai-chat", baseUrl: base, apiKey: plaintextKey, models: ["m1"], enabled: true }, () => undefined);
  // 真实竞态：queryModels 先读取提供商、再 await 上游请求、最后按当时的 revision 写回。
  // 让假上游在响应前改一次文档，就等于「另一位管理员在查询返回前保存了同一提供商」。
  upstream(t, () => {
    const current = h.store.getDocument<{ id: string; revision: number }>("@zane-system", "settings", "direct-llm-provider:p2")!;
    h.store.putDocument("@zane-system", "settings", { ...current, name: "并发改名" } as { id: string; revision: number }, current.revision);
    return { body: JSON.stringify({ data: [{ id: "from-upstream" }] }) };
  });
  const conflict = await h.config.queryModels("p2", () => undefined).then(() => "ok", (error: HttpError) => error.code);
  assert.equal(conflict, "RESOURCE_REVISION_CONFLICT", "查询期间被改动必须冲突而不是覆盖");
  const after = h.config.get("p2");
  assert.equal(after.name, "并发改名", "并发写入的结果必须保留");
  assert.deepEqual(after.models, ["m1"], "本次查询结果不得写入");
  assert.equal(after.hasApiKey, true, "并发改名不得丢掉密钥");
  assert.equal(after.modelsFetchedAt, null, "冲突时不得写入缓存时间");
});

test("1.5.39 单例兼容：未声明 providerId 时按旧单例解析，保存默认提供商后迁移并删除旧单例", async t => {
  const h = await directLlmHarness(t, { baseUrl: "http://127.0.0.1:9999/v1", apiKeyEnv: "ENV_DEFAULT_KEY", model: "env-model" });
  // 环境默认值：保留默认提供商存在、enabled=false、revision 0，且没有明文密钥。
  const legacy = h.config.get("direct-llm-default");
  assert.equal(legacy.origin, "environment");
  assert.equal(legacy.revision, 0);
  assert.equal(legacy.reservedDefault, true);
  assert.equal(legacy.enabled, false, "环境默认值不自动启用：必须显式保存 enabled=true");
  assert.equal(legacy.baseUrl, "http://127.0.0.1:9999/v1");
  assert.equal(legacy.hasApiKey, false, "1.5.39 从来只存环境变量名，没有明文密钥");
  assert.equal(legacy.apiKeyEnv, "ENV_DEFAULT_KEY");
  assert.deepEqual(legacy.models, ["env-model"], "单例的 model 映射为 models[0]");
  assert.deepEqual(h.config.read().providers.map(provider => provider.providerId), ["direct-llm-default"]);
  assert.equal(h.config.target(undefined, undefined).model, "env-model", "历史步骤（无 providerId）仍能解析到模型");

  // 直接用 SQLite 写入 1.5.39 单例文档，验证它优先于环境默认值。
  h.store.putDocument("@zane-system", "settings", { id: "direct-llm", revision: 0, enabled: true, baseUrl: "http://127.0.0.1:11434/v1", apiKeyEnv: keyEnv, model: "qwen2.5-7b-instruct" }, 0);
  const fromSingleton = h.config.get("direct-llm-default");
  assert.equal(fromSingleton.origin, "legacy-singleton");
  assert.equal(fromSingleton.enabled, true);
  assert.equal(fromSingleton.baseUrl, "http://127.0.0.1:11434/v1");
  assert.deepEqual(fromSingleton.models, ["qwen2.5-7b-instruct"]);
  assert.equal(h.config.target(undefined, undefined).model, "qwen2.5-7b-instruct");

  // 保存保留的默认提供商：写成新式文档（revision 1），旧单例被删除，避免同一 ID 有两个真相。
  const saved = h.config.update("direct-llm-default", { revision: 0, name: "默认提供商", protocol: "anthropic", baseUrl: "https://api.anthropic.com/v1", apiKey: plaintextKey, models: ["claude-sonnet-4"], enabled: true }, () => undefined);
  assert.equal(saved.revision, 1);
  assert.equal(saved.origin, "saved");
  assert.equal(saved.protocol, "anthropic");
  assert.equal(saved.hasApiKey, true);
  assert.equal(h.store.getDocument("@zane-system", "settings", "direct-llm"), undefined, "旧单例必须被删除");
  assert.deepEqual(h.config.get("direct-llm-default").models, ["claude-sonnet-4"]);
  assert.equal(h.config.target(undefined, undefined).protocol, "anthropic", "迁移后历史步骤解析到新记录");
  assert.equal(h.config.target(undefined, undefined).apiKey, plaintextKey);
  // 步骤显式选择另一个提供商：不再落到保留默认。
  const other = h.config.create({ providerId: "other", name: "Other", protocol: "openai-chat", baseUrl: base, apiKeyEnv: keyEnv, models: ["m"], enabled: true }, () => undefined);
  const target = h.config.target("other", "override-model");
  assert.equal(target.providerId, "other");
  assert.equal(target.model, "override-model", "步骤里的 model 覆盖提供商列表");
  assert.equal(h.config.target("missing-provider", undefined).enabled, false, "未知 providerId 解析为未启用，不猜默认");
  assert.equal(other.revision, 1);
});

test("HTTP 路由：匿名 401、普通用户 403、管理员可读写，响应不含密钥明文且带 no-store", async t => {
  const h = await directLlmHarness(t);
  // 未认证先失败（401），已认证但非管理员是权限不足（403）：两条边界都要成立。
  assert.equal((await h.request("", "GET")).status, 401);
  assert.equal((await h.request(h.user.token, "GET")).status, 403);
  const anonymous = await h.request(h.admin.token, "GET");
  assert.equal(anonymous.status, 200);
  assert.equal(anonymous.headers.get("cache-control"), "no-store");
  const created = await h.request(h.admin.token, "POST", "", { providerId: "p1", name: "P1", protocol: "anthropic", baseUrl: base, apiKey: plaintextKey, models: ["m1"], enabled: true });
  assert.equal(created.status, 201);
  assert.equal(created.headers.get("cache-control"), "no-store");
  const text = await created.text();
  assert.doesNotMatch(text, new RegExp(plaintextKey), "创建回执不得回显密钥明文");
  const body = JSON.parse(text) as Record<string, unknown>;
  assert.equal(body.hasApiKey, true);
  assert.equal((body.credential as Record<string, unknown>).lastFour, plaintextKey.slice(-4));
  // 详情与列表同样不回显。
  assert.doesNotMatch(await (await h.request(h.admin.token, "GET", "/p1")).text(), new RegExp(plaintextKey));
  assert.doesNotMatch(await (await h.request(h.admin.token, "GET")).text(), new RegExp(plaintextKey));
  // 查询参数被拒绝：这些操作是固定的，不是查询代理。
  assert.equal((await h.request(h.admin.token, "GET", "?unknown=1")).status, 400);
  assert.equal((await h.request(h.admin.token, "GET", "/p1?limit=1")).status, 400);
  assert.equal((await h.request(h.user.token, "POST", "", { providerId: "p2", name: "P2", protocol: "openai-chat", baseUrl: base, apiKey: plaintextKey })).status, 403);
  assert.equal(h.store.listRuns(h.settings.projectDirectory).runs.length, 0, "配置不生成运行");
  assert.equal(h.executions, 0, "配置不执行步骤");
});

test("发布快照与导出不承载密钥：提供商文档只被步骤按 providerId 引用", async t => {
  const h = await directLlmHarness(t);
  h.config.create({ providerId: "p1", name: "P1", protocol: "openai-chat", baseUrl: base, apiKey: plaintextKey, models: ["m1"], enabled: true }, () => undefined);
  // 步骤快照是 capabilityConfig（providerId/model），本测试断言它不会因为提供商存在而被注入密钥：
  // 提供商的明文只存在于 @zane-system 的 settings 文档里，别的集合一条都没有。
  const documents = h.store.listDocuments<Record<string, unknown>>("@zane-system", "settings");
  assert.equal(documents.length, 1);
  assert.equal(documents[0]!.providerId, "p1");
  for (const collection of ["drafts", "sceneVersions", "runs", "exports"]) {
    assert.deepEqual(h.store.listDocuments("@zane-system", collection), [], collection + " 不应有内容");
  }
  assert.equal(h.store.listRuns(h.settings.projectDirectory).runs.length, 0, "配置不生成运行，因此没有运行输入归档");
});
