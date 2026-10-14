import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { taskHarness } from "../testing/taskSupport.js";
import { until } from "../testing/testSupport.js";
import type { ApiResult } from "./httpClient.js";

/** 真实 stdio MCP 客户端：经子进程走 HTTP 到隔离任务后台，验证工具确实端到端可用。 */
async function connect(t: Parameters<typeof taskHarness>[0], base: string, token: string) {
  // 任务路由受访问中间件保护：MCP 子进程必须拿到管理员凭证，否则只会得到 AUTH_REQUIRED。
  const transport = new StdioClientTransport({ command: process.execPath, args: ["--import", "tsx", path.resolve("server/mcp/index.ts")], cwd: process.cwd(), env: { ...Object.fromEntries(Object.entries(process.env).filter((item): item is [string, string] => typeof item[1] === "string")), ZANE_BASE_URL: base, ZANE_API_TOKEN: token }, stderr: "pipe" });
  let errors = ""; transport.stderr?.on("data", chunk => { errors += chunk; });
  const client = new Client({ name: "zane-task-mcp-test", version: "1.0.0" });
  t.after(async () => { await client.close(); });
  try { await client.connect(transport); } catch (error) { throw new Error(String(error) + "\n" + errors); }
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const result = await client.callTool({ name, arguments: args });
    assert.ok("content" in result);
    return { result, payload: result.structuredContent as ApiResult };
  };
  return { client, call };
}

test("真实stdio MCP：任务创建→确认批量提交→跟踪→单项重跑→取消→删除", async t => {
  const h = await taskHarness(t);
  const { client, call } = await connect(t, h.base, h.admin.token);
  const tools = await client.listTools();
  for (const name of ["list_tasks", "get_task", "create_task", "update_task", "confirm_task", "rerun_task_item", "cancel_task", "delete_task"]) {
    assert.ok(tools.tools.some(tool => tool.name === name), "缺少 MCP 工具 " + name);
  }
  // 只读工具必须声明只读，避免调用方误以为会提交运行。
  assert.equal(tools.tools.find(tool => tool.name === "list_tasks")?.annotations?.readOnlyHint, true);
  assert.equal(tools.tools.find(tool => tool.name === "get_task")?.annotations?.readOnlyHint, true);
  assert.equal(tools.tools.find(tool => tool.name === "confirm_task")?.annotations?.readOnlyHint, false);

  const taskId = randomUUID();
  const created = await call("create_task", { taskId, name: "批量出图", note: "项目 A", items: [{ label: "第 1 张", sceneId: "demo", versionId: "version-a", inputValues: { flag: true } }, { label: "第 2 张", sceneId: "demo2", versionId: "version-b", inputValues: { flag: false } }] });
  assert.equal(created.payload.ok, true);
  const draft = created.payload.data as { task: { status: string; revision: number; itemCount: number; itemsOmitted: boolean; items: Array<{ itemId: string; inputValues: Record<string, unknown> }> }; nextAction: string };
  assert.equal(draft.task.status, "draft");
  assert.equal(draft.task.itemCount, 2);
  // 创建只保存中间态：不提交任何运行，也不生成媒体。
  assert.equal(h.store.listRuns(h.settings.projectDirectory).runs.length, 0);
  assert.equal(draft.nextAction, "confirm_task");
  // 发布版默认值由服务端补齐，AI 不必猜。
  assert.equal(draft.task.items[0].inputValues.style, "已发布值");

  // 响应丢失后按同一 taskId 读取对账，而不是重新创建。
  const reread = await call("get_task", { taskId });
  assert.equal((reread.payload.data as { task: { revision: number } }).task.revision, draft.task.revision);
  assert.equal((await call("create_task", { taskId, name: "重复", items: [{ sceneId: "demo", versionId: "version-a", inputValues: { flag: true } }] })).payload.error?.code, "TASK_ALREADY_EXISTS");

  const edited = await call("update_task", { taskId, revision: draft.task.revision, name: "批量出图（已改）" });
  assert.equal(edited.payload.ok, true);
  const editedTask = (edited.payload.data as { task: { revision: number; name: string } }).task;
  assert.equal(editedTask.name, "批量出图（已改）");
  // 旧 revision 必须被拒绝，不能盲目覆盖。
  assert.equal((await call("update_task", { taskId, revision: draft.task.revision, name: "覆盖" })).payload.error?.code, "TASK_REVISION_CONFLICT");

  const confirmed = await call("confirm_task", { taskId, revision: editedTask.revision });
  assert.equal(confirmed.payload.ok, true);
  const confirmation = confirmed.payload.data as { task: { revision: number; runIds: string[]; items: Array<{ itemId: string; runId: string }> }; alreadyConfirmed: boolean; submitted: Array<{ itemId: string; runId: string }>; failures: unknown[]; nextAction: string };
  assert.equal(confirmation.alreadyConfirmed, false);
  assert.equal(confirmation.submitted.length, 2);
  assert.equal(confirmation.failures.length, 0);
  // 全部提交成功后下一步是跟踪进度；只有存在失败项时才指向单项重跑。
  assert.equal(confirmation.nextAction, "get_task");
  assert.equal(h.store.listRuns(h.settings.projectDirectory).runs.length, 2);

  // 纯重读：同一请求重放不重复提交、不重复计费，也不推进 revision。
  const replay = await call("confirm_task", { taskId, revision: editedTask.revision });
  assert.equal(replay.payload.ok, true);
  const replayed = replay.payload.data as { task: { revision: number }; alreadyConfirmed: boolean; submitted: unknown[] };
  assert.equal(replayed.alreadyConfirmed, true);
  assert.equal(replayed.submitted.length, 0);
  assert.equal(replayed.task.revision, confirmation.task.revision, "重放不应推进 revision");
  assert.equal(h.store.listRuns(h.settings.projectDirectory).runs.length, 2);

  const runIds = confirmation.task.runIds;
  await until(() => runIds.every(id => h.store.getRun(h.settings.projectDirectory, id)?.status === "completed"));
  const tracked = await call("get_task", { taskId });
  const done = tracked.payload.data as { task: { status: string; progress: Record<string, number>; items: Array<{ itemId: string; state: string; runId: string }> } };
  assert.equal(done.task.status, "completed");
  assert.deepEqual(done.task.progress, { total: 2, pending: 0, active: 0, waiting: 0, completed: 2, failed: 0, cancelled: 0 });

  const rerun = await call("rerun_task_item", { taskId, itemId: done.task.items[0].itemId, revision: (tracked.payload.data as { task: { revision: number } }).task.revision });
  assert.equal(rerun.payload.ok, true);
  const rerunTask = (rerun.payload.data as { task: { runIds: string[]; items: Array<{ itemId: string; attemptCount: number }> } }).task;
  assert.equal(rerunTask.runIds.length, 2, "重跑只替换该项的当前运行");
  await until(() => rerunTask.runIds.every(id => h.store.getRun(h.settings.projectDirectory, id)?.status === "completed"));

  // 列表分页省略 items 与 inputValues，避免一次拉回整批输入。
  const listed = await call("list_tasks", { limit: 10 });
  assert.equal(listed.payload.ok, true);
  const page = listed.payload.data as { total: number; items: Array<{ itemsOmitted: boolean; itemCount: number }>; hasMore: boolean };
  assert.equal(page.total, 1);
  assert.equal(page.items[0].itemsOmitted, true);
  assert.equal(page.items[0].itemCount, 2);

  const current = (await call("get_task", { taskId })).payload.data as { task: { revision: number } };
  const cancelled = await call("cancel_task", { taskId, revision: current.task.revision });
  assert.equal(cancelled.payload.ok, true);
  assert.ok((cancelled.payload.data as { task: { cancelledAt?: string } }).task.cancelledAt);

  const deleted = await call("delete_task", { taskId, revision: (cancelled.payload.data as { task: { revision: number } }).task.revision });
  assert.equal(deleted.payload.ok, true);
  assert.equal(deleted.payload.data && (deleted.payload.data as { deleted: boolean }).deleted, true);
  assert.equal((await call("get_task", { taskId })).payload.error?.status, 404);
  // 删除任务记录不删除历史运行：3 条（2 首次 + 1 重跑）都保留。
  assert.equal(h.store.listRuns(h.settings.projectDirectory).runs.length, 3);
});

test("真实stdio MCP：任务项校验失败明确报错，缺参数不产生任何运行", async t => {
  const h = await taskHarness(t);
  const { call } = await connect(t, h.base, h.admin.token);
  const taskId = randomUUID();
  const invalid = await call("create_task", { taskId, name: "批量出图", items: [{ label: "第 1 张", sceneId: "demo", versionId: "version-a", inputValues: { flag: true } }, { label: "第 2 张", sceneId: "demo", versionId: "version-a", inputValues: { flag: "不是布尔" } }] });
  assert.equal(invalid.result.isError, true);
  // 保留底层场景契约的错误码，同时把失败归属到具体项：调用方既知道原因也知道是哪一行。
  assert.equal(invalid.payload.error?.code, "INPUT_TYPE_MISMATCH");
  assert.match(String(invalid.payload.error?.message), /第 2 项（第 2 张）/);
  // 校验失败不落库、不提交运行。
  assert.equal(h.store.listRuns(h.settings.projectDirectory).runs.length, 0);
  assert.equal((await call("get_task", { taskId })).payload.error?.status, 404);

  // 缺必填参数由 MCP 输入 schema 直接拒绝：这是协议层错误，没有结构化回执。
  const missing = await call("confirm_task", { taskId: randomUUID() });
  assert.equal(missing.result.isError, true);
  assert.equal(missing.payload, undefined);
  assert.match(JSON.stringify(missing.result.content), /revision/);
  // 形状合法但不存在的任务走业务层，返回明确错误码而不是 500。
  const absent = await call("confirm_task", { taskId: randomUUID(), revision: 1 });
  assert.equal(absent.result.isError, true);
  assert.equal(absent.payload.error?.code, "OBJECT_NOT_FOUND");
  assert.equal((await call("list_tasks")).payload.ok, true);
});
