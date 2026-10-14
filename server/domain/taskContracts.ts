import * as z from "zod/v4";
import type { JsonValue, RunStatus, RunSubmitter } from "./types.js";

/**
 * 任务（Task）：一个可复用的批量执行容器。
 * 任务项各自固定「已发布场景 + versionId + 输入」，确认后一次性提交为互相独立的运行，
 * 复用现有运行队列的并发与恢复机制——不新建调度器，也不新建旁路任务数据库。
 */
export const TASK_ITEM_LIMIT = 200;
export const TASK_NOTE_MAX_LENGTH = 2000;
export const TASK_NAME_MAX_LENGTH = 160;
export const TASK_ITEM_LABEL_MAX_LENGTH = 120;
export const TASK_DOCUMENT_MAX_BYTES = 4 * 1024 * 1024;

/** 任务项状态：pending 表示尚未提交（没有运行记录，或运行记录尚未落库）。 */
export type TaskItemState = "pending" | RunStatus;
export type TaskStatus = "draft" | "running" | "waiting" | "cancelling" | "completed" | "completed_with_errors" | "failed" | "cancelled";

export const TASK_ITEM_STATES = ["pending", "queued", "running", "cancelling", "waiting", "completed", "failed", "cancelled", "stale"] as const;
export const TASK_STATUSES = ["draft", "running", "waiting", "cancelling", "completed", "completed_with_errors", "failed", "cancelled"] as const;
const ACTIVE_ITEM_STATES: TaskItemState[] = ["queued", "running", "cancelling"];

export interface TaskItem {
  itemId: string;
  label: string;
  sceneId: string;
  versionId: string;
  inputValues: Record<string, JsonValue>;
  runId?: string;
  /** 历史运行记录：重跑只追加，不覆盖，便于回溯这一项实际生成过什么。 */
  previousRunIds?: string[];
  lastError?: string;
  submittedAt?: string;
}
export interface TaskRecord {
  id: string;
  revision: number;
  name: string;
  note?: string;
  ownerUserId?: string;
  submitter?: RunSubmitter;
  createdAt: string;
  updatedAt: string;
  /** 确认时刻。确认后任务项冻结，只能整体取消或单项重跑，不能再改输入。 */
  confirmedAt?: string;
  cancelledAt?: string;
  items: TaskItem[];
}
export interface TaskProgress { total: number; pending: number; active: number; waiting: number; completed: number; failed: number; cancelled: number }
/** 任务项视图：列表省略 inputValues 并显式标记，详情才返回完整输入。 */
export interface TaskItemView {
  itemId: string; label: string; sceneId: string; versionId: string; state: TaskItemState;
  runId?: string; reviewId?: string; attemptCount: number; lastError?: string; submittedAt?: string;
  inputValues?: Record<string, JsonValue>; inputValuesOmitted: boolean;
}
export interface TaskView {
  taskId: string; revision: number; name: string; note?: string; status: TaskStatus; progress: TaskProgress;
  createdAt: string; updatedAt: string; confirmedAt?: string; cancelledAt?: string;
  itemCount: number; runIds: string[]; sceneIds: string[];
  items?: TaskItemView[]; itemsOmitted: boolean;
}

/** 单项状态：有运行记录就用运行状态，否则按是否已取消判定。
 *  没有运行记录但留有 lastError，说明这一项提交失败过——它是终端的 failed，
 *  不能混同为“尚未提交的 pending”，否则整批跑完后任务会永远停在 running。 */
export function taskItemState(record: TaskRecord, item: TaskItem, states: Map<string, RunStatus>): TaskItemState {
  const state = item.runId ? states.get(item.runId) : undefined;
  if (state) return state;
  if (item.lastError) return "failed";
  return record.cancelledAt ? "cancelled" : "pending";
}
export function taskProgress(record: TaskRecord, states: Map<string, RunStatus>): TaskProgress {
  const counts: TaskProgress = { total: record.items.length, pending: 0, active: 0, waiting: 0, completed: 0, failed: 0, cancelled: 0 };
  for (const item of record.items) {
    const state = taskItemState(record, item, states);
    if (state === "pending") counts.pending += 1;
    else if (ACTIVE_ITEM_STATES.includes(state)) counts.active += 1;
    else if (state === "waiting") counts.waiting += 1;
    else if (state === "completed") counts.completed += 1;
    else if (state === "cancelled") counts.cancelled += 1;
    else counts.failed += 1;
  }
  return counts;
}
/** 任务状态完全由任务项的运行状态投影得出，不单独维护状态机，避免与运行记录不一致。 */
export function taskStatusOf(record: TaskRecord, states: Map<string, RunStatus>): TaskStatus {
  if (!record.confirmedAt) return "draft";
  const counts = taskProgress(record, states);
  if (record.cancelledAt) return counts.active || counts.pending ? "cancelling" : "cancelled";
  if (counts.active || counts.pending) return "running";
  if (counts.waiting) return "waiting";
  if (counts.completed === counts.total) return "completed";
  if (counts.completed) return "completed_with_errors";
  return "failed";
}

const values = z.record(z.string(), z.json());
const taskId = z.string().regex(/^[a-f0-9-]{36}$/i).describe("客户端事先生成并保存的 UUID；响应丢失时用 get_task 读取这个 ID 对账，不换 ID 重建");
const revision = z.int().positive().describe("先读取任务取得当前 revision；409 后重新读取，不能盲重试写入");
const itemId = z.string().min(1).max(200);

export const taskItemRequest = z.object({
  label: z.string().trim().max(TASK_ITEM_LABEL_MAX_LENGTH).optional().describe("这一项的显示名（例如「第 3 张」）；省略时按序号自动生成"),
  sceneId: z.string().min(1).max(200).describe("已发布场景 ID；每一项可以不同，因此一个任务可以跨场景"),
  versionId: z.string().min(1).max(200).describe("固定发布版本 ID（get_scene 返回的 versionId）。不跟随之后的新发布，也不接受草稿"),
  inputValues: values.describe("该场景发布版输入契约的完整输入；媒体用本人/已授权素材的 assetId+assetVersion 固定引用"),
}).strict();
export const createTaskRequest = z.object({
  taskId,
  name: z.string().trim().min(1).max(TASK_NAME_MAX_LENGTH),
  note: z.string().max(TASK_NOTE_MAX_LENGTH).optional(),
  items: z.array(taskItemRequest).min(1).max(TASK_ITEM_LIMIT).describe("任务项；最多 " + TASK_ITEM_LIMIT + " 项。每一项独立指定场景、发布版本与输入"),
}).strict();
export const updateTaskRequest = z.object({
  taskId: z.string().min(1).max(200),
  revision,
  name: z.string().trim().min(1).max(TASK_NAME_MAX_LENGTH).optional(),
  note: z.string().max(TASK_NOTE_MAX_LENGTH).optional(),
  items: z.array(taskItemRequest).min(1).max(TASK_ITEM_LIMIT).optional().describe("完整替换任务项，只在确认前的中间态允许；确认后任务项冻结，只能单项重跑"),
}).strict();
export const confirmTaskRequest = z.object({ taskId: z.string().min(1).max(200), revision }).strict();
export const cancelTaskRequest = z.object({ taskId: z.string().min(1).max(200), revision }).strict();
export const rerunTaskItemRequest = z.object({ taskId: z.string().min(1).max(200), revision, itemId }).strict();
export const deleteTaskRequest = z.object({ taskId: z.string().min(1).max(200), revision }).strict();
export const taskQuery = z.object({
  // HTTP 查询串只给出字符串，MCP 给出数字：与既有查询 schema 一致用 coerce，两处共用同一契约。
  limit: z.coerce.number().int().min(1).max(100).default(50).describe("单页任务数量；默认50，最大100"),
  cursor: z.string().min(1).max(4096).optional().describe("上页 nextCursor；任务目录变化时返回 409 ACCESS_PAGE_CHANGED，需重读第一页"),
}).strict();

export type CreateTaskRequest = z.output<typeof createTaskRequest>;
export type UpdateTaskRequest = z.output<typeof updateTaskRequest>;
export type ConfirmTaskRequest = z.output<typeof confirmTaskRequest>;
export type RerunTaskItemRequest = z.output<typeof rerunTaskItemRequest>;

/** 任务项视图：列表省略 inputValues 并显式标记，详情才返回完整输入。 */
export const taskItemViewSchema = z.object({
  itemId: z.string(), label: z.string(), sceneId: z.string(), versionId: z.string(),
  state: z.enum(TASK_ITEM_STATES), runId: z.string().optional(), reviewId: z.string().optional(),
  attemptCount: z.int().nonnegative(), lastError: z.string().optional(), submittedAt: z.string().optional(),
  inputValues: values.optional(), inputValuesOmitted: z.boolean().optional(),
}).strict();
export const taskViewSchema = z.object({
  taskId: z.string(), revision: z.int().positive(), name: z.string(), note: z.string().optional(),
  status: z.enum(TASK_STATUSES), progress: z.object({ total: z.int().nonnegative(), pending: z.int().nonnegative(), active: z.int().nonnegative(), waiting: z.int().nonnegative(), completed: z.int().nonnegative(), failed: z.int().nonnegative(), cancelled: z.int().nonnegative() }).strict(),
  createdAt: z.string(), updatedAt: z.string(), confirmedAt: z.string().optional(), cancelledAt: z.string().optional(),
  itemCount: z.int().nonnegative(), runIds: z.array(z.string()), sceneIds: z.array(z.string()),
  items: z.array(taskItemViewSchema).optional(), itemsOmitted: z.boolean().optional(),
}).strict();
export const taskEnvelopeSchema = z.object({ task: taskViewSchema, nextAction: z.string() }).strict();
export const taskPageSchema = z.object({ items: z.array(taskViewSchema), revision: z.string().describe("任务目录快照摘要；分页游标绑定该值"), total: z.int().nonnegative(), hasMore: z.boolean(), nextCursor: z.string().optional(), nextAction: z.string() }).strict();
export const taskConfirmationSchema = z.object({
  task: taskViewSchema,
  alreadyConfirmed: z.boolean().describe("true 表示这次调用没有重复提交，只是读取了既有确认结果"),
  submitted: z.array(z.object({ itemId: z.string(), runId: z.string() }).strict()).describe("本次调用真正新提交的项；响应丢失后重试时已有运行被复用，因此为 0"),
  failures: z.array(z.object({ itemId: z.string(), message: z.string() }).strict()).describe("提交失败的项；其余项继续执行，失败项可单独重跑"),
  nextAction: z.string(),
}).strict();
export const taskMutationSchema = z.object({ task: taskViewSchema, nextAction: z.string() }).strict();
export const taskDeletionSchema = z.object({ taskId: z.string(), deleted: z.boolean(), nextAction: z.string() }).strict();
