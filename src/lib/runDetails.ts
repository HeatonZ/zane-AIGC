import type { OwnRun } from "./accessApi";
import type { ResultContext, ResultPage } from "./userPortal";
import type { WorkflowRunHistoryItem, WorkflowRunRecord } from "../types";

export const runStatusLabels: Record<string, string> = {
  queued: "排队中", running: "运行中", cancelling: "取消中", waiting: "待确认",
  completed: "已完成", failed: "执行失败", cancelled: "已取消", stale: "等待恢复", pending: "未执行", skipped: "已跳过",
};
export const runStatusDescriptions: Record<string, string> = {
  queued: "任务已保存，等待执行。关闭页面不会丢失任务。",
  running: "任务正在执行，状态自动同步。可以先查看已完成步骤的结果。",
  cancelling: "正在停止并保存当前进度，请等待收尾；已发出的外部请求可能仍有费用。",
  waiting: "流程暂停，等待你确认当前结果。确认后才会继续执行。",
  completed: "所有流程已结束，可以查看、复制或下载结果。",
  failed: "任务执行中断。已完成步骤的结果仍可查看，核对后可按原快照续跑。",
  cancelled: "任务已停止，已有结果保留。需要继续时可按原快照续跑。",
  stale: "服务中断留下了未结束的任务，请先核对已有结果再恢复。",
};
export function runDate(value?: string): string {
  if (!value || !Number.isFinite(Date.parse(value))) return "未记录";
  return new Date(value).toLocaleString("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
}
export function runDuration(ms?: number): string {
  if (ms === undefined || !Number.isFinite(ms) || ms < 0) return "未记录";
  if (ms < 1000) return "不足 1 秒";
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds} 秒`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`;
  return `${Math.floor(seconds / 3600)} 时 ${Math.floor(seconds % 3600 / 60)} 分`;
}
export function elapsedRun(run: {createdAt?: string; finishedAt?: string; totalDurationMs?: number; status?: string}, now: number): number | undefined {
  if (run.totalDurationMs !== undefined) return run.totalDurationMs;
  if (!run.finishedAt && !["queued", "running", "cancelling", "waiting"].includes(run.status ?? "")) return undefined;
  const start = Date.parse(run.createdAt ?? "");
  const end = run.finishedAt ? Date.parse(run.finishedAt) : now;
  return Number.isFinite(start) && Number.isFinite(end) ? Math.max(0, end - start) : undefined;
}
export function progressPercent(progress: OwnRun["progress"]): number {
  return progress.total ? Math.min(100, Math.max(0, progress.settled / progress.total * 100)) : 0;
}
/** A field's next slice must not erase other outputs, aggregate fields or foreach
 * items. Top-level directory cursors still belong to the original list query. */
export function mergeResultSlice(previous: ResultPage, next: ResultPage, context: ResultContext): ResultPage {
  if (previous.revision && next.revision && previous.revision !== next.revision) throw new Error("结果已变化，请刷新本页再读取分段。");
  const replace = (old: NonNullable<ResultPage["outputs"]>, values: NonNullable<ResultPage["outputs"]>) => old.map(output => values.find(value => value.key === output.key) ?? output);
  if (context.itemIndex !== undefined) return {
    ...previous, items: previous.items?.map(item => item.index === context.itemIndex
      ? { ...item, outputs: replace(item.outputs, next.items?.find(value => value.index === item.index)?.outputs ?? []) } : item),
  };
  return { ...previous, outputs: replace(previous.outputs ?? [], next.outputs ?? []) };
}
const eventNames: Record<string, string> = {
  "run.queued": "任务进入队列", "run.recovered_queued": "队列任务已恢复", "run.started": "开始执行",
  "run.completed": "任务完成", "run.failed": "任务执行失败", "run.cancelled": "任务已取消", "run.cancelling": "请求停止执行",
  "run.stale": "执行中断，等待恢复", "run.waiting": "等待业务确认", "review.approve": "已确认，继续执行", "review.redo": "已退回，重新执行",
  "step.started": "开始步骤", "step.completed": "步骤完成", "step.failed": "步骤失败", "step.skipped": "跳过步骤", "step.cancelled": "步骤已取消",
  "step.item.started": "开始逐项执行", "step.item.completed": "逐项完成", "step.item.failed": "逐项失败", "step.item.skipped": "逐项跳过", "step.item.cancelled": "逐项已取消",
};
export const activityLabel = (type: string): string => eventNames[type] ?? type;

export function previousValueOffset(page: {offset?: number; pageSize?: number}, fallbackSize: number): number {
  return Math.max(0, (page.offset ?? 0) - (page.pageSize ?? fallbackSize));
}

/** Keep authoritative ownership and creation metadata when a detail/SSE update
 * refreshes the administrator's list; a read must not turn an owned run into legacy history. */
export function runHistorySummary(run: WorkflowRunRecord & {createdAt?: string}): WorkflowRunHistoryItem {
  return {
    ownerUserId: run.ownerUserId, submitter: run.submitter, createdAt: run.createdAt,
    runId: run.runId, sceneId: run.sceneId, workflowName: run.workflowName, runTitle: run.runTitle,
    status: run.status, startedAt: run.startedAt ?? "", finishedAt: run.finishedAt, durationMs: run.durationMs,
    stepCount: run.steps.length, outputCount: run.outputs.length, error: run.error, artifacts: run.artifacts!,
  };
}
