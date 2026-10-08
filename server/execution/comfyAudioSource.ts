import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { mediaContentTypeExtension } from "../artifacts/runArtifacts.js";
import { asRecord } from "../domain/workflowValues.js";

export type ComfyAudioSource =
  | { kind: "attachment"; value: Record<string, unknown> }
  | { kind: "bytes"; bytes: Buffer; filename: string; contentType: string };
export interface ComfyAudioSourceOptions {
  stepName: string;
  limitBytes: number;
  signal?: AbortSignal;
  readRemote(url: string): Promise<{ bytes: Buffer; contentType?: string }>;
  readComfy(media: Record<string, unknown>): Promise<{ bytes: Buffer; contentType?: string }>;
  mimeTypeForPath(filename: string, fallback: string): string;
}

/** Consume already-authorized execution media, never an asset preview credential.
 * A fixed asset's private path remains authoritative after media selection/zip. */
export async function readComfyAudioSource(value: unknown, options: ComfyAudioSourceOptions): Promise<ComfyAudioSource> {
  const { stepName, limitBytes, signal } = options;
  const mimeTypeForMediaPath = options.mimeTypeForPath;
  signal?.throwIfAborted();
  const media = asRecord(value);
  const localPath = typeof media?.path === "string" && media.path.trim() ? media.path.trim() : undefined;
  if (!localPath && media?.type === "input" && typeof media.id === "string" && typeof media.filename === "string" && typeof media.subfolder === "string" && typeof media.url === "string") return { kind: "attachment", value: media };
  let filename = "input.wav", contentType = "audio/wav", bytes: Buffer;
  const source = localPath ?? (typeof value === "string" ? value.trim() : typeof media?.url === "string" ? media.url.trim() : "");
  if (!localPath && typeof media?.filename === "string" && (media.type === "input" || media.type === "output")) {
    filename = path.basename(media.filename) || filename;
    const fetched = await options.readComfy(media);
    bytes = fetched.bytes; contentType = fetched.contentType || mimeTypeForMediaPath(filename, contentType);
  } else if (/^data:audio\//i.test(source)) {
    const match = /^data:(audio\/[a-z0-9.+-]+);base64,([a-z0-9+/=\s]+)$/i.exec(source);
    if (!match) throw new Error(`${stepName} 的音频 data URL 格式无效`);
    bytes = Buffer.from(match[2].replace(/\s/g, ""), "base64");
    contentType = match[1]; filename = `input${mediaContentTypeExtension(contentType)}`;
  } else if (/^https?:\/\//i.test(source)) {
    filename = path.basename(new URL(source).pathname) || filename;
    const fetched = await options.readRemote(source);
    bytes = fetched.bytes; contentType = fetched.contentType || mimeTypeForMediaPath(filename, contentType);
  } else if (source) {
    const file = path.resolve(source), info = await stat(file).catch(() => undefined);
    signal?.throwIfAborted();
    if (!info?.isFile()) throw new Error(`${stepName} 无法读取音频文件：${source}`);
    if (info.size > limitBytes) throw new Error(`${stepName} 的音频超过大小限制`);
    bytes = await readFile(file, { signal }); filename = path.basename(file);
    contentType = mimeTypeForMediaPath(filename, contentType);
  } else throw new Error(`${stepName} 的音频输入缺少可读取的路径、URL 或 ComfyUI 附件`);
  signal?.throwIfAborted();
  if (bytes.length > limitBytes) throw new Error(`${stepName} 的音频超过大小限制`);
  return { kind: "bytes", bytes, filename, contentType };
}
