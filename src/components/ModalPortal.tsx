import type { ReactNode } from "react";
import { createPortal } from "react-dom";

/** Keep fixed dialogs outside animated/scrolling page containers. */
export default function ModalPortal({ children }: { children: ReactNode }) {
  // 静态标记生成（Node）没有 document：直接渲染子节点；浏览器里仍走 portal。
  if (typeof document === "undefined") return <>{children}</>;
  return createPortal(children, document.body);
}
