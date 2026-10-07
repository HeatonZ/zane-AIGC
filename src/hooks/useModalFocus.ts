import { useEffect, useRef } from "react";

const modalStack: HTMLElement[] = [];

export function useModalFocus(onClose: () => void, busy = false) {
  const container = useRef<HTMLElement>(null);
  const latest = useRef({ onClose, busy }); latest.current = { onClose, busy };
  useEffect(() => {
    const element = container.current;
    if (!element) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    modalStack.push(element);
    const selector = 'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), summary, [tabindex="0"]';
    element.querySelector<HTMLElement>(selector)?.focus({ preventScroll: true });
    const keyboard = (event: KeyboardEvent) => {
      if (modalStack.at(-1) !== element) return;
      if (event.key === "Escape" && !latest.current.busy) {
        event.preventDefault(); latest.current.onClose(); return;
      }
      if (event.key !== "Tab") return;
      const controls = [...element.querySelectorAll<HTMLElement>(selector)].filter(control => control.getClientRects().length > 0);
      if (!controls.length) { event.preventDefault(); return; }
      const first = controls[0], last = controls.at(-1)!;
      if (event.shiftKey && (document.activeElement === first || !element.contains(document.activeElement))) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && (document.activeElement === last || !element.contains(document.activeElement))) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener("keydown", keyboard);
    return () => {
      document.removeEventListener("keydown", keyboard);
      const index = modalStack.indexOf(element);
      if (index >= 0) modalStack.splice(index, 1);
      const next = modalStack.at(-1);
      if (previous?.isConnected && (!next || next.contains(previous))) previous.focus({ preventScroll: true });
    };
  }, []);
  return container;
}
