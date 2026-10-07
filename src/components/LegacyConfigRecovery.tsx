import { useState } from "react";

// Upgrade-only recovery of pre-account pending writes. This is not a scene store,
// and must never be merged/replayed into the server automatically.
export default function LegacyConfigRecovery() {
  const [legacy] = useState(() => {
    try { return localStorage.getItem("zane-studio:config-outbox:v1"); } catch { return null; }
  });
  const [dismissed, setDismissed] = useState(false);
  if (!legacy || dismissed) return null;
  function download() {
    const url = URL.createObjectURL(new Blob([legacy!], { type: "application/json" }));
    const anchor = document.createElement("a");
    anchor.href = url; anchor.download = "zane-pre-account-pending-edits.json"; anchor.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  return <section className="access-card" role="status">
    <h3>保留了升级前尚未确认的编辑</h3>
    <p>这份旧提交意图没有账户归属，未加载为场景，也不会自动重放。可先下载原始备份，再由管理员对照服务端逐项处理；不会删除浏览器中的原内容。</p>
    <button className="button button-outline" onClick={download}>下载旧待提交编辑备份</button>
    <button className="button button-outline" onClick={() => setDismissed(true)}>本次隐藏提示</button>
  </section>;
}
