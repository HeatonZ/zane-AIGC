import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { localExportHarness } from "../testing/localExportSupport.js";
import { localExportSettingsSchema } from "../domain/localExport.js";
import type { ApiResult } from "./httpClient.js";

test("真实stdio MCP隔离闭环：本地导出根目录读取→revision写入→HTTP一致→丢失回执对账→旧revision拒绝", async t => {
  const h = await localExportHarness(t);
  const transport = new StdioClientTransport({ command: process.execPath, args: ["--import", "tsx", path.resolve("server/mcp/index.ts")], cwd: process.cwd(), env: { ...Object.fromEntries(Object.entries(process.env).filter((item): item is [string, string] => typeof item[1] === "string")), ZANE_BASE_URL: h.base, ZANE_API_TOKEN: h.admin.token }, stderr: "pipe" });
  const client = new Client({ name: "isolated-local-export", version: "1.0.0" });
  t.after(() => client.close());
  await client.connect(transport);
  const tools = await client.listTools();
  assert.equal(tools.tools.find(tool => tool.name === "get_local_export")?.annotations?.readOnlyHint, true);
  assert.equal(tools.tools.find(tool => tool.name === "update_local_export")?.annotations?.idempotentHint, false);
  async function call(name: string, args: Record<string, unknown> = {}) {
    const result = await client.callTool({ name, arguments: args });
    assert.ok(!result.isError, JSON.stringify(result));
    const payload = result.structuredContent as ApiResult; assert.ok(payload.ok);
    return localExportSettingsSchema.parse(payload.data);
  }
  const initial = await call("get_local_export");
  assert.equal(initial.revision, 0); assert.equal(initial.root, ""); assert.equal(initial.enabled, false);
  assert.equal(initial.appliesTo, "core.code.localExport");
  // 无效根目录经 MCP 也被拒绝，且不落库。
  const invalid = await client.callTool({ name: "update_local_export", arguments: { revision: 0, root: "relative/dir" } });
  assert.equal(invalid.isError, true);
  assert.equal((await call("get_local_export")).revision, 0);
  // 故意丢弃成功回执，用固定单例对账而不是重放写入。
  const savedReceipt = await call("update_local_export", { revision: initial.revision, root: h.exportsRoot });
  const saved = await call("get_local_export");
  assert.equal(saved.id, initial.id); assert.equal(saved.revision, 1); assert.equal(saved.enabled, true);
  assert.equal(saved.root, savedReceipt.root);
  assert.deepEqual(saved, await (await h.request()).json(), "MCP 与 HTTP 读同一份权威设置");
  assert.equal(h.config.root(), saved.root);
  const stale = await client.callTool({ name: "update_local_export", arguments: { revision: 0, root: path.join(h.root, "other") } });
  assert.equal(stale.isError, true); assert.equal((stale.structuredContent as ApiResult).error?.code, "RESOURCE_REVISION_CONFLICT");
  assert.match((stale.structuredContent as ApiResult).error!.recovery, /get_local_export/);
  assert.deepEqual(await call("get_local_export"), saved);
  const closed = await call("update_local_export", { revision: saved.revision, root: "" });
  assert.equal(closed.revision, 2); assert.equal(closed.enabled, false); assert.equal(h.config.root(), "");
  assert.equal(h.store.listRuns(h.settings.projectDirectory).runs.length, 0, "配置不生成运行");
  assert.equal(h.executions, 0, "配置不执行步骤");
});
