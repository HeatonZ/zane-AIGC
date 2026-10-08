import ModalPortal from "./ModalPortal";
import { feedbackMessageMaxLength } from "../../server/domain/feedbackContracts.js";
import { useEffect, useRef, useState } from "react";
import { LoaderCircle, X } from "lucide-react";
import type { RerunPlan, RerunRequest } from "../../server/domain/rerunContracts.js";
import type { WorkflowRunRecord, WorkflowStepDefinition } from "../types";
import { previewWorkflowRerun, pickLocalMediaFile } from "../lib/api";
import { buildRerunChanges, canFeedbackStep, editableOutputs, editableStep, outputDraft, type RerunMode } from "../lib/rerunEditing";
import { capabilityForStep } from "../lib/capabilities";
import { useModalFocus } from "../hooks/useModalFocus";
import { useCapabilities } from "../hooks/useCapabilities";
import CapabilityConfigEditor from "./CapabilityConfigEditor";
import RunValueView from "./RunValueView";
export interface RerunTarget { stepId?: string; itemIndex?: number; mode?: RerunMode }
export default function RerunDialog({ run, target, onClose, onSubmit }: { run: WorkflowRunRecord; target: RerunTarget; onClose(): void; onSubmit(changes: RerunRequest): Promise<void> }) {
  const steps = run.workflow?.steps ?? [];
  const [stepId, setStepId] = useState(target.stepId ?? steps[0]?.id ?? "");
  const [scope, setScope] = useState(target.itemIndex === undefined ? "all" : String(target.itemIndex));
  const [mode, setMode] = useState<RerunMode>(target.mode ?? "rerun");
  const [draftStep, setDraftStep] = useState<WorkflowStepDefinition>(() => editableStep(run, stepId, target.itemIndex));
  const [feedback, setFeedback] = useState("");
  const [outputDrafts, setOutputDrafts] = useState<Record<string, string>>({});
  const [plan, setPlan] = useState<RerunPlan | null>(null);
  const [previewedChanges, setPreviewedChanges] = useState<RerunRequest | null>(null);
  const [configDraftErrors, setConfigDraftErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState(""); const [pending, setPending] = useState(false); const [submitting, setSubmitting] = useState(false);
  const requestRef = useRef<AbortController | null>(null);
  const { capabilities } = useCapabilities();
  const modalRef = useModalFocus(onClose, submitting);
  const selectionRef = useRef({ stepId, scope }); selectionRef.current = { stepId, scope };
  const itemIndex = scope === "all" ? undefined : Number(scope);
  const record = run.steps.find((step) => step.stepId === stepId);
  const selectedItem = record?.items?.find((item) => item.index === itemIndex);
  const definition = capabilityForStep(draftStep, capabilities);
  const references = [...(run.workflow?.inputs.map((input) => ({ value: "input." + input.key, label: input.label })) ?? []), ...steps.slice(0, steps.findIndex((step) => step.id === stepId)).flatMap((step) => step.outputs.map((output) => ({ value: "step." + step.id + ".outputs." + output.key, label: step.name + " · " + output.label }))), ...(itemIndex === undefined ? [] : [{ value: "iteration.item", label: "当前遍历项" }])];
  const canFeedback = canFeedbackStep(run, stepId, itemIndex);
  const canReplace = record?.status === "completed" && (itemIndex === undefined ? record?.status : selectedItem?.status) === "completed" && !(draftStep.execution?.mode === "for_each" && itemIndex === undefined);
  function invalidate() { requestRef.current?.abort(); requestRef.current = null; setPending(false); setPlan(null); setPreviewedChanges(null); setError(""); }
  useEffect(() => {
    const current = editableStep(run, stepId, itemIndex); setDraftStep(current); setConfigDraftErrors({}); setFeedback("");
    const outputs = editableOutputs(run, stepId, itemIndex);
    setOutputDrafts(Object.fromEntries(current.outputs.filter((output) => Object.prototype.hasOwnProperty.call(outputs, output.key)).map((output) => [output.key, outputDraft(output.type, outputs[output.key])])));
    invalidate();
  }, [run.runId, stepId, scope]);
  useEffect(() => () => requestRef.current?.abort(), []);
  function changeInput(index: number, changes: Partial<WorkflowStepDefinition["inputs"][number]>) {
    invalidate(); setDraftStep((current) => {
      const input = current.inputs[index]; const next = { ...input, ...changes };
      return { ...current, inputs: current.inputs.map((item, position) => position === index ? next : item), ...(definition?.editor.inputs === "bindings" && current.comfyui ? { comfyui: { ...current.comfyui, bindings: current.comfyui.bindings.map((binding) => binding.direction === "input" && binding.key === input.key ? { ...binding, sourceRef: next.sourceRef, valueSource: next.valueSource, literalValue: next.literalValue, ...(next.valueSource === "literal" ? { type: next.literalType ?? binding.type } : {}) } : binding) } } : {}) };
    });
  }
  async function preview() {
    invalidate();
    if (mode === "rerun" && Object.keys(configDraftErrors).length) { setError("先修正能力配置：" + Object.values(configDraftErrors).join("；")); return; }
    const controller = new AbortController(); requestRef.current = controller;
    try {
      const changes = buildRerunChanges(run, stepId, itemIndex, mode, draftStep, outputDrafts, feedback); setPending(true);
      const next = await previewWorkflowRerun(run.runId, changes, controller.signal);
      if (!controller.signal.aborted) { setPlan(next); setPreviewedChanges(changes); }
    } catch (reason) { if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : "无法规划局部重做"); }
    finally { if (!controller.signal.aborted) setPending(false); }
  }
  async function submit() {
    if (!previewedChanges) return; setSubmitting(true); setError("");
    try { await onSubmit(previewedChanges); onClose(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "无法提交局部重做"); }
    finally { setSubmitting(false); }
  }
  async function chooseMedia(key: string, type: "image" | "video") {
    const selected = { ...selectionRef.current };
    try { const result = await pickLocalMediaFile(type); if (result && selected.stepId === selectionRef.current.stepId && selected.scope === selectionRef.current.scope) { invalidate(); setOutputDrafts((current) => ({ ...current, [key]: JSON.stringify([result], null, 2) })); } }
    catch (reason) { setError(reason instanceof Error ? reason.message : "无法选择文件"); }
  }
  return <ModalPortal><div className="modal-backdrop"><section ref={modalRef} className="rerun-dialog" role="dialog" aria-modal="true" aria-labelledby="rerun-title">
    <header><div><h2 id="rerun-title">{mode === "feedback" ? "反馈并重做 Hermes 结果" : "修改结果与局部重做"}</h2><p>基于 {run.runTitle || run.workflowName} 创建新版本；原记录和结果保持不变。</p></div><button className="icon-button" type="button" onClick={onClose} disabled={submitting} aria-label="关闭局部重做"><X size={18} /></button></header>
    <fieldset className="rerun-dialog-body" disabled={submitting}>
      <div className="rerun-selectors"><label className="field-group"><span className="field-label">目标步骤</span><select className="text-input" value={stepId} disabled={submitting} onChange={(event) => { invalidate(); setStepId(event.target.value); setScope("all"); }}>{steps.map((step, index) => <option key={step.id} value={step.id}>{index + 1}. {step.name}</option>)}</select></label>
        {draftStep.execution?.mode === "for_each" && <label className="field-group"><span className="field-label">修改范围</span><select className="text-input" value={scope} disabled={submitting} onChange={(event) => { invalidate(); setScope(event.target.value); }}><option value="all">整个步骤</option>{record?.items?.map((item) => <option key={item.index} value={item.index}>第 {item.index + 1} 项 · {item.status === "completed" ? "已完成" : item.status === "failed" ? "失败" : item.status}</option>)}</select></label>}
        <label className="field-group"><span className="field-label">操作</span><select className="text-input" value={mode} disabled={submitting} onChange={(event) => { invalidate(); setMode(event.target.value as RerunMode); }}><option value="feedback" disabled={!canFeedback}>反馈并重做 Hermes 结果</option><option value="rerun">修改参数 / 重新生成</option><option value="replace">直接替换生成结果</option></select></label></div>
      {mode === "feedback" ? <section className="hermes-feedback-editor">
        <p className="rerun-note">指出哪里不好、希望怎样修改。系统会把反馈和原结果一起交给 Hermes，保留未受影响的前序与独立步骤，并重算依赖此结果的下游。反馈只影响本次修订链，不修改已发布场景的提示词。</p>
        {!canFeedback && <p className="notice error">只能反馈已有结果的 Hermes 步骤；逐项反馈请选择已完成的一项。</p>}
        <label className="field-group"><span className="field-label">反馈意见{itemIndex === undefined ? "（整个步骤）" : "（仅第 " + (itemIndex + 1) + " 项）"}</span><textarea className="text-input text-area" rows={6} value={feedback} maxLength={feedbackMessageMaxLength} disabled={!canFeedback || submitting} onChange={event => { invalidate(); setFeedback(event.target.value); }} placeholder="例如：开头铺垫太长，缺少冲突；请在前两秒直接呈现矛盾，保留人物设定和结尾。" /><small>无需重写提示词。请描述问题和期望结果；提交后可能产生模型及下游生成费用。</small></label>
      </section> : mode === "rerun" ? <>
        <p className="rerun-note">不改参数也可以重做。选择单项时，其余成功项会保留；不能证明独立的下游依赖会保守重算。</p>
        {definition && <CapabilityConfigEditor key={run.runId + ":" + stepId + ":" + scope} step={draftStep} definition={definition} references={references} onChange={(next) => { invalidate(); setDraftStep(next); }} onDraftChange={(key, message) => { invalidate(); setConfigDraftErrors((current) => { const next = { ...current }; if (message) next[key] = message; else delete next[key]; return next; }); }} />}
        {!!draftStep.inputs.length && <section className="designer-subsection"><h3>本次步骤输入{itemIndex === undefined ? "" : "（仅当前项）"}</h3><p className="rerun-note">可替换输入引用，或改为固定值；不修改场景的原始配置。</p>{draftStep.inputs.map((input, index) => <div className="rerun-input-row" key={input.key}>
          <strong>{input.label || input.key}</strong><select className="text-input" aria-label={input.key + "取值方式"} value={input.valueSource ?? "reference"} onChange={(event) => changeInput(index, { valueSource: event.target.value as "reference" | "literal", literalType: input.literalType ?? "text" })}><option value="reference">引用</option><option value="literal">固定值</option></select>
          {input.valueSource === "literal" ? <><select className="text-input" aria-label={input.key + "固定值类型"} value={input.literalType ?? "text"} onChange={(event) => changeInput(index, { literalType: event.target.value as NonNullable<typeof input.literalType> })}>{["text", "number", "boolean", "json", "image_list", "video_list", "audio_list"].map((type) => <option key={type}>{type}</option>)}</select><textarea className="text-input" aria-label={input.key + "固定值"} rows={2} value={input.literalValue ?? ""} onChange={(event) => changeInput(index, { literalValue: event.target.value })} /></> : <input className="text-input" aria-label={input.key + "输入引用"} list="rerun-input-refs" value={input.sourceRef} onChange={(event) => changeInput(index, { sourceRef: event.target.value })} />}
        </div>)}<datalist id="rerun-input-refs">{references.map((ref) => <option key={ref.value} value={ref.value}>{ref.label}</option>)}</datalist></section>}
        {definition?.editor.profile && <label className="field-group"><span className="field-label">Hermes Profile</span><input className="text-input" value={draftStep.hermesProfile ?? ""} disabled={submitting} onChange={(event) => { invalidate(); setDraftStep((current) => ({ ...current, hermesProfile: event.target.value })); }} /></label>}
        {definition?.editor.prompt && <label className="field-group"><span className="field-label">本次提示词{itemIndex === undefined ? "" : "（仅当前项）"}</span><textarea className="text-input prompt-textarea" value={draftStep.promptTemplate} disabled={submitting} onChange={(event) => { invalidate(); setDraftStep((current) => ({ ...current, promptTemplate: event.target.value })); }} /></label>}
      </> : <>
        {!canReplace && <p className="notice error">只能替换已完成的结果；逐项步骤需先选择具体一项。</p>}
        {draftStep.outputs.filter((output) => output.key in outputDrafts).map((output) => <label className="field-group" key={output.key}><span className="field-label">{output.label || output.key} · {output.type}</span><textarea className="text-input" rows={output.type === "text" ? 5 : 7} value={outputDrafts[output.key]} disabled={!canReplace || submitting} onChange={(event) => { invalidate(); setOutputDrafts((current) => ({ ...current, [output.key]: event.target.value })); }} />
          {(output.type === "image_list" || output.type === "image" || output.type === "video_list" || output.type === "video") && <button className="text-button" type="button" disabled={!canReplace || submitting} onClick={() => void chooseMedia(output.key, output.type.startsWith("image") ? "image" : "video")}>选择本地文件替换</button>}
          {output.type !== "text" && <small>使用 JSON 表示；媒体可以填写路径数组或保留附件对象。</small>}
        </label>)}
      </>}
      <details className="run-input-snapshot"><summary>查看原结果</summary><RunValueView value={editableOutputs(run, stepId, itemIndex)} type="json" /></details>
      {error && <div className="notice error" role="alert">{error}</div>}
      {plan && <section className="rerun-plan" aria-label="局部重做计划"><h3>本次执行计划</h3><p>将重算 {plan.steps.filter((step) => step.action === "run").length} 个步骤，保留或替换 {plan.steps.filter((step) => step.action !== "run").length} 个步骤。</p><ol>{plan.steps.map((step) => <li key={step.stepId} data-action={step.action}><strong>{step.name}</strong><span>{step.action === "reuse" ? "复用" : step.action === "replace" ? "替换" : "重算"}</span><small>{step.reason}{step.runItemIndexes ? " · 第 " + step.runItemIndexes.map((index) => index + 1).join("、") + " 项重做；复用 " + (step.reuseItemIndexes?.length ?? 0) + " 项" : ""}</small></li>)}</ol></section>}
    </fieldset>
    <footer><button className="button button-outline" type="button" onClick={onClose} disabled={submitting}>取消</button><button className="button button-outline" type="button" onClick={() => void preview()} disabled={pending || submitting || (mode === "replace" && !canReplace) || (mode === "feedback" && (!canFeedback || !feedback.trim()))}>{pending && <LoaderCircle className="spin" size={14} />}预览影响范围</button><button className="button button-primary" type="button" onClick={() => void submit()} disabled={!previewedChanges || pending || submitting}>{submitting ? "正在提交…" : mode === "feedback" ? "提交反馈并创建修订版" : "创建新版本并执行"}</button></footer>
  </section></div></ModalPortal>;
}
