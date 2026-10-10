import { createHash } from "node:crypto";
import { mkdir, readdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { HttpError } from "../errors.js";

/** Display-only derivative for private media. Never used for execution, export or archiving. */
export const defaultPreviewWidth = 512;
export const minimumPreviewWidth = 16;
export const maximumPreviewWidth = 2048;
const previewCacheLimit = 4000;

/** Raised when a source is not a rasterizable image; callers fall back to the original bytes. */
export class PreviewUnavailableError extends Error {}

export function previewWidth(raw: unknown): number {
  if (raw === undefined) return defaultPreviewWidth;
  const numeric = typeof raw === "number" ? raw : typeof raw === "string" && raw.trim() ? Number(raw) : NaN;
  if (!Number.isSafeInteger(numeric) || numeric < minimumPreviewWidth || numeric > maximumPreviewWidth) throw new HttpError(400, `预览宽度必须是 ${minimumPreviewWidth} 到 ${maximumPreviewWidth} 的整数`, "INVALID_PREVIEW_WIDTH");
  return numeric;
}

/**
 * Resolve (and on demand render) the WebP display derivative of a local media file.
 * Run media and asset blobs are immutable, so the cache key covers path, mtime, size and width.
 * Concurrent requests for the same derivative share one render (single flight).
 */
export async function mediaPreviewFile(projectDirectory: string, source: string, width: number): Promise<string> {
  const info = await stat(source).catch(() => undefined);
  if (!info?.isFile()) throw new HttpError(404, "没有找到媒体文件", "MEDIA_NOT_FOUND");
  const digest = createHash("sha256").update([path.resolve(source), info.mtimeMs, info.size, width].join("|")).digest("hex");
  const directory = path.join(projectDirectory, ".zane", "previews");
  const target = path.join(directory, digest + ".webp");
  const inFlight = pending.get(target);
  if (inFlight) return inFlight;
  const task = (async () => {
    if ((await stat(target).catch(() => undefined))?.isFile()) return target;
    const derivative = await sharp(source, { limitInputPixels: 268_402_688, failOn: "error" })
      .rotate()
      .resize({ width, fit: "inside", withoutEnlargement: true })
      .webp({ quality: 82 })
      .toBuffer()
      .catch(() => { throw new PreviewUnavailableError("此媒体不支持预览缩放"); });
    await mkdir(directory, { recursive: true });
    const temporary = `${target}.${process.pid}.${createHash("sha256").update(target + Math.random()).digest("hex").slice(0, 12)}.tmp`;
    await writeFile(temporary, derivative);
    await rename(temporary, target);
    void trimPreviewCache(directory);
    return target;
  })();
  pending.set(target, task);
  try { return await task; } finally { pending.delete(target); }
}
const pending = new Map<string, Promise<string>>();

/** Best-effort housekeeping so a long-lived workbench cannot grow previews without bound. */
async function trimPreviewCache(directory: string) {
  try {
    const entries = await readdir(directory, { withFileTypes: true });
    if (entries.length <= previewCacheLimit) return;
    const files = await Promise.all(entries.filter(entry => entry.isFile()).map(async entry => ({ name: entry.name, mtimeMs: (await stat(path.join(directory, entry.name))).mtimeMs })));
    files.sort((first, second) => first.mtimeMs - second.mtimeMs);
    for (const file of files.slice(0, files.length - Math.floor(previewCacheLimit * 0.9))) await unlink(path.join(directory, file.name)).catch(() => undefined);
  } catch { /* housekeeping must never break a media read */ }
}
