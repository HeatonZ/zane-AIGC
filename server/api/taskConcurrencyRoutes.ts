import { Router, type Response } from "express";
import { taskConcurrencyQuery } from "../domain/taskConcurrencyContracts.js";
import { HttpError } from "../errors.js";
import type { TaskConcurrencyService } from "../services/taskConcurrencyService.js";

function authorize(res: Response) {
  // Fail closed if mounted without the shared identity middleware.
  if (typeof res.locals.authorizeAdmin !== "function") throw new HttpError(403, "需要管理员权限", "ADMIN_REQUIRED");
  res.locals.authorizeAdmin();
}
export function createTaskConcurrencyRouter(service: TaskConcurrencyService) {
  const router = Router();
  router.get("/api/v1/settings/task-concurrency", (req, res) => {
    authorize(res);
    if (!taskConcurrencyQuery.safeParse(req.query).success) throw new HttpError(400, "此配置是系统单例，不接受查询参数", "INVALID_TASK_CONCURRENCY_REQUEST");
    res.set("Cache-Control", "no-store").json(service.read());
  });
  router.patch("/api/v1/settings/task-concurrency", (req, res) => {
    authorize(res);
    if (!taskConcurrencyQuery.safeParse(req.query).success) throw new HttpError(400, "不接受查询参数", "INVALID_TASK_CONCURRENCY_REQUEST");
    res.set("Cache-Control", "no-store").json(service.update(req.body, () => authorize(res)));
  });
  return router;
}
