import { Router, type Response } from "express";
import type { Identity } from "../services/accessService.js";
import type { RunQualityService } from "../services/runQualityService.js";
import type { StepFeedbackService } from "../services/stepFeedbackService.js";
import { HttpError } from "../errors.js";

/** 任务质检通道（仅管理员）。与 taskConcurrencyRoutes 同一个姿势：挂载点缺少共享身份中间件时
 *  直接失败关闭，不因为「路由顺序被改过」而静默放行。 */
function context(res: Response): Identity {
  if (typeof res.locals.authorizeAdmin !== "function" || !res.locals.identity) throw new HttpError(403, "需要管理员权限", "ADMIN_REQUIRED");
  res.locals.authorizeAdmin();
  return res.locals.identity as Identity;
}

export function createQualityRouter(quality: RunQualityService, stepFeedback?: StepFeedbackService) {
  const router = Router();
  router.get("/api/v1/runs/:runId/audit", async (req, res) => {
    const identity = context(res);
    res.set("Cache-Control", "no-store").json(await quality.audit(identity, { ...req.query, runId: req.params.runId }));
  });
  // 唯一可能计费的步骤级反馈：把反馈连同执行期上下文交给该步骤原本调用的 Agent 一次，
  // 返回原文与按输出契约解析的修订结果；不重做、不排队、不写运行记录。
  if (stepFeedback) router.post("/api/v1/runs/:runId/steps/:stepId/feedback", async (req, res) => {
    const identity = context(res);
    const controller = new AbortController();
    const disconnected = () => controller.abort();
    res.once("close", disconnected);
    try {
      res.set("Cache-Control", "no-store").json(await stepFeedback.requestStepAgentFeedback(identity, { ...req.body, runId: req.params.runId, stepId: req.params.stepId }, controller.signal));
    } finally { res.off("close", disconnected); }
  });
  router.post("/api/v1/runs/:runId/critiques", async (req, res) => {
    const identity = context(res);
    res.status(201).json(await quality.createCritique(identity, { ...req.body, runId: req.params.runId }));
  });
  router.get("/api/v1/runs/:runId/critiques", async (req, res) => {
    const identity = context(res);
    res.set("Cache-Control", "no-store").json(await quality.listCritiques(identity, { ...req.query, runId: req.params.runId }));
  });
  router.get("/api/v1/quality/critiques/:critiqueId", async (req, res) => {
    const identity = context(res);
    res.set("Cache-Control", "no-store").json(await quality.getCritique(identity, { critiqueId: req.params.critiqueId }));
  });
  router.patch("/api/v1/quality/critiques/:critiqueId", async (req, res) => {
    const identity = context(res);
    res.json(await quality.updateCritique(identity, { ...req.body, critiqueId: req.params.critiqueId }));
  });
  // 唯一可能计费的质检操作：一次请求不自动重试；响应丢失用同一 critiqueId 读取质检记录对账。
  router.post("/api/v1/runs/:runId/audit/hermes", async (req, res) => {
    const identity = context(res);
    const controller = new AbortController();
    const disconnected = () => controller.abort();
    res.once("close", disconnected);
    try {
      res.status(201).json(await quality.hermesAudit(identity, { ...req.body, runId: req.params.runId }, controller.signal));
    } finally { res.off("close", disconnected); }
  });
  return router;
}
