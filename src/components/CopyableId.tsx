import { useState } from "react";
import { Check, Copy } from "lucide-react";

/**
 * 任务编号：客户端结果页用于对账、报障与检索。
 * 完整编号直接可见（用户要求能看 ID），复制按钮只是省去手动选中。
 * compact 只影响显示，复制与 title 始终是完整编号。
 */
export default function CopyableId({ id, label = "任务编号", compact = false }: {
  id: string; label?: string; compact?: boolean;
}) {
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState("");
  async function copy() {
    try { await navigator.clipboard.writeText(id); setCopied(true); setError(""); }
    catch { setError("无法自动复制，请选中编号手动复制。"); }
  }
  return <span className={`studio-id${compact ? " studio-id-compact" : ""}`}>
    <span className="studio-id-label">{label}</span>
    <code title={id}>{compact ? id.slice(0, 8) : id}</code>
    <button type="button" className="studio-id-copy"
      onClick={event => { event.stopPropagation(); void copy(); }}
      onKeyDown={event => event.stopPropagation()}
      aria-label={`复制${label} ${id}`}>
      {copied ? <Check size={13} /> : <Copy size={13} />}{copied ? "已复制" : "复制"}
    </button>
    {error && <small className="studio-id-error" role="alert">{error}</small>}
  </span>;
}
