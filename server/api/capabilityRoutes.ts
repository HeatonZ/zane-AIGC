import { Router } from "express";
import { CapabilityCatalogService } from "../services/capabilityCatalogService.js";
import type { ExecutorRegistry } from "../execution/executorRegistry.js";
export function createCapabilityRouter(registry: ExecutorRegistry) {
  const router = Router();
  const catalog = new CapabilityCatalogService(registry);
  router.get("/api/v1/capabilities", (request, response) => {
    const query = { ...request.query, ...(typeof request.query.limit === "string" ? { limit: Number(request.query.limit) } : {}) };
    response.json(catalog.list(query));
  });
  return router;
}
