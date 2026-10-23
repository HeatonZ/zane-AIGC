import { Router } from "express";
import { opsLogQuery, systemLogQuery } from "../domain/systemLogContracts.js";
import { HttpError } from "../errors.js";
import type { SystemLogService } from "../services/systemLogService.js";
import type * as z from "zod/v4";

function parsed<S extends z.ZodType>(schema: S, value: unknown): z.output<S> {
  const result = schema.safeParse(value);
  if (!result.success) throw new HttpError(400, result.error.issues.map(issue => issue.path.join(".") + ": " + issue.message).join("; "), "INVALID_LOG_REQUEST");
  return result.data;
}

/**
 * Mounted under `/api/v1/maintenance/*`. The access middleware already rejects non-admins for
 * any `/api/v1/**` path that is neither `/self/*` nor discovery, and the explicit
 * `authorizeAdmin()` is defense in depth (same pattern as `metricsRoutes`). The ops-log route
 * additionally re-checks, because it reads files from disk.
 */
export function createSystemLogRouter(logs: SystemLogService) {
  const router = Router();
  router.get("/api/v1/maintenance/logs", (req, res) => {
    res.locals.authorizeAdmin?.();
    res.set("Cache-Control", "no-store").json(logs.listProcess(parsed(systemLogQuery, req.query)));
  });
  router.get("/api/v1/maintenance/logs/ops", async (req, res) => {
    res.locals.authorizeAdmin?.();
    res.set("Cache-Control", "no-store").json(await logs.readOpsFile(parsed(opsLogQuery, req.query)));
  });
  return router;
}
