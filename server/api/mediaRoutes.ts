import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { Router } from "express";
import type { SavedSettings } from "../domain/types.js";
import { isRunId, runArtifactPaths } from "../artifacts/runArtifacts.js";
import { HttpError } from "../errors.js";
import { enablePrivateMediaRevalidation } from "./privateMediaCache.js";

/** Stream media instead of buffering complete videos in the API process. */
export function createMediaRouter(loadSettings: () => Promise<SavedSettings>, timeoutMs = 300000) {
  const router = Router();
  router.get(["/api/workflows/runs/:runId/media/:filename", "/api/v1/runs/:runId/media/:filename"], async (request, response, next) => {
    const settings = await loadSettings();
    const { runId, filename } = request.params;
    if (typeof runId !== "string" || typeof filename !== "string" || !isRunId(runId) || !/^[A-Za-z0-9_-][A-Za-z0-9._-]*$/.test(filename) || filename.includes("..")) throw new HttpError(400, "归档媒体路径无效");
    if (!settings.projectDirectory) throw new HttpError(404, "项目目录未配置");
    const directory = path.resolve(runArtifactPaths(settings.projectDirectory, runId).directory, "outputs", "media");
    const file = path.resolve(directory, filename);
    if (!file.startsWith(`${directory}${path.sep}`)) throw new HttpError(400, "归档媒体路径无效");
    // sendFile handles Content-Length, HEAD, Range and If-Range without a readFile buffer.
    enablePrivateMediaRevalidation(response);
    response.sendFile(file, { dotfiles: "allow", cacheControl: false, etag: true, lastModified: true }, (error) => {
      if (!error) return;
      if (response.headersSent) { next(error); return; }
      if ((error as NodeJS.ErrnoException).code === "ENOENT" || (error as { status?: number }).status === 404) response.status(404).json({ error: "没有找到归档媒体文件" });
      else next(error);
    });
  });
  router.get("/api/comfyui/view", async (request, response) => {
    const settings = await loadSettings();
    const filename = typeof request.query.filename === "string" ? request.query.filename : "";
    const subfolder = typeof request.query.subfolder === "string" ? request.query.subfolder : "";
    const type = typeof request.query.type === "string" ? request.query.type : "output";
    if (!settings.comfyuiBaseUrl || !filename || filename.includes("..") || subfolder.includes("..")) throw new HttpError(400, "ComfyUI 媒体参数无效");
    const query = new URLSearchParams({ filename, subfolder, type });
    const controller = new AbortController();
    const disconnected = () => { if (!response.writableFinished) controller.abort("媒体客户端已断开"); };
    response.once("close", disconnected);
    const timeout = setTimeout(() => controller.abort("媒体读取超时"), timeoutMs);
    try {
      const headers: Record<string, string> = { "Accept-Encoding": "identity" };
      for (const name of ["Range", "If-Range"]) { const value = request.get(name); if (value) headers[name] = value; }
      const upstream = await fetch(`${settings.comfyuiBaseUrl}/view?${query}`, { headers, signal: controller.signal });
      if (!upstream.ok) {
        const range = upstream.headers.get("content-range"); if (range) response.set("Content-Range", range);
        response.status(upstream.status).json({ error: "无法读取 ComfyUI 输出媒体" });
        await upstream.body?.cancel();
        return;
      }
      response.status(upstream.status);
      for (const name of ["content-type", "accept-ranges", "content-range", "etag", "last-modified"]) {
        const value = upstream.headers.get(name); if (value) response.set(name, value);
      }
      const length = upstream.headers.get("content-length");
      if (length && !upstream.headers.get("content-encoding")) response.set("Content-Length", length);
      if (!upstream.body) { response.end(); return; }
      await pipeline(Readable.fromWeb(upstream.body as unknown as NodeReadableStream<Uint8Array>), response, { signal: controller.signal });
    } catch (error) {
      if (!response.destroyed) {
        if (response.headersSent) response.destroy(error instanceof Error ? error : undefined);
        else response.status(502).json({ error: "读取 ComfyUI 输出媒体失败" });
      }
    } finally { clearTimeout(timeout); response.off("close", disconnected); }
  });
  return router;
}
