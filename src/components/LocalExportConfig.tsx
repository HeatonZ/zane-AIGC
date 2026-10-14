import { Check, FolderOutput, LoaderCircle, RefreshCw, Save, X } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";
import { loadLocalExport, saveLocalExport } from "../lib/api";
import type { LocalExportSettings } from "../types";

/** 根目录必须是绝对路径，且不能是盘符根：整块盘不能被开成可写目录。
 *  空串是合法输入，表示关闭本地导出。错误信息与后端 normalizeLocalExportRoot 保持一致，避免两处口径不同。 */
export function localExportRootError(value: string): string {
  const text = value.trim();
  if (!text) return "";
  if (text.length > 512) return "路径过长，最多 512 个字符。";
  if (/[\0\r\n]/.test(text)) return "路径不能包含控制字符。";
  if (!/^[a-zA-Z]:[\\/]/.test(text) && !text.startsWith("\\\\") && !text.startsWith("/")) return "请填写绝对路径，例如 E:\\AI-outsourcing\\二次元抱枕。";
  if (/^[a-zA-Z]:[\\/]?$/.test(text)) return "不能使用盘符根目录，请指定一个具体子目录。";
  return "";
}

export default function LocalExportConfig() {
  const [snapshot, setSnapshot] = useState<LocalExportSettings | null>(null);
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
      const current = await loadLocalExport();
      setSnapshot(current);
      setValue(current.root);
      setNeedsReconcile(false);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "无法读取本地导出配置");
      setNeedsReconcile(true);
    } finally { setLoading(false); }
  }
  useEffect(() => { void read(); }, []);

  async function save(event: FormEvent) {
    event.preventDefault();
    const invalid = localExportRootError(value);
    if (!snapshot || needsReconcile || invalid) return;
    setSaving(true);
    setError("");
    setNotice("");
    try {
      const current = await saveLocalExport({ revision: snapshot.revision, root: value.trim() });
      setSnapshot(current);
      setValue(current.root);
      setNotice(current.enabled ? "本地导出根目录已保存；之后提交的 core.code 导出步骤会写入该目录。" : "本地导出已关闭；启用导出的步骤会明确失败，不会写入任何文件。");
    } catch (reason) {
      // The server may already have committed. Disable writes until the operator explicitly reconciles.
      setNeedsReconcile(true);
      setError((reason instanceof Error ? reason.message : "保存回执未知") + "。请先重新读取配置核对，不要重复提交旧请求。");
    } finally { setSaving(false); }
  }
  const busy = loading || saving;
  const invalid = localExportRootError(value);
  const mb = (bytes: number) => Math.round(bytes / 1024 / 1024);
  return (
    <form className="connection-settings" onSubmit={save}>
      <div className="connection-section-heading"><div><span className="section-index">05</span><div><h2>本地导出</h2><p>允许自定义代码步骤把已归档媒体写入本机受控目录，管理员配置</p></div></div><button type="button" className="button button-outline" onClick={() => void read()} disabled={busy}><RefreshCw size={14} />重新读取配置</button></div>
      <div className="connection-fields single-field">
        <div className="field-group">
          <label className="field-label" htmlFor="local-export-root">导出根目录</label>
          <input id="local-export-root" className="text-input" type="text" value={value} placeholder="E:\AI-outsourcing\二次元抱枕" onChange={event => setValue(event.target.value)} disabled={busy || !snapshot || needsReconcile} />
          <small className="field-help">填写本机绝对路径，不能是盘符根目录；保存时会真实创建目录并写入探测，不可写会直接报错。留空表示关闭本地导出。</small>
          <small className="field-help"><FolderOutput size={13} /> 隔离沙箱仍然没有文件系统访问：自定义代码只返回 <code>{'{items:[{source,target}]}'}</code> 计划，写盘由宿主在沙箱之外完成，且 target 归一化后必须落在此根目录内，<code>..</code> 逃逸会被拒绝而不是被改写。</small>
          <small className="field-help">只有 <code>core.code</code> 步骤显式配置 <code>localExport</code> 时才会落盘；配置、校验和预检都不写文件。</small>
          {snapshot && <small className="field-help">服务端快照：revision {snapshot.revision} · {snapshot.enabled ? "已启用" : "已关闭"} · 来源 {snapshot.source === "saved" ? "已保存到系统数据库" : snapshot.source === "environment" ? "环境默认值" : "尚未配置"} · 上限 {snapshot.limits.files} 个文件 / 单文件 {mb(snapshot.limits.fileBytes)} MB / 合计 {mb(snapshot.limits.totalBytes)} MB。</small>}
        </div>
      </div>
      {invalid && <div className="notice error-notice"><X size={15} />{invalid}</div>}
      {notice && <div className="notice success-notice"><Check size={15} />{notice}</div>}
      {error && <div className="notice error-notice"><X size={15} />{error}</div>}
      <div className="connection-form-footer"><span>跨重启保存；根目录只授权给本地导出，不改变沙箱隔离与其他步骤行为。</span><button className="button button-dark" type="submit" disabled={busy || !snapshot || needsReconcile || Boolean(invalid)}>{saving ? <LoaderCircle className="spin" size={15} /> : <Save size={15} />}{saving ? "保存中…" : "保存本地导出"}</button></div>
    </form>
  );
}
