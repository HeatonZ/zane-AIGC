import SystemFeedback from "./SystemFeedback";
import { sortOwnDrafts } from "../lib/drafts";
import { getOwnDraft, setOwnDraftFavorite } from "../lib/taskDraftApi";
import { OwnDraftSaveQueue, sameDraftSnapshot, type OwnDraftSaveSession } from "../lib/userDraftAutosave";
import { Star } from "lucide-react";
import UserMediaInput, { type UserMediaKind } from "../components/UserMediaInput";
import ObjectArrayInput from "../components/ObjectArrayInput";
import { visibleInputFields } from "../lib/workflowInputVisibility";
import { DraftFavoriteUnconfirmedError, writeDraftFavorite } from "../lib/draftFavoriteWrite";
import { useEffect, useRef, useState, type FocusEvent } from "react";
import {
  AccessApiError, accessApi, jsonBody, type Account, type AccessPage,
  type AvailableScene, type UserScene, type OwnRun, type OwnDraft,
} from "../lib/accessApi";
import {
  isDefiniteRunRejection, mediaKindByType, mediaKindLabel, uploadedBatchNotice, uploadedInput, uploadFailureMessage,
} from "../lib/userPortal";
import UserRunDetail from "../components/UserRunDetail";
import { runDate, runStatusLabels } from "../lib/runDetails";
import { parseObjectArrayFormValue } from "../lib/objectArrayInput";
import type { WorkflowInputField } from "../types";

type PendingUpload = { id: string; key: string; type: string; sceneId: string };

export default function UserPortal({ user, onLogout, onAdmin }: {
  user: Account; onLogout: () => void; onAdmin?: () => void;
}) {
  const api = <T,>(path: string, options?: RequestInit) => accessApi<T>(path, options, user.id);
  const [page, setPage] = useState<"scenes" | "drafts" | "runs" | "feedback">("scenes");
  const [scenes, setScenes] = useState<AvailableScene[]>([]);
  const [sceneCursor, setSceneCursor] = useState<string>();
  const [scene, setScene] = useState<UserScene>();
  const [values, setValues] = useState<Record<string, unknown>>({});
  const [runTitle, setRunTitle] = useState("");
  const valuesRef = useRef(values);
  valuesRef.current = values;
  const [busy, setBusy] = useState(false);
  const [uploadingKey, setUploadingKey] = useState("");
  const [draftSaving, setDraftSaving] = useState(false);
  const [draftAutoSaveStatus, setDraftAutoSaveStatus] = useState<"idle" | "pending" | "saving" | "saved" | "error" | "reconcile" | "review">("idle");
  const draftSaveCountRef = useRef(0);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [drafts, setDrafts] = useState<OwnDraft[]>([]);
  const [draftCursor, setDraftCursor] = useState<string>();
  const [favoriteBusy, setFavoriteBusy] = useState(false);
  const favoriteBusyRef = useRef(false);
  const [favoriteUnknownId, setFavoriteUnknownId] = useState("");
  const draftReadSequence = useRef(0);
  const [draftId, setDraftId] = useState<string>(() => crypto.randomUUID());
  const [draftRevision, setDraftRevision] = useState(0);
  const [draftUnknown, setDraftUnknown] = useState(false);
  const draftSessionRef = useRef<OwnDraftSaveSession | null>(null);
  const draftSaveQueueRef = useRef<OwnDraftSaveQueue | null>(null);
  if (!draftSaveQueueRef.current) {
    draftSaveQueueRef.current = new OwnDraftSaveQueue(request => api<{ draft: OwnDraft }>("/api/v1/self/drafts", jsonBody(request)));
  }
  const [runs, setRuns] = useState<OwnRun[]>([]);
  const [runCursor, setRunCursor] = useState<string>();
  const [run, setRun] = useState<OwnRun>();
  const [uploadUnknown, setUploadUnknown] = useState<PendingUpload[]>([]);
  const [uploadProgress, setUploadProgress] = useState<{ completed: number; total: number }>();
  const pendingKey = "zane-studio:run-intent:v1:" + user.id;
  const [pendingRun, setPendingRun] = useState(() => {
    try { return localStorage.getItem(pendingKey) ?? ""; } catch { return ""; }
  });
  const runRef = useRef(run);
  runRef.current = run;
  const readSequence = useRef(0);
  const selectingRun = useRef(false);

  async function loadScenes(cursor?: string) {
    const data = await api<AccessPage<AvailableScene>>("/api/v1/self/scenes" + (cursor ? "?cursor=" + encodeURIComponent(cursor) : ""));
    setScenes(current => cursor ? [...current, ...data.items] : data.items);
    setSceneCursor(data.nextCursor);
  }
  async function loadDrafts(cursor?: string) {
    const sequence = ++draftReadSequence.current;
    const data = await api<AccessPage<OwnDraft>>("/api/v1/self/drafts" + (cursor ? "?cursor=" + encodeURIComponent(cursor) : ""));
    if (sequence !== draftReadSequence.current) return;
    setDrafts(current => cursor ? [...current, ...data.items] : data.items);
    setDraftCursor(data.nextCursor);
  }
  async function reconcileFavorites() {
    if (favoriteUnknownId) await api<{ draft: OwnDraft }>("/api/v1/self/drafts/" + encodeURIComponent(favoriteUnknownId));
    await loadDrafts(); setFavoriteUnknownId("");
  }
  async function favoriteDraft(draft: OwnDraft) {
    if (favoriteBusyRef.current || favoriteUnknownId) return;
    favoriteBusyRef.current = true; setFavoriteBusy(true); ++draftReadSequence.current;
    try {
      const result = await writeDraftFavorite({
        isFavorite: !draft.isFavorite,
        write: () => setOwnDraftFavorite(draft.id, { revision: draft.revision, isFavorite: !draft.isFavorite }, user.id),
        read: () => getOwnDraft(draft.id, user.id),
        favorite: snapshot => snapshot.draft.isFavorite === true,
      });
      setDrafts(current => sortOwnDrafts(current.map(item => item.id === draft.id ? result.snapshot.draft : item)));
      setDraftCursor(undefined); // The old page cursor cannot be used after reordering.
      if (result.outcome === "saved" && draftId === draft.id && draftRevision === draft.revision) setDraftRevision(result.snapshot.draft.revision);
      await loadDrafts();
      if (result.error) throw new Error(result.error.message + "；已读取服务端状态，请核对后再操作。");
    } catch (error) {
      if (error instanceof DraftFavoriteUnconfirmedError) setFavoriteUnknownId(draft.id);
      throw error;
    } finally { favoriteBusyRef.current = false; setFavoriteBusy(false); }
  }
  async function loadRuns(cursor?: string) {
    const data = await api<AccessPage<OwnRun>>("/api/v1/self/runs" + (cursor ? "?cursor=" + encodeURIComponent(cursor) : ""));
    setRuns(current => cursor ? [...current, ...data.items] : data.items);
    setRunCursor(data.nextCursor);
  }
  async function attempt(action: () => Promise<void>) {
    setError("");
    try { await action(); } catch (e) { setError((e as Error).message); }
  }
  useEffect(() => { void attempt(() => loadScenes()); }, []);
  useEffect(() => {
    if (page === "drafts") void attempt(() => loadDrafts());
    if (page === "runs") void attempt(() => loadRuns());
  }, [page]);
  useEffect(() => {
    const flushWhenHidden = () => {
      if (document.visibilityState === "hidden") void flushDraftAutosave().catch(reason => setError((reason as Error).message));
    };
    document.addEventListener("visibilitychange", flushWhenHidden);
    window.addEventListener("pagehide", flushWhenHidden);
    return () => {
      document.removeEventListener("visibilitychange", flushWhenHidden);
      window.removeEventListener("pagehide", flushWhenHidden);
    };
  }, [page, scene, values, draftId]);
  useEffect(() => {
    const warnBeforeUnload = (event: BeforeUnloadEvent) => {
      const session = draftSessionRef.current;
      if (!session || session.editVersion <= session.savedEditVersion) return;
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warnBeforeUnload);
    return () => window.removeEventListener("beforeunload", warnBeforeUnload);
  }, [scene, values, draftId]);
  useEffect(() => {
    if (!run || busy || !["queued", "running", "cancelling", "waiting"].includes(run.status)) return;
    let stopped = false;
    const id = run.runId;
    const timer = window.setInterval(() => {
      if (selectingRun.current) return;
      const sequence = ++readSequence.current;
      void api<OwnRun>("/api/v1/self/runs/" + id).then(value => {
        if (!stopped && sequence === readSequence.current && runRef.current?.runId === id) {
          setRun(value); setRuns(current => current.map(item => item.runId === id ? value : item));
        }
      }).catch(e => { if (!stopped && sequence === readSequence.current && runRef.current?.runId === id) setError((e as Error).message); });
    }, 2500);
    return () => { stopped = true; clearInterval(timer); };
  }, [run?.runId, run?.status, busy]);

  async function openScene(id: string, draft?: OwnDraft) {
    const previous = draftSessionRef.current;
    if (previous?.reviewRequired && previous.editVersion > previous.savedEditVersion
      && !window.confirm("本页输入与服务端草稿不同。继续打开另一份草稿会放弃本页输入，确定继续吗？")) return;
    await flushDraftAutosave();
    const selected = await api<UserScene>("/api/v1/self/scenes/" + encodeURIComponent(id));
    if (draft && draft.versionId !== selected.versionId) {
      setError("草稿绑定的发布版已变化。原草稿仍在服务端，请核对新表单后再修改和保存。");
    }
    const nextDraftId = draft?.id ?? crypto.randomUUID();
    const nextValues = draft?.inputValues ?? selected.inputDefaults;
    draftSessionRef.current = {
      id: nextDraftId, revision: draft?.revision ?? 0, sceneId: selected.sceneId, versionId: selected.versionId, title: selected.title, runTitle: draft?.runTitle, hasServerDraft: Boolean(draft),
      editVersion: 0, savedEditVersion: 0, enqueuedEditVersion: 0, reconcileRequired: false, reviewRequired: false,
    };
    setScene(selected);
    valuesRef.current = nextValues;
    setValues(nextValues);
    setDraftId(nextDraftId);
    setRunTitle(draft?.runTitle ?? "");
    setDraftRevision(draft?.revision ?? 0);
    setDraftUnknown(false);
    setDraftAutoSaveStatus(draft ? "saved" : "idle");
    setNotice("");
    setPage("scenes");
  }
  function updateValues(update: (current: Record<string, unknown>) => Record<string, unknown>) {
    const session = draftSessionRef.current;
    if (session) { session.editVersion += 1; session.reviewRequired = false; }
    setDraftAutoSaveStatus(session ? "pending" : "idle");
    setError("");
    setNotice("");
    const next = update(valuesRef.current);
    valuesRef.current = next;
    setValues(next);
  }
  function updateRunTitle(next: string) {
    const session = draftSessionRef.current;
    if (session) { session.runTitle = next; session.editVersion += 1; session.reviewRequired = false; }
    setDraftAutoSaveStatus(session ? "pending" : "idle");
    setError("");
    setNotice("");
    setRunTitle(next);
  }
  function autosaveDraftOnBlur() {
    void flushDraftAutosave().catch(() => undefined);
  }
  function handleDraftFieldBlur(event: FocusEvent<HTMLElement>) {
    const relatedTarget = event.relatedTarget;
    if (relatedTarget instanceof Node && event.currentTarget.contains(relatedTarget)) return;
    if (relatedTarget instanceof HTMLButtonElement) return;
    autosaveDraftOnBlur();
  }
  function inputs(sourceValues = values, sourceScene = scene, validateRequired = false) {
    const result = { ...sourceValues };
    for (const field of sourceScene?.fields ?? []) {
      const value = result[field.key];
      if (field.type === "number" && typeof value === "string" && value.trim()) {
        const number = Number(value);
        if (!Number.isFinite(number)) throw new Error(field.label + "需要有效数字");
        if (validateRequired && field.minimum !== undefined && number < field.minimum) throw new Error(field.label + "不能小于 " + field.minimum);
        if (validateRequired && field.maximum !== undefined && number > field.maximum) throw new Error(field.label + "不能大于 " + field.maximum);
        result[field.key] = number;
      }
      if (field.type === "json" && typeof value === "string" && value.trim()) {
        try { result[field.key] = JSON.parse(value); } catch { throw new Error(field.label + "需要有效JSON"); }
      }
      if (field.type === "json" && field.inputMode === "object_array") result[field.key] = parseObjectArrayFormValue({ ...field, type: "json" } as WorkflowInputField, value, validateRequired);
    }
    return result;
  }
  async function saveDraftSnapshot(session: OwnDraftSaveSession, inputValues: Record<string, unknown>, editVersion: number, force = false) {
    if (session.reconcileRequired) throw new Error("草稿写入回执待核对，请先读取原草稿ID。");
    try {
      if (session.pendingWrite && session.enqueuedEditVersion >= editVersion) {
        if (draftSessionRef.current === session) setDraftAutoSaveStatus("saving");
        await session.pendingWrite;
      } else if (session.savedEditVersion < editVersion || (force && !session.hasServerDraft)) {
        draftSaveCountRef.current += 1;
        if (draftSessionRef.current === session) setDraftAutoSaveStatus("saving");
        setDraftSaving(true);
        try {
          await draftSaveQueueRef.current!.save(session, inputValues, editVersion);
        } finally {
          draftSaveCountRef.current = Math.max(0, draftSaveCountRef.current - 1);
          setDraftSaving(draftSaveCountRef.current > 0);
        }
      }
    } catch (error) {
      if (draftSessionRef.current === session) {
        if (session.reconcileRequired) setDraftUnknown(true);
        setDraftAutoSaveStatus(session.reconcileRequired ? "reconcile" : "error");
        setError((error as Error).message + " 草稿ID：" + session.id);
      }
      throw error;
    }
    if (session.reconcileRequired) throw new Error("草稿写入回执待核对，请先读取原草稿ID。");
    if (draftSessionRef.current === session) {
      setDraftRevision(session.revision);
      setDraftUnknown(false);
      setDraftAutoSaveStatus(session.reviewRequired ? "review" : session.editVersion > session.savedEditVersion ? "pending" : "saved");
    }
    return session.revision;
  }
  async function flushDraftAutosave() {
    const session = draftSessionRef.current;
    if (!session) return;
    if (session.reconcileRequired) throw new Error("草稿写入回执待核对，请先读取原草稿ID。");
    if (session.reviewRequired) return;
    if (session.pendingWrite) await session.pendingWrite;
    if (session.reconcileRequired) throw new Error("草稿写入回执待核对，请先读取原草稿ID。");
    if (session.editVersion <= session.savedEditVersion) return;
    if (!scene) throw new Error("当前草稿表单尚未就绪，未自动保存");
    let inputValues: Record<string, unknown>;
    try { inputValues = inputs(valuesRef.current, scene); }
    catch (reason) {
      setDraftAutoSaveStatus("error");
      setError(reason instanceof Error ? reason.message : "草稿输入暂时无法自动保存");
      throw reason;
    }
    await saveDraftSnapshot(session, inputValues, session.editVersion);
  }
  async function navigateToPage(nextPage: typeof page) {
    if (page === "scenes" && scene && nextPage !== "scenes") await flushDraftAutosave();
    setPage(nextPage);
    setError("");
  }
  async function save() {
    if (!scene) return;
    const session = draftSessionRef.current;
    if (!session) { setError("当前草稿表单尚未就绪"); return; }
    if (session.reviewRequired && !window.confirm("服务端草稿与本页输入不同。确定用本页内容覆盖服务端当前版本吗？")) return;
    session.reviewRequired = false;
    setBusy(true); setError(""); setNotice("");
    try {
      const revision = await saveDraftSnapshot(session, inputs(), session.editVersion, true);
      setNotice("服务端已保存 · r" + revision);
    } catch (e) {
      if (session.reconcileRequired) setDraftUnknown(true);
      setDraftAutoSaveStatus(session.reconcileRequired ? "reconcile" : "error");
      setError((e as Error).message + " 草稿ID：" + session.id);
    } finally { setBusy(false); }
  }
  async function reconcileDraft() {
    const session = draftSessionRef.current;
    if (!session) throw new Error("当前草稿表单尚未就绪");
    const data = await api<{ draft: OwnDraft }>("/api/v1/self/drafts/" + encodeURIComponent(session.id));
    const failed = session.failedWrite;
    const matchesFailed = Boolean(failed && sameDraftSnapshot(data.draft, failed));
    const matchesLastSaved = Boolean(session.lastSaved && sameDraftSnapshot(data.draft, session.lastSaved));
    session.revision = data.draft.revision;
    session.reconcileRequired = false;
    session.enqueuedEditVersion = session.savedEditVersion;
    setDraftRevision(data.draft.revision);
    setDraftUnknown(false);
    if (matchesFailed && failed) {
      session.savedEditVersion = Math.max(session.savedEditVersion, failed.editVersion);
      session.enqueuedEditVersion = session.savedEditVersion;
      session.lastSaved = failed;
      session.failedWrite = undefined;
      session.reviewRequired = false;
      setNotice("已确认原草稿ID的保存回执 · r" + data.draft.revision);
      setDraftAutoSaveStatus(session.editVersion > session.savedEditVersion ? "pending" : "saved");
    } else if (matchesLastSaved && session.lastSaved) {
      session.savedEditVersion = Math.max(session.savedEditVersion, session.lastSaved.editVersion);
      session.enqueuedEditVersion = session.savedEditVersion;
      session.failedWrite = undefined;
      session.reviewRequired = false;
      setNotice("已读取原草稿ID并确认服务端基线 · r" + data.draft.revision);
      setDraftAutoSaveStatus(session.editVersion > session.savedEditVersion ? "pending" : "saved");
    } else {
      session.failedWrite = undefined;
      session.reviewRequired = true;
      setNotice("服务端草稿内容已变化；本页输入已保留。核对后可手动保存，或重新打开服务端草稿。");
      setDraftAutoSaveStatus("review");
    }
  }
  function retainRunId(id: string) {
    // Save before the request. If browser storage is unavailable, do not submit.
    localStorage.setItem(pendingKey, id);
    setPendingRun(id);
  }
  function clearRunId() {
    localStorage.removeItem(pendingKey);
    setPendingRun("");
  }
  async function submit() {
    if (!scene || pendingRun) return;
    setBusy(true); setError(""); setNotice("");
    let id = "";
    try {
      await flushDraftAutosave();
      const inputValues = inputs(values, scene, true);
      await api("/api/v1/self/scenes/" + scene.sceneId + "/prepare", jsonBody({ versionId: scene.versionId, inputValues }));
      if (!window.confirm("确认提交？此场景可能调用外部模型并产生费用，后续审核也可能继续生成。")) return;
      id = crypto.randomUUID();
      retainRunId(id);
      const accepted = await api<OwnRun>("/api/v1/self/scenes/" + scene.sceneId + "/runs", jsonBody({
        versionId: scene.versionId, inputValues, runId: id, runTitle: runTitle.trim() || scene.title,
      }));
      clearRunId(); setRun(accepted); setPage("runs");
      await loadRuns();
    } catch (e) {
      if (id && isDefiniteRunRejection(e)) clearRunId();
      setError((e as Error).message);
    } finally { setBusy(false); }
  }
  async function reconcileRun() {
    const current = await api<OwnRun>("/api/v1/self/runs/" + pendingRun);
    setRun(current); clearRunId(); setPage("runs");
    setNotice("已确认原任务，无需重复提交");
  }
  async function selectRun(id: string) {
    const sequence = ++readSequence.current;
    selectingRun.current = true;
    try {
      const value = await api<OwnRun>("/api/v1/self/runs/" + id);
      if (sequence !== readSequence.current) return;
      runRef.current = value;
      setRun(value);
      setRuns(current => current.map(item => item.runId === id ? value : item));
    } finally { if (sequence === readSequence.current) selectingRun.current = false; }
  }
  async function action(kind: "cancel" | "review" | "resume", reviewAction?: "approve" | "redo") {
    if (!run) return;
    setBusy(true); setError("");
    let newRunId = "";
    try {
      if (kind !== "cancel" && !window.confirm("此操作可能继续外部生成，确认执行？")) return;
      if (kind === "resume") { newRunId = crypto.randomUUID(); retainRunId(newRunId); }
      const body = kind === "review" ? { reviewId: run.pendingReview?.id, action: reviewAction }
        : kind === "resume" ? { newRunId } : {};
      const updated = await api<OwnRun>("/api/v1/self/runs/" + run.runId + "/" + kind, jsonBody(body));
      if (newRunId) clearRunId();
      setRun(updated); 
      await loadRuns();
    } catch (e) {
      if (newRunId && isDefiniteRunRejection(e)) clearRunId();
      setError((e as Error).message + "；请先刷新任务状态或按原提交ID对账。");
    } finally { setBusy(false); }
  }
  async function upload(key: string, type: string, files: File[]) {
    if (!scene || files.length === 0) return;
    const kind = mediaKindByType(type), label = mediaKindLabel(kind);
    setBusy(true); setUploadingKey(key); setError(""); setUploadProgress({ completed: 0, total: files.length });
    const pending: PendingUpload[] = [], failures: string[] = [];
    let uploaded = 0, settled = 0;
    // One selected file is one asset upload with its own assetId; a batch never merges or drops receipts.
    for (const file of files) {
      const id = crypto.randomUUID();
      try {
        const data = await api<{ reference: unknown }>("/api/v1/self/assets/upload?" + new URLSearchParams({ assetId: id, name: file.name, kind }), {
          method: "POST", body: file, headers: { "Content-Type": "application/octet-stream", "X-File-Name": encodeURIComponent(file.name) },
        });
        updateValues(current => ({ ...current, [key]: uploadedInput(current[key], type, data.reference) }));
        uploaded += 1;
      } catch (e) {
        if (e instanceof AccessApiError && e.status === 0) pending.push({ id, key, type, sceneId: scene.sceneId });
        failures.push((e as Error).message + " 素材ID：" + id);
      } finally { settled += 1; setUploadProgress({ completed: settled, total: files.length }); }
    }
    if (pending.length) setUploadUnknown(current => [...current, ...pending]);
    if (uploaded) setNotice(uploadedBatchNotice(uploaded, label));
    if (failures.length) setError(uploadFailureMessage(failures, label));
    setBusy(false); setUploadingKey(""); setUploadProgress(undefined);
  }
  async function reconcileUploads() {
    if (!uploadUnknown.length) return;
    const remaining: PendingUpload[] = []; let reconciled = 0;
    for (const item of uploadUnknown) {
      try {
        const data = await api<{ reference: unknown }>("/api/v1/self/assets/" + encodeURIComponent(item.id));
        if (scene?.sceneId === item.sceneId) {
          updateValues(current => ({ ...current, [item.key]: uploadedInput(current[item.key], item.type, data.reference) }));
        }
        reconciled += 1;
      } catch { remaining.push(item); }
    }
    setUploadUnknown(remaining);
    setNotice(remaining.length ? `已核验 ${reconciled} 个原素材ID，未重复上传；${remaining.length} 个回执仍待核验` : "已核验原素材ID，未重复上传");
  }
  async function backToSceneList() {
    const session = draftSessionRef.current;
    if (session?.reviewRequired && session.editVersion > session.savedEditVersion
      && !window.confirm("服务端草稿与本页输入不同。返回场景列表会放弃本页输入，确定继续吗？")) return;
    await flushDraftAutosave();
    draftSessionRef.current = null;
    setScene(undefined);
    setDraftAutoSaveStatus("idle");
  }
  async function logout() {
    const session = draftSessionRef.current;
    if (session?.reviewRequired && session.editVersion > session.savedEditVersion
      && !window.confirm("服务端草稿与本页输入不同。退出会放弃本页输入，确定继续吗？")) return;
    await flushDraftAutosave();
    onLogout();
  }
  async function returnToAdmin() {
    const session = draftSessionRef.current;
    if (session?.reviewRequired && session.editVersion > session.savedEditVersion
      && !window.confirm("服务端草稿与本页输入不同。返回管理端会放弃本页输入，确定继续吗？")) return;
    await flushDraftAutosave();
    onAdmin?.();
  }
  const lockedForm = busy || draftSaving || draftUnknown || uploadUnknown.length > 0;

  return <div className="access-shell">
    <aside className="access-sidebar">
      <h2>Zane Studio</h2><p>创作中心</p><strong>{user.displayName}</strong>
      {([['scenes', '可用场景'], ['drafts', '我的草稿'], ['runs', '我的任务'], ['feedback', '系统反馈']] as const).map(([id, label]) =>
        <button key={id} disabled={busy || draftSaving || draftUnknown} className={page === id ? "active" : ""} onClick={() => void attempt(() => navigateToPage(id))}>{label}</button>)}
      {onAdmin && <button disabled={busy || draftSaving || draftUnknown} onClick={() => void attempt(returnToAdmin)}>返回管理后台</button>}
      <button disabled={busy || draftSaving || draftUnknown} onClick={() => void attempt(logout)}>退出登录</button>
    </aside>
    <main className="access-main">
      <header className="access-heading"><div>
        <h1>{page === "scenes" ? "可用场景" : page === "drafts" ? "我的草稿" : page === "runs" ? "我的任务" : "系统反馈"}</h1>
        <p>{page === "feedback" ? "提交使用问题或改进建议，由管理员处理；不会自动影响 Agent。" : page === "runs" ? "跟踪任务进度、核对原始输入、查看结果；历史与详情以服务端运行快照为准。" : page === "drafts" ? "收藏常用输入草稿并置顶，快速继续填写和复用；所有确认保存的数据都在服务端。" : scene ? "输入框失焦后会自动保存到服务端，离开表单前也会先保存。" : "只展示你可以使用的已发布场景；所有已保存数据以服务端为准。"}</p>
      </div></header>
      {error && <p className="access-error" role="alert">{error}</p>}
      {notice && <p className="access-success" role="status">{notice}</p>}
      {pendingRun && <section className="access-card">
        <strong>有一条提交等待核验</strong><p>任务ID：{pendingRun}。不要重复提交。</p>
        <button className="button button-outline" onClick={() => void attempt(reconcileRun)}>查询原任务ID</button>
      </section>}
      {uploadUnknown.length > 0 && <section className="access-card">
        <p>媒体上传回执待核验（{uploadUnknown.length}）：{uploadUnknown.map(item => item.id).join("、")}</p>
        <button className="button button-outline" onClick={() => void attempt(reconcileUploads)}>读取原素材ID</button>
      </section>}
      {page === "scenes" && <>
        <div className="access-inline">
          <button className="button button-outline" onClick={() => void attempt(async () => { if (scene) await flushDraftAutosave(); await loadScenes(); })}>刷新可用场景</button>
          {scene && <button className="button button-outline" disabled={lockedForm} onClick={() => void attempt(backToSceneList)}>返回场景列表</button>}
        </div>
        {!scene && <div className="access-grid">
          {scenes.map(item => <button className="access-card access-scene" key={item.sceneId} disabled={lockedForm} onClick={() => void attempt(() => openScene(item.sceneId))}>
            <h2>{item.title}</h2><p>{item.summary}</p><small>发布版 {item.version}</small>
          </button>)}
          {!scenes.length && <section className="access-card"><h2>暂无可用场景</h2><p>请联系管理员授权并发布场景。</p></section>}
        </div>}
        {!scene && sceneCursor && <button className="button button-outline" onClick={() => void attempt(() => loadScenes(sceneCursor))}>加载更多场景</button>}
        {scene && <section className="access-card">
          <h2>{scene.title}</h2><p>{scene.description || scene.summary}</p><small>固定发布版：{scene.version} · {scene.versionId}</small>
          <form noValidate onSubmit={e => { e.preventDefault(); void save(); }}>
            <label className="access-run-title-field" onBlur={handleDraftFieldBlur}>任务标题（可选）
              <input className="text-input" type="text" maxLength={120} value={runTitle}
                onChange={event => updateRunTitle(event.target.value)}
                placeholder="留空则任务记录使用场景标题" aria-label="任务标题（可选）" />
              <small className="access-muted">最多120个字符；保存在本场景的输入草稿中，提交时作为任务标题。</small>
            </label>
            {visibleInputFields(scene.fields).map(field => field.inputMode === "object_array" ? <div className="access-media-field" key={field.key} onBlur={handleDraftFieldBlur}>
              <div className="access-media-field-label">{field.label}{field.required && <span> *</span>}</div>
              <ObjectArrayInput field={{ ...field, type: "json" } as WorkflowInputField} value={values[field.key]} disabled={lockedForm} onChange={rows => updateValues(current => ({ ...current, [field.key]: rows }))} />
            </div> : /image|video|audio/.test(field.type) ? <div className="access-media-field" key={field.key} onBlur={handleDraftFieldBlur}>
              <div className="access-media-field-label">{field.label}{field.required && <span> *</span>}</div>
              <UserMediaInput
                label={field.label}
                kind={(/audio/.test(field.type) ? "audio" : /video/.test(field.type) ? "video" : "image") as UserMediaKind}
                multiple={/\[\]|_list|images|videos|audios/.test(field.type)}
                value={values[field.key]}
                userId={user.id}
                disabled={lockedForm}
                uploading={uploadingKey === field.key}
                uploadProgress={uploadingKey === field.key ? uploadProgress : undefined}
                onUpload={files => void upload(field.key, field.type, files)}
                onSelect={reference => {
                  updateValues(current => ({ ...current, [field.key]: uploadedInput(current[field.key], field.type, reference) }));
                  setNotice("已从我的素材库选择素材");
                }}
                onMove={(index, offset) => updateValues(current => {
                  const currentValue = current[field.key];
                  const items = Array.isArray(currentValue) ? currentValue : currentValue === undefined || currentValue === null || currentValue === "" ? [] : [currentValue];
                  const target = index + offset;
                  if (index < 0 || index >= items.length || target < 0 || target >= items.length) return current;
                  const next = [...items];
                  [next[index], next[target]] = [next[target], next[index]];
                  return { ...current, [field.key]: next };
                })}
                onRemove={index => updateValues(current => {
                  const currentValue = current[field.key];
                  const items = Array.isArray(currentValue) ? currentValue : currentValue === undefined || currentValue === null || currentValue === "" ? [] : [currentValue];
                  return { ...current, [field.key]: /\[\]|_list|images|videos|audios/.test(field.type) ? items.filter((_item, itemIndex) => itemIndex !== index) : "" };
                })}
                onClear={() => updateValues(current => ({ ...current, [field.key]: "" }))}
              />
            </div> : <label key={field.key} onBlur={handleDraftFieldBlur}>{field.label}{field.required && <span> *</span>}
              {field.type === "number" && <small className="access-muted">{field.minimum !== undefined || field.maximum !== undefined ? `范围：${field.minimum ?? "不限"}–${field.maximum ?? "不限"}` : "数字输入"}{!field.required ? " · 可不填" : ""}</small>}
              {field.type === "boolean" ? <input type="checkbox" disabled={lockedForm} checked={values[field.key] === true} onChange={e => updateValues(current => ({ ...current, [field.key]: e.target.checked }))} />
                : field.type === "select" ? <select className="text-input" disabled={lockedForm} value={String(values[field.key] ?? "")} onChange={e => updateValues(current => ({ ...current, [field.key]: e.target.value }))}>
                  <option value="">请选择</option>{field.options?.map(option => <option key={option}>{option}</option>)}
                </select> : field.type === "number" ? <input className="text-input" type="number" step="any" min={field.minimum} max={field.maximum} disabled={lockedForm} value={values[field.key] === undefined || values[field.key] === null ? "" : String(values[field.key])} onChange={e => updateValues(current => ({ ...current, [field.key]: e.target.value }))} placeholder={field.placeholder} />
                : <textarea className="text-input" rows={3} disabled={lockedForm} value={typeof values[field.key] === "string" ? values[field.key] as string
                  : values[field.key] === undefined || values[field.key] === null ? "" : field.type === "json" ? JSON.stringify(values[field.key], null, 2) : String(values[field.key])}
                  placeholder={field.placeholder} onChange={e => updateValues(current => ({ ...current, [field.key]: e.target.value }))} />}
            </label>)}
            <div className="access-inline">
              <button className="button button-outline" type="submit" disabled={lockedForm}>保存我的草稿</button>
              <button className="button button-dark" type="button" disabled={lockedForm || !!pendingRun} onClick={() => void submit()}>{busy ? "处理中…" : "提交任务"}</button>
              <small>草稿 {draftId} · r{draftRevision}</small>
              <small className="access-muted" role="status" aria-live="polite">{draftAutoSaveStatus === "pending" ? "输入已修改，失焦后自动保存" : draftAutoSaveStatus === "saving" ? "正在自动保存到服务端…" : draftAutoSaveStatus === "saved" ? "已自动保存到服务端" : draftAutoSaveStatus === "error" ? "自动保存未完成；修正输入并失焦后会重试" : draftAutoSaveStatus === "reconcile" ? "保存回执待核对" : draftAutoSaveStatus === "review" ? "服务端内容已变化，请核对后手动保存" : ""}</small>
            </div>
            {draftUnknown && <button type="button" className="button button-outline" onClick={() => void attempt(reconcileDraft)}>读取原草稿ID对账</button>}
            <p className="access-muted">配置、保存草稿和预检不会调用模型。提交及后续审核可能产生费用。</p>
          </form>
        </section>}
      </>}
      {page === "drafts" && <section className="access-card">
        <div className="user-run-history-heading"><h2>我的草稿</h2><button className="run-icon-button" disabled={favoriteBusy} onClick={() => void attempt(reconcileFavorites)}>{favoriteUnknownId ? "读取原草稿ID对账" : "刷新草稿"}</button></div>
        <p className="access-muted">收藏置顶 · 同组最近保存优先</p>
        <ul className="access-list">{drafts.map(draft => <li key={draft.id}>
          <span>{draft.runTitle || draft.title}<small>{draft.id} · r{draft.revision}{draft.runTitle ? " · " + draft.title : ""}</small></span>
          <div className="draft-row-actions">
            <button className={`draft-favorite-button${draft.isFavorite ? " is-favorite" : ""}`} type="button" aria-pressed={Boolean(draft.isFavorite)} aria-label={`${draft.isFavorite ? "取消收藏" : "收藏"}：${draft.title}`} title={draft.isFavorite ? "取消收藏" : "收藏并置顶"} disabled={favoriteBusy || Boolean(favoriteUnknownId) || lockedForm} onClick={() => void attempt(() => favoriteDraft(draft))}><Star size={15} fill={draft.isFavorite ? "currentColor" : "none"} /><span>{draft.isFavorite ? "已收藏" : "收藏"}</span></button>
            <button className="button button-outline" disabled={lockedForm || favoriteBusy} onClick={() => void attempt(async () => {
              const data = await api<{ draft: OwnDraft }>("/api/v1/self/drafts/" + draft.id); await openScene(data.draft.sceneId, data.draft);
            })}>继续填写</button>
          </div>
        </li>)}</ul>
        {!drafts.length && <p>暂无本人草稿。</p>}
        {draftCursor && <button className="button button-outline" disabled={favoriteBusy || Boolean(favoriteUnknownId)} onClick={() => void attempt(() => loadDrafts(draftCursor))}>加载更多</button>}
      </section>}
      {page === "runs" && <>
        <div className="user-runs-layout">
          <section className="access-card user-run-history" aria-label="本人任务列表">
            <div className="user-run-history-heading"><h2>最近任务</h2><button className="run-icon-button" onClick={() => void attempt(() => loadRuns())}>刷新</button></div>
            <ul className="user-run-history-items">{runs.map(item => <li key={item.runId}>
              <button className={run?.runId === item.runId ? "active" : ""} onClick={() => void attempt(() => selectRun(item.runId))}>
                <span className={`business-status ${item.status}`}>{runStatusLabels[item.status]}</span>
                <strong>{item.runTitle || item.workflowName || item.sceneId}</strong><small>{runDate(item.createdAt)}</small>
                <small>{item.progress.completed} / {item.progress.total} 步完成 · {item.outputCount} 个最终产物</small>
              </button>
            </li>)}</ul>
            {!runs.length && <p>暂无本人任务。</p>}
            {runCursor && <button className="button button-outline" onClick={() => void attempt(() => loadRuns(runCursor))}>加载更多</button>}
          </section>
          {run ? <UserRunDetail key={run.runId} run={run} userId={user.id} busy={busy} submissionPending={!!pendingRun}
            onRefresh={() => selectRun(run.runId)} onCancel={() => void action("cancel")} onResume={() => void action("resume")}
            onReview={decision => void action("review", decision)} />
            : <section className="access-card run-empty-state"><h2>运行详情</h2><p>选择一条任务，查看步骤进度、输入和结果。</p></section>}
        </div>
      </>}
      {page === "feedback" && <SystemFeedback key={user.id} userId={user.id} />}
    </main>
  </div>;
}
