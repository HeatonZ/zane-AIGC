import { ArrowUpRight, Image } from "lucide-react";
import type { PageId, SceneId, SceneModule, WorkflowDraft } from "../types";
import ClipSelectionLibrary from "../components/ClipSelectionLibrary";
import AssetBrowser from "../components/AssetBrowser";
interface LibraryProps { drafts: WorkflowDraft[]; scenes: SceneModule[]; onNavigate: (page: PageId) => void; onOpenScene: (scene: SceneId, draftId?: string) => void; onOpenRun?: (runId: string) => void }
export default function Library({ drafts, scenes, onNavigate, onOpenScene, onOpenRun }: LibraryProps) {
  return <div className="library-page"><div className="welcome-row"><div><div className="eyebrow"><span className="eyebrow-line" />ASSET LIBRARY</div><h1>素材库</h1><p className="page-subtitle">管理员统一归档图片、视频与音频，用说明、分组和标签组织素材，供后续 AI 检索并引用固定版本。</p></div></div>
    <AssetBrowser />
    <ClipSelectionLibrary onOpenRun={id => { if (onOpenRun) onOpenRun(id); else onNavigate("runs"); }} />
    <div className="library-section-heading draft-library-heading"><div><h2>任务草稿</h2><p>{drafts.length ? drafts.length + " 份已保存" : "已保存的业务构想"}</p></div><button className="text-button" onClick={() => onNavigate("history")}>查看全部 <ArrowUpRight size={14} /></button></div>
    {drafts.length ? <div className="library-drafts">{drafts.slice(0,4).map(draft => <button className="library-draft" key={draft.id} onClick={() => onOpenScene(draft.sceneId, draft.id)}><span className={"library-draft-icon " + draft.sceneId}><Image size={15} /></span><span><strong>{draft.title}</strong><small>{draft.summary}</small></span><ArrowUpRight size={15} /></button>)}</div> : <div className="library-empty"><strong>还没有任务草稿</strong><button className="text-button" onClick={() => { if (scenes[0]) onOpenScene(scenes[0].id); }} disabled={!scenes.length}>开始创作</button></div>}
  </div>;
}
