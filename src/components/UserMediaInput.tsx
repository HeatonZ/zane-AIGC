import { useRef } from "react";
import { ArrowDown, ArrowUp, FileImage, Film, LoaderCircle, Music2, Trash2, Upload } from "lucide-react";
import { useProtectedMedia } from "../lib/mediaPreview";

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

/** Same-origin API media is private and cannot be used as a bare img/video/audio URL. */
export function isProtectedMediaUrl(url: string) {
  if (url.startsWith("/api/")) return true;
  if (typeof window === "undefined") return false;
  try {
    const parsed = new URL(url, window.location.href);
    return parsed.origin === window.location.origin && parsed.pathname.startsWith("/api/");
  } catch {
    return false;
  }
}

export function ProtectedMediaPreview({ url, kind, userId, label }: { url?: string; kind: UserMediaKind; userId?: string; label: string }) {
  const { holder, source, error, retry } = useProtectedMedia(url, kind, userId);

  if (source && kind === "image") return <a className="user-media-preview-link" href={source} target="_blank" rel="noreferrer"><img src={source} alt={label} /></a>;
  if (source && kind === "video") return <video src={source} controls preload="metadata" aria-label={label} />;
  if (source && kind === "audio") return <audio src={source} controls preload="metadata" aria-label={label} />;
  const Icon = kind === "image" ? FileImage : kind === "video" ? Film : Music2;
  return <div ref={holder} className={`user-media-preview-placeholder${error ? " has-error" : ""}`} role="status">
    {error ? <><Icon size={24} /><span>预览暂不可用</span><button type="button" onClick={retry}>重试</button></>
      : url ? <><LoaderCircle className="spin" size={22} /><span>正在读取预览…</span></>
        : <><Icon size={24} /><span>此素材暂无预览</span></>}
  </div>;
}

export default function UserMediaInput({ label, kind, multiple, value, userId, disabled, uploading, uploadProgress, onUpload, onMove, onRemove, onClear }: {
  label: string;
  kind: UserMediaKind;
  multiple: boolean;
  value: unknown;
  userId: string;
  disabled: boolean;
  uploading: boolean;
  uploadProgress?: { completed: number; total: number };
  onUpload: (files: File[]) => void;
  onMove?: (index: number, offset: -1 | 1) => void;
  onRemove: (index: number) => void;
  onClear: () => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const items = Array.isArray(value) ? value : value === undefined || value === null || value === "" ? [] : [value];
  const primaryLabel = kind === "image" ? "图片" : kind === "video" ? "视频" : "音频";
  const sortable = kind === "image" && multiple && !!onMove;

  return <div className="user-media-uploader">
    <input ref={inputRef} className="user-media-file-input" type="file" accept={acceptByKind[kind]} multiple={multiple} disabled={disabled} aria-label={`选择${label}${multiple ? "（可多选）" : ""}`} onChange={event => {
      const files = Array.from(event.target.files ?? []);
      event.target.value = "";
      if (files.length) onUpload(files);
    }} />
    <div className="user-media-picker-row">
      <div className="user-media-picker-copy">
        <span className="user-media-picker-icon">{uploading ? <LoaderCircle className="spin" size={19} /> : <Upload size={19} />}</span>
        <span><strong>{uploading ? `正在上传${primaryLabel}${uploadProgress && uploadProgress.total > 1 ? ` ${Math.min(uploadProgress.completed + 1, uploadProgress.total)}/${uploadProgress.total}` : ""}…` : items.length ? multiple ? `继续添加${primaryLabel}` : `更换${primaryLabel}` : `选择${primaryLabel}`}</strong><small>{hintByKind[kind]} · {multiple ? "可一次多选上传" : "上传新文件作为本次输入"}</small></span>
      </div>
      <div className="user-media-picker-actions">
        <button className="button button-outline user-media-browse" type="button" disabled={disabled || uploading} onClick={() => inputRef.current?.click()}>{uploading ? "上传中" : "上传文件"}</button>
      </div>
    </div>
    {items.length > 0 && <div className="user-media-gallery">
      {items.map((item, index) => {
        const name = mediaName(item, kind, index);
        return <article className="user-media-card" key={`${name}-${index}`}>
          <div className={`user-media-preview user-media-preview-${kind}`}>
            <ProtectedMediaPreview url={mediaUrl(item)} kind={kind} userId={userId} label={name} />
          </div>
          <div className="user-media-card-meta"><span><strong title={name}>{name}</strong><small>{primaryLabel}</small></span>
            <div className="user-media-card-actions">
              {sortable && <div className="user-media-order-actions" aria-label={`调整${name}顺序`}>
                <button type="button" className="user-media-order" disabled={disabled || index === 0} aria-label={`上移${name}`} title="上移" onClick={() => onMove?.(index, -1)}><ArrowUp size={14} /></button>
                <button type="button" className="user-media-order" disabled={disabled || index === items.length - 1} aria-label={`下移${name}`} title="下移" onClick={() => onMove?.(index, 1)}><ArrowDown size={14} /></button>
              </div>}
              <button type="button" className="user-media-remove" disabled={disabled} aria-label={`移除${name}`} title={`移除${name}`} onClick={() => onRemove(index)}><Trash2 size={15} /></button>
            </div>
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
