import SystemFeedback from "./SystemFeedback";
import { useConfirmDialog } from "../components/ConfirmDialog";
import { useEffect, useRef, useState } from "react";
import { LogOut, MessageCircle, Settings2 } from "lucide-react";
import UserMediaInput, { type UserMediaKind } from "../components/UserMediaInput";
import {
  AccessApiError, accessApi, jsonBody, type Account, type AccessPage,
  type OwnRun,
} from "../lib/accessApi";
import { isDefiniteRunRejection, mediaKindByType, mediaKindLabel, uploadedBatchNotice, uploadedInput, uploadFailureMessage } from "../lib/userPortal";
import UserRunDetail from "../components/UserRunDetail";
import PackageRunInputs from "../components/PackageRunInputs";
import type { ReusableInputs } from "../lib/packageRunInputs";
import { reusableInputs } from "../lib/packageRunInputs";
import CopyableId from "../components/CopyableId";
import { RecentShot } from "../components/RecentShot";
import { ServicePage, ServiceCard, ServiceQuickStarts, ServiceActionBar, serviceThemeStyle, useBlockAnchor, useScrolled, type ServicePresentation, type ServicePageAction } from "../components/ServicePage";
import { ServiceWorkspace } from "../components/ServiceWorkspace";
import { formatPoints } from "../../server/domain/creditUnits.js";
import "../styles/client.css";
import "../styles/service-page.css";

type PendingUpload = { id: string; key: string; type: string };
/**
 * 用户面的服务运行视图：只包含「做到哪一步、要不要确认、出了什么结果」。
 * 组件名、步骤名、子运行ID、内部错误原文属于实现细节，服务端不会下发，这里也不预留字段。
 */
type ServiceRunSummary = {
  packageRunId: string; title: string; status: string; stage?: "running" | "waiting_confirm" | "completed" | "failed" | "cancelled";
  createdAt: string; progress?: { total: number; completed: number; current: number };
  /** 列表投影可能不带；详情一定带，用于「再做一次」回到同一服务。 */
  packageId?: string;
};
type ServiceRunDetail = ServiceRunSummary & {
  packageId?: string;
  confirmation?: { step: number; total: number; itemId: string; actions: string[] };
  retry?: { step: number; total: number; itemId: string; action: "retry" };
  credit?: { total: number; settlement?: { charged: number; refunded: number } };
};
type ServicePackage = {
  /** 配置型包固定发布版本ID；代码子工程没有版本ID（版本由包自身声明），所以是可选的。 */
  packageId: string; versionId?: string; version: string; title: string; summary?: string;
  /** 目录来源：code=磁盘代码子工程，config=历史配置型包。用户面不区分，仅用于诊断与埋点。 */
  source?: "code" | "config";
  itemCount: number; headline?: string; accent?: string; showcase?: Array<{ url: string; caption?: string }>;
};
type ActivePackage = ServicePackage & {
  description?: string;
  fields: Array<{ key: string; label: string; type: string; required: boolean; hidden: boolean; options?: string[]; defaultValue?: unknown; minimum?: number; maximum?: number }>;
  inputDefaults: Record<string, unknown>;
  steps: Array<{ itemId: string; name: string; confirmAfter?: boolean }>;
  presentation?: ServicePresentation;
};
type ClientPage = "services" | "results" | "account" | "feedback";
type Shot = { key: string; label: string; kind: "image" | "video"; url: string };

/** 用户面状态只说人话：不出现 queued/running 这类内部词。 */
function serviceStageLabel(stage?: string) {
  if (stage === "waiting_confirm") return "等你确认";
  if (stage === "completed") return "已完成";
  if (stage === "failed") return "没成功";
  if (stage === "cancelled") return "已取消";
  return "进行中";
}
/** 状态颜色与文案同一处定义，避免详情卡和列表各写一套导致颜色缺失。 */
function serviceStageTone(stage?: string): "good" | "warn" | "bad" | undefined {
  if (stage === "completed") return "good";
  if (stage === "waiting_confirm") return "warn";
  if (stage === "failed") return "bad";
  return undefined;
}

// 没有独立首页：打开客户端直接落在服务页，服务就是产品本身。
const navItems: Array<[ClientPage, string]> = [["services", "服务"], ["results", "作品"]];

export default function UserPortal({ user, entryPackageId, onLogout, onAdmin }: {
  user: Account; /** 卡密绑定的服务：有值时直接进入该服务，跳过目录。 */ entryPackageId?: string; onLogout: () => void; onAdmin?: () => void;
}) {
  const api = <T,>(path: string, options?: RequestInit) => accessApi<T>(path, options, user.id);
  const [page, setPage] = useState<ClientPage>("services");
  const { confirm, dialog: confirmDialog } = useConfirmDialog();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  // 用户面不再渲染单场景运行列表；保留加载是为了让既有详情入口仍能工作。
  const [, setRuns] = useState<OwnRun[]>([]);
  const [, setRunCursor] = useState<string>();
  const [run, setRun] = useState<OwnRun>();
  const [packages, setPackages] = useState<ServicePackage[]>([]);
  const [activePackage, setActivePackage] = useState<ActivePackage>();
  const [packageValues, setPackageValues] = useState<Record<string, unknown>>({});
  const [estimatedCost, setEstimatedCost] = useState<number | null>(null);
  const [packageRuns, setPackageRuns] = useState<ServiceRunSummary[]>([]);
  const [packageRun, setPackageRun] = useState<ServiceRunDetail>();
  const [credits, setCredits] = useState<{ balance: number; reserved: number; available: number } | null>(null);
  const [uploadUnknown, setUploadUnknown] = useState<PendingUpload[]>([]);
  const [uploadingKey, setUploadingKey] = useState("");
  const [uploadProgress, setUploadProgress] = useState<{ completed: number; total: number }>();
  const [ledger, setLedger] = useState<Array<{ entryId: string; delta: number; balanceAfter: number; kind: string; note?: string; createdAt: string }>>([]);
  const [pageAction, setPageAction] = useState<ServicePageAction>();
  /** 工作台里刚提交的那一次：用来在右侧原地轮询到结果，而不是跳到「作品」页。 */
  const [startedAt, setStartedAt] = useState<string>();
  /** 正在读取哪一次运行的参数（按钮显示 loading，避免连点重复读取）。 */
  const [reuseBusy, setReuseBusy] = useState("");
  /** 「再做一次」带过来的参数：打开服务页时覆盖默认值，并在页面上说明带了什么。 */
  const [prefill, setPrefill] = useState<{ packageId: string; values: Record<string, unknown>; notice: ReusableInputs }>();
  const pendingKey = "zane-studio:run-intent:v1:" + user.id;
  const [pendingRun, setPendingRun] = useState(() => {
    try { return localStorage.getItem(pendingKey) ?? ""; } catch { return ""; }
  });
  const runRef = useRef(run);
  runRef.current = run;
  const readSequence = useRef(0);
  const selectingRun = useRef(false);
  /** 只被授权一个服务时自动进入一次；之后点「服务」仍能回到目录。 */
  const autoOpenedOnce = useRef(false);
  const { formRef, resultsRef } = useBlockAnchor(pageAction);
  const scrolled = useScrolled();

  async function loadRuns(cursor?: string) {
    const data = await api<AccessPage<OwnRun>>("/api/v1/self/runs" + (cursor ? "?cursor=" + encodeURIComponent(cursor) : ""));
    setRuns(current => cursor ? [...current, ...data.items] : data.items);
    setRunCursor(data.nextCursor);
  }
  async function loadPackages() {
    const data = await api<{ packages: ServicePackage[] }>("/api/v1/self/packages");
    setPackages(data.packages);
    return data.packages;
  }
  async function openPackage(packageId: string, options: { silentMissing?: boolean; carried?: typeof prefill } = {}) {
    const detail = await api<ActivePackage>("/api/v1/self/packages/" + encodeURIComponent(packageId))
      .catch(error => { if (options.silentMissing) return undefined; throw error; });
    if (!detail) return;
    // 预填值显式传入，不读 state：调用方刚 setPrefill 就打开服务时，闭包里还是上一次的渲染值。
    const carried = options.carried?.packageId === packageId ? options.carried : undefined;
    const values = { ...detail.inputDefaults, ...carried?.values };
    setActivePackage(detail);
    setPackageValues(values);
    setEstimatedCost(null);
    setPage("services");
    setPageAction(undefined);
    if (carried) setNotice(carried.notice.notice);
    else setPrefill(undefined);
    // 预检只读、不计费：打开服务就先算一次上限价，用户填表时能看到「这次要花多少」。
    try {
      const prepared = await api<{ costPlan: { total: number }; credits?: typeof credits }>("/api/v1/self/packages/" + encodeURIComponent(packageId) + "/prepare", jsonBody({ versionId: detail.versionId, inputValues: values }));
      setEstimatedCost(prepared.costPlan?.total ?? 0);
      if (prepared.credits) setCredits(prepared.credits);
    } catch { /* 预检失败不阻断打开服务；提交时仍会再算一次 */ }
  }
  /** 用历史运行的原始输入重开创建页：仍是新的一次运行，照常预检、确认与计费。 */
  async function reusePackageInputs(packageId: string, values: Record<string, unknown>, notice: ReusableInputs) {
    if (!packageId) { setError("无法确定这条运行属于哪个服务，请从服务目录重新打开。"); return; }
    const carried = { packageId, values, notice };
    setPrefill(carried);
    setError("");
    await openPackage(packageId, { carried });
  }
  /** 输入变化后重新预估（防抖），让价格跟着参数走。 */
  async function refreshEstimate(nextValues: Record<string, unknown>) {
    if (!activePackage) return;
    try {
      const prepared = await api<{ costPlan: { total: number } }>("/api/v1/self/packages/" + encodeURIComponent(activePackage.packageId) + "/prepare", jsonBody({ versionId: activePackage.versionId, inputValues: nextValues }));
      setEstimatedCost(prepared.costPlan?.total ?? 0);
    } catch { /* 输入还不完整时预检会失败，保持上一次的估算 */ }
  }
  function updatePackageValue(key: string, value: unknown) {
    const next = { ...packageValues, [key]: value };
    setPackageValues(next);
    void refreshEstimate(next);
  }

  /**
   * 工作台内「用这组参数」：把那次运行的原始输入填回左侧表单，就地改或直接再生成。
   * 不跳页、不重开服务——客户在结果旁边就能接着调。
   * 只填当前发布版仍然声明且合法的字段（媒体复用固定素材引用），丢弃的字段会说明原因。
   */
  async function applyRunInputs(packageRunId: string) {
    if (!activePackage) return;
    setReuseBusy(packageRunId); setError(""); setNotice("");
    try {
      const page = await api<{ inputs: Array<{ key: string; present: boolean; value?: unknown; valueOmitted?: boolean }> }>(
        "/api/v1/self/package-runs/" + encodeURIComponent(packageRunId) + "/inputs?limit=50&valueLimit=8000",
      );
      const reusable = reusableInputs(page.inputs as never, activePackage.fields as never);
      if (!Object.keys(reusable.values).length) { setNotice(reusable.notice); return; }
      // 与默认值合并：这次没填的可选字段保持默认，不会被历史空值覆盖。
      const next = { ...activePackage.inputDefaults, ...reusable.values };
      setPackageValues(next);
      void refreshEstimate(next);
      setNotice(reusable.notice);
    } catch (e) { setError((e as Error).message); } finally { setReuseBusy(""); }
  }
  async function loadPackageRuns() {
    const data = await api<{ items: ServiceRunSummary[] }>("/api/v1/self/package-runs");
    setPackageRuns(data.items);
    return data.items;
  }
  async function submitPackage() {
    if (!activePackage) return;
    const inWorkspace = activePackage.presentation?.layout === "workspace";
    setBusy(true); setError(""); setNotice("");
    try {
      const prepared = await api<{ costPlan: { total: number }; credits?: typeof credits }>("/api/v1/self/packages/" + encodeURIComponent(activePackage.packageId) + "/prepare", jsonBody({ versionId: activePackage.versionId, inputValues: packageValues }));
      if (prepared.credits) setCredits(prepared.credits);
      const total = prepared.costPlan?.total ?? 0;
      if (!(await confirm({ message: total > 0 ? "本次最多消耗 " + formatPoints(total) + " 积分，跑完按成功项结算并退还差额。确认提交？" : "确认提交这个服务？", confirmLabel: "确认提交" }))) return;
      const result = await api<{ packageRun: ServiceRunDetail }>("/api/v1/self/packages/" + encodeURIComponent(activePackage.packageId) + "/runs", jsonBody({ versionId: activePackage.versionId, inputValues: packageValues, packageRunId: crypto.randomUUID() }));
      setPackageRun(result.packageRun);
      if (inWorkspace) {
        // 工作台：留在当前页，结果在右侧原地出现；输入不清空，方便改一句再生成。
        setStartedAt(new Date().toISOString());
        await loadPackageRuns();
      } else {
        setActivePackage(undefined);
        setPage("results");
        setPageAction(undefined);
        await loadPackageRuns();
      }
      await loadCredits();
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  async function confirmPackageItem(itemId: string, action: "approve" | "redo" | "retry") {
    if (!packageRun) return;
    setBusy(true); setError("");
    try {
      const result = await api<{ packageRun: ServiceRunDetail }>("/api/v1/self/package-runs/" + encodeURIComponent(packageRun.packageRunId) + "/items/" + encodeURIComponent(itemId) + "/confirm", jsonBody({ packageRunId: packageRun.packageRunId, itemId, action }));
      setPackageRun(result.packageRun);
      await loadPackageRuns();
      await loadCredits();
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  async function loadCredits() {
    const data = await api<{ balance: number; reserved: number; available: number }>("/api/v1/self/credits");
    setCredits(data);
    return data;
  }
  async function loadLedger() {
    const data = await api<{ items: typeof ledger }>("/api/v1/self/credits/entries?limit=20");
    setLedger(data.items);
  }
  /**
   * 媒体上传：一次选择多个文件时逐个上传，每个文件一个 assetId；
   * 网络中断的批次保留待核验清单，绝不合并或丢弃回执。
   */
  async function upload(key: string, type: string, files: File[]) {
    if (files.length === 0) return;
    const kind = mediaKindByType(type), label = mediaKindLabel(kind);
    setBusy(true); setUploadingKey(key); setError(""); setUploadProgress({ completed: 0, total: files.length });
    const pending: PendingUpload[] = [], failures: string[] = [];
    let uploaded = 0, settled = 0;
    for (const file of files) {
      const id = crypto.randomUUID();
      try {
        const data = await api<{ reference: unknown }>("/api/v1/self/assets/upload?" + new URLSearchParams({ assetId: id, name: file.name, kind }), {
          method: "POST", body: file, headers: { "Content-Type": "application/octet-stream", "X-File-Name": encodeURIComponent(file.name) },
        });
        setPackageValues(current => ({ ...current, [key]: uploadedInput(current[key], type, data.reference) }));
        uploaded += 1;
      } catch (e) {
        if (e instanceof AccessApiError && e.status === 0) pending.push({ id, key, type });
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
        setPackageValues(current => ({ ...current, [item.key]: uploadedInput(current[item.key], item.type, data.reference) }));
        reconciled += 1;
      } catch { remaining.push(item); }
    }
    setUploadUnknown(remaining);
    setNotice(remaining.length ? `已核验 ${reconciled} 个原素材ID，未重复上传；${remaining.length} 个回执仍待核验` : "已核验原素材ID，未重复上传");
  }

  // 返回值会被忽略，但允许调用方传回数据的加载函数（如 loadPackages 返回目录）。
  async function attempt(action: () => Promise<unknown>) {
    setError("");
    try { await action(); } catch (e) { setError((e as Error).message); }
  }

  useEffect(() => { void attempt(() => loadPackages()); }, []);
  // 卡密绑定了服务：登录后直接进那个服务，用户不需要在目录里挑。
  useEffect(() => {
    const bound = entryPackageId ?? (/(?:^#|&)service=([^&]+)/.exec(window.location.hash)?.[1]
      ? decodeURIComponent(/(?:^#|&)service=([^&]+)/.exec(window.location.hash)![1]) : undefined);
    if (!bound) return;
    void attempt(async () => {
      await openPackage(bound, { silentMissing: true });
      setPage("services");
    });
  }, [entryPackageId]);
  useEffect(() => { void attempt(async () => { await loadCredits(); }); }, []);
  useEffect(() => {
    if (page === "results") void attempt(() => loadRuns());
    if (page === "account") void attempt(async () => { await loadCredits(); await loadLedger(); });
    if (page === "services") void attempt(async () => {
      const list = await loadPackages();
      await loadPackageRuns(); await loadCredits(); await loadRuns();
      // 只被授权一个服务时直接进那个服务：客户不需要先看一屏只有一张卡的目录。
      // 点顶部「服务」仍可回到目录（那时 activePackage 已被清掉，但 users.length 仍是 1，
      // 所以用 autoOpenedOnce 保证只自动进一次，不让用户退不出来）。
      if (!activePackage && list.length === 1 && !autoOpenedOnce.current) {
        autoOpenedOnce.current = true;
        await openPackage(list[0].packageId, { silentMissing: true });
      }
    });
  }, [page]);
  // 工作台：提交后原地轮询那一次服务运行，结果一到就替换右侧画布，不跳页。
  useEffect(() => {
    if (!startedAt || !packageRun) return;
    if (!["queued", "running", "waiting_confirm"].includes(packageRun.status)) return;
    let stopped = false;
    let timer: number | undefined;
    let delayMs = 2000;
    const id = packageRun.packageRunId;
    const tick = () => {
      if (stopped) return;
      if (document.hidden) { timer = window.setTimeout(tick, delayMs); return; }
      void api<ServiceRunDetail>("/api/v1/self/package-runs/" + encodeURIComponent(id))
        .then(value => {
          if (stopped) return;
          const changed = value.stage !== packageRun.stage || value.progress?.completed !== packageRun.progress?.completed;
          delayMs = changed ? 2000 : Math.min(delayMs * 1.5, 8000);
          setPackageRun(value);
          if (!["queued", "running", "waiting_confirm"].includes(value.status)) void loadPackageRuns();
        })
        .catch(() => { delayMs = Math.min(delayMs * 1.5, 8000); })
        .finally(() => { if (!stopped) timer = window.setTimeout(tick, delayMs); });
    };
    timer = window.setTimeout(tick, delayMs);
    return () => { stopped = true; if (timer !== undefined) window.clearTimeout(timer); };
  }, [startedAt, packageRun?.packageRunId, packageRun?.status, packageRun?.stage, packageRun?.progress?.completed]);
  useEffect(() => {
    if (!run || busy || !["queued", "running", "cancelling", "waiting"].includes(run.status)) return;
    let stopped = false;
    let timer: number | undefined;
    let delayMs = 2500;
    const id = run.runId;
    const schedule = () => { timer = window.setTimeout(tick, delayMs); };
    const tick = () => {
      if (stopped) return;
      // 页面隐藏时暂停轮询，回到前台由 visibilitychange 立即补一次。
      if (document.hidden || selectingRun.current) { schedule(); return; }
      const sequence = ++readSequence.current;
      void api<OwnRun>("/api/v1/self/runs/" + id).then(value => {
        if (stopped || sequence !== readSequence.current || runRef.current?.runId !== id) return;
        const previous = runRef.current;
        // 状态或进度有变化时保持紧轮询；长时间无变化则退避到 10 秒，降低长任务请求量。
        const changed = previous?.status !== value.status
          || previous?.steps.some((step, index) => step.status !== value.steps[index]?.status)
          || previous?.progress.settled !== value.progress.settled;
        delayMs = changed ? 2500 : Math.min(delayMs * 1.5, 10_000);
        setRun(value); setRuns(current => current.map(item => item.runId === id ? value : item));
      }).catch(e => {
        delayMs = Math.min(delayMs * 1.5, 10_000);
        if (!stopped && sequence === readSequence.current && runRef.current?.runId === id) setError((e as Error).message);
      }).finally(() => { if (!stopped) schedule(); });
    };
    const onVisibility = () => { if (!document.hidden && !stopped && timer !== undefined) { window.clearTimeout(timer); timer = undefined; delayMs = 2500; void tick(); } };
    document.addEventListener("visibilitychange", onVisibility);
    schedule();
    return () => { stopped = true; if (timer !== undefined) window.clearTimeout(timer); document.removeEventListener("visibilitychange", onVisibility); };
  }, [run?.runId, run?.status, busy]);

  async function navigateToPage(nextPage: ClientPage) {
    setPage(nextPage);
    setPageAction(undefined);
    // 点顶部「服务」= 回到服务目录；否则已打开的服务页会一直占着，导航看起来没反应。
    if (nextPage === "services") setActivePackage(undefined);
    setError("");
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
  async function reconcileRun() {
    const current = await api<OwnRun>("/api/v1/self/runs/" + pendingRun);
    setRun(current); clearRunId(); setPage("results");
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
      if (kind !== "cancel" && !(await confirm({ message: "此操作可能继续外部生成，确认执行？" }))) return;
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
  function logout() { onLogout(); }
  function returnToAdmin() { onAdmin?.(); }

  const activeRuns = packageRuns.filter(item => ["queued", "running", "waiting_confirm"].includes(item.status));
  // 服务页主题：优先用详情（草稿期刚改过），回退到目录摘要里的配色。
  const themeStyle = serviceThemeStyle(activePackage?.presentation);

  /** 结果画廊：结果区块与「作品」页共用，避免两处渲染逻辑不一致。 */
  function resultGallery(packageRunId: string, emptyHint?: string) {
    return <ServiceResultGallery packageRunId={packageRunId} emptyHint={emptyHint} />;
  }

  return <div className="zclient">
    <header className="zclient-topbar" data-scrolled={scrolled}>
      <div className="zclient-brand">
        <span className="zclient-brand-mark">Z</span>
        <span className="zclient-brand-name">Zane Studio</span>
      </div>
      <nav className="zclient-tabs" aria-label="主导航">
        {navItems.map(([id, label]) => <button key={id} aria-current={page === id || (page === "services" && id === "services") ? "page" : undefined} disabled={busy} onClick={() => void attempt(() => navigateToPage(id))}>{label}</button>)}
      </nav>
      <div className="zclient-topbar-right">
        <span className="zclient-credit" title="可用积分 · 进行中占用 · 总余额">
          {credits ? formatPoints(credits.available) : "—"}<small>积分</small>
        </span>
        <button type="button" className="zclient-icon-button" aria-label="账户" title="账户" onClick={() => void attempt(() => navigateToPage("account"))}><Settings2 size={18} /></button>
        <button type="button" className="zclient-icon-button" aria-label="帮助与反馈" title="帮助与反馈" onClick={() => void attempt(() => navigateToPage("feedback"))}><MessageCircle size={18} /></button>
      </div>
    </header>

    <main className="zclient-main">
      {page === "services" && activePackage && activePackage.presentation?.layout === "workspace"
        ? <div style={themeStyle}>
            {notice && <p className="zclient-notice" data-tone="good" role="status">{notice}</p>}
            {error && <p className="zclient-notice" data-tone="bad" role="alert">{error}</p>}
            <ServiceWorkspace
              presentation={activePackage.presentation}
              title={activePackage.title}
              summary={activePackage.summary}
              credits={credits?.available}
              cost={estimatedCost}
              busy={busy}
              onSubmit={() => void submitPackage()}
              onBack={() => { setActivePackage(undefined); setPageAction(undefined); }}
              form={serviceFields()}
              result={workspaceResult()}
              history={workspaceHistory()}
              resultActions={workspaceResultActions()}
            />
          </div>
        : page === "services" && activePackage
        ? <div className="zclient-shell is-wide" style={themeStyle}>
            {notice && <p className="zclient-notice" data-tone="good" role="status">{notice}</p>}
            {error && <p className="zclient-notice" data-tone="bad" role="alert">{error}</p>}
            <ServicePage
              presentation={activePackage.presentation}
              title={activePackage.title}
              summary={activePackage.summary}
              activeAction={pageAction}
              onAction={setPageAction}
              onBack={() => { setActivePackage(undefined); setPageAction(undefined); }}
              formRef={formRef}
              resultsRef={resultsRef}
              results={latestResult()}
              form={<form noValidate className="zclient-form" onSubmit={event => { event.preventDefault(); void submitPackage(); }}>
                {serviceFields()}
                {activePackage.steps.length > 1 && <details className="zclient-steps">
                  <summary>执行过程（{activePackage.steps.length} 步）</summary>
                  <ol>{activePackage.steps.map(step => <li key={step.itemId}>{step.name}{step.confirmAfter ? "（完成后等你确认）" : ""}</li>)}</ol>
                </details>}
                <ServiceActionBar
                  cost={estimatedCost}
                  available={credits?.available}
                  busy={busy}
                  cta={activePackage.presentation?.resultLabels?.cta}
                  onSubmit={() => void submitPackage()}
                />
              </form>}
            />
          </div>
        : <div className="zclient-shell">
            <div className="zclient-stack">
              {error && <p className="zclient-notice" data-tone="bad" role="alert">{error}</p>}
              {notice && <p className="zclient-notice" data-tone="good" role="status">{notice}</p>}

              {(pendingRun || uploadUnknown.length > 0) && <section className="zclient-card">
                <h2>待核验</h2>
                {pendingRun && <p className="zclient-muted">有一条提交尚未取得回执，请不要重复提交。<button className="zclient-btn zclient-btn-ghost" onClick={() => void attempt(reconcileRun)}>查询原任务</button></p>}
                {uploadUnknown.length > 0 && <p className="zclient-muted">有 {uploadUnknown.length} 个上传待核验。<button className="zclient-btn zclient-btn-ghost" onClick={() => void attempt(reconcileUploads)}>核对上传</button></p>}
              </section>}

              {page === "services" && <>
                <div className="zclient-heading">
                  <div>
                    <span className="zclient-eyebrow">服务</span>
                    <h1>全部服务</h1>
                    <p>每个服务有自己的页面与流程，打开就能用。</p>
                  </div>
                </div>
                {activeRuns.length > 0 && <section className="zclient-section">
                  <div className="zclient-section-head"><h2>进行中</h2></div>
                  <div className="zclient-card zclient-card-flat">
                    <ul className="zclient-list">{activeRuns.map(item => <li key={item.packageRunId}>
                      <div className="zclient-list-item" role="button" tabIndex={busy ? -1 : 0}
                        aria-label={`查看 ${item.title}`}
                        onClick={() => { if (!busy) { setPackageRun(item); setPage("results"); } }}
                        onKeyDown={event => { if (!busy && (event.key === "Enter" || event.key === " ")) { event.preventDefault(); setPackageRun(item); setPage("results"); } }}>
                        <span className="zclient-list-main">
                          <strong className="zclient-list-title">{item.title}</strong>
                          <CopyableId id={item.packageRunId} label="编号" compact />
                        </span>
                        <span className="zclient-pill" data-tone={serviceStageTone(item.stage)}>{serviceStageLabel(item.stage)}</span>
                        <span className="zclient-list-chevron" aria-hidden="true">›</span>
                      </div>
                    </li>)}</ul>
                  </div>
                </section>}

                <div className="zclient-services">
                  {packages.map(item => <ServiceCard key={item.packageId}
                    title={item.headline ?? item.title}
                    summary={item.summary}
                    accent={item.accent}
                    cover={item.showcase?.[0]?.url}
                    itemCount={item.itemCount}
                    disabled={busy}
                    onOpen={() => void attempt(() => openPackage(item.packageId))} />)}
                </div>
                {!packages.length && <div className="zclient-card zclient-empty"><div>暂无可用的服务</div><div>请联系管理员开通并发布。</div></div>}
              </>}

              {page === "results" && <>
                <div className="zclient-heading">
                  <div>
                    <span className="zclient-eyebrow">我的作品</span>
                    <h1>作品</h1>
                    <p>每次任务的产出都在这里，按任务分组。</p>
                  </div>
                </div>

                {packageRun && <section className="zclient-card">
                  <div className="zclient-row" style={{ justifyContent: "space-between" }}>
                    <h2 style={{ margin: 0 }}>{packageRun.title}</h2>
                    <div className="zclient-row">
                      <span className="zclient-pill" data-tone={serviceStageTone(packageRun.stage)}>{serviceStageLabel(packageRun.stage)}</span>
                      <button className="zclient-btn zclient-btn-ghost" onClick={() => void attempt(async () => { const latest = await api<ServiceRunDetail>("/api/v1/self/package-runs/" + encodeURIComponent(packageRun.packageRunId)); setPackageRun(latest); })}>刷新</button>
                    </div>
                  </div>
                  <CopyableId id={packageRun.packageRunId} />
                  {packageRun.progress && packageRun.progress.completed > 0 && resultGallery(packageRun.packageRunId)}
                  {packageRun.progress && packageRun.progress.total > 1 && <p className="zclient-muted">已完成 {packageRun.progress.completed} / {packageRun.progress.total} 步</p>}
                  {packageRun.stage === "failed" && <div className="zclient-notice" data-tone="bad">
                    <span>这一步没有成功。已消耗的积分会自动退回。</span>
                    {packageRun.retry && <button className="zclient-btn zclient-btn-primary" disabled={busy} onClick={() => void confirmPackageItem(packageRun.retry!.itemId, "retry")}>重试</button>}
                  </div>}
                  {packageRun.confirmation && <div className="zclient-row">
                    <span className="zclient-muted">第 {packageRun.confirmation.step} 步已完成，满意就继续。</span>
                    <button className="zclient-btn zclient-btn-primary" disabled={busy} onClick={() => void confirmPackageItem(packageRun.confirmation!.itemId, "approve")}>满意，继续</button>
                    <button className="zclient-btn" disabled={busy} onClick={() => void confirmPackageItem(packageRun.confirmation!.itemId, "redo")}>重做这一步</button>
                  </div>}
                  <details className="zclient-steps">
                    <summary>本次提交的原始输入</summary>
                    <PackageRunInputs packageRunId={packageRun.packageRunId} userId={user.id} busy={busy}
                      onReuse={(values, reusable) => void attempt(() => reusePackageInputs(packageRun.packageId ?? "", values, reusable))} />
                  </details>
                </section>}

                <section className="zclient-card">
                  <h2>任务记录</h2>
                  {!packageRuns.length && <div className="zclient-empty"><div>还没有任务</div><div>从「服务」开始第一个。</div></div>}
                  {/* 用户面只列服务运行：单场景运行是服务的内部实现，不在这里单独出现。 */}
                  <ul className="zclient-list">
                    {packageRuns.map(item => <li key={item.packageRunId}>
                      {/* 整行可点：用可聚焦容器而不是 <button>，因为行内有「复制」按钮，按钮不能嵌套。 */}
                      <div className="zclient-list-item" role="button" tabIndex={busy ? -1 : 0}
                        aria-label={`查看 ${item.title} 的结果`}
                        aria-disabled={busy || undefined}
                        onClick={() => { if (!busy) setPackageRun(item); }}
                        onKeyDown={event => { if (!busy && (event.key === "Enter" || event.key === " ")) { event.preventDefault(); setPackageRun(item); } }}>
                        <span className="zclient-list-main">
                          <strong className="zclient-list-title">{item.title}</strong>
                          <CopyableId id={item.packageRunId} />
                        </span>
                        <span className="zclient-pill" data-tone={serviceStageTone(item.stage)}>{serviceStageLabel(item.stage)}{item.progress && item.progress.total > 1 ? ` · ${item.progress.completed}/${item.progress.total}` : ""}</span>
                        <span className="zclient-list-chevron" aria-hidden="true">›</span>
                      </div>
                    </li>)}
                  </ul>
                </section>

                {run && <UserRunDetail key={run.runId} run={run} userId={user.id} busy={busy} submissionPending={!!pendingRun}
                  onRefresh={() => selectRun(run.runId)} onCancel={() => void action("cancel")} onResume={() => void action("resume")}
                  onReview={decision => void action("review", decision)} />}
              </>}

              {page === "account" && <>
                <div className="zclient-heading">
                  <div>
                    <span className="zclient-eyebrow">账户</span>
                    <h1>{user.displayName}</h1>
                    <p>{user.username}</p>
                  </div>
                  <div className="zclient-row">
                    <button className="zclient-btn" onClick={() => void attempt(async () => logout())}><LogOut size={15} />退出登录</button>
                    {onAdmin && <button className="zclient-btn zclient-btn-ghost" onClick={() => void attempt(async () => returnToAdmin())}>返回管理后台</button>}
                  </div>
                </div>

                <section className="zclient-card">
                  <h2>积分</h2>
                  <div className="zclient-metrics">
                    <div className="zclient-metric"><strong>{credits ? formatPoints(credits.available) : "—"}</strong><small>可用</small></div>
                    <div className="zclient-metric"><strong>{credits ? formatPoints(credits.reserved) : "—"}</strong><small>进行中占用</small></div>
                    <div className="zclient-metric"><strong>{credits ? formatPoints(credits.balance) : "—"}</strong><small>总余额</small></div>
                  </div>
                  <p className="zclient-muted">按上限预扣、按成功产出结算；失败、跳过与取消的部分自动退回，不会事后补扣。</p>
                </section>

                {ledger.length > 0 && <section className="zclient-card">
                  <h2>积分记录</h2>
                  <ul className="zclient-list">{ledger.map(entry => <li key={entry.entryId} className="zclient-list-item" style={{ cursor: "default" }}>
                    <span className="zclient-list-main">
                      <strong className="zclient-list-title">{entry.note || ledgerKindLabel(entry.kind)}</strong>
                      <small>{new Date(entry.createdAt).toLocaleString("zh-CN")}</small>
                    </span>
                    <span className="zclient-pill" data-tone={entry.delta >= 0 ? "good" : undefined}>{entry.delta >= 0 ? "+" : ""}{formatPoints(entry.delta)}</span>
                  </li>)}</ul>
                </section>}
              </>}

              {page === "feedback" && <SystemFeedback key={user.id} userId={user.id} />}
            </div>
          </div>}
    </main>
    {confirmDialog}
  </div>;

  /** 服务页里的结果区块：最近一次已完成任务的产出；没有就显示空提示。 */
  function latestResult() {
    const latest = packageRuns.find(item => item.stage === "completed");
    if (!latest) return <div className="zclient-empty"><div>还没有产出</div><div>填好输入点「生成」，结果会出现在这里。</div></div>;
    // 已完成但没读到媒体：说清楚是「这次没有图片」，不要写成「还在生成」——那是另一个状态。
    return resultGallery(latest.packageRunId, "这次已完成，但没有产出图片。换一组输入再试一次。");
  }

  /** 工作台右侧：当前这次运行的实时状态与产出；没有在跑就显示最近一次完成的结果。 */
  function workspaceResult() {
    if (packageRun && packageRun.stage !== "completed") {
      return <div className="zclient-empty">
        <div>{serviceStageLabel(packageRun.stage)}</div>
        <div>{packageRun.stage === "running" && packageRun.progress ? `已完成 ${packageRun.progress.completed} / ${packageRun.progress.total} 步` : "结果生成后会自动出现在这里。"}</div>
        {packageRun.stage === "failed" && packageRun.retry && <button type="button" className="zclient-btn zclient-btn-primary" disabled={busy} onClick={() => void confirmPackageItem(packageRun.retry!.itemId, "retry")}>重试</button>}
        {packageRun.confirmation && <div className="zclient-row">
          <button type="button" className="zclient-btn zclient-btn-primary" disabled={busy} onClick={() => void confirmPackageItem(packageRun.confirmation!.itemId, "approve")}>满意，继续</button>
          <button type="button" className="zclient-btn" disabled={busy} onClick={() => void confirmPackageItem(packageRun.confirmation!.itemId, "redo")}>重做这一步</button>
        </div>}
      </div>;
    }
    // 已完成但没有产出（例如本次输入没带参考图）不能说「还在生成」——那是假的状态。
    if (packageRun?.stage === "completed") return resultGallery(packageRun.packageRunId, "这次已完成，但没有产出图片。换一组输入再试一次。");
    return latestResult();
  }

  /**
   * 工作台底部历史条：出图工具的历史要能一眼看到图，所以用缩略图而不是文字列表。
   * 点一张切到那次的结果，「套用」则把那次的参数填回左侧表单。
   */
  function workspaceHistory() {
    const completed = packageRuns.filter(item => item.stage === "completed").slice(0, 8);
    if (!completed.length) return <p className="sws-history-empty">还没有历史；生成过的图片会按时间排在这里。</p>;
    return <ul className="sws-history-strip">{completed.map(item => <li key={item.packageRunId}>
      <button type="button" className={`sws-history-item${packageRun?.packageRunId === item.packageRunId ? " is-active" : ""}`}
        onClick={() => { setPackageRun(item); setStartedAt(undefined); }}
        title={new Date(item.createdAt).toLocaleString("zh-CN")}>
        <HistoryThumb packageRunId={item.packageRunId} label={item.title} />
        <span>{new Date(item.createdAt).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}</span>
      </button>
      <button type="button" className="sws-history-reuse" disabled={Boolean(reuseBusy)}
        onClick={() => void applyRunInputs(item.packageRunId)}
        title="把这一组的参数填回左侧表单">
        {reuseBusy === item.packageRunId ? "读取中…" : "套用"}
      </button>
    </li>)}</ul>;
  }

  /** 结果区右上角：就地套用这次（或当前查看的这次）运行的参数，不用跳页重开服务。 */
  function workspaceResultActions() {
    const target = packageRun ?? packageRuns.find(item => item.stage === "completed");
    if (!target) return undefined;
    const busyThis = reuseBusy === target.packageRunId;
    return <button type="button" className="sws-reuse" disabled={Boolean(reuseBusy)} onClick={() => void applyRunInputs(target.packageRunId)}
      title="把这次生成用的参数填回左侧表单，改一改就能再生成">
      {busyThis ? "读取参数中…" : "用这组参数"}
    </button>;
  }

  /** 表单字段：两种布局共用同一份渲染，避免工作台与营销页各写一套。 */
  function serviceFields() {
    if (!activePackage) return null;
    return <>
      <ServiceQuickStarts
        presentation={activePackage.presentation}
        onApplyPrompt={(value, inputKey) => {
          const target = inputKey ?? activePackage.fields.find(field => field.type === "textarea" || field.type === "text")?.key;
          if (target) updatePackageValue(target, value);
        }}
        onApplyPreset={values => {
          const next = { ...packageValues, ...values };
          setPackageValues(next);
          void refreshEstimate(next);
        }}
      />
      {activePackage.fields.filter(field => !field.hidden).map(field => <label className="zclient-field" key={field.key}>
        <span className="zclient-field-label">{field.label}{field.required ? <em>必填</em> : null}</span>
        {/image|video|audio/.test(field.type) ? <UserMediaInput
          label={field.label}
          kind={(/audio/.test(field.type) ? "audio" : /video/.test(field.type) ? "video" : "image") as UserMediaKind}
          multiple={/\[\]|_list|images|videos|audios/.test(field.type)}
          value={packageValues[field.key]}
          userId={user.id}
          disabled={busy}
          uploading={uploadingKey === field.key}
          uploadProgress={uploadingKey === field.key ? uploadProgress : undefined}
          onUpload={files => void upload(field.key, field.type, files)}
          onMove={(index, offset) => {
            const current = packageValues[field.key];
            const items = Array.isArray(current) ? [...current] : current === undefined || current === null || current === "" ? [] : [current];
            const target = index + offset;
            if (index < 0 || index >= items.length || target < 0 || target >= items.length) return;
            [items[index], items[target]] = [items[target], items[index]];
            updatePackageValue(field.key, items);
          }}
          onRemove={index => {
            const current = packageValues[field.key];
            const items = Array.isArray(current) ? current : current === undefined || current === null || current === "" ? [] : [current];
            updatePackageValue(field.key, /\[\]|_list|images|videos|audios/.test(field.type) ? items.filter((_item, position) => position !== index) : "");
          }}
          onClear={() => updatePackageValue(field.key, "")}
        />
        : field.type === "select" ? <select className="zclient-input" value={String(packageValues[field.key] ?? "")} onChange={event => updatePackageValue(field.key, event.target.value)}>
          <option value="">请选择</option>{field.options?.map(option => <option key={option}>{option}</option>)}
        </select> : field.type === "boolean" ? <input type="checkbox" checked={packageValues[field.key] === true} onChange={event => updatePackageValue(field.key, event.target.checked)} />
          : field.type === "number" ? <input className="zclient-input" type="number" step="any" value={packageValues[field.key] === undefined ? "" : String(packageValues[field.key])} onChange={event => updatePackageValue(field.key, event.target.value)} />
            : field.type === "textarea" || field.type === "json" ? <textarea className="zclient-input zclient-textarea" rows={5} placeholder={String((field as { placeholder?: string }).placeholder ?? "")} value={typeof packageValues[field.key] === "string" ? packageValues[field.key] as string : packageValues[field.key] === undefined ? "" : JSON.stringify(packageValues[field.key], null, 2)} onChange={event => updatePackageValue(field.key, event.target.value)} />
              : <input className="zclient-input" type="text" placeholder={String((field as { placeholder?: string }).placeholder ?? "")} value={typeof packageValues[field.key] === "string" ? packageValues[field.key] as string : packageValues[field.key] === undefined ? "" : String(packageValues[field.key])} onChange={event => updatePackageValue(field.key, event.target.value)} />}
      </label>)}
    </>;
  }
}

function ledgerKindLabel(kind: string) {
  if (kind === "cdk_redeem") return "卡密兑换";
  if (kind === "admin_grant") return "管理员赠送";
  if (kind === "admin_adjust") return "积分调整";
  if (kind === "run_reserve") return "任务预扣";
  if (kind === "run_settle") return "任务结算";
  if (kind === "run_refund") return "任务退款";
  if (kind === "cdk_refund") return "卡密退回";
  return "积分变动";
}

/**
 * 历史缩略图：只取该次运行的第一张图，用于底部历史条。
 * 复用结果接口但不整页渲染，避免历史条把每次运行的产出全拉一遍。
 */
function HistoryThumb({ packageRunId, label }: { packageRunId: string; label: string }) {
  const [url, setUrl] = useState("");
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let stopped = false;
    void (async () => {
      try {
        const response = await fetch("/api/v1/self/package-runs/" + encodeURIComponent(packageRunId) + "/outputs", { credentials: "same-origin" });
        if (!response.ok) { if (!stopped) setFailed(true); return; }
        const data = await response.json() as { items?: Array<{ media: Array<{ url: string; kind: string }> }> };
        const first = (data.items ?? []).flatMap(item => item.media).find(media => media.kind === "image" || media.kind === "video");
        if (!stopped) { if (first) setUrl(first.url); else setFailed(true); }
      } catch { if (!stopped) setFailed(true); }
    })();
    return () => { stopped = true; };
  }, [packageRunId]);
  if (failed) return <span className="sws-history-placeholder" aria-hidden="true">·</span>;
  if (!url) return <span className="sws-history-placeholder" aria-hidden="true">…</span>;
  return <RecentShot url={url} kind="image" label={label} className="zclient-shot" zoomable />;
}

/**
 * 结果画廊：读服务级产出（服务端已按包内顺序聚合各步媒体，不暴露子运行）。
 * 与「作品」页共用同一份读取逻辑，避免两处渲染不一致。
 */
function ServiceResultGallery({ packageRunId, emptyHint }: { packageRunId: string; emptyHint?: string }) {
  const [shots, setShots] = useState<Shot[]>([]);
  const [error, setError] = useState("");
  const loaded = useRef("");
  useEffect(() => {
    if (loaded.current === packageRunId) return;
    loaded.current = packageRunId;
    void (async () => {
      try {
        const response = await fetch("/api/v1/self/package-runs/" + encodeURIComponent(packageRunId) + "/outputs", { credentials: "same-origin" });
        if (!response.ok) { setError("结果暂时读取不到"); return; }
        const data = await response.json() as { items?: Array<{ index: number; media: Array<{ url: string; kind: "image" | "video" | "audio" }> }> };
        setShots((data.items ?? []).flatMap(item => item.media.filter(media => media.kind !== "audio").map((media, index) => ({
          key: item.index + ":" + index, url: media.url, kind: media.kind as "image" | "video", label: "产出",
        }))));
      } catch { setError("结果暂时读取不到"); }
    })();
  }, [packageRunId]);
  if (error) return <div className="zclient-empty"><div>{error}</div></div>;
  if (!shots.length) return <div className="zclient-empty"><div>{emptyHint ?? "还在生成中，稍后刷新"}</div></div>;
  return <div className="zclient-gallery">{shots.map(shot => <RecentShot key={shot.key} url={shot.url} kind={shot.kind} label={shot.label} className="zclient-shot" zoomable />)}</div>;
}
