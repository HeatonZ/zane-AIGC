import sharp, { type OverlayOptions } from "sharp";
import { access } from "node:fs/promises";
import { imageLayoutSchema } from "../domain/imageLayoutContracts.js";
import { throwIfAborted } from "../execution/cancellation.js";

export function escapeMarkup(text: string) {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}
export function prepareImageLayout(value: unknown) {
  const parsed = imageLayoutSchema.safeParse(value);
  if (!parsed.success) {
    if (parsed.error.issues.some((issue) => issue.code === "too_big" && (issue.path[0] === "title" || issue.path[0] === "caption"))) throw new Error("文案过长，标题/正文各最多2000字；不会截断");
    throw new Error("图片排版参数无效：需要64至8192的整数宽高、合法颜色和文本");
  }
  const layout = parsed.data;
  const shortSide = Math.min(layout.width, layout.height);
  const titleHeight = layout.title ? layout.titleHeight ?? Math.round(shortSide * .16) : 0;
  const captionHeight = layout.caption ? layout.captionHeight ?? Math.round(shortSide * .18) : 0;
  if (layout.width * layout.height > 32_000_000 || layout.margin > shortSide / 4 || layout.width - 2 * layout.margin < 1 || layout.height - 2 * layout.margin - titleHeight - captionHeight < 1 || (layout.title && titleHeight <= 8) || (layout.caption && captionHeight <= 0)) throw new Error("图片排版安全留白/文字区域/画布像素数无效");
  return { ...layout, titleHeight, captionHeight };
}
async function textImage(text: string, size: number, width: number, maxHeight: number, color: string, bold: boolean, signal?: AbortSignal) {
  const fontfile = process.env.ZANE_IMAGE_FONT_FILE || process.env.ZANE_COMMERCE_FONT_FILE;
  if (fontfile) await access(fontfile).catch(() => { throw new Error("图片字体文件不存在"); });
  const markup = '<span foreground="' + color + '">' + (bold ? "<b>" : "") + escapeMarkup(text) + (bold ? "</b>" : "") + "</span>";
  for (let fontSize = size; fontSize >= Math.floor(size * .55); fontSize -= 4) {
    throwIfAborted(signal);
    const rendered = await sharp({ text: { text: markup, font: "Microsoft YaHei " + fontSize, ...(fontfile ? { fontfile } : {}), width, rgba: true, spacing: Math.round(fontSize * .2), wrap: "word-char" } }).png().toBuffer({ resolveWithObject: true });
    if (rendered.info.height <= maxHeight) return rendered;
  }
  throw new Error("文案过长，无法在安全区域内完整排版，请缩短文案或增加画布尺寸");
}
/** Shared deterministic image processing; contains no product/platform/shot policy. */
export async function composeImageLayout(source: Buffer, value: unknown, signal?: AbortSignal) {
  const layout = prepareImageLayout(value);
  const { width, height, margin, background, titleHeight, captionHeight } = layout;
  throwIfAborted(signal);
  const shortSide = Math.min(width, height);
  const imageWidth = width - 2 * margin;
  const imageHeight = height - 2 * margin - titleHeight - captionHeight;
  const image = await sharp(source, { limitInputPixels: 32_000_000, failOn: "error" }).rotate().toColourspace("srgb").resize(imageWidth, imageHeight, { fit: "contain", background }).png().toBuffer();
  throwIfAborted(signal);
  const overlays: OverlayOptions[] = [{ input: image, left: margin, top: margin + titleHeight }];
  if (layout.title) {
    const title = await textImage(layout.title, Math.max(24, Math.round(shortSide * .045)), imageWidth, titleHeight - 8, "#263522", true, signal);
    overlays.push({ input: title.data, left: margin, top: margin });
  }
  if (layout.caption) {
    const caption = await textImage(layout.caption, Math.max(1, Math.round(shortSide * .022)), imageWidth, captionHeight, "#45523f", false, signal);
    overlays.push({ input: caption.data, left: margin, top: height - margin - captionHeight });
  }
  throwIfAborted(signal);
  const bytes = await sharp({ create: { width, height, channels: 3, background } }).composite(overlays).jpeg({ quality: 95, chromaSubsampling: "4:4:4" }).toBuffer();
  const metadata = await sharp(bytes).metadata();
  if (metadata.width !== width || metadata.height !== height || metadata.format !== "jpeg") throw new Error("成图尺寸或格式校验失败");
  throwIfAborted(signal);
  return { bytes, layout, hasText: Boolean(layout.title || layout.caption), qa: { width, height, format: "jpeg", dimensionsMatch: true, subjectFit: "contain-no-crop", textSource: layout.title || layout.caption ? "provided-text-only" : "none", requiresHumanReview: true } };
}
export type { ImageLayout } from "../domain/imageLayoutContracts.js";
