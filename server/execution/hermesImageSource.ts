import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { mediaContentTypeExtension } from "../artifacts/runArtifacts.js";
import { asRecord } from "../domain/workflowValues.js";

export type HermesImageSource =
  | { kind: "url"; url: string }
  | { kind: "bytes"; bytes: Buffer; filename: string; contentType?: string };
export interface HermesImageSourceOptions {
  sourceLimitBytes: number;
  signal?: AbortSignal;
  readComfy(media: Record<string, unknown>): Promise<{ bytes: Buffer; contentType?: string }>;
}

/** Consume the already-authorized, normalized execution input, not previewUrl.
 * Fixed asset references retain {assetId, assetVersion, path} after archival.
 * Both plain paths and that structured shape use the same bounded file reader. */
export async function readHermesImageSource(value: unknown, options: HermesImageSourceOptions): Promise<HermesImageSource> {
  const { sourceLimitBytes, signal } = options;
  signal?.throwIfAborted();
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (/^data:image\//i.test(trimmed)) {
      const match = /^data:(image\/[a-z0-9.+-]+);base64,([a-z0-9+/=\s]+)$/i.exec(trimmed);
      if (!match) return { kind: "url", url: trimmed }; // Preserve legacy data-URL semantics.
      const bytes = Buffer.from(match[2].replace(/\s/g, ""), "base64");
      if (bytes.length > sourceLimitBytes) throw new Error("Hermes 图片原文件超过 100 MB 限制");
      return { kind: "bytes", bytes, filename: `input${mediaContentTypeExtension(match[1])}`, contentType: match[1] };
    }
    if (/^https?:\/\//i.test(trimmed)) return { kind: "url", url: trimmed };
    if (!trimmed) throw new Error("图片输入为空");
    const filename = path.resolve(trimmed);
    const info = await stat(filename).catch(() => undefined);
    signal?.throwIfAborted();
    if (!info?.isFile()) throw new Error(`无法读取图片文件：${trimmed}`);
    if (info.size > sourceLimitBytes) throw new Error("Hermes 图片原文件超过 100 MB 限制");
    const bytes = await readFile(filename, { signal });
    if (bytes.length > sourceLimitBytes) throw new Error("Hermes 图片原文件超过 100 MB 限制");
    return { kind: "bytes", bytes, filename };
  }
  const media = asRecord(value);
  if (!media) throw new Error("Hermes 图片输入格式无效");
  // A resolved fixed asset's path is authoritative. Do not fetch its authenticated
  // display URL, or mistake display metadata for a ComfyUI attachment.
  if (typeof media.path === "string" && media.path.trim()) return readHermesImageSource(media.path, options);
  if (typeof media.filename === "string") {
    const source = await options.readComfy(media);
    signal?.throwIfAborted();
    if (source.bytes.length > sourceLimitBytes) throw new Error("Hermes 图片原文件超过 100 MB 限制");
    return { kind: "bytes", filename: media.filename, ...source };
  }
  if (typeof media.url === "string" && /^https?:\/\//i.test(media.url)) return { kind: "url", url: media.url };
  throw new Error("Hermes 图片输入缺少可读取的文件或 URL");
}
