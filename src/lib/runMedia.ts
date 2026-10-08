import type { JsonValue } from "../types";
import type { AssetSource } from "../../server/domain/productionContracts";
import { assetPreview } from "./production";

/** Translate durable local run archive paths and the old admin alias to user-readable routes. */
export function runMediaUrl(value: string): string | undefined {
  const path = value.replace(/\\/g, "/");
  const archived = /(?:^|\/)\.zane\/runs\/([a-f0-9-]{36})\/outputs\/media\/([A-Za-z0-9_-][A-Za-z0-9._-]*)$/i.exec(path);
  if (archived) return "/api/v1/runs/" + archived[1] + "/media/" + encodeURIComponent(archived[2]);
  const legacy = /^\/api\/workflows\/runs\/([a-f0-9-]{36})\/media\/([A-Za-z0-9_-][A-Za-z0-9._-]*)$/i.exec(value);
  if (legacy) return "/api/v1/runs/" + legacy[1] + "/media/" + encodeURIComponent(legacy[2]);
  if (/^(?:https?:\/\/|data:|blob:|\/api\/)/i.test(value)) return value;
  return undefined;
}

function recordOf(value: JsonValue): Record<string, JsonValue> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, JsonValue> : undefined;
}

/** Recognize a media leaf inside arbitrary JSON without classifying its parent container. */
export function isRunMediaRecord(value: JsonValue): value is Record<string, JsonValue> {
  const record = recordOf(value);
  if (!record) return false;
  if (typeof record.assetId === "string" && Number.isSafeInteger(record.assetVersion) && Number(record.assetVersion) > 0) return true;
  const locator = recordOf(record.locator as JsonValue);
  if (locator?.type === "path" && typeof locator.value === "string") return true;
  if (locator?.type === "url" && typeof locator.value === "string") return true;
  if (locator?.type === "comfy" && typeof locator.filename === "string") return true;
  const candidates = [record.previewUrl, record.url, record.path, record.file, record.filename, record.assetName, locator?.value, locator?.filename]
    .filter((item): item is string => typeof item === "string");
  const mimeType = typeof record.mimeType === "string" ? record.mimeType : "";
  const mediaType = typeof record.mediaType === "string" ? record.mediaType : "";
  const kind = typeof record.kind === "string" ? record.kind.toLowerCase() : "";
  return Boolean(
    candidates.some(candidate => /\.(?:avif|bmp|gif|jpe?g|png|svg|tiff?|webp|m4v|mkv|mov|mp4|mpeg|mpg|webm|aac|aiff?|flac|m4a|mp3|oga|ogg|opus|wav)(?:[?#]|$)/i.test(candidate))
    || /^(?:image|video|audio)\//i.test(mimeType)
    || /^(?:image|video|audio)(?:_list)?$/i.test(mediaType)
    || ["image", "video", "audio"].includes(kind),
  );
}

function isArchivedMediaRoute(value: string | undefined) {
  return Boolean(value && /^\/api\/v1\/runs\/[a-f0-9-]{36}\/media\/[A-Za-z0-9_-][A-Za-z0-9._-]*$/i.test(value));
}

/** Match the flattened media indices used by the source API, even if some entries cannot be previewed. */
export function runOutputMediaItems(value: JsonValue, type?: string, source?: Omit<AssetSource, "mediaIndex">) {
  const values: Array<{ value: JsonValue; mediaCandidate: boolean }> = [];
  function containsMediaRecord(item: JsonValue): boolean {
    if (isRunMediaRecord(item)) return true;
    if (Array.isArray(item)) return item.some(nested => containsMediaRecord(nested));
    if (item !== null && typeof item === "object") return Object.values(item).some(nested => containsMediaRecord(nested as JsonValue));
    return false;
  }
  function visit(item: JsonValue, nested = false) {
    if (Array.isArray(item)) item.forEach(child => visit(child, nested));
    else if (isRunMediaRecord(item)) values.push({value: item, mediaCandidate: true});
    else if (item !== null && typeof item === "object") {
      if (containsMediaRecord(item)) Object.values(item).forEach(child => visit(child as JsonValue, true));
      else values.push({value: item, mediaCandidate: false});
    } else if (item !== null && item !== "") values.push({value: item, mediaCandidate: !nested});
  }
  visit(value);
  return values.flatMap(({value: item, mediaCandidate}, mediaIndex) => {
    if (!mediaCandidate) return [];
    const record = recordOf(item);
    const locator = recordOf(record?.locator as JsonValue);
    const fixedAsset = record && typeof record.assetId === "string" && Number.isSafeInteger(record.assetVersion) && Number(record.assetVersion) > 0
      ? assetPreview(record.assetId, Number(record.assetVersion)) : undefined;
    const locations = typeof item === "string" ? [item] : [record?.url, record?.previewUrl, fixedAsset, locator?.value, record?.path, record?.file]
      .filter((candidate): candidate is string => typeof candidate === "string");
    const normalized = locations.map(runMediaUrl).filter((candidate): candidate is string => Boolean(candidate));
    const relativeArchive = typeof record?.file === "string" ? /^(?:outputs[\\/])media[\\/]([A-Za-z0-9_-][A-Za-z0-9._-]*)$/i.exec(record.file) : null;
    const relativeArchiveUrl = relativeArchive && source ? "/api/v1/runs/" + encodeURIComponent(source.runId) + "/media/" + encodeURIComponent(relativeArchive[1]) : undefined;
    // Archived run media is authorized by the owning run; prefer it over stale ComfyUI preview URLs.
    let url = normalized.find(isArchivedMediaRoute) ?? relativeArchiveUrl ?? normalized.find(candidate => candidate === fixedAsset) ?? normalized[0];
    const filename = typeof item === "string" ? item : [record?.assetName, record?.filename, record?.file, locator?.filename, record?.path, ...locations]
      .find(candidate => typeof candidate === "string") as string;
    // User-facing projections redact local paths. Fixed asset references still
    // retain their display name, which is the durable source for media typing
    // when previewUrl itself has no extension.
    const extensionSource = [record?.filename, record?.assetName, record?.file, locator?.filename, locator?.value, record?.path, record?.url, record?.previewUrl]
      .find(candidate => typeof candidate === "string") as string;
    const mimeType = typeof record?.mimeType === "string" ? record.mimeType.toLowerCase() : typeof record?.mediaType === "string" ? record.mediaType.toLowerCase().replace(/_list$/, "") + "/" : "";
    const kind = typeof record?.kind === "string" ? record.kind.toLowerCase() : "";
    const dataMime = locations.map(location => /^data:(image|video|audio)\//i.exec(location)?.[1]?.toLowerCase()).find(Boolean) ?? "";
    const mediaKind = ["image", "video", "audio"].includes(kind) ? kind : dataMime;
    const inferFromExtension = !type || type === "json";
    const isVideo = type === "video" || type === "video_list" || mediaKind === "video" || mimeType.startsWith("video/") || (inferFromExtension && /\.(m4v|mkv|mov|mp4|mpeg|mpg|webm)(?:[?#]|$)/i.test(extensionSource));
    const isAudio = type === "audio" || type === "audio_list" || mediaKind === "audio" || mimeType.startsWith("audio/") || (inferFromExtension && /\.(aac|aiff?|flac|m4a|mp3|oga|ogg|opus|wav)(?:[?#]|$)/i.test(extensionSource));
    const isImage = type === "image" || type === "image_list" || mediaKind === "image" || mimeType.startsWith("image/") || (inferFromExtension && /\.(avif|bmp|gif|jpe?g|png|svg|tiff?|webp)(?:[?#]|$)/i.test(extensionSource));
    if (!url && locations.length && source && (isVideo || isAudio || isImage)) {
      const query = new URLSearchParams({outputKey: source.outputKey, mediaIndex: String(mediaIndex)});
      if (source.stepId) query.set("stepId", source.stepId);
      if (source.itemIndex !== undefined) query.set("itemIndex", String(source.itemIndex));
      url = "/api/v1/runs/" + source.runId + "/output-media?" + query;
    }
    return url && (isVideo || isAudio || isImage) ? [{ url, filename, isVideo, isAudio, mediaIndex }] : [];
  });
}
