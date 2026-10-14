import { runMediaUrl } from "./runMedia";

export type MediaInputValue = string | Record<string, unknown>;

function mediaValues(value: unknown): MediaInputValue[] {
  if (Array.isArray(value)) return value.flatMap(mediaValues);
  if (typeof value === "string") return value.trim() ? [value.trim()] : [];
  if (typeof value !== "object" || value === null) return [];
  const item = value as Record<string, unknown>;
  if (item.kind === "media" && item.__zaneRuntime === "media" && Array.isArray(item.items)) {
    return mediaValues(item.items);
  }
  return [item];
}

/** 把任意已存值（数组/单值/运行时媒体包装）摊平成媒体项；语义与服务端 normalizeMediaList 一致。 */
export function mediaItemsOf(value: unknown): MediaInputValue[] { return mediaValues(value); }

export function mediaListValues(value: string): MediaInputValue[] {
  if (!value.trim()) return [];
  try {
    return mediaValues(JSON.parse(value));
  } catch {
    return [value.trim()];
  }
}

export function appendMediaInputValue(value: string, item: MediaInputValue): string {
  return JSON.stringify([...mediaListValues(value), item]);
}

export function moveMediaInputValue(values: MediaInputValue[], index: number, offset: -1 | 1): MediaInputValue[] {
  const next = [...values];
  const target = index + offset;
  if (index < 0 || index >= next.length || target < 0 || target >= next.length) return next;
  [next[index], next[target]] = [next[target], next[index]];
  return next;
}

export function removeMediaInputValue(values: MediaInputValue[], index: number): MediaInputValue[] {
  return values.filter((_, itemIndex) => itemIndex !== index);
}

export function mediaInputLabel(value: MediaInputValue, fallback = "媒体"): string {
  if (typeof value === "string") return value;
  const locator = value.locator as Record<string, unknown> | undefined;
  for (const candidate of [value.assetName, value.filename, value.path, value.url, locator?.value, locator?.filename]) {
    if (typeof candidate === "string" && candidate) return candidate;
  }
  return fallback;
}

export function mediaInputPreviewUrl(value: MediaInputValue): string | undefined {
  if (typeof value === "string") return runMediaUrl(value);
  const locator = value.locator as Record<string, unknown> | undefined;
  const source = value.previewUrl ?? value.url ?? (locator?.type === "url" ? locator.value : undefined);
  return typeof source === "string" ? source : undefined;
}
