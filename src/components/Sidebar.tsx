import {
  Archive,
  ArrowDownUp,
  Boxes,
  Cable,
  Clapperboard,
  Image,
  History as HistoryIcon,
  LayoutDashboard,
  Orbit,
  Package,
  Sparkles,
  Workflow,
  Users,
  MessageSquare,
} from "lucide-react";
import type { PageId, SceneId, SceneModule } from "../types";

interface SidebarProps {
  page: PageId;
  sceneId: SceneId;
  scenes: SceneModule[];
  onNavigate: (page: PageId) => void;
  onOpenScene: (sceneId: SceneId) => void;
  onSortScenes: () => void;
}

export default function Sidebar({ page, sceneId, scenes, onNavigate, onOpenScene, onSortScenes }: SidebarProps) {
  return (
    <aside className="sidebar">
      <button className="brand" onClick={() => onNavigate("home")} aria-label="返回工作台">
        <span className="brand-mark"><Orbit size={19} strokeWidth={2.5} /></span>
        <span className="brand-copy">
          <strong>Zane Studio</strong>
          <small>管理员后台</small>
        </span>
      </button>

      <div className="workspace-switcher">
        <span className="workspace-avatar">Z</span>
        <span className="workspace-label"><strong>系统管理</strong><small>管理账户</small></span>
        <span className="online-dot" title="本地运行" />
      </div>

      <nav className="sidebar-nav" aria-label="主导航">
        <span className="nav-section-label">管理导航</span>
        <button className={`nav-item ${page === "home" ? "active" : ""}`} onClick={() => onNavigate("home")} aria-label="管理概览" title="管理概览">
          <LayoutDashboard size={17} /><span>管理概览</span>
        </button>
        <button className={`nav-item ${page === "history" ? "active" : ""}`} onClick={() => onNavigate("history")} aria-label="任务草稿" title="任务草稿">
          <Archive size={17} /><span>任务草稿</span>
        </button>
        <button className={`nav-item ${page === "runs" ? "active" : ""}`} onClick={() => onNavigate("runs")} aria-label="运行记录" title="运行记录">
          <HistoryIcon size={17} /><span>运行记录</span>
        </button>
        <button className={`nav-item ${page === "assets" ? "active" : ""}`} onClick={() => onNavigate("assets")} aria-label="素材库" title="素材库">
          <Boxes size={17} /><span>素材库</span>
        </button>
        <button className={`nav-item ${page === "flows" ? "active" : ""}`} onClick={() => onNavigate("flows")} aria-label="流程配置" title="流程配置">
          <Workflow size={17} /><span>流程配置</span>
        </button>

        <button className={`nav-item ${page === "users" ? "active" : ""}`} onClick={() => onNavigate("users")} aria-label="用户管理" title="用户管理"><Users size={17} /><span>用户管理</span></button>
        <button className={`nav-item ${page === "feedback" ? "active" : ""}`} onClick={() => onNavigate("feedback")} aria-label="系统反馈" title="系统反馈"><MessageSquare size={17} /><span>系统反馈</span></button>
        <div className="nav-divider" />
        <div className="nav-section-heading"><span className="nav-section-label">创作场景</span><button className="tiny-icon-button" onClick={onSortScenes} disabled={scenes.length < 2} title="场景排序" aria-label="场景排序"><ArrowDownUp size={14} /></button></div>
        {scenes.map((scene, index) => <button className={`nav-item ${page === "studio" && sceneId === scene.id ? "active" : ""}`} key={scene.id} onClick={() => onOpenScene(scene.id)} aria-label={scene.title} title={scene.title}>
          {scene.id === "text_to_image" ? <Image size={17} /> : scene.id === "comic" ? <Clapperboard size={17} /> : scene.id === "commerce" ? <Package size={17} /> : <Sparkles size={17} />}<span>{scene.title}</span><span className="nav-count">{String(index + 1).padStart(2, "0")}</span>
        </button>)}
      </nav>

      <div className="sidebar-bottom">
        <button className={`nav-item ${page === "connections" ? "active" : ""}`} onClick={() => onNavigate("connections")} aria-label="集成连接" title="集成连接">
          <Cable size={17} /><span>集成连接</span>
        </button>
        <div className="sidebar-footer">
          <span className="footer-indicator" />
          <span>服务端统一配置</span>
          <span className="footer-version">v0.1</span>
        </div>
      </div>
    </aside>
  );
}
