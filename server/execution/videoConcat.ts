import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, mkdtemp, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import { execFileAsync, ffmpegBinary, ffprobeBinary, workflowTimeoutMs } from "../config.js";
import { isRunId, runArtifactPaths } from "../artifacts/runArtifacts.js";
import { asRecord, resolveStepInputs } from "../domain/workflowValues.js";
import type { JsonValue } from "../domain/types.js";
import { createRuntimeMediaValue, runtimeMediaItems, type RuntimeMediaItem } from "../runtimeValue.js";
import type { StepExecutionContext } from "./workflowExecutor.js";
import { throwIfAborted } from "./cancellation.js";

const maxClipBytes = 2_000_000_000;
const archiveUrl = /^\/api\/(?:workflows|v1)\/runs\/([^/]+)\/media\/([A-Za-z0-9_-][A-Za-z0-9._-]*)$/;

async function copySource(item: RuntimeMediaItem, destination: string, context: StepExecutionContext) {
  throwIfAborted(context.signal);
  const locator = item.locator;
  let url: string | undefined;
  let source: string | undefined;
  // Resumed outputs may retain their original Comfy filename but point at a durable archive.
  const archived = archiveUrl.exec(item.previewUrl ?? (locator.type === "comfy" ? "" : locator.value));
  if (archived) {
    if (!isRunId(archived[1]) || archived[2].includes("..")) throw new Error("视频片段归档路径无效");
    source = path.join(runArtifactPaths(context.settings.projectDirectory, archived[1]).directory, "outputs", "media", archived[2]);
  } else if (locator.type === "comfy") {
    if (!locator.filename || /[\\/]/.test(locator.filename) || locator.filename === "." || locator.filename === ".." || locator.subfolder.startsWith("/") || locator.subfolder.startsWith("\\") || locator.subfolder.split(/[\\/]/).some((part) => part === "." || part === "..")) throw new Error("视频片段的 ComfyUI 文件路径无效");
    const params = new URLSearchParams({ filename: locator.filename, subfolder: locator.subfolder, type: locator.location });
    url = `${context.settings.comfyuiBaseUrl.replace(/\/+$/, "")}/view?${params}`;
  } else {
    if (locator.type === "path") source = path.resolve(locator.value);
    else if (/^https?:\/\//i.test(locator.value)) url = locator.value;
    else throw new Error("视频拼接仅支持 ComfyUI 片段、本地文件或已归档视频");
  }
  if (source) {
    const info = await stat(source);
    if (!info.isFile() || info.size > maxClipBytes) throw new Error("视频片段不是文件或超过2GB限制");
    await pipeline(createReadStream(source), createWriteStream(destination, { flags: "wx" }), { signal: context.signal });
    return;
  }
  const signal = AbortSignal.any([context.signal, AbortSignal.timeout(300000)]);
  const response = await fetch(url!, { signal });
  if (!response.ok || !response.body) throw new Error(`无法读取视频片段（HTTP ${response.status}）`);
  if (Number(response.headers.get("content-length")) > maxClipBytes) {
    await response.body.cancel();
    throw new Error("视频片段超过2GB限制");
  }
  let received = 0;
  const limit = new Transform({ transform(chunk: Buffer, _encoding, callback) {
    received += chunk.length;
    callback(received > maxClipBytes ? new Error("视频片段超过2GB限制") : null, chunk);
  } });
  await pipeline(Readable.fromWeb(response.body as unknown as NodeReadableStream), limit, createWriteStream(destination, { flags: "wx" }), { signal });
}

export interface VideoClipInfo { width: number; height: number; duration: number; audio: boolean }
export async function probeVideoClip(filename: string, signal?: AbortSignal): Promise<VideoClipInfo> {
  const { stdout } = await execFileAsync(ffprobeBinary, ["-v", "error", "-show_streams", "-show_format", "-of", "json", filename], { signal, timeout: 30000, windowsHide: true, maxBuffer: 2_000_000 });
  const payload = JSON.parse(stdout) as { streams?: Array<Record<string, unknown>>; format?: Record<string, unknown> };
  const video = payload.streams?.find((stream) => stream.codec_type === "video");
  const duration = Number(video?.duration ?? payload.format?.duration);
  const width = Number(video?.width), height = Number(video?.height);
  if (!Number.isFinite(duration) || duration <= 0 || !Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 2 || height < 2 || width > 8192 || height > 8192) throw new Error("视频片段缺少有效的画面、时长或分辨率");
  return { width, height, duration, audio: Boolean(payload.streams?.some((stream) => stream.codec_type === "audio")) };
}

export function normalizationArgs(source: string, output: string, info: VideoClipInfo, width: number, height: number) {
  return ["-hide_banner", "-loglevel", "error", "-y", "-i", source,
    ...(!info.audio ? ["-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo"] : []),
    "-map", "0:v:0", "-map", info.audio ? "0:a:0" : "1:a:0",
    "-vf", `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=24`,
    "-af", "aresample=48000:async=1:first_pts=0,apad", "-t", String(info.duration),
    "-c:v", "libx264", "-preset", "fast", "-crf", "18", "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-ac", "2", "-threads", "2",
    "-video_track_timescale", "24000", "-movflags", "+faststart", output];
}

/** Deterministic editing, not an LLM frame-only request. Never adds music or revoices dialogue. */
export async function runVideoConcatStep(context: StepExecutionContext): Promise<Record<string, JsonValue>> {
  const input = resolveStepInputs(context.step, context.inputValues, context.stepValues);
  const clips = runtimeMediaItems(input.clips, "video");
  if (!clips.length || clips.length > 360) throw new Error("视频拼接需要1到360个视频片段");
  const shots = input.shots;
  if (!Array.isArray(shots) || shots.length !== clips.length || shots.some((shot, index) => asRecord(shot)?.index !== index + 1)) throw new Error("视频片段数量/顺序与制作分镜不符，不能静默漏掉片段或拼接乱序");
  throwIfAborted(context.signal);
  const directory = path.resolve(context.artifacts.directory, "outputs", "media");
  await mkdir(directory, { recursive: true });
  const temporary = path.resolve(await mkdtemp(path.join(directory, ".long-text-concat-")));
  // Check before any recursive cleanup; only our mkdtemp child is ever removed.
  if (path.dirname(temporary) !== directory) throw new Error("视频拼接临时目录不在当前任务输出目录内");
  const timeout = workflowTimeoutMs(context.settings.workflowTimeoutMinutes);
  const signal = AbortSignal.any([context.signal, AbortSignal.timeout(timeout)]);
  const workContext = { ...context, signal };
  try {
    const rows: Array<VideoClipInfo & { index: number }> = [];
    const normalized: string[] = [];
    let width = 0, height = 0;
    for (let index = 0; index < clips.length; index += 1) {
      throwIfAborted(signal);
      const source = path.join(temporary, `source-${index + 1}.mp4`);
      await copySource(clips[index], source, workContext);
      const info = await probeVideoClip(source, signal);
      if (index === 0) { width = Math.ceil(info.width / 2) * 2; height = Math.ceil(info.height / 2) * 2; }
      const filename = `clip-${String(index + 1).padStart(4, "0")}.mp4`;
      await execFileAsync(ffmpegBinary, normalizationArgs(source, path.join(temporary, filename), info, width, height), { signal, timeout, windowsHide: true, maxBuffer: 2_000_000 });
      rows.push({ index: index + 1, ...info });
      normalized.push(filename);
      await rm(source);
    }
    // Only generated ASCII basenames enter the concat list; paths from inputs cannot become directives.
    await writeFile(path.join(temporary, "clips.txt"), normalized.map((filename) => `file '${filename}'`).join("\n"), "utf8");
    const joined = path.join(temporary, "joined.mp4");
    await execFileAsync(ffmpegBinary, ["-hide_banner", "-loglevel", "error", "-y", "-f", "concat", "-safe", "1", "-i", "clips.txt", "-map", "0:v:0", "-map", "0:a:0", "-c", "copy", "-movflags", "+faststart", joined], { cwd: temporary, signal, timeout, windowsHide: true, maxBuffer: 2_000_000 });
    const finalInfo = await probeVideoClip(joined, signal);
    const filename = `${randomUUID()}-long-text-video.mp4`;
    await rename(joined, path.join(directory, filename));
    const url = `/api/v1/runs/${context.runId}/media/${filename}`;
    return {
      video: createRuntimeMediaValue("video", [{ url }]) as unknown as JsonValue,
      download: url,
      manifest: { format: "zane.long-text-video/v1", clips: rows.map((row) => ({ ...row })), count: clips.length, fps: 24, width, height, duration_seconds: finalInfo.duration, music_added: false, native_audio_preserved: true },
    };
  } catch (error) {
    throwIfAborted(context.signal);
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error("视频拼接需要可用的 FFmpeg/FFprobe，请检查 FFMPEG_BIN 和 FFPROBE_BIN 配置", { cause: error });
    if (signal.aborted) throw new Error("视频拼接超时，请检查片段长度或提高单步超时", { cause: error });
    throw error;
  } finally {
    if (path.dirname(temporary) === directory) await rm(temporary, { recursive: true, force: true });
  }
}
