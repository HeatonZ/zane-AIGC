import { draftFavoriteRequest } from "../ai/taskDraftSchemas.js";
import { accessPage } from "../ai/accessSchemas.js";
import { TaskDraftService } from "../services/taskDraftService.js";
import { sceneDiffQuery, sceneDiffValueQuery } from "../ai/sceneDiffSchemas.js";
import { publicUser, runSubmitter } from "../services/accessService.js";
import { Router } from "express";
import type { Request, Response } from "express";
import { AI_FOUNDATION_FEATURES } from "../ai/features.js";
import { createScene, updateSceneDraft, revisionRequest, publishScene, restoreSceneDraft, saveOptionPreset, presetQuery, outputQuery, stepResultQuery, sceneQuery } from "../ai/sceneSchemas.js";
import { runOutputs, stepResult } from "../services/runResultService.js";
import type * as z from "zod/v4";
import { aiOperations, AI_CONTRACT_VERSION } from "../ai/operations.js";
import { scenePreparation, sceneSubmission } from "../ai/schemas.js";
import { AI_OPERATOR_GUIDE, PUBLIC_USER_OPERATOR_GUIDE } from "../ai/guide.js";
import { createAiOpenApi } from "../ai/openapi.js";
import type { RunRecord, SavedSettings } from "../domain/types.js";
import { isActiveRunStatus } from "../domain/types.js";
import { isRunId } from "../artifacts/runArtifacts.js";
import { HttpError } from "../errors.js";
import { AiSceneService } from "../services/aiSceneService.js";
import type { RunService } from "../services/runService.js";

function parsed<S extends z.ZodType>(schema: S, body: unknown): z.output<S> {
  const result = schema.safeParse(body);
  if (!result.success) throw new HttpError(400, result.error.issues.map(issue => issue.path.join(".") + ": " + issue.message).join("; "), "INVALID_AI_REQUEST");
  return result.data;
}
type RunSubmitterResolver = (userId: string) => import("../domain/types.js").RunSubmitter | undefined;
function withSubmitter(run: RunRecord, resolveSubmitter?: RunSubmitterResolver): RunRecord {
  if (run.submitter || !run.ownerUserId || !resolveSubmitter) return run;
  const submitter = resolveSubmitter(run.ownerUserId);
  return submitter ? { ...run, submitter } : run;
}
export function observation(run: RunRecord, resolveSubmitter?: RunSubmitterResolver) {
  const view = withSubmitter(run, resolveSubmitter);
  return { runId: view.runId, sceneId: view.sceneId, status: view.status, runTitle: view.runTitle, workflowName: view.workflowName, createdAt: view.createdAt, finishedAt: view.finishedAt, ...(view.submitter ? { submitter: view.submitter } : {}), pendingReview: view.pendingReview, error: view.error, archiveWarnings: view.archiveWarnings, steps: view.steps.map(step => ({ stepId: step.stepId, name: step.name, status: step.status, message: step.message, itemCount: step.items?.length })), outputCount: view.outputs.length, nextAction: view.status === "waiting" ? "review" : isActiveRunStatus(view.status) ? "wait" : view.status === "stale" || view.status === "failed" || view.status === "cancelled" ? "inspect_before_recovery" : "read_outputs" };
}
export function createAiRouter(scenes: AiSceneService, runs: RunService, loadSettings: () => Promise<SavedSettings>, resolveSubmitter?: RunSubmitterResolver) {
  const router = Router();
  const drafts = new TaskDraftService(scenes.workspace);
  router.get("/api/v1/task-drafts", async (req, res) => res.json(await drafts.list(parsed(accessPage, req.query), res.locals.identity.id)));
  router.get("/api/v1/task-drafts/:draftId", async (req, res) => res.json(await drafts.get(String(req.params.draftId))));
  router.patch("/api/v1/task-drafts/:draftId/favorite", async (req, res) => res.json(await drafts.setFavorite(String(req.params.draftId), parsed(draftFavoriteRequest, req.body), res.locals.authorizeAdmin)));
  router.use(["/api/workspace/status", "/api/v1/ai", "/api/v1/scenes", "/api/v1/option-presets", "/api/v1/runs/:runId/wait", "/api/v1/runs/:runId/outputs", "/api/v1/runs/:runId/steps"], (_req, res, next) => { res.set("Cache-Control", "no-store"); next(); });
  router.get("/api/v1/ai", async (_req, res) => {
    const settings = await loadSettings();
    res.json({ ...(res.locals.identity ? {identity:publicUser(res.locals.identity),mode:"admin"} : {}), name: "zane-workbench", contractVersion: AI_CONTRACT_VERSION, security: res.locals.httpSecurityPolicy, worker: runs.metrics(), projectConfigured: Boolean(settings.projectDirectory), projectDirectory: settings.projectDirectory, endpoints: { openapi: "/api/v1/ai/openapi.json", guide: "/api/v1/ai/guide", scenes: "/api/v1/scenes", capabilities: "/api/v1/capabilities", assets: "/api/v1/assets" }, features: AI_FOUNDATION_FEATURES, runtimeContext: { enabledHermesProfiles: settings.enabledHermesProfiles, workflowTimeoutMinutes: settings.workflowTimeoutMinutes, comfyuiConfigured: Boolean(settings.comfyuiBaseUrl) }, submissionPolicy: { clientRunIdRequiredForAi: true, duplicateRunId: "409_RUN_ALREADY_EXISTS", lostResponse: "query_same_run_id_do_not_resubmit", exactlyOnce: false }, operations: aiOperations.map(({ name, path, method, description, effect, access }) => ({ name, path, method, description, effect, access:access ?? "admin" })) });
  });
  router.get("/api/v1/ai/openapi.json", (_req, res) => res.json(createAiOpenApi({ userOnly: Boolean(res.locals.publicUserOnly) })));
  router.get("/api/v1/ai/guide", (_req, res) => res.type("text/markdown").send(res.locals.publicUserOnly ? PUBLIC_USER_OPERATOR_GUIDE : AI_OPERATOR_GUIDE));
  router.get("/api/workspace/status", async (_req, res) => res.json(await scenes.workspace.status()));
  const query = (req: Request) => {
    const result: Record<string, unknown> = { ...req.query };
    for (const [key, value] of Object.entries(result)) {
      if (typeof value !== "string") throw new HttpError(400, "查询参数必须为单个字符串：" + key, "INVALID_AI_REQUEST");
      if (key === "includeValues") {
        if (value !== "true" && value !== "false") throw new HttpError(400, "includeValues必须是true或false", "INVALID_AI_REQUEST");
        result[key] = value === "true";
      }
    }
    return result;
  };
  router.get("/api/v1/scenes", async (req, res) => {
    const input = query(req);
    if (input.limit !== undefined) input.limit = Number(input.limit);
    res.json(await scenes.list(parsed(sceneQuery, input)));
  });
  const readRun = async (req: Request, res: Response) => {
    const id = String(req.params.runId);
    if (!isRunId(id)) throw new HttpError(400, "运行记录编号无效", "INVALID_AI_REQUEST");
    const { projectDirectory } = await loadSettings();
    const run = await runs.getRun(projectDirectory, id);
    if (!run && runs.isPreparing(projectDirectory, id)) { res.set("Retry-After", "1"); throw new HttpError(409, "运行正在准备，请稍后查询", "RUN_PREPARING"); }
    if (!run) throw new HttpError(404, "没有找到此运行", "RUN_NOT_FOUND");
    return run;
  };
  router.post("/api/v1/scenes", async (req, res) => res.status(201).json(await scenes.drafts.create(parsed(createScene, req.body))));
  router.get("/api/v1/scenes/:sceneId/draft/diff", async (req, res) => res.set("Cache-Control", "no-store").json(await scenes.drafts.diff(String(req.params.sceneId), parsed(sceneDiffQuery, query(req)))));
  router.get("/api/v1/scenes/:sceneId/draft/diff/value", async (req, res) => res.set("Cache-Control", "no-store").json(await scenes.drafts.diffValue(String(req.params.sceneId), parsed(sceneDiffValueQuery, query(req)))));
  router.get("/api/v1/scenes/:sceneId/draft", async (req, res) => res.json(await scenes.drafts.get(String(req.params.sceneId))));
  router.patch("/api/v1/scenes/:sceneId/draft", async (req, res) => res.json(await scenes.drafts.update(String(req.params.sceneId), parsed(updateSceneDraft, req.body))));
  router.post("/api/v1/scenes/:sceneId/validate", async (req, res) => res.json(await scenes.drafts.validate(String(req.params.sceneId), parsed(revisionRequest, req.body).revision)));
  router.post("/api/v1/scenes/:sceneId/publish", async (req, res) => {
    const input = parsed(publishScene, req.body);
    const result = await scenes.drafts.publish(String(req.params.sceneId), input.revision, input.publicationId);
    res.status(result.created ? 201 : 200).json(result);
  });
  router.post("/api/v1/scenes/:sceneId/restore", async (req, res) => {
    const input = parsed(restoreSceneDraft, req.body);
    res.json(await scenes.drafts.restore(String(req.params.sceneId), input.revision, input.versionId));
  });
  router.delete("/api/v1/scenes/:sceneId", async (req, res) => res.json(await scenes.drafts.delete(String(req.params.sceneId), parsed(revisionRequest, req.body).revision)));
  router.get("/api/v1/option-presets", async (req, res) => {
    const input = parsed(presetQuery, query(req));
    res.json(await scenes.drafts.listPresets(input.q, input.limit, input.cursor));
  });
  router.post("/api/v1/option-presets", async (req, res) => {
    const input = parsed(saveOptionPreset, req.body);
    res.json(await scenes.drafts.savePreset(input.preset, input.revision));
  });
  router.delete("/api/v1/option-presets/:presetId", async (req, res) => res.json(await scenes.drafts.deletePreset(String(req.params.presetId), parsed(revisionRequest, req.body).revision)));
  router.get("/api/v1/runs/:runId/outputs", async (req, res) => res.json(runOutputs(await readRun(req, res), parsed(outputQuery, query(req)))));
  router.get("/api/v1/runs/:runId/steps/:stepId/result", async (req, res) => res.json(stepResult(await readRun(req, res), String(req.params.stepId), parsed(stepResultQuery, query(req)))));

  router.get("/api/v1/scenes/:sceneId", async (req, res) => {
    if (req.query.versionId !== undefined && typeof req.query.versionId !== "string") throw new HttpError(400, "versionId 必须是字符串", "INVALID_AI_REQUEST");
    res.json(await scenes.get(String(req.params.sceneId), req.query.versionId as string | undefined));
  });
  router.post("/api/v1/scenes/:sceneId/prepare", async (req, res) => {
    const input = parsed(scenePreparation, req.body);
    res.json(await scenes.prepare(String(req.params.sceneId), input.versionId, input.inputValues));
  });
  router.post("/api/v1/scenes/:sceneId/runs", async (req, res) => {
    const input = parsed(sceneSubmission, req.body);
    const prepared = await scenes.prepare(String(req.params.sceneId), input.versionId, input.inputValues);
    const run = await runs.submit({ runId: input.runId, runTitle: input.runTitle, workflow: prepared.workflow, inputValues: prepared.inputValues }, res.locals.identity ? { ownerUserId: res.locals.identity.id, submitter: runSubmitter(res.locals.identity), authorize: res.locals.authorizeAdmin } : undefined);
    res.status(202).json({ runId: run.runId, status: run.status, createdAt: run.createdAt, sceneId: prepared.sceneId, versionId: prepared.versionId, version: prepared.version });
  });
  router.get("/api/v1/runs/:runId/wait", async (req, res) => {
    const id = String(req.params.runId);
    if (!isRunId(id)) throw new HttpError(400, "运行记录编号无效");
    const seconds = req.query.timeoutSeconds === undefined ? 20 : Number(req.query.timeoutSeconds);
    if (!Number.isInteger(seconds) || seconds < 0 || seconds > 30) throw new HttpError(400, "timeoutSeconds 必须是0至30的整数", "INVALID_AI_REQUEST");
    const { projectDirectory } = await loadSettings();
    const initial = await runs.getRun(projectDirectory, id);
    if (!initial && runs.isPreparing(projectDirectory, id)) { res.set("Retry-After", "1"); throw new HttpError(409, "运行正在准备，请稍后查询", "RUN_PREPARING"); }
    if (!initial) throw new HttpError(404, "没有找到此运行");
    if (!seconds || !isActiveRunStatus(initial.status)) { res.json({ ...observation(initial, resolveSubmitter), timedOut: isActiveRunStatus(initial.status) }); return; }
    const controller = new AbortController();
    let elapsed = false;
    const timer = setTimeout(() => { elapsed = true; controller.abort(); }, seconds * 1000);
    const disconnected = () => controller.abort();
    res.once("close", disconnected);
    try { res.json({ ...observation(await runs.wait(projectDirectory, id, controller.signal), resolveSubmitter), timedOut: false }); }
    catch (error) {
      if (!controller.signal.aborted) throw error;
      if (!elapsed || res.destroyed) return;
      const current = await runs.getRun(projectDirectory, id);
      if (!current) throw new HttpError(404, "没有找到此运行");
      res.json({ ...observation(current, resolveSubmitter), timedOut: isActiveRunStatus(current.status) });
    } finally { clearTimeout(timer); res.off("close", disconnected); }
  });
  return router;
}
