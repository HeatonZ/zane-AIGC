import { useCallback, useEffect, useState } from "react";
import { ChevronRight, Command, RotateCw } from "lucide-react";
import Sidebar from "./components/Sidebar";
import Connections from "./features/Connections";
import Dashboard from "./features/Dashboard";
import History from "./features/History";
import Library from "./features/Library";
import Studio from "./features/Studio";
import { getScene } from "./data/scenes";
import { checkConnections } from "./lib/api";
import { readDrafts, writeDrafts } from "./lib/drafts";
import { readWorkflows, writeWorkflows } from "./lib/workflowStorage";
import FlowDesigner from "./features/FlowDesigner";
import type { ConnectorState, PageId, SceneId, WorkflowDefinition, WorkflowDraft } from "./types";

const navLabels: Record<PageId, string> = {
  home: "工作台",
  history: "任务草稿",
  assets: "素材库",
  connections: "集成连接",
  studio: "创作场景",
  flows: "流程配置",
};

const initialConnectors: ConnectorState[] = [
  { id: "hermes", name: "Hermes Agent", status: "not_configured", message: "等待检查" },
  { id: "comfyui", name: "ComfyUI", status: "not_configured", message: "等待检查" },
];

export default function App() {
  const [page, setPage] = useState<PageId>("home");
  const [sceneId, setSceneId] = useState<SceneId>("comic");
  const [drafts, setDrafts] = useState<WorkflowDraft[]>(() => readDrafts().sort((a, b) => b.createdAt.localeCompare(a.createdAt)));
  const [workflows, setWorkflows] = useState(() => readWorkflows());
  const [connectors, setConnectors] = useState<ConnectorState[]>(initialConnectors);
  const [refreshing, setRefreshing] = useState(false);

  const refreshConnections = useCallback(async (enabledHermesProfiles?: string[]) => {
    setRefreshing(true);
    try {
      const states = await checkConnections(enabledHermesProfiles);
      setConnectors(states);
      return states;
    } catch (error) {
      setConnectors([
        { id: "hermes", name: "Hermes Agent", status: "disconnected", message: "本地 API 暂不可用" },
        { id: "comfyui", name: "ComfyUI", status: "disconnected", message: "本地 API 暂不可用" },
      ]);
      throw error;
    } finally {
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    let disposed = false;
    let retryTimer: number | undefined;
    let attempts = 0;

    async function checkWhenReady() {
      try {
        await refreshConnections();
      } catch {
        if (disposed || attempts >= 4) return;
        const delay = 300 * 2 ** attempts;
        attempts += 1;
        retryTimer = window.setTimeout(() => void checkWhenReady(), delay);
      }
    }

    void checkWhenReady();
    return () => {
      disposed = true;
      if (retryTimer !== undefined) window.clearTimeout(retryTimer);
    };
  }, [refreshConnections]);

  function openScene(nextScene: SceneId) {
    setSceneId(nextScene);
    setPage("studio");
  }

  function saveDraft(draft: WorkflowDraft) {
    const next = [draft, ...drafts];
    setDrafts(next);
    writeDrafts(next);
  }

  function updateWorkflow(workflow: WorkflowDefinition) {
    const next = { ...workflows, [workflow.sceneId]: workflow };
    setWorkflows(next);
    writeWorkflows(next);
  }

  const currentScene = getScene(sceneId);
  const title = page === "studio" ? currentScene.title : navLabels[page];
  const dateLabel = new Intl.DateTimeFormat("zh-CN", { weekday: "long", month: "long", day: "numeric" }).format(new Date());

  return (
    <div className="app-shell">
      <Sidebar page={page} sceneId={sceneId} onNavigate={setPage} onOpenScene={openScene} />
      <main className="main-column">
        <header className="topbar">
          <div className="topbar-context"><span className="topbar-workspace"><span className="workspace-dot" />本地工作区</span><ChevronRight size={14} /><span>{title}</span></div>
          <div className="topbar-actions">
            <span className="topbar-date">{dateLabel}</span>
            <button className="icon-button refresh-button" title="刷新连接状态" aria-label="刷新连接状态" onClick={() => refreshConnections().catch(() => undefined)} disabled={refreshing}>
              <RotateCw className={refreshing ? "spin" : ""} size={15} />
            </button>
            <span className="topbar-divider" />
            <span className="profile-badge" title="个人空间">Z</span>
          </div>
        </header>

        <div className="page-scroll">
          <div className="page-content" key={page === "studio" ? `${page}-${sceneId}` : page}>
            {page === "home" && <Dashboard drafts={drafts} connectors={connectors} onNavigate={setPage} onOpenScene={openScene} />}
            {page === "studio" && <Studio sceneId={sceneId} workflow={workflows[sceneId]} onBack={() => setPage("home")} onSaveDraft={saveDraft} />}
            {page === "history" && <History drafts={drafts} onNavigate={setPage} onOpenScene={openScene} />}
            {page === "assets" && <Library drafts={drafts} onNavigate={setPage} onOpenScene={openScene} />}
            {page === "connections" && <Connections connectors={connectors} onRefresh={refreshConnections} />}
            {page === "flows" && <FlowDesigner sceneId={sceneId} workflow={workflows[sceneId]} onSceneChange={setSceneId} onChange={updateWorkflow} onOpenConnections={() => setPage("connections")} />}
          </div>
          <footer className="app-footer"><span>在本地专注创作</span><span><Command size={12} /> ZANE STUDIO</span></footer>
        </div>
      </main>
    </div>
  );
}
