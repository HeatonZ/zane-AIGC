import { SystemFeedbackService } from "../services/systemFeedbackService.js";
import { ownReviewRequest } from "../domain/systemFeedbackContracts.js";
import express, { Router } from "express";
import type { Response } from "express";
import * as z from "zod/v4";
import { AccessService, publicUser, type Identity } from "../services/accessService.js";
import { UserPortalService } from "../services/userPortalService.js";
import { HttpError } from "../errors.js";
import { assertRequestOrigin } from "../security/requestOrigin.js";
import { accessPage, adminSetup, authLogin, userCreate, userUpdate, userAccess, passwordReset, ownScene, ownPreparation, ownSubmission, ownDraft, credentialCreate, credentialRevoke, runInputQuery, runActivityQuery } from "../ai/accessSchemas.js";
import { draftFavoriteRequest } from "../ai/taskDraftSchemas.js";
import { outputQuery, stepResultQuery } from "../ai/sceneSchemas.js";
import { AI_CONTRACT_VERSION, aiOperations } from "../ai/operations.js";
import { ownAssetQuerySchema } from "../domain/assetLibraryContracts.js";
const parsed = <S extends z.ZodType>(schema: S, value: unknown): z.output<S> => { const result = schema.safeParse(value); if (!result.success) throw new HttpError(400, result.error.issues.map(issue => issue.path.join(".") + ": " + issue.message).join("; "), "INVALID_ACCESS_REQUEST"); return result.data; };
const identity = (res: Response): Identity => res.locals.identity;
const sessionCookie = (res: Response, token: string, secure: boolean) => res.cookie("zane_session", token, { httpOnly: true, secure, sameSite: "strict", path: "/", maxAge: 24 * 3600 * 1000 });
export function createAuthRouter(access: AccessService) {
  const router = Router(); router.use("/api/auth", (_req,res,next) => { res.set("Cache-Control", "no-store"); next(); });
  router.get("/api/auth/status", (_req,res) => { const initialized = access.initialized(), userOnly = Boolean(res.locals.publicUserOnly); res.json({ initialized, nextAction: initialized ? "login" : userOnly ? "contact_admin" : "setup_admin", entryMode: userOnly ? "user-only" : "full", setupAllowed: !userOnly && !initialized, security: access.securityPolicy(userOnly) }); });
  router.post("/api/auth/setup", async (req,res) => {
    if (!["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(req.ip ?? "")) throw new HttpError(403, "首次管理员初始化请在服务器本机完成", "LOCAL_SETUP_REQUIRED");
    assertRequestOrigin(req);
    const input = parsed(adminSetup, req.body); await access.create(input, true); const result = await access.login(input.username, input.password, { clientAddress: req.ip });
    sessionCookie(res, result.token, req.secure); res.status(201).json({ user: result.user, nextAction: "open_admin" });
  });
  router.post("/api/auth/login", async (req,res) => { assertRequestOrigin(req); const input = parsed(authLogin, req.body); const result = await access.login(input.username, input.password, { clientAddress: req.ip, userOnly: Boolean(res.locals.publicUserOnly) }); sessionCookie(res,result.token,req.secure); res.json({ user: result.user }); });
  // Logout is handled after the identity gate, not by an unauthenticated bypass.
  return router;
}
export function createAccessRouter(access: AccessService, portal: UserPortalService) {
  const router = Router();
  const feedback = new SystemFeedbackService(access, async () => (await portal.scenes.loadSettings()).projectDirectory);
  router.get("/api/v1/self/system-feedback", async (req,res) => res.json(await feedback.list(identity(res), req.query)));
  router.post("/api/v1/self/system-feedback", async (req,res) => res.status(201).json(await feedback.create(identity(res), req.body)));
  router.get("/api/v1/self/system-feedback/:feedbackId", async (req,res) => res.json(await feedback.get(identity(res), { feedbackId: req.params.feedbackId })));
  router.get("/api/v1/system-feedback", async (req,res) => res.json(await feedback.list(identity(res), req.query, true)));
  router.get("/api/v1/system-feedback/:feedbackId", async (req,res) => res.json(await feedback.get(identity(res), { feedbackId: req.params.feedbackId }, true)));
  router.post("/api/v1/system-feedback/:feedbackId/handle", async (req,res) => res.json(await feedback.handle(identity(res), { ...req.body, feedbackId: req.params.feedbackId })));
  router.get("/api/v1/ai", (_req,res,next) => {
    const current = identity(res);
    if (current.role === "admin") { next(); return; }
    res.json({ name: "zane-workbench", contractVersion: AI_CONTRACT_VERSION, identity: publicUser(current), mode: "user", security: access.securityPolicy(Boolean(res.locals.publicUserOnly)), worker: { ready: portal.runs.metrics().ready, accepting: portal.runs.metrics().accepting }, operations: aiOperations.filter(operation => operation.access === "authenticated").map(({ name,path,method,effect,description }) => ({ name,path,method,effect,description })), nextAction: "list_available_scenes", submissionPolicy: { clientRunIdRequiredForAi: true, lostResponse: "query_same_run_id_do_not_resubmit" } });
  });
  router.post("/api/v1/self/logout", (_req,res) => { access.logout(identity(res)); res.clearCookie("zane_session", { path: "/" }); res.json({ loggedOut: true }); });
  router.get("/api/v1/self/account", (_req,res) => res.json({ user: publicUser(access.refresh(identity(res))), nextAction: identity(res).role === "admin" ? "list_users" : "list_available_scenes" }));
  router.get("/api/v1/users", (req,res) => res.json(access.list(parsed(accessPage,req.query))));
  router.post("/api/v1/users", async (req,res) => res.status(201).json(await access.create(parsed(userCreate,req.body),false,res.locals.authorizeAdmin)));
  router.get("/api/v1/users/:userId", (req,res) => res.json({ user: access.get(String(req.params.userId)) }));
  router.patch("/api/v1/users/:userId", (req,res) => res.json(access.update(parsed(userUpdate,{ ...req.body, userId: req.params.userId }))));
  router.post("/api/v1/users/:userId/scene-access", async (req,res) => res.json(await access.setScenes(parsed(userAccess,{ ...req.body, userId: req.params.userId }),res.locals.authorizeAdmin)));
  router.post("/api/v1/users/:userId/password", async (req,res) => res.json(await access.resetPassword(parsed(passwordReset,{ ...req.body,userId:req.params.userId }),res.locals.authorizeAdmin)));
  router.get("/api/v1/self/tokens", (req,res) => res.json(access.credentials(identity(res),parsed(accessPage,req.query))));
  router.post("/api/v1/self/tokens", (req,res) => res.status(201).json(access.createCredential(identity(res),parsed(credentialCreate,req.body))));
  router.post("/api/v1/self/tokens/:tokenId/revoke", (req,res) => { const input = parsed(credentialRevoke,{ ...req.body,tokenId:req.params.tokenId }); res.json(access.revokeCredential(identity(res),input.tokenId,input.revision)); });
  router.get("/api/v1/self/scenes", async (req,res) => res.json(await portal.list(identity(res),parsed(accessPage,req.query))));
  router.get("/api/v1/self/scenes/:sceneId", async (req,res) => { const input = parsed(ownScene,req.params); res.json(await portal.get(identity(res),input.sceneId)); });
  router.post("/api/v1/self/scenes/:sceneId/prepare", async (req,res) => res.json(await portal.prepare(identity(res),parsed(ownPreparation,{ ...req.body,sceneId:req.params.sceneId }))));
  router.post("/api/v1/self/scenes/:sceneId/runs", async (req,res) => res.status(202).json(await portal.submit(identity(res),parsed(ownSubmission,{ ...req.body,sceneId:req.params.sceneId }))));
  router.get("/api/v1/self/drafts", async (req,res) => res.json(await portal.listDrafts(identity(res),parsed(accessPage,req.query))));
  router.get("/api/v1/self/drafts/:draftId", async (req,res) => res.json(await portal.getDraft(identity(res),String(req.params.draftId))));
  router.patch("/api/v1/self/drafts/:draftId/favorite", async (req,res) => res.json(await portal.setDraftFavorite(identity(res), String(req.params.draftId), parsed(draftFavoriteRequest, req.body))));
  router.post("/api/v1/self/drafts", async (req,res) => res.json(await portal.saveDraft(identity(res),parsed(ownDraft,req.body))));
  router.get("/api/v1/self/runs", async (req,res) => res.json(await portal.listRuns(identity(res),parsed(accessPage,req.query))));
  router.get("/api/v1/self/runs/:runId", async (req,res) => res.json(await portal.getRun(identity(res),String(req.params.runId))));
  const results = (query: Record<string, unknown>) => ({ ...query, ...(query.includeValues === undefined ? {} : { includeValues: query.includeValues === "true" ? true : query.includeValues === "false" ? false : query.includeValues }) });
  router.get("/api/v1/self/runs/:runId/inputs", async (req,res) => res.json(await portal.inputs(identity(res),String(req.params.runId),parsed(runInputQuery,results(req.query)))));
  router.get("/api/v1/self/runs/:runId/activity", async (req,res) => res.json(await portal.activity(identity(res),String(req.params.runId),parsed(runActivityQuery,req.query))));
  router.get("/api/v1/self/runs/:runId/outputs", async (req,res) => res.json(await portal.outputs(identity(res),String(req.params.runId),parsed(outputQuery,results(req.query)))));
  router.get("/api/v1/self/runs/:runId/steps/:stepId", async (req,res) => res.json(await portal.outputs(identity(res),String(req.params.runId),parsed(stepResultQuery,results(req.query)),String(req.params.stepId))));
  router.get("/api/v1/self/runs/:runId/wait", async (req,res) => {
    const input = parsed(z.object({ timeoutSeconds: z.coerce.number().int().min(1).max(30).default(20) }).strict(),req.query);
    const run = await portal.ownRun(identity(res),String(req.params.runId)); const controller = new AbortController(); const timer = setTimeout(() => controller.abort(),input.timeoutSeconds * 1000); const close = () => controller.abort(); res.once("close",close);
    try { await portal.runs.wait((await portal.scenes.loadSettings()).projectDirectory,run.runId,controller.signal); access.refresh(identity(res)); if (!res.destroyed) res.json({ ...await portal.getRun(identity(res),run.runId),timedOut:false }); }
    catch (error) { if (!controller.signal.aborted) throw error; if (!res.destroyed) res.json({ ...await portal.getRun(identity(res),run.runId),timedOut:true }); }
    finally { clearTimeout(timer); res.off("close",close); }
  });
  router.post("/api/v1/self/runs/:runId/cancel", async (req,res) => { parsed(z.object({}).strict(),req.body ?? {}); res.json(await portal.action(identity(res),String(req.params.runId),"cancel",{})); });
  router.post("/api/v1/self/runs/:runId/review", async (req,res) => { const input = parsed(ownReviewRequest,req.body); res.status(202).json(await portal.action(identity(res),String(req.params.runId),"review",input)); });
  router.post("/api/v1/self/runs/:runId/resume", async (req,res) => { const input = parsed(z.object({ newRunId:z.uuid() }).strict(),req.body); res.status(202).json(await portal.action(identity(res),String(req.params.runId),"resume",input)); });
  router.post("/api/v1/self/assets/upload", express.raw({ type:"application/octet-stream",limit:"250mb" }), async (req,res) => {
    const input = parsed(z.object({ assetId:z.uuid(),name:z.string().trim().min(1).max(160),kind:z.enum(["image","video","audio"]) }).strict(),req.query);
    if (!Buffer.isBuffer(req.body) || !req.body.length) throw new HttpError(400,"请选择非空媒体文件","INVALID_ACCESS_REQUEST");
    let filename: string; try { filename = decodeURIComponent(req.get("X-File-Name") ?? "media.bin"); } catch { throw new HttpError(400,"文件名无效","INVALID_ACCESS_REQUEST"); }
    res.status(201).json(await portal.upload(identity(res),input.assetId,input.name,input.kind,req.body,filename));
  });
  router.get("/api/v1/self/assets", async (req,res) => { res.set("Cache-Control", "no-store"); res.json(await portal.listOwnAssets(identity(res),parsed(ownAssetQuerySchema,req.query))); });
  router.get("/api/v1/self/assets/:assetId", async (req,res) => res.json(await portal.getAsset(identity(res),String(req.params.assetId))));
  return router;
}
