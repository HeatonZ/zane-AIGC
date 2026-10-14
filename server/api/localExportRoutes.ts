import { Router, type Response } from "express";
import { localExportQuery } from "../domain/localExport.js";
import { HttpError } from "../errors.js";
import type { LocalExportService } from "../services/localExportSettings.js";

function authorize(res: Response) {
  // Fail closed if mounted without the shared identity middleware.
  if (typeof res.locals.authorizeAdmin !== "function") throw new HttpError(403, "需要管理员权限", "ADMIN_REQUIRED");
  res.locals.authorizeAdmin();
}
/** 本地导出根目录是系统单例设置：只有管理员能读写，普通用户永远看不到也改不了。 */
export function createLocalExportRouter(service: LocalExportService) {
  const router = Router();
  router.get("/api/v1/settings/local-export", (req, res) => {
    authorize(res);
    if (!localExportQuery.safeParse(req.query).success) throw new HttpError(400, "此配置是系统单例，不接受查询参数", "INVALID_LOCAL_EXPORT_REQUEST");
    res.set("Cache-Control", "no-store").json(service.read());
  });
  router.patch("/api/v1/settings/local-export", async (req, res) => {
    authorize(res);
    if (!localExportQuery.safeParse(req.query).success) throw new HttpError(400, "不接受查询参数", "INVALID_LOCAL_EXPORT_REQUEST");
    res.set("Cache-Control", "no-store").json(await service.update(req.body, () => authorize(res)));
  });
  return router;
}
