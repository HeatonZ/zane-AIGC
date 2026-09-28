import { Check, Copy, History as HistoryIcon, Square } from "lucide-react";
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

export default function WorkflowRunPanel({
  result,
  inputValues,
  onOpenRuns,
  onCancelRun,
}: {
  result: WorkflowRunResult;
  inputValues?: Record<string, JsonValue>;
  onOpenRuns?: () => void;
  onCancelRun?: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const cancelled = result.status === "cancelled";

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
        <div><h3>{result.status === "completed" ? "运行完成" : cancelled ? "已取消运行" : result.status === "running" ? "正在运行" : "运行失败"}</h3><span>{result.steps.filter((step) => step.status === "completed").length} 步完成 · {result.steps.filter((step) => step.status === "skipped").length} 步跳过</span></div>
        <small>{result.runId.slice(0, 8)}</small>
      </div>
      {result.status === "running" && onCancelRun && <button className="text-button workflow-run-cancel" type="button" onClick={onCancelRun}><Square size={13} />取消运行</button>}
      {result.error && <div className="workflow-run-error" role="alert">{result.error}</div>}
      {result.archiveWarnings?.length ? <div className="workflow-run-warning" role="status">部分生成媒体没有复制到项目目录：{result.archiveWarnings.join("；")}</div> : null}
      {inputValues && <details className="run-input-snapshot"><summary>查看本次输入</summary><pre>{JSON.stringify(inputValues, null, 2)}</pre></details>}
      <ol className="workflow-run-steps">
        {result.steps.map((step) => <li key={step.stepId} className={step.status}><span>{step.name}</span><small>{step.status === "completed" ? "完成" : step.status === "skipped" ? "跳过" : step.status === "running" ? "运行中" : "失败"}{step.message ? ` · ${step.message}` : ""}</small></li>)}
      </ol>
      {!!result.outputs.length && <div className="workflow-run-outputs">
        {result.outputs.map((output) => {
          const media = output.type === "image" || output.type === "video" ? mediaItems(output.value) : [];
          return <article className="workflow-run-output" key={output.key}>
            <div className="workflow-run-output-heading"><strong>{output.label}</strong><small>{output.type}</small></div>
            {media.length ? <div className="workflow-run-media">{media.map((item) => output.type === "video"
              ? <video src={item.url} controls preload="metadata" key={item.url} aria-label={item.filename} />
              : <a href={item.url} target="_blank" rel="noreferrer" key={item.url}><img src={item.url} alt={item.filename} loading="lazy" /></a>)}</div>
              : <pre>{outputText(output)}</pre>}
          </article>;
        })}
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
