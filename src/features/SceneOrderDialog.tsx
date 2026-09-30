import { ArrowDown, ArrowUp, ChevronsDown, ChevronsUp, Sparkles, X } from "lucide-react";
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import type { SceneId, SceneModule } from "../types";

interface SceneOrderDialogProps {
  scenes: SceneModule[];
  onMoveScene: (sceneId: SceneId, targetIndex: number) => void;
  onClose: () => void;
}

export default function SceneOrderDialog({ scenes, onMoveScene, onClose }: SceneOrderDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [notice, setNotice] = useState("");

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    const previouslyFocused = document.activeElement;
    dialog.showModal();
    return () => {
      dialog.close();
      if (previouslyFocused instanceof HTMLElement && previouslyFocused.isConnected) previouslyFocused.focus();
    };
  }, []);

  function containTabFocus(event: KeyboardEvent<HTMLDialogElement>) {
    if (event.key !== "Tab") return;
    const buttons = event.currentTarget.querySelectorAll<HTMLButtonElement>("button:not(:disabled)");
    const first = buttons[0];
    const last = buttons[buttons.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last?.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first?.focus();
    }
  }

  function move(scene: SceneModule, targetIndex: number) {
    onMoveScene(scene.id, targetIndex);
    setNotice(`已将「${scene.title}」移至第 ${targetIndex + 1} 位`);
  }

  return (
    <dialog
      ref={dialogRef}
      className="scene-dialog scene-order-dialog"
      aria-labelledby="scene-order-title"
      aria-describedby="scene-order-description"
      onKeyDown={containTabFocus}
      onCancel={(event) => { event.preventDefault(); onClose(); }}
      onClick={(event) => {
        if (event.target !== event.currentTarget) return;
        const bounds = event.currentTarget.getBoundingClientRect();
        if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) onClose();
      }}
    >
      <div className="scene-dialog-heading">
        <div>
          <h2 id="scene-order-title">场景排序</h2>
          <p id="scene-order-description">常用场景放在前面，不常用的可以一键置底。</p>
        </div>
        <button className="icon-button" onClick={onClose} title="关闭" aria-label="关闭场景排序"><X size={17} /></button>
      </div>
      <ol className="scene-order-list" aria-label="场景顺序">
        {scenes.map((scene, index) => (
          <li className="scene-order-row" key={scene.id}>
            <span className="scene-order-number">{String(index + 1).padStart(2, "0")}</span>
            <span className={`scene-icon-box ${scene.accent}`} aria-hidden="true"><Sparkles size={16} /></span>
            <div className="scene-order-copy">
              <strong title={scene.title}>{scene.title}</strong>
              <small title={scene.summary}>{scene.summary || "自定义创作场景"}</small>
            </div>
            <div className="scene-order-actions" role="group" aria-label={`调整${scene.title}顺序`}>
              <button className="icon-button" onClick={() => move(scene, 0)} disabled={index === 0} title="置顶" aria-label={`置顶${scene.title}`}><ChevronsUp size={16} /></button>
              <button className="icon-button" onClick={() => move(scene, index - 1)} disabled={index === 0} title="上移" aria-label={`上移${scene.title}`}><ArrowUp size={15} /></button>
              <button className="icon-button" onClick={() => move(scene, index + 1)} disabled={index === scenes.length - 1} title="下移" aria-label={`下移${scene.title}`}><ArrowDown size={15} /></button>
              <button className="icon-button" onClick={() => move(scene, scenes.length - 1)} disabled={index === scenes.length - 1} title="置底" aria-label={`置底${scene.title}`}><ChevronsDown size={16} /></button>
            </div>
          </li>
        ))}
      </ol>
      {!scenes.length && <p className="scene-order-empty">还没有可排序的场景。</p>}
      <div className="scene-order-footer">
        <div>
          <p role="status">{notice || "顺序自动保存，所有场景列表同步更新。"}</p>
          <small>排序不影响流程内容，无需重新发布。</small>
        </div>
        <button className="button button-dark" onClick={onClose}>完成</button>
      </div>
    </dialog>
  );
}
