import { useEffect, useRef, useState } from "react";
import { FileImage, Film, LoaderCircle, Music2, Trash2, Upload } from "lucide-react";
import { accessMedia } from "../lib/accessApi";

export type UserMediaKind = "image" | "video" | "audio";

const acceptByKind: Record<UserMediaKind, string> = {
  image: "image/*",
  video: "video/*",
  audio: "audio/*",
};

const hintByKind: Record<UserMediaKind, string> = {
  image: "PNG、JPG、WEBP 等图片",
  video: "MP4、MOV 等视频",
  audio: "MP3、WAV 等音频",
};

function mediaUrl(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const reference = value as Record<string, unknown>;
  if (typeof reference.assetId !== "string" || !reference.assetId
    || !Number.isSafeInteger(reference.assetVersion) || Number(reference.assetVersion) < 1) return undefined;
  return `/api/v1/assets/${encodeURIComponent(reference.assetId)}/versions/${reference.assetVersion}/media`;
}

function mediaName(value: unknown, kind: UserMediaKind, index: number): string {
  if (typeof value === "string" && value.trim()) return value;
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const reference = value as Record<string, unknown>;
    if (typeof reference.assetName === "string" && reference.assetName) return reference.assetName;
    if (typeof reference.filename === "string" && reference.filename) return reference.filename;
  }
  return `已上传${kind === "image" ? "图片" : kind === "video" ? "视频" : "音频"} ${index + 1}`;
}

export function ProtectedMediaPreview({ url, kind, userId, label }: { url?: string; kind: UserMediaKind; userId: string; label: string }) {
  const [source, setSource] = useState("");
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    let objectUrl = "";
    setSource("");
    setError("");
    if (url) {
      void accessMedia(url, userId, controller.signal).then(blob => {
        if (!blob.type.toLowerCase().startsWith(`${kind}/`)) throw new Error("返回内容不是可预览的媒体文件");
        if (controller.signal.aborted) return;
        objectUrl = URL.createObjectURL(blob);
        setSource(objectUrl);
      }).catch(reason => {
        if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : "媒体预览读取失败");
      });
    }
    return () => {
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [url, kind, userId, attempt]);

  if (source && kind === "image") return <a className="user-media-preview-link" href={source} target="_blank" rel="noreferrer"><img src={source} alt={label} /></a>;
  if (source && kind === "video") return <video src={source} controls preload="metadata" aria-label={label} />;
  if (source && kind === "audio") return <audio src={source} controls preload="metadata" aria-label={label} />;
  const Icon = kind === "image" ? FileImage : kind === "video" ? Film : Music2;
  return <div className={`user-media-preview-placeholder${error ? " has-error" : ""}`} role="status">
    {error ? <><Icon size={24} /><span>预览暂不可用</span><button type="button" onClick={() => setAttempt(value => value + 1)}>重试</button></>
      : url ? <><LoaderCircle className="spin" size={22} /><span>正在读取预览…</span></>
        : <><Icon size={24} /><span>此素材暂无预览</span></>}
  </div>;
}

export default function UserMediaInput({ label, kind, multiple, value, userId, disabled, uploading, onUpload, onRemove, onClear }: {
  label: string;
  kind: UserMediaKind;
  multiple: boolean;
  value: unknown;
  userId: string;
  disabled: boolean;
  uploading: boolean;
  onUpload: (file: File) => void;
  onRemove: (index: number) => void;
  onClear: () => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const items = Array.isArray(value) ? value : value === undefined || value === null || value === "" ? [] : [value];
  const primaryLabel = kind === "image" ? "图片" : kind === "video" ? "视频" : "音频";

  return <div className="user-media-uploader">
    <input ref={inputRef} className="user-media-file-input" type="file" accept={acceptByKind[kind]} disabled={disabled} aria-label={`选择${label}`} onChange={event => {
      const file = event.target.files?.[0];
      event.target.value = "";
      if (file) onUpload(file);
    }} />
    <div className="user-media-picker-row">
      <div className="user-media-picker-copy">
        <span className="user-media-picker-icon">{uploading ? <LoaderCircle className="spin" size={19} /> : <Upload size={19} />}</span>
        <span><strong>{uploading ? `正在上传${primaryLabel}…` : items.length ? multiple ? `继续添加${primaryLabel}` : `更换${primaryLabel}` : `上传${primaryLabel}`}</strong><small>{hintByKind[kind]} · 上传后自动保存到素材并显示预览</small></span>
      </div>
      <button className="button button-outline user-media-browse" type="button" disabled={disabled} onClick={() => inputRef.current?.click()}>{uploading ? "上传中" : "选择文件"}</button>
    </div>
    {items.length > 0 && <div className="user-media-gallery">
      {items.map((item, index) => {
        const name = mediaName(item, kind, index);
        const version = item && typeof item === "object" && !Array.isArray(item) ? (item as Record<string, unknown>).assetVersion : undefined;
        return <article className="user-media-card" key={`${name}-${index}`}>
          <div className={`user-media-preview user-media-preview-${kind}`}>
            <ProtectedMediaPreview url={mediaUrl(item)} kind={kind} userId={userId} label={name} />
          </div>
          <div className="user-media-card-meta"><span><strong title={name}>{name}</strong><small>{primaryLabel}{Number.isSafeInteger(version) ? ` · 固定版本 v${version}` : ""}</small></span>
            <button type="button" className="user-media-remove" disabled={disabled} aria-label={`移除${name}`} title={`移除${name}`} onClick={() => onRemove(index)}><Trash2 size={15} /></button>
          </div>
        </article>;
      })}
    </div>}
    <div className="user-media-footer">
      {multiple && <small className="user-media-count">{items.length ? `已添加 ${items.length} 个${primaryLabel}，顺序将用于任务输入` : `尚未添加${primaryLabel}`}</small>}
      {items.length > 1 && <button type="button" className="user-media-clear" disabled={disabled} onClick={onClear}>清除全部</button>}
    </div>
  </div>;
}
