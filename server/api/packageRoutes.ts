import { Router } from "express";
import { HttpError } from "../errors.js";
import type { CodeScenePackageService } from "../services/codeScenePackageService.js";
import type { PackageService } from "../services/packageService.js";

/**
 * 管理端场景包：
 * - 配置型（source: "config"）：草稿 CRUD 与发布，沿用 PackageService。
 * - 代码型（source: "code"）：磁盘代码子工程的加载状态与定制化配置，沿用 CodeScenePackageService。
 *
 * 两个来源共用一个目录入口，前端靠 `source` 区分；代码型包不提供代码编辑器，
 * 只做执行场景、输入契约、服务页面与定价的覆盖配置（规格 §6）。
 */
export function createPackageRouter(packages: PackageService, codePackages: CodeScenePackageService) {
  const router = Router();
  router.use("/api/v1/packages", (_req, res, next) => { res.set("Cache-Control", "no-store"); next(); });

  router.get("/api/v1/packages", async (_req, res) => {
    res.locals.authorizeAdmin();
    const [config, code] = await Promise.all([packages.listDrafts(), codePackages.getAdminList()]);
    // 同 ID 只留代码包：代码子工程与历史配置型包可能撞同一个 ID（如 ai_image），
    // 代码包是唯一在跑的实现，重复列出会让配置型那份看起来还能编辑、实际不生效。
    const codeIds = new Set(code.packages.map((entry) => entry.packageId));
    res.json({
      packages: [
        ...code.packages.map((entry) => ({ ...entry, source: "code" as const })),
        ...config.packages.filter((draft) => !codeIds.has(draft.id)).map((draft) => ({ ...draft, source: "config" as const })),
      ],
      codePackages: code.packages,
      nextAction: config.nextAction,
    });
  });

  router.get("/api/v1/packages/:packageId", async (req, res) => {
    res.locals.authorizeAdmin();
    res.json(await packages.getDraft(String(req.params.packageId)));
  });

  router.post("/api/v1/packages", async (req, res) => {
    res.locals.authorizeAdmin();
    res.status(201).json(await packages.createDraft(req.body));
  });

  router.patch("/api/v1/packages/:packageId", async (req, res) => {
    res.locals.authorizeAdmin();
    res.json(await packages.updateDraft(String(req.params.packageId), req.body));
  });

  router.post("/api/v1/packages/:packageId/publish", async (req, res) => {
    res.locals.authorizeAdmin();
    res.status(201).json(await packages.publish(String(req.params.packageId), req.body));
  });

  // ---- 代码子工程（场景包）----
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

  // ---- 运行入口与运行记录 ----
  //
  // 提交走管理员路由而不是 MCP 工具：包内通常会 `scenes.wait` 到子运行终态（分钟级），
  // MCP 是同步请求-应答语义，挂上去要么撑爆工具超时、要么逼出一个自建任务队列（规格明令禁止）。
  // 这里用 202 + packageRunId 表达「已受理」，执行与排队仍完全复用 RunService。
  router.post("/api/v1/code-packages/:packageId/runs", async (req, res) => {
    res.locals.authorizeAdmin();
    const accepted = await codePackages.start(String(req.params.packageId), req.body);
    res.status(202).json(accepted);
  });

  router.get("/api/v1/code-packages/:packageId/runs", async (req, res) => {
    res.locals.authorizeAdmin();
    res.set("Cache-Control", "no-store");
    const status = typeof req.query.status === "string" && req.query.status ? req.query.status as "running" | "completed" | "failed" : undefined;
    if (status && !["running", "completed", "failed"].includes(status)) throw new HttpError(400, "运行状态筛选无效", "INVALID_PACKAGE_RUN_STATUS");
    res.json(await codePackages.listRuns(String(req.params.packageId), {
      limit: req.query.limit === undefined ? undefined : Number(req.query.limit),
      ...(typeof req.query.cursor === "string" && req.query.cursor ? { cursor: req.query.cursor } : {}),
      ...(status ? { status } : {}),
    }));
  });

  router.get("/api/v1/code-packages/:packageId/runs/:packageRunId", async (req, res) => {
    res.locals.authorizeAdmin();
    res.set("Cache-Control", "no-store");
    res.json(await codePackages.getRunDetail(String(req.params.packageId), String(req.params.packageRunId)));
  });

  return router;
}
