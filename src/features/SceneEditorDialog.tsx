import { useEffect, useState, type FormEvent } from "react";
import { Check, X } from "lucide-react";
import type { SceneDetails, SceneModule } from "../types";

interface SceneEditorDialogProps {
  scene?: SceneModule;
  onClose: () => void;
  onSave: (details: SceneDetails) => void;
}

function detailsFromScene(scene?: SceneModule): SceneDetails {
  return scene ? {
    title: scene.title,
    shortTitle: scene.shortTitle,
    summary: scene.summary,
    description: scene.description,
    cover: scene.cover,
    coverPosition: scene.coverPosition,
    accent: scene.accent,
    stages: scene.stages,
  } : {
    title: "",
    shortTitle: "",
    summary: "",
    description: "",
    cover: "",
    coverPosition: "center",
    accent: "green",
    stages: [],
  };
}

export default function SceneEditorDialog({ scene, onClose, onSave }: SceneEditorDialogProps) {
  const [details, setDetails] = useState(() => detailsFromScene(scene));
  const [stagesText, setStagesText] = useState(() => (scene?.stages ?? []).join("\n"));

  useEffect(() => {
    const next = detailsFromScene(scene);
    setDetails(next);
    setStagesText(next.stages.join("\n"));
  }, [scene]);

  useEffect(() => {
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [onClose]);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const title = details.title.trim();
    if (!title) return;
    const stages = stagesText.split("\n").map((stage) => stage.trim()).filter(Boolean);
    onSave({
      ...details,
      title,
      shortTitle: details.shortTitle.trim() || title,
      summary: details.summary.trim(),
      description: details.description.trim(),
      cover: details.cover.trim(),
      coverPosition: details.coverPosition?.trim() || "center",
      stages,
    });
  }

  function update<K extends keyof SceneDetails>(key: K, value: SceneDetails[K]) {
    setDetails((current) => ({ ...current, [key]: value }));
  }

  return (
    <div className="scene-dialog-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section className="scene-dialog" role="dialog" aria-modal="true" aria-labelledby="scene-dialog-title">
        <header className="scene-dialog-heading">
          <div><h2 id="scene-dialog-title">{scene ? "编辑场景" : "添加场景"}</h2><p>配置场景信息与工作台展示内容。</p></div>
          <button type="button" className="icon-button" onClick={onClose} title="关闭" aria-label="关闭"><X size={17} /></button>
        </header>
        <form className="scene-editor-form" onSubmit={submit}>
          <div className="scene-editor-grid">
            <label className="scene-editor-field"><span>场景名称 <i>必填</i></span><input className="text-input" autoFocus maxLength={40} value={details.title} onChange={(event) => update("title", event.target.value)} placeholder="例如：短片制作" required /></label>
            <label className="scene-editor-field"><span>简称</span><input className="text-input" maxLength={16} value={details.shortTitle} onChange={(event) => update("shortTitle", event.target.value)} placeholder="用于导航和记录" /></label>
            <label className="scene-editor-field scene-editor-wide"><span>简介</span><input className="text-input" maxLength={100} value={details.summary} onChange={(event) => update("summary", event.target.value)} placeholder="一句话说明这个场景" /></label>
            <label className="scene-editor-field scene-editor-wide"><span>场景说明</span><textarea className="text-input scene-editor-textarea" maxLength={240} value={details.description} onChange={(event) => update("description", event.target.value)} placeholder="说明这个场景的用途" /></label>
            <label className="scene-editor-field scene-editor-wide"><span>封面图片 URL</span><input className="text-input" type="url" value={details.cover} onChange={(event) => update("cover", event.target.value)} placeholder="https://..." /></label>
            <label className="scene-editor-field"><span>封面位置</span><input className="text-input" value={details.coverPosition ?? "center"} onChange={(event) => update("coverPosition", event.target.value)} placeholder="center" /></label>
            <fieldset className="scene-editor-field scene-accent-field"><legend>强调色</legend><div className="scene-accent-options">
              <label><input type="radio" name="scene-accent" checked={details.accent === "green"} onChange={() => update("accent", "green")} /><span className="accent-swatch green" />绿色</label>
              <label><input type="radio" name="scene-accent" checked={details.accent === "coral"} onChange={() => update("accent", "coral")} /><span className="accent-swatch coral" />珊瑚色</label>
            </div></fieldset>
            <label className="scene-editor-field scene-editor-wide"><span>流程阶段 <small>每行一个阶段</small></span><textarea className="text-input scene-editor-textarea stage-editor-textarea" value={stagesText} onChange={(event) => setStagesText(event.target.value)} placeholder={"构思\n内容制作\n审核发布"} /></label>
          </div>
          <footer className="scene-dialog-actions"><button type="button" className="button button-outline" onClick={onClose}>取消</button><button type="submit" className="button button-dark"><Check size={15} />保存场景</button></footer>
        </form>
      </section>
    </div>
  );
}
