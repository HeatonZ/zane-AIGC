import { useRef, useState } from "react";
import ModalPortal from "./ModalPortal";
import { useModalFocus } from "../hooks/useModalFocus";

export interface ConfirmRequest {
  title?: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  /** 破坏性/费用类操作使用警示按钮样式，默认按普通确认。 */
  tone?: "default" | "danger";
}

interface PendingConfirm extends ConfirmRequest {
  resolve: (confirmed: boolean) => void;
}

export function ConfirmDialog({ request, onSettle }: { request: PendingConfirm; onSettle: (confirmed: boolean) => void }) {
  const busy = useRef(false);
  const container = useModalFocus(() => settle(false), false);
  function settle(confirmed: boolean) {
    if (busy.current) return;
    busy.current = true;
    onSettle(confirmed);
  }
  return (
    <ModalPortal>
      <div className="modal-backdrop" onClick={() => settle(false)}>
        <section className="modal-card confirm-dialog" role="alertdialog" aria-modal="true" aria-label={request.title ?? "确认操作"} ref={container} onClick={(event) => event.stopPropagation()}>
          <header><h2>{request.title ?? "确认操作"}</h2></header>
          <p className="confirm-dialog-message">{request.message}</p>
          <footer className="confirm-dialog-actions">
            <button type="button" className="button button-outline" onClick={() => settle(false)}>{request.cancelLabel ?? "取消"}</button>
            <button type="button" className={"button " + (request.tone === "danger" ? "button-danger" : "button-dark")} autoFocus onClick={() => settle(true)}>{request.confirmLabel ?? "确定"}</button>
          </footer>
        </section>
      </div>
    </ModalPortal>
  );
}

/** 统一的确认对话框；替代会阻塞事件循环的原生 window.confirm/alert。 */
export function useConfirmDialog() {
  const [pending, setPending] = useState<PendingConfirm>();
  const confirm = (request: ConfirmRequest) => new Promise<boolean>((resolve) => setPending({ ...request, resolve }));
  const settle = (confirmed: boolean) => {
    setPending((current) => { current?.resolve(confirmed); return undefined; });
  };
  return { confirm, dialog: pending ? <ConfirmDialog request={pending} onSettle={settle} /> : null };
}
