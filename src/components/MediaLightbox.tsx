import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { accessMedia } from "../lib/accessApi";
import MediaDownloadButton from "./MediaDownloadButton";

/**
 * 原图查看：画布上的图是 w=512 预览（省流量），但客户需要确认真实分辨率，
 * 所以这里必须按**原始字节**读取，绕开预览缩放参数，
 * 并显示这张图真实的像素尺寸 + 下载入口。
 */
export function MediaLightbox({ url, kind = "image", label, onClose }: {
  url: string;
  kind?: "image" | "video";
  label: string;
  onClose: () => void;
}) {
  const [source, setSource] = useState("");
  const [error, setError] = useState("");
  const [dimensions, setDimensions] = useState<{ width: number; height: number }>();
  const [bytes, setBytes] = useState<number>();

  useEffect(() => {
    const controller = new AbortController();
    let objectUrl = "";
    // 直接读原始地址：预览派生会给图片加 w=512，原图查看必须绕开它。
    accessMedia(url, undefined, controller.signal)
      .then(blob => {
        if (controller.signal.aborted) return;
        objectUrl = URL.createObjectURL(blob);
        setBytes(blob.size);
        setSource(objectUrl);
      })
      .catch(reason => { if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : "原图读取失败"); });
    return () => { controller.abort(); if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [url]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const sizeLabel = dimensions ? `${dimensions.width} × ${dimensions.height}` : null;

  return createPortal(
    <div className="imglb" role="dialog" aria-modal="true" aria-label={label} onClick={onClose}>
      <header className="imglb-bar" onClick={event => event.stopPropagation()}>
        <div className="imglb-meta">
          <strong>{label || "原图"}</strong>
          {/* 尺寸与体积是客户确认「不是 512」的依据，读不到时明确说「读取中」而不是留空。 */}
          <span>{sizeLabel ?? "正在读取尺寸…"}{bytes ? ` · ${formatBytes(bytes)}` : ""}</span>
        </div>
        <div className="imglb-actions">
          <MediaDownloadButton url={url} kind={kind} fallback={label || "原图"} className="imglb-action" />
          <button type="button" className="imglb-action" onClick={onClose} aria-label="关闭原图"><X size={15} />关闭</button>
        </div>
      </header>
      <div className="imglb-stage" onClick={event => event.stopPropagation()}>
        {error
          ? <div className="imglb-error">{error}</div>
          : !source
            ? <div className="imglb-error">正在读取原图…</div>
            : kind === "video"
              ? <video src={source} controls playsInline autoPlay />
              : <img src={source} alt={label}
                  onLoad={event => {
                    const image = event.currentTarget;
                    setDimensions({ width: image.naturalWidth, height: image.naturalHeight });
                  }} />}
      </div>
      <p className="imglb-hint" onClick={event => event.stopPropagation()}>点击空白处或按 Esc 关闭 · 右上角可下载原图</p>
    </div>,
    document.body,
  );
}

function formatBytes(value: number) {
  if (value < 1024) return value + " B";
  if (value < 1024 * 1024) return (value / 1024).toFixed(0) + " KB";
  return (value / 1024 / 1024).toFixed(1) + " MB";
}

/** 是图片就允许放大看原图；视频本身有控件，不需要这一层。 */
export function isZoomableImage(kind: "image" | "video") {
  return kind === "image";
}
