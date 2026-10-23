import { Download } from "lucide-react";
import { useState } from "react";
import { mediaDownloadName, mediaExtensionForMime } from "../lib/runMedia";

function sameOrigin(url: string) {
  if (typeof window === "undefined") return url.startsWith("/");
  try { return new URL(url, window.location.href).origin === window.location.origin; } catch { return false; }
}

/** 单个媒体文件的下载按钮。
 *
 *  运行归档、output-media、local-media 都是需要鉴权的同源地址，普通 <a download> 会带上
 *  会话 Cookie，视频还能由浏览器边下边写盘，所以文件名带扩展名时直接走链接。
 *  只有运行记录里给不出带扩展名的文件名时（固定素材展示名常是「猫主角米酒_四视图_V4」），
 *  才先 HEAD 一次拿 Content-Type 补扩展名——否则存下来的是没有后缀、打不开的文件。 */
export default function MediaDownloadButton({ url, filename, kind, fallback, index = 0, className = "run-icon-button" }: {
  url: string;
  filename?: string;
  kind: "image" | "video" | "audio";
  fallback: string;
  index?: number;
  className?: string;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const resolved = mediaDownloadName({ url, filename }, fallback, index);
  const external = !sameOrigin(url);
  async function download(event: React.MouseEvent<HTMLAnchorElement>) {
    // 跨域地址读不到响应头（CORS），download 属性也不生效，交给浏览器直接打开。
    if (resolved.extension || external) return;
    event.preventDefault();
    setBusy(true); setError("");
    try {
      const response = await fetch(url, { method: "HEAD", credentials: "same-origin" });
      if (!response.ok) throw new Error(`读取文件类型失败（${response.status}）`);
      const name = resolved.name + mediaExtensionForMime(response.headers.get("Content-Type") ?? "", kind);
      const anchor = document.createElement("a");
      anchor.href = url; anchor.download = name; anchor.rel = "noreferrer";
      document.body.append(anchor); anchor.click(); anchor.remove();
    } catch (failure) { setError(failure instanceof Error ? failure.message : "下载失败"); }
    finally { setBusy(false); }
  }
  return <>
    <a className={className} href={url} download={resolved.name} target={external ? "_blank" : undefined}
      rel={external ? "noreferrer" : undefined} aria-busy={busy} title={busy ? "正在读取文件类型…" : `下载 ${filename || fallback}`}
      onClick={(event) => void download(event)}>
      <Download size={14} />{busy ? "准备下载…" : "下载"}
    </a>
    {error && <span role="alert" className="access-error">{error}</span>}
  </>;
}
