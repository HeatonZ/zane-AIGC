import type { JsonValue } from "../types";
import type { AssetSource } from "../../server/domain/productionContracts";
import { assetPreview } from "./production";
import { collectLocalMediaPaths } from "../../server/domain/localMediaPaths";

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

/** 本地绝对路径媒体（例如 core.code fileAccess 写进 text/json 输出的角色图路径）。
 *
 *  这些文件不在运行归档里，只能经受控的 local-media 通道按坐标读取：客户端不提交路径，
 *  只提交「第几个本地图」，服务端再从运行记录重新解析并校验它落在管理员配置的根目录内。 */
export function localMediaUrl(source: Omit<AssetSource, "mediaIndex">, mediaIndex: number): string {
  const query = new URLSearchParams({ outputKey: source.outputKey, mediaIndex: String(mediaIndex) });
  if (source.stepId) query.set("stepId", source.stepId);
  if (source.itemIndex !== undefined) query.set("itemIndex", String(source.itemIndex));
  return "/api/v1/runs/" + encodeURIComponent(source.runId) + "/local-media?" + query;
}

const mediaExtension = /\.(avif|bmp|gif|jpe?g|png|svg|tiff?|webp|m4v|mkv|mov|mp4|mpeg|mpg|webm|aac|aiff?|flac|m4a|mp3|oga|ogg|opus|wav)$/i;

const extensionByMime: Record<string, string> = {
  "image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp", "image/gif": ".gif", "image/avif": ".avif", "image/bmp": ".bmp", "image/svg+xml": ".svg", "image/tiff": ".tiff",
  "video/mp4": ".mp4", "video/quicktime": ".mov", "video/webm": ".webm", "video/x-matroska": ".mkv", "video/mpeg": ".mpg", "video/x-m4v": ".m4v",
  "audio/mpeg": ".mp3", "audio/wav": ".wav", "audio/x-wav": ".wav", "audio/mp4": ".m4a", "audio/aac": ".aac", "audio/flac": ".flac", "audio/ogg": ".ogg", "audio/opus": ".opus", "audio/aiff": ".aiff",
};

/** 单个媒体下载时补的扩展名：优先响应 Content-Type，判不出才按媒体类型给常见容器。 */
export function mediaExtensionForMime(mimeType: string, kind: "image" | "video" | "audio") {
  const known = extensionByMime[mimeType.split(";")[0].trim().toLowerCase()];
  if (known) return known;
  return kind === "video" ? ".mp4" : kind === "audio" ? ".mp3" : ".png";
}

/** 单个媒体的下载文件名。
 *
 *  优先用运行记录里的真实文件名（固定素材的展示名常是「猫主角米酒_四视图_V4」这种没有
 *  扩展名的中文名），其次取归档媒体路由的末段。`extension` 表示名字里已经带了媒体扩展名：
 *  有扩展名时调用方可以直接用同源 <a download>，视频边下边写盘；没有时才需要读响应头补全。 */
export function mediaDownloadName(item: { url: string; filename?: string }, fallback: string, index = 0) {
  const basename = (value: string) => {
    let decoded = value;
    try { decoded = decodeURIComponent(value); } catch { /* 非法转义按原样处理 */ }
    const name = decoded.replace(/\\/g, "/").split("/").pop() ?? "";
    // 路径分隔符、控制字符与 Windows 保留字符会让浏览器改写文件名，统一替换掉。
    // oxlint-disable-next-line no-control-regex -- 过滤文件名中的 NUL 等控制字符正是本行的目的
    return name.replace(/[\u0000-\u001f<>:"|?*]/g, "-").replace(/^\.+/, "").trim();
  };
  const archived = /^\/api\/v1\/runs\/[^/]+\/media\/([^/?#]+)$/i.exec(item.url)?.[1];
  const candidates = [item.filename, archived].filter((value): value is string => typeof value === "string" && value.trim() !== "").map(basename).filter(Boolean);
  const extended = candidates.find(name => mediaExtension.test(name));
  if (extended) return { name: extended, extension: true };
  if (candidates.length) return { name: candidates[0], extension: false };
  return { name: `${basename(fallback) || "媒体"}-${index + 1}`, extension: false };
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
  // 本地绝对路径的坐标必须与「整份输出值」里的首次出现顺序一致，服务端才取到同一张图。
  // collectLocalMediaPaths 会去重，因此同一个路径在整个输出里只有一个稳定序号。
  const allLocalPaths = source ? collectLocalMediaPaths(value) : [];
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
    // 本地绝对路径（core.code fileAccess 写进 text/json 输出的角色图/参考图）不在运行归档里，
    // 既没有可解析的地址、也不会被 output-media 接受（它只服务声明为媒体类型的输出）。
    // 这类值只经受控的 local-media 通道读取：前端只翻译成坐标，路径仍由服务端从运行记录
    // 重新解析并校验落在管理员授权的根目录内，客户端永远不能指定路径。
    // 只有拿到运行坐标（source）才谈得上定位本机文件；没有坐标时不做任何本地媒体判定。
    const localPath = source ? collectLocalMediaPaths(item)[0] : undefined;
    // 裸字符串只有靠扩展名才能判断媒体类型。用户面投影会把本机路径脱敏，固定素材引用则保留
    // 展示名；两种都必须在推断时参与，否则 text/json 输出里的图会被当成普通文本丢弃。
    // 判据必须覆盖全部候选，不能只取第一个：固定素材引用的 assetName 常是「猫主角米酒_四视图_V4」
    // 这类没有扩展名的展示名，真正带扩展名的是同一条引用上的 path/previewUrl。只认第一个候选会把
    // 整条引用判成非媒体，调用方随后渲染成空白——运行记录「查看本次输入」就是这样看不到图的。
    // 这里与 isRunMediaRecord 的判据保持一致：它能认出媒体叶子，这里就必须能给出媒体类型。
    const extensionCandidates = [
      ...(localPath ? [localPath] : []),
      ...[record?.filename, record?.assetName, record?.file, locator?.filename, locator?.value, record?.path, record?.url, record?.previewUrl]
        .filter((candidate): candidate is string => typeof candidate === "string"),
      ...locations,
    ];
    const hasExtension = (pattern: RegExp) => extensionCandidates.some(candidate => pattern.test(candidate));
    const mimeType = typeof record?.mimeType === "string" ? record.mimeType.toLowerCase() : typeof record?.mediaType === "string" ? record.mediaType.toLowerCase().replace(/_list$/, "") + "/" : "";
    const kind = typeof record?.kind === "string" ? record.kind.toLowerCase() : "";
    const dataMime = locations.map(location => /^data:(image|video|audio)\//i.exec(location)?.[1]?.toLowerCase()).find(Boolean) ?? "";
    const mediaKind = ["image", "video", "audio"].includes(kind) ? kind : dataMime;
    // 声明为媒体类型的输出与 text/json 输出走不同的只读通道，必须先把这件事算清楚，见下方注释。
    const declaredMediaType = /^(?:image|video|audio)(?:_list)?$/.test(type ?? "");
    // 普通输出按声明类型决定是否值得推断；非媒体声明类型（text/json）里已识别的本地媒体路径
    // 不受此限：isLocalMediaPath 已要求「整串就是绝对路径且带媒体扩展名」，扩展名即权威判据，
    // 而 core.code 常见的做法正是把图路径写在 text/json 输出里（例如 characterPath 声明为 text）。
    // 声明为媒体类型的输出不走这条：它的类型由声明决定，输出坐标也统一由 output-media 承担。
    const infer = !type || type === "json" || (Boolean(localPath) && !declaredMediaType);
    const isVideo = type === "video" || type === "video_list" || mediaKind === "video" || mimeType.startsWith("video/") || (infer && hasExtension(/\.(m4v|mkv|mov|mp4|mpeg|mpg|webm)(?:[?#]|$)/i));
    const isAudio = type === "audio" || type === "audio_list" || mediaKind === "audio" || mimeType.startsWith("audio/") || (infer && hasExtension(/\.(aac|aiff?|flac|m4a|mp3|oga|ogg|opus|wav)(?:[?#]|$)/i));
    const isImage = type === "image" || type === "image_list" || mediaKind === "image" || mimeType.startsWith("image/") || (infer && hasExtension(/\.(avif|bmp|gif|jpe?g|png|svg|tiff?|webp)(?:[?#]|$)/i));
    const isMediaKind = isVideo || isAudio || isImage;
    // 两个只读通道的分工必须明确，不能互相抢：
    //  - 声明为媒体类型的输出（image/video/audio[_list]）保持走 output-media。这是既有契约，
    //    也覆盖「手动替换本步结果」选中的任意本地文件——它们通常不在管理员配置的导出根目录里，
    //    用带包含性校验的 local-media 会直接失败。
    //  - 非媒体类型（text/json）里出现的本地媒体路径此前没有任何可用通道（output-media 只认
    //    媒体类型，会 400），只能走受控的 local-media；这正是 core.code 把图片路径写进
    //    characterPath(text)/reference(json) 时「看不了图」的原因。
    if (!url && isMediaKind) {
      if (localPath && !declaredMediaType) {
        const localIndex = allLocalPaths.indexOf(localPath);
        if (localIndex >= 0) url = localMediaUrl(source!, localIndex);
      } else if (locations.length && source) {
        const query = new URLSearchParams({outputKey: source.outputKey, mediaIndex: String(mediaIndex)});
        if (source.stepId) query.set("stepId", source.stepId);
        if (source.itemIndex !== undefined) query.set("itemIndex", String(source.itemIndex));
        url = "/api/v1/runs/" + source.runId + "/output-media?" + query;
      }
    }
    return url && isMediaKind ? [{ url, filename, isVideo, isAudio, mediaIndex }] : [];
  });
}
