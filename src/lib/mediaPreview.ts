import { useEffect, useState } from "react";
import { accessMedia } from "./accessApi";

export type MediaKind = "image" | "video" | "audio";
/** Smallest grid size the workbench renders; larger widths only add bytes for the same pixels. */
export const previewWidth = 512;
const previewCacheLimit = 80;
const concurrentMediaReads = 3;

/** Map a protected media URL to its small display derivative. Videos, audio and foreign URLs pass through. */
export function mediaPreviewUrl(url: string, kind: MediaKind, width = previewWidth): string {
  if (kind !== "image" || !url.startsWith("/api/")) return url;
  const asset = /^\/api\/v1\/assets\/([^/]+)\/versions\/(\d+)\/media$/.exec(url);
  if (asset) return `/api/v1/assets/${asset[1]}/versions/${asset[2]}/preview?w=${width}`;
  const archived = /^(\/api\/(?:v1\/runs|workflows\/runs)\/[^/]+\/media\/[^/?]+)$/.exec(url);
  if (archived) return `${archived[1]}/preview?w=${width}`;
  const output = /^(\/api\/v1\/runs\/[^/]+\/output-media)(\?.*)?$/.exec(url);
  if (output) {
    const parameters = new URLSearchParams(output[2] ?? "");
    parameters.set("w", String(width));
    return `${output[1]}?${parameters}`;
  }
  return url;
}

const objectUrls = new Map<string, string>();
function cachedObjectUrl(url: string) {
  const hit = objectUrls.get(url);
  if (hit === undefined) return undefined;
  objectUrls.delete(url); objectUrls.set(url, hit);
  return hit;
}
function rememberObjectUrl(url: string, value: string) {
  objectUrls.set(url, value);
  while (objectUrls.size > previewCacheLimit) {
    const oldest = objectUrls.keys().next().value;
    if (oldest === undefined) break;
    const revoked = objectUrls.get(oldest);
    objectUrls.delete(oldest);
    if (revoked) URL.revokeObjectURL(revoked);
  }
}

let activeReads = 0;
const waitingReads: Array<() => void> = [];
async function acquireRead() {
  if (activeReads < concurrentMediaReads) { activeReads += 1; return; }
  await new Promise<void>(resolve => waitingReads.push(resolve));
  activeReads += 1;
}
function releaseRead() { activeReads -= 1; waitingReads.shift()?.(); }

/** Read private media as a displayable object URL. Images use the small derivative and are cached per session. */
async function readMedia(url: string, kind: MediaKind, userId: string | undefined, signal: AbortSignal): Promise<{ source: string; owned: boolean }> {
  const preview = mediaPreviewUrl(url, kind);
  const cached = kind === "image" ? cachedObjectUrl(preview) : undefined;
  if (cached) return { source: cached, owned: false };
  await acquireRead();
  try {
    const read = async (target: string) => {
      const blob = await accessMedia(target, userId, signal);
      if (!blob.type.toLowerCase().startsWith(`${kind}/`)) throw new Error("工作台返回的内容不是可预览的媒体文件");
      return URL.createObjectURL(blob);
    };
    let source: string;
    if (preview === url) source = await read(url);
    else {
      try { source = await read(preview); }
      catch (error) { if (signal.aborted) throw error; source = await read(url); }
    }
    if (kind === "image") { rememberObjectUrl(preview, source); return { source, owned: false }; }
    return { source, owned: true };
  } finally { releaseRead(); }
}

/**
 * Lazily read one protected media item for display: fetch starts only near the viewport,
 * at most a few items load at once, and image derivatives are reused within the session.
 */
export function useProtectedMedia(url: string | undefined, kind: MediaKind, userId?: string) {
  const [node, setNode] = useState<HTMLElement | null>(null);
  const [visible, setVisible] = useState(false);
  const [source, setSource] = useState("");
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!url || visible || !node) return;
    if (typeof IntersectionObserver === "undefined") { setVisible(true); return; }
    const observer = new IntersectionObserver(entries => { if (entries.some(entry => entry.isIntersecting)) { setVisible(true); observer.disconnect(); } }, { rootMargin: "240px" });
    observer.observe(node);
    return () => observer.disconnect();
  }, [url, visible, node]);
  useEffect(() => {
    if (!url || !visible) return;
    const controller = new AbortController();
    let objectUrl = "";
    let owned = false;
    setSource(""); setError("");
    void readMedia(url, kind, userId, controller.signal).then(result => {
      if (controller.signal.aborted) return;
      objectUrl = result.source; owned = result.owned;
      setSource(result.source);
    }).catch(reason => { if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : "媒体预览读取失败"); });
    return () => { controller.abort(); if (objectUrl && owned) URL.revokeObjectURL(objectUrl); };
  }, [url, kind, userId, visible, attempt]);
  return { holder: setNode, source, error, retry: () => setAttempt(value => value + 1) };
}
