import ModalPortal from "./ModalPortal";
import { useModalFocus } from "../hooks/useModalFocus";
import { X } from "lucide-react";
import type { WorkflowRunRecord } from "../types";
import WorkflowRunPanel from "./WorkflowRunPanel";
export default function RunComparisonDialog({ original, revised, onClose }: { original: WorkflowRunRecord; revised: WorkflowRunRecord; onClose(): void }) {
  const modalRef = useModalFocus(onClose);
  return <ModalPortal><div className="modal-backdrop"><section ref={modalRef} className="rerun-dialog run-comparison-dialog" role="dialog" aria-modal="true" aria-labelledby="run-comparison-title"><header><div><h2 id="run-comparison-title">原结果与修订结果</h2><p>两个版本独立保存，查看对比不会覆盖任何结果。</p></div><button className="icon-button" onClick={onClose} aria-label="关闭版本对比"><X size={18} /></button></header><div className="run-comparison-columns"><section><h3>原运行 · {original.runId.slice(0, 8)}</h3><WorkflowRunPanel result={original} /></section><section><h3>修订运行 · {revised.runId.slice(0, 8)}</h3><WorkflowRunPanel result={revised} /></section></div></section></div></ModalPortal>;
}
