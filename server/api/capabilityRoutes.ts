import { Router } from "express";
import { CapabilityCatalogService } from "../services/capabilityCatalogService.js";
import type { ExecutorRegistry } from "../execution/executorRegistry.js";
import type { WorkspaceService } from "../services/workspaceService.js";
export function createCapabilityRouter(registry: ExecutorRegistry, workspace?: WorkspaceService) {
  const router = Router();
  const catalog = new CapabilityCatalogService(registry, workspace);
  router.get("/api/v1/capabilities", async (request, response) => {
    const query = { ...request.query, ...(typeof request.query.limit === "string" ? { limit: Number(request.query.limit) } : {}) };
    const page = catalog.list(query);
    // 显式请求时才统计退役能力引用：默认响应不做工作区扫描。
    if (request.query.compatibilityUsage === "true" && !page.nextCursor) {
      const usage = await catalog.compatibilityUsage();
      response.json(usage.length ? { ...page, compatibilityUsage: usage } : page);
      return;
    }
    response.json(page);
  });
  return router;
}
