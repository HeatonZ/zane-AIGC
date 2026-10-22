import { Clock3, FolderOpen, LoaderCircle, RefreshCw, Search, Workflow, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { getScene } from "../data/scenes";
import { loadWorkflowRuns, loadWorkflowRun, subscribeWorkflowRun } from "../lib/api";
import RerunDialog, { type RerunTarget } from "../components/RerunDialog";
import RunComparisonDialog from "../components/RunComparisonDialog";
import type { RerunRequest } from "../../server/domain/rerunContracts.js";
import WorkflowRunPanel from "../components/WorkflowRunPanel";
import { runHistorySummary } from "../lib/runDetails";
import type { PageId, SceneModule, WorkflowRunHistoryItem, WorkflowRunRecord, WorkflowRunSubmitter } from "../types";

const statusLabels: Record<WorkflowRunHistoryItem["status"], string> = {
  waiting: "待确认",
  queued: "排队中",
  running: "运行中",
  cancelling: "取消中",
  stale: "待恢复",
  completed: "已完成",
  failed: "失败",
  cancelled: "已取消",
};

export function getRunDisplayTitle(sceneTitle: string, runTitle?: string | null) {
  return runTitle?.trim() || sceneTitle;
}

export function formatRunSubmitter(submitter?: WorkflowRunSubmitter) {
  const username = submitter?.username.trim();
  if (!username) return "用户名未记录";
  const displayName = submitter?.displayName.trim();
  return displayName && displayName !== username ? `${displayName}（${username}）` : username;
}

function formatDate(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "时间未知" : new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).format(date);
}

function formatDuration(value?: number) {
  if (value === undefined) return "执行中";
  if (value < 1000) return `${value} 毫秒`;
  return `${(value / 1000).toFixed(1)} 秒`;
}

interface WorkflowRunsProps {
  scenes: SceneModule[];
  onNavigate: (page: PageId) => void;
  /** 从场景包跳转过来时带上的执行场景筛选（只读初值，后续由本页自己维护）。 */
  initialSceneFilter?: string;
  onSceneFilterChange?: (sceneId: string) => void;
  selectedRunId: string | null;
  onSelectRun: (runId: string | null) => void;
  onCancelRun: (runId: string) => void;
  onResumeRun: (run: WorkflowRunRecord) => Promise<void>;
  onRerunRun: (run: WorkflowRunRecord, changes: RerunRequest) => Promise<void>;
  activeRunId: string | null;
  runStartError?: string;
  submissionPending?: boolean;
}

export default function WorkflowRuns({ scenes, onNavigate, initialSceneFilter = "", onSceneFilterChange, selectedRunId, onSelectRun, onCancelRun, onResumeRun, onRerunRun, activeRunId, runStartError, submissionPending = false }: WorkflowRunsProps) {
  const [projectDirectory, setProjectDirectory] = useState("");
  const [runs, setRuns] = useState<WorkflowRunHistoryItem[]>([]);
  const [selectedRun, setSelectedRun] = useState<WorkflowRunRecord | null>(null);
  const [nextCursor, setNextCursor] = useState<string | undefined>();
  const [loadingMore, setLoadingMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailsVersion, setDetailsVersion] = useState(0);
  const [error, setError] = useState("");
  const [searchText, setSearchText] = useState("");
  const [query, setQuery] = useState("");
  const [sceneFilter, setSceneFilter] = useState(initialSceneFilter);
  const [rerunTarget, setRerunTarget] = useState<RerunTarget | null>(null);
  const [comparison, setComparison] = useState<WorkflowRunRecord | null>(null);
  const [comparing, setComparing] = useState(false);
  useEffect(() => { setRerunTarget(null); setComparison(null); }, [selectedRunId]);
  async function compareOriginal() {
    if (!selectedRun?.rerunFromRunId) return;
    const targetRunId = selectedRun.runId; setComparing(true);
    try { const original = await loadWorkflowRun(selectedRun.rerunFromRunId); if (selectedRunIdRef.current === targetRunId) setComparison(original); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "无法读取原结果"); }
    finally { setComparing(false); }
  }
  const [resumingRunIds, setResumingRunIds] = useState<Set<string>>(() => new Set());
  const resumingRunIdsRef = useRef(new Set<string>());
  const selectedRunIdRef = useRef(selectedRunId);
  selectedRunIdRef.current = selectedRunId;

  async function resumeRun(run: WorkflowRunRecord) {
    if (resumingRunIdsRef.current.has(run.runId)) return;
    const pendingRunIds = new Set(resumingRunIdsRef.current);
    pendingRunIds.add(run.runId);
    resumingRunIdsRef.current = pendingRunIds;
    setResumingRunIds(pendingRunIds);
    setError("");
    try {
      await onResumeRun(run);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "无法从断点继续运行");
    } finally {
      const remainingRunIds = new Set(resumingRunIdsRef.current);
      remainingRunIds.delete(run.runId);
      resumingRunIdsRef.current = remainingRunIds;
      setResumingRunIds(remainingRunIds);
    }
  }

  const refresh = useCallback(async (keyword = query, cursor?: string, scene = sceneFilter) => {
    if (!cursor) setLoading(true);
    setError("");
    try {
      const response = await loadWorkflowRuns(cursor, keyword, scene);
      setProjectDirectory(response.projectDirectory);
      const page = response.runs;
      setRuns((current) => cursor ? [...current, ...page.filter((item) => !current.some((existing) => existing.runId === item.runId))] : page);
      setNextCursor(response.nextCursor);
      // 第一页选中最新一条；搜索结果为空时清空详情，避免右栏停在筛选外的旧运行上。
      if (!cursor && !selectedRunIdRef.current && page[0]) onSelectRun(page[0].runId);
      if (!cursor && !page[0]) onSelectRun(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "读取运行记录失败");
    } finally {
      setLoading(false);
    }
  }, [onSelectRun, query, sceneFilter]);

  useEffect(() => { void refresh(); }, [refresh]);

  // 外部带入的筛选（场景包「查看运行记录」）：只在 prop 本身变化时应用一次。
  // 不能用 sceneFilter 做依赖——本页自己的下拉变化会让这个 effect 把值推回旧 prop。
  const appliedSceneFilter = useRef(initialSceneFilter);
  useEffect(() => {
    if (initialSceneFilter === appliedSceneFilter.current) return;
    appliedSceneFilter.current = initialSceneFilter;
    setSceneFilter(initialSceneFilter);
    setNextCursor(undefined);
  }, [initialSceneFilter]);

  useEffect(() => {
    if (!selectedRunId) { setSelectedRun(null); return; }
    setSelectedRun(null);
    setDetailLoading(true);
    // A new ID is not readable until POST commits its input snapshot and acknowledges acceptance.
    if (submissionPending) return;
    return subscribeWorkflowRun(selectedRunId, (run) => {
      setSelectedRun(run);
      setDetailLoading(false);
      setError("");
      const summary = runHistorySummary(run);
      setRuns((current) => {
        const updated = current.some((item) => item.runId === run.runId) ? current.map((item) => item.runId === run.runId ? summary : item) : [summary, ...current];
        return updated;
      });
    }, (reason, permanent) => {
      if (permanent || activeRunId !== selectedRunId) setError(reason.message);
      if (permanent) setDetailLoading(false);
    });
  }, [selectedRunId, detailsVersion, activeRunId, submissionPending]);

  async function loadMore() {
    if (!nextCursor || loadingMore) return;
    setLoadingMore(true);
    try {
      await refresh(query, nextCursor, sceneFilter);
    } finally { setLoadingMore(false); }
  }

  function changeSceneFilter(next: string) {
    setSceneFilter(next);
    onSceneFilterChange?.(next);
    setNextCursor(undefined);
  }

  function submitSearch() {
    const next = searchText.trim();
    setSearchText(next);
    if (next === query) { void refresh(next); return; }
    // 关键字变化必须从第一页重读：旧游标绑定的是上一组筛选条件。query 变更由 refresh 的依赖触发。
    setQuery(next);
    setNextCursor(undefined);
  }

  return (
    <div className="workflow-runs-page">
      <div className="welcome-row">
        <div><div className="eyebrow"><span className="eyebrow-line" />PROJECT RUNS</div><h1>运行记录</h1><p className="page-subtitle">查看每次运行的输入、执行状态和生成结果。</p></div>
        <button className="button button-outline" onClick={() => { setDetailsVersion((version) => version + 1); void refresh(query); }} disabled={loading}><RefreshCw className={loading ? "spin" : ""} size={15} />刷新记录</button>
      </div>

      {projectDirectory && <div className="runs-project-path"><FolderOpen size={15} /><span><strong>项目目录</strong><code>{projectDirectory}</code></span></div>}
      {runStartError && <div className="notice error-notice" role="alert">运行操作失败：{runStartError}</div>}
      {error && !runStartError && <div className="notice error-notice" role="alert">{error}</div>}

      {!projectDirectory && !loading ? (
        <div className="history-empty"><span className="history-empty-mark"><FolderOpen size={22} /></span><h2>还没有配置项目目录</h2><p>先设置目录，之后每次运行都会在这里留下输入、状态和输出记录。</p><button className="button button-dark" onClick={() => onNavigate("connections")}>配置项目目录 <FolderOpen size={15} /></button></div>
      ) : loading ? (
        <div className="runs-loading"><LoaderCircle className="spin" size={18} />正在读取运行记录</div>
      ) : runs.length === 0 && selectedRunId === null ? (
        <div className="history-empty"><span className="history-empty-mark"><Workflow size={22} /></span><h2>项目目录中还没有运行记录</h2><p>完成一次流程运行后，输入和输出会归档到 <code>.zane/runs</code>。</p><button className="button button-dark" onClick={() => onNavigate("home")}>开始运行 <Workflow size={15} /></button></div>
      ) : (
        <div className="runs-layout">
          <section className="runs-list" aria-label="运行记录列表">
            <div className="runs-list-heading"><strong>最近运行</strong><span>{runs.length}</span></div>
            <div className="runs-scene-filter">
              <label>场景<select value={sceneFilter} onChange={(event) => changeSceneFilter(event.target.value)} aria-label="按场景筛选运行记录">
                <option value="">全部场景</option>
                {scenes.map((scene) => <option key={scene.id} value={scene.id}>{scene.shortTitle}</option>)}
              </select></label>
              {sceneFilter && <button className="text-button" onClick={() => changeSceneFilter("")} type="button">清除筛选</button>}
            </div>
            <div className="runs-search">
              <Search size={14} aria-hidden />
              <input value={searchText} onChange={(event) => setSearchText(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") submitSearch(); }} placeholder="搜索标题、流程、场景、编号、错误或提交人" aria-label="搜索运行记录" maxLength={200} />
              {searchText && <button className="runs-search-clear" onClick={() => { setSearchText(""); if (query) { setQuery(""); setNextCursor(undefined); } }} aria-label="清空搜索" type="button"><X size={13} /></button>}
              <button className="runs-search-submit" onClick={submitSearch} disabled={loading} type="button">搜索</button>
            </div>
            {query && <div className="runs-search-active">筛选「{query}」· {runs.length} 条匹配</div>}
            <div className="runs-list-items">
              {!runs.length && <div className="run-detail-empty">{activeRunId ? "正在创建运行记录…" : query ? `没有匹配「${query}」的运行记录。` : "暂无运行记录。"}</div>}
              {runs.map((run) => {
                const scene = getScene(run.sceneId, scenes);
                return <button className={`run-history-item ${selectedRunId === run.runId ? "active" : ""}`} key={run.runId} onClick={() => { setError(""); onSelectRun(run.runId); }}>
                  <span className={`run-history-mark ${scene.accent}`}><Workflow size={16} /></span>
                  <span className="run-history-copy"><span className="run-history-title"><strong>{getRunDisplayTitle(scene.shortTitle, run.runTitle)}</strong><i className={`run-status-dot ${run.status}`} /></span><small>{scene.shortTitle} · {formatDate(run.startedAt)}</small><small>提交人：{formatRunSubmitter(run.submitter)} · {run.stepCount} 步 · {run.outputCount} 项输出 · {formatDuration(run.durationMs)}</small></span>
                  <span className={`run-status-label ${run.status}`}>{statusLabels[run.status]}</span>
                </button>;
              })}
            </div>
            {nextCursor && <button className="button button-outline runs-load-more" onClick={() => void loadMore()} disabled={loadingMore}>{loadingMore ? "读取中…" : "加载更多运行"}</button>}
          </section>

          <section className="run-detail" aria-label="运行详情">
            {detailLoading || submissionPending || (!selectedRun && activeRunId === selectedRunId) ? <div className="runs-loading"><LoaderCircle className="spin" size={17} />{submissionPending ? "正在准备素材并确认任务提交…" : "读取运行详情"}</div> : selectedRun ? <>
              <div className="run-detail-heading"><div><span className="eyebrow"><span className="eyebrow-line" />{getScene(selectedRun.sceneId, scenes).shortTitle.toUpperCase()}</span><h2>{getRunDisplayTitle(getScene(selectedRun.sceneId, scenes).shortTitle, selectedRun.runTitle)}</h2><small>提交人：{formatRunSubmitter(selectedRun.submitter)}</small><p><Clock3 size={13} />{formatDate(selectedRun.startedAt ?? "")} · {formatDuration(selectedRun.durationMs)}</p></div><span className={`run-status-label ${selectedRun.status}`}>{statusLabels[selectedRun.status]}</span></div>
              {selectedRun.rerunFromRunId && <div className="rerun-lineage"><span>由 {selectedRun.rerunFromRunId.slice(0, 8)} 修订</span><button className="text-button" onClick={() => onSelectRun(selectedRun.rerunFromRunId!)}>查看原运行</button><button className="text-button" disabled={comparing} onClick={() => void compareOriginal()}>{comparing ? "读取中…" : "对比原结果"}</button></div>}
              {selectedRun.rerunPlan && <details className="run-input-snapshot"><summary>查看本次重算范围</summary><ul>{selectedRun.rerunPlan.steps.map((step) => <li key={step.stepId}>{step.name}：{step.action === "reuse" ? "复用" : step.action === "replace" ? "替换" : "重算"} · {step.reason}</li>)}</ul></details>}
              <WorkflowRunPanel
                result={selectedRun}
                inputValues={selectedRun.inputValues}
                onComposedRun={runId => { onSelectRun(runId); setDetailsVersion(value => value+1); void refresh(); }}
                onReviewSubmitted={() => { setDetailsVersion(value => value + 1); void refresh(); }}
                onCancelRun={["queued", "running", "cancelling", "waiting"].includes(selectedRun.status) ? () => onCancelRun(selectedRun.runId) : undefined}
                onResumeRun={["failed", "cancelled", "stale"].includes(selectedRun.status) && selectedRun.workflow && !selectedRun.items?.length ? () => void resumeRun(selectedRun) : undefined}
                resumePending={resumingRunIds.has(selectedRun.runId)}
                onRerunStep={!["queued", "running", "cancelling", "waiting"].includes(selectedRun.status) && selectedRun.workflow?.steps.length && !selectedRun.items?.length ? (stepId, itemIndex, mode) => setRerunTarget({ stepId, itemIndex, mode }) : undefined}
              />
            </> : runStartError ? <div className="run-detail-empty">运行未能启动。</div> : <div className="run-detail-empty">选择一条记录查看详情。</div>}
          </section>
        </div>
      )}
      {selectedRun && rerunTarget && <RerunDialog run={selectedRun} target={rerunTarget} onClose={() => setRerunTarget(null)} onSubmit={(changes) => onRerunRun(selectedRun, changes)} />}
      {selectedRun && comparison && <RunComparisonDialog original={comparison} revised={selectedRun} onClose={() => setComparison(null)} />}
    </div>
  );
}
