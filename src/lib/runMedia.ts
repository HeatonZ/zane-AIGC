import type { JsonValue } from "../types";
import type { AssetSource } from "../../server/domain/productionContracts";
import { assetPreview } from "./production";

/** Translate a durable local run archive path into its existing media route. */
export function runMediaUrl(value: string): string | undefined {
  const path = value.replace(/\\/g, "/");
  const archived = /(?:^|\/)\.zane\/runs\/([a-f0-9-]{36})\/outputs\/media\/([A-Za-z0-9_-][A-Za-z0-9._-]*)$/i.exec(path);
  if (archived) return "/api/v1/runs/" + archived[1] + "/media/" + encodeURIComponent(archived[2]);
  if (/^(?:https?:\/\/|data:|blob:|\/api\/)/i.test(value)) return value;
  return undefined;
}

/** Match the flattened media indices used by the asset source API, even if some entries cannot be previewed. */
export function runOutputMediaItems(value: JsonValue, type?: string, source?: Omit<AssetSource, "mediaIndex">) {
  const values: JsonValue[] = [];
  function visit(item: JsonValue) {
    if (Array.isArray(item)) item.forEach(visit);
    else if (item !== null && item !== "") values.push(item);
  }
  visit(value);
  return values.flatMap((item, mediaIndex) => {
    const record = item && typeof item === "object" && !Array.isArray(item) ? item : undefined;
    const fixedAsset = record && typeof record.assetId === "string" && Number.isSafeInteger(record.assetVersion) && Number(record.assetVersion) > 0
      ? assetPreview(record.assetId, Number(record.assetVersion)) : undefined;
    const location = typeof item === "string" ? item : [record?.previewUrl, fixedAsset, record?.url, record?.path].find(candidate => typeof candidate === "string") as string | undefined;
    let url = location ? runMediaUrl(location) : undefined;
    const filename = typeof item === "string" ? item : [record?.assetName, record?.filename, record?.file, record?.path, location].find(candidate => typeof candidate === "string") as string;
    const extensionSource = [record?.filename, record?.file, record?.path, location].find(candidate => typeof candidate === "string") as string;
    const isVideo = type === "video" || type === "video_list" || (!type && /\.(mp4|webm|mov|m4v)(?:[?#]|$)/i.test(extensionSource));
    const isAudio = type === "audio" || type === "audio_list" || (!type && /\.(aac|aiff?|flac|m4a|mp3|ogg|opus|wav)(?:[?#]|$)/i.test(extensionSource));
    const isImage = type === "image" || type === "image_list" || (!type && /\.(png|jpe?g|webp|gif|bmp)(?:[?#]|$)/i.test(extensionSource));
    if (!url && location && source && (isVideo || isAudio || isImage)) {
      const query = new URLSearchParams({outputKey: source.outputKey, mediaIndex: String(mediaIndex)});
      if (source.stepId) query.set("stepId", source.stepId);
      if (source.itemIndex !== undefined) query.set("itemIndex", String(source.itemIndex));
      url = "/api/v1/runs/" + source.runId + "/output-media?" + query;
    }
    return url && (isVideo || isAudio || isImage) ? [{ url, filename, isVideo, isAudio, mediaIndex }] : [];
  });
}
