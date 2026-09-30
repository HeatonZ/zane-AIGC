import sharp, { type OverlayOptions } from "sharp";
import { access } from "node:fs/promises";
import type { CommerceProfile, CommerceShotId } from "./profiles.js";
import { commerceShotLabels } from "./profiles.js";
import { throwIfAborted } from "../execution/cancellation.js";

export interface CommerceCopy {
  productName: string;
  sellingPoints: string;
  productSpecs: string;
  packageContents: string;
  visualStyle: string;
  addText: boolean;
}
export function escapeMarkup(text: string) {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

async function textImage(text: string, size: number, width: number, maxHeight: number, color: string, bold: boolean) {
  const fontfile = process.env.ZANE_COMMERCE_FONT_FILE;
  if (fontfile) await access(fontfile).catch(() => { throw new Error("ZANE_COMMERCE_FONT_FILE指定的字体文件不存在"); });
  const markup = `<span foreground="${color}">${bold ? "<b>" : ""}${escapeMarkup(text)}${bold ? "</b>" : ""}</span>`;
  for (let fontSize = size; fontSize >= Math.floor(size * .55); fontSize -= 4) {
    const rendered = await sharp({ text: { text: markup, font: `Microsoft YaHei ${fontSize}`, ...(fontfile ? { fontfile } : {}), width, rgba: true, spacing: Math.round(fontSize * .2), wrap: "word-char" } }).png().toBuffer({ resolveWithObject: true });
    if (rendered.info.height <= maxHeight) return rendered;
  }
  throw new Error("文案过长，无法在安全区域内完整排版，请缩短该图文案或增加画布尺寸");
}

export async function composeCommerceImage(source: Buffer, profile: CommerceProfile, shot: CommerceShotId, copy: CommerceCopy, signal?: AbortSignal) {
  throwIfAborted(signal);
  const whiteHero = profile.whiteHero && shot === "hero";
  const showText = copy.addText && profile.showText && !whiteHero;
  const background = whiteHero ? "#ffffff" : copy.visualStyle === "暖调家居" ? "#faf3e9" : copy.visualStyle === "自然生活" ? "#f0f4e9" : copy.visualStyle === "冷静科技" ? "#eef2f7" : "#fafaf7";
  const { width, height, safeMargin: margin } = profile;
  const shortSide = Math.min(width, height);
  const titleArea = showText ? Math.round(shortSide * .16) : 0;
  const footerArea = showText ? Math.round(shortSide * .18) : 0;
  const imageWidth = width - 2 * margin;
  const imageHeight = height - 2 * margin - titleArea - footerArea;
  const image = await sharp(source, { limitInputPixels: 32_000_000, failOn: "error" }).rotate().toColourspace("srgb").resize(imageWidth, imageHeight, { fit: "contain", background }).png().toBuffer();
  throwIfAborted(signal);
  const overlays: OverlayOptions[] = [{ input: image, left: margin, top: margin + titleArea }];
  if (showText) {
    const titleSize = Math.max(24, Math.round(shortSide * .045));
    const title = await textImage(copy.productName, titleSize, imageWidth, titleArea - 8, "#263522", true);
    overlays.push({ input: title.data, left: margin, top: margin });
    const lines = shot === "specs" ? copy.productSpecs : shot === "package" ? copy.packageContents : shot === "selling_point" ? copy.sellingPoints : "";
    const caption = [commerceShotLabels[shot], lines].filter(Boolean).join("\n");
    const text = await textImage(caption, Math.round(shortSide * .022), imageWidth, footerArea, "#45523f", false);
    overlays.push({ input: text.data, left: margin, top: height - margin - footerArea });
  }
  throwIfAborted(signal);
  const bytes = await sharp({ create: { width, height, channels: 3, background } }).composite(overlays).jpeg({ quality: 95, chromaSubsampling: "4:4:4" }).toBuffer();
  const metadata = await sharp(bytes).metadata();
  if (metadata.width !== width || metadata.height !== height || metadata.format !== "jpeg") throw new Error("成图尺寸或格式校验失败");
  throwIfAborted(signal);
  return { bytes, hasText: showText, whiteHero, qa: { width, height, format: "jpeg", dimensionsMatch: true, subjectFit: "contain-no-crop", textSource: showText ? "user-input-only" : "none", requiresHumanReview: true } };
}

