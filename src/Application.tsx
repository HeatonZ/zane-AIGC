import { Suspense, lazy, useEffect, useState } from "react";
import App from "./App";
const UserPortal = lazy(() => import("./features/UserPortal"));
import ErrorBoundary from "./components/ErrorBoundary";
import { accessApi, jsonBody, setCurrentActor, type Account } from "./lib/accessApi";
import { CdkLogin } from "./components/CdkLogin";

export default function Application() {
  const [publicOnly, setPublicOnly] = useState(false);
  const [user, setUser] = useState<Account>();
  const [initialized, setInitialized] = useState<boolean>();
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [username, setUsername] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [setupId] = useState(() => crypto.randomUUID());
  const [mode, setMode] = useState<"admin" | "user">("admin");
  const [cdkAvailable, setCdkAvailable] = useState(false);
  // 卡密绑定的服务：登录后直接进入，不再让用户挑选。
  const [entryPackageId, setEntryPackageId] = useState<string | undefined>();

  function accept(account: Account) {
    const mode = account.role === "admin" && window.location.pathname !== "/app" ? "admin" : "user";
    setError(""); setCurrentActor(account.id); setUser(account); setMode(mode);
    window.history.replaceState(null, "", mode === "admin" ? "/admin" : "/app");
  }

  // 会话恢复：hash 里带着绑定服务时继续直达（刷新不丢）。
  useEffect(() => {
    const match = /(?:^#|&)service=([^&]+)/.exec(window.location.hash);
    if (match) setEntryPackageId(decodeURIComponent(match[1]));
  }, []);

  useEffect(() => {
    let stopped = false;
    setCurrentActor("");
    void (async () => {
      try {
        const status = await accessApi<{ initialized: boolean; entryMode?: "full" | "user-only"; cdkLogin?: boolean }>("/api/auth/status");
        if (stopped) return;
        setInitialized(status.initialized);
        setPublicOnly(status.entryMode === "user-only");
        setCdkAvailable(Boolean(status.cdkLogin));
        if (status.initialized) {
          try { const result = await accessApi<{ user: Account }>("/api/v1/self/account"); if (!stopped) accept(result.user); }
          catch (e) { if (!stopped && (e as { status?: number }).status !== 401) setError((e as Error).message); }
        }
      } catch (e) { if (!stopped) setError((e as Error).message); }
      finally { if (!stopped) setLoading(false); }
    })();
    const invalid = () => { setUser(undefined); setCurrentActor(""); setPassword(""); setInitialized(true); };
    window.addEventListener("zane-auth-required", invalid);
    return () => { stopped = true; window.removeEventListener("zane-auth-required", invalid); };
  }, []);

  async function login() {
    setBusy(true); setError("");
    try {
      const result = await accessApi<{ user: Account }>(initialized ? "/api/auth/login" : "/api/auth/setup", jsonBody(initialized ? { username, password } : { userId: setupId, username, displayName, password, role: "admin" }));
      setPassword(""); setInitialized(true); accept(result.user);
    } catch (e) { setError((e as Error).message + (!initialized ? "；若首次初始化回执丢失，请改为登录，不要重复创建。" : "")); }
    finally { setBusy(false); }
  }

  async function logout() {
    try {
      await accessApi("/api/v1/self/logout", jsonBody({}));
      setUser(undefined); setCurrentActor(""); setPassword("");
      window.history.replaceState(null, "", publicOnly ? "/app" : "/");
    } catch (e) { setError((e as Error).message); }
  }

  if (loading) return <div className="studio-app studio-app-centered"><div className="studio-muted">正在连接…</div></div>;

  if (user) return <>
    {error && <p role="alert" className="studio-notice" data-tone="bad">{error}</p>}
    {user.role === "admin" && mode === "admin"
      ? <ErrorBoundary label="管理后台"><App key={user.id} userId={user.id} displayName={user.displayName} onLogout={() => void logout()} onOpenUserView={() => { setMode("user"); window.history.replaceState(null, "", "/app"); }} /></ErrorBoundary>
      : <ErrorBoundary label="用户工作台">
          <Suspense fallback={<div className="studio-app studio-app-centered"><div className="studio-muted">正在加载…</div></div>}>
            <UserPortal key={user.id} user={user} entryPackageId={entryPackageId} onLogout={() => void logout()} onAdmin={user.role === "admin" && !publicOnly ? () => { setMode("admin"); window.history.replaceState(null, "", "/admin"); } : undefined} />
          </Suspense>
        </ErrorBoundary>}
  </>;

  // ── 公网用户入口：只有卡密。不提供账号密码、注册、初始化或任何管理入口。 ──
  if (publicOnly) {
    if (initialized === false) return <div className="studio-app studio-app-centered">
      <div className="cdk-gate"><h1>服务尚未开放</h1><p className="studio-muted">请联系管理员完成配置。</p>{error && <p className="studio-notice" data-tone="bad">{error}</p>}</div>
    </div>;
    if (cdkAvailable) return <div className="studio-app studio-app-centered">
      <CdkLogin onSuccess={(account, packageId) => { setError(""); setEntryPackageId(packageId); accept(account); }} />
    </div>;
    return <div className="studio-app studio-app-centered">
      <div className="cdk-gate"><h1>入口暂未开放</h1><p className="studio-muted">请联系管理员获取使用凭证。</p>
        {error && <p className="studio-notice" data-tone="bad">{error}</p>}
      </div>
    </div>;
  }

  // ── 私有管理入口：仅管理员，账号密码。此入口不面向最终用户。 ──
  return <div className="studio-app studio-app-centered">
    <form className="cdk-gate" onSubmit={event => { event.preventDefault(); void login(); }}>
      <div className="cdk-brand"><span className="cdk-brand-mark">Z</span><span>Zane Studio 管理端</span></div>
      <h1>{initialized === false ? "初始化管理员" : "登录"}</h1>
      {initialized === false && <p className="studio-muted">在服务器本机创建首个管理员。</p>}
      {error && <p className="studio-notice" data-tone="bad" role="alert">{error}</p>}
      <label className="cdk-field"><span>登录名</span>
        <input className="svc-input" autoComplete="username" value={username} onChange={event => setUsername(event.target.value)} required />
      </label>
      {initialized === false && <label className="cdk-field"><span>显示名</span>
        <input className="svc-input" value={displayName} onChange={event => setDisplayName(event.target.value)} required />
      </label>}
      <label className="cdk-field"><span>密码</span>
        <input className="svc-input" type="password" autoComplete={initialized ? "current-password" : "new-password"} value={password} onChange={event => setPassword(event.target.value)} minLength={initialized ? 1 : 10} required />
      </label>
      <button className="svc-cta" style={{ width: "100%" }} disabled={busy || initialized === undefined}>{busy ? "处理中…" : initialized === false ? "创建管理员" : "登录"}</button>
    </form>
  </div>;
}
