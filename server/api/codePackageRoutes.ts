import { Router } from "express";
import { HttpError } from "../errors.js";
import type { CodeScenePackageService, CodeScenePackageRun } from "../services/codeScenePackageService.js";

/**
 * 代码子工程（场景包）的管理端操作面：加载状态、执行场景配置、重新加载、运行入口与运行记录。
 *
 * 单独成文件是因为这一半**不依赖配置型场景包与积分/定价线**：它只认磁盘代码包 +
 * `RunService` 队列，可以独立挂载、独立测试。配置型包（`/api/v1/packages`）在
 * `packageRoutes.ts` 里，复用这里的代码包路由后再挂自己的部分。
 *
 * 提交入口选管理员 HTTP 路由而不是 MCP 工具：包内通常 `scenes.wait` 到子运行终态（分钟级），
 * MCP 是同步请求-应答语义，挂上去要么撑爆工具超时、要么逼出一个自建任务队列（规格明令禁止）。
 * 这里用 202 + `packageRunId` 表达「已受理」，执行与排队仍完全复用 `RunService`。
 */
export function createCodePackageRouter(codePackages: CodeScenePackageService) {
  const router = Router();
  router.use("/api/v1/code-packages", (_req, res, next) => { res.set("Cache-Control", "no-store"); next(); });

  router.get("/api/v1/code-packages", async (_req, res) => {
    res.locals.authorizeAdmin();
    res.json(await codePackages.getAdminList());
  });

  router.patch("/api/v1/code-packages/:packageId", async (req, res) => {
    res.locals.authorizeAdmin();
    res.json(await codePackages.updateConfig(String(req.params.packageId), req.body));
  });

  router.post("/api/v1/code-packages/:packageId/reload", async (req, res) => {
    res.locals.authorizeAdmin();
    const entry = await codePackages.reload(String(req.params.packageId));
    res.json({ package: entry, nextAction: "list_code_packages" as const });
  });

  // ---- 运行入口 ----
  router.post("/api/v1/code-packages/:packageId/runs", async (req, res) => {
    res.locals.authorizeAdmin();
    const accepted = await codePackages.start(String(req.params.packageId), req.body);
    res.status(202).json(accepted);
  });

  // ---- 运行记录（数据源 codeScenePackageRuns）----
  router.get("/api/v1/code-packages/:packageId/runs", async (req, res) => {
    res.locals.authorizeAdmin();
    const status = typeof req.query.status === "string" && req.query.status ? req.query.status as CodeScenePackageRun["status"] : undefined;
    if (status && !["running", "completed", "failed"].includes(status)) throw new HttpError(400, "运行状态筛选无效", "INVALID_PACKAGE_RUN_STATUS");
    res.json(await codePackages.listRuns(String(req.params.packageId), {
      limit: req.query.limit === undefined ? undefined : Number(req.query.limit),
      ...(typeof req.query.cursor === "string" && req.query.cursor ? { cursor: req.query.cursor } : {}),
      ...(status ? { status } : {}),
    }));
  });

  router.get("/api/v1/code-packages/:packageId/runs/:packageRunId", async (req, res) => {
    res.locals.authorizeAdmin();
    res.json(await codePackages.getRunDetail(String(req.params.packageId), String(req.params.packageRunId)));
  });

  return router;
}
