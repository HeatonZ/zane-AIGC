import type { NextFunction, Response } from "express";
import { mediaPreviewFile, PreviewUnavailableError } from "../services/mediaPreview.js";
import { enablePrivateMediaRevalidation } from "./privateMediaCache.js";

const previewHeaders = { "X-Content-Type-Options": "nosniff", "Content-Security-Policy": "default-src 'none'; sandbox" };

/**
 * Serve private media bytes, or their WebP display derivative when a width is requested.
 * Derivatives are display-only: a missing source stays 404, a non-rasterizable source
 * (video/audio) falls back to the original bytes so one route covers every media kind.
 */
export async function sendPrivateMedia(response: Response, file: string, width: number | undefined, projectDirectory: string, next: NextFunction) {
  enablePrivateMediaRevalidation(response);
  const original = (error: unknown) => {
    if (!error) return;
    if (response.headersSent) { next(error); return; }
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || (error as { status?: number }).status === 404) { response.status(404).json({ error: "没有找到媒体文件" }); return; }
    next(error);
  };
  if (width !== undefined) {
    try {
      const derivative = await mediaPreviewFile(projectDirectory, file, width);
      response.sendFile(derivative, { dotfiles: "allow", cacheControl: false, etag: true, lastModified: true, headers: previewHeaders }, original);
      return;
    } catch (error) {
      if (!(error instanceof PreviewUnavailableError)) { original(error); return; }
    }
  }
  response.sendFile(file, { dotfiles: "allow", cacheControl: false, etag: true, lastModified: true, headers: previewHeaders }, original);
}
