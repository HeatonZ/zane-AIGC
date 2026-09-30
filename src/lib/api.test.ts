import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { ApiError, cancelWorkflowRun, loadWorkflowRun, loadWorkflowRuns, runWorkflow, subscribeWorkflowRun } from "./api";
import type { WorkflowDefinition, WorkflowRunRecord } from "../types";

const originalFetch = globalThis.fetch;
const originalEventSource = globalThis.EventSource;
afterEach(() => { globalThis.fetch = originalFetch; globalThis.EventSource = originalEventSource; });

const runId = "12345678-1234-4234-8234-123456789abc";
const record: WorkflowRunRecord = {
  runId,
  sceneId: "legacy-scene",
  workflowName: "旧版本工作流",
  status: "completed",
  inputValues: {},
  steps: [],
  outputs: [],
  artifacts: { directory: "", inputs: "", workflow: "", runtime: "", output: "" },
};
const legacy404 = () => new Response("<!doctype html><title>Cannot GET</title>", {
  status: 404,
  headers: { "Content-Type": "text/html; charset=utf-8" },
});
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { "Content-Type": "application/json; charset=utf-8" },
});

test("运行列表、详情和取消在旧版服务缺少 v1 路由时回退到兼容路径", async () => {
  const paths: string[] = [];
  globalThis.fetch = (async (input) => {
    const path = String(input);
    paths.push(path);
    if (path.startsWith("/api/v1/")) return legacy404();
    if (path.startsWith("/api/workflows/runs?") || path === "/api/workflows/runs") return json({ projectDirectory: "project", runs: [] });
    if (path.endsWith("/cancel")) return json({ runId, status: "cancelling" });
    return json(record);
  }) as typeof fetch;

  const list = await loadWorkflowRuns("next cursor");
  assert.equal(list.projectDirectory, "project");
  assert.deepEqual(list.runs, []);
  assert.deepEqual(await loadWorkflowRun(runId), record);
  assert.deepEqual(await cancelWorkflowRun(runId), { runId, status: "cancelling" });
  assert.ok(paths.includes("/api/v1/runs?limit=50&cursor=next%20cursor"));
  assert.ok(paths.includes("/api/workflows/runs?limit=50&cursor=next%20cursor"));
  assert.ok(paths.includes(`/api/workflows/runs/${runId}`));
  assert.ok(paths.includes(`/api/workflows/runs/${runId}/cancel`));
});

test("JSON 404 表示运行记录不存在，不应伪装成旧路由回退", async () => {
  let calls = 0;
  globalThis.fetch = (async () => { calls += 1; return json({ error: "没有找到这条运行记录", code: "REQUEST_FAILED" }, 404); }) as typeof fetch;

  await assert.rejects(loadWorkflowRun(runId), (error: unknown) => error instanceof ApiError && error.status === 404 && !error.routeUnavailable);
  assert.equal(calls, 1);
});

test("运行详情订阅在旧版服务上回退到轮询，不把兼容路由显示为 404", async () => {
  const paths: string[] = [];
  globalThis.fetch = (async (input) => {
    const path = String(input);
    paths.push(path);
    return path.startsWith("/api/v1/") ? legacy404() : json(record);
  }) as typeof fetch;
  class UnexpectedEventSource {
    onmessage: ((event: MessageEvent) => void) | null = null;
    onopen: (() => void) | null = null;
    onerror: (() => void) | null = null;
    close() {}
  }
  globalThis.EventSource = UnexpectedEventSource as unknown as typeof EventSource;
  let seen: WorkflowRunRecord | undefined;
  const stop = subscribeWorkflowRun(runId, (run) => { seen = run; });
  for (let index = 0; index < 20 && !seen; index += 1) await new Promise((resolve) => setImmediate(resolve));
  stop();
  assert.deepEqual(seen, record);
  assert.deepEqual(paths, [`/api/v1/runs/${runId}`, `/api/workflows/runs/${runId}`]);
});

test("旧版同步运行接口可作为新异步提交路由缺失时的兼容回退", async () => {
  const paths: string[] = [];
  globalThis.fetch = (async (input, init) => {
    paths.push(String(input));
    if (String(input) === "/api/v1/runs") return legacy404();
    assert.equal(init?.method, "POST");
    const body = JSON.parse(String(init?.body)) as { runId: string; workflow: WorkflowDefinition };
    assert.equal(body.runId, runId);
    assert.equal(body.workflow.name, "兼容测试");
    return json(record);
  }) as typeof fetch;

  const workflow: WorkflowDefinition = { sceneId: "legacy-scene", name: "兼容测试", inputs: [], steps: [], outputs: [] };
  assert.deepEqual(await runWorkflow(workflow, {}, undefined, runId), record);
  assert.deepEqual(paths, ["/api/v1/runs", "/api/workflows/run"]);
});
