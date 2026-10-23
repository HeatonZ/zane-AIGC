import { useEffect, useState } from "react";
import { accessApi, jsonBody } from "../lib/accessApi";
import { useConfirmDialog } from "../components/ConfirmDialog";
import { formatPoints } from "../../server/domain/creditUnits.js";

interface Batch { batchId: string; name: string; faceValue: number; codeCount: number; createdAt: string; unused: number; redeemed: number; voided: number; packageId?: string; expiresAt?: string; note?: string }
interface RedeemCode { codeId: string; codeHint: string; status: "unused" | "redeemed" | "void"; faceValue: number; code?: string; recoverable: boolean; redeemedBy?: string; redeemedAt?: string; voidedAt?: string; voidedBy?: string; reclaimedFaceValue?: number; expiresAt?: string; createdAt: string }
interface BatchDetail { batch: Batch; codes: RedeemCode[]; counts: { unused: number; redeemed: number; voided: number }; recoverable: boolean }
/** 可绑定的服务（场景包）：id 是包 ID，title 是给人看的名字。 */
interface ServiceOption { id: string; title: string }

const statusLabels: Record<RedeemCode["status"], string> = { unused: "未使用", redeemed: "已兑换", void: "已作废" };

/** 管理端积分与卡密：发码（明文只返回一次）、批次明细、逐张/整批作废、按用户调账。 */
export default function CreditManagement() {
  const { confirm, dialog } = useConfirmDialog();
  const [batches, setBatches] = useState<Batch[]>([]);
  const [name, setName] = useState("");
  const [faceValue, setFaceValue] = useState("100");
  const [count, setCount] = useState("10");
  const [expiresAt, setExpiresAt] = useState("");
  const [packageId, setPackageId] = useState("");
  const [serviceOptions, setServiceOptions] = useState<ServiceOption[]>([]);
  const [servicesLoaded, setServicesLoaded] = useState(false);
  const [batchId, setBatchId] = useState<string>(() => crypto.randomUUID());
  /** 未确认落库的批次ID：失败重试沿用它，成功后清空并轮换。 */
  const [pendingBatchId, setPendingBatchId] = useState<string | null>(null);
  const [issued, setIssued] = useState<{ batchId: string; codes: string[] } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [detail, setDetail] = useState<BatchDetail | null>(null);
  const [reconciliation, setReconciliation] = useState<{ healthy: boolean; totals: { accounts: number; balance: number; reserved: number; usersWithReserved: number }; mismatchedBalances: unknown[]; overRefunded: unknown[]; accounts: Array<{ userId: string; balance: number; ledgerTotal: number; reserved: number; available: number; balanceMatchesLedger: boolean }> } | null>(null);

  async function attempt(action: () => Promise<void>) { setError(""); try { await action(); } catch (e) { setError((e as Error).message); } }
  async function loadBatches() { setBatches((await accessApi<{ batches: Batch[] }>("/api/v1/redeem-batches")).batches); }
  /**
   * 绑定服务下拉框的数据源。
   * 管理端 `/api/v1/packages` 返回的是代码包注册项：ID 在 `packageId`、显示名在
   * `manifest.title`。早先这里按 `id`/`title` 读，两个都是 undefined，下拉框只剩
   * 一对空括号——不是没数据，是字段名读错了。
   *
   * 同时按状态过滤：加载失败（error）或已停用（disabled）的包不能绑——绑上去用户
   * 登录即进入一个跑不起来的服务。失败也不再静默吞成空列表，要把原因放到界面上，
   * 否则管理员只会看到空括号，无从判断是没包还是接口挂了。
   */
  async function loadServices() {
    const data = await accessApi<{ packages?: Array<Record<string, unknown>> }>("/api/v1/packages");
    const options: ServiceOption[] = [];
    for (const entry of data.packages ?? []) {
      const id = typeof entry.packageId === "string" ? entry.packageId : "";
      if (!id) continue;
      const disabled = entry.enabled === false || entry.status === "disabled" || entry.status === "error";
      if (disabled) continue;
      const manifest = (entry.manifest ?? {}) as { title?: string };
      const title = typeof manifest.title === "string" && manifest.title.trim() ? manifest.title.trim() : id;
      options.push({ id, title });
    }
    options.sort((left, right) => left.title.localeCompare(right.title, "zh-Hans-CN") || left.id.localeCompare(right.id));
    setServiceOptions(options);
    setServicesLoaded(true);
  }
  useEffect(() => { void attempt(loadBatches); void attempt(loadServices); }, []);
  async function loadReconciliation() { setReconciliation(await accessApi<typeof reconciliation>("/api/v1/settings/credits/reconciliation")); }
  useEffect(() => { void attempt(loadReconciliation); }, []);

  async function openDetail(target: string) {
    setError(""); setNotice("");
    try { setDetail(await accessApi<BatchDetail>("/api/v1/redeem-batches/" + encodeURIComponent(target) + "/codes")); }
    catch (e) { setError((e as Error).message); }
  }
  async function createBatch() {
    setBusy(true); setError(""); setNotice("");
    // 批次ID是幂等键：同ID重复提交由服务端返回原批次（created=false），不会多建一批。
    // 成功后轮换新ID，下一批才是新的一批；失败重试沿用同一ID，避免把「已建成但回执丢失」变成重复批次。
    const targetBatchId = pendingBatchId ?? crypto.randomUUID();
    if (!pendingBatchId) { setPendingBatchId(targetBatchId); setBatchId(targetBatchId); }
    try {
      const result = await accessApi<{ batch: Batch; codes: string[]; created: boolean; warning: string }>("/api/v1/redeem-batches", jsonBody({
        batchId: targetBatchId, name: name.trim() || "卡密批次", faceValue: Number(faceValue), count: Number(count),
        ...(expiresAt ? { expiresAt: new Date(expiresAt).toISOString() } : {}),
        ...(packageId ? { packageId } : {}),
      }));
      setIssued({ batchId: result.batch.batchId, codes: result.codes });
      setNotice((result.created ? "已生成批次 " : "该批次ID已存在，已返回原批次结果（未新建）") + result.batch.batchId + "。" + result.warning);
      // 成功即轮换：下一批是另一张新ID。
      setPendingBatchId(null);
      setBatchId(crypto.randomUUID());
      await loadBatches();
    } catch (e) {
      setError((e as Error).message);
    } finally { setBusy(false); }
  }
  async function voidCode(code: RedeemCode) {
    if (!detail) return;
    const redeemed = code.status === "redeemed";
    const confirmed = await confirm({
      title: redeemed ? "作废已兑换的卡密并收回积分" : "作废这张卡密",
      message: redeemed
        ? "这张卡已由 " + (code.redeemedBy ?? "某用户") + " 兑换，面值 " + formatPoints(code.faceValue) + " 分。作废会同时从该账户收回积分（余额不足就扣到 0，差额会如实显示），并写一条收回流水。作废后用户不能再兑换。"
        : "将作废批次 " + detail.batch.name + " 中末四位 " + code.codeHint + " 的卡密（" + code.codeId + "）。作废后无法恢复，用户不能再兑换。",
      confirmLabel: redeemed ? "作废并收回" : "作废",
      tone: "danger",
    });
    if (!confirmed) return;
    setBusy(true); setError(""); setNotice("");
    try {
      const result = await accessApi<{ reclaimed?: number; shortfall?: number }>("/api/v1/redeem-codes/" + encodeURIComponent(code.codeId) + "/void", jsonBody({ reclaim: true }));
      setNotice("已作废 " + code.codeId + (result.reclaimed ? "，已收回 " + formatPoints(result.reclaimed) + " 分" : "") + (result.shortfall ? "（余额不足，未收回 " + formatPoints(result.shortfall) + " 分）" : ""));
      await Promise.all([openDetail(detail.batch.batchId), loadBatches()]);
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  async function voidBatch() {
    if (!detail) return;
    const redeemed = detail.counts.redeemed;
    const confirmed = await confirm({
      title: "整批作废",
      message: "将作废批次 " + detail.batch.name + " 中未使用的 " + detail.counts.unused + " 张" + (redeemed > 0 ? "，并把已兑换的 " + redeemed + " 张一并作废、逐张收回面值（余额不足就扣到 0，差额会如实显示）" : "") + "。作废后无法恢复。",
      confirmLabel: "整批作废并收回",
      tone: "danger",
    });
    if (!confirmed) return;
    setBusy(true); setError(""); setNotice("");
    try {
      const result = await accessApi<{ voided: number; reclaimed?: number; shortfall?: number; partial?: Array<{ codeHint: string }>; note?: string }>("/api/v1/redeem-batches/" + encodeURIComponent(detail.batch.batchId) + "/void", jsonBody({ reclaim: true, includeRedeemed: true }));
      setNotice("本次作废 " + result.voided + " 张" + (result.reclaimed ? "，收回 " + formatPoints(result.reclaimed) + " 分" : "") + (result.shortfall ? "；" + (result.partial?.length ?? 0) + " 张余额不足，合计未收回 " + formatPoints(result.shortfall) + " 分（" + (result.partial ?? []).map(item => item.codeHint).join("、") + "）" : "") + (result.note ? "；" + result.note : ""));
      await Promise.all([openDetail(detail.batch.batchId), loadBatches()]);
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  function download() {
    if (!issued) return;
    downloadCodes(issued.codes, "redeem-" + issued.batchId + ".txt");
  }
  /** 卡密明文存库后，任何时候都能再导出一份；旧批次没有明文时按钮不可用。 */
  function downloadDetail() {
    if (!detail) return;
    const lines = detail.codes.filter(code => code.code).map(code => code.code!);
    if (lines.length) downloadCodes(lines, "redeem-" + detail.batch.batchId + ".txt");
  }
  function downloadCodes(codes: string[], filename: string) {
    const blob = new Blob([codes.join("\r\n")], { type: "text/plain;charset=utf-8" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = filename;
    link.click();
    URL.revokeObjectURL(link.href);
  }
  async function copyCode(code: string) {
    setError(""); setNotice("");
    try { await navigator.clipboard.writeText(code); setNotice("已复制 " + code); }
    catch { setError("复制失败，请手动选择卡密文本"); }
  }

  return <div className="access-stack">
    {dialog}
    <header className="access-heading"><div><h1>积分与卡密</h1><p>卡密明文保存在本机数据库，可随时在批次明细里回读或导出；请只在发放与核对时查看，不要外传。</p></div><button className="button button-outline" onClick={() => void attempt(loadBatches)}>刷新批次</button></header>
    {error && <p role="alert" className="access-error">{error}</p>}
    {notice && <p role="status" className="access-success">{notice}</p>}

    <section className="access-card">
      <h2>生成卡密批次</h2>
      <div className="credit-form">
        <label>批次名称<input className="text-input" value={name} onChange={e => setName(e.target.value)} placeholder="首期内测" /></label>
        <label>面值（积分）<input className="text-input" type="number" min={1} value={faceValue} onChange={e => setFaceValue(e.target.value)} /></label>
        <label>数量<input className="text-input" type="number" min={1} max={500} value={count} onChange={e => setCount(e.target.value)} /></label>
        <label>有效期（可选）<input className="text-input" type="datetime-local" value={expiresAt} onChange={e => setExpiresAt(e.target.value)} /></label>
        <label>绑定服务（用户登录后直接进入）<select className="text-input" value={packageId} onChange={e => setPackageId(e.target.value)}>
          <option value="">不绑定（登录后自己挑）</option>
          {serviceOptions.map(option => <option key={option.id} value={option.id}>{option.title}（{option.id}）</option>)}
        </select>
        {servicesLoaded && !serviceOptions.length && <small className="access-muted">当前没有可绑定的服务：场景包未加载成功或尚未部署。</small>}
        </label>
      </div>
      <button className="button button-dark" disabled={busy || Number(faceValue) < 1 || Number(count) < 1 || Number(count) > 500} onClick={() => void createBatch()}>生成</button>
      <small>下一个批次ID：{batchId}{pendingBatchId ? "（上次提交未确认，重试会沿用这个ID，避免重复建批）" : ""}</small>
      {issued && <div className="credit-issued">
        <div className="access-inline"><strong>本批明文</strong><button className="button button-outline" onClick={download}>下载 .txt</button><button className="button button-outline" onClick={() => setIssued(null)}>收起</button></div>
        <textarea className="text-input" readOnly rows={Math.min(12, issued.codes.length + 1)} value={issued.codes.join("\n")} aria-label="卡密明文" />
      </div>}
    </section>

    <section className="access-card">
      <div className="user-run-history-heading"><h2>批次</h2><button className="run-icon-button" onClick={() => void attempt(loadBatches)}>刷新</button></div>
      <ul className="access-list">{batches.map(batch => <li key={batch.batchId}>
        <button className="access-link" onClick={() => void openDetail(batch.batchId)}>{batch.name}<small>{batch.batchId} · 面值 {formatPoints(batch.faceValue)} · {batch.codeCount} 张{batch.packageId ? " · 绑定 " + batch.packageId : ""}{batch.expiresAt ? " · 有效期至 " + batch.expiresAt.slice(0, 10) : ""}</small></button>
        <small>未用 {batch.unused} · 已用 {batch.redeemed} · 作废 {batch.voided}</small>
      </li>)}</ul>
      {!batches.length && <p>还没有批次。</p>}
    </section>

    {detail && <section className="access-card">
      <div className="user-run-history-heading"><h2>{detail.batch.name} · 明细</h2><div className="access-inline">
        <button className="button button-outline" onClick={() => void openDetail(detail.batch.batchId)}>刷新明细</button>
        <button className="button button-outline" disabled={!detail.recoverable} onClick={downloadDetail}>导出本批卡密 .txt</button>
        <button className="button button-danger" disabled={busy || detail.counts.unused === 0 && detail.counts.redeemed === 0} onClick={() => void voidBatch()}>整批作废并收回（未用 {detail.counts.unused} · 已用 {detail.counts.redeemed}）</button>
        <button className="button button-outline" onClick={() => setDetail(null)}>收起</button>
      </div></div>
      <p className="access-muted">未用 {detail.counts.unused} · 已用 {detail.counts.redeemed} · 作废 {detail.counts.voided}。卡密明文保存在本机数据库，可随时回读与导出；请只在需要发放或核对时查看，不要截图外传。</p>
      {!detail.recoverable && <p className="access-error">这个批次创建于明文存储上线之前，库里只有哈希，无法回读卡密；如需发放请作废后重新生成。</p>}
      <ul className="access-list">{detail.codes.map(code => <li key={code.codeId}>
        <span>
          <strong className={code.code ? "redeem-code-plain" : "access-muted"}>{code.code ?? "（不可回读 · 末四位 " + code.codeHint + "）"}</strong>
          <small>{code.codeId} · 面值 {formatPoints(code.faceValue)}{code.redeemedBy ? " · 兑换人 " + code.redeemedBy : ""}{code.redeemedAt ? " · " + code.redeemedAt : ""}{code.voidedAt ? " · 作废于 " + code.voidedAt : ""}{code.reclaimedFaceValue ? " · 已收回 " + formatPoints(code.reclaimedFaceValue) : ""}{code.expiresAt ? " · 有效期至 " + code.expiresAt.slice(0, 10) : ""}</small>
        </span>
        <span className="access-inline">
          <strong className={code.status === "redeemed" ? "credit-positive" : code.status === "void" ? "credit-negative" : ""}>{statusLabels[code.status]}</strong>
          <button className="button button-outline" disabled={!code.code} onClick={() => void copyCode(code.code!)}>复制</button>
          <button className="button button-outline" disabled={busy || code.status === "void"} onClick={() => void voidCode(code)}>{code.status === "redeemed" ? "作废并收回" : "作废"}</button>
        </span>
      </li>)}</ul>
      {!detail.codes.length && <p>这个批次没有码。</p>}
    </section>}

    <section className="access-card">
      <div className="user-run-history-heading"><h2>账本对账</h2><button className="run-icon-button" onClick={() => void attempt(loadReconciliation)}>刷新</button></div>
      {!reconciliation && <p className="access-muted">读取中…</p>}
      {reconciliation && <>
        <p className={reconciliation.healthy ? "access-success" : "access-error"}>
          {reconciliation.healthy ? "账本一致" : "发现异常，请核对下方明细"} · 账户 {reconciliation.totals.accounts} · 总余额 {formatPoints(reconciliation.totals.balance)} · 未结预扣 {formatPoints(reconciliation.totals.reserved)}（{reconciliation.totals.usersWithReserved} 个账户）
        </p>
        <p className="access-muted">结算写错时余额与流水会一起错，所以只看一致性发现不了问题；未结预扣长期不下降通常意味着漏结算。</p>
        {reconciliation.mismatchedBalances.length > 0 && <div className="access-error">余额≠流水累计：{reconciliation.mismatchedBalances.length} 个账户</div>}
        {reconciliation.overRefunded.length > 0 && <div className="access-error">退款超过预扣：{reconciliation.overRefunded.length} 笔</div>}
        <ul className="access-list">{reconciliation.accounts.map(row => <li key={row.userId}>
          <span>{row.userId}<small>余额 {formatPoints(row.balance)} · 流水 {formatPoints(row.ledgerTotal)} · 未结预扣 {formatPoints(row.reserved)} · 可用 {formatPoints(row.available)}</small></span>
          <strong className={row.balanceMatchesLedger ? "credit-positive" : "credit-negative"}>{row.balanceMatchesLedger ? "一致" : "不一致"}</strong>
        </li>)}</ul>
      </>}
    </section>

  </div>;
}
