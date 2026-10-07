import RunMediaDownloadButton from "./RunMediaDownloadButton";
import RunWarnings from "./RunWarnings";
import { Check, ChevronRight, Copy, Download, History as HistoryIcon, MessageSquare, Pencil, RotateCcw, Square } from "lucide-react";
import { useState } from "react";
import { RunMetrics } from "./RunOverview";
import ClipSelectionDialog from "./ClipSelectionDialog";
import ReviewPanel from "./ReviewPanel";
import type { WorkflowDefinition, WorkflowRunRecord } from "../types";
import SaveAssetButton from "./SaveAssetButton";
import type { AssetSource } from "../../server/domain/productionContracts";
import { runOutputMediaItems } from "../lib/runMedia";
import { useCapabilities } from "../hooks/useCapabilities";
import type { JsonValue, WorkflowRunOutput, WorkflowRunResult } from "../types";

function outputText(output: WorkflowRunOutput) {
  if (typeof output.value === "boolean") return output.value ? "真" : "假";
  if (output.value === null) return "无结果";
  if (typeof output.value === "object") return JSON.stringify(output.value, null, 2);
  return String(output.value);
}

function StepValue({ value, type, source }: { value: JsonValue; type?: string; source?: Omit<AssetSource,"mediaIndex"> }) {
  const media = runOutputMediaItems(value, type, source);
  if (media.length) return <div className="workflow-run-step-media">{media.map((item, index) => <div className="production-media-item" key={item.url + index}>
    {item.isVideo ? <video src={item.url} controls preload="metadata" aria-label={item.filename} /> : item.isAudio ? <audio src={item.url} controls preload="metadata" aria-label={item.filename} /> : <a href={item.url} target="_blank" rel="noreferrer"><img src={item.url} alt={item.filename} loading="lazy" /></a>}
    {source && <SaveAssetButton kind={item.isVideo ? "video" : item.isAudio ? "audio" : "image"} source={{ ...source, mediaIndex: item.mediaIndex }} />}
  </div>)}</div>;
  return <pre>{value === null ? "无值" : typeof value === "object" ? JSON.stringify(value, null, 2) : String(value)}</pre>;
}

function stepStatusLabel(status: WorkflowRunResult["steps"][number]["status"]) {
  return status === "completed" ? "完成" : status === "skipped" ? "跳过" : status === "running" ? "运行中" : status === "cancelled" ? "已取消" : "失败";
}

function itemStatusLabel(status: NonNullable<WorkflowRunResult["items"]>[number]["status"]) {
  return status === "completed" ? "完成" : status === "running" ? "运行中" : status === "cancelled" ? "已取消" : "失败";
}

function stepItemStatusLabel(status: NonNullable<WorkflowRunResult["steps"][number]["items"]>[number]["status"]) {
  return status === "completed" ? "完成" : status === "skipped" ? "跳过" : status === "running" ? "运行中" : status === "cancelled" ? "已取消" : "失败";
}

function outputValueLabel(value: JsonValue) {
  if (value && typeof value === "object" && !Array.isArray(value) && typeof value.filename === "string") return value.filename;
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}

function RunOutput({ output, runId, className = "workflow-run-output", renderer = "auto" }: { output: WorkflowRunOutput; runId?: string; className?: string; renderer?: "auto" | "text" | "json" | "media" }) {
  const renderType = renderer === "text" || renderer === "json" ? renderer : output.type;
  const isVideoOutput = renderType === "video" || renderType === "video_list";
  const isAudioOutput = renderType === "audio" || renderType === "audio_list";
  const media = renderType === "image" || renderType === "image_list" || isVideoOutput || isAudioOutput ? runOutputMediaItems(output.value, renderType, runId ? {runId, outputKey: output.key} : undefined) : [];
  return <article className={className}>
    <div className="workflow-run-output-heading"><strong>{output.label}</strong><small>{output.type}</small></div>
    {media.length ? <div className="workflow-run-media">{media.map((item,index) => <div className="production-media-item" key={item.url + index}>{isVideoOutput ? <video src={item.url} controls preload="metadata" aria-label={item.filename} /> : isAudioOutput ? <audio src={item.url} controls preload="metadata" aria-label={item.filename} /> : <a href={item.url} target="_blank" rel="noreferrer"><img src={item.url} alt={item.filename} loading="lazy" /></a>}{runId && <SaveAssetButton kind={isVideoOutput ? "video" : isAudioOutput ? "audio" : "image"} source={{ runId, outputKey: output.key, mediaIndex: item.mediaIndex }} />}</div>)}</div>
      : <pre>{outputText(output)}</pre>}
  </article>;
}

export default function WorkflowRunPanel({
  result,
  inputValues,
  onOpenRuns,
  onCancelRun,
  onResumeRun,
  resumePending = false,
  onRerunStep,
  onFeedbackStep,
  workflow,
  onReviewSubmitted,
  onComposedRun,
}: {
  result: WorkflowRunResult;
  inputValues?: Record<string, JsonValue>;
  onOpenRuns?: () => void;
  onCancelRun?: () => void;
  onResumeRun?: () => void;
  resumePending?: boolean;
  onComposedRun?: (runId: string) => void;
  onReviewSubmitted?: () => void;
  onRerunStep?: (stepId?: string, itemIndex?: number, mode?: "rerun" | "replace" | "feedback") => void;
  onFeedbackStep?: (stepId: string, itemIndex?: number) => void;
  workflow?: WorkflowDefinition;
}) {
  const [copied, setCopied] = useState(false);
  const [selectingClips, setSelectingClips] = useState(false);
  const { capabilities } = useCapabilities();
  const feedbackAllowed = !["queued", "running", "cancelling", "waiting"].includes(result.status);
  const submitFeedback = onFeedbackStep ?? (onRerunStep ? (stepId: string, itemIndex?: number) => onRerunStep(stepId, itemIndex, "feedback") : undefined);
  const cancelled = result.status === "cancelled";
  const snapshotWorkflow = (result as WorkflowRunRecord).workflow ?? workflow;
  const statuses = [...new Set([...(snapshotWorkflow?.steps.map(step => step.id) ?? []), ...result.steps.map(step => step.stepId)])]
    .map(id => result.steps.find(step => step.stepId === id)?.status ?? "pending");
  const progress = {
    total: statuses.length, completed: statuses.filter(status => status === "completed").length,
    skipped: statuses.filter(status => status === "skipped").length, failed: statuses.filter(status => status === "failed").length,
    cancelled: statuses.filter(status => status === "cancelled").length, running: statuses.filter(status => status === "running").length,
    pending: statuses.filter(status => status === "pending").length, settled: statuses.filter(status => !["pending", "running"].includes(status)).length,
  };
  const iterationSteps = result.steps.filter((step) => step.items?.length);
  const iterationCount = iterationSteps.reduce((total, step) => total + (step.items?.length ?? 0), 0);

  async function copyRunDirectory() {
    const directory = result.artifacts?.directory;
    if (!directory || !navigator.clipboard) return;
    await navigator.clipboard.writeText(directory);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1800);
  }

  return (
    <section className={`workflow-run-result ${result.status}`} aria-live="polite">
      <div className="workflow-run-heading">
        <div><h3>{result.status === "completed" ? "运行完成" : cancelled ? "已取消运行" : result.status === "queued" ? "正在排队" : result.status === "running" ? "正在运行" : result.status === "cancelling" ? "正在取消" : result.status === "waiting" ? "等待人工确认" : result.status === "stale" ? "等待恢复" : "运行失败"}</h3><span>{result.items?.length ? `${result.items.filter((item) => item.status === "completed").length}/${result.items.length} 项完成` : `${result.steps.filter((step) => step.status === "completed").length} 步完成 · ${result.steps.filter((step) => step.status === "skipped").length} 步跳过${iterationCount ? ` · ${iterationSteps.length} 个步骤逐项执行 ${iterationCount} 项` : ""}`}</span></div>
        <small>{result.runId.slice(0, 8)}</small>
      </div>
      <RunMetrics progress={progress} outputCount={result.outputs.length} expectedOutputCount={snapshotWorkflow?.outputs.length ?? result.outputs.length}
        createdAt={(result as WorkflowRunRecord & {createdAt?: string}).createdAt ?? result.startedAt} finishedAt={result.finishedAt} status={result.status} />
      <details className="run-input-snapshot run-admin-metadata"><summary>任务标识与发布快照</summary><dl><div><dt>任务 ID</dt><dd>{result.runId}</dd></div><div><dt>发布版本</dt><dd>{(snapshotWorkflow as WorkflowDefinition & { publishedScene?: {version?: string; versionId?: string} } | undefined)?.publishedScene?.version ?? "未绑定发布快照"}</dd></div><div><dt>发布版本 ID</dt><dd>{(snapshotWorkflow as WorkflowDefinition & { publishedScene?: {version?: string; versionId?: string} } | undefined)?.publishedScene?.versionId ?? "未记录"}</dd></div><div><dt>创建</dt><dd>{(result as WorkflowRunRecord & {createdAt?: string}).createdAt ?? result.startedAt ?? "未记录"}</dd></div><div><dt>结束</dt><dd>{result.finishedAt ?? "尚未结束"}</dd></div></dl></details>
      {(onCancelRun || onResumeRun || onRerunStep) && <div className="workflow-run-actions">
        {["queued", "running", "cancelling", "waiting"].includes(result.status) && onCancelRun && <button className="text-button workflow-run-action workflow-run-cancel" type="button" onClick={onCancelRun} disabled={result.status === "cancelling"}><Square size={13} />{result.status === "cancelling" ? "取消中…" : "取消运行"}</button>}
        {onResumeRun && <button className="text-button workflow-run-action workflow-run-resume" type="button" onClick={onResumeRun} disabled={resumePending}><RotateCcw size={13} />{resumePending ? "正在启动续跑" : result.status === "failed" ? "从失败步骤继续" : "从断点继续"}</button>}
        {onRerunStep && <button className="text-button workflow-run-action workflow-run-rerun" type="button" onClick={() => onRerunStep()}><Pencil size={13} />修改结果 / 局部重做</button>}
      </div>}
      {!['queued','running','cancelling','waiting'].includes(result.status) && result.steps.some(step => step.items?.some(item => item.status === "completed") && Object.values(step.outputTypes ?? {}).some(type => /^(video|video_list)$/.test(type))) && <button className="button button-outline" type="button" onClick={() => setSelectingClips(true)}>镜头选版 / 合成</button>}
      {selectingClips && <ClipSelectionDialog run={result as WorkflowRunRecord} onClose={() => setSelectingClips(false)} onComposed={runId => { setSelectingClips(false); if (onComposedRun) onComposedRun(runId); else onOpenRuns?.(); }} />}
      {result.status === "waiting" && result.pendingReview && (onReviewSubmitted ? <ReviewPanel key={result.pendingReview.id} run={result as WorkflowRunRecord} onSubmitted={onReviewSubmitted} /> : <div className="production-review"><strong>等待确认：{result.pendingReview.name}</strong>{onOpenRuns && <button className="text-button" onClick={onOpenRuns}>前往运行记录处理</button>}</div>)}
      {result.reviewHistory?.length ? <details className="run-input-snapshot"><summary>确认历史（{result.reviewHistory.length} 次）</summary><pre>{JSON.stringify(result.reviewHistory,null,2)}</pre></details> : null}
      {result.feedbackHistory?.length ? <details className="run-input-snapshot hermes-feedback-history"><summary>Hermes 反馈历史（{result.feedbackHistory.length} 条）</summary><ol>{result.feedbackHistory.map(feedback => <li key={feedback.id}><strong>{result.steps.find(step => step.stepId === feedback.stepId)?.name ?? feedback.stepId}{feedback.itemIndex === undefined ? " · 整步" : " · 第 " + (feedback.itemIndex + 1) + " 项"}</strong><small>{new Date(feedback.createdAt).toLocaleString("zh-CN")} · 来源版本 {feedback.sourceRunId.slice(0, 8)}</small><p>{feedback.message}</p><details><summary>查看反馈时的原结果</summary><pre>{JSON.stringify(feedback.originalItems ? { outputs: feedback.originalOutputs, items: feedback.originalItems } : feedback.originalOutputs, null, 2)}</pre></details></li>)}</ol></details> : null}
      {cancelled && <div className="workflow-run-cancellation-reason" role="status"><strong>取消原因</strong><span>{result.cancellationReason ?? (result.error && result.error !== "运行已取消" ? result.error : "这条历史记录没有保存具体取消原因")}</span></div>}
      {result.error && !cancelled && <div className="workflow-run-error" role="alert">{result.error}</div>}
      {result.archiveWarnings?.length ? <div className="workflow-run-warning" role="status">部分生成媒体没有复制到项目目录：{result.archiveWarnings.join("；")}</div> : null}
      {inputValues && <details className="run-input-snapshot"><summary>查看本次输入</summary><pre>{JSON.stringify(inputValues, null, 2)}</pre></details>}
      {result.items?.length ? <div className="workflow-run-items">
        {result.items.map((item) => <article className="workflow-run-item" key={`workflow-run-item-${item.index}`}>
          <div className="workflow-run-item-heading"><strong>第 {item.index + 1} 项</strong><small className={item.status}>{itemStatusLabel(item.status)}</small></div>
          <div className="workflow-run-item-source">{outputValueLabel(item.value)}</div>
          {item.error && <div className="workflow-run-item-error">{item.error}</div>}
          {!!item.outputs.length && <div className="workflow-run-item-outputs">{item.outputs.map((output) => <RunOutput key={`${item.index}-${output.key}`} output={output} className="workflow-run-item-output" />)}</div>}
        </article>)}
      </div> : null}
      <ol className="workflow-run-steps">
        {result.steps.map((step) => {
          const definition = (result as WorkflowRunRecord).workflow?.steps.find(definition => definition.id === step.stepId) ?? workflow?.steps.find(definition => definition.id === step.stepId);
          const isHermes = definition ? definition.kind === "hermes" : step.capabilityId === "core.hermes";
          const inputValues = step.inputs ?? {};
          const outputValues = step.outputs ?? {};
          const outputRenderer = capabilities.find((item) => item.id === step.capabilityId && item.version === step.capabilityVersion)?.result.renderer;
          const inputKeys = Object.keys(inputValues);
          const outputKeys = [...new Set([...Object.keys(step.outputLabels ?? {}), ...Object.keys(outputValues)])];
          return <li key={step.stepId} className={step.status}>
            <details className="workflow-run-step">
              <summary className="workflow-run-step-summary">
                <span className="workflow-run-step-name"><ChevronRight size={14} /><strong>{step.name}</strong></span>
                <span className="workflow-run-step-meta"><span className={`workflow-run-step-status ${step.status}`}>{stepStatusLabel(step.status)}</span>{step.message && <small>{step.message}</small>}{(step.warnings?.length || step.items?.some(item => item.warnings?.length)) ? <small>⚠ {(step.warnings?.length ?? 0) + (step.items ?? []).reduce((sum, item) => sum + (item.warnings?.length ?? 0), 0)} 条提示</small> : null}<span>{inputKeys.length} 个输入 · {outputKeys.length} 个输出</span></span>
              </summary>
              <div className="workflow-run-step-content"><RunWarnings warnings={step.warnings} />
                {onRerunStep && <div className="rerun-step-actions"><button className="text-button" type="button" onClick={() => onRerunStep(step.stepId, undefined, "rerun")}>重做本步骤</button>{step.status === "completed" && !step.items?.length && <button className="text-button" type="button" onClick={() => onRerunStep(step.stepId, undefined, "replace")}>修改本步结果</button>}{step.reusedFromRunId && <small>{step.replaced ? "使用手动替换结果" : "复用历史结果"}</small>}</div>}
                {submitFeedback && feedbackAllowed && isHermes && ((step.status === "completed" && Object.keys(outputValues).length > 0) || step.items?.some(item => item.status === "completed" && Object.keys(item.outputs ?? {}).length > 0)) && <div className="rerun-step-actions"><button className="text-button workflow-run-feedback" type="button" onClick={() => submitFeedback(step.stepId)}><MessageSquare size={14} />{step.items?.length ? "反馈并重做整个步骤" : "反馈并重做"}</button><small>说明哪里不好，让 Hermes 根据原结果修改</small></div>}
                <section className="workflow-run-step-section">
                  <div className="workflow-run-step-section-heading"><strong>输入</strong><small>{inputKeys.length}</small></div>
                  {inputKeys.length ? <dl>{inputKeys.map((key) => <div className="workflow-run-step-value" key={key}><dt>{step.inputLabels?.[key] ?? key}<small>{step.inputLabels?.[key] ? key : ""}</small></dt><dd><StepValue value={inputValues[key]} /></dd></div>)}</dl> : <p className="workflow-run-step-empty">未配置步骤输入</p>}
                </section>
                <section className="workflow-run-step-section">
                  <div className="workflow-run-step-section-heading"><strong>输出</strong><small>{outputKeys.length}</small></div>
                  {outputKeys.length ? <dl>{outputKeys.map((key) => <div className="workflow-run-step-value" key={key}><dt>{step.outputLabels?.[key] ?? key}<small>{step.outputLabels?.[key] ? key : ""}</small></dt><dd>{Object.prototype.hasOwnProperty.call(outputValues, key) ? <StepValue value={outputValues[key]} source={step.status === "completed" ? { runId: result.runId, stepId: step.stepId, outputKey: key } : undefined} type={outputRenderer === "text" || outputRenderer === "json" ? outputRenderer : step.outputTypes?.[key]} /> : <p className="workflow-run-step-empty">{step.status === "running" ? "步骤完成后生成" : step.status === "skipped" ? "步骤未执行" : "尚未生成"}</p>}</dd></div>)}</dl> : <p className="workflow-run-step-empty">此步骤没有定义输出</p>}
                </section>
                {step.items?.length ? <section className="workflow-run-step-section workflow-run-step-iterations">
                  <div className="workflow-run-step-section-heading"><strong>逐项执行</strong><small>{step.items.filter((item) => item.status === "completed").length}/{step.items.length}</small></div>
                  <div className="workflow-run-step-items">
                    {step.items.map((item) => {
                      const itemInputValues = item.inputs ?? {};
                      const itemOutputValues = item.outputs ?? {};
                      const itemInputKeys = Object.keys(itemInputValues);
                      const itemOutputKeys = [...new Set([...Object.keys(step.outputLabels ?? {}), ...Object.keys(itemOutputValues)])];
                      return <details className="workflow-run-step-item" key={`${step.stepId}-item-${item.index}`}>
                        <summary><strong>第 {item.index + 1} 项</strong><span className={`workflow-run-step-status ${item.status}`}>{stepItemStatusLabel(item.status)}</span><small>{outputValueLabel(item.value)}</small>{!!item.warnings?.length && <small>⚠ {item.warnings.length} 条提示</small>}</summary>
                        <div className="workflow-run-step-item-content">
                          {onRerunStep && <div className="rerun-step-actions"><button className="text-button" type="button" onClick={() => onRerunStep(step.stepId, item.index, "rerun")}>只重做第 {item.index + 1} 项</button>{item.status === "completed" && <button className="text-button" type="button" onClick={() => onRerunStep(step.stepId, item.index, "replace")}>替换此项结果</button>}{item.reusedFromRunId && <small>复用历史结果</small>}</div>}
                          {submitFeedback && feedbackAllowed && isHermes && item.status === "completed" && Object.keys(itemOutputValues).length > 0 && <div className="rerun-step-actions"><button className="text-button workflow-run-feedback" type="button" onClick={() => submitFeedback(step.stepId, item.index)}><MessageSquare size={14} />反馈并重做第 {item.index + 1} 项</button></div>}
                          {item.error && <div className="workflow-run-item-error">{item.error}</div>}<RunWarnings warnings={item.warnings} />
                          <div className="workflow-run-step-item-values">
                            <section><div className="workflow-run-step-section-heading"><strong>输入</strong><small>{itemInputKeys.length}</small></div>{itemInputKeys.length ? <dl>{itemInputKeys.map((key) => <div className="workflow-run-step-value" key={key}><dt>{step.inputLabels?.[key] ?? key}<small>{step.inputLabels?.[key] ? key : ""}</small></dt><dd><StepValue value={itemInputValues[key]} /></dd></div>)}</dl> : <p className="workflow-run-step-empty">未配置步骤输入</p>}</section>
                            <section><div className="workflow-run-step-section-heading"><strong>输出</strong><small>{itemOutputKeys.length}</small></div>{itemOutputKeys.length ? <dl>{itemOutputKeys.map((key) => <div className="workflow-run-step-value" key={key}><dt>{step.outputLabels?.[key] ?? key}<small>{step.outputLabels?.[key] ? key : ""}</small></dt><dd>{Object.prototype.hasOwnProperty.call(itemOutputValues, key) ? <StepValue value={itemOutputValues[key]} source={item.status === "completed" ? { runId: result.runId, stepId: step.stepId, itemIndex: item.index, outputKey: key } : undefined} type={outputRenderer === "text" || outputRenderer === "json" ? outputRenderer : step.outputTypes?.[key]} /> : <p className="workflow-run-step-empty">尚未生成</p>}</dd></div>)}</dl> : <p className="workflow-run-step-empty">此项没有输出</p>}</section>
                          </div>
                        </div>
                      </details>;
                    })}
                  </div>
                </section> : null}
              </div>
            </details>
          </li>;
        })}
      </ol>
      {!!result.outputs.length && <div className="workflow-run-outputs">
        {result.outputs.map((output) => <RunOutput key={output.key} output={output} runId={result.runId} />)}
      </div>}
      {!(["queued", "running", "cancelling"] as string[]).includes(result.status) && (result.outputs.some((output) => output.key === "commerce_manifest" && Array.isArray(output.value) && output.value.length > 0) || result.steps.some((step) => step.items?.some((item) => item.status === "completed" && item.outputs?.commerce_manifest))) && <a className="button button-outline" href={`/api/v1/runs/${encodeURIComponent(result.runId)}/commerce-pack.zip`}><Download size={14} />按平台打包下载{result.status !== "completed" ? "（已完成部分）" : ""}</a>}
      {["completed", "failed", "cancelled", "stale"].includes(result.status) && result.outputs.filter(output => /^(image|video|audio)(_list)?$/.test(output.type) && runOutputMediaItems(output.value, output.type).length > 0).map(output => <RunMediaDownloadButton key={output.key} runId={result.runId} outputKey={output.key} />)}
      {result.artifacts && <div className="workflow-run-artifacts">
        <div><strong>项目归档</strong><code title={result.artifacts.directory}>{result.artifacts.directory}</code></div>
        <div className="workflow-run-artifact-actions">
          <button className="icon-button" type="button" onClick={() => void copyRunDirectory()} title="复制运行目录路径" aria-label="复制运行目录路径">{copied ? <Check size={14} /> : <Copy size={14} />}</button>
          {onOpenRuns && <button className="text-button" type="button" onClick={onOpenRuns}>运行记录 <HistoryIcon size={14} /></button>}
        </div>
      </div>}
    </section>
  );
}
