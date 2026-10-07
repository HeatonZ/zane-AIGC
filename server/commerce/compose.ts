import type { CommerceProfile, CommerceShotId } from "./profiles.js";
import { commerceShotLabels } from "./profiles.js";
import { composeImageLayout } from "../services/imageLayoutService.js";
export { escapeMarkup } from "../services/imageLayoutService.js";

export interface CommerceCopy {
  productName: string;
  sellingPoints: string;
  productSpecs: string;
  packageContents: string;
  visualStyle: string;
  addText: boolean;
}
/** Compatibility policy wrapper; all image rendering is the shared basic layout service. */
export async function composeCommerceImage(source: Buffer, profile: CommerceProfile, shot: CommerceShotId, copy: CommerceCopy, signal?: AbortSignal) {
  const whiteHero = profile.whiteHero && shot === "hero";
  const showText = copy.addText && profile.showText && !whiteHero;
  const background = whiteHero ? "#ffffff" : copy.visualStyle === "暖调家居" ? "#faf3e9" : copy.visualStyle === "自然生活" ? "#f0f4e9" : copy.visualStyle === "冷静科技" ? "#eef2f7" : "#fafaf7";
  const lines = shot === "specs" ? copy.productSpecs : shot === "package" ? copy.packageContents : shot === "selling_point" ? copy.sellingPoints : "";
  const rendered = await composeImageLayout(source, { width: profile.width, height: profile.height, margin: profile.safeMargin, background, title: showText ? copy.productName : "", caption: showText ? [commerceShotLabels[shot], lines].filter(Boolean).join("\n") : "" }, signal);
  return { ...rendered, hasText: showText, whiteHero, qa: { ...rendered.qa, textSource: showText ? "user-input-only" : "none" } };
}
