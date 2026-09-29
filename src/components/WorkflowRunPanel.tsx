import { Check, ChevronRight, Copy, History as HistoryIcon, RotateCcw, Square } from "lucide-react";
import { useState } from "react";
import type { JsonValue, WorkflowRunOutput, WorkflowRunResult } from "../types";

function mediaItems(value: JsonValue) {
  const items = Array.isArray(value) ? value : [value];
  return items.flatMap((item) => {
    if (typeof item === "string" && /^(https?:\/\/|\/api\/comfyui\/view)/i.test(item)) return [{ url: item, filename: item }];
    if (!item || typeof item !== "object" || Array.isArray(item) || typeof item.url !== "string") return [];
    return [{ url: item.url, filename: typeof item.filename === "string" ? item.filename : item.url }];
  });
}

function outputText(output: WorkflowRunOutput) {
  if (typeof output.value === "boolean") return output.value ? "真" : "假";
  if (output.value === null) return "无结果";
  if (typeof output.value === "object") return JSON.stringify(output.value, null, 2);
  return String(output.value);
}

function stepMediaItems(value: JsonValue, type?: string) {
  const values = Array.isArray(value) ? value : [value];
  return values.flatMap((item) => {
    if (typeof item === "string") {
      const isVideo = type === "video" || (!type && /\.(mp4|webm|mov|m4v)(?:[?#]|$)/i.test(item));
      const isImage = type === "image" || (!type && /\.(png|jpe?g|webp|gif|bmp)(?:[?#]|$)/i.test(item));
      return (isVideo || isImage) && /^(https?:\/\/|\/|data:|blob:)/i.test(item)
        ? [{ url: item, filename: item, isVideo }]
        : [];
    }
    if (!item || typeof item !== "object" || Array.isArray(item) || typeof item.url !== "string") return [];
    if (typeof item.filename !== "string" && typeof item.file !== "string" && item.type !== "input" && item.type !== "output" && type !== "image" && type !== "video") return [];
    const filename = typeof item.filename === "string" ? item.filename : item.url;
    const isVideo = type === "video" || /\.(mp4|webm|mov|m4v)(?:[?#]|$)/i.test(filename);
    return [{ url: item.url, filename, isVideo }];
  });
}

function StepValue({ value, type }: { value: JsonValue; type?: string }) {
  const media = stepMediaItems(value, type);
  if (media.length) return <div className="workflow-run-step-media">{media.map((item, index) => item.isVideo
    ? <video src={item.url} controls preload="metadata" key={`${item.url}-${index}`} aria-label={item.filename} />
    : <a href={item.url} target="_blank" rel="noreferrer" key={`${item.url}-${index}`}><img src={item.url} alt={item.filename} loading="lazy" /></a>)}</div>;
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

function RunOutput({ output, className = "workflow-run-output" }: { output: WorkflowRunOutput; className?: string }) {
  const media = output.type === "image" || output.type === "video" ? mediaItems(output.value) : [];
  return <article className={className}>
    <div className="workflow-run-output-heading"><strong>{output.label}</strong><small>{output.type}</small></div>
    {media.length ? <div className="workflow-run-media">{media.map((item) => output.type === "video"
      ? <video src={item.url} controls preload="metadata" key={item.url} aria-label={item.filename} />
      : <a href={item.url} target="_blank" rel="noreferrer" key={item.url}><img src={item.url} alt={item.filename} loading="lazy" /></a>)}</div>
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
}: {
  result: WorkflowRunResult;
  inputValues?: Record<string, JsonValue>;
  onOpenRuns?: () => void;
  onCancelRun?: () => void;
  onResumeRun?: () => void;
  resumePending?: boolean;
}) {
  const [copied, setCopied] = useState(false);
  const cancelled = result.status === "cancelled";
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
        <div><h3>{result.status === "completed" ? "运行完成" : cancelled ? "已取消运行" : result.status === "running" ? "正在运行" : "运行失败"}</h3><span>{result.items?.length ? `${result.items.filter((item) => item.status === "completed").length}/${result.items.length} 项完成` : `${result.steps.filter((step) => step.status === "completed").length} 步完成 · ${result.steps.filter((step) => step.status === "skipped").length} 步跳过${iterationCount ? ` · ${iterationSteps.length} 个步骤逐项执行 ${iterationCount} 项` : ""}`}</span></div>
        <small>{result.runId.slice(0, 8)}</small>
      </div>
      {result.status === "running" && onCancelRun && <button className="text-button workflow-run-cancel" type="button" onClick={onCancelRun}><Square size={13} />取消运行</button>}
      {onResumeRun && <button className="text-button workflow-run-resume" type="button" onClick={onResumeRun} disabled={resumePending}><RotateCcw size={13} />{resumePending ? "正在启动续跑" : result.status === "failed" ? "从失败步骤继续" : "从断点继续"}</button>}
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
          const inputValues = step.inputs ?? {};
          const outputValues = step.outputs ?? {};
          const inputKeys = Object.keys(inputValues);
          const outputKeys = [...new Set([...Object.keys(step.outputLabels ?? {}), ...Object.keys(outputValues)])];
          return <li key={step.stepId} className={step.status}>
            <details className="workflow-run-step">
              <summary className="workflow-run-step-summary">
                <span className="workflow-run-step-name"><ChevronRight size={14} /><strong>{step.name}</strong></span>
                <span className="workflow-run-step-meta"><span className={`workflow-run-step-status ${step.status}`}>{stepStatusLabel(step.status)}</span>{step.message && <small>{step.message}</small>}<span>{inputKeys.length} 个输入 · {outputKeys.length} 个输出</span></span>
              </summary>
              <div className="workflow-run-step-content">
                <section className="workflow-run-step-section">
                  <div className="workflow-run-step-section-heading"><strong>输入</strong><small>{inputKeys.length}</small></div>
                  {inputKeys.length ? <dl>{inputKeys.map((key) => <div className="workflow-run-step-value" key={key}><dt>{step.inputLabels?.[key] ?? key}<small>{step.inputLabels?.[key] ? key : ""}</small></dt><dd><StepValue value={inputValues[key]} /></dd></div>)}</dl> : <p className="workflow-run-step-empty">未配置步骤输入</p>}
                </section>
                <section className="workflow-run-step-section">
                  <div className="workflow-run-step-section-heading"><strong>输出</strong><small>{outputKeys.length}</small></div>
                  {outputKeys.length ? <dl>{outputKeys.map((key) => <div className="workflow-run-step-value" key={key}><dt>{step.outputLabels?.[key] ?? key}<small>{step.outputLabels?.[key] ? key : ""}</small></dt><dd>{Object.prototype.hasOwnProperty.call(outputValues, key) ? <StepValue value={outputValues[key]} type={step.outputTypes?.[key]} /> : <p className="workflow-run-step-empty">{step.status === "running" ? "步骤完成后生成" : step.status === "skipped" ? "步骤未执行" : "尚未生成"}</p>}</dd></div>)}</dl> : <p className="workflow-run-step-empty">此步骤没有定义输出</p>}
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
                        <summary><strong>第 {item.index + 1} 项</strong><span className={`workflow-run-step-status ${item.status}`}>{stepItemStatusLabel(item.status)}</span><small>{outputValueLabel(item.value)}</small></summary>
                        <div className="workflow-run-step-item-content">
                          {item.error && <div className="workflow-run-item-error">{item.error}</div>}
                          <div className="workflow-run-step-item-values">
                            <section><div className="workflow-run-step-section-heading"><strong>输入</strong><small>{itemInputKeys.length}</small></div>{itemInputKeys.length ? <dl>{itemInputKeys.map((key) => <div className="workflow-run-step-value" key={key}><dt>{step.inputLabels?.[key] ?? key}<small>{step.inputLabels?.[key] ? key : ""}</small></dt><dd><StepValue value={itemInputValues[key]} /></dd></div>)}</dl> : <p className="workflow-run-step-empty">未配置步骤输入</p>}</section>
                            <section><div className="workflow-run-step-section-heading"><strong>输出</strong><small>{itemOutputKeys.length}</small></div>{itemOutputKeys.length ? <dl>{itemOutputKeys.map((key) => <div className="workflow-run-step-value" key={key}><dt>{step.outputLabels?.[key] ?? key}<small>{step.outputLabels?.[key] ? key : ""}</small></dt><dd>{Object.prototype.hasOwnProperty.call(itemOutputValues, key) ? <StepValue value={itemOutputValues[key]} type={step.outputTypes?.[key]} /> : <p className="workflow-run-step-empty">尚未生成</p>}</dd></div>)}</dl> : <p className="workflow-run-step-empty">此项没有输出</p>}</section>
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
        {result.outputs.map((output) => <RunOutput key={output.key} output={output} />)}
      </div>}
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
