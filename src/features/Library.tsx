import { ArrowUpRight, Image, Layers3, Package, Sparkles } from "lucide-react";
import { scenes } from "../data/scenes";
import type { PageId, SceneId, WorkflowDraft } from "../types";

interface LibraryProps {
  drafts: WorkflowDraft[];
  onNavigate: (page: PageId) => void;
  onOpenScene: (scene: SceneId, draftId?: string) => void;
}

const visualAssets = [
  { title: "星云叙事", type: "氛围参考", scene: "comic" as const, image: "https://images.unsplash.com/photo-1534447677768-be436bb09401?auto=format&fit=crop&w=720&q=80" },
  { title: "轻跑鞋型", type: "商品参考", scene: "commerce" as const, image: "https://images.unsplash.com/photo-1542291026-7eec264c27ff?auto=format&fit=crop&w=720&q=80" },
  { title: "森林微光", type: "场景参考", scene: "comic" as const, image: "https://images.unsplash.com/photo-1448375240586-882707db888b?auto=format&fit=crop&w=720&q=80" },
  { title: "日常护肤", type: "商品参考", scene: "commerce" as const, image: "https://images.unsplash.com/photo-1608248543803-ba4f8c70ae0b?auto=format&fit=crop&w=720&q=80" },
];

export default function Library({ drafts, onNavigate, onOpenScene }: LibraryProps) {
  return (
    <div className="library-page">
      <div className="welcome-row"><div><div className="eyebrow"><span className="eyebrow-line" />REFERENCE MATERIALS</div><h1>素材库</h1><p className="page-subtitle">集中查看创作参考与已保存的任务草稿。</p></div><span className="library-total"><Layers3 size={15} />{visualAssets.length + drafts.length} 项内容</span></div>
      <div className="library-section-heading"><div><h2>灵感参考</h2><p>可用于构思与视觉方向参考</p></div><span>示例素材</span></div>
      <div className="asset-grid">
        {visualAssets.map((asset) => (
          <button className="asset-card" key={asset.title} onClick={() => onOpenScene(asset.scene)}>
            <span className="asset-image"><img src={asset.image} alt="" loading="lazy" /><span className="asset-image-arrow"><ArrowUpRight size={15} /></span></span>
            <span className="asset-card-caption"><span><strong>{asset.title}</strong><small>{asset.type}</small></span><span className={`asset-scene-mark ${asset.scene}`} title={asset.scene === "comic" ? "漫剧" : "商品"}>{asset.scene === "comic" ? <Sparkles size={14} /> : <Package size={14} />}</span></span>
          </button>
        ))}
      </div>
      <div className="library-section-heading draft-library-heading"><div><h2>任务草稿</h2><p>{drafts.length ? `${drafts.length} 份已保存` : "已保存的业务构想"}</p></div><button className="text-button" onClick={() => onNavigate("history")}>查看全部 <ArrowUpRight size={14} /></button></div>
      {drafts.length ? <div className="library-drafts">{drafts.slice(0, 4).map((draft) => <button className="library-draft" key={draft.id} onClick={() => onOpenScene(draft.sceneId, draft.id)}><span className={`library-draft-icon ${draft.sceneId}`}><Image size={15} /></span><span><strong>{draft.title}</strong><small>{draft.summary}</small></span><ArrowUpRight size={15} /></button>)}</div> : <div className="library-empty"><span className="library-empty-icon"><Image size={18} /></span><strong>素材会出现在这里</strong><span>先从场景工作流创建一份任务草稿。</span><button className="text-button" onClick={() => onOpenScene(scenes[0].id)}>开始创作 <ArrowUpRight size={14} /></button></div>}
    </div>
  );
}
