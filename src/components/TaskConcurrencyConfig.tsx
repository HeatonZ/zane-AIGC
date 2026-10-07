import { Check, LoaderCircle, RefreshCw, Save, X } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";
import { loadTaskConcurrency, saveTaskConcurrency } from "../lib/api";
import type { TaskConcurrencySettings } from "../types";

export function validTaskConcurrency(value: string) {
  const numeric = value.trim() ? Number(value) : NaN;
  return Number.isInteger(numeric) && numeric >= 1 && numeric <= 32;
}

export default function TaskConcurrencyConfig() {
  const [snapshot, setSnapshot] = useState<TaskConcurrencySettings | null>(null);
  const [value, setValue] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [needsReconcile, setNeedsReconcile] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  async function read() {
    setLoading(true);
    setError("");
    setNotice("");
    try {
      const current = await loadTaskConcurrency();
      setSnapshot(current);
      setValue(String(current.maxActiveRuns));
      setNeedsReconcile(false);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "无法读取任务并发配置");
      setNeedsReconcile(true);
    } finally { setLoading(false); }
  }
  useEffect(() => { void read(); }, []);

  async function save(event: FormEvent) {
    event.preventDefault();
    if (!snapshot || needsReconcile || !validTaskConcurrency(value)) return;
    setSaving(true);
    setError("");
    setNotice("");
    try {
      const current = await saveTaskConcurrency({ revision: snapshot.revision, maxActiveRuns: Number(value) });
      setSnapshot(current);
      setValue(String(current.maxActiveRuns));
      setNotice("系统任务并发已保存并立即生效，正在运行的任务不会被中断。");
    } catch (reason) {
      // The server may already have committed. Disable writes until the operator explicitly reconciles.
      setNeedsReconcile(true);
      setError((reason instanceof Error ? reason.message : "保存回执未知") + "。请先重新读取配置核对，不要重复提交旧请求。");
    } finally { setSaving(false); }
  }
  const busy = loading || saving;
  return (
    <form className="connection-settings" onSubmit={save}>
      <div className="connection-section-heading"><div><span className="section-index">04</span><div><h2>系统任务并发</h2><p>全系统同时执行的流程任务数量，管理员配置</p></div></div><button type="button" className="button button-outline" onClick={() => void read()} disabled={busy}><RefreshCw size={14} />重新读取配置</button></div>
      <div className="connection-fields single-field">
        <div className="field-group">
          <label className="field-label" htmlFor="task-concurrency">任务并发上限</label>
          <input id="task-concurrency" className="text-input" type="number" required min={1} max={32} step={1} value={value} onChange={event => setValue(event.target.value)} disabled={busy || !snapshot || needsReconcile} />
          <small className="field-help">范围 1–32。调高立即放行排队任务；调低不取消正在执行的任务，待执行数低于新上限后再放行。不需重启。</small>
          <small className="field-help">仅控制流程任务并发；步骤 for_each 的 maxConcurrency 和 ComfyUI 资源限流仍独立生效。</small>
          {snapshot && <small className="field-help">服务端快照：上限 {snapshot.maxActiveRuns} · 执行中 {snapshot.worker.active} · 排队 {snapshot.worker.queued} · 准备中 {snapshot.worker.preparing} · revision {snapshot.revision}。{snapshot.source === "saved" ? "已保存到系统数据库。" : `尚未保存，使用环境默认值 ${snapshot.defaultMaxActiveRuns}。`}</small>}
        </div>
      </div>
      {notice && <div className="notice success-notice"><Check size={15} />{notice}</div>}
      {error && <div className="notice error-notice"><X size={15} />{error}</div>}
      <div className="connection-form-footer"><span>跨重启保存；配置与任务提交相互独立。</span><button className="button button-dark" type="submit" disabled={busy || !snapshot || needsReconcile || !validTaskConcurrency(value)}>{saving ? <LoaderCircle className="spin" size={15} /> : <Save size={15} />}{saving ? "保存中…" : "保存任务并发"}</button></div>
    </form>
  );
}
