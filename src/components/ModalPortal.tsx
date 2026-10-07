import type { ReactNode } from "react";
import { createPortal } from "react-dom";

/** Keep fixed dialogs outside animated/scrolling page containers. */
export default function ModalPortal({ children }: { children: ReactNode }) {
  return createPortal(children, document.body);
}
