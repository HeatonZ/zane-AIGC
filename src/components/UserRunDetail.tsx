import RunMediaDownloadButton from "./RunMediaDownloadButton";
import RunWarnings from "./RunWarnings";
import { useEffect, useRef, useState } from "react";
import { Activity, AlertCircle, Check, CheckCircle2, ChevronLeft, ChevronRight, Circle, ClipboardCheck, Copy, Download, FileText, Layers3, LoaderCircle, PackageOpen, RefreshCw, RotateCcw, Square } from "lucide-react";
import { accessApi, type OwnRun } from "../lib/accessApi";
import { resultPath, mergeResultPage, type ResultContext, type ResultOutput, type ResultPage } from "../lib/userPortal";
import { activityLabel, mergeResultSlice, previousValueOffset, runDate, runStatusLabels } from "../lib/runDetails";
import RunOverview from "./RunOverview";

type InputPage = ReturnType<typeof import("../../server/services/runDetailService").businessRunInputs>;
type InputValue = InputPage["inputs"][number];
interface RunActivity { sequence: number; type: string; at: string; stepId?: string; stepName?: string; itemIndex?: number }
interface ActivityPage { runId: string; events: RunActivity[]; nextSequence: number; hasMore: boolean }

function valueText(value: unknown): string {
  return value === undefined ? "未提供" : value === null ? "空值" : typeof value === "string" ? value : typeof value === "boolean" ? (value ? "是 / true" : "否 / false") : JSON.stringify(value, null, 2);
}
function OutputCard({ output, onSlice, busy }: { output: ResultOutput; onSlice: (offset: number, narrow?: boolean) => void; busy: boolean }) {
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState("");
  useEffect(() => { setCopied(false); setCopyError(""); }, [output.value]);
  const media = output.mediaReferences ?? [];
  const offset = output.valuePage.offset ?? 0;
  const size = output.valuePage.pageSize || (output.valuePage.kind === "string" ? 8000 : 20);
  const segmented = offset > 0 || output.valuePage.hasMore;
  const copy = async () => {
    try { await navigator.clipboard.writeText(valueText(output.value)); setCopied(true); setCopyError(""); }
    catch { setCopyError("自动复制不可用，请选中内容手动复制。"); }
  };
  return <article className="business-output">
    <header><div><h4>{output.label || output.key}</h4><small>{output.key} · {output.type}</small></div>
      {!media.length && !output.valueOmitted && <button className="run-icon-button" onClick={() => void copy()} aria-label={`复制${output.label || output.key}当前片段`}>{copied ? <Check size={14} /> : <Copy size={14} />}{copied ? "已复制" : segmented ? "复制本段" : "复制"}</button>}</header>
    {copyError && <p className="access-error">{copyError}</p>}
    {output.valueOmitted ? <div className="run-empty-state"><AlertCircle size={22} /><strong>内容未返回，不是空结果</strong><p>{output.omissionReason === "metadata_only" ? "当前只读取了元数据。" : "当前片段超过响应预算，请按更小片段读取。"}</p><button className="button button-outline" disabled={busy} onClick={() => onSlice(offset, true)}>读取较小片段</button></div>
      : media.length ? <div className="business-media-grid">{media.map((item, index) => <figure key={item.url}>
        {/video/.test(output.type) ? <video src={item.url} controls preload="metadata" aria-label={output.label + " " + (index + 1)} /> : /audio/.test(output.type) ? <audio src={item.url} controls preload="metadata" aria-label={output.label} /> : <a href={item.url} target="_blank" rel="noreferrer"><img src={item.url} alt={output.label + " " + (index + 1)} loading="lazy" /></a>}
        <figcaption><span>第 {(item.source?.mediaIndex ?? offset + index) + 1} 项</span><a href={item.url} download className="run-icon-button"><Download size={14} />下载</a></figcaption>
      </figure>)}</div> : <pre className={`business-value ${output.type === "text" ? "text" : ""}`}>{valueText(output.value)}</pre>}
    {segmented && <footer className="run-value-pager"><span>{output.valuePage.kind === "string" ? "字符" : "项"} {offset + 1}–{offset + (output.valuePage.count ?? size)} / {output.valuePage.total}{output.valueOmitted ? "（未读取）" : ""}</span>
      <button className="run-icon-button" disabled={busy || offset === 0} onClick={() => onSlice(previousValueOffset(output.valuePage, size))}><ChevronLeft size={14} />上一段</button>
      <button className="run-icon-button" disabled={busy || !output.valuePage.hasMore || output.valueOmitted} onClick={() => onSlice(output.valuePage.nextValueOffset!)}>下一段<ChevronRight size={14} /></button></footer>}
  </article>;
}

export default function UserRunDetail({ run, userId, busy, submissionPending, onRefresh, onCancel, onResume, onReview }: {
  run: OwnRun; userId: string; busy: boolean; submissionPending: boolean;
  onRefresh: () => Promise<void>; onCancel: () => void; onResume: () => void;
  onReview: (action: "approve" | "redo") => void;
}) {
  const api = <T,>(path: string) => accessApi<T>(path, {}, userId);
  const [tab, setTab] = useState<"results" | "inputs" | "activity">("results");
  const [selectedStep, setSelectedStep] = useState<string>();
  const [results, setResults] = useState<ResultPage>();
  const [inputs, setInputs] = useState<InputPage>();
  const [activity, setActivity] = useState<ActivityPage>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const sequence = useRef(0);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; sequence.current++; }; }, []);
  const step = run.steps.find(item => item.stepId === selectedStep);
  const runPath = "/api/v1/self/runs/" + encodeURIComponent(run.runId);

  async function read(kind: "results" | "inputs" | "activity", options: { cursor?: string; context?: ResultContext; inputKey?: string; offset?: number; narrow?: boolean; chunk?: number; reset?: boolean } = {}) {
    const ticket = ++sequence.current;
    setLoading(true); setError("");
    try {
      if (kind === "results") {
        const context = options.context ?? { stepId: selectedStep };
        if (context.stepId && run.steps.find(item => item.stepId === context.stepId)?.status === "pending") { setResults(undefined); return; }
        const page = await api<ResultPage>(resultPath(run.runId, context, options.cursor));
        if (!alive.current || ticket !== sequence.current) return;
        const updated = options.context?.outputKey && results ? mergeResultSlice(results, page, context) : mergeResultPage(results, page, context, options.cursor);
        setResults(updated);
      } else if (kind === "inputs") {
        const query = new URLSearchParams({ limit: "12", valueLimit: String(options.narrow ? 1 : options.chunk ?? 2000), valueOffset: String(options.offset ?? 0) });
        if (options.cursor) query.set("cursor", options.cursor);
        if (options.inputKey) query.set("inputKey", options.inputKey);
        if (options.narrow) query.set("maxValueBytes", "262144");
        const page = await api<InputPage>(runPath + "/inputs?" + query);
        if (!alive.current || ticket !== sequence.current) return;
        if (inputs && (options.inputKey || options.cursor) && inputs.revision !== page.revision) throw new Error("输入快照已变化，请重新读取第一页。");
        setInputs(options.inputKey && inputs ? { ...inputs, inputs: inputs.inputs.map(input => page.inputs.find(value => value.key === input.key) ?? input) }
          : options.cursor && inputs ? { ...page, inputs: [...inputs.inputs, ...page.inputs] } : page);
      } else {
        const after = options.reset ? 0 : activity?.nextSequence ?? 0;
        const page = await api<ActivityPage>(runPath + "/activity?" + new URLSearchParams({ afterSequence: String(after), limit: "30" }));
        if (!alive.current || ticket !== sequence.current) return;
        setActivity(current => current && !options.reset ? { ...page, events: [...current.events, ...page.events.filter(event => !current.events.some(old => old.sequence === event.sequence))] } : page);
      }
    } catch (e) { if (alive.current && ticket === sequence.current) setError((e as Error).message); }
    finally { if (alive.current && ticket === sequence.current) setLoading(false); }
  }
  // Selection/revision changes invalidate older in-flight reads. Do not combine
  // snapshots from different steps or runs after delayed HTTP responses.
  useEffect(() => {
    setResults(undefined);
    if (tab === "results") void read("results");
    else if (tab === "inputs") { if (!inputs) void read("inputs"); }
    else void read("activity");
  }, [run.revision, selectedStep, tab]);
  async function refresh() { await onRefresh(); await read(tab); }
  function select(stepId?: string) { if (stepId === selectedStep && tab === "results") { void read("results"); return; } sequence.current++; setSelectedStep(stepId); setTab("results"); setResults(undefined); setError(""); }
  const readOutput = (output: ResultOutput, itemIndex?: number, offset = 0, narrow = false) => void read("results", { context: {
    stepId: selectedStep, itemIndex, outputKey: output.key,
    ...(output.valuePage.kind === "string" ? { textOffset: offset, textLimit: narrow ? 512 : output.valuePage.pageSize ?? 8000 } : { valueOffset: offset, valueLimit: narrow ? 1 : output.valuePage.pageSize ?? 20 }),
    ...(narrow ? { maxValueBytes: 262144, textLimit: 512 } : {}),
  } });
  function inputCard(input: InputValue) {
    const page = input.valuePage;
    return <article key={input.key} className="business-input"><header><div><h4>{input.label}</h4><small>{input.key} · {input.type}{input.required ? " · 必填" : ""}</small></div><span className="run-input-tag">原始输入</span></header>
      {input.valueOmitted ? <div className="run-omitted"><p>片段超过响应预算，值未返回。</p><button className="button button-outline" disabled={loading} onClick={() => void read("inputs", { inputKey: input.key, offset: page.offset, narrow: true })}>缩小片段读取</button></div> : <pre className="business-value">{input.present ? valueText(input.value) : "未提供此字段"}</pre>}
      {(page.hasMore || page.offset > 0) && <footer className="run-value-pager"><span>{page.kind === "string" ? "字符" : page.kind === "object" ? "键" : "项"} {page.offset + 1}–{page.offset + page.count} / {page.total}</span>
        <button className="run-icon-button" disabled={loading || !page.offset} onClick={() => void read("inputs", { inputKey: input.key, offset: previousValueOffset(page, 2000), chunk: page.pageSize })}><ChevronLeft size={14} />上一段</button>
        <button className="run-icon-button" disabled={loading || !page.hasMore || input.valueOmitted} onClick={() => void read("inputs", { inputKey: input.key, offset: page.nextValueOffset, chunk: page.pageSize })}>下一段<ChevronRight size={14} /></button></footer>}
    </article>;
  }
  return <section className="business-run-detail" aria-label="本人运行详情">
    <RunOverview run={run} actions={<>
      <button className="button button-outline" disabled={loading} onClick={() => void refresh().catch(e => setError((e as Error).message))}><RefreshCw size={14} />刷新详情</button>
      {["queued", "running", "waiting"].includes(run.status) && <button className="button button-outline" disabled={busy} onClick={onCancel}><Square size={13} />停止任务</button>}
      {["failed", "cancelled", "stale"].includes(run.status) && <button className="button button-dark" disabled={busy || submissionPending} onClick={onResume}><RotateCcw size={14} />按原快照续跑</button>}
      {["queued", "running", "cancelling", "waiting"].includes(run.status) && <span className="run-sync-indicator"><i />状态每 2.5 秒同步</span>}
    </>} />
    {run.pendingReview && <section className="business-review" aria-label="待业务确认"><ClipboardCheck size={22} /><div><h3>等待确认：{run.pendingReview.name}</h3><p>{run.pendingReview.instruction || "请查看本步骤的结果，确认后流程才会继续。"}</p>
      <button className="run-icon-button" onClick={() => select(run.pendingReview!.stepId)}>查看待确认结果<ChevronRight size={14} /></button>
      <div className="run-detail-actions"><button className="button button-dark" disabled={busy} onClick={() => onReview("approve")}><Check size={14} />确认并继续</button><button className="button button-outline" disabled={busy} onClick={() => onReview("redo")}>退回重做</button></div><small>确认或重做可能继续外部生成并产生费用。</small></div></section>}
    {run.error && run.status !== "cancelled" && <p className="run-business-error"><AlertCircle size={17} />{run.error} · 请提供上方任务 ID 便于定位。</p>}
    <nav className="business-run-tabs" aria-label="运行详情分类">{([
      ["results", "结果与步骤", Layers3], ["inputs", "输入快照", FileText], ["activity", "运行动态", Activity],
    ] as const).map(([key, label, Icon]) => <button key={key} className={tab === key ? "active" : ""} aria-current={tab === key ? "page" : undefined} onClick={() => { if (key === tab) return; sequence.current++; setTab(key); setError(""); }}><Icon size={16} />{label}{key === "inputs" && <small>{run.inputCount}</small>}</button>)}</nav>
    {error && <div className="access-error" role="alert">{error}<button className="run-icon-button" onClick={() => void read(tab, { reset: tab === "activity" })}>重新读取当前页</button></div>}
    <div className="run-read-indicator" role="status">{loading ? <><LoaderCircle size={14} className="spin" />读取服务端快照…</> : "所有详情来自服务端运行快照"}</div>
    {tab === "results" && <div className="business-run-results"><aside className="business-step-list" aria-label="流程步骤">
      <button className={!selectedStep ? "active final-result" : "final-result"} onClick={() => select()}><PackageOpen size={19} /><span><strong>最终结果</strong><small>{run.outputCount} / {run.expectedOutputCount} 个输出字段</small></span></button>
      <h3>执行步骤 <span>{run.steps.length}</span></h3><ol>{run.steps.map(item => <li key={item.stepId}><button className={selectedStep === item.stepId ? "active" : ""} onClick={() => select(item.stepId)} aria-current={selectedStep === item.stepId ? "step" : undefined}>
        <span className={`business-step-marker ${item.status}`}>{item.status === "completed" ? <CheckCircle2 size={17} /> : item.status === "running" ? <LoaderCircle size={17} className="spin" /> : item.status === "failed" ? <AlertCircle size={17} /> : <Circle size={17} />}</span>
        <span><strong>{item.order + 1}. {item.name}</strong><small>{item.reviewStatus === "pending" ? "等待确认" : runStatusLabels[item.status]}{item.reused ? " · 复用结果" : ""}{item.replaced ? " · 已替换" : ""}{item.warningCount ? ` · ⚠ ${item.warningCount} 条提示` : ""}</small>{item.itemProgress && <small>{item.itemProgress.completed} 完成 / {item.itemProgress.total} 项{item.itemProgress.failed ? ` · ${item.itemProgress.failed} 失败` : ""}</small>}</span>
      </button></li>)}</ol></aside><section className="business-result-pane" aria-label="当前结果">
        <header className="result-pane-heading"><div><span className="run-eyebrow">{step ? "STEP RESULT" : "FINAL OUTPUT"}</span><h3>{step?.name || "最终结果"}</h3></div><span className={`business-status ${step?.status ?? run.status}`}>{runStatusLabels[step?.status ?? run.status]}</span></header>
        {step && <p className="access-muted">{step.inputCount} 个输入 · {step.outputCount} / {step.expectedOutputCount} 个输出{step.reviewStatus === "pending" ? " · 当前结果等待确认" : ""}</p>}
        {!results?.outputs?.length && !results?.items?.length && !loading && <div className="run-empty-state"><PackageOpen size={32} /><strong>{step?.status === "pending" ? "此步骤尚未执行" : "当前没有可展示的结果"}</strong><p>{step?.status === "skipped" ? "流程根据条件跳过了此步骤，不会产生输出。" : selectedStep ? "步骤完成并保存结果后将在这里展示。" : run.status === "completed" ? "此流程没有保存最终输出，可查看各步骤的中间结果。" : "最终结果尚未生成，可以先查看左侧已完成步骤。"}</p></div>}
        <RunWarnings warnings={results?.warnings} />
        {["completed", "failed", "cancelled", "stale"].includes(run.status) && results?.outputs?.filter(output => /^(image|video|audio)(_list)?$/.test(output.type) && (output.valuePage.total ?? 0) > 0).map(output => <RunMediaDownloadButton key={output.key} runId={run.runId} outputKey={output.key} stepId={selectedStep} own userId={userId} />)}
        {results?.outputs?.map(output => <OutputCard key={output.key} output={output} busy={loading} onSlice={(offset, narrow) => readOutput(output, undefined, offset, narrow)} />)}
        {!!results?.items?.length && <div className="business-iterations"><h4>逐项结果 <span>共 {results.itemCount ?? results.items.length} 项</span></h4>{results.items.map(item => <details key={item.index} open={item.status === "failed" || results.items!.length < 4}><summary><span>第 {item.index + 1} 项{item.warnings?.length ? ` · ⚠ ${item.warnings.length} 条提示` : ""}</span><span className={`business-status ${item.status}`}>{runStatusLabels[item.status]}</span><ChevronRight size={15} /></summary>{item.error && <p className="access-error">{item.error}</p>}<RunWarnings warnings={item.warnings} />{item.outputs.map(output => <OutputCard key={output.key} output={output} busy={loading} onSlice={(offset, narrow) => readOutput(output, item.index, offset, narrow)} />)}{!item.outputs.length && <p className="access-muted">此项尚无结果。</p>}</details>)}</div>}
        {results?.nextCursor && <button className="button button-outline run-load-more" disabled={loading} onClick={() => void read("results", { cursor: results.nextCursor })}>加载更多{selectedStep ? "逐项结果" : "输出"}<ChevronRight size={14} /></button>}
      </section></div>}
    {tab === "inputs" && <section className="business-inputs"><div className="run-section-intro"><h3>本次任务的原始输入</h3><p>固定在创建任务时的快照，不受场景后续修改影响。媒体显示固定素材引用，不展示服务器路径。</p></div>{inputs?.inputs.map(inputCard)}{inputs && !inputs.inputs.length && <p className="run-empty-state">此流程没有输入字段。</p>}{inputs?.nextCursor && <button className="button button-outline" disabled={loading} onClick={() => void read("inputs", { cursor: inputs.nextCursor })}>加载更多输入字段</button>}
      <details className="business-snapshot-meta"><summary>快照标识</summary><dl><div><dt>场景 ID</dt><dd>{run.sceneId}</dd></div><div><dt>发布版本 ID</dt><dd>{run.versionId ?? "历史记录未保存发布版本"}</dd></div><div><dt>发布时间</dt><dd>{runDate(run.publishedAt)}</dd></div><div><dt>输入 revision</dt><dd>{inputs?.revision ?? "读取中"}</dd></div></dl></details></section>}
    {tab === "activity" && <section className="business-activity"><div className="run-section-intro"><h3>运行动态</h3><p>记录真实的排队、步骤执行、确认与结束事件，不是模型对话或原始日志。</p></div><ol>{activity?.events.map(event => <li key={event.sequence}><i /><div><strong>{activityLabel(event.type)}</strong>{event.stepName && <p>{event.stepName}{event.itemIndex !== undefined ? ` · 第 ${event.itemIndex + 1} 项` : ""}</p>}<small>事件 #{event.sequence}</small></div><time dateTime={event.at}>{runDate(event.at)}</time></li>)}</ol>{activity && !activity.events.length && <p className="run-empty-state">暂无业务动态。旧版导入的任务可能没有持久化事件。</p>}<button className="button button-outline" disabled={loading} onClick={() => void read("activity")}>{activity?.hasMore ? "加载后续动态" : "检查最新动态"}<RefreshCw size={14} /></button></section>}
  </section>;
}
