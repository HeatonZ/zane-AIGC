import { Check, ChevronDown, CircleHelp, ExternalLink, FolderOpen, LoaderCircle, Save, ServerCog, ShieldCheck, Unplug, X } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";
import { loadConnectionSettings, loadHermesProfiles, saveConnectionSettings } from "../lib/api";
import type { ConnectionSettings, ConnectorState, HermesProfile } from "../types";

interface ConnectionsProps {
  connectors: ConnectorState[];
  onRefresh: (enabledHermesProfiles?: string[]) => Promise<ConnectorState[]>;
}

const initialSettings: ConnectionSettings = {
  enabledHermesProfiles: ["default"],
  comfyuiBaseUrl: "http://127.0.0.1:8188",
  projectDirectory: "",
};

export default function Connections({ connectors, onRefresh }: ConnectionsProps) {
  const [settings, setSettings] = useState(initialSettings);
  const [profiles, setProfiles] = useState<HermesProfile[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [checking, setChecking] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    Promise.all([loadConnectionSettings(), loadHermesProfiles()])
      .then(([savedSettings, foundProfiles]) => {
        setSettings(savedSettings);
        setProfiles(foundProfiles);
      })
      .catch((reason: unknown) => setError(reason instanceof Error ? reason.message : "无法读取本地集成设置"))
      .finally(() => setLoading(false));
  }, []);

  function toggleProfile(profileId: string) {
    const selected = new Set(settings.enabledHermesProfiles);
    if (selected.has(profileId)) selected.delete(profileId);
    else selected.add(profileId);
    setSettings({ ...settings, enabledHermesProfiles: profiles.map((profile) => profile.id).filter((id) => selected.has(id)) });
  }

  async function save(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    setError("");
    setNotice("");
    try {
      const updated = await saveConnectionSettings({
        enabledHermesProfiles: settings.enabledHermesProfiles,
        comfyuiBaseUrl: settings.comfyuiBaseUrl,
        projectDirectory: settings.projectDirectory,
      });
      setSettings(updated);
      setNotice("集成设置和项目目录已保存。");
      await onRefresh(updated.enabledHermesProfiles);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "保存失败，请检查本地 API 服务。 ");
    } finally {
      setSaving(false);
    }
  }

  async function check() {
    setChecking(true);
    setError("");
    setNotice("");
    try {
      await onRefresh(settings.enabledHermesProfiles);
      setNotice("连接检查完成。");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "连接检查失败。");
    } finally {
      setChecking(false);
    }
  }

  const hermes = connectors.find((item) => item.id === "hermes");
  const comfyui = connectors.find((item) => item.id === "comfyui");

  return (
    <div className="connections-page">
      <div className="welcome-row">
        <div><div className="eyebrow"><span className="eyebrow-line" />LOCAL SERVICES</div><h1>集成连接</h1><p className="page-subtitle">连接本机的智能体与生成服务。</p></div>
        <button className="button button-outline" onClick={check} disabled={checking || loading}><LoaderCircle className={checking ? "spin" : ""} size={15} />检测连接</button>
      </div>

      <div className="connection-overview">
        <div className="connection-overview-icon"><ServerCog size={19} /></div>
        <div><strong>本机服务</strong><span>Hermes 使用本机 CLI 与多 Profile Gateway</span></div>
        <div className="overview-secure"><ShieldCheck size={14} />仅本机</div>
      </div>

      <form className="connection-settings" onSubmit={save}>
        <div className="connection-section-heading"><div><span className="section-index">01</span><div><h2>Hermes Agent</h2><p>选择本机安装的 Profile，可同时启用多个</p></div></div><StatusText state={hermes} /></div>
        <div className="profile-picker-heading">
          <span>已发现 {profiles.length} 个 Profile</span>
          <div>
            <button type="button" onClick={() => setSettings({ ...settings, enabledHermesProfiles: profiles.map((profile) => profile.id) })} disabled={loading || profiles.length === 0}>全选</button>
            <i />
            <button type="button" onClick={() => setSettings({ ...settings, enabledHermesProfiles: [] })} disabled={loading}>清空</button>
          </div>
        </div>
        {profiles.length ? <div className="profile-grid">{profiles.map((profile) => {
          const selected = settings.enabledHermesProfiles.includes(profile.id);
          return <label className={`profile-choice ${selected ? "selected" : ""}`} key={profile.id}>
            <input type="checkbox" checked={selected} onChange={() => toggleProfile(profile.id)} disabled={loading} />
            <span className="profile-check"><Check size={12} /></span>
            <span className="profile-choice-name">{profile.id}</span>
            {profile.isDefault && <span className="profile-default">默认</span>}
            <ChevronDown className="profile-choice-chevron" size={13} />
          </label>;
        })}</div> : <div className="no-profiles"><CircleHelp size={16} />没有发现 Hermes Profile，请确认本机 Hermes 安装与 HERMES_HOME。</div>}
        <small className="field-help profile-help">运行任务时将以对应的 <code>hermes -p Profile</code> 隔离上下文。选择列表保存在本机工作区。</small>

        <div className="connection-section-heading comfy-heading"><div><span className="section-index coral-index">02</span><div><h2>ComfyUI</h2><p>提交工作流并生成图像与视频</p></div></div><StatusText state={comfyui} /></div>
        <div className="connection-fields single-field">
          <div className="field-group">
            <label className="field-label" htmlFor="comfyui-url">服务地址</label>
            <input id="comfyui-url" className="text-input mono-input" value={settings.comfyuiBaseUrl} onChange={(event) => setSettings({ ...settings, comfyuiBaseUrl: event.target.value })} disabled={loading} placeholder="http://127.0.0.1:8188" />
            <small className="field-help">检查 ComfyUI 的 /system_stats 接口；默认端口为 8188。</small>
          </div>
        </div>

        <div className="connection-section-heading comfy-heading"><div><span className="section-index">03</span><div><h2>项目目录</h2><p>保存运行输入、结果和执行状态</p></div></div><FolderOpen size={17} className="project-directory-icon" /></div>
        <div className="connection-fields single-field project-directory-fields">
          <div className="field-group">
            <label className="field-label" htmlFor="project-directory">项目根目录</label>
            <input id="project-directory" className="text-input mono-input" value={settings.projectDirectory} onChange={(event) => setSettings({ ...settings, projectDirectory: event.target.value })} disabled={loading} placeholder="例如 F:/projects/my-drama" />
            <small className="field-help">填写本机的绝对路径。保存时会创建目录并检查写入权限；运行时会写入 <code>.zane/runs/&lt;运行 ID&gt;</code>。</small>
            <small className="field-help project-layout-help">每次运行包含 <code>inputs/input.json</code>、<code>workflow.json</code>、<code>runtime.json</code> 和 <code>outputs/result.json</code>；生成媒体放在 <code>outputs/media</code>。</small>
          </div>
        </div>

        {notice && <div className="notice success-notice"><Check size={15} />{notice}</div>}
        {error && <div className="notice error-notice"><X size={15} />{error}</div>}
        <div className="connection-form-footer">
          <span><CircleHelp size={14} />连接检查会从本地 API 发起。</span>
          <button className="button button-dark" type="submit" disabled={saving || loading}><Save size={15} />{saving ? "保存中…" : "保存连接"}</button>
        </div>
      </form>

      <div className="connection-footnote"><Unplug size={15} /><span>Profile 由 Hermes CLI 管理。步骤可以单独指定 Hermes Profile；ComfyUI 仍使用原生 HTTP API。</span><a href="https://docs.comfy.org/" target="_blank" rel="noreferrer" aria-label="ComfyUI 文档"><ExternalLink size={14} /></a></div>
    </div>
  );
}

function StatusText({ state }: { state?: ConnectorState }) {
  if (!state) return <span className="status-text pending-status"><span />尚未检查</span>;
  const connected = state.status === "connected";
  const missing = state.status === "not_configured";
  return <span className={`status-text ${connected ? "connected-status" : missing ? "pending-status" : "offline-status"}`}><span />{connected ? state.message : missing ? state.message : state.message}</span>;
}
