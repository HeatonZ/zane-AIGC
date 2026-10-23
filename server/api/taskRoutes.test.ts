import assert from "node:assert/strict";
import test from "node:test";
import { taskHarness } from "../testing/taskSupport.js";
import { until } from "../testing/testSupport.js";

test("任务HTTP：完整闭环 创建→读取→修改→确认→跟踪→取消", async (t) => {
  const h = await taskHarness(t);
  const taskId = h.newTaskId();
  const created = await h.call("POST", "/api/v1/tasks", { taskId, name: "批量出图", note: "项目 A", items: [h.item("第 1 张"), h.item("第 2 张")] });
  assert.equal(created.status, 201);
  assert.equal((created.body.task as Record<string, unknown>).status, "draft");
  assert.equal((created.body.task as Record<string, unknown>).itemCount, 2);
  assert.equal((created.body.task as Record<string, unknown>).revision, 1);
  assert.equal(created.body.nextAction, "confirm_task");
  // 创建不产生运行记录。
  assert.equal(h.store.listRuns(h.settings.projectDirectory).runs.length, 0);

  const detail = await h.call("GET", "/api/v1/tasks/" + taskId);
  assert.equal(detail.status, 200);
  const items = (detail.body.task as { items: Array<Record<string, unknown>> }).items;
  assert.equal(items.length, 2);
  // 详情返回完整输入，且已按发布快照补齐默认值（style 来自发布版预设）。
  assert.deepEqual(items[0].inputValues, { flag: true, style: "已发布值" });
  assert.equal(items[0].state, "pending");

  const patched = await h.call("PATCH", "/api/v1/tasks/" + taskId, { revision: 1, name: "批量出图（改）" });
  assert.equal(patched.status, 200);
  assert.equal((patched.body.task as Record<string, unknown>).name, "批量出图（改）");
  assert.equal((patched.body.task as Record<string, unknown>).revision, 2);

  const confirmed = await h.call("POST", "/api/v1/tasks/" + taskId + "/confirm", { revision: 2 });
  assert.equal(confirmed.status, 202);
  assert.equal(confirmed.body.alreadyConfirmed, false);
  const runIds = (confirmed.body.task as { runIds: string[] }).runIds;
  assert.equal(runIds.length, 2);
  assert.equal((confirmed.body.submitted as unknown[]).length, 2);
  assert.equal((confirmed.body.failures as unknown[]).length, 0);

  await until(() => runIds.every(id => h.store.getRun(h.settings.projectDirectory, id)?.status === "completed"));
  const done = await h.call("GET", "/api/v1/tasks/" + taskId);
  assert.equal((done.body.task as Record<string, unknown>).status, "completed");
  assert.deepEqual((done.body.task as { progress: unknown }).progress, { total: 2, pending: 0, active: 0, waiting: 0, completed: 2, failed: 0, cancelled: 0 });

  // 响应丢失重试：同一请求重复确认必须复用同一批 runId，不重复提交。
  const retry = await h.call("POST", "/api/v1/tasks/" + taskId + "/confirm", { revision: 2 });
  assert.equal(retry.status, 202);
  assert.equal(retry.body.alreadyConfirmed, true);
  assert.deepEqual((retry.body.task as { runIds: string[] }).runIds, runIds);
  assert.equal(h.store.listRuns(h.settings.projectDirectory).runs.length, 2);

  const rerun = await h.call("POST", "/api/v1/tasks/" + taskId + "/items/" + items[0].itemId + "/rerun", { revision: (done.body.task as { revision: number }).revision });
  assert.equal(rerun.status, 202);
  assert.equal(((rerun.body.task as { runIds: string[] }).runIds).length, 2, "重跑后仍是 2 个当前运行");
  const rerunRunIds = (rerun.body.task as { runIds: string[] }).runIds;
  await until(() => rerunRunIds.every(id => h.store.getRun(h.settings.projectDirectory, id)?.status === "completed"));

  const listed = await h.call("GET", "/api/v1/tasks?limit=10");
  assert.equal(listed.status, 200);
  assert.equal(listed.body.total, 1);
  assert.equal((listed.body.items as Array<Record<string, unknown>>)[0].itemsOmitted, true);

  const cancelled = await h.call("POST", "/api/v1/tasks/" + taskId + "/cancel", { revision: ((await h.call("GET", "/api/v1/tasks/" + taskId)).body.task as { revision: number }).revision });
  assert.equal(cancelled.status, 200);
  assert.ok((cancelled.body.task as Record<string, unknown>).cancelledAt);

  const revision = (cancelled.body.task as { revision: number }).revision;
  const deleted = await h.call("DELETE", "/api/v1/tasks/" + taskId, { revision });
  assert.equal(deleted.status, 200);
  assert.equal(deleted.body.deleted, true);
  assert.equal((await h.call("GET", "/api/v1/tasks/" + taskId)).status, 404);
  // 删除任务不删除历史运行：2 条首次运行 + 1 条单项重跑都还在。
  assert.equal(h.store.listRuns(h.settings.projectDirectory).runs.length, 3);
});

test("任务HTTP：参数、revision 冲突与不存在的对象返回明确错误码", async (t) => {
  const h = await taskHarness(t);
  const taskId = h.newTaskId();
  // 无效参数：schema 层拒绝，并说明哪个字段。
  const bad = await h.call("POST", "/api/v1/tasks", { taskId, name: "x", items: [] });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.code, "INVALID_TASK_REQUEST");
  const missingRevision = await h.call("PATCH", "/api/v1/tasks/" + taskId, { name: "x" });
  assert.equal(missingRevision.status, 400);
  const extraField = await h.call("POST", "/api/v1/tasks", { taskId, name: "x", items: [h.item("a")], unexpected: 1 });
  assert.equal(extraField.status, 400, "严格模式拒绝未知字段");

  const created = await h.call("POST", "/api/v1/tasks", { taskId, name: "冲突", items: [h.item("a")] });
  assert.equal(created.status, 201);
  const conflict = await h.call("PATCH", "/api/v1/tasks/" + taskId, { revision: 99, name: "旧revision" });
  assert.equal(conflict.status, 409);
  assert.equal(conflict.body.code, "TASK_REVISION_CONFLICT");
  // 同一 taskId 重复创建 → 按原 ID 对账，不新建。
  const duplicate = await h.call("POST", "/api/v1/tasks", { taskId, name: "重复", items: [h.item("a")] });
  assert.equal(duplicate.status, 409);
  assert.equal(duplicate.body.code, "TASK_ALREADY_EXISTS");
  // 不存在的对象。
  assert.equal((await h.call("GET", "/api/v1/tasks/" + h.newTaskId())).status, 404);
  assert.equal((await h.call("POST", "/api/v1/tasks/" + h.newTaskId() + "/confirm", { revision: 1 })).status, 404);
  // 分页边界。
  assert.equal((await h.call("GET", "/api/v1/tasks?limit=0")).status, 400);
  assert.equal((await h.call("GET", "/api/v1/tasks?limit=101")).status, 400);
});

test("任务HTTP：缺必填的草稿能创建，确认返回 400 TASK_ITEMS_INCOMPLETE 并指出哪几项", async (t) => {
  const h = await taskHarness(t);
  const taskId = h.newTaskId();
  // 显式 null 表示「还没填」：这是「先占行、后补素材」的保存路径，必须 201 而不是 REQUIRED_INPUT_MISSING。
  const created = await h.call("POST", "/api/v1/tasks", { taskId, name: "缺必填草稿", items: [{ label: "第 1 张", sceneId: "demo", versionId: "version-a", inputValues: { flag: null } }] });
  assert.equal(created.status, 201);
  assert.equal((created.body.task as Record<string, unknown>).status, "draft");
  assert.equal((created.body.task as { revision: number }).revision, 1);

  const blocked = await h.call("POST", "/api/v1/tasks/" + taskId + "/confirm", { revision: 1 });
  assert.equal(blocked.status, 400);
  assert.equal(blocked.body.code, "TASK_ITEMS_INCOMPLETE");
  const details = blocked.body.details as { items: Array<{ itemId: string; label: string; message: string }>; nextAction: string };
  assert.equal(details.items.length, 1);
  assert.equal(details.items[0].label, "第 1 张");
  assert.match(details.items[0].message, /必填字段：flag/);
  assert.equal(details.nextAction, "update_task");
  // 拒绝确认时不能冻结任务、也不能提交运行：仍是 revision 1 的可编辑草稿。
  const after = await h.call("GET", "/api/v1/tasks/" + taskId);
  assert.equal((after.body.task as Record<string, unknown>).status, "draft");
  assert.equal((after.body.task as { revision: number }).revision, 1);
  assert.equal(h.store.listRuns(h.settings.projectDirectory).runs.length, 0);
});

test("任务HTTP：管理端专用，普通用户被拒绝", async (t) => {
  const h = await taskHarness(t);
  const taskId = h.newTaskId();
  const created = await h.call("POST", "/api/v1/tasks", { taskId, name: "管理端任务", items: [h.item("a")] });
  assert.equal(created.status, 201);

  // 普通用户凭证不能读取、创建、确认或删除任务：任务属管理端本轮范围。
  for (const [method, suffix, body] of [
    ["GET", "/api/v1/tasks", undefined],
    ["GET", "/api/v1/tasks/" + taskId, undefined],
    ["POST", "/api/v1/tasks", { taskId: h.newTaskId(), name: "x", items: [h.item("a")] }],
    ["POST", "/api/v1/tasks/" + taskId + "/confirm", { revision: 1 }],
    ["DELETE", "/api/v1/tasks/" + taskId, { revision: 1 }],
  ] as Array<[string, string, unknown]>) {
    const response = await h.call(method, suffix, body, h.user.token);
    assert.equal(response.status, 403, method + " " + suffix + " 必须拒绝普通用户");
    assert.equal(response.body.code, "ADMIN_REQUIRED");
  }
  // 未认证请求同样被拒绝。
  const anonymous = await h.call("GET", "/api/v1/tasks", undefined, "");
  assert.equal(anonymous.status, 401);
});

test("任务HTTP：确认时单项失败仍返回 202 并汇总部分完成", async (t) => {
  const h = await taskHarness(t);
  const taskId = h.newTaskId();
  const created = await h.call("POST", "/api/v1/tasks", { taskId, name: "部分失败", items: [h.item("第 1 张"), { label: "第 2 张", sceneId: "demo2", versionId: "version-b", inputValues: { flag: true } }] });
  assert.equal(created.status, 201);
  const intact = h.store.getWorkspace()!;
  const versions = { ...(intact.sceneVersions as Record<string, unknown>) };
  h.store.saveWorkspace({ ...intact, sceneVersions: { ...versions, demo2: { publishedVersionId: "version-b", versions: [] } } });

  const confirmed = await h.call("POST", "/api/v1/tasks/" + taskId + "/confirm", { revision: 1 });
  assert.equal(confirmed.status, 202, "部分失败不是整批失败，仍返回已接受");
  assert.equal((confirmed.body.failures as unknown[]).length, 1);
  assert.equal((confirmed.body.submitted as unknown[]).length, 1);
  assert.equal(confirmed.body.nextAction, "rerun_task_item");
  const task = confirmed.body.task as { progress: Record<string, number>; runIds: string[] };
  assert.equal(task.progress.failed, 1);
  assert.equal(task.progress.active, 1);
  await until(() => task.runIds.every(id => h.store.getRun(h.settings.projectDirectory, id)?.status === "completed"));
  assert.equal(((await h.call("GET", "/api/v1/tasks/" + taskId)).body.task as Record<string, unknown>).status, "completed_with_errors");
});
