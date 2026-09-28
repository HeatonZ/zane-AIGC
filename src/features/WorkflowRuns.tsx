import { Clock3, FolderOpen, LoaderCircle, RefreshCw, Workflow } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { getScene } from "../data/scenes";
import { loadWorkflowRun, loadWorkflowRuns } from "../lib/api";
import WorkflowRunPanel from "../components/WorkflowRunPanel";
import type { PageId, WorkflowRunHistoryItem, WorkflowRunRecord } from "../types";

const statusLabels: Record<WorkflowRunHistoryItem["status"], string> = {
  running: "运行中",
  completed: "已完成",
  failed: "失败",
  cancelled: "已取消",
};

function formatDate(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "时间未知" : new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).format(date);
}

function formatDuration(value?: number) {
  if (value === undefined) return "执行中";
  if (value < 1000) return `${value} 毫秒`;
  return `${(value / 1000).toFixed(1)} 秒`;
}

export default function WorkflowRuns({ onNavigate }: { onNavigate: (page: PageId) => void }) {
  const [projectDirectory, setProjectDirectory] = useState("");
  const [runs, setRuns] = useState<WorkflowRunHistoryItem[]>([]);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [selectedRun, setSelectedRun] = useState<WorkflowRunRecord | null>(null);
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [error, setError] = useState("");

  const refresh = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const response = await loadWorkflowRuns();
      setProjectDirectory(response.projectDirectory);
      setRuns(response.runs);
      setSelectedRunId((current) => current && response.runs.some((run) => run.runId === current) ? current : response.runs[0]?.runId ?? null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "读取运行记录失败");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  useEffect(() => {
    if (!selectedRunId) {
      setSelectedRun(null);
      return;
    }
    let current = true;
    setDetailLoading(true);
    loadWorkflowRun(selectedRunId)
      .then((run) => { if (current) setSelectedRun(run); })
      .catch((reason: unknown) => {
        if (!current) return;
        setSelectedRun(null);
        setError(reason instanceof Error ? reason.message : "读取运行详情失败");
      })
      .finally(() => { if (current) setDetailLoading(false); });
    return () => { current = false; };
  }, [selectedRunId]);

  return (
    <div className="workflow-runs-page">
      <div className="welcome-row">
        <div><div className="eyebrow"><span className="eyebrow-line" />PROJECT RUNS</div><h1>运行记录</h1><p className="page-subtitle">查看每次运行的输入、执行状态和生成结果。</p></div>
        <button className="button button-outline" onClick={() => void refresh()} disabled={loading}><RefreshCw className={loading ? "spin" : ""} size={15} />刷新记录</button>
      </div>

      {projectDirectory && <div className="runs-project-path"><FolderOpen size={15} /><span><strong>项目目录</strong><code>{projectDirectory}</code></span></div>}
      {error && <div className="notice error-notice" role="alert">{error}</div>}

      {!projectDirectory && !loading ? (
        <div className="history-empty"><span className="history-empty-mark"><FolderOpen size={22} /></span><h2>还没有配置项目目录</h2><p>先设置目录，之后每次运行都会在这里留下输入、状态和输出记录。</p><button className="button button-dark" onClick={() => onNavigate("connections")}>配置项目目录 <FolderOpen size={15} /></button></div>
      ) : loading ? (
        <div className="runs-loading"><LoaderCircle className="spin" size={18} />正在读取运行记录</div>
      ) : runs.length === 0 ? (
        <div className="history-empty"><span className="history-empty-mark"><Workflow size={22} /></span><h2>项目目录中还没有运行记录</h2><p>完成一次流程运行后，输入和输出会归档到 <code>.zane/runs</code>。</p><button className="button button-dark" onClick={() => onNavigate("home")}>开始运行 <Workflow size={15} /></button></div>
      ) : (
        <div className="runs-layout">
          <section className="runs-list" aria-label="运行记录列表">
            <div className="runs-list-heading"><strong>最近运行</strong><span>{runs.length}</span></div>
            {runs.map((run) => {
              const scene = getScene(run.sceneId);
              return <button className={`run-history-item ${selectedRunId === run.runId ? "active" : ""}`} key={run.runId} onClick={() => setSelectedRunId(run.runId)}>
                <span className={`run-history-mark ${scene.accent}`}><Workflow size={16} /></span>
                <span className="run-history-copy"><span className="run-history-title"><strong>{run.workflowName}</strong><i className={`run-status-dot ${run.status}`} /></span><small>{scene.shortTitle} · {formatDate(run.startedAt)}</small><small>{run.stepCount} 步 · {run.outputCount} 项输出 · {formatDuration(run.durationMs)}</small></span>
                <span className={`run-status-label ${run.status}`}>{statusLabels[run.status]}</span>
              </button>;
            })}
          </section>

          <section className="run-detail" aria-label="运行详情">
            {detailLoading ? <div className="runs-loading"><LoaderCircle className="spin" size={17} />读取运行详情</div> : selectedRun ? <>
              <div className="run-detail-heading"><div><span className="eyebrow"><span className="eyebrow-line" />{getScene(selectedRun.sceneId).shortTitle.toUpperCase()}</span><h2>{selectedRun.workflowName}</h2><p><Clock3 size={13} />{formatDate(selectedRun.startedAt ?? "")} · {formatDuration(selectedRun.durationMs)}</p></div><span className={`run-status-label ${selectedRun.status}`}>{statusLabels[selectedRun.status]}</span></div>
              <WorkflowRunPanel result={selectedRun} inputValues={selectedRun.inputValues} />
            </> : <div className="run-detail-empty">选择一条记录查看详情。</div>}
          </section>
        </div>
      )}
    </div>
  );
}
