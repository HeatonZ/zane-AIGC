import { ArrowRight, ArrowUpRight, Cable, Clock3, Image, Pencil, Plus, Sparkles, Trash2 } from "lucide-react";
import { useState } from "react";
import { getScene } from "../data/scenes";
import type { ConnectorState, PageId, SceneDetails, SceneId, SceneModule, WorkflowDraft } from "../types";
import ConnectorBadge, { ConnectorMark } from "../components/ConnectorBadge";
import SceneEditorDialog from "./SceneEditorDialog";

interface DashboardProps {
  drafts: WorkflowDraft[];
  scenes: SceneModule[];
  connectors: ConnectorState[];
  onNavigate: (page: PageId) => void;
  onOpenScene: (sceneId: SceneId, draftId?: string) => void;
  onCreateScene: (details: SceneDetails) => void;
  onUpdateScene: (sceneId: SceneId, details: SceneDetails) => void;
  onDeleteScene: (sceneId: SceneId) => void;
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).format(new Date(value));
}

export default function Dashboard({ drafts, scenes, connectors, onNavigate, onOpenScene, onCreateScene, onUpdateScene, onDeleteScene }: DashboardProps) {
  const [creatingScene, setCreatingScene] = useState(false);
  const [editingScene, setEditingScene] = useState<SceneModule | null>(null);
  const recentDrafts = drafts.slice(0, 3);
  const connectorMap = new Map(connectors.map((connector) => [connector.id, connector]));

  return (
    <div className="dashboard-page">
      <div className="welcome-row">
        <div>
          <div className="eyebrow"><span className="eyebrow-line" />PERSONAL STUDIO</div>
          <h1>工作台</h1>
          <p className="page-subtitle">把想法带进每一个创作场景。</p>
        </div>
        <button className="button button-dark" onClick={() => onOpenScene(scenes[0].id)} disabled={!scenes.length}>
          <Plus size={16} /> 新建创作
        </button>
      </div>

      <section className="scene-section">
        <div className="section-heading">
          <div><h2>创作场景</h2><p>选择一个业务，继续你的工作流</p></div>
          <div className="scene-section-actions"><span className="section-meta">{String(scenes.length).padStart(2, "0")} 个场景</span><button className="button button-outline scene-add-button" onClick={() => setCreatingScene(true)}><Plus size={14} />添加场景</button></div>
        </div>
        {scenes.length ? <div className="scene-grid">
          {scenes.map((scene, index) => (
            <article className={`scene-card scene-${scene.accent}`} key={scene.id}>
              <div className="scene-cover">
                {scene.cover && <img src={scene.cover} alt="" style={{ objectPosition: scene.coverPosition }} />}
                <div className="scene-cover-shade" />
                <span className="scene-number">0{index + 1}</span>
                <span className="scene-category">{scene.id === "text_to_image" ? "IMAGE GENERATION" : scene.id === "comic" ? "STORY & MOTION" : scene.id === "commerce" ? "PRODUCT VISUALS" : "CUSTOM WORKFLOW"}</span>
                <button className="scene-open" onClick={() => onOpenScene(scene.id)} aria-label={`打开${scene.title}`}>
                  <ArrowUpRight size={19} />
                </button>
                <div className="scene-cover-title">
                  <h3>{scene.title}</h3>
                  <span>{scene.summary}</span>
                </div>
              </div>
              <div className="scene-card-bottom">
                <div className="scene-stage-list">
                  {scene.stages.map((stage, stageIndex) => (
                    <span key={stage}>{stage}{stageIndex < scene.stages.length - 1 && <i>·</i>}</span>
                  ))}
                </div>
                <div className="scene-card-actions"><button className="text-button" onClick={() => onOpenScene(scene.id)}>进入工作流 <ArrowRight size={14} /></button><div><button className="icon-button" onClick={() => setEditingScene(scene)} title={`编辑${scene.title}`} aria-label={`编辑${scene.title}`}><Pencil size={14} /></button><button className="icon-button scene-delete-action" onClick={() => onDeleteScene(scene.id)} title={`删除${scene.title}`} aria-label={`删除${scene.title}`}><Trash2 size={14} /></button></div></div>
              </div>
            </article>
          ))}
        </div> : <div className="scene-empty"><Sparkles size={17} /><span>还没有创作场景</span><button className="text-button" onClick={() => setCreatingScene(true)}>添加第一个场景 <ArrowRight size={14} /></button></div>}
      </section>

      <div className="dashboard-lower">
        <section className="lower-panel recent-panel">
          <div className="lower-heading">
            <div className="lower-heading-icon"><Clock3 size={16} /></div>
            <div><h2>最近任务</h2><p>最近保存的创作草稿</p></div>
            <button className="icon-button panel-link" onClick={() => onNavigate("history")} title="查看全部任务" aria-label="查看全部任务">
              <ArrowUpRight size={17} />
            </button>
          </div>
          {recentDrafts.length ? (
            <div className="draft-list">
              {recentDrafts.map((draft) => {
                const scene = getScene(draft.sceneId, scenes);
                return (
                  <button className="draft-row" key={draft.id} onClick={() => onOpenScene(draft.sceneId, draft.id)}>
                    <span className={`draft-thumb ${scene.accent}`}><Sparkles size={16} /></span>
                    <span className="draft-info"><strong>{draft.title}</strong><small>{scene.shortTitle}制作 · {formatDate(draft.createdAt)}</small></span>
                    <span className={`draft-status ${draft.status}`}>{draft.status === "completed" ? "已完成" : draft.status === "failed" ? "失败" : "草稿"}</span>
                    <ArrowRight className="draft-arrow" size={15} />
                  </button>
                );
              })}
            </div>
          ) : (
            <div className="empty-inline">
              <span className="empty-inline-icon"><Image size={18} /></span>
              <span><strong>还没有任务草稿</strong><small>选择一个创作场景，开始建立第一份方案。</small></span>
            </div>
          )}
          <button className="panel-bottom-link" onClick={() => onNavigate("history")}>
            查看任务草稿 <ArrowRight size={14} />
          </button>
        </section>

        <section className="lower-panel integrations-panel">
          <div className="lower-heading">
            <div className="lower-heading-icon integration-icon"><Cable size={16} /></div>
            <div><h2>运行环境</h2><p>本地服务连接状态</p></div>
            <button className="icon-button panel-link" onClick={() => onNavigate("connections")} title="管理连接" aria-label="管理连接">
              <ArrowUpRight size={17} />
            </button>
          </div>
          <div className="integration-list">
            {[{ id: "hermes", title: "Hermes Agent", caption: "Profile Gateway 状态" }, { id: "comfyui", title: "ComfyUI", caption: "图像与视频生成" }].map((item) => {
              const state = connectorMap.get(item.id as "hermes" | "comfyui");
              return (
                <button className="integration-row" key={item.id} onClick={() => onNavigate("connections")}>
                  <ConnectorMark state={state} />
                  <span className="integration-info"><strong>{item.title}</strong><small>{item.caption}</small></span>
                  <ConnectorBadge state={state} />
                </button>
              );
            })}
          </div>
          <button className="panel-bottom-link" onClick={() => onNavigate("connections")}>
            管理集成连接 <ArrowRight size={14} />
          </button>
        </section>
      </div>
      {(creatingScene || editingScene) && <SceneEditorDialog scene={editingScene ?? undefined} onClose={() => { setCreatingScene(false); setEditingScene(null); }} onSave={(details) => {
        if (editingScene) onUpdateScene(editingScene.id, details);
        else onCreateScene(details);
        setCreatingScene(false);
        setEditingScene(null);
      }} />}
    </div>
  );
}
