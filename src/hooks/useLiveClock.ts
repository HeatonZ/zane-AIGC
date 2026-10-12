import { useEffect, useState } from "react";

/** 运行计时的秒级心跳。仅在 active 为真且页面可见时走表；隐藏时暂停，
 *  恢复可见后立即补一次，避免后台标签页的无谓重渲染。 */
export function useLiveClock(active: boolean, intervalMs = 1000) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!active) return;
    let timer: number | undefined;
    const start = () => { if (timer === undefined) timer = window.setInterval(() => setNow(Date.now()), intervalMs); };
    const stop = () => { if (timer !== undefined) { window.clearInterval(timer); timer = undefined; } };
    const sync = () => {
      if (document.hidden) stop();
      else { setNow(Date.now()); start(); }
    };
    sync();
    document.addEventListener("visibilitychange", sync);
    return () => { stop(); document.removeEventListener("visibilitychange", sync); };
  }, [active, intervalMs]);
  return now;
}
