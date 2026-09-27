import {
  Archive,
  Boxes,
  Cable,
  Clapperboard,
  LayoutDashboard,
  Orbit,
  Package,
  Workflow,
} from "lucide-react";
import type { PageId, SceneId } from "../types";

interface SidebarProps {
  page: PageId;
  sceneId: SceneId;
  onNavigate: (page: PageId) => void;
  onOpenScene: (sceneId: SceneId) => void;
}

export default function Sidebar({ page, sceneId, onNavigate, onOpenScene }: SidebarProps) {
  return (
    <aside className="sidebar">
      <button className="brand" onClick={() => onNavigate("home")} aria-label="返回工作台">
        <span className="brand-mark"><Orbit size={19} strokeWidth={2.5} /></span>
        <span className="brand-copy">
          <strong>Zane Studio</strong>
          <small>个人创作空间</small>
        </span>
      </button>

      <div className="workspace-switcher">
        <span className="workspace-avatar">Z</span>
        <span className="workspace-label"><strong>本地工作区</strong><small>个人空间</small></span>
        <span className="online-dot" title="本地运行" />
      </div>

      <nav className="sidebar-nav" aria-label="主导航">
        <span className="nav-section-label">工作空间</span>
        <button className={`nav-item ${page === "home" ? "active" : ""}`} onClick={() => onNavigate("home")}>
          <LayoutDashboard size={17} /><span>工作台</span>
        </button>
        <button className={`nav-item ${page === "history" ? "active" : ""}`} onClick={() => onNavigate("history")}>
          <Archive size={17} /><span>任务草稿</span>
        </button>
        <button className={`nav-item ${page === "assets" ? "active" : ""}`} onClick={() => onNavigate("assets")}>
          <Boxes size={17} /><span>素材库</span>
        </button>
        <button className={`nav-item ${page === "flows" ? "active" : ""}`} onClick={() => onNavigate("flows")}>
          <Workflow size={17} /><span>流程配置</span>
        </button>

        <div className="nav-divider" />
        <div className="nav-section-heading"><span className="nav-section-label">创作场景</span></div>
        <button className={`nav-item ${page === "studio" && sceneId === "comic" ? "active" : ""}`} onClick={() => onOpenScene("comic")}>
          <Clapperboard size={17} /><span>漫剧制作</span><span className="nav-count">01</span>
        </button>
        <button className={`nav-item ${page === "studio" && sceneId === "commerce" ? "active" : ""}`} onClick={() => onOpenScene("commerce")}>
          <Package size={17} /><span>商品展示</span><span className="nav-count">02</span>
        </button>
      </nav>

      <div className="sidebar-bottom">
        <button className={`nav-item ${page === "connections" ? "active" : ""}`} onClick={() => onNavigate("connections")}>
          <Cable size={17} /><span>集成连接</span>
        </button>
        <div className="sidebar-footer">
          <span className="footer-indicator" />
          <span>仅此设备可见</span>
          <span className="footer-version">v0.1</span>
        </div>
      </div>
    </aside>
  );
}
