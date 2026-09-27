import { Check, Circle, LoaderCircle, X } from "lucide-react";
import type { ConnectorState } from "../types";

export default function ConnectorBadge({ state }: { state?: ConnectorState }) {
  const status = state?.status ?? "not_configured";
  const label = status === "connected" ? "已连接" : status === "disconnected" ? "离线" : "未配置";
  const Icon = status === "connected" ? Check : status === "disconnected" ? X : Circle;

  return (
    <span className={`connector-badge ${status}`}>
      <Icon size={12} strokeWidth={2.5} />{label}
    </span>
  );
}

export function ConnectorMark({ state }: { state?: ConnectorState }) {
  const status = state?.status ?? "not_configured";
  if (status === "connected") return <span className="connector-mark connected"><Check size={12} /></span>;
  if (status === "disconnected") return <span className="connector-mark disconnected"><X size={12} /></span>;
  return <span className="connector-mark pending"><LoaderCircle size={12} /></span>;
}

