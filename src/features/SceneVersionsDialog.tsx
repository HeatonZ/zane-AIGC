import { Check, Clock3, Rocket, X } from "lucide-react";
import type { SceneVersion, SceneVersionRecord } from "../types";

interface SceneVersionsDialogProps {
  sceneTitle: string;
  record?: SceneVersionRecord;
  onClose: () => void;
  onApply: (version: SceneVersion) => void;
}

function formatPublishedAt(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "发布时间未知";
  return new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "short" }).format(date);
}

export default function SceneVersionsDialog({ sceneTitle, record, onClose, onApply }: SceneVersionsDialogProps) {
  const versions = [...(record?.versions ?? [])].sort((left, right) => right.publishedAt.localeCompare(left.publishedAt));

  return (
    <div className="scene-versions-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section className="scene-versions-dialog" role="dialog" aria-modal="true" aria-labelledby="scene-versions-title">
        <header className="scene-versions-heading">
          <div><h2 id="scene-versions-title">{sceneTitle} · 发布版本</h2><p>最近保留 {versions.length} 个版本</p></div>
          <button type="button" className="icon-button" onClick={onClose} title="关闭" aria-label="关闭"><X size={17} /></button>
        </header>
        {versions.length ? <ol className="scene-version-list">
          {versions.map((version) => {
            const published = version.id === record?.publishedVersionId;
            return <li key={version.id} className={published ? "current" : ""}>
              <div className="scene-version-marker">{published ? <Check size={13} /> : <Clock3 size={13} />}</div>
              <div className="scene-version-copy">
                <div><strong>v{version.version} · {version.scene.title}</strong>{published && <span>当前发布</span>}</div>
                <small>{formatPublishedAt(version.publishedAt)}</small>
                {version.scene.summary && <p>{version.scene.summary}</p>}
              </div>
              <button className="button button-outline scene-version-apply" onClick={() => { onApply(version); onClose(); }}>
                <Rocket size={13} />应用到暂存
              </button>
            </li>;
          })}
        </ol> : <div className="scene-versions-empty"><Clock3 size={17} /><span>这个场景还没有发布版本。</span></div>}
      </section>
    </div>
  );
}
