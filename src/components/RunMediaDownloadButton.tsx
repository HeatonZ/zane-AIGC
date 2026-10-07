import { Download } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { accessApi } from "../lib/accessApi";
import type { RunMediaExport } from "../../server/domain/runMediaExportContracts";

/** Generic media export; no scene-name switch or local business state. */
export default function RunMediaDownloadButton({ runId, outputKey, stepId, own = false, userId }: { runId: string; outputKey: string; stepId?: string; own?: boolean; userId?: string }) {
  const [busy, setBusy] = useState(false); const [error, setError] = useState(""); const [prepared, setPrepared] = useState<RunMediaExport>();
  const sequence = useRef(0);
  useEffect(() => { sequence.current++; setPrepared(undefined); setError(""); setBusy(false); return () => { sequence.current++; }; }, [runId, outputKey, stepId, own, userId]);
  const prepare = async () => {
    const current = ++sequence.current; setBusy(true); setError(""); setPrepared(undefined);
    const params = new URLSearchParams({ outputKey, ...(stepId ? { stepId } : {}) });
    try {
      const prefix = "/api/v1/" + (own ? "self/" : "") + "runs/" + encodeURIComponent(runId);
      const result = await accessApi<RunMediaExport>(prefix + "/media-export?" + params, {}, userId);
      if (!result.downloadUrl.startsWith(prefix + "/media.zip?")) throw new Error("导出下载地址不属于当前运行");
      if (sequence.current === current) setPrepared(result);
    } catch (failure) { if (sequence.current === current) setError(failure instanceof Error ? failure.message : "导出信息读取失败"); }
    finally { if (sequence.current === current) setBusy(false); }
  };
  return <span className="run-media-download">
    {prepared ? <a className="button button-outline" href={prepared.downloadUrl} download><Download size={14} />下载 {prepared.fileCount} 项媒体{prepared.incomplete ? "（不完整）" : ""}</a> : <button className="button button-outline" disabled={busy} onClick={() => void prepare()}><Download size={14} />{busy ? "正在核对归档…" : "打包下载媒体"}</button>}
    {prepared && <button className="run-icon-button" onClick={() => void prepare()} disabled={busy}>重新核对</button>}
    {error && <span role="alert" className="access-error">{error}</span>}
  </span>;
}
