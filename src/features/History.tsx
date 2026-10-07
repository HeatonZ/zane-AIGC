import { useState } from "react";
import { ArrowRight, Star, Archive, ArrowUpRight, Clock3, FileText, Sparkles } from "lucide-react";
import { getScene } from "../data/scenes";
import type { PageId, SceneId, SceneModule, WorkflowDraft } from "../types";

interface HistoryProps {
  drafts: WorkflowDraft[];
  scenes: SceneModule[];
  onNavigate: (page: PageId) => void;
  onOpenScene: (scene: SceneId, draftId?: string) => void;
  onSetFavorite: (id: string, isFavorite: boolean) => Promise<void>;
  onReconcileFavorites: () => Promise<void>;
  favoriteBusy: boolean;
  favoriteUnknown: boolean;
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).format(new Date(value));
}

export default function History({ drafts, scenes, onNavigate, onOpenScene, onSetFavorite, onReconcileFavorites, favoriteBusy, favoriteUnknown }: HistoryProps) {
  const [error, setError] = useState("");
  async function attempt(action: () => Promise<void>) {
    setError("");
    try { await action(); } catch (error) { setError(error instanceof Error ? error.message : "收藏保存失败"); }
  }
  return (
    <div className="history-page">
      <div className="welcome-row"><div><div className="eyebrow"><span className="eyebrow-line" />WORKSPACE RECORDS</div><h1>任务草稿</h1><p className="page-subtitle">收藏常用草稿，快速找到并复用；已确认的收藏保存在服务端。</p></div><button className="button button-outline" onClick={() => onNavigate("home")}><ArrowUpRight size={15} />浏览场景</button></div>
      <div className="history-toolbar"><div><Archive size={16} /><strong>全部草稿</strong><span>{drafts.length}</span></div><small>收藏置顶 · 最近保存优先</small></div>
      {error && <div className="workspace-bootstrap-error" role="alert">{error}</div>}
      {favoriteUnknown && <button className="button button-outline" disabled={favoriteBusy} onClick={() => void attempt(onReconcileFavorites)}>读取服务端收藏状态对账</button>}
      {drafts.length ? (
        <div className="history-list">
          {drafts.map((draft) => {
            const scene = getScene(draft.sceneId, scenes);
            return (
              <article className={`history-row${draft.isFavorite ? " is-favorite" : ""}`} key={draft.id}>
                <span className={`history-type-icon ${scene.accent}`}><Sparkles size={17} /></span>
                <div className="history-main"><div className="history-title-row"><h2>{draft.title}</h2><span className={`draft-status ${draft.status}`}>{draft.status === "completed" ? "已完成" : draft.status === "failed" ? "失败" : "草稿"}</span></div><p>{draft.summary}</p><div className="history-meta"><span>{scene.shortTitle}制作</span><i /> <Clock3 size={12} /><span>{formatDate(draft.createdAt)}</span>{draft.runResult && <><i /><span>{draft.runResult.steps.length} 步执行记录</span></>}</div></div>
                <button className={`draft-favorite-button${draft.isFavorite ? " is-favorite" : ""}`} type="button" aria-pressed={Boolean(draft.isFavorite)} aria-label={`${draft.isFavorite ? "取消收藏" : "收藏"}：${draft.title}`} title={draft.isFavorite ? "取消收藏" : "收藏并置顶"} disabled={favoriteBusy || favoriteUnknown} onClick={() => void attempt(() => onSetFavorite(draft.id, !draft.isFavorite))}><Star size={15} fill={draft.isFavorite ? "currentColor" : "none"} /><span>{draft.isFavorite ? "已收藏" : "收藏"}</span></button>
                <button className="button button-small" onClick={() => onOpenScene(draft.sceneId, draft.id)}>继续编辑 <ArrowRight size={14} /></button>
              </article>
            );
          })}
        </div>
      ) : (
        <div className="history-empty"><span className="history-empty-mark"><FileText size={22} /></span><h2>还没有保存的草稿</h2><p>选择一个场景创建你的第一份业务方案。</p><button className="button button-dark" onClick={() => onNavigate("home")}>浏览创作场景 <ArrowRight size={15} /></button></div>
      )}
    </div>
  );
}
