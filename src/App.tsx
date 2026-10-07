import { sortWorkflowDrafts } from "./lib/drafts";
import { getTaskDraft, setTaskDraftFavorite } from "./lib/taskDraftApi";
import { DraftFavoriteUnconfirmedError, writeDraftFavorite } from "./lib/draftFavoriteWrite";
import LegacyConfigRecovery from "./components/LegacyConfigRecovery";
import SystemFeedback from "./features/SystemFeedback";
import UserManagement from "./features/UserManagement";
import { RetainedSaveQueue, type PendingSave } from "./lib/retainedSaveQueue";
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
import { cancelWorkflowRun as requestWorkflowRunCancellation, checkConnections, initializeWorkspace, loadWorkspace, loadWorkspaceStatus, mergeWorkspace, runWorkflow, submitWorkflowRerun, waitForWorkflowRun } from "./lib/api";
import { createScene, moveScene } from "./lib/sceneStorage";
import { createEmptyWorkspaceSnapshot, normalizeWorkspaceSnapshot } from "./lib/workspaceStorage";
import { readAuthoritativeWorkspace, loadAuthoritativeWorkspace, parseRetainedWorkspaceEdits, retainWorkspaceReferences, replaceWorkspaceFromAuthority, WorkspaceSynchronizer } from "./lib/workspaceSync";
import { createId } from "./lib/ids";
import { downloadScenePackage, parseScenePackage, prepareImportedScene } from "./lib/sceneTransfer";
import { publishedSceneVersion, publishSceneVersion, restoreSceneVersionDraft } from "./lib/sceneVersions";
import FlowDesigner from "./features/FlowDesigner";
import SceneOrderDialog from "./features/SceneOrderDialog";
import type { ConnectorState, JsonValue, PageId, SceneDetails, SceneId, SceneModule, SceneVersion, SceneVersionRecord, WorkflowDefinition, WorkflowDraft, WorkflowOptionPreset, WorkflowRunRecord, WorkspaceSnapshot } from "./types";

import type { RerunRequest } from "../server/domain/rerunContracts.js";

const navLabels: Record<PageId, string> = {
  home: "管理概览",
  users: "用户管理",
  feedback: "系统反馈",
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

export default function App({ userId, displayName, onLogout, onOpenUserView }: { userId: string; displayName: string; onLogout: () => void; onOpenUserView: () => void }) {
  const outboxStorageKey = "zane-studio:config-outbox:v2:" + userId;
  const bootstrapWorkspaceRef = useRef<WorkspaceSnapshot | null>(null);
  const initialWorkspace = bootstrapWorkspaceRef.current ?? createEmptyWorkspaceSnapshot();
  bootstrapWorkspaceRef.current = initialWorkspace;
  const [page, setPage] = useState<PageId>("home");
  const pageRef = useRef(page);
  pageRef.current = page;
  const [scenes, setScenes] = useState<SceneModule[]>(initialWorkspace.scenes);
  const [showSceneOrder, setShowSceneOrder] = useState(false);
  const [sceneId, setSceneId] = useState<SceneId>(initialWorkspace.scenes[0]?.id ?? "");
  const sceneIdRef = useRef(sceneId);
  sceneIdRef.current = sceneId;
  const [studioPublication, setStudioPublication] = useState<SceneVersion | null>(null);
  const studioPublicationRef = useRef<SceneVersion | null>(null);
  const workspaceEditorEpochRef = useRef(0);
  function selectStudioPublication(value: SceneVersion | null) { studioPublicationRef.current = value; setStudioPublication(value); }
  const [activeDraftId, setActiveDraftId] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<WorkflowDraft[]>(initialWorkspace.drafts);
  const draftsRef = useRef(drafts);
  const draftFavoriteBusyRef = useRef(false);
  const [draftFavoriteBusy, setDraftFavoriteBusy] = useState(false);
  const [draftFavoriteUnknown, setDraftFavoriteUnknown] = useState(false);
  const [workflows, setWorkflows] = useState<Record<SceneId, WorkflowDefinition>>(initialWorkspace.workflows);
  const [optionPresets, setOptionPresets] = useState<WorkflowOptionPreset[]>(initialWorkspace.optionPresets);
  const [sceneVersions, setSceneVersions] = useState<Record<SceneId, SceneVersionRecord>>(initialWorkspace.sceneVersions);
  const workspaceRef = useRef<WorkspaceSnapshot>(initialWorkspace);
  const workspaceSaveQueueRef = useRef<RetainedSaveQueue<WorkspaceSnapshot> | null>(null);
  const restoredWorkspaceEditsRef = useRef(false);
  const outboxReadErrorRef = useRef("");
  const [workspaceSyncError, setWorkspaceSyncError] = useState("");
  const [workspaceReadError, setWorkspaceReadError] = useState("");
  const [workspaceRevision, setWorkspaceRevision] = useState(initialWorkspace.revision);
  const [workspaceRemoteRevision, setWorkspaceRemoteRevision] = useState<number | null>(null);
  const [workspacePendingCount, setWorkspacePendingCount] = useState(0);
  const [workspaceLegacyRead, setWorkspaceLegacyRead] = useState(false);
  const workspaceSynchronizerRef = useRef<WorkspaceSynchronizer | null>(null);
  const [workspaceStatus, setWorkspaceStatus] = useState<"loading" | "missing" | "ready">("loading");
  const [workspaceInitializing, setWorkspaceInitializing] = useState(false);
  const [workspaceLoadAttempt, setWorkspaceLoadAttempt] = useState(0);
  const [connectors, setConnectors] = useState<ConnectorState[]>(initialConnectors);
  const [refreshing, setRefreshing] = useState(false);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [activeRunIds, setActiveRunIds] = useState<string[]>([]);
  const [pendingSubmissionIds, setPendingSubmissionIds] = useState<string[]>([]);
  const [runStartErrors, setRunStartErrors] = useState<Record<string, string>>({});
  const runControllersRef = useRef(new Map<string, AbortController>());

  function applyWorkspace(value: WorkspaceSnapshot) {
    const next = retainWorkspaceReferences(workspaceRef.current, { ...value, drafts: sortWorkflowDrafts(value.drafts) });
    setWorkspaceRevision(next.revision);
    workspaceRef.current = next;
    draftsRef.current = next.drafts;
    setScenes(next.scenes);
    setWorkflows(next.workflows);
    setOptionPresets(next.optionPresets);
    setSceneVersions(next.sceneVersions);
    setDrafts(next.drafts);
    setSceneId((current) => (pageRef.current === "studio" && studioPublicationRef.current?.scene.id === current) || next.scenes.some((scene) => scene.id === current) ? current : next.scenes[0]?.id ?? "");
  }

  if (!workspaceSaveQueueRef.current) {
    let pending: PendingSave<WorkspaceSnapshot>[] = [];
    try {
      pending = parseRetainedWorkspaceEdits(window.localStorage.getItem(outboxStorageKey));
      restoredWorkspaceEditsRef.current = pending.length > 0;
    } catch (error) {
      // Preserve unreadable storage verbatim; only an explicit discard may remove it.
      restoredWorkspaceEditsRef.current = true;
      outboxReadErrorRef.current = error instanceof Error ? error.message : "待提交编辑读取失败，原始数据已保留";
    }
    workspaceSaveQueueRef.current = new RetainedSaveQueue({
      initial: pending,
      send: async (base, desired) => readAuthoritativeWorkspace((await mergeWorkspace(base, desired, userId)).workspace),
      persist: (entries) => {
        if (entries.length) window.localStorage.setItem(outboxStorageKey, JSON.stringify(entries));
        else window.localStorage.removeItem(outboxStorageKey);
        if (!entries.length) { restoredWorkspaceEditsRef.current = false; outboxReadErrorRef.current = ""; }
        setWorkspacePendingCount(entries.length);
      },
      saved: (workspace, remaining) => {
        if (!remaining) { applyWorkspace(workspace); setWorkspaceRemoteRevision(workspace.revision ?? null); setWorkspaceSyncError(""); }
      },
      failed: (error) => setWorkspaceSyncError(error.message),
    });
  }

  function commitWorkspace(value: WorkspaceSnapshot) {
    if (draftFavoriteBusyRef.current) { setWorkspaceSyncError("收藏正在确认，请稍后再保存配置"); return false; }
    if (restoredWorkspaceEditsRef.current) {
      setWorkspaceSyncError(outboxReadErrorRef.current || "上次未确认编辑已保留。当前显示服务端场景，请先恢复提交或读取服务端配置，再继续修改");
      return false;
    }
    const base = workspaceRef.current;
    const next = normalizeWorkspaceSnapshot(value, workspaceRef.current);
    applyWorkspace(next);
    workspaceSaveQueueRef.current!.enqueue(base, next);
    return true;
  }

  useEffect(() => {
    let disposed = false;
    async function syncWorkspace() {
      try {
        const workspace = await loadAuthoritativeWorkspace(loadWorkspace);
        if (disposed) return;
        if (!workspace) {
          setWorkspaceStatus("missing");
          return;
        }
        // Always display the server snapshot. Restored outbox is retained intent,
        // not a second catalog and not an automatic write during startup.
        applyWorkspace(workspace);
        setWorkspacePendingCount(workspaceSaveQueueRef.current!.pendingCount);
        setWorkspaceRemoteRevision(workspace.revision ?? null);
        setWorkspaceStatus("ready");
        setWorkspaceSyncError(restoredWorkspaceEditsRef.current
          ? outboxReadErrorRef.current || "上次未确认编辑已保留；当前只显示服务端场景。核对后可恢复提交，或明确放弃并读取服务端配置"
          : "");
      } catch (error) {
        if (!disposed) setWorkspaceSyncError(error instanceof Error ? error.message : "服务端管理配置同步失败");
      }
    }
    void syncWorkspace();
    return () => { disposed = true; };
  }, [workspaceLoadAttempt]);

  useEffect(() => {
    if (workspaceStatus !== "ready") return;
    const sync = new WorkspaceSynchronizer({
      current: () => workspaceRef.current,
      // Deferred text fields commit on blur. Studio inputs and dialogs have their
      // own drafts; notify about changes instead of replacing those underneath them.
      blocked: () => draftFavoriteBusyRef.current || Boolean(workspaceSaveQueueRef.current?.pendingCount)
        || pageRef.current === "studio"
        || Boolean(document.activeElement?.closest("input, textarea, select, [contenteditable='true']"))
        || Boolean(document.querySelector("[role='dialog'], [aria-modal='true']")),
      readStatus: loadWorkspaceStatus,
      readWorkspace: loadWorkspace,
      observed: status => { setWorkspaceRemoteRevision(status.workspaceRevision); setWorkspaceLegacyRead(status.readMode === "legacy-snapshot"); setWorkspaceReadError(""); },
      apply: workspace => { applyWorkspace(workspace); setWorkspaceRemoteRevision(workspace.revision ?? null); },
      failed: error => setWorkspaceReadError(error.message),
    });
    workspaceSynchronizerRef.current = sync;
    const refresh = () => { if (document.visibilityState !== "hidden") void sync.refresh(); };
    const timer = window.setInterval(refresh, 3000);
    const afterBlur = () => { window.setTimeout(refresh, 0); };
    window.addEventListener("focus", refresh);
    window.addEventListener("online", refresh);
    document.addEventListener("visibilitychange", refresh);
    document.addEventListener("focusout", afterBlur);
    refresh();
    return () => {
      sync.stop();
      if (workspaceSynchronizerRef.current === sync) workspaceSynchronizerRef.current = null;
      window.clearInterval(timer);
      window.removeEventListener("focus", refresh);
      window.removeEventListener("online", refresh);
      document.removeEventListener("visibilitychange", refresh);
      document.removeEventListener("focusout", afterBlur);
    };
  }, [workspaceStatus]);

  useEffect(() => { void workspaceSynchronizerRef.current?.refresh(); }, [page]);

  async function initializeServerWorkspace() {
    setWorkspaceInitializing(true);
    setWorkspaceSyncError("");
    try {
      const result = await initializeWorkspace(createEmptyWorkspaceSnapshot());
      const workspace = readAuthoritativeWorkspace(result.workspace);
      applyWorkspace(workspace);
      setWorkspaceRemoteRevision(workspace.revision ?? null);
      setWorkspacePendingCount(workspaceSaveQueueRef.current!.pendingCount);
      setWorkspaceSyncError(restoredWorkspaceEditsRef.current ? outboxReadErrorRef.current || "上次未确认编辑已保留，未导入服务端；请核对后恢复或明确放弃" : "");
      setWorkspaceStatus("ready");
    } catch (error) {
      setWorkspaceSyncError(error instanceof Error ? error.message : "无法初始化服务端场景目录");
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
    selectStudioPublication(published ?? null);
    setActiveDraftId(published ? draftId ?? null : null);
    setPage(published ? "studio" : "flows");
  }

  async function loadLatestWorkspace(discardPending = false) {
    const outbox = workspaceSaveQueueRef.current!;
    if (!discardPending && outbox.pendingCount) {
      setWorkspaceSyncError("本机还有未同步配置，请先重试，或选择“读取正式配置”");
      return;
    }
    if (discardPending && (outbox.pendingCount || restoredWorkspaceEditsRef.current) && !window.confirm("未确认的编辑尚未成为服务端配置。确定放弃这些待提交内容，并读取服务端权威配置吗？")) return;
    if (pageRef.current === "studio" && !window.confirm("刷新可能切换创作的发布版本，并重载表单。请先保存当前任务草稿；确定继续吗？")) return;
    const editorEpoch = workspaceEditorEpochRef.current;
    const sourcePage = pageRef.current;
    const sourceSceneId = sceneIdRef.current;
    try {
      await replaceWorkspaceFromAuthority({
        current: () => workspaceRef.current, queue: outbox,
        readWorkspace: loadWorkspace, discardPending,
        canApply: () => workspaceEditorEpochRef.current === editorEpoch && pageRef.current === sourcePage && sceneIdRef.current === sourceSceneId,
        apply: workspace => {
          if (sourcePage === "studio") {
            selectStudioPublication(publishedSceneVersion(workspace.sceneVersions[sourceSceneId]) ?? null);
            if (!workspace.scenes.some(scene => scene.id === sourceSceneId)) setPage("home");
          }
          applyWorkspace(workspace);
          setWorkspaceRemoteRevision(workspace.revision ?? null);
          setWorkspaceStatus("ready");
          setWorkspaceSyncError(restoredWorkspaceEditsRef.current ? outboxReadErrorRef.current || "上次未确认编辑仍保留，当前显示服务端场景；请明确恢复或放弃" : "");
          setWorkspaceReadError("");
        },
      });
    } catch (error) {
      setWorkspaceReadError(error instanceof Error ? error.message : "读取权威工作区失败");
    }
  }

  async function retryPendingWorkspace() {
    if (outboxReadErrorRef.current) { setWorkspaceSyncError(outboxReadErrorRef.current); return; }
    if (restoredWorkspaceEditsRef.current) {
      if (!window.confirm("当前显示的是服务端场景。恢复提交上次未确认的编辑吗？将保留原 ID 和基线，由服务端校验冲突，不会覆盖冲突配置。")) return;
      try {
        const workspace = await loadAuthoritativeWorkspace(loadWorkspace);
        if (!workspace) throw new Error("管理配置尚未初始化，不能恢复旧编辑");
        // Read before retrying lost receipts; do not display a browser-owned snapshot.
        setWorkspaceRemoteRevision(workspace.revision ?? null);
      } catch (error) {
        setWorkspaceSyncError(error instanceof Error ? error.message : "服务端对账失败，未恢复提交");
        return;
      }
    }
    await workspaceSaveQueueRef.current!.retry();
  }

  async function saveDraft(draft: WorkflowDraft) {
    const existing = draftsRef.current.find(item => item.id === draft.id);
    const next = sortWorkflowDrafts([{ ...draft, isFavorite: existing?.isFavorite ?? draft.isFavorite ?? false }, ...draftsRef.current.filter((item) => item.id !== draft.id)]);
    if (!commitWorkspace({ ...workspaceRef.current, drafts: next })) throw new Error("草稿未提交，请处理待确认编辑");
    await workspaceSaveQueueRef.current!.waitForSaved();
  }

  async function reconcileDraftFavorites() {
    const base = workspaceRef.current;
    if (workspaceSaveQueueRef.current!.pendingCount || restoredWorkspaceEditsRef.current) throw new Error("请先处理未确认的配置编辑，再读取收藏状态");
    const snapshot = await loadAuthoritativeWorkspace(loadWorkspace);
    if (!snapshot) throw new Error("服务端工作区尚未初始化");
    if (workspaceRef.current !== base || workspaceSaveQueueRef.current!.pendingCount) throw new Error("读取期间有新编辑，未替换本机内容，请重新对账");
    applyWorkspace(snapshot); setWorkspaceRemoteRevision(snapshot.revision ?? null); setDraftFavoriteUnknown(false);
  }

  async function changeDraftFavorite(id: string, isFavorite: boolean) {
    if (draftFavoriteBusyRef.current || draftFavoriteUnknown) throw new Error("请先等候或读取服务端收藏状态对账");
    if (workspaceSaveQueueRef.current!.pendingCount || restoredWorkspaceEditsRef.current) throw new Error("请先处理未确认的配置编辑，再收藏草稿");
    const base = workspaceRef.current;
    if (!base.revision || !base.drafts.some(draft => draft.id === id)) throw new Error("请先读取服务端任务草稿");
    draftFavoriteBusyRef.current = true; setDraftFavoriteBusy(true);
    try {
      const result = await writeDraftFavorite({
        isFavorite,
        write: () => setTaskDraftFavorite(id, { revision: base.revision!, isFavorite }, userId),
        read: () => getTaskDraft(id, userId),
        favorite: snapshot => snapshot.draft.isFavorite,
      });
      if (result.outcome === "saved" && workspaceRef.current === base && !workspaceSaveQueueRef.current!.pendingCount) {
        applyWorkspace(normalizeWorkspaceSnapshot({ ...base, revision: result.snapshot.revision, drafts: base.drafts.map(draft => draft.id === id ? { ...draft, isFavorite: result.snapshot.draft.isFavorite } : draft) }, base));
        setWorkspaceRemoteRevision(result.snapshot.revision);
      } else await reconcileDraftFavorites();
      if (result.error) throw new Error(result.error.message + "；已读取服务端状态，请核对后再操作。");
    } catch (error) {
      if (error instanceof DraftFavoriteUnconfirmedError) setDraftFavoriteUnknown(true);
      throw error;
    } finally { draftFavoriteBusyRef.current = false; setDraftFavoriteBusy(false); }
  }

  const startWorkflowRun = useCallback(async (workflow: WorkflowDefinition, inputValues: Record<string, JsonValue>, runId: string, runTitle?: string, resumeFromRunId?: string) => {
    const controller = new AbortController();
    runControllersRef.current.set(runId, controller);
    setSelectedRunId(runId);
    setActiveRunIds((current) => [...current, runId]);
    setPendingSubmissionIds((current) => [...current, runId]);
    setRunStartErrors((current) => ({ ...current, [runId]: "" }));
    setPage("runs");
    try {
      return await runWorkflow(workflow, inputValues, controller.signal, runId, resumeFromRunId, runTitle,
        () => setPendingSubmissionIds((current) => current.filter((id) => id !== runId)));
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
      setPendingSubmissionIds((current) => current.filter((id) => id !== runId));
      setActiveRunIds((current) => current.filter((id) => id !== runId));
    }
  }, []);

  const resumeWorkflowRun = useCallback(async (source: WorkflowRunRecord) => {
    if (!source.workflow) return;
    const runId = createId();
    await startWorkflowRun(source.workflow, source.inputValues, runId, source.runTitle, source.runId);
  }, [startWorkflowRun]);

  const rerunWorkflowRun = useCallback(async (source: WorkflowRunRecord, changes: RerunRequest) => {
    const runId = createId();
    // Keep the edit dialog and its drafts until the server has accepted the revision.
    await submitWorkflowRerun(source.runId, changes, runId, (source.runTitle || source.workflowName).slice(0, 110) + " · 修订");
    const controller = new AbortController();
    runControllersRef.current.set(runId, controller);
    setActiveRunIds((current) => [...current, runId]);
    setSelectedRunId(runId);
    setPage("runs");
    setRunStartErrors((current) => ({ ...current, [runId]: "" }));
    void waitForWorkflowRun(runId, controller.signal).catch((error: unknown) => {
      if (!controller.signal.aborted) setRunStartErrors((current) => ({ ...current, [runId]: error instanceof Error ? error.message : "局部重做失败" }));
    }).finally(() => {
      runControllersRef.current.delete(runId);
      setActiveRunIds((current) => current.filter((id) => id !== runId));
    });
  }, []);

  const cancelWorkflowRun = useCallback((runId: string) => {
    void requestWorkflowRunCancellation(runId).then(() => {
      setRunStartErrors((current) => ({ ...current, [runId]: "" }));
    }).catch((error: unknown) => {
      setRunStartErrors((current) => ({ ...current, [runId]: error instanceof Error ? error.message : "取消请求失败，后台任务仍在运行" }));
    });
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
    if (!commitWorkspace({ ...workspaceRef.current, scenes: nextScenes, workflows: nextWorkflows, sceneVersions: nextSceneVersions })) return;
    setSceneId(scene.id);
    setPage("flows");
  }

  function updateScene(sceneIdToUpdate: SceneId, details: SceneDetails) {
    const nextScenes = scenes.map((scene) => scene.id === sceneIdToUpdate ? { ...scene, ...details } : scene);
    commitWorkspace({ ...workspaceRef.current, scenes: nextScenes });
  }

  function moveWorkspaceScene(sceneIdToMove: SceneId, targetIndex: number) {
    const snapshot = workspaceRef.current;
    const nextScenes = moveScene(snapshot.scenes, sceneIdToMove, targetIndex);
    if (nextScenes !== snapshot.scenes) commitWorkspace({ ...snapshot, scenes: nextScenes });
  }

  function exportWorkspaceScene(sceneIdToExport: SceneId) {
    const scene = scenes.find((item) => item.id === sceneIdToExport);
    if (!scene) return;
    downloadScenePackage(scene, workflows[scene.id] ?? createSceneWorkflow(scene), optionPresets);
  }

  async function publishWorkspaceScene(sceneIdToPublish: SceneId) {
    const snapshot = workspaceRef.current;
    const scene = snapshot.scenes.find((item) => item.id === sceneIdToPublish);
    const workflow = snapshot.workflows[sceneIdToPublish];
    if (!scene || !workflow) return undefined;
    const result = publishSceneVersion(snapshot.sceneVersions[sceneIdToPublish], scene, workflow, snapshot.optionPresets);
    if (result.created) {
      if (!commitWorkspace({
        ...snapshot,
        sceneVersions: { ...snapshot.sceneVersions, [sceneIdToPublish]: result.record },
      })) return undefined;
    }
    await workspaceSaveQueueRef.current!.waitForSaved();
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
      if (!commitWorkspace({ ...workspaceRef.current, scenes: nextScenes, workflows: nextWorkflows, optionPresets: nextOptionPresets, sceneVersions: nextSceneVersions })) return;
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
    if (!commitWorkspace({ ...workspaceRef.current, scenes: nextScenes, workflows: nextWorkflows, drafts: nextDrafts, sceneVersions: nextSceneVersions })) return;
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
  const activeStudioPublication = studioPublication?.scene.id === sceneId ? studioPublication : selectedPublishedVersion;
  const studioPublicationChanged = page === "studio" && Boolean(activeStudioPublication && activeStudioPublication.id !== selectedPublishedVersion?.id);
  const currentScene = (page === "studio" ? activeStudioPublication?.scene : selectedPublishedVersion?.scene) ?? getScene(sceneId, scenes);
  const activeDraft = activeDraftId ? drafts.find((draft) => draft.id === activeDraftId) : undefined;
  const title = page === "studio" ? currentScene.title : navLabels[page];
  const dateLabel = new Intl.DateTimeFormat("zh-CN", { weekday: "long", month: "long", day: "numeric" }).format(new Date());

  if (workspaceStatus !== "ready") {
    return <main className="workspace-bootstrap">
      <section className="workspace-bootstrap-panel">
        <div className="workspace-bootstrap-icon"><Database size={20} /></div>
        <p className="eyebrow"><span className="eyebrow-line" />管理员后台</p>
        <h1>{workspaceStatus === "loading" ? "连接管理配置" : "管理配置尚未初始化"}</h1>
        {workspaceStatus === "loading" ? <p className="workspace-bootstrap-copy">正在读取当前后台上的权威场景、流程和草稿；不会用浏览器缓存替代。</p> : <>
          <p className="workspace-bootstrap-copy">场景、流程和发布版本只保存在服务端。可以初始化空的场景目录，再通过网页或 AI 明确创建、导入场景；不会读取或上传浏览器旧场景，不会自动补入内置场景。</p>
          <button className="button button-dark" onClick={() => void initializeServerWorkspace()} disabled={workspaceInitializing}>
            {workspaceInitializing ? <LoaderCircle className="spin" size={15} /> : <Database size={15} />}
            {workspaceInitializing ? "正在初始化…" : "初始化场景目录"}
          </button>
        </>}
        {workspaceSyncError && <div className="workspace-bootstrap-error" role="alert">{workspaceSyncError}</div>}
        {workspaceStatus === "loading" && workspaceSyncError && <button className="button button-outline" onClick={() => { setWorkspaceSyncError(""); setWorkspaceLoadAttempt((attempt) => attempt + 1); }}><RotateCw size={14} />重试连接</button>}
      </section>
    </main>;
  }

  return (
    <div className="app-shell" onInputCapture={() => { workspaceEditorEpochRef.current += 1; }} onChangeCapture={() => { workspaceEditorEpochRef.current += 1; }}>
      <Sidebar page={page} sceneId={sceneId} scenes={scenes} onNavigate={setPage} onOpenScene={openScene} onSortScenes={() => setShowSceneOrder(true)} />
      <main className="main-column">
        <header className="topbar">
          <div className="topbar-context"><span className="topbar-workspace"><span className="workspace-dot" />管理后台</span><ChevronRight size={14} /><span>{title}</span></div>
          <div className="topbar-actions">
            <span className="topbar-date">{dateLabel}</span>
            <button className="button button-outline" onClick={onOpenUserView}>用户端预览</button>
            <button className="button button-outline" disabled={workspacePendingCount > 0} onClick={onLogout}>退出 {displayName}</button>
            <span className="workspace-authority-status" title={`来源：${window.location.origin} · SQLite 权威配置。目录/流程配置为草稿，创作为发布快照。${workspaceLegacyRead ? "旧后台兼容读取共享快照；新增AI操作需升级到匹配契约的后台后生效。" : "轻量revision同步。"}${workspacePendingCount ? "本机修改尚未取得保存回执。" : ""}`}>
              {workspacePendingCount ? `${restoredWorkspaceEditsRef.current ? "旧编辑待确认" : "编辑待同步"} · 服务端 r${workspaceRevision ?? "—"}` : `共享配置 r${workspaceRevision ?? "—"}`}
            </span>
            {workspaceRemoteRevision !== null && workspaceRemoteRevision !== workspaceRevision && <span className="workspace-update-notice" role="status">配置有更新 · 待同步 r{workspaceRemoteRevision}</span>}
            {studioPublicationChanged && <span className="workspace-update-notice" role="status">发布版有更新 · 当前创作保留原版</span>}
            {workspaceReadError && <span className="workspace-update-notice" role="status" title={workspaceReadError}>同步读取失败 · 请刷新</span>}
            {workspaceSyncError && <>
              <button className="button button-outline workspace-sync-status" title={workspaceSyncError} onClick={() => void retryPendingWorkspace()} disabled={Boolean(outboxReadErrorRef.current)}>{restoredWorkspaceEditsRef.current ? "恢复待提交编辑" : "配置未同步 · 重试"}</button>
              <button className="button button-outline workspace-sync-status" title="放弃本机未同步配置，读取正式配置" onClick={() => void loadLatestWorkspace(true)}>读取正式配置</button>
            </>}
            <button className="button button-outline workspace-refresh-button" title="从当前后台读取权威配置；有未同步编辑时不会自动覆盖" onClick={() => void loadLatestWorkspace(false)}>刷新配置</button>
            <button className="icon-button refresh-button" title="刷新连接状态" aria-label="刷新连接状态" onClick={() => refreshConnections().catch(() => undefined)} disabled={refreshing}>
              <RotateCw className={refreshing ? "spin" : ""} size={15} />
            </button>
            <span className="topbar-divider" />
            <span className="profile-badge" title="管理员">Z</span>
          </div>
        </header>
        <LegacyConfigRecovery />

        <div className="page-scroll">
          <div className="page-content" key={page === "studio" ? `${page}-${sceneId}` : page}>
            {page === "home" && <Dashboard drafts={drafts} scenes={scenes} workflows={workflows} optionPresets={optionPresets} sceneVersions={sceneVersions} connectors={connectors} onNavigate={setPage} onOpenScene={openScene} onCreateScene={createWorkspaceScene} onUpdateScene={updateScene} onDeleteScene={deleteScene} onExportScene={exportWorkspaceScene} onImportScene={importWorkspaceScene} onSortScenes={() => setShowSceneOrder(true)} />}
            {page === "studio" && activeStudioPublication && <Studio sceneId={sceneId} scene={activeStudioPublication.scene} workflow={activeStudioPublication.workflow} publication={activeStudioPublication} draft={activeDraft} onNavigate={setPage} onBack={() => setPage("home")} onSaveDraft={saveDraft} onStartRun={startWorkflowRun} onCancelRun={cancelWorkflowRun} onRerunRun={rerunWorkflowRun} />}
            {page === "studio" && !activeStudioPublication && <section className="scene-unpublished"><span className="scene-unpublished-icon"><Rocket size={17} /></span><div><h2>这个场景还没有发布版本</h2><p>暂存配置不会用于创作。完成流程配置并发布后，场景才可使用。</p></div><button className="button button-dark" onClick={() => setPage("flows")}>前往流程配置</button></section>}
            {page === "history" && <History drafts={drafts} scenes={scenes} onNavigate={setPage} onOpenScene={openScene} onSetFavorite={changeDraftFavorite} favoriteBusy={draftFavoriteBusy} favoriteUnknown={draftFavoriteUnknown} onReconcileFavorites={reconcileDraftFavorites} />}
            {page === "runs" && <WorkflowRuns scenes={scenes} onNavigate={setPage} selectedRunId={selectedRunId} onSelectRun={selectRun} onCancelRun={cancelWorkflowRun} onResumeRun={resumeWorkflowRun} onRerunRun={rerunWorkflowRun} activeRunId={selectedRunId !== null && activeRunIds.includes(selectedRunId) ? selectedRunId : null} submissionPending={selectedRunId !== null && pendingSubmissionIds.includes(selectedRunId)} runStartError={selectedRunId ? runStartErrors[selectedRunId] : undefined} />}
            {page === "assets" && <Library drafts={drafts} scenes={scenes} onNavigate={setPage} onOpenScene={openScene} onOpenRun={runId => { selectRun(runId); setPage("runs"); }} />}
            {page === "users" && <UserManagement scenes={scenes} />}
            {page === "feedback" && <SystemFeedback key={userId} userId={userId} admin />}
            {page === "connections" && <Connections connectors={connectors} onRefresh={refreshConnections} />}
            {page === "flows" && selectedScene && selectedWorkflow && <FlowDesigner saveStatus={workspaceSyncError ? "failed" : workspacePendingCount ? "saving" : "saved"} sceneId={sceneId} scenes={scenes} scene={selectedScene} workflow={selectedWorkflow} optionPresets={optionPresets} versionRecord={selectedVersionRecord} onSceneChange={setSceneId} onSortScenes={() => setShowSceneOrder(true)} onChange={updateWorkflow} onOptionPresetsChange={updateOptionPresets} onPublish={() => publishWorkspaceScene(sceneId)} onApplyVersion={(version: SceneVersion) => applyWorkspaceSceneVersion(sceneId, version.id)} onOpenConnections={() => setPage("connections")} />}
          </div>
          <footer className="app-footer"><span>在本地专注创作</span><span><Command size={12} /> ZANE STUDIO</span></footer>
        </div>
      </main>
      {showSceneOrder && <SceneOrderDialog scenes={scenes} onMoveScene={moveWorkspaceScene} onClose={() => setShowSceneOrder(false)} />}
    </div>
  );
}
