import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { loadTaskConcurrency, saveTaskConcurrency } from "../lib/api";
import { validTaskConcurrency } from "./TaskConcurrencyConfig";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

test("并发UI校验：空值、非整数、超范围禁用保存", () => {
  for (const value of ["", " ", "0", "33", "1.5", "NaN", "oops"]) assert.equal(validTaskConcurrency(value), false, value);
  for (const value of ["1", "2", "32"]) assert.equal(validTaskConcurrency(value), true, value);
});
test("并发UI客户端：读取服务端快照，写入带revision，冲突/回执丢失不重试", async () => {
  const calls: Array<{ path: string; init?: RequestInit }> = [];
  globalThis.fetch = async (input, init) => {
    calls.push({ path: String(input), init });
    return new Response(JSON.stringify({ revision: 4, maxActiveRuns: 3 }), { headers: { "Content-Type": "application/json" } });
  };
  assert.deepEqual(await loadTaskConcurrency(), { revision: 4, maxActiveRuns: 3 });
  assert.equal(calls[0].path, "/api/v1/settings/task-concurrency");
  await saveTaskConcurrency({ revision: 4, maxActiveRuns: 2 });
  assert.equal(calls[1].init?.method, "PATCH"); assert.deepEqual(JSON.parse(calls[1].init?.body as string), { revision: 4, maxActiveRuns: 2 });
  for (const mode of ["conflict", "lost"] as const) {
    let writes = 0;
    globalThis.fetch = async () => {
      writes++;
      if (mode === "lost") throw new TypeError("receipt lost");
      return new Response(JSON.stringify({ error: "changed", code: "RESOURCE_REVISION_CONFLICT" }), { status: 409, headers: { "Content-Type": "application/json" } });
    };
    await assert.rejects(saveTaskConcurrency({ revision: 4, maxActiveRuns: 2 }));
    assert.equal(writes, 1);
  }
});
