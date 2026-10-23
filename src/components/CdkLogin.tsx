import { useState } from "react";
import { accessApi, jsonBody, type Account } from "../lib/accessApi";

/**
 * 卡密入口：打开页面就是这一步。
 * 先只读校验（告诉用户这是新卡还是老卡），再登录；新卡会自动开账户并充值。
 */
export function CdkLogin({ onSuccess }: { onSuccess: (account: Account, packageId?: string) => void }) {
  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [inspect, setInspect] = useState<{ known: boolean; faceValue: number; packageId?: string } | null>(null);

  const normalized = code.replace(/[\s-]/g, "").toUpperCase();

  async function check() {
    if (!normalized) return;
    setBusy(true); setError("");
    try {
      const result = await accessApi<{ known: boolean; faceValue: number; packageId?: string }>("/api/auth/cdk/inspect", jsonBody({ code }));
      setInspect(result);
    } catch (e) { setInspect(null); setError((e as Error).message); }
    finally { setBusy(false); }
  }

  async function enter() {
    if (!normalized) return;
    setBusy(true); setError("");
    try {
      const result = await accessApi<{ user: Account; packageId?: string }>("/api/auth/cdk/login", jsonBody({ code, ...(name.trim() ? { displayName: name.trim() } : {}) }));
      onSuccess(result.user, result.packageId ?? inspect?.packageId);
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }

  return <div className="cdk-gate">
    <div className="cdk-brand"><span className="cdk-brand-mark">Z</span><span>Zane Studio</span></div>
    <h1>输入卡密开始创作</h1>
    <p className="studio-muted">
      {inspect ? (inspect.known ? "欢迎回来，这张卡会回到你原来的项目。" : "新卡，将为你开通账户并充值 " + inspect.faceValue + " 积分。")
        : "用管理员发给你的卡密进入，无需注册账号。"}
    </p>
    {error && <p className="studio-notice" data-tone="bad" role="alert">{error}</p>}
    <form onSubmit={event => { event.preventDefault(); void (inspect ? enter() : check()); }}>
      <input
        className="cdk-input"
        value={code}
        onChange={event => { setCode(event.target.value); setInspect(null); }}
        placeholder="XXXXX-XXXXX-XXXXX-XXXXX"
        aria-label="卡密"
        autoComplete="off"
        autoFocus
        spellCheck={false}
      />
      {inspect && !inspect.known && <label className="cdk-field">
        <span>怎么称呼你（可选）</span>
        <input className="svc-input" value={name} onChange={event => setName(event.target.value)} placeholder="留空也可以" maxLength={40} />
      </label>}
      <button className="svc-cta cdk-submit" type="submit" disabled={busy || !normalized}>
        {busy ? "处理中…" : inspect ? (inspect.known ? "进入" : "开通并进入") : "继续"}
      </button>
      {inspect && <button type="button" className="studio-btn studio-btn-ghost cdk-back" onClick={() => { setInspect(null); setError(""); }}>换一张卡</button>}
    </form>
    <p className="cdk-hint">卡密就是你的账号：同一张卡再次进入，余额与历史都会保留。请妥善保管。</p>
  </div>;
}
