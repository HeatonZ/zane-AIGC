import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { loadWorkspaceStatus, ApiError, cancelWorkflowRun, loadWorkflowRun, loadWorkflowRuns, runWorkflow, subscribeWorkflowRun, previewWorkflowRerun, submitWorkflowRerun, waitForWorkflowRun } from "./api";
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


test("旧服务缺少局部重做路由时明确要求重启，绝不回退为整流程运行", async () => {
  const paths: string[] = [];
  globalThis.fetch = (async (input) => { paths.push(String(input)); return legacy404(); }) as typeof fetch;
  const changes = { rerunSteps: [{ stepId: "selected" }] };
  for (const submit of [() => previewWorkflowRerun(runId, changes), () => submitWorkflowRerun(runId, changes)]) {
    await assert.rejects(submit(), (error: unknown) => error instanceof ApiError && error.code === "RERUN_UNAVAILABLE" && /重启/.test(error.message));
  }
  assert.deepEqual(paths, [
    "/api/v1/runs/" + runId + "/rerun/preview",
    "/api/v1/runs/" + runId + "/rerun",
  ]);
});

test("局部重做的 JSON 404 保留真实错误，不误报旧服务", async () => {
  globalThis.fetch = (async () => json({ error: "没有找到局部重做来源运行记录" }, 404)) as typeof fetch;
  await assert.rejects(previewWorkflowRerun(runId, { rerunSteps: [{ stepId: "selected" }] }), (error: unknown) => error instanceof ApiError && !error.routeUnavailable && /来源运行记录/.test(error.message));
});

class TestEventSource {
  static instances: TestEventSource[] = [];
  onmessage: ((event: MessageEvent) => void) | null = null;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;
  constructor(readonly url: string) { TestEventSource.instances.push(this); }
  close() { this.closed = true; }
  frame(run: WorkflowRunRecord, sequence: number) { this.onmessage?.(new MessageEvent("message", { data: JSON.stringify({ run }), lastEventId: String(sequence) })); }
}
async function flushRequests() { for (let index = 0; index < 5; index++) await new Promise(resolve => setImmediate(resolve)); }
function useTestEventSource() { TestEventSource.instances = []; globalThis.EventSource = TestEventSource as unknown as typeof EventSource; }

test("提交响应丢失后只按原运行 ID 查询，不重复 POST 生成", async () => {
  const paths: string[] = [];
  globalThis.fetch = (async (input, init) => {
    paths.push(String(input));
    if (init?.method === "POST") throw new TypeError("response connection lost after commit");
    return json(record);
  }) as typeof fetch;
  const definition: WorkflowDefinition = { sceneId: record.sceneId, name: record.workflowName, inputs: [], steps: [], outputs: [] };
  const result = await runWorkflow(definition, {}, undefined, runId);
  assert.equal(result.status, "completed");
  assert.deepEqual(paths, ["/api/v1/runs", "/api/v1/runs/" + runId]);
});

test("已读到运行后，长时间网络断开不会误判成永久失败", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] }); useTestEventSource();
  let offline = false; const seen: string[] = [], permanent: boolean[] = [];
  globalThis.fetch = (async () => { if (offline) throw new TypeError("offline"); return json({ ...record, status: seen.length ? "completed" : "running" }); }) as typeof fetch;
  const stop = subscribeWorkflowRun(runId, run => seen.push(run.status), (_error, terminal) => permanent.push(Boolean(terminal)));
  t.after(stop); await flushRequests(); offline = true;
  TestEventSource.instances[0].onerror?.();
  for (let index = 0; index < 70; index++) { t.mock.timers.tick(10000); await flushRequests(); }
  assert.equal(permanent.some(Boolean), false);
  offline = false; t.mock.timers.tick(10000); await flushRequests();
  assert.equal(seen.at(-1), "completed"); stop();
});

test("SSE 手动重连携带事件游标，忽略旧连接和倒序消息", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] }); useTestEventSource();
  const seen: string[] = [];
  globalThis.fetch = (async () => json({ ...record, status: "running" })) as typeof fetch;
  const stop = subscribeWorkflowRun(runId, run => seen.push(run.status)); t.after(stop);
  await flushRequests(); const first = TestEventSource.instances[0];
  first.frame({ ...record, status: "running" }, 5); first.onerror?.();
  first.frame(record, 7);
  assert.equal(seen.at(-1), "running");
  t.mock.timers.tick(10000); await flushRequests(); const second = TestEventSource.instances[1];
  assert.equal(second.url, "/api/v1/runs/" + runId + "/events?after=5");
  second.frame(record, 4); assert.equal(seen.at(-1), "running");
  second.frame(record, 6); assert.equal(seen.at(-1), "completed");
  assert.equal(first.closed, true); assert.equal(second.closed, true);
});

test("取消等待前已中断的信号不再发起详情请求", async () => {
  let calls = 0; globalThis.fetch = (async () => { ++calls; return json(record); }) as typeof fetch;
  const controller = new AbortController(); controller.abort(new Error("page already closed"));
  await assert.rejects(waitForWorkflowRun(runId, controller.signal), /page already closed/);
  assert.equal(calls, 0);
});

test("正常提交得到确认后才开始读取详情，并通知界面解除准备状态", async () => {
  const paths: string[] = []; let accept!: (response: Response) => void; let acknowledged = false;
  const response = new Promise<Response>(resolve => { accept = resolve; });
  globalThis.fetch = (async (input, init) => { paths.push(String(input)); return init?.method === "POST" ? response : json(record); }) as typeof fetch;
  const definition: WorkflowDefinition = { sceneId: record.sceneId, name: record.workflowName, inputs: [], steps: [], outputs: [] };
  const running = runWorkflow(definition, {}, undefined, runId, undefined, undefined, () => { acknowledged = true; });
  await flushRequests(); assert.equal(acknowledged, false); assert.deepEqual(paths, ["/api/v1/runs"]);
  accept(json({ runId, status: "queued" }, 202));
  assert.equal((await running).status, "completed"); assert.equal(acknowledged, true);
  assert.deepEqual(paths, ["/api/v1/runs", "/api/v1/runs/" + runId]);
});

test("确定的提交校验错误不启动结果查询或重新提交", async () => {
  let calls = 0; let acknowledged = false;
  globalThis.fetch = (async () => { ++calls; return json({ error: "输入类型错误", code: "INVALID_INPUT" }, 400); }) as typeof fetch;
  const definition: WorkflowDefinition = { sceneId: record.sceneId, name: record.workflowName, inputs: [], steps: [], outputs: [] };
  await assert.rejects(runWorkflow(definition, {}, undefined, runId, undefined, undefined, () => { acknowledged = true; }),
    error => error instanceof ApiError && error.code === "INVALID_INPUT");
  assert.equal(calls, 1); assert.equal(acknowledged, false);
});

test("提交响应异常且记录仍在准备时等待原 ID，读到记录后再解除准备状态", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let posts = 0, reads = 0; let acknowledged = false;
  globalThis.fetch = (async (_input, init) => {
    if (init?.method === "POST") { ++posts; return json({ error: "response failed" }, 502); }
    if (++reads === 1) return json({ error: "素材准备中", code: "RUN_PREPARING" }, 409);
    return json(record);
  }) as typeof fetch;
  const definition: WorkflowDefinition = { sceneId: record.sceneId, name: record.workflowName, inputs: [], steps: [], outputs: [] };
  const controller = new AbortController(); t.after(() => controller.abort());
  const running = runWorkflow(definition, {}, controller.signal, runId, undefined, undefined, () => { acknowledged = true; });
  await flushRequests(); assert.equal(acknowledged, false); t.mock.timers.tick(1000); await flushRequests();
  assert.equal((await running).status, "completed"); assert.equal(acknowledged, true); assert.equal(posts, 1); assert.equal(reads, 2);
});

test("一直查不到未确认提交时给出不确定状态，绝不自动再次生成", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] }); let posts = 0;
  globalThis.fetch = (async (_input, init) => {
    if (init?.method === "POST") { ++posts; throw new TypeError("response lost"); }
    return json({ error: "not found" }, 404);
  }) as typeof fetch;
  const definition: WorkflowDefinition = { sceneId: record.sceneId, name: record.workflowName, inputs: [], steps: [], outputs: [] };
  const controller = new AbortController(); t.after(() => controller.abort());
  const rejected = assert.rejects(runWorkflow(definition, {}, controller.signal, runId), error =>
    error instanceof ApiError && error.code === "RUN_SUBMISSION_UNCONFIRMED" && error.message.includes(runId) && /不要重复提交/.test(error.message));
  await flushRequests(); for (let index = 0; index < 60; index++) { t.mock.timers.tick(10000); await flushRequests(); }
  await rejected; assert.equal(posts, 1);
});

test("详情请求无响应会超时并重连，停止订阅会释放所有读取", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] }); useTestEventSource();
  let reads = 0, aborted = 0; const seen: string[] = [], errors: boolean[] = [];
  globalThis.fetch = (async (_input, init) => {
    if (++reads === 1) return json({ ...record, status: "running" });
    if (reads === 2) return new Promise<Response>((_resolve, reject) => {
      init!.signal!.addEventListener("abort", () => { ++aborted; reject(init!.signal!.reason); }, { once: true });
    });
    return json(record);
  }) as typeof fetch;
  const stop = subscribeWorkflowRun(runId, run => seen.push(run.status), (_error, permanent) => errors.push(Boolean(permanent)));
  t.after(stop); await flushRequests(); TestEventSource.instances[0].onerror?.();
  t.mock.timers.tick(10000); await flushRequests(); t.mock.timers.tick(15000); await flushRequests();
  assert.equal(aborted, 1); assert.equal(errors.some(Boolean), false);
  t.mock.timers.tick(1000); await flushRequests(); assert.equal(seen.at(-1), "completed");
  stop(); t.mock.timers.tick(100000); await flushRequests(); assert.equal(reads, 3);
});


test("能力目录客户端读完分页才提交完整目录，快照变化/坏游标不能静默截断", async () => {
  const { loadWorkflowCapabilities } = await import("./api");
  const paths: string[] = [];
  globalThis.fetch = (async (input) => { const path = String(input); paths.push(path); return json({ schemaVersion: 1, revision: "stable", capabilities: [{ id: path.includes("cursor=") ? "second" : "first" }], hasMore: !path.includes("cursor="), ...(path.includes("cursor=") ? {} : { nextCursor: "next" }) }); }) as typeof fetch;
  const all = await loadWorkflowCapabilities(); assert.deepEqual(all.capabilities.map((item) => item.id), ["first", "second"]); assert.equal(all.hasMore, false); assert.equal(paths.length, 2); assert.match(paths[1], /cursor=next/);
  globalThis.fetch = (async (input) => json({ revision: String(input).includes("cursor=") ? "new" : "old", capabilities: [], hasMore: true, nextCursor: "next" })) as typeof fetch;
  await assert.rejects(loadWorkflowCapabilities(), (error: unknown) => error instanceof ApiError && error.code === "CAPABILITY_PAGE_CHANGED");
  globalThis.fetch = (async () => json({ revision: "stable", capabilities: [], hasMore: true, nextCursor: "same" })) as typeof fetch;
  await assert.rejects(loadWorkflowCapabilities(), (error: unknown) => error instanceof ApiError && error.code === "INVALID_CAPABILITY_PAGE");
});


test("旧后台缺少轻量revision端点时仅读取相同权威工作区，不使用本地场景并标记兼容模式", async () => {
  const paths: string[] = [];
  const workspace = { format: "zane-studio.workspace/v1", revision: 120, scenes: [], workflows: {}, drafts: [], optionPresets: [], sceneVersions: {} };
  globalThis.fetch = (async (input, init) => { const path = String(input); paths.push(path); assert.equal(init?.cache, "no-store"); return path.endsWith("/status") ? legacy404() : json({ workspace }); }) as typeof fetch;
  assert.deepEqual(await loadWorkspaceStatus(), { authority: "sqlite", initialized: true, workspaceRevision: 120, catalogView: "draft", executionView: "published", readMode: "legacy-snapshot" });
  assert.deepEqual(paths, ["/api/workspace/status", "/api/workspace"]);
});

test("新版元数据直接读取；503不伪装成旧后台，损坏快照不使用浏览器默认配置", async () => {
  const status = { authority: "sqlite", initialized: true, workspaceRevision: 7, catalogView: "draft", executionView: "published" }; let calls = 0;
  globalThis.fetch = (async () => { calls++; return json(status); }) as typeof fetch;
  assert.deepEqual(await loadWorkspaceStatus(), { ...status, readMode: "metadata" }); assert.equal(calls, 1);
  globalThis.fetch = (async () => json({ error: "服务正在停止", code: "NOT_READY" }, 503)) as typeof fetch;
  await assert.rejects(loadWorkspaceStatus(), error => error instanceof ApiError && error.status === 503);
  globalThis.fetch = (async input => String(input).endsWith("/status") ? legacy404() : json({ workspace: { scenes: [] } })) as typeof fetch;
  await assert.rejects(loadWorkspaceStatus(), /不会使用本机默认场景替代/);
});
