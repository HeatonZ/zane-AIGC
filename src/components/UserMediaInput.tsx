import { useEffect, useRef, useState } from "react";
import { ArrowDown, ArrowUp, FileImage, Film, FolderOpen, LoaderCircle, Music2, Search, Trash2, Upload, X } from "lucide-react";
import { listOwnAssets, type OwnAssetPage } from "../lib/accessApi";
import { useProtectedMedia } from "../lib/mediaPreview";
import type { AssetReference } from "../../server/domain/productionContracts";
import ModalPortal from "./ModalPortal";
import { useModalFocus } from "../hooks/useModalFocus";

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

export default function UserMediaInput({ label, kind, multiple, value, userId, disabled, uploading, uploadProgress, onUpload, onSelect, onMove, onRemove, onClear }: {
  label: string;
  kind: UserMediaKind;
  multiple: boolean;
  value: unknown;
  userId: string;
  disabled: boolean;
  uploading: boolean;
  uploadProgress?: { completed: number; total: number };
  onUpload: (files: File[]) => void;
  onSelect: (reference: AssetReference) => void;
  onMove?: (index: number, offset: -1 | 1) => void;
  onRemove: (index: number) => void;
  onClear: () => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [libraryOpen, setLibraryOpen] = useState(false);
  const items = Array.isArray(value) ? value : value === undefined || value === null || value === "" ? [] : [value];
  const primaryLabel = kind === "image" ? "图片" : kind === "video" ? "视频" : "音频";
  const sortable = kind === "image" && multiple && !!onMove;
  const selectedIds = items.flatMap(item => item && typeof item === "object" && !Array.isArray(item)
    && typeof (item as Record<string, unknown>).assetId === "string" ? [(item as Record<string, unknown>).assetId as string] : []);

  return <div className="user-media-uploader">
    <input ref={inputRef} className="user-media-file-input" type="file" accept={acceptByKind[kind]} multiple={multiple} disabled={disabled} aria-label={`选择${label}${multiple ? "（可多选）" : ""}`} onChange={event => {
      const files = Array.from(event.target.files ?? []);
      event.target.value = "";
      if (files.length) onUpload(files);
    }} />
    <div className="user-media-picker-row">
      <div className="user-media-picker-copy">
        <span className="user-media-picker-icon">{uploading ? <LoaderCircle className="spin" size={19} /> : <Upload size={19} />}</span>
        <span><strong>{uploading ? `正在上传${primaryLabel}${uploadProgress && uploadProgress.total > 1 ? ` ${Math.min(uploadProgress.completed + 1, uploadProgress.total)}/${uploadProgress.total}` : ""}…` : items.length ? multiple ? `继续添加${primaryLabel}` : `更换${primaryLabel}` : `选择${primaryLabel}`}</strong><small>{hintByKind[kind]} · {multiple ? "可一次多选上传，或从自己的素材库选择" : "可上传新文件或从自己的素材库选择"}</small></span>
      </div>
      <div className="user-media-picker-actions">
        <button className="button button-outline user-media-browse" type="button" disabled={disabled || uploading} onClick={() => inputRef.current?.click()}>{uploading ? "上传中" : "上传文件"}</button>
        <button className="button button-outline user-media-browse" type="button" disabled={disabled} onClick={() => setLibraryOpen(true)}><FolderOpen size={14} />我的素材库</button>
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
    {libraryOpen && <OwnAssetPicker kind={kind} userId={userId} multiple={multiple} selectedIds={selectedIds} onSelect={onSelect} onClose={() => setLibraryOpen(false)} />}
  </div>;
}

function OwnAssetPicker({ kind, userId, multiple, selectedIds, onSelect, onClose }: {
  kind: UserMediaKind;
  userId: string;
  multiple: boolean;
  selectedIds: string[];
  onSelect: (reference: AssetReference) => void;
  onClose: () => void;
}) {
  const [page, setPage] = useState<OwnAssetPage>();
  const [search, setSearch] = useState("");
  const [cursor, setCursor] = useState<string>();
  const [previous, setPrevious] = useState<Array<string | undefined>>([]);
  const [refresh, setRefresh] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const modal = useModalFocus(onClose);
  const kindLabel = kind === "image" ? "图片" : kind === "video" ? "视频" : "音频";

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setError(""); setPage(undefined);
    const timer = window.setTimeout(() => {
      void listOwnAssets({ q: search, kind, limit: 24, cursor }, userId, controller.signal)
        .then(setPage)
        .catch(reason => { if (!controller.signal.aborted) setError((reason as Error).message); })
        .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    }, 150);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [search, kind, cursor, refresh, userId]);

  function reset() { setCursor(undefined); setPrevious([]); setRefresh(value => value + 1); }

  return <ModalPortal><div className="production-modal-backdrop user-asset-picker-backdrop"><section className="production-modal production-modal-wide user-asset-picker-modal" ref={modal} role="dialog" aria-modal="true" aria-label="我的素材库">
    <div className="production-toolbar"><div><h2>从我的素材库选择{kindLabel}</h2><p>只显示当前账号拥有的未归档素材，选择后用于当前任务输入。</p></div><button type="button" className="icon-button" aria-label="关闭我的素材库" onClick={onClose}><X size={18} /></button></div>
    <label className="user-asset-picker-search"><Search size={16} aria-hidden="true" /><input className="text-input" aria-label="搜索我的素材" placeholder="搜索名称、说明、分组或标签" value={search} onChange={event => { setSearch(event.target.value); setCursor(undefined); setPrevious([]); }} /></label>
    {error && <div className="workflow-run-error" role="alert">{error} <button type="button" className="text-button" onClick={reset}>重新读取第一页</button></div>}
    {loading ? <p className="studio-field-hint" role="status">正在读取本人素材…</p> : page?.assets.length ? <>
      <div className="asset-page-summary">共 {page.total} 个{kindLabel} · 第 {previous.length + 1} 页 · 本页 {page.assets.length} 个</div>
      <div className="user-asset-picker-grid">{page.assets.map(asset => {
        const alreadySelected = selectedIds.includes(asset.id);
        return <article className="user-asset-picker-card" key={asset.id}>
          <div className={`user-asset-picker-preview user-media-preview-${kind}`}><ProtectedMediaPreview url={asset.reference.previewUrl} kind={kind} userId={userId} label={asset.name} /></div>
          <div className="user-asset-picker-details"><strong title={asset.name}>{asset.name}</strong>
            {asset.description && <p title={asset.description}>{asset.description}</p>}
            {asset.group && <small>{asset.group}</small>}
            {asset.tags.length > 0 && <div className="production-tags">{asset.tags.map((tag,index) => <span key={tag + index}>{tag}</span>)}</div>}
            <button type="button" className="button button-outline" disabled={alreadySelected} onClick={() => { onSelect(asset.reference); if (!multiple) onClose(); }}>{alreadySelected ? "已添加" : multiple ? "添加到输入" : "选择此素材"}</button>
          </div>
        </article>;
      })}</div>
      <div className="asset-pagination"><button type="button" className="button button-outline" disabled={!previous.length} onClick={() => { setCursor(previous.at(-1)); setPrevious(values => values.slice(0, -1)); }}>上一页</button><span>第 {previous.length + 1} 页</span><button type="button" className="button button-outline" disabled={!page.hasMore} onClick={() => { setPrevious(values => [...values, cursor]); setCursor(page.nextCursor); }}>下一页</button></div>
    </> : page && <div className="library-empty"><FolderOpen size={30} /><strong>{search ? "没有符合条件的素材" : `还没有可用的${kindLabel}`}</strong><p>你在输入框中上传的{kindLabel}会保存到自己的素材库，之后可以重复选用。</p><button type="button" className="button button-outline" onClick={onClose}>返回上传</button></div>}
  </section></div></ModalPortal>;
}
