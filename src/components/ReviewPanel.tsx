import { feedbackMessageMaxLength } from "../../server/domain/feedbackContracts.js";
import { useState } from "react";
import type { JsonValue, WorkflowRunRecord } from "../types";
import { reviewWorkflowRun } from "../lib/api";
import { outputDraft, parseOutputDraft } from "../lib/rerunEditing";
import { AssetPickerDialog } from "./AssetBrowser";
export default function ReviewPanel({ run, onSubmitted }: { run: WorkflowRunRecord; onSubmitted(): void }) {
  const review = run.pendingReview!; const step = run.steps.find(step => step.stepId === review.stepId)!;
  const definition = run.workflow?.steps.find(step => step.id === review.stepId);
  const [drafts, setDrafts] = useState<Record<string,string>>(() => Object.fromEntries(Object.entries(step.outputs ?? {}).map(([key,value]) => [key, outputDraft(step.outputTypes?.[key] ?? "json", value)])));
  const [feedback, setFeedback] = useState("");
  const [prompt, setPrompt] = useState(definition?.promptTemplate ?? ""); const [busy, setBusy] = useState(false); const [error, setError] = useState(""); const [assetKey, setAssetKey] = useState<string | null>(null);
  const iterative = Boolean(step.items?.length || definition?.execution?.mode === "for_each");
  async function submit(action: "approve" | "redo") { setBusy(true); setError(""); try {
    const outputs: Record<string,JsonValue> = {};
    if (action === "approve" && !iterative) for (const [key,draft] of Object.entries(drafts)) {
      const type = step.outputTypes?.[key] ?? "json";
      if (draft !== outputDraft(type, step.outputs?.[key])) outputs[key] = parseOutputDraft(type, draft);
    }
    await reviewWorkflowRun(run.runId, { reviewId: review.id, action, ...(action === "redo" && feedback.trim() ? { feedback: feedback.trim() } : {}), ...(Object.keys(outputs).length ? { outputs } : {}), ...(action === "redo" && prompt !== definition?.promptTemplate ? { stepChanges: { promptTemplate: prompt } } : {}) }); onSubmitted();
  } catch (reason) { setError((reason as Error).message); } finally { setBusy(false); } }
  return <section className="production-review" aria-label="人工确认关卡"><h3>等待确认：{review.name}</h3><p>{review.instruction || "请检查此步骤结果。确认后才会继续执行后续步骤。"}</p>
    {!iterative && <details><summary>修改结果后确认</summary>{Object.entries(drafts).map(([key,value]) => { const type = step.outputTypes?.[key] ?? "json"; const media = /^(image|video|audio)(_list)?$/.test(type); return <label className="field-group" key={key}><span>{step.outputLabels?.[key] ?? key}{type !== "text" ? "（JSON）" : ""}</span><textarea className="text-input text-area" value={value} onChange={event => setDrafts(current => ({ ...current, [key]: event.target.value }))} disabled={busy} />{media && <button type="button" className="text-button" disabled={busy} onClick={() => setAssetKey(key)}>从素材库替换</button>}</label>; })}</details>}
    {iterative && <p className="studio-field-hint">本关卡确认整批结果；需要调整单项时可先取消，再使用局部重做。</p>}
    {definition?.kind === "hermes" && <label className="field-group hermes-feedback-editor"><span className="field-label">退回重做的反馈意见</span><textarea className="text-input text-area" rows={4} value={feedback} maxLength={feedbackMessageMaxLength} disabled={busy} onChange={event => setFeedback(event.target.value)} placeholder="描述哪里不满意，以及希望怎样修改…" /><small>退回时将反馈和原结果交给 Hermes；确认并继续不会提交这里的意见。整批反馈会应用于各项结果。</small></label>}
    {definition && <details><summary>退回重做时修改提示词</summary><textarea className="text-input text-area" value={prompt} onChange={event => setPrompt(event.target.value)} disabled={busy} /><p className="studio-field-hint">此处仅在点击“退回重做”时生效；已完成的前序步骤不会重跑。</p></details>}
    {assetKey && <AssetPickerDialog kind={(step.outputTypes?.[assetKey] ?? "image").startsWith("video") ? "video" : (step.outputTypes?.[assetKey] ?? "").startsWith("audio") ? "audio" : "image"} onClose={() => setAssetKey(null)} onPick={reference => setDrafts(current => ({ ...current, [assetKey]: JSON.stringify([reference],null,2) }))} />}
    {error && <p className="production-inline-error" role="alert">{error}</p>}<div className="production-toolbar"><button className="button button-primary" disabled={busy} onClick={() => void submit("approve")}>{busy ? "提交中…" : "确认并继续"}</button><button className="button button-outline" disabled={busy} onClick={() => void submit("redo")}>退回重做本步骤</button></div><small>等待状态已保存，可以关闭页面后回来继续。</small>
  </section>;
}
