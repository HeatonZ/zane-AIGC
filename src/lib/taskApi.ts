import { accessApi, AccessApiError, type AccessPage } from "./accessApi";
import {
  taskEnvelopeSchema, taskPageSchema, taskConfirmationSchema, taskMutationSchema, taskDeletionSchema,
  type TaskView,
} from "../../server/domain/taskContracts";
import type { JsonValue } from "../types";

/** 任务回执解析：契约不符时明确失败，绝不把不完整回执当成成功。 */
function invalid(): never { throw new AccessApiError("任务回执格式无法确认，请按原 taskId 读取对账，不要重复提交。", 0, "RESPONSE_UNKNOWN"); }

export type Task = TaskView;
export interface TaskItemInput { label?: string; sceneId: string; versionId: string; inputValues: Record<string, JsonValue> }

export async function listTasks(query: { limit?: number; cursor?: string } = {}, signal?: AbortSignal): Promise<AccessPage<Task>> {
  const params = new URLSearchParams(Object.entries(query).filter(([, value]) => value !== undefined).map(([key, value]) => [key, String(value)]));
  const parsed = taskPageSchema.safeParse(await accessApi<unknown>("/api/v1/tasks?" + params, { signal, cache: "no-store" }));
  if (!parsed.success) invalid();
  return { items: parsed.data.items as Task[], total: parsed.data.total, hasMore: parsed.data.hasMore, nextCursor: parsed.data.nextCursor, revision: parsed.data.revision };
}
export async function getTask(taskId: string, signal?: AbortSignal): Promise<Task> {
  const parsed = taskEnvelopeSchema.safeParse(await accessApi<unknown>("/api/v1/tasks/" + encodeURIComponent(taskId), { signal, cache: "no-store" }));
  if (!parsed.success) invalid();
  return parsed.data.task as Task;
}
export async function createTask(body: { taskId: string; name: string; note?: string; items: TaskItemInput[] }): Promise<Task> {
  const parsed = taskEnvelopeSchema.safeParse(await accessApi<unknown>("/api/v1/tasks", { method: "POST", body: JSON.stringify(body) }));
  if (!parsed.success) invalid();
  return parsed.data.task as Task;
}
export async function updateTask(taskId: string, body: { revision: number; name?: string; note?: string; items?: TaskItemInput[] }): Promise<Task> {
  const parsed = taskEnvelopeSchema.safeParse(await accessApi<unknown>("/api/v1/tasks/" + encodeURIComponent(taskId), { method: "PATCH", body: JSON.stringify(body) }));
  if (!parsed.success) invalid();
  return parsed.data.task as Task;
}
/** 确认即批量提交：响应丢失时用同一 taskId 重新确认即可对账，不要换 ID。 */
export async function confirmTask(taskId: string, revision: number) {
  const parsed = taskConfirmationSchema.safeParse(await accessApi<unknown>("/api/v1/tasks/" + encodeURIComponent(taskId) + "/confirm", { method: "POST", body: JSON.stringify({ revision }) }));
  if (!parsed.success) invalid();
  return { task: parsed.data.task as Task, alreadyConfirmed: parsed.data.alreadyConfirmed, submitted: parsed.data.submitted, failures: parsed.data.failures };
}
export async function rerunTaskItem(taskId: string, itemId: string, revision: number): Promise<Task> {
  const parsed = taskMutationSchema.safeParse(await accessApi<unknown>("/api/v1/tasks/" + encodeURIComponent(taskId) + "/items/" + encodeURIComponent(itemId) + "/rerun", { method: "POST", body: JSON.stringify({ revision }) }));
  if (!parsed.success) invalid();
  return parsed.data.task as Task;
}
export async function cancelTask(taskId: string, revision: number): Promise<Task> {
  const parsed = taskMutationSchema.safeParse(await accessApi<unknown>("/api/v1/tasks/" + encodeURIComponent(taskId) + "/cancel", { method: "POST", body: JSON.stringify({ revision }) }));
  if (!parsed.success) invalid();
  return parsed.data.task as Task;
}
export async function deleteTask(taskId: string, revision: number) {
  const parsed = taskDeletionSchema.safeParse(await accessApi<unknown>("/api/v1/tasks/" + encodeURIComponent(taskId), { method: "DELETE", body: JSON.stringify({ revision }) }));
  if (!parsed.success) invalid();
  return parsed.data;
}

export const taskStatusLabels: Record<Task["status"], string> = {
  draft: "待确认", running: "执行中", waiting: "等待确认", cancelling: "正在取消",
  completed: "已完成", completed_with_errors: "部分完成", failed: "失败", cancelled: "已取消",
};
export const taskItemStateLabels: Record<string, string> = {
  pending: "待提交", queued: "排队中", running: "执行中", cancelling: "正在取消", waiting: "等待确认",
  completed: "已完成", failed: "失败", cancelled: "已取消", stale: "已中断",
};
/** 未结束的项：决定任务页是否继续轮询，以及能否删除任务。 */
export function isActiveTask(status: Task["status"]) { return ["running", "waiting", "cancelling"].includes(status); }

/**
 * 任务项输入此时是否可编辑。只有确认前（draft）能改：confirmedAt 一旦落库输入即冻结，
 * 服务端也会拒绝 UPDATE（TASK_ALREADY_CONFIRMED），页面对应渲染只读跟踪表。
 */
export function isEditableTask(task: Pick<Task, "status" | "confirmedAt"> | undefined) {
  // 以 confirmedAt 为准：它才是单向冻结的标记；status==="draft" 只是它的投影。
  return !task || !task.confirmedAt;
}
