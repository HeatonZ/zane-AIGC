import { Router } from "express";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { storeZip } from "../artifacts/zip.js";
import { runMediaExportQuery, runMediaArchiveQuery } from "../domain/runMediaExportContracts.js";
import { RunMediaExportService } from "../services/runMediaExportService.js";
import { HttpError } from "../errors.js";
export function createRunMediaExportRouter(service: RunMediaExportService) {
  const router = Router();
  for (const prefix of ["/api/v1/runs", "/api/v1/self/runs"]) {
    const self = prefix.includes("/self/");
    router.get(prefix + "/:runId/media-export", async (req, res) => {
      const query = runMediaExportQuery.safeParse(req.query);
      if (!query.success) throw new HttpError(400, "媒体导出参数无效", "INVALID_MEDIA_EXPORT");
      res.set("Cache-Control", "no-store");
      const result = await service.prepare(String(req.params.runId), query.data, res.locals.authorizeRunMedia, self);
      res.json(result.data);
    });
    router.get(prefix + "/:runId/media.zip", async (req, res) => {
      const query = runMediaArchiveQuery.safeParse(req.query);
      if (!query.success) throw new HttpError(400, "下载需要媒体输出及当前revision", "INVALID_MEDIA_EXPORT");
      const { revision, ...selection } = query.data;
      const result = await service.prepare(String(req.params.runId), selection, res.locals.authorizeRunMedia, self);
      if (revision !== result.data.revision) throw new HttpError(409, "导出内容已变化，请重新读取导出信息", "MEDIA_EXPORT_CHANGED", { currentRevision: result.data.revision, nextAction: "get_run_media_export" });
      res.set({ "Content-Type": "application/zip", "Content-Disposition": 'attachment; filename="run-media-' + req.params.runId + '.zip"', "Cache-Control": "no-store" });
      if (req.method === "HEAD") { res.end(); return; }
      const controller = new AbortController(); const disconnect = () => { if (!res.writableFinished) controller.abort(); };
      res.once("close", disconnect);
      try { await pipeline(Readable.from(storeZip(result.entries, controller.signal)), res, { signal: controller.signal }); }
      finally { res.off("close", disconnect); }
    });
  }
  return router;
}
