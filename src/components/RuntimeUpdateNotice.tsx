import { useEffect, useState } from "react";
import { currentActorId } from "../lib/accessApi";

export function isNewWorkbenchRelease(current: string, received: unknown) {
  // Without a version baked into the client we cannot tell whether the API is newer.
  // Treating "unversioned" as an old build causes a permanent false-positive notice.
  return Boolean(current !== "unversioned" && received && typeof received === "object" && "releaseId" in received && typeof received.releaseId === "string" && received.releaseId !== "unversioned" && received.releaseId !== current);
}
/**
 * The public user entry rejects administrator credentials with 403 PUBLIC_USER_ONLY.
 * That answer is final for the current identity — retrying every 15 seconds only fills
 * the log window with the same refusal — but a different login on the same tab may be
 * accepted, so the rejection is scoped to the actor that received it.
 */
export function shouldPollRelease(actorId: string, rejectedActorId: string) {
  return Boolean(actorId) && actorId !== rejectedActorId;
}
export default function RuntimeUpdateNotice() {
  const [available, setAvailable] = useState(false);
  useEffect(() => {
    let disposed=false, pending=false, rejectedActor="";
    const controller=new AbortController();
    const poll=async()=>{
      const actor=currentActorId;
      if (pending || !shouldPollRelease(actor, rejectedActor) || document.visibilityState === "hidden") return;
      pending=true;
      try {
        const response=await fetch("/api/v1/self/runtime-release",{credentials:"same-origin",cache:"no-store",headers:{"X-Zane-Actor":actor},signal:controller.signal});
        if (response.status === 403) {
          const body=await response.json().catch(()=>undefined) as {code?: string}|undefined;
          if (body?.code === "PUBLIC_USER_ONLY") rejectedActor=actor;
          return;
        }
        if (!response.ok) return;
        const data=await response.json();
        if (!disposed) setAvailable(isNewWorkbenchRelease(typeof __WORKBENCH_RELEASE__ === "string" ? __WORKBENCH_RELEASE__ : "unversioned",data));
      } catch { /* Upgrade outage/offline never logs out, replays writes or reloads the page. */ }
      finally { pending=false; }
    };
    void poll(); const timer=window.setInterval(()=>void poll(),15000);
    return ()=>{disposed=true;controller.abort();window.clearInterval(timer);};
  },[]);
  if (!available) return null;
  return <aside className="runtime-update-notice" role="status"><strong>工作台新版本已就绪</strong><span>请先确认当前编辑已保存，再刷新页面使用新版本。不会自动刷新或恢复防丢草稿。</span><button type="button" onClick={()=>window.location.reload()}>我已确认保存，刷新</button></aside>;
}
