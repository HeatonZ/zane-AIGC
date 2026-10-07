import * as z from "zod/v4";

export const minimumTaskConcurrency = 1;
export const maximumTaskConcurrency = 32;
export const taskConcurrencyLimit = z.int().min(minimumTaskConcurrency).max(maximumTaskConcurrency);
export const taskConcurrencyQuery = z.object({}).strict();
export const updateTaskConcurrency = z.object({
  revision: z.int().nonnegative().describe("读取配置的当前 revision，未保存时为 0；409 或响应丢失后先重新读取，不自动重放"),
  maxActiveRuns: taskConcurrencyLimit.describe("全系统同时执行的流程任务上限（1–32）；不控制 for_each 或 ComfyUI 的内部并发"),
}).strict();
export const taskConcurrencySettingsSchema = z.object({
  format: z.literal("zane-studio.task-concurrency/v1"),
  id: z.literal("task-concurrency"),
  revision: z.int().nonnegative(),
  maxActiveRuns: taskConcurrencyLimit,
  defaultMaxActiveRuns: taskConcurrencyLimit,
  source: z.enum(["environment", "saved"]),
  scope: z.literal("system"),
  applyPolicy: z.literal("immediate_without_interrupting_active_runs"),
  worker: z.object({ active: z.int().nonnegative(), queued: z.int().nonnegative(), preparing: z.int().nonnegative() }).strict(),
  nextAction: z.literal("update_with_revision"),
}).strict();
export type TaskConcurrencySettings = z.infer<typeof taskConcurrencySettingsSchema>;
