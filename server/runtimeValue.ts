export type RuntimeJsonValue = string | number | boolean | null | RuntimeJsonValue[] | { [key: string]: RuntimeJsonValue };

export type RuntimeMediaKind = "image" | "video" | "audio";

export type RuntimeMediaLocator =
  | { type: "path"; value: string }
  | { type: "url"; value: string }
  | { type: "comfy"; filename: string; subfolder: string; location: "input" | "output" };

export interface RuntimeMediaItem {
  id: string;
  kind: RuntimeMediaKind;
  locator: RuntimeMediaLocator;
  filename?: string;
  mimeType?: string;
  previewUrl?: string;
  assetId?: string;
  assetVersion?: number;
  assetName?: string;
}

export interface RuntimeMediaValue {
  kind: "media";
  __zaneRuntime: "media";
  mediaKind: RuntimeMediaKind;
  items: RuntimeMediaItem[];
}

export type RuntimeValue = RuntimeJsonValue | RuntimeMediaValue;

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function fileNameFromUrl(value: string) {
  try {
    return decodeURIComponent(new URL(value).pathname.split("/").pop() ?? "") || undefined;
  } catch { /* Not an absolute URL; a relative reference is resolved below. */ }
  // Workbench media is also published as canonical *relative* paths, such as
  // `/api/v1/runs/<runId>/media/<file>`; `new URL` rejects those without a base.
  // Only a file-like last segment counts, so an endpoint path such as
  // `.../output-media` never invents a file name. A query or fragment is
  // dropped by `pathname`.
  let pathname: string;
  try {
    pathname = new URL(value, "http://localhost").pathname;
  } catch {
    return undefined;
  }
  const candidate = pathname.split("/").pop() ?? "";
  if (candidate === "." || candidate === ".." || !candidate.includes(".")) return undefined;
  try {
    return decodeURIComponent(candidate) || undefined;
  } catch {
    return undefined;
  }
}

function fileNameFromPath(value: string) {
  const normalized = value.replace(/[\\/]+$/, "");
  const candidate = normalized.split(/[\\/]/).pop();
  return candidate || undefined;
}

function itemId(kind: RuntimeMediaKind, index: number, filename?: string) {
  const suffix = filename?.replace(/[^A-Za-z0-9_.-]/g, "_").slice(-80) || String(index);
  return `media_${kind}_${index}_${suffix}`;
}

export function isRuntimeMediaValue(value: unknown): value is RuntimeMediaValue {
  return Boolean(
    record(value)?.kind === "media"
    && record(value)?.__zaneRuntime === "media"
    && (record(value)?.mediaKind === "image" || record(value)?.mediaKind === "video" || record(value)?.mediaKind === "audio")
    && Array.isArray(record(value)?.items),
  );
}

function normalizeMediaItem(value: unknown, mediaKind: RuntimeMediaKind, index: number): RuntimeMediaItem | undefined {
  const existing = record(value);
  const asset = typeof existing?.assetId === "string" && Number.isSafeInteger(existing.assetVersion)
    ? { assetId: existing.assetId, assetVersion: existing.assetVersion as number, ...(typeof existing.assetName === "string" ? { assetName: existing.assetName } : {}) } : {};
  if (existing && typeof existing.id === "string" && existing.id && existing.kind === mediaKind && record(existing.locator)) {
    const locator = existing.locator as Record<string, unknown>;
    if (locator.type === "path" && typeof locator.value === "string") {
      return {
        id: existing.id,
        kind: mediaKind,
        locator: { type: "path", value: locator.value },
        ...asset,
        ...(typeof existing.filename === "string" ? { filename: existing.filename } : {}),
        ...(typeof existing.mimeType === "string" ? { mimeType: existing.mimeType } : {}),
        ...(typeof existing.previewUrl === "string" ? { previewUrl: existing.previewUrl } : {}),
      };
    }
    if (locator.type === "url" && typeof locator.value === "string") {
      return {
        id: existing.id,
        kind: mediaKind,
        locator: { type: "url", value: locator.value },
        ...(typeof existing.filename === "string" ? { filename: existing.filename } : {}),
        ...(typeof existing.mimeType === "string" ? { mimeType: existing.mimeType } : {}),
        ...(typeof existing.previewUrl === "string" ? { previewUrl: existing.previewUrl } : { previewUrl: locator.value }),
      };
    }
    if (locator.type === "comfy" && typeof locator.filename === "string" && (locator.location === "input" || locator.location === "output")) {
      return {
        id: existing.id,
        kind: mediaKind,
        locator: {
          type: "comfy",
          filename: locator.filename,
          subfolder: typeof locator.subfolder === "string" ? locator.subfolder : "",
          location: locator.location,
        },
        filename: typeof existing.filename === "string" ? existing.filename : locator.filename,
        ...(typeof existing.mimeType === "string" ? { mimeType: existing.mimeType } : {}),
        ...(typeof existing.previewUrl === "string" ? { previewUrl: existing.previewUrl } : {}),
      };
    }
  }
  const text = typeof value === "string" ? value.trim() : "";
  if (text) {
    const isUrl = /^(?:https?:|data:)/i.test(text);
    return {
      id: itemId(mediaKind, index, isUrl ? fileNameFromUrl(text) : fileNameFromPath(text)),
      kind: mediaKind,
      locator: isUrl ? { type: "url", value: text } : { type: "path", value: text },
      ...(isUrl ? { previewUrl: text } : {}),
      ...(fileNameFromUrl(text) || fileNameFromPath(text) ? { filename: fileNameFromUrl(text) ?? fileNameFromPath(text) } : {}),
    };
  }
  const candidate = record(value);
  if (!candidate) return undefined;
  const filename = typeof candidate.filename === "string" ? candidate.filename : undefined;
  const subfolder = typeof candidate.subfolder === "string" ? candidate.subfolder : "";
  // A filename by itself is also a common shape for external media APIs.
  // Treat it as a ComfyUI attachment only when its location is explicit;
  // otherwise prefer the URL or path fields below.
  const comfyLocation = candidate.type === "input" || candidate.type === "output"
    ? candidate.type
    : undefined;
  if (filename && comfyLocation) {
    const location = candidate.type === "input" ? "input" : "output";
    const previewUrl = typeof candidate.url === "string" ? candidate.url : undefined;
    return {
      id: typeof candidate.id === "string" && candidate.id ? candidate.id : itemId(mediaKind, index, filename),
      kind: mediaKind,
      locator: { type: "comfy", filename, subfolder, location },
      filename,
      ...(previewUrl ? { previewUrl } : {}),
    };
  }
  const url = typeof candidate.url === "string" && candidate.url.trim() ? candidate.url.trim() : undefined;
  if (url) {
    return {
      id: typeof candidate.id === "string" && candidate.id ? candidate.id : itemId(mediaKind, index, fileNameFromUrl(url)),
      kind: mediaKind,
      locator: { type: "url", value: url },
      ...(fileNameFromUrl(url) ? { filename: fileNameFromUrl(url) } : {}),
      previewUrl: url,
    };
  }
  const pathValue = typeof candidate.path === "string" && candidate.path.trim() ? candidate.path.trim() : undefined;
  if (pathValue) {
    return {
      id: typeof candidate.id === "string" && candidate.id ? candidate.id : itemId(mediaKind, index, fileNameFromPath(pathValue)),
      kind: mediaKind,
      locator: { type: "path", value: pathValue },
      ...asset,
      ...(typeof candidate.previewUrl === "string" ? { previewUrl: candidate.previewUrl } : {}),
      ...(fileNameFromPath(pathValue) ? { filename: fileNameFromPath(pathValue) } : {}),
    };
  }
  return undefined;
}

function flatten(value: unknown): unknown[] {
  if (isRuntimeMediaValue(value)) return flatten(value.items);
  if (!Array.isArray(value)) return [value];
  return value.flatMap((item) => flatten(item));
}

export function createRuntimeMediaValue(mediaKind: RuntimeMediaKind, value: unknown): RuntimeMediaValue {
  if (isRuntimeMediaValue(value) && value.mediaKind === mediaKind) return value;
  const items = flatten(isRuntimeMediaValue(value) ? value.items : value)
    .map((item, index) => normalizeMediaItem(item, mediaKind, index))
    .filter((item): item is RuntimeMediaItem => Boolean(item));
  return { kind: "media", __zaneRuntime: "media", mediaKind, items };
}

export function runtimeMediaItems(value: unknown, mediaKind: RuntimeMediaKind = "image"): RuntimeMediaItem[] {
  return isRuntimeMediaValue(value) ? value.items : createRuntimeMediaValue(mediaKind, value).items;
}

export function runtimeMediaItemValue(item: RuntimeMediaItem): RuntimeJsonValue {
  if (item.assetId && item.locator.type === "path") return { assetId: item.assetId, assetVersion: item.assetVersion ?? 1, path: item.locator.value, ...(item.assetName ? { assetName: item.assetName } : {}), ...(item.previewUrl ? { previewUrl: item.previewUrl } : {}) };
  if (item.locator.type === "path" || item.locator.type === "url") return item.locator.value;
  const { filename, subfolder, location } = item.locator;
  const url = item.previewUrl ?? `/api/comfyui/view?${new URLSearchParams({ filename, subfolder, type: location }).toString()}`;
  return {
    id: item.id,
    filename,
    subfolder,
    type: location,
    url,
    ...(item.filename && item.filename !== filename ? { name: item.filename } : {}),
  };
}

export function runtimeMediaExternalValue(value: unknown): RuntimeJsonValue {
  if (isRuntimeMediaValue(value)) return value.items.map(runtimeMediaItemValue);
  if (Array.isArray(value)) return value.map(runtimeMediaExternalValue);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, runtimeMediaExternalValue(item)]));
  return value as RuntimeJsonValue;
}

export function selectRuntimeMedia(value: unknown, selection?: { mode: "all" | "item" | "for_each"; index?: number }) {
  if (!isRuntimeMediaValue(value) || !selection || selection.mode !== "item") return value;
  const item = value.items[selection.index ?? 0];
  if (!item) throw new Error(`媒体序号 ${selection.index ?? 0} 不存在`);
  return { ...value, items: [item] } satisfies RuntimeMediaValue;
}

export function mediaKindFromWorkflowType(type: unknown): RuntimeMediaKind | undefined {
  if (type === "image" || type === "image_list") return "image";
  if (type === "video" || type === "video_list") return "video";
  if (type === "audio" || type === "audio_list") return "audio";
  return undefined;
}
