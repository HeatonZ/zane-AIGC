import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronRight, Command, RotateCw } from "lucide-react";
import Sidebar from "./components/Sidebar";
import Connections from "./features/Connections";
import Dashboard from "./features/Dashboard";
import History from "./features/History";
import WorkflowRuns from "./features/WorkflowRuns";
import Library from "./features/Library";
import Studio from "./features/Studio";
import { getScene } from "./data/scenes";
import { createSceneWorkflow } from "./data/workflows";
import { checkConnections, runWorkflow } from "./lib/api";
import { readDrafts, writeDrafts } from "./lib/drafts";
import { createScene, readScenes, writeScenes } from "./lib/sceneStorage";
import { readOptionPresets, readWorkflows, writeOptionPresets, writeWorkflows } from "./lib/workflowStorage";
import FlowDesigner from "./features/FlowDesigner";
import type { ConnectorState, JsonValue, PageId, SceneDetails, SceneId, SceneModule, WorkflowDefinition, WorkflowDraft, WorkflowOptionPreset } from "./types";

const navLabels: Record<PageId, string> = {
  home: "工作台",
  history: "任务草稿",
  runs: "运行记录",
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
  const [scenes, setScenes] = useState<SceneModule[]>(() => readScenes());
  const [sceneId, setSceneId] = useState<SceneId>(() => readScenes()[0]?.id ?? "");
  const [activeDraftId, setActiveDraftId] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<WorkflowDraft[]>(() => readDrafts().sort((a, b) => b.createdAt.localeCompare(a.createdAt)));
  const draftsRef = useRef(drafts);
  const [workflows, setWorkflows] = useState(() => readWorkflows(readScenes()));
  const [optionPresets, setOptionPresets] = useState<WorkflowOptionPreset[]>(() => readOptionPresets());
  const [connectors, setConnectors] = useState<ConnectorState[]>(initialConnectors);
  const [refreshing, setRefreshing] = useState(false);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [activeRunIds, setActiveRunIds] = useState<string[]>([]);
  const [runStartErrors, setRunStartErrors] = useState<Record<string, string>>({});
  const runControllersRef = useRef(new Map<string, AbortController>());

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

  function openScene(nextScene: SceneId, draftId?: string) {
    setSceneId(nextScene);
    setActiveDraftId(draftId ?? null);
    setPage("studio");
  }

  function saveDraft(draft: WorkflowDraft) {
    const next = [draft, ...draftsRef.current.filter((item) => item.id !== draft.id)]
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    draftsRef.current = next;
    setDrafts(next);
    writeDrafts(next);
  }

  const startWorkflowRun = useCallback(async (workflow: WorkflowDefinition, inputValues: Record<string, JsonValue>, runId: string) => {
    const controller = new AbortController();
    runControllersRef.current.set(runId, controller);
    setSelectedRunId(runId);
    setActiveRunIds((current) => [...current, runId]);
    setRunStartErrors((current) => ({ ...current, [runId]: "" }));
    setPage("runs");
    try {
      return await runWorkflow(workflow, inputValues, controller.signal, runId);
    } catch (error) {
      if (!controller.signal.aborted) {
        setRunStartErrors((current) => ({
          ...current,
          [runId]: error instanceof Error ? error.message : "流程执行失败",
        }));
      }
      throw error;
    } finally {
      runControllersRef.current.delete(runId);
      setActiveRunIds((current) => current.filter((id) => id !== runId));
    }
  }, []);

  const cancelWorkflowRun = useCallback((runId: string) => {
    runControllersRef.current.get(runId)?.abort();
  }, []);

  const selectRun = useCallback((runId: string | null) => {
    setSelectedRunId(runId);
  }, []);

  function updateWorkflow(workflow: WorkflowDefinition) {
    const next = { ...workflows, [workflow.sceneId]: workflow };
    setWorkflows(next);
    writeWorkflows(next);
  }

  function createWorkspaceScene(details: SceneDetails) {
    const scene = createScene(details);
    const nextScenes = [...scenes, scene];
    const nextWorkflows = { ...workflows, [scene.id]: createSceneWorkflow(scene) };
    setScenes(nextScenes);
    writeScenes(nextScenes);
    setWorkflows(nextWorkflows);
    writeWorkflows(nextWorkflows);
    setSceneId(scene.id);
    setPage("flows");
  }

  function updateScene(sceneIdToUpdate: SceneId, details: SceneDetails) {
    const nextScenes = scenes.map((scene) => scene.id === sceneIdToUpdate ? { ...scene, ...details } : scene);
    setScenes(nextScenes);
    writeScenes(nextScenes);
  }

  function deleteScene(sceneIdToDelete: SceneId) {
    const scene = scenes.find((item) => item.id === sceneIdToDelete);
    if (!scene) return;
    const sceneDrafts = drafts.filter((draft) => draft.sceneId === sceneIdToDelete);
    const draftMessage = sceneDrafts.length ? `以及 ${sceneDrafts.length} 份关联草稿` : "";
    if (!window.confirm(`确定删除“${scene.title}”吗？这会同时删除该场景的流程配置${draftMessage}。项目目录中的运行归档会保留。`)) return;

    const nextScenes = scenes.filter((item) => item.id !== sceneIdToDelete);
    const nextWorkflows = Object.fromEntries(Object.entries(workflows).filter(([id]) => id !== sceneIdToDelete));
    const nextDrafts = drafts.filter((draft) => draft.sceneId !== sceneIdToDelete);
    setScenes(nextScenes);
    writeScenes(nextScenes);
    setWorkflows(nextWorkflows);
    writeWorkflows(nextWorkflows);
    setDrafts(nextDrafts);
    draftsRef.current = nextDrafts;
    writeDrafts(nextDrafts);
    if (sceneId === sceneIdToDelete) setSceneId(nextScenes[0]?.id ?? "");
    if (activeDraftId && sceneDrafts.some((draft) => draft.id === activeDraftId)) setActiveDraftId(null);
    if (sceneId === sceneIdToDelete && page === "studio") setPage("home");
  }

  function updateOptionPresets(nextOptionPresets: WorkflowOptionPreset[]) {
    const previousIds = new Set(optionPresets.map((preset) => preset.id));
    const nextPresetMap = new Map(nextOptionPresets.map((preset) => [preset.id, preset]));
    const removedIds = new Set([...previousIds].filter((id) => !nextPresetMap.has(id)));
    const nextWorkflows = Object.fromEntries(Object.entries(workflows).map(([id, workflow]) => {
      const inputs = workflow.inputs.map((field) => {
        if (!field.optionPresetId) return field;
        if (removedIds.has(field.optionPresetId)) return { ...field, optionPresetId: undefined };
        const preset = nextPresetMap.get(field.optionPresetId);
        return preset ? { ...field, options: [...preset.options] } : field;
      });
      const steps = workflow.steps.map((step) => {
        if (!step.comfyui?.bindings.length) return step;
        const bindings = step.comfyui.bindings.map((binding) => {
          const format = binding.sourceInputFormat;
          if (!format?.optionPresetId) return binding;
          if (removedIds.has(format.optionPresetId)) {
            return { ...binding, sourceInputFormat: { ...format, optionPresetId: undefined } };
          }
          const preset = nextPresetMap.get(format.optionPresetId);
          return preset ? { ...binding, sourceInputFormat: { ...format, options: [...preset.options] } } : binding;
        });
        return { ...step, comfyui: { ...step.comfyui, bindings } };
      });
      return [id, { ...workflow, inputs, steps }];
    })) as Record<SceneId, WorkflowDefinition>;
    setOptionPresets(nextOptionPresets);
    writeOptionPresets(nextOptionPresets);
    setWorkflows(nextWorkflows);
    writeWorkflows(nextWorkflows);
  }

  const currentScene = getScene(sceneId, scenes);
  const selectedScene = scenes.find((scene) => scene.id === sceneId);
  const selectedWorkflow = workflows[sceneId];
  const activeDraft = activeDraftId ? drafts.find((draft) => draft.id === activeDraftId) : undefined;
  const title = page === "studio" ? currentScene.title : navLabels[page];
  const dateLabel = new Intl.DateTimeFormat("zh-CN", { weekday: "long", month: "long", day: "numeric" }).format(new Date());

  return (
    <div className="app-shell">
      <Sidebar page={page} sceneId={sceneId} scenes={scenes} onNavigate={setPage} onOpenScene={openScene} />
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
            {page === "home" && <Dashboard drafts={drafts} scenes={scenes} connectors={connectors} onNavigate={setPage} onOpenScene={openScene} onCreateScene={createWorkspaceScene} onUpdateScene={updateScene} onDeleteScene={deleteScene} />}
            {page === "studio" && selectedScene && selectedWorkflow && <Studio sceneId={sceneId} scene={selectedScene} workflow={selectedWorkflow} draft={activeDraft} onNavigate={setPage} onBack={() => setPage("home")} onSaveDraft={saveDraft} onStartRun={startWorkflowRun} onCancelRun={cancelWorkflowRun} />}
            {page === "history" && <History drafts={drafts} scenes={scenes} onNavigate={setPage} onOpenScene={openScene} />}
            {page === "runs" && <WorkflowRuns scenes={scenes} onNavigate={setPage} selectedRunId={selectedRunId} onSelectRun={selectRun} onCancelRun={cancelWorkflowRun} activeRunId={selectedRunId !== null && activeRunIds.includes(selectedRunId) ? selectedRunId : null} canCancelRun={selectedRunId !== null && activeRunIds.includes(selectedRunId)} runStartError={selectedRunId ? runStartErrors[selectedRunId] : undefined} />}
            {page === "assets" && <Library drafts={drafts} scenes={scenes} onNavigate={setPage} onOpenScene={openScene} />}
            {page === "connections" && <Connections connectors={connectors} onRefresh={refreshConnections} />}
            {page === "flows" && selectedScene && selectedWorkflow && <FlowDesigner sceneId={sceneId} scenes={scenes} workflow={selectedWorkflow} optionPresets={optionPresets} onSceneChange={setSceneId} onChange={updateWorkflow} onOptionPresetsChange={updateOptionPresets} onOpenConnections={() => setPage("connections")} />}
          </div>
          <footer className="app-footer"><span>在本地专注创作</span><span><Command size={12} /> ZANE STUDIO</span></footer>
        </div>
      </main>
    </div>
  );
}
