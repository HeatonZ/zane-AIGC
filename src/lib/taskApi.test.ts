import assert from "node:assert/strict";
import test from "node:test";
import { AccessApiError } from "./accessApi.js";
import { cancelTask, confirmTask, createTask, deleteTask, getTask, listTasks, rerunTaskItem, updateTask, isActiveTask, isEditableTask, taskStatusLabels } from "./taskApi.js";
import type { TaskView } from "../../server/domain/taskContracts.js";

const view: TaskView = {
  taskId: "11111111-1111-4111-8111-111111111111", revision: 1, name: "批量出图", status: "draft",
  progress: { total: 2, pending: 2, active: 0, waiting: 0, completed: 0, failed: 0, cancelled: 0 },
  createdAt: "2026-10-12T00:00:00.000Z", updatedAt: "2026-10-12T00:00:00.000Z",
  itemCount: 2, runIds: [], sceneIds: ["demo"], itemsOmitted: true,
};
const ok = (value: unknown) => new Response(JSON.stringify(value), { status: 200, headers: { "Content-Type": "application/json" } });
/** 记录请求，便于断言「没有自动重放、没有换 ID」。 */
function recording(responses: unknown[]) {
  const calls: Array<{ path: string; method: string; body?: Record<string, unknown> }> = [];
  return { calls, handler: async (input: string, options: RequestInit = {}) => {
    calls.push({ path: input, method: options.method ?? "GET", ...(options.body ? { body: JSON.parse(String(options.body)) as Record<string, unknown> } : {}) });
    return ok(responses[Math.min(calls.length - 1, responses.length - 1)]);
  } };
}

test("任务客户端：列表与详情读取经契约校验，返回稳定 revision", async t => {
  const h = recording([{ items: [view], revision: "snap", total: 1, hasMore: false, nextAction: "get_task" }, { task: { ...view, itemsOmitted: false, items: [] }, nextAction: "confirm_task" }]);
  t.mock.method(globalThis, "fetch", h.handler);
  const page = await listTasks({ limit: 10 });
  assert.equal(page.total, 1); assert.equal(page.items[0].taskId, view.taskId);
  const detail = await getTask(view.taskId);
  assert.equal(detail.status, "draft");
  assert.deepEqual(h.calls.map(call => call.method), ["GET", "GET"]);
});

test("任务客户端：创建携带预先保存的 taskId，回执不完整时明确失败且不重放", async t => {
  const h = recording([{ task: { ...view, name: undefined } }]);
  t.mock.method(globalThis, "fetch", h.handler);
  await assert.rejects(createTask({ taskId: view.taskId, name: "批量出图", items: [{ sceneId: "demo", versionId: "version-a", inputValues: { flag: true } }] }), (error: AccessApiError) => error.code === "RESPONSE_UNKNOWN" && /按原 taskId 读取对账/.test(error.message));
  // 只发了一次请求：失败不得自动换 ID 重投。
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].body?.taskId, view.taskId);
});

test("任务客户端：确认回执报告本次真正提交的项，重放时 submitted 为空", async t => {
  const h = recording([{ task: { ...view, status: "running", revision: 2 }, alreadyConfirmed: true, submitted: [], failures: [], nextAction: "get_task" }]);
  t.mock.method(globalThis, "fetch", h.handler);
  const result = await confirmTask(view.taskId, 1);
  assert.equal(result.alreadyConfirmed, true);
  assert.equal(result.submitted.length, 0);
  assert.equal(h.calls[0].body?.revision, 1);
  assert.match(h.calls[0].path, /\/confirm$/);
});

test("任务客户端：确认、重跑、取消、删除都带上当前 revision，且各自走独立端点", async t => {
  const h = recording([
    { task: { ...view, revision: 2 }, alreadyConfirmed: false, submitted: [{ itemId: "i", runId: "r" }], failures: [], nextAction: "get_task" },
    { task: { ...view, revision: 3 }, nextAction: "get_task" },
    { task: { ...view, revision: 4, name: "改名" }, nextAction: "get_task" },
    { task: { ...view, revision: 5, cancelledAt: "2026-10-12T01:00:00.000Z" }, nextAction: "get_task" },
    { taskId: view.taskId, deleted: true, nextAction: "list_tasks" },
  ]);
  t.mock.method(globalThis, "fetch", h.handler);
  assert.equal((await confirmTask(view.taskId, 1)).submitted.length, 1);
  assert.equal((await rerunTaskItem(view.taskId, "item-1", 2)).revision, 3);
  assert.equal((await updateTask(view.taskId, { revision: 3, name: "改名" })).name, "改名");
  const cancelled = await cancelTask(view.taskId, 4);
  assert.ok(cancelled.cancelledAt);
  assert.equal((await deleteTask(view.taskId, 5)).deleted, true);
  assert.deepEqual(h.calls.map(call => call.method), ["POST", "POST", "PATCH", "POST", "DELETE"]);
  assert.match(h.calls[1].path, /\/items\/item-1\/rerun$/);
  assert.match(h.calls[3].path, /\/cancel$/);
  // 删除把 revision 放在请求体：DELETE 也要有并发保护。
  assert.equal(h.calls[4].body?.revision, 5);
});

test("任务状态：只有未结束的状态触发轮询，标签覆盖全部状态", () => {
  assert.equal(isActiveTask("running"), true);
  assert.equal(isActiveTask("waiting"), true);
  assert.equal(isActiveTask("cancelling"), true);
  for (const status of ["draft", "completed", "completed_with_errors", "failed", "cancelled"] as const) assert.equal(isActiveTask(status), false);
  assert.deepEqual(Object.keys(taskStatusLabels).sort(), ["cancelled", "cancelling", "completed", "completed_with_errors", "draft", "failed", "running", "waiting"]);
});

test("任务项只在确认前可编辑：confirmedAt 落库后冻结，与 status 投影一致", () => {
  // 未选中任何任务时按「新建」处理，表格可编辑。
  assert.equal(isEditableTask(undefined), true);
  assert.equal(isEditableTask({ status: "draft" }), true);
  // 确认后（confirmedAt 非空）必须只读：服务端也会拒绝 UPDATE（TASK_ALREADY_CONFIRMED）。
  for (const status of ["running", "waiting", "completed", "failed", "cancelled"] as const) {
    assert.equal(isEditableTask({ status, confirmedAt: "2026-01-01T00:00:00.000Z" }), false);
  }
  // 以 confirmedAt 为准，而不是只信 status 字符串。
  assert.equal(isEditableTask({ status: "completed" }), true);
});
