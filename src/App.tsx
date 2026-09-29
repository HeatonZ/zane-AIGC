import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronRight, Command, Database, LoaderCircle, RotateCw, Rocket } from "lucide-react";
import Sidebar from "./components/Sidebar";
import Connections from "./features/Connections";
import Dashboard from "./features/Dashboard";
import History from "./features/History";
import WorkflowRuns from "./features/WorkflowRuns";
import Library from "./features/Library";
import Studio from "./features/Studio";
import { getScene } from "./data/scenes";
import { createSceneWorkflow } from "./data/workflows";
import { cancelWorkflowRun as requestWorkflowRunCancellation, checkConnections, initializeWorkspace, loadWorkspace, mergeWorkspace, runWorkflow } from "./lib/api";
import { createScene } from "./lib/sceneStorage";
import { hasLegacyNumericSceneVersions, readLocalWorkspace, normalizeWorkspaceSnapshot, writeLocalWorkspace } from "./lib/workspaceStorage";
import { createId } from "./lib/ids";
import { downloadScenePackage, parseScenePackage, prepareImportedScene } from "./lib/sceneTransfer";
import { publishedSceneVersion, publishSceneVersion, restoreSceneVersionDraft } from "./lib/sceneVersions";
import FlowDesigner from "./features/FlowDesigner";
import type { ConnectorState, JsonValue, PageId, SceneDetails, SceneId, SceneModule, SceneVersion, SceneVersionRecord, WorkflowDefinition, WorkflowDraft, WorkflowOptionPreset, WorkflowRunRecord, WorkspaceSnapshot } from "./types";

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
  const localWorkspaceRef = useRef<WorkspaceSnapshot | null>(null);
  const initialWorkspace = localWorkspaceRef.current ?? readLocalWorkspace();
  localWorkspaceRef.current = initialWorkspace;
  const [page, setPage] = useState<PageId>("home");
  const [scenes, setScenes] = useState<SceneModule[]>(initialWorkspace.scenes);
  const [sceneId, setSceneId] = useState<SceneId>(initialWorkspace.scenes[0]?.id ?? "");
  const [activeDraftId, setActiveDraftId] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<WorkflowDraft[]>(initialWorkspace.drafts);
  const draftsRef = useRef(drafts);
  const [workflows, setWorkflows] = useState<Record<SceneId, WorkflowDefinition>>(initialWorkspace.workflows);
  const [optionPresets, setOptionPresets] = useState<WorkflowOptionPreset[]>(initialWorkspace.optionPresets);
  const [sceneVersions, setSceneVersions] = useState<Record<SceneId, SceneVersionRecord>>(initialWorkspace.sceneVersions);
  const workspaceRef = useRef<WorkspaceSnapshot>(initialWorkspace);
  const workspaceSaveQueueRef = useRef(Promise.resolve());
  const [workspaceSyncError, setWorkspaceSyncError] = useState("");
  const [workspaceStatus, setWorkspaceStatus] = useState<"loading" | "missing" | "ready">("loading");
  const [workspaceInitializing, setWorkspaceInitializing] = useState(false);
  const [workspaceLoadAttempt, setWorkspaceLoadAttempt] = useState(0);
  const [connectors, setConnectors] = useState<ConnectorState[]>(initialConnectors);
  const [refreshing, setRefreshing] = useState(false);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [activeRunIds, setActiveRunIds] = useState<string[]>([]);
  const [runStartErrors, setRunStartErrors] = useState<Record<string, string>>({});
  const runControllersRef = useRef(new Map<string, AbortController>());

  function applyWorkspace(value: WorkspaceSnapshot) {
    const next = normalizeWorkspaceSnapshot(value, workspaceRef.current);
    workspaceRef.current = next;
    draftsRef.current = next.drafts;
    setScenes(next.scenes);
    setWorkflows(next.workflows);
    setOptionPresets(next.optionPresets);
    setSceneVersions(next.sceneVersions);
    setDrafts(next.drafts);
    setSceneId((current) => next.scenes.some((scene) => scene.id === current) ? current : next.scenes[0]?.id ?? "");
  }

  function commitWorkspace(value: WorkspaceSnapshot) {
    const base = workspaceRef.current;
    const next = normalizeWorkspaceSnapshot(value, workspaceRef.current);
    applyWorkspace(next);
    writeLocalWorkspace(next);
    workspaceSaveQueueRef.current = workspaceSaveQueueRef.current
      .catch(() => undefined)
      .then(async () => {
        await mergeWorkspace(base, next);
        setWorkspaceSyncError("");
      })
      .catch((error: unknown) => {
        setWorkspaceSyncError(error instanceof Error ? error.message : "本机工作区同步失败");
      });
  }

  useEffect(() => {
    let disposed = false;
    async function syncWorkspace() {
      try {
        const response = await loadWorkspace();
        if (disposed) return;
        if (!response.workspace) {
          setWorkspaceStatus("missing");
          return;
        }
        const needsVersionMigration = !Object.prototype.hasOwnProperty.call(response.workspace, "sceneVersions")
          || hasLegacyNumericSceneVersions(response.workspace.sceneVersions);
        const normalized = normalizeWorkspaceSnapshot(response.workspace, workspaceRef.current);
        applyWorkspace(normalized);
        writeLocalWorkspace(normalized);
        if (needsVersionMigration) {
          await mergeWorkspace(response.workspace, normalized);
          if (disposed) return;
        }
        setWorkspaceStatus("ready");
        setWorkspaceSyncError("");
      } catch (error) {
        if (!disposed) setWorkspaceSyncError(error instanceof Error ? error.message : "本机工作区同步失败");
      }
    }
    void syncWorkspace();
    return () => { disposed = true; };
  }, [workspaceLoadAttempt]);

  async function initializeServerWorkspace() {
    setWorkspaceInitializing(true);
    setWorkspaceSyncError("");
    try {
      const result = await initializeWorkspace(initialWorkspace);
      applyWorkspace(result.workspace);
      writeLocalWorkspace(result.workspace);
      setWorkspaceStatus("ready");
    } catch (error) {
      setWorkspaceSyncError(error instanceof Error ? error.message : "无法初始化本机工作区");
    } finally {
      setWorkspaceInitializing(false);
    }
  }

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
    const published = publishedSceneVersion(workspaceRef.current.sceneVersions[nextScene]);
    setActiveDraftId(published ? draftId ?? null : null);
    setPage(published ? "studio" : "flows");
  }

  function saveDraft(draft: WorkflowDraft) {
    const next = [draft, ...draftsRef.current.filter((item) => item.id !== draft.id)]
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    commitWorkspace({ ...workspaceRef.current, drafts: next });
  }

  const startWorkflowRun = useCallback(async (workflow: WorkflowDefinition, inputValues: Record<string, JsonValue>, runId: string, runTitle?: string, resumeFromRunId?: string) => {
    const controller = new AbortController();
    runControllersRef.current.set(runId, controller);
    setSelectedRunId(runId);
    setActiveRunIds((current) => [...current, runId]);
    setRunStartErrors((current) => ({ ...current, [runId]: "" }));
    setPage("runs");
    try {
      return await runWorkflow(workflow, inputValues, controller.signal, runId, resumeFromRunId, runTitle);
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

  const resumeWorkflowRun = useCallback(async (source: WorkflowRunRecord) => {
    if (!source.workflow) return;
    const runId = createId();
    await startWorkflowRun(source.workflow, source.inputValues, runId, source.runTitle, source.runId);
  }, [startWorkflowRun]);

  const cancelWorkflowRun = useCallback((runId: string) => {
    const controller = runControllersRef.current.get(runId);
    void requestWorkflowRunCancellation(runId).catch(() => controller?.abort());
  }, []);

  const selectRun = useCallback((runId: string | null) => {
    setSelectedRunId(runId);
  }, []);

  function updateWorkflow(workflow: WorkflowDefinition) {
    const next = { ...workflows, [workflow.sceneId]: workflow };
    commitWorkspace({ ...workspaceRef.current, workflows: next });
  }

  function createWorkspaceScene(details: SceneDetails) {
    const scene = createScene(details);
    const nextScenes = [...scenes, scene];
    const nextWorkflows = { ...workflows, [scene.id]: createSceneWorkflow(scene) };
    const nextSceneVersions = { ...workspaceRef.current.sceneVersions, [scene.id]: { publishedVersionId: null, versions: [] } };
    commitWorkspace({ ...workspaceRef.current, scenes: nextScenes, workflows: nextWorkflows, sceneVersions: nextSceneVersions });
    setSceneId(scene.id);
    setPage("flows");
  }

  function updateScene(sceneIdToUpdate: SceneId, details: SceneDetails) {
    const nextScenes = scenes.map((scene) => scene.id === sceneIdToUpdate ? { ...scene, ...details } : scene);
    commitWorkspace({ ...workspaceRef.current, scenes: nextScenes });
  }

  function exportWorkspaceScene(sceneIdToExport: SceneId) {
    const scene = scenes.find((item) => item.id === sceneIdToExport);
    if (!scene) return;
    downloadScenePackage(scene, workflows[scene.id] ?? createSceneWorkflow(scene), optionPresets);
  }

  function publishWorkspaceScene(sceneIdToPublish: SceneId) {
    const snapshot = workspaceRef.current;
    const scene = snapshot.scenes.find((item) => item.id === sceneIdToPublish);
    const workflow = snapshot.workflows[sceneIdToPublish];
    if (!scene || !workflow) return undefined;
    const result = publishSceneVersion(snapshot.sceneVersions[sceneIdToPublish], scene, workflow, snapshot.optionPresets);
    if (result.created) {
      commitWorkspace({
        ...snapshot,
        sceneVersions: { ...snapshot.sceneVersions, [sceneIdToPublish]: result.record },
      });
    }
    return result.version;
  }

  function applyWorkspaceSceneVersion(sceneIdToUpdate: SceneId, versionId: string) {
    const snapshot = workspaceRef.current;
    const version = snapshot.sceneVersions[sceneIdToUpdate]?.versions.find((item) => item.id === versionId);
    if (!version) return;
    const restored = restoreSceneVersionDraft(version, snapshot.optionPresets);
    const nextScenes = snapshot.scenes.map((scene) => scene.id === sceneIdToUpdate ? restored.scene : scene);
    const nextWorkflows = { ...snapshot.workflows, [sceneIdToUpdate]: restored.workflow };
    commitWorkspace({ ...snapshot, scenes: nextScenes, workflows: nextWorkflows, optionPresets: restored.optionPresets });
  }

  async function importWorkspaceScene(file: File) {
    try {
      const parsed = parseScenePackage(JSON.parse(await file.text()));
      const imported = prepareImportedScene(parsed, optionPresets);
      const nextScenes = [...scenes, imported.scene];
      const nextWorkflows = { ...workflows, [imported.scene.id]: imported.workflow };
      const nextSceneVersions = { ...workspaceRef.current.sceneVersions, [imported.scene.id]: { publishedVersionId: null, versions: [] } };
      const importedPresetIds = new Set(imported.optionPresets.map((preset) => preset.id));
      const nextOptionPresets = [...optionPresets.filter((preset) => !importedPresetIds.has(preset.id)), ...imported.optionPresets];
      commitWorkspace({ ...workspaceRef.current, scenes: nextScenes, workflows: nextWorkflows, optionPresets: nextOptionPresets, sceneVersions: nextSceneVersions });
      setSceneId(imported.scene.id);
      setPage("flows");
    } catch (error) {
      window.alert(error instanceof Error ? error.message : "导入场景失败，请检查文件内容");
    }
  }

  function deleteScene(sceneIdToDelete: SceneId) {
    const scene = scenes.find((item) => item.id === sceneIdToDelete);
    if (!scene) return;
    const sceneDrafts = drafts.filter((draft) => draft.sceneId === sceneIdToDelete);
    const draftMessage = sceneDrafts.length ? `以及 ${sceneDrafts.length} 份关联草稿` : "";
    if (!window.confirm(`确定删除“${scene.title}”吗？这会同时删除该场景的流程配置${draftMessage}。项目目录中的运行归档会保留。`)) return;

    const nextScenes = scenes.filter((item) => item.id !== sceneIdToDelete);
    const nextWorkflows = Object.fromEntries(Object.entries(workflows).filter(([id]) => id !== sceneIdToDelete));
    const nextSceneVersions = Object.fromEntries(Object.entries(workspaceRef.current.sceneVersions).filter(([id]) => id !== sceneIdToDelete));
    const nextDrafts = drafts.filter((draft) => draft.sceneId !== sceneIdToDelete);
    commitWorkspace({ ...workspaceRef.current, scenes: nextScenes, workflows: nextWorkflows, drafts: nextDrafts, sceneVersions: nextSceneVersions });
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
    commitWorkspace({ ...workspaceRef.current, optionPresets: nextOptionPresets, workflows: nextWorkflows });
  }

  const selectedScene = scenes.find((scene) => scene.id === sceneId);
  const selectedWorkflow = workflows[sceneId];
  const selectedVersionRecord = sceneVersions[sceneId];
  const selectedPublishedVersion = publishedSceneVersion(selectedVersionRecord);
  const currentScene = selectedPublishedVersion?.scene ?? getScene(sceneId, scenes);
  const activeDraft = activeDraftId ? drafts.find((draft) => draft.id === activeDraftId) : undefined;
  const title = page === "studio" ? currentScene.title : navLabels[page];
  const dateLabel = new Intl.DateTimeFormat("zh-CN", { weekday: "long", month: "long", day: "numeric" }).format(new Date());

  if (workspaceStatus !== "ready") {
    return <main className="workspace-bootstrap">
      <section className="workspace-bootstrap-panel">
        <div className="workspace-bootstrap-icon"><Database size={20} /></div>
        <p className="eyebrow"><span className="eyebrow-line" />本机共享工作区</p>
        <h1>{workspaceStatus === "loading" ? "连接本机工作区" : "选择要同步的现有配置"}</h1>
        {workspaceStatus === "loading" ? <p className="workspace-bootstrap-copy">正在读取 8799 服务上的共享场景、流程和草稿。</p> : <>
          <p className="workspace-bootstrap-copy">服务端还没有工作区。请在保存着你现有 AI 生图、AI 生视频场景的设备上初始化；当前浏览器的配置将成为电脑和手机共同使用的数据。</p>
          <div className="workspace-bootstrap-scenes"><strong>当前设备将导入 {initialWorkspace.scenes.length} 个场景</strong>
            {initialWorkspace.scenes.length ? <ul>{initialWorkspace.scenes.map((scene) => <li key={scene.id}>{scene.title}</li>)}</ul> : <span>没有找到已保存的场景</span>}
          </div>
          <button className="button button-dark" onClick={() => void initializeServerWorkspace()} disabled={workspaceInitializing || !initialWorkspace.scenes.length}>
            {workspaceInitializing ? <LoaderCircle className="spin" size={15} /> : <Database size={15} />}
            {workspaceInitializing ? "正在初始化…" : "用当前设备配置初始化本机工作区"}
          </button>
        </>}
        {workspaceSyncError && <div className="workspace-bootstrap-error" role="alert">{workspaceSyncError}</div>}
        {workspaceStatus === "loading" && workspaceSyncError && <button className="button button-outline" onClick={() => { setWorkspaceSyncError(""); setWorkspaceLoadAttempt((attempt) => attempt + 1); }}><RotateCw size={14} />重试连接</button>}
      </section>
    </main>;
  }

  return (
    <div className="app-shell">
      <Sidebar page={page} sceneId={sceneId} scenes={scenes} onNavigate={setPage} onOpenScene={openScene} />
      <main className="main-column">
        <header className="topbar">
          <div className="topbar-context"><span className="topbar-workspace"><span className="workspace-dot" />本地工作区</span><ChevronRight size={14} /><span>{title}</span></div>
          <div className="topbar-actions">
            <span className="topbar-date">{dateLabel}</span>
            {workspaceSyncError && <span className="workspace-sync-status" title={workspaceSyncError}>本机配置未同步</span>}
            <button className="icon-button refresh-button" title="刷新连接状态" aria-label="刷新连接状态" onClick={() => refreshConnections().catch(() => undefined)} disabled={refreshing}>
              <RotateCw className={refreshing ? "spin" : ""} size={15} />
            </button>
            <span className="topbar-divider" />
            <span className="profile-badge" title="个人空间">Z</span>
          </div>
        </header>

        <div className="page-scroll">
          <div className="page-content" key={page === "studio" ? `${page}-${sceneId}` : page}>
            {page === "home" && <Dashboard drafts={drafts} scenes={scenes} workflows={workflows} optionPresets={optionPresets} sceneVersions={sceneVersions} connectors={connectors} onNavigate={setPage} onOpenScene={openScene} onCreateScene={createWorkspaceScene} onUpdateScene={updateScene} onDeleteScene={deleteScene} onExportScene={exportWorkspaceScene} onImportScene={importWorkspaceScene} />}
            {page === "studio" && selectedPublishedVersion && <Studio sceneId={sceneId} scene={selectedPublishedVersion.scene} workflow={selectedPublishedVersion.workflow} draft={activeDraft} onNavigate={setPage} onBack={() => setPage("home")} onSaveDraft={saveDraft} onStartRun={startWorkflowRun} onCancelRun={cancelWorkflowRun} />}
            {page === "studio" && !selectedPublishedVersion && <section className="scene-unpublished"><span className="scene-unpublished-icon"><Rocket size={17} /></span><div><h2>这个场景还没有发布版本</h2><p>暂存配置不会用于创作。完成流程配置并发布后，场景才可使用。</p></div><button className="button button-dark" onClick={() => setPage("flows")}>前往流程配置</button></section>}
            {page === "history" && <History drafts={drafts} scenes={scenes} onNavigate={setPage} onOpenScene={openScene} />}
            {page === "runs" && <WorkflowRuns scenes={scenes} onNavigate={setPage} selectedRunId={selectedRunId} onSelectRun={selectRun} onCancelRun={cancelWorkflowRun} onResumeRun={resumeWorkflowRun} activeRunId={selectedRunId !== null && activeRunIds.includes(selectedRunId) ? selectedRunId : null} canCancelRun={selectedRunId !== null && activeRunIds.includes(selectedRunId)} runStartError={selectedRunId ? runStartErrors[selectedRunId] : undefined} />}
            {page === "assets" && <Library drafts={drafts} scenes={scenes} onNavigate={setPage} onOpenScene={openScene} />}
            {page === "connections" && <Connections connectors={connectors} onRefresh={refreshConnections} />}
            {page === "flows" && selectedScene && selectedWorkflow && <FlowDesigner sceneId={sceneId} scenes={scenes} scene={selectedScene} workflow={selectedWorkflow} optionPresets={optionPresets} versionRecord={selectedVersionRecord} onSceneChange={setSceneId} onChange={updateWorkflow} onOptionPresetsChange={updateOptionPresets} onPublish={() => publishWorkspaceScene(sceneId)} onApplyVersion={(version: SceneVersion) => applyWorkspaceSceneVersion(sceneId, version.id)} onOpenConnections={() => setPage("connections")} />}
          </div>
          <footer className="app-footer"><span>在本地专注创作</span><span><Command size={12} /> ZANE STUDIO</span></footer>
        </div>
      </main>
    </div>
  );
}
