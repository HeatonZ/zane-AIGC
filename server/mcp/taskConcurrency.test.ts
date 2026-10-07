import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { taskConcurrencyHarness } from "../testing/taskConcurrencySupport.js";
import { taskConcurrencySettingsSchema } from "../domain/taskConcurrencyContracts.js";
import type { ApiResult } from "./httpClient.js";

test("真实stdio MCP隔离闭环：鉴权读取→revision写入→HTTP/调度一致→丢失回执对账→旧revision拒绝", async t => {
  const h = await taskConcurrencyHarness(t);
  const transport = new StdioClientTransport({ command: process.execPath, args: ["--import", "tsx", path.resolve("server/mcp/index.ts")], cwd: process.cwd(), env: { ...Object.fromEntries(Object.entries(process.env).filter((item): item is [string, string] => typeof item[1] === "string")), ZANE_BASE_URL: h.base, ZANE_API_TOKEN: h.admin.token }, stderr: "pipe" });
  const client = new Client({ name: "isolated-task-concurrency", version: "1.0.0" });
  t.after(() => client.close());
  await client.connect(transport);
  const tools = await client.listTools();
  assert.equal(tools.tools.find(tool => tool.name === "get_task_concurrency")?.annotations?.readOnlyHint, true);
  assert.equal(tools.tools.find(tool => tool.name === "update_task_concurrency")?.annotations?.idempotentHint, false);
  assert.equal(tools.tools.find(tool => tool.name === "update_task_concurrency")?.annotations?.openWorldHint, true);
  async function call(name: string, args: Record<string, unknown> = {}) {
    const result = await client.callTool({ name, arguments: args });
    assert.ok(!result.isError, JSON.stringify(result));
    const payload = result.structuredContent as ApiResult; assert.ok(payload.ok);
    return taskConcurrencySettingsSchema.parse(payload.data);
  }
  const initial = await call("get_task_concurrency"); assert.equal(initial.revision, 0); assert.equal(initial.maxActiveRuns, 2);
  const invalid = await client.callTool({ name: "update_task_concurrency", arguments: { revision: 0, maxActiveRuns: 33 } }); assert.equal(invalid.isError, true);
  // Intentionally discard the successful write receipt and reconcile by fixed ID.
  await call("update_task_concurrency", { revision: initial.revision, maxActiveRuns: 5 });
  const saved = await call("get_task_concurrency"); assert.equal(saved.id, initial.id); assert.equal(saved.revision, 1); assert.equal(saved.maxActiveRuns, 5);
  assert.deepEqual(saved, await (await h.request()).json()); assert.equal(h.service.metrics().maxActiveRuns, 5);
  const stale = await client.callTool({ name: "update_task_concurrency", arguments: { revision: 0, maxActiveRuns: 7 } });
  assert.equal(stale.isError, true); assert.equal((stale.structuredContent as ApiResult).error?.code, "RESOURCE_REVISION_CONFLICT");
  assert.match((stale.structuredContent as ApiResult).error!.recovery, /get_task_concurrency/);
  assert.deepEqual(await call("get_task_concurrency"), saved);
  const lowered = await call("update_task_concurrency", { revision: saved.revision, maxActiveRuns: 1 });
  assert.equal(lowered.revision, 2); assert.equal(h.config.getLimit(), 1); assert.equal(h.service.metrics().maxActiveRuns, 1);
  assert.equal(h.store.listRuns(h.settings.projectDirectory).runs.length, 0); assert.equal(h.executions, 0);
});
