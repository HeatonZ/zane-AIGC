import assert from "node:assert/strict";
import test from "node:test";
import { taskHarness } from "../testing/taskSupport.js";
import { taskStatusOf } from "../domain/taskContracts.js";
import { until } from "../testing/testSupport.js";
import type { WorkflowInputField } from "../../src/types.js";

/** 建一个确认前草稿，返回 taskId 与详情。 */
async function draft(h: Awaited<ReturnType<typeof taskHarness>>, name: string, items: unknown[]) {
  const taskId = h.newTaskId();
  const created = await h.tasks.create({ taskId, name, items }, h.actor);
  return { taskId, created };
}
async function confirmed(h: Awaited<ReturnType<typeof taskHarness>>, name: string, items: unknown[]) {
  const { taskId, created } = await draft(h, name, items);
  const result = await h.tasks.confirm(taskId, { taskId, revision: created.task.revision }, h.actor);
  return { taskId, created, result };
}

test("任务：创建草稿时不提交运行，确认后每项各提交一条独立运行", async (t) => {
  const h = await taskHarness(t);
  const { taskId, created } = await draft(h, "连续出图", [h.item("第 1 张"), h.item("第 2 张"), h.item("第 3 张")]);
  assert.equal(created.task.status, "draft");
  assert.equal(created.task.confirmedAt, undefined);
  assert.equal(created.task.itemCount, 3);
  assert.deepEqual(created.task.progress, { total: 3, pending: 3, active: 0, waiting: 0, completed: 0, failed: 0, cancelled: 0 });
  // 创建只落任务草稿，不产生任何运行记录——这是“先创建、确认后才全自动跑”的核心约束。
  assert.deepEqual(h.store.listRuns(h.settings.projectDirectory).runs, []);
  assert.deepEqual(created.task.items?.map(item => item.state), ["pending", "pending", "pending"]);

  const { result } = await confirmed(h, "另一个任务", [h.item("唯一一张")]);
  assert.equal(result.alreadyConfirmed, false);
  assert.equal(result.failures.length, 0);
  assert.equal(result.submitted.length, 1);
  // 每项一个独立 runId，且都能按该 ID 读回真实运行记录。
  const runIds = result.task.runIds;
  assert.equal(runIds.length, 1);
  assert.equal(h.store.getRun(h.settings.projectDirectory, runIds[0])?.status, "queued");
  assert.equal(result.task.status, "running");
  assert.equal(result.task.progress.active, 1);
  assert.ok(runIds.includes(result.submitted[0].runId));
  await until(() => h.store.getRun(h.settings.projectDirectory, runIds[0])?.status === "completed");
  const done = await h.tasks.detail(taskId.replace(taskId, result.task.taskId));
  assert.equal(done.task.status, "completed");
  assert.deepEqual(done.task.progress, { total: 1, pending: 0, active: 0, waiting: 0, completed: 1, failed: 0, cancelled: 0 });
});

test("任务：确认前可反复编辑，确认后输入冻结且 revision 冲突受保护", async (t) => {
  const h = await taskHarness(t);
  const { taskId, created } = await draft(h, "可编辑草稿", [h.item("第 1 张")]);
  const renamed = await h.tasks.update(taskId, { taskId, revision: created.task.revision, name: "改名后的任务", note: "项目 A" }, h.actor);
  assert.equal(renamed.task.name, "改名后的任务");
  assert.equal(renamed.task.note, "项目 A");
  const replaced = await h.tasks.update(taskId, { taskId, revision: renamed.task.revision, items: [h.item("第 1 张"), h.item("第 2 张"), h.item("第 3 张")] }, h.actor);
  assert.equal(replaced.task.itemCount, 3);
  // 按位置保留 itemId：编辑表格行不应让已有项的标识漂移，否则单项重跑会指错对象。
  assert.equal(replaced.task.items?.[0].itemId, created.task.items?.[0].itemId);
  assert.equal(new Set(replaced.task.items?.map(item => item.itemId)).size, 3, "每个任务项的 itemId 必须唯一");

  const result = await h.tasks.confirm(taskId, { taskId, revision: replaced.task.revision }, h.actor);
  await assert.rejects(() => h.tasks.update(taskId, { taskId, revision: result.task.revision, name: "确认后改名" }, h.actor), /已确认/);
  // 确认后 revision 必然推进；旧 revision 必须被拒绝，不能盲重试写入。
  await assert.rejects(() => h.tasks.update(taskId, { taskId, revision: created.task.revision, name: "旧revision" }, h.actor), (error: Error & { code?: string }) => error.code === "TASK_REVISION_CONFLICT");
  await until(() => result.task.runIds.every(id => h.store.getRun(h.settings.projectDirectory, id)?.status === "completed"));
});

test("任务：重复确认用同一批 runId 对账，不重复提交或重复计费", async (t) => {
  const h = await taskHarness(t);
  const { taskId, created } = await draft(h, "重复确认", [h.item("第 1 张"), h.item("第 2 张")]);
  const first = await h.tasks.confirm(taskId, { taskId, revision: created.task.revision }, h.actor);
  assert.equal(first.alreadyConfirmed, false);
  assert.equal(first.submitted.length, 2);
  const runIds = [...first.task.runIds].sort();

  // 模拟响应丢失后重试：同一 taskId、同一（已过期的）revision。已确认任务不再要求 revision 匹配，
  // 而是复用已落库的 runId 对账——这正是幂等提交的依据。
  const retry = await h.tasks.confirm(taskId, { taskId, revision: created.task.revision }, h.actor);
  assert.equal(retry.alreadyConfirmed, true);
  assert.deepEqual([...retry.task.runIds].sort(), runIds);
  // submitted 只统计「本次调用真正新提交的项」：重试时全部复用既有运行，因此是 0。
  // 若这里报 2，调用方就无法区分「真的又提交了两项」和「本来就有两项」，会误判重复计费。
  assert.equal(retry.submitted.length, 0);
  assert.equal(retry.failures.length, 0);
  // 运行记录总数必须仍等于任务项数，证明没有重复提交。
  assert.equal(h.store.listRuns(h.settings.projectDirectory).runs.length, 2);
  await until(() => first.task.runIds.every(id => h.store.getRun(h.settings.projectDirectory, id)?.status === "completed"));
});

test("任务：单项提交失败不阻断整批，任务汇总为部分完成且失败项可单独重跑", async (t) => {
  const h = await taskHarness(t);
  const { taskId, created } = await draft(h, "部分失败", [h.item("第 1 张"), { label: "第 2 张", sceneId: "demo2", versionId: "version-b", inputValues: { flag: true } }, h.item("第 3 张")]);
  const secondItemId = created.task.items![1].itemId;
  // 确认前把 demo2 的发布版撤下：确认时第 2 项预检失败，其余两项必须照常提交。
  const intact = h.store.getWorkspace()!;
  const versions = { ...(intact.sceneVersions as Record<string, { publishedVersionId: string; versions: unknown[] }>) };
  h.store.saveWorkspace({ ...intact, sceneVersions: { ...versions, demo2: { publishedVersionId: "version-b", versions: [] } } });

  const result = await h.tasks.confirm(taskId, { taskId, revision: created.task.revision }, h.actor);
  assert.equal(result.submitted.length, 2, "其余项必须继续提交");
  assert.equal(result.failures.length, 1);
  assert.equal(result.failures[0].itemId, secondItemId);
  assert.match(result.failures[0].message, /发布版本/);
  assert.equal(result.task.progress.failed, 1);
  assert.equal(result.nextAction, "rerun_task_item");
  const failedItem = result.task.items!.find(item => item.itemId === secondItemId)!;
  assert.equal(failedItem.state, "failed", "提交失败且无运行记录的项是终端的 failed，不能混同为未提交的 pending");
  assert.ok(failedItem.lastError);
  // 失败项没有真实运行记录，因此不出现在 runIds 中，避免调用方误以为它跑过。
  assert.equal(result.task.runIds.length, 2);
  await until(() => result.task.runIds.every(id => h.store.getRun(h.settings.projectDirectory, id)?.status === "completed"));
  // 部分成功 → 部分完成，而不是整体失败。
  assert.equal((await h.tasks.detail(taskId)).task.status, "completed_with_errors");

  // 确认后任务项已冻结，不能借编辑绕过。
  const rejected = await h.tasks.update(taskId, { taskId, revision: result.task.revision, items: [h.item("改一改")] }, h.actor).catch((error: Error) => error);
  assert.match(String(rejected), /已确认/);

  // 修好发布版后单独重跑这一项：只追加新运行，旧 runId 进 previousRunIds，不覆盖历史。
  h.store.saveWorkspace(intact);
  const before = result.task.items!.find(item => item.itemId === secondItemId)!;
  assert.equal(before.attemptCount, 0, "提交失败预留的 runId 从未成为运行记录，不计入尝试次数");
  const rerun = await h.tasks.rerunItem(taskId, { taskId, revision: result.task.revision, itemId: secondItemId }, h.actor);
  const rerunItem = rerun.task.items!.find(item => item.itemId === secondItemId)!;
  assert.ok(rerunItem.runId);
  assert.equal(rerunItem.lastError, undefined);
  await until(() => rerun.task.runIds.every(id => h.store.getRun(h.settings.projectDirectory, id)?.status === "completed"));
  const after = await h.tasks.detail(taskId);
  assert.equal(after.task.status, "completed", "重跑成功后任务转为全部完成");
  const rerunItemAfter = after.task.items!.find(item => item.itemId === secondItemId)!;
  assert.equal(rerunItemAfter.attemptCount, 1, "重跑后尝试数为 1（失败预留的 runId 不计入）");
  // 历史运行保留：任务只记录追加关系，不删除或覆盖旧运行。
  assert.equal(h.store.listRuns(h.settings.projectDirectory).runs.length, 3);
});

test("任务：等待人工确认的项拒绝重跑，不能绕过审核", async (t) => {
  const h = await taskHarness(t, { review: true });
  const { taskId, created } = await draft(h, "需要审核", [h.item("第 1 张")]);
  const result = await h.tasks.confirm(taskId, { taskId, revision: created.task.revision }, h.actor);
  const runId = result.task.runIds[0];
  await until(() => h.store.getRun(h.settings.projectDirectory, runId)?.status === "waiting");
  const waiting = await h.tasks.detail(taskId);
  assert.equal(waiting.task.status, "waiting");
  assert.equal(waiting.task.progress.waiting, 1);
  assert.ok(waiting.task.items![0].reviewId, "等待审核时暴露当前 reviewId");
  await assert.rejects(() => h.tasks.rerunItem(taskId, { taskId, revision: waiting.task.revision, itemId: waiting.task.items![0].itemId }, h.actor), (error: Error & { code?: string }) => error.code === "REVIEW_REQUIRED");
});

test("任务：取消尽力取消在途项并保留已完成结果，删除不删除历史运行", async (t) => {
  const h = await taskHarness(t);
  const { taskId, created } = await draft(h, "取消任务", [h.item("第 1 张"), h.item("第 2 张")]);
  const result = await h.tasks.confirm(taskId, { taskId, revision: created.task.revision }, h.actor);
  await until(() => result.task.runIds.every(id => h.store.getRun(h.settings.projectDirectory, id)?.status === "completed"));
  const cancelled = await h.tasks.cancel(taskId, { taskId, revision: result.task.revision }, h.actor);
  assert.ok(cancelled.task.cancelledAt);
  // 已完成的项保留结果：取消不回溯、不回滚已完成运行。
  assert.equal(cancelled.task.progress.completed, 2);
  assert.equal(cancelled.task.status, "cancelled");
  for (const id of result.task.runIds) assert.equal(h.store.getRun(h.settings.projectDirectory, id)?.status, "completed");
  // 取消可重复调用，不报错也不改变已完成项。
  const again = await h.tasks.cancel(taskId, { taskId, revision: cancelled.task.revision }, h.actor);
  assert.equal(again.task.progress.completed, 2);

  const removed = await h.tasks.remove(taskId, { taskId, revision: again.task.revision }, h.actor);
  assert.equal(removed.deleted, true);
  await assert.rejects(() => h.tasks.detail(taskId), (error: Error & { code?: string }) => error.code === "OBJECT_NOT_FOUND");
  // 删除任务不删除历史运行：运行记录仍可按原 runId 读取。
  for (const id of result.task.runIds) assert.equal(h.store.getRun(h.settings.projectDirectory, id)?.status, "completed");
});

test("任务：在途项存在时拒绝删除任务", async (t) => {
  const h = await taskHarness(t);
  const { taskId, created } = await draft(h, "在途任务", [h.item("第 1 张")]);
  const result = await h.tasks.confirm(taskId, { taskId, revision: created.task.revision }, h.actor);
  await assert.rejects(() => h.tasks.remove(taskId, { taskId, revision: result.task.revision }, h.actor), (error: Error & { code?: string }) => error.code === "TASK_ITEM_ACTIVE");
  await until(() => result.task.runIds.every(id => h.store.getRun(h.settings.projectDirectory, id)?.status === "completed"));
});

test("任务：草稿允许缺必填，确认前必须补齐且缺必填不冻结任务", async (t) => {
  const h = await taskHarness(t);
  // 显式 null 就是「还没填」：草稿允许先存进度，服务端的必填判定与服务端空值语义一致。
  const { taskId, created } = await draft(h, "缺必填草稿", [{ label: "第 1 张", sceneId: "demo", versionId: "version-a", inputValues: { flag: null } }, h.item("第 2 张")]);
  assert.equal(created.task.status, "draft");
  assert.equal(created.task.itemCount, 2);
  // 存草稿不补齐、不伪造必填值：表里填了什么就是什么（style 仍按发布版默认值合并）。
  assert.equal(created.task.items?.[0].inputValues?.flag, null);
  assert.equal(created.task.items?.[0].inputValues?.style, "已发布值");
  assert.deepEqual(h.store.listRuns(h.settings.projectDirectory).runs, []);

  // 确认前整体判一次必填：直接拒绝并指出哪一项，而不是先冻结再让这些项在 failures 里失败——
  // 冻结后输入不能再改、只能重跑，缺必填的项会永远提交不上去。
  await assert.rejects(
    () => h.tasks.confirm(taskId, { taskId, revision: created.task.revision }, h.actor),
    (error: Error & { code?: string }) => error.code === "TASK_ITEMS_INCOMPLETE" && /第 1 张/.test(error.message) && /必填字段：flag/.test(error.message),
  );
  const after = await h.tasks.detail(taskId);
  assert.equal(after.task.status, "draft");
  assert.equal(after.task.revision, created.task.revision, "缺必填时确认被拒绝，任务不能被冻结");
  assert.deepEqual(h.store.listRuns(h.settings.projectDirectory).runs, [], "缺必填时不能提交任何运行");

  // 补齐后先保存再确认：正常批量提交，两项都跑起来。
  const filled = await h.tasks.update(taskId, { taskId, revision: after.task.revision, items: [h.item("第 1 张"), h.item("第 2 张")] }, h.actor);
  const result = await h.tasks.confirm(taskId, { taskId, revision: filled.task.revision }, h.actor);
  assert.equal(result.submitted.length, 2);
  assert.equal(result.failures.length, 0);
  await until(() => result.task.runIds.every(id => h.store.getRun(h.settings.projectDirectory, id)?.status === "completed"));
});

test("任务：必填媒体没挑也能存草稿，确认时才拦（真实录入顺序：先占行、后补素材）", async (t) => {
  const h = await taskHarness(t);
  // 真实场景的商品主图就是必填、没有默认值的媒体输入：必须先挑素材才能执行。
  await h.workspace.mutateScoped(current => {
    const versions = current.sceneVersions as Record<string, { versions: Array<Record<string, unknown>> }>;
    const workflow = versions.demo.versions[0].workflow as { inputs: WorkflowInputField[] };
    workflow.inputs = [...workflow.inputs, { key: "product_images", type: "image_list", required: true, label: "商品主图" } as WorkflowInputField];
    return { workspace: current, result: {}, changed: true };
  });
  const { taskId, created } = await draft(h, "先占行后补图", [h.item("第 1 张")]);
  assert.equal(created.task.status, "draft");

  // 草稿可保存，但确认必须补齐素材：缺的是媒体时同样按项指出（必填错误按字段 key 说明，
  // 与服务端既有 REQUIRED_INPUT_MISSING 口径一致；任务页显示的是字段标签）。
  await assert.rejects(
    () => h.tasks.confirm(taskId, { taskId, revision: created.task.revision }, h.actor),
    (error: Error & { code?: string }) => error.code === "TASK_ITEMS_INCOMPLETE" && /product_images/.test(error.message),
  );
  assert.deepEqual(h.store.listRuns(h.settings.projectDirectory).runs, []);
  // 只判必填：填错的值（类型/选项/素材版本）在存草稿时就已经逐项拒绝，不会等到确认。
  await assert.rejects(() => h.tasks.update(taskId, { taskId, revision: created.task.revision, items: [h.item("第 1 张", { flag: "不是布尔" })] }, h.actor), /第 1 项/);
});

test("任务：无效参数被明确拒绝并指出第几项", async (t) => {
  const h = await taskHarness(t);
  await assert.rejects(() => h.tasks.create({ taskId: "not-a-uuid", name: "x", items: [h.item("a")] }, h.actor), /任务编号无效/);
  await assert.rejects(() => h.tasks.create({ taskId: h.newTaskId(), name: "  ", items: [h.item("a")] }, h.actor), /任务名称/);
  await assert.rejects(() => h.tasks.create({ taskId: h.newTaskId(), name: "x", items: [] }, h.actor), /至少需要一个任务项/);
  await assert.rejects(() => h.tasks.create({ taskId: h.newTaskId(), name: "x", items: [h.item("a"), { label: "b", sceneId: "", versionId: "version-a", inputValues: {} }] }, h.actor), /第 2 项缺少场景或发布版本/);
  await assert.rejects(() => h.tasks.create({ taskId: h.newTaskId(), name: "x", items: [h.item("a"), { label: "b", sceneId: "demo", versionId: "version-a", inputValues: { flag: "不是布尔" } }] }, h.actor), /第 2 项/);
  // 超过 200 项上限：明确拒绝，不静默截断。
  const many = Array.from({ length: 201 }, (_, index) => h.item("第 " + (index + 1) + " 张"));
  await assert.rejects(() => h.tasks.create({ taskId: h.newTaskId(), name: "太多", items: many }, h.actor), /最多 200 项/);
  // 同一 taskId 重复创建按原 ID 对账，不新建任务。
  const duplicate = h.newTaskId();
  await h.tasks.create({ taskId: duplicate, name: "首次", items: [h.item("a")] }, h.actor);
  await assert.rejects(() => h.tasks.create({ taskId: duplicate, name: "第二次", items: [h.item("b")] }, h.actor), (error: Error & { code?: string }) => error.code === "TASK_ALREADY_EXISTS");
});

test("任务：列表分页省略项与输入，游标绑定快照并在变化后失效", async (t) => {
  const h = await taskHarness(t);
  for (let index = 0; index < 5; index++) await draft(h, "任务 " + (index + 1), [h.item("第 1 张")]);
  const first = await h.tasks.list({ limit: 2 }, "tester");
  assert.equal(first.items.length, 2);
  assert.equal(first.total, 5);
  assert.equal(first.hasMore, true);
  // 列表省略 items 与 inputValues 并显式标记，不静默截断；详情才返回完整输入。
  assert.equal(first.items[0].itemsOmitted, true);
  assert.equal(first.items[0].items, undefined);
  const second = await h.tasks.list({ limit: 2, cursor: first.nextCursor }, "tester");
  assert.equal(second.items.length, 2);
  assert.notEqual(second.items[0].taskId, first.items[0].taskId);
  // 目录变化（新增任务）后旧游标必须失效，不拼接两个快照。
  await draft(h, "新任务", [h.item("第 1 张")]);
  await assert.rejects(() => h.tasks.list({ limit: 2, cursor: first.nextCursor }, "tester"), (error: Error & { code?: string }) => error.code === "ACCESS_PAGE_CHANGED");
  await assert.rejects(() => h.tasks.list({ limit: 0 }, "tester"), (error: Error & { code?: string }) => error.code === "INVALID_ACCESS_REQUEST");
  await assert.rejects(() => h.tasks.list({ limit: 201 }, "tester"), (error: Error & { code?: string }) => error.code === "INVALID_ACCESS_REQUEST");
});

test("任务：进度是运行状态的投影，不单独维护状态机", async (t) => {
  const h = await taskHarness(t);
  const { taskId, created } = await draft(h, "投影", [h.item("第 1 张")]);
  const record = h.store.getDocument<Parameters<typeof taskStatusOf>[0]>(h.settings.projectDirectory, "tasks", taskId)!;
  // 未确认 → draft；确认但运行仍排队 → running；全部完成 → completed。
  assert.equal(taskStatusOf(record, new Map()), "draft");
  assert.equal(created.task.status, "draft");
  const result = await h.tasks.confirm(taskId, { taskId, revision: created.task.revision }, h.actor);
  const runId = result.task.runIds[0];
  const queued = h.store.getDocument<Parameters<typeof taskStatusOf>[0]>(h.settings.projectDirectory, "tasks", taskId)!;
  assert.equal(taskStatusOf(queued, new Map([[runId, "queued"]])), "running");
  assert.equal(taskStatusOf(queued, new Map([[runId, "failed"]])), "failed");
  assert.equal(taskStatusOf(queued, new Map([[runId, "cancelled"]])), "failed", "只有取消任务本身才算 cancelled");
  await until(() => h.store.getRun(h.settings.projectDirectory, runId)?.status === "completed");
  assert.equal((await h.tasks.detail(taskId)).task.status, "completed");
});

test("任务：确认复用现有运行队列的并发上限与排队，不自己并发跑满", async (t) => {
  // 测试台固定 maxActiveRuns=1：5 项一次性确认后也必须逐条排队执行。
  const h = await taskHarness(t, { executor: { kind: "fake", async execute() { await new Promise(resolve => setTimeout(resolve, 80)); return { value: "ok" }; } } });
  const { taskId, created } = await draft(h, "并发", Array.from({ length: 5 }, (_, index) => h.item("第 " + (index + 1) + " 项")));
  const confirmed = await h.tasks.confirm(taskId, { taskId, revision: created.task.revision }, h.actor);
  assert.equal(confirmed.submitted.length, 5);
  const runIds = confirmed.task.runIds;
  assert.equal(runIds.length, 5);
  const statuses = () => runIds.map(id => h.store.getRun(h.settings.projectDirectory, id)?.status);
  // 任一时刻最多 1 条在跑：证明任务走的是同一条队列，而不是绕开上限自己并发提交。
  for (let tick = 0; tick < 6; tick++) {
    const active = statuses().filter(status => status === "running").length;
    assert.ok(active <= 1, "同时执行数 " + active + " 超过队列上限 1：" + JSON.stringify(statuses()));
    await new Promise(resolve => setTimeout(resolve, 40));
  }
  await until(() => statuses().every(status => status === "completed"));
  assert.deepEqual(statuses(), Array(5).fill("completed"));
});
