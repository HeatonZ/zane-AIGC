import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { WorkbenchHttpClient } from "./httpClient.js";
import { aiOperations } from "../ai/operations.js";
const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

test("并发MCP回执丢失：写入结果未知，指向固定ID只读对账且不重试", async () => {
  let requests = 0;
  globalThis.fetch = async (_input, init) => {
    requests++;
    assert.equal(init?.method, "PATCH");
    assert.deepEqual(JSON.parse(init?.body as string), { revision: 1, maxActiveRuns: 3 });
    throw new TypeError("connection closed after commit");
  };
  const client = new WorkbenchHttpClient("http://127.0.0.1:1", 1000, "isolated-token");
  const result = await client.call(aiOperations.find(operation => operation.name === "update_task_concurrency")!, { revision: 1, maxActiveRuns: 3 });
  assert.equal(result.ok, false); assert.equal(result.error?.outcome, "unknown");
  assert.match(result.error!.recovery, /get_task_concurrency/); assert.match(result.error!.recovery, /task-concurrency/);
  assert.equal(requests, 1);
});
