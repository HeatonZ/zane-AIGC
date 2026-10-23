import { useState } from "react";
import { Maximize2 } from "lucide-react";
import { useProtectedMedia } from "../lib/mediaPreview";
import { MediaLightbox } from "./MediaLightbox";

/**
 * 单张图/视频缩略图，按需加载（进入视口才取字节）。
 * 视觉作用域由调用方决定：管理端 studio-shot、客户端 zclient-shot，
 * 否则客户端会引用到只存在于管理端样式里的类名，缩略图退化成无样式方块。
 *
 * zoomable：图片可点击查看原图（原始字节 + 真实像素尺寸）。画布上的图是 512 预览，
 * 不提供这个入口时客户会以为成品就是 512。
 */
export function RecentShot({ url, kind, label, className = "studio-shot", zoomable = false }: {
  url: string; kind: "image" | "video"; label: string; className?: string; zoomable?: boolean;
}) {
  const media = useProtectedMedia(url, kind);
  const [zoom, setZoom] = useState(false);
  const canZoom = zoomable && kind === "image" && Boolean(media.source);
  return <>
    <figure className={className} ref={node => media.holder(node)}>
      {media.error
        ? <div className={`${className}-fallback`} onClick={media.retry} role="button" tabIndex={0}>{media.error}</div>
        : kind === "video"
          ? <video src={media.source || undefined} muted playsInline preload="metadata" />
          : <img src={media.source || undefined} alt={label} loading="lazy"
              role={canZoom ? "button" : undefined}
              tabIndex={canZoom ? 0 : undefined}
              title={canZoom ? "点击查看原图（原始分辨率）" : undefined}
              onClick={() => { if (canZoom) setZoom(true); }}
              onKeyDown={event => { if (canZoom && (event.key === "Enter" || event.key === " ")) { event.preventDefault(); setZoom(true); } }} />}
      {/* 这里刻意不显示像素尺寸：画布上加载的是 512 预览，读到的自然是预览尺寸，
          写出来会让人以为成品就是 512。真实尺寸在点开的原图里显示。 */}
      {canZoom && <span className={`${className}-zoom`} aria-hidden="true"><Maximize2 size={12} />看原图</span>}
      <figcaption className={`${className}-caption`}>{label}</figcaption>
    </figure>
    {zoom && <MediaLightbox url={url} kind="image" label={label} onClose={() => setZoom(false)} />}
  </>;
}
