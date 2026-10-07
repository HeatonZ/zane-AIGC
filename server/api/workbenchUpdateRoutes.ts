import { Router } from "express";
import { upgradeQuery } from "../domain/workbenchUpdateContracts.js";
import { readUpgradeStatus } from "../services/workbenchUpdateService.js";
import { AI_CONTRACT_VERSION } from "../ai/operations.js";
import { HttpError } from "../errors.js";

export function createWorkbenchUpdateRouter(dataDirectory: string, releaseId: string, production: boolean) {
  const router = Router();
  router.get("/api/v1/self/runtime-release", (_req, res) => {
    res.set("Cache-Control", "no-store").json({releaseId,contractVersion:AI_CONTRACT_VERSION,environment:production ? "production" : "development",automaticRefresh:false});
  });
  router.get("/api/v1/maintenance/upgrade", async (req, res) => {
    const query = upgradeQuery.safeParse(req.query);
    if (!query.success) throw new HttpError(400, "仅接受一个可选 UUID operationId", "INVALID_AI_REQUEST");
    res.set("Cache-Control", "no-store").json(await readUpgradeStatus(dataDirectory, query.data.operationId));
  });
  return router;
}
