import { useEffect, useState } from "react";
import { ApiError, getAsset } from "../lib/api";
import { clearAssetWrite, pendingAssetWrites, type PendingAssetWrite } from "../lib/assetWriteRecovery";
import type { AssetSummary } from "../../server/domain/assetLibraryContracts";
export default function AssetWriteRecovery({ onReconciled }: { onReconciled(): void }) {
  const [pending, setPending] = useState<PendingAssetWrite[]>([]);
  const [error, setError] = useState(""); const [busy, setBusy] = useState(false);
  const [checked, setChecked] = useState<{ item: PendingAssetWrite; asset?: AssetSummary }>();
  useEffect(() => { const read = () => { try { setPending(pendingAssetWrites()); setChecked(undefined); setError(""); } catch (reason) { setError((reason as Error).message); } }; read(); window.addEventListener("zane-asset-outbox-changed", read); return () => window.removeEventListener("zane-asset-outbox-changed", read); }, []);
  async function check(item: PendingAssetWrite) {
    setBusy(true); setError(""); setChecked(undefined);
    try { const result = await getAsset(item.assetId); setChecked({ item, asset: result.asset }); }
    catch (reason) { if (reason instanceof ApiError && reason.status === 404 && reason.code === "ASSET_NOT_FOUND") setChecked({ item }); else setError((reason as Error).message); }
    finally { setBusy(false); }
  }
  function clear() {
    if (!checked || !window.confirm(checked.asset ? "确认已核对服务端素材？这只清除回执提示，不修改素材。" : "素材暂未找到，但原请求可能仍在落库。确认不再等待？不会重新发送或删除素材。")) return;
    try { clearAssetWrite(checked.item); onReconciled(); } catch (reason) { setError((reason as Error).message); }
  }
  if (!pending.length && !error) return null;
  return <section className="asset-recovery" aria-label="素材写入对账"><strong>素材写入回执未确认</strong><p>仅保留原请求的 ID，不恢复本地素材库、不自动重放。下面展示的素材仍来自服务端。</p>{pending.map(item => <div key={item.assetId}><code>{item.assetId}</code><button className="text-button" disabled={busy} onClick={() => void check(item)}>读取服务端对账</button></div>)}{checked && <div>{checked.asset ? <p>服务端：{checked.asset.name} · revision {checked.asset.revision} · 当前 v{checked.asset.currentVersion}。请核对是否为本次写入。</p> : <p>服务端暂未找到此 ID；原请求可能仍在落库，不要换 ID 重投。</p>}<button className="button button-outline" disabled={busy} onClick={clear}>{checked.asset ? "已核对，清除提示" : "明确放弃等待（仅清除提示）"}</button></div>}{error && <p role="alert">{error}</p>}</section>;
}
