import { useEffect, useState, type ReactNode } from "react";
import { Check, Clock3, Copy, Layers3, PackageCheck } from "lucide-react";
import type { OwnRun } from "../lib/accessApi";
import { elapsedRun, progressPercent, runDate, runDuration, runStatusDescriptions, runStatusLabels } from "../lib/runDetails";

export function RunMetrics({ progress, outputCount, expectedOutputCount, createdAt, finishedAt, totalDurationMs, status }: {
  progress: OwnRun["progress"]; outputCount: number; expectedOutputCount: number;
  createdAt?: string; finishedAt?: string; totalDurationMs?: number; status?: string;
}) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (finishedAt || !createdAt || !["queued", "running", "cancelling", "waiting"].includes(status ?? "")) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [createdAt, finishedAt, status]);
  return <div className="run-metrics">
    <article><span><Layers3 size={15} />步骤进度</span><strong>{progress.settled}<small> / {progress.total}</small></strong>
      <div className="run-progress-track" role="progressbar" aria-label="已结束步骤比例，不代表预计完成时间" aria-valuemin={0} aria-valuemax={progress.total || 1} aria-valuenow={progress.settled}><i style={{ width: progressPercent(progress) + "%" }} /></div>
      <p>{progress.completed} 完成 · {progress.skipped} 跳过{progress.failed ? ` · ${progress.failed} 失败` : ""}{progress.cancelled ? ` · ${progress.cancelled} 取消` : ""}</p></article>
    <article><span><PackageCheck size={15} />最终产物</span><strong>{outputCount}<small> / {expectedOutputCount} 个字段</small></strong><p>中间结果在对应步骤查看</p></article>
    <article><span><Clock3 size={15} />总历时</span><strong className="run-duration">{runDuration(elapsedRun({ createdAt, finishedAt, totalDurationMs, status }, now))}</strong><p>从创建计时 · 包含排队和确认等待</p></article>
  </div>;
}

export default function RunOverview({ run, actions }: { run: OwnRun; actions?: ReactNode }) {
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState("");
  async function copyId() {
    try { await navigator.clipboard.writeText(run.runId); setCopied(true); setCopyError(""); }
    catch { setCopyError("无法自动复制，请选中任务 ID 手动复制。"); }
  }
  return <header className="business-run-overview">
    <div className="business-run-title"><div><span className="run-eyebrow">RUN DETAIL · 运行详情</span><h2>{run.runTitle || run.workflowName || run.sceneId}</h2>
      <p>{run.workflowName}{run.version ? ` · 发布版 ${run.version}` : " · 历史快照"}</p></div>
      <span className={`business-status ${run.status}`} aria-live="polite"><i />{runStatusLabels[run.status] ?? run.status}</span></div>
    <p className="run-state-description">{runStatusDescriptions[run.status]}</p>
    <RunMetrics progress={run.progress} outputCount={run.outputCount} expectedOutputCount={run.expectedOutputCount} createdAt={run.createdAt} finishedAt={run.finishedAt} totalDurationMs={run.totalDurationMs} status={run.status} />
    <div className="run-metadata"><span>创建 <b>{runDate(run.createdAt)}</b></span><span>开始 <b>{run.startedAt ? runDate(run.startedAt) : run.status === "queued" ? "尚未开始" : "历史未记录"}</b></span>
      <span>结束 <b>{run.finishedAt ? runDate(run.finishedAt) : "尚未结束"}</b></span>{run.queueDurationMs !== undefined && <span>排队 <b>{runDuration(run.queueDurationMs)}</b></span>}</div>
    <div className="run-id-row"><code title={run.runId}>{run.runId}</code><button type="button" className="run-icon-button" onClick={() => void copyId()} aria-label="复制完整任务 ID">{copied ? <Check size={14} /> : <Copy size={14} />}{copied ? "已复制" : "复制 ID"}</button>
      <span>快照固定 · {run.reviewCount} 次确认</span></div>{copyError && <p className="access-error">{copyError}</p>}
    {actions && <div className="run-detail-actions">{actions}</div>}
  </header>;
}
