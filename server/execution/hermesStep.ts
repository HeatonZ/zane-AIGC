import os from "node:os";
import { createHash, randomUUID } from "node:crypto";
import sharp from "sharp";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { mediaContentTypeExtension } from "../artifacts/runArtifacts.js";
import { defaultWorkflowTimeoutMinutes, execFileAsync, ffmpegBinary, ffprobeBinary, workflowTimeoutLabel, workflowTimeoutMs } from "../config.js";
import type { HermesApiConnection, JsonValue, RunStep, SavedSettings } from "../domain/types.js";
import type { HermesFeedbackContext } from "../domain/feedbackContracts.js";
import { asRecord, externalizeRuntimeValue, normalizeMediaList, parseWorkflowLiteral, resolvePromptTemplate, resolveWorkflowValue, toJsonValue, workflowMediaValueKind, workflowReferenceRoot } from "../domain/workflowValues.js";
import { fetchHermesWithRetry, hermesTransportError, HermesHttpError, HermesRunEndpointUnavailableError, requestHermesRun } from "../hermesTransport.js";
import { log } from "../observability/logger.js";
import { mediaKindFromWorkflowType, createRuntimeMediaValue } from "../runtimeValue.js";
import { cancellationError, throwIfAborted } from "./cancellation.js";
import { hermesApiEndpoint, readHermesApiConnection } from "../services/hermesProfiles.js";
import { hermesModelSelectionError, hermesRequestModelFields, type HermesModelSelection } from "../domain/hermesModelSelection.js";
import { readHermesImageSource } from "./hermesImageSource.js";
import { appendHermesFeedback } from "./hermesFeedback.js";
import { parseHermesJson, parseHermesOutput } from "./hermesOutput.js";

type HermesMessagePart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string; detail: "high" } };

const hermesImageLimit = 12;
const hermesVideoFrameCount = 6;
const hermesInlineMediaLimit = 9_500_000;
const hermesImageSourceLimit = 100_000_000;
const hermesImageTargetBytes = 5_500_000;

export function mimeTypeForMediaPath(filename: string, fallback = "application/octet-stream") {
  const extension = path.extname(filename).toLowerCase();
  return ({
    ".avif": "image/avif",
    ".bmp": "image/bmp",
    ".gif": "image/gif",
    ".heic": "image/heic",
    ".jpeg": "image/jpeg",
    ".jpg": "image/jpeg",
    ".mp4": "video/mp4",
    ".png": "image/png",
    ".tif": "image/tiff",
    ".tiff": "image/tiff",
    ".webm": "video/webm",
    ".webp": "image/webp",
  } as Record<string, string>)[extension] ?? fallback;
}

function mediaDataUrl(bytes: Buffer, contentType: string) {
  const normalizedType = contentType.split(";")[0].trim().toLowerCase();
  if (!normalizedType.startsWith("image/")) throw new Error("Hermes 多模态输入只支持图像附件");
  return `data:${normalizedType};base64,${bytes.toString("base64")}`;
}

/** 压缩结果缓存：同一素材在续跑/重做时不再重复编码。键含预算，避免不同预算互相污染。 */
const hermesImageCache = new Map<string, { bytes: Buffer; contentType: string }>();
const hermesImageCacheLimit = 64;

async function prepareHermesImage(bytes: Buffer, contentType: string, signal?: AbortSignal, maxBytes = hermesImageTargetBytes) {
  if (bytes.length <= maxBytes) return { bytes, contentType };
  const cacheKey = createHash("sha256").update(bytes).update(`:${maxBytes}`).digest("hex");
  const cached = hermesImageCache.get(cacheKey);
  if (cached) return cached;
  const compressed = await compressHermesImage(bytes, signal, maxBytes);
  hermesImageCache.set(cacheKey, compressed);
  if (hermesImageCache.size > hermesImageCacheLimit) hermesImageCache.delete(hermesImageCache.keys().next().value as string);
  return compressed;
}

/** 优先用进程内 sharp（依赖已在）；不可解码或仍超限时回退 ffmpeg 阶梯。 */
async function compressHermesImage(bytes: Buffer, signal: AbortSignal | undefined, maxBytes: number) {
  throwIfAborted(signal);
  try {
    const image = sharp(bytes, { failOn: "none", limitInputPixels: 100_000_000 });
    const metadata = await image.metadata();
    const width = Number(metadata.width);
    const height = Number(metadata.height);
    if (Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0) {
      const hasAlpha = Boolean(metadata.hasAlpha);
      const maxEdge = Math.max(width, height);
      const edgeTargets = [...new Set([3072, 2560, 2048, 1600, 1280, 1024, 768, 512].map((edge) => Math.min(edge, maxEdge)))];
      const qualityTargets = hasAlpha ? [undefined] : [60, 45, 32, 22];
      for (const edge of edgeTargets) {
        for (const quality of qualityTargets) {
          throwIfAborted(signal);
          const pipeline = sharp(bytes, { failOn: "none", limitInputPixels: 100_000_000 })
            .rotate()
            .resize({ width: edge, height: edge, fit: "inside", withoutEnlargement: true });
          const encoded = hasAlpha
            ? await pipeline.png({ compressionLevel: 9, palette: true }).toBuffer()
            : await pipeline.jpeg({ quality, mozjpeg: true }).toBuffer();
          if (encoded.length <= maxBytes) return { bytes: encoded, contentType: hasAlpha ? "image/png" : "image/jpeg" };
        }
      }
    }
  } catch {
    if (signal?.aborted) throw cancellationError();
    // sharp 无法解码时继续走 ffmpeg 兜底；两者都失败才向调用方报错。
  }
  return compressHermesImageWithFfmpeg(bytes, signal, maxBytes);
}

async function compressHermesImageWithFfmpeg(bytes: Buffer, signal: AbortSignal | undefined, maxBytes: number) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "zane-hermes-image-"));
  const input = path.join(directory, "input.img");
  try {
    await writeFile(input, bytes);
    let probeResult: Record<string, unknown> | undefined;
    try {
      const probe = await execFileAsync(ffprobeBinary, [
        "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height,pix_fmt", "-of", "json", input,
      ], { timeout: 30000, windowsHide: true, maxBuffer: 1024 * 1024, signal });
      probeResult = asRecord(JSON.parse(probe.stdout));
    } catch (error) {
      if (signal?.aborted) throw cancellationError();
      if (asRecord(error)?.code === "ENOENT") throw new Error("找不到 ffprobe，无法压缩 Hermes 图片");
      throw new Error("无法识别超限图片，请确认文件有效且为常见图像格式");
    }
    const stream = Array.isArray(probeResult?.streams) ? asRecord(probeResult.streams[0]) : undefined;
    const width = Number(stream?.width);
    const height = Number(stream?.height);
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
      throw new Error("无法识别超限图片的尺寸");
    }
    const hasAlpha = typeof stream?.pix_fmt === "string" && /(?:rgba|bgra|argb|abgr|yuva|gbrap|ya\d)/i.test(stream.pix_fmt);
    const maxEdge = Math.max(width, height);
    const edgeTargets = [...new Set([3072, 2560, 2048, 1600, 1280, 1024, 768, 512].map((edge) => Math.min(edge, maxEdge)))];
    for (const edge of edgeTargets) {
      for (const quality of hasAlpha ? [undefined] : [4, 7, 10, 13]) {
        throwIfAborted(signal);
        const output = path.join(directory, hasAlpha ? "resized.png" : "resized.jpg");
        try {
          await execFileAsync(ffmpegBinary, [
            "-hide_banner", "-loglevel", "error", "-y", "-max_pixels", "100000000", "-i", input,
            "-frames:v", "1", "-vf", `scale=${edge}:${edge}:force_original_aspect_ratio=decrease:force_divisible_by=2`,
            ...(hasAlpha ? ["-compression_level", "9", "-pred", "mixed"] : ["-q:v", String(quality)]), output,
          ], { timeout: 60000, windowsHide: true, maxBuffer: 2 * 1024 * 1024, signal });
        } catch (error) {
          if (signal?.aborted) throw cancellationError();
          if (asRecord(error)?.code === "ENOENT") throw new Error("找不到 ffmpeg，无法压缩 Hermes 图片");
          throw new Error("压缩 Hermes 图片失败，请确认文件有效且为常见图像格式");
        }
        const resized = await readFile(output).catch(() => undefined);
        if (resized?.length && resized.length <= maxBytes) {
          return { bytes: resized, contentType: hasAlpha ? "image/png" : "image/jpeg" };
        }
      }
    }
    throw new Error("图片无法压缩到本次请求预算；请减少图片数量或缩小图片");
  } finally {
    await rm(directory, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function hermesImageDataUrl(bytes: Buffer, _filename: string, contentType: string, signal?: AbortSignal, maxBytes = hermesImageTargetBytes) {
  const prepared = await prepareHermesImage(bytes, contentType, signal, maxBytes);
  return mediaDataUrl(prepared.bytes, prepared.contentType || "image/jpeg");
}

export async function fetchMediaResponse(url: string, signal?: AbortSignal, maxBytes = 100_000_000, limitMessage = "视频附件超过 100 MB 限制") {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 120000);
  const abortFromParent = () => controller.abort();
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener("abort", abortFromParent, { once: true });
  }
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) throw new Error(`媒体服务返回 ${response.status}`);
    const contentLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(contentLength) && contentLength > maxBytes) throw new Error(limitMessage);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > maxBytes) throw new Error(limitMessage);
    return { bytes, contentType: response.headers.get("content-type") ?? "" };
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", abortFromParent);
  }
}

async function readComfyMediaBytes(media: Record<string, unknown>, settings: SavedSettings, signal?: AbortSignal, maxBytes = 100_000_000, limitMessage?: string) {
  if (!settings.comfyuiBaseUrl || typeof media.filename !== "string") {
    throw new Error("无法读取 ComfyUI 媒体附件，请检查 ComfyUI 连接");
  }
  const query = new URLSearchParams({
    filename: media.filename,
    subfolder: typeof media.subfolder === "string" ? media.subfolder : "",
    type: typeof media.type === "string" ? media.type : "output",
  });
  try {
    return await fetchMediaResponse(`${settings.comfyuiBaseUrl}/view?${query}`, signal, maxBytes, limitMessage);
  } catch (error) {
    if (signal?.aborted) throw cancellationError();
    throw new Error(error instanceof Error ? `无法读取 ComfyUI 媒体附件：${error.message}` : "无法读取 ComfyUI 媒体附件");
  }
}

async function hermesImageUrl(value: unknown, settings: SavedSettings, signal?: AbortSignal, maxBytes = hermesImageTargetBytes): Promise<string> {
  const source = await readHermesImageSource(value, {
    sourceLimitBytes: hermesImageSourceLimit,
    signal,
    readComfy: media => readComfyMediaBytes(media, settings, signal, hermesImageSourceLimit, "Hermes 图片原文件超过 100 MB 限制"),
  });
  if (source.kind === "url") return source.url;
  return hermesImageDataUrl(source.bytes, source.filename, mimeTypeForMediaPath(source.filename, source.contentType || "image/jpeg"), signal, maxBytes);
}

async function materializeHermesVideo(value: unknown, settings: SavedSettings, directory: string, signal?: AbortSignal) {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (/^https?:\/\//i.test(trimmed)) return trimmed;
    if (/^data:/i.test(trimmed)) {
      const match = /^data:(video\/[a-z0-9.+-]+);base64,([a-z0-9+/=\s]+)$/i.exec(trimmed);
      if (!match) throw new Error("视频 data URL 格式无效");
      const bytes = Buffer.from(match[2].replace(/\s/g, ""), "base64");
      if (!bytes.length || bytes.length > 100_000_000) throw new Error("视频附件超过 100 MB 限制");
      const filename = path.join(directory, `input${mediaContentTypeExtension(match[1])}`);
      await writeFile(filename, bytes);
      return filename;
    }
    const filename = path.resolve(trimmed);
    const info = await stat(filename).catch(() => undefined);
    if (!info?.isFile()) throw new Error(`无法读取视频文件：${trimmed}`);
    return filename;
  }

  const media = asRecord(value);
  if (!media) throw new Error("Hermes 视频输入格式无效");
  if (typeof media.filename === "string") {
    const { bytes } = await readComfyMediaBytes(media, settings, signal);
    const extension = path.extname(media.filename).replace(/[^.A-Za-z0-9]/g, "").slice(0, 12) || ".mp4";
    const filename = path.join(directory, `input${extension}`);
    await writeFile(filename, bytes);
    return filename;
  }
  if (typeof media.url === "string" && /^https?:\/\//i.test(media.url)) return media.url;
  throw new Error("Hermes 视频输入缺少可读取的文件或 URL");
}

function formatVideoTimestamp(seconds: number) {
  const minutes = Math.floor(seconds / 60);
  const remainder = (seconds - minutes * 60).toFixed(1).padStart(4, "0");
  return `${minutes}:${remainder}`;
}

async function hermesVideoFrameParts(value: unknown, label: string, settings: SavedSettings, signal?: AbortSignal, maxImageBytes = hermesImageTargetBytes): Promise<HermesMessagePart[]> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "zane-hermes-video-"));
  try {
    const source = await materializeHermesVideo(value, settings, directory, signal);
    const inputOptions = /^https?:\/\//i.test(source)
      ? ["-protocol_whitelist", "file,http,https,tcp,tls,crypto", "-rw_timeout", "15000000"]
      : [];
    let probeOutput: string;
    try {
      const probe = await execFileAsync(ffprobeBinary, [
        "-v", "error", ...inputOptions, "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", source,
      ], { timeout: 45000, windowsHide: true, maxBuffer: 1024 * 1024, signal });
      probeOutput = probe.stdout;
    } catch (error) {
      if (signal?.aborted) throw cancellationError();
      if (asRecord(error)?.code === "ENOENT") throw new Error("找不到 ffprobe，请安装 ffmpeg 并设置 FFPROBE_BIN");
      throw new Error("无法读取视频时长，请确认视频有效且可访问");
    }
    const duration = Number(probeOutput.trim());
    if (!Number.isFinite(duration) || duration <= 0) throw new Error("视频时长无效，无法抽取代表帧");
    const frameCount = duration < 1 ? 1 : hermesVideoFrameCount;
    const parts: HermesMessagePart[] = [];
    for (let index = 0; index < frameCount; index += 1) {
      throwIfAborted(signal);
      const timestamp = duration < 1 ? duration / 2 : Math.min(duration - 0.05, duration * (index + 1) / (frameCount + 1));
      const filename = path.join(directory, `frame-${index + 1}.jpg`);
      try {
        await execFileAsync(ffmpegBinary, [
          "-hide_banner", "-loglevel", "error", "-y", "-ss", timestamp.toFixed(3), ...inputOptions,
          "-i", source, "-frames:v", "1", "-vf", "scale=1280:1280:force_original_aspect_ratio=decrease", "-q:v", "4", filename,
        ], { timeout: 60000, windowsHide: true, maxBuffer: 1024 * 1024, signal });
      } catch (error) {
        if (signal?.aborted) throw cancellationError();
        if (asRecord(error)?.code === "ENOENT") throw new Error("找不到 ffmpeg，请安装 ffmpeg 并设置 FFMPEG_BIN");
        throw new Error(`抽取视频代表帧失败（${formatVideoTimestamp(timestamp)}）`);
      }
      const bytes = await readFile(filename).catch(() => undefined);
      if (!bytes?.length) throw new Error(`无法读取视频代表帧（${formatVideoTimestamp(timestamp)}）`);
      parts.push({ type: "text", text: `${label}，${formatVideoTimestamp(timestamp)} 帧` });
      const imageUrl = await hermesImageDataUrl(bytes, filename, "image/jpeg", signal, maxImageBytes);
      parts.push({ type: "image_url", image_url: { url: imageUrl, detail: "high" } });
    }
    return parts;
  } finally {
    await rm(directory, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function hermesMessageContent(step: RunStep, inputs: Record<string, JsonValue>, stepValues: Map<string, Record<string, JsonValue>>, types: Map<string, string>, prompt: string, settings: SavedSettings, signal?: AbortSignal): Promise<string | HermesMessagePart[]> {
  const parts: HermesMessagePart[] = [{ type: "text", text: prompt }];
  const mediaInputs = (step.inputs ?? []).flatMap((input) => {
    const type = input.valueSource === "literal" ? input.literalType ?? "text" : types.get(workflowReferenceRoot(input.sourceRef ?? ""));
    const rawValue = resolveWorkflowValue(input, inputs, stepValues);
    const mediaKind = workflowMediaValueKind(rawValue, type);
    if (mediaKind !== "image" && mediaKind !== "video") return [];
    const value = normalizeMediaList(externalizeRuntimeValue(rawValue));
    return value.length ? [{ input, mediaKind, value }] : [];
  });
  const expectedImageCount = Math.max(1, mediaInputs.reduce((total, media) => total + (
    media.mediaKind === "video" ? hermesVideoFrameCount * media.value.length : media.value.length
  ), 0));
  // 附件数量在抽帧/压缩之前就确定：必然超限时立即失败，不做注定白费的 ffmpeg 工作。
  if (expectedImageCount > hermesImageLimit) {
    throw new Error(`${step.name} 最多支持 ${hermesImageLimit} 张图片或视频帧（当前附件预计 ${expectedImageCount} 张）`);
  }
  const promptBytes = Buffer.byteLength(prompt, "utf8");
  const imageBudgetBytes = Math.min(
    hermesImageTargetBytes,
    Math.floor(Math.max(0, hermesInlineMediaLimit - promptBytes - 32_000) * 0.7 / expectedImageCount),
  );
  let imageCount = 0;
  for (const { input, mediaKind, value } of mediaInputs) {
    const label = input.label?.trim() || input.key;
    if (mediaKind === "video") {
      for (let index = 0; index < value.length; index += 1) {
        const videoLabel = value.length > 1 ? `${label}（第 ${index + 1} 个视频）` : label;
        const frames = await hermesVideoFrameParts(value[index], videoLabel, settings, signal, imageBudgetBytes);
        imageCount += frames.filter((part) => part.type === "image_url").length;
        if (imageCount > hermesImageLimit) throw new Error(`${step.name} 最多支持 ${hermesImageLimit} 张图片或视频帧`);
        parts.push(...frames);
      }
      continue;
    }
    const imageValues = value;
    for (let index = 0; index < imageValues.length; index += 1) {
      throwIfAborted(signal);
      if (imageCount >= hermesImageLimit) throw new Error(`${step.name} 最多支持 ${hermesImageLimit} 张图片或视频帧`);
      const imageUrl = await hermesImageUrl(imageValues[index], settings, signal, imageBudgetBytes);
      imageCount += 1;
      parts.push({ type: "text", text: imageValues.length > 1 ? `${label}（第 ${index + 1} 张）` : label });
      parts.push({ type: "image_url", image_url: { url: imageUrl, detail: "high" } });
    }
  }
  const serializedLength = Buffer.byteLength(JSON.stringify(parts), "utf8");
  if (serializedLength > hermesInlineMediaLimit) {
    throw new Error("Hermes API Server 单次请求上限为 10 MB；附件已按数量压缩后仍超限，请减少附件数量或缩短提示词");
  }
  return parts.some((part) => part.type === "image_url") ? parts : prompt;
}

async function requestHermesChatCompletion(profile: string, connection: HermesApiConnection, content: string | HermesMessagePart[], timeoutMs: number, signal?: AbortSignal, selection?: HermesModelSelection) {
  throwIfAborted(signal);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const abortFromParent = () => controller.abort();
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener("abort", abortFromParent, { once: true });
  }
  try {
    const response = await fetchHermesWithRetry(hermesApiEndpoint(connection.baseUrl, profile, "chat/completions"), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${connection.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        ...hermesRequestModelFields(selection?.provider, selection?.model),
        messages: [{ role: "user", content }],
        stream: false,
      }),
      signal: controller.signal,
    }, { retryHttpStatuses: [] });
    const payload = await response.json().catch(() => null) as unknown;
    const envelope = asRecord(payload);
    if (!response.ok) {
      const apiError = asRecord(envelope?.error);
      const message = typeof apiError?.message === "string" ? apiError.message : typeof envelope?.message === "string" ? envelope.message : `HTTP ${response.status}`;
      if (response.status === 401 || response.status === 403) throw new Error(`Hermes Profile「${profile}」API 密钥认证失败`);
      throw new Error(`Hermes API 请求失败：${message}`);
    }
    const choices = Array.isArray(envelope?.choices) ? envelope.choices : [];
    const choice = asRecord(choices[0]);
    const message = asRecord(choice?.message);
    if (typeof message?.content !== "string") throw new Error("Hermes API 没有返回文本内容");
    return message.content;
  } catch (error) {
    if (signal?.aborted) throw cancellationError();
    if (error instanceof Error && error.name === "AbortError") throw new Error(`Hermes API 请求超时（单步上限 ${workflowTimeoutLabel(timeoutMs / 60 / 1000)}）`);
    if (error instanceof TypeError) throw hermesTransportError(profile, connection, "chat/completions", error);
    throw error;
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", abortFromParent);
  }
}

async function requestHermesCompletion(profile: string, connection: HermesApiConnection, content: string | HermesMessagePart[], timeoutMs = workflowTimeoutMs(defaultWorkflowTimeoutMinutes), signal?: AbortSignal, selection?: HermesModelSelection) {
  throwIfAborted(signal);
  try {
    return await requestHermesRun({
      startUrl: hermesApiEndpoint(connection.baseUrl, profile, "runs"),
      statusUrl: (runId) => hermesApiEndpoint(connection.baseUrl, profile, `runs/${encodeURIComponent(runId)}`),
      stopUrl: (runId) => hermesApiEndpoint(connection.baseUrl, profile, `runs/${encodeURIComponent(runId)}/stop`),
      headers: {
        Authorization: `Bearer ${connection.apiKey}`,
        "Content-Type": "application/json",
      },
      body: {
        ...hermesRequestModelFields(selection?.provider, selection?.model),
        input: [{ role: "user", content }],
      },
      idempotencyKey: randomUUID(),
      timeoutMs,
      signal,
    });
  } catch (error) {
    // Keep compatibility with older Hermes installations. Current Hermes uses
    // /v1/runs, but a 404/405 here should not make existing profiles unusable.
    if (error instanceof HermesRunEndpointUnavailableError) {
      log("warn", "hermes.runs_endpoint_unavailable", { profile, baseUrl: connection.baseUrl, status: error.status });
      return requestHermesChatCompletion(profile, connection, content, timeoutMs, signal, selection);
    }
    if (error instanceof HermesHttpError && (error.status === 401 || error.status === 403)) {
      throw new Error(`Hermes Profile「${profile}」API 密钥认证失败`);
    }
    if (signal?.aborted) throw cancellationError();
    if (error instanceof Error && error.name === "AbortError") throw new Error(`Hermes API 请求超时（单步上限 ${workflowTimeoutLabel(timeoutMs / 60 / 1000)}）`);
    if (error instanceof TypeError) throw hermesTransportError(profile, connection, "runs", error);
    throw error;
  }
}

function coerceHermesOutput(value: unknown, type: string): JsonValue {
  if (type === "text") return typeof value === "string" ? value : JSON.stringify(value) ?? String(value);
  if (type === "number") {
    const parsed = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : NaN;
    if (!Number.isFinite(parsed)) throw new Error("Hermes 输出不是有效数字");
    return parsed;
  }
  if (type === "boolean") {
    if (typeof value === "boolean") return value;
    if (typeof value === "string" && /^(true|false)$/i.test(value.trim())) return value.trim().toLowerCase() === "true";
    throw new Error("Hermes 输出不是有效布尔值");
  }
  if (type === "json") return toJsonValue(typeof value === "string" ? parseHermesJson(value) : value);
  const mediaKind = mediaKindFromWorkflowType(type);
  if (mediaKind) {
    return createRuntimeMediaValue(mediaKind, value);
  }
  return toJsonValue(value);
}

export async function runHermesStep(step: RunStep, inputs: Record<string, JsonValue>, stepValues: Map<string, Record<string, JsonValue>>, types: Map<string, string>, settings: SavedSettings, signal?: AbortSignal, feedback?: HermesFeedbackContext, captureAgentPrompt?: (prompt: string) => Promise<void>, captureAgentResponse?: (response: string) => Promise<void>) {
  throwIfAborted(signal);
  const profile = step.hermesProfile;
  if (!profile || !/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(profile)) throw new Error(`${step.name} 的 Hermes Profile 无效`);
  const selectionError = hermesModelSelectionError(step.hermesProvider, step.hermesModel);
  if (selectionError) throw new Error(`${step.name} 的${selectionError}`);
  const selection: HermesModelSelection = { provider: step.hermesProvider, model: step.hermesModel };
  const outputs = step.outputs ?? [];
  if (!outputs.length) throw new Error(`${step.name} 至少需要定义一个步骤输出`);
  const outputKeys = outputs.map((item) => item.key.trim());
  if (outputKeys.some((key) => !/^[a-zA-Z0-9_]+$/.test(key))) throw new Error(`${step.name} 的输出 key 无效`);
  if (new Set(outputKeys).size !== outputKeys.length) throw new Error(`${step.name} 的输出 key 不能重复`);
  const connection = await readHermesApiConnection(profile);
  const promptTypes = new Map(types);
  for (const input of step.inputs ?? []) if (input.valueSource !== "literal" && input.referenceType && input.sourceRef) promptTypes.set(input.sourceRef, input.referenceType);
  const templatePrompt = resolvePromptTemplate(step.promptTemplate ?? "", inputs, stepValues, promptTypes);
  const stepInputLines = (step.inputs ?? []).flatMap((input) => {
    const type = input.valueSource === "literal" ? input.literalType ?? "text" : types.get(workflowReferenceRoot(input.sourceRef ?? ""));
    if (mediaKindFromWorkflowType(type)) return [];
    const value = input.valueSource === "literal"
      ? parseWorkflowLiteral(input.literalValue, type, input.label ?? input.key)
      : resolveWorkflowValue(input, inputs, stepValues);
    if (value === undefined || workflowMediaValueKind(value, input.referenceType ?? type)) return [];
    const formatted = typeof value === "string" ? value : JSON.stringify(value) ?? String(value);
    return [`${input.label?.trim() || input.key}: ${formatted}`];
  });
  const prompt = stepInputLines.length
    ? `${templatePrompt}\n\n步骤输入：\n${stepInputLines.join("\n")}`
    : templatePrompt;
  if (!prompt.trim()) throw new Error(`${step.name} 的提示词为空`);
  const outputInstructions = outputs.map((item, index) => {
    const description = typeof item.description === "string" ? item.description.trim() : "";
    return `${index + 1}. ${item.key}（${item.label ?? item.key}，类型：${item.type}）${description ? `；说明：${description}` : ""}`;
  }).join("\n");
  const executionPrompt = `${appendHermesFeedback(prompt, feedback)}\n\n输出要求：\n只输出一个 JSON 对象，不要使用 Markdown 代码围栏，不要附加说明。\n回复的第一个字符必须是 {，最后一个字符必须是 }，除该对象外不得出现任何其他内容（包括复核结论、自检报告、完成说明、文件名或路径）。\n字符串内的换行、回车、制表符、双引号和反斜杠必须按 JSON 语法转义，不能直接写入原始控制字符；数组元素与对象成员之间必须有逗号。\n对象必须包含以下字段，字段名必须完全一致：\n${outputInstructions}\n不得输出未声明的字段。`;
  await captureAgentPrompt?.(executionPrompt);
  const content = await hermesMessageContent(step, inputs, stepValues, types, executionPrompt, settings, signal);
  const rawResponse = await requestHermesCompletion(profile, connection, content, workflowTimeoutMs(settings.workflowTimeoutMinutes), signal, selection);
  try {
    const parsed = parseHermesOutput(rawResponse, outputKeys);
    if (parsed.repair) log("warn", "hermes.output_json_repaired", { stepId: step.id, profile, ...parsed.repair });
    const result = parsed.value;
    return Object.fromEntries(outputs.map((item) => {
      const value = result[item.key];
      if (value === undefined) throw new Error(`Hermes 输出缺少字段：${item.key}`);
      return [item.key, coerceHermesOutput(value, item.type)];
    }));
  } catch (error) {
    try {
      await captureAgentResponse?.(rawResponse);
    } catch (captureError) {
      // Never let a persistence failure replace the original Hermes parsing error or log response content.
      log("warn", "hermes.response_capture_failed", { stepId: step.id, profile, errorName: captureError instanceof Error ? captureError.name : typeof captureError });
    }
    throw error;
  }
}
