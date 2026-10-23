import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { directLlmHarness } from "../testing/directLlmSupport.js";
import { directLlmProviderSchema, directLlmProviderListSchema } from "../domain/directLlm.js";
import type { ApiResult } from "./httpClient.js";

test("真实stdio MCP隔离闭环：提供商列表→新建→revision写入→HTTP一致→丢失回执对账→旧revision拒绝", async t => {
  const h = await directLlmHarness(t);
  const transport = new StdioClientTransport({ command: process.execPath, args: ["--import", "tsx", path.resolve("server/mcp/index.ts")], cwd: process.cwd(), env: { ...Object.fromEntries(Object.entries(process.env).filter((item): item is [string, string] => typeof item[1] === "string")), ZANE_BASE_URL: h.base, ZANE_API_TOKEN: h.admin.token }, stderr: "pipe" });
  const client = new Client({ name: "isolated-direct-llm", version: "1.0.0" });
  t.after(() => client.close());
  await client.connect(transport);
  const tools = await client.listTools();
  // 读操作只读；写操作非幂等（重复 providerId 是 409 而不是幂等成功）。
  assert.equal(tools.tools.find(tool => tool.name === "list_direct_llm_providers")?.annotations?.readOnlyHint, true);
  assert.equal(tools.tools.find(tool => tool.name === "create_direct_llm_provider")?.annotations?.idempotentHint, false);
  // 配置本身不接触外部世界（不调用模型、不发布、不写业务媒体），因此 openWorldHint 保持 false；
  // 只有 query_direct_llm_models 会真实访问上游，因此它是 open world。
  assert.equal(tools.tools.find(tool => tool.name === "create_direct_llm_provider")?.annotations?.openWorldHint, false);
  assert.equal(tools.tools.find(tool => tool.name === "query_direct_llm_models")?.annotations?.openWorldHint, true);
  async function call(name: string, args: Record<string, unknown> = {}) {
    const result = await client.callTool({ name, arguments: args });
    assert.ok(!result.isError, JSON.stringify(result));
    const payload = result.structuredContent as ApiResult;
    assert.ok(payload.ok);
    return payload.data;
  }
  // 未配置任何提供商时目录为空，且不伪造一条记录。
  const empty = directLlmProviderListSchema.parse(await call("list_direct_llm_providers"));
  assert.equal(empty.total, 0);
  assert.deepEqual(empty.providers, []);
  assert.equal(empty.secretStorage, "local_sqlite_plaintext", "契约必须声明明文入库");

  const plaintextKey = "sk-live-MCP-PLAINTEXT-SENTINEL-4c3b2a1f0e9d";
  // 地址非法经 MCP 也被拒绝，且不落库。
  const invalidAddress = await client.callTool({ name: "create_direct_llm_provider", arguments: { providerId: "p1", name: "P1", protocol: "openai-chat", baseUrl: "ftp://nope", apiKey: plaintextKey, enabled: true } });
  assert.equal(invalidAddress.isError, true);
  assert.equal((invalidAddress.structuredContent as ApiResult).error?.code, "INVALID_DIRECT_LLM_REQUEST");
  assert.doesNotMatch(JSON.stringify(invalidAddress.structuredContent), new RegExp(plaintextKey), "被拒绝的写入回执也不得回显密钥");
  assert.equal((await call("list_direct_llm_providers") as { total: number }).total, 0);

  // 新建：明文密钥直填，回执只给掩码。
  const created = directLlmProviderSchema.parse(await call("create_direct_llm_provider", { providerId: "local-ollama", name: "本机 Ollama", protocol: "openai-chat", baseUrl: "http://127.0.0.1:11434/v1", apiKey: plaintextKey, models: ["qwen2.5-7b-instruct"], enabled: true }));
  assert.equal(created.revision, 1);
  assert.equal(created.hasApiKey, true);
  assert.equal(created.credential.lastFour, plaintextKey.slice(-4));
  assert.equal(created.configured, true);
  assert.doesNotMatch(JSON.stringify(created), new RegExp(plaintextKey), "MCP 读接口不得回显密钥明文");
  // MCP 与 HTTP 读同一份权威记录。
  assert.deepEqual(directLlmProviderSchema.parse(await call("get_direct_llm_provider", { providerId: "local-ollama" })), created);
  assert.deepEqual(directLlmProviderSchema.parse(await (await h.request(h.admin.token, "GET", "/local-ollama")).json()), created, "MCP 与 HTTP 读同一份记录");
  assert.equal(h.config.target("local-ollama", undefined).apiKey, plaintextKey, "落库的明文密钥供 worker 使用");

  // 重复 providerId 是 409，不换 ID 重建、不静默覆盖。
  const duplicate = await client.callTool({ name: "create_direct_llm_provider", arguments: { providerId: "local-ollama", name: "覆盖尝试", protocol: "anthropic", baseUrl: "https://other.example.com/v1", apiKey: "another-key", enabled: true } });
  assert.equal(duplicate.isError, true);
  assert.equal((duplicate.structuredContent as ApiResult).error?.code, "PROVIDER_ALREADY_EXISTS");
  assert.match((duplicate.structuredContent as ApiResult).error!.recovery, /get_direct_llm_provider/);
  assert.deepEqual(await call("get_direct_llm_provider", { providerId: "local-ollama" }), created, "重复创建不得覆盖");

  // 只改名称、不传 apiKey：密钥必须保持（这正是「省略=保持」的语义）。
  const renamed = directLlmProviderSchema.parse(await call("update_direct_llm_provider", { providerId: "local-ollama", revision: 1, name: "本机 Ollama（改名）", protocol: "openai-chat", baseUrl: "http://127.0.0.1:11434/v1", enabled: true }));
  assert.equal(renamed.revision, 2);
  assert.equal(renamed.name, "本机 Ollama（改名）");
  assert.equal(renamed.hasApiKey, true, "省略 apiKey 必须保持已保存的密钥");
  assert.equal(h.config.target("local-ollama", undefined).apiKey, plaintextKey);

  // 旧 revision（重命名前的 1）冲突，且 recovery 指回读同一 providerId。
  const stale = await client.callTool({ name: "update_direct_llm_provider", arguments: { providerId: "local-ollama", revision: 1, name: "旧 revision", protocol: "openai-chat", baseUrl: "https://other.example.com/v1", apiKey: "stale-key", enabled: true } });
  assert.equal(stale.isError, true);
  assert.equal((stale.structuredContent as ApiResult).error?.code, "RESOURCE_REVISION_CONFLICT");
  assert.match((stale.structuredContent as ApiResult).error!.recovery, /get_direct_llm_provider/);
  assert.deepEqual(await call("get_direct_llm_provider", { providerId: "local-ollama" }), renamed, "冲突不得改写已保存配置");
  assert.equal(h.config.target("local-ollama", undefined).apiKey, plaintextKey, "冲突写入的密钥不得生效");

  // 删除是 revision 保护的；响应丢失后按同一 providerId 对账。
  const deleted = await call("delete_direct_llm_provider", { providerId: "local-ollama", revision: 2 });
  assert.deepEqual(deleted, { providerId: "local-ollama", deleted: true, nextAction: "list_direct_llm_providers" });
  assert.equal((await call("list_direct_llm_providers") as { total: number }).total, 0);
  const missing = await client.callTool({ name: "get_direct_llm_provider", arguments: { providerId: "local-ollama" } });
  assert.equal(missing.isError, true);
  assert.equal((missing.structuredContent as ApiResult).error?.code, "DIRECT_LLM_PROVIDER_NOT_FOUND");

  // 普通用户不能读写注册表。
  const userDenied = await fetch(h.base + "/api/v1/settings/direct-llm/providers", { headers: { Authorization: "Bearer " + h.user.token } });
  assert.equal(userDenied.status, 403);
  assert.equal(h.store.listRuns(h.settings.projectDirectory).runs.length, 0, "配置不生成运行");
  assert.equal(h.executions, 0, "配置不执行步骤");
});
