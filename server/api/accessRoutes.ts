import { SystemFeedbackService } from "../services/systemFeedbackService.js";
import { ownReviewRequest } from "../domain/systemFeedbackContracts.js";
import express, { Router } from "express";
import type { Response } from "express";
import * as z from "zod/v4";
import { AccessService, publicUser, type Identity } from "../services/accessService.js";
import { UserPortalService } from "../services/userPortalService.js";
import { HttpError } from "../errors.js";
import { UploadQuotaLimiter } from "../security/uploadQuota.js";
import { assertRequestOrigin } from "../security/requestOrigin.js";
import { accessPage, adminSetup, authLogin, userCreate, userUpdate, userAccess, passwordReset, ownScene, ownPreparation, ownSubmission, ownDraft, credentialCreate, credentialRevoke, runInputQuery, runActivityQuery, runListPage } from "../ai/accessSchemas.js";
import { draftFavoriteRequest } from "../ai/taskDraftSchemas.js";
import { outputQuery, stepResultQuery } from "../ai/sceneSchemas.js";
import { AI_CONTRACT_VERSION, aiOperations } from "../ai/operations.js";
import { CATALOGUE_SUMMARY_OMISSION, catalogueDetailQuery, catalogueOperations } from "../ai/discovery.js";
import { ownAssetQuerySchema } from "../domain/assetLibraryContracts.js";
import type { CreditService } from "../services/creditService.js";
import { creditLedgerQuery, redeemCodeRequest, createRedeemBatch, redeemCodeKey, redeemBatchKey, adjustUserCredits, voidRedeemCodeRequest, voidRedeemBatchRequest } from "../domain/creditContracts.js";
import { signupRegister, ownPackageQuery, packageRunKey, packageAccess } from "../ai/accessSchemas.js";
import type { PackageCatalogueService } from "../services/packageCatalogueService.js";
import type { CdkLoginService } from "../services/cdkLoginService.js";
const parsed = <S extends z.ZodType>(schema: S, value: unknown): z.output<S> => { const result = schema.safeParse(value); if (!result.success) throw new HttpError(400, result.error.issues.map(issue => issue.path.join(".") + ": " + issue.message).join("; "), "INVALID_ACCESS_REQUEST"); return result.data; };
const identity = (res: Response): Identity => res.locals.identity;
const sessionCookie = (res: Response, token: string, secure: boolean) => res.cookie("zane_session", token, { httpOnly: true, secure, sameSite: "strict", path: "/", maxAge: 24 * 3600 * 1000 });
export function createAuthRouter(access: AccessService, signup?: { enabled: boolean; grant: number; credits?: CreditService }, cdk?: CdkLoginService) {
  const router = Router(); router.use("/api/auth", (_req,res,next) => { res.set("Cache-Control", "no-store"); next(); });
  router.get("/api/auth/status", (_req,res) => { const initialized = access.initialized(), userOnly = Boolean(res.locals.publicUserOnly); res.json({ initialized, nextAction: initialized ? "login" : userOnly ? "contact_admin" : "setup_admin", entryMode: userOnly ? "user-only" : "full", setupAllowed: !userOnly && !initialized, signupAvailable: Boolean(signup?.enabled) && initialized, cdkLogin: Boolean(cdk) && initialized, security: access.securityPolicy(userOnly) }); });
  router.post("/api/auth/setup", async (req,res) => {
    if (!["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(req.ip ?? "")) throw new HttpError(403, "首次管理员初始化请在服务器本机完成", "LOCAL_SETUP_REQUIRED");
    assertRequestOrigin(req);
    const input = parsed(adminSetup, req.body); await access.create(input, true); const result = await access.login(input.username, input.password, { clientAddress: req.ip });
    sessionCookie(res, result.token, req.secure); res.status(201).json({ user: result.user, nextAction: "open_admin" });
  });
  // 自助注册：默认关闭（ZANE_SELF_SIGNUP=false）。始终建普通用户、空场景授权；注册不送场景，
  // 积分按 ZANE_SIGNUP_GRANT_CREDITS 发放（默认 0）。限流复用登录窗口的独立 signup 作用域。
  router.post("/api/auth/register", async (req,res) => {
    if (!signup?.enabled) throw new HttpError(403, "本工作台未开放自助注册，请联系管理员开通账户", "SIGNUP_DISABLED");
    if (!access.initialized()) throw new HttpError(409, "系统尚未初始化，请联系管理员", "WORKSPACE_NOT_INITIALIZED");
    assertRequestOrigin(req);
    const input = parsed(signupRegister, req.body);
    const user = await access.register(input, { clientAddress: req.ip });
    if (signup.grant > 0 && signup.credits) signup.credits.adjust({ userId: user.id, revision: 0, delta: signup.grant, note: "注册赠送" });
    const result = await access.login(input.username, input.password, { clientAddress: req.ip, userOnly: Boolean(res.locals.publicUserOnly) });
    sessionCookie(res, result.token, req.secure);
    res.status(201).json({ user: result.user, notice: signup.grant > 0 ? `注册成功，已赠送 ${signup.grant} 积分` : "注册成功；账户尚未授权场景，请联系管理员开通后再兑换积分", nextAction: "open_user_portal" });
  });
  // CDK 登录：卡即身份。inspect 只读，用于「输卡 → 告诉我这是新卡还是老卡」；login 建/回账户并签发会话。
  router.post("/api/auth/cdk/inspect", async (req,res) => {
    if (!cdk) throw new HttpError(503, "未开放卡密登录", "CDK_DISABLED");
    assertRequestOrigin(req);
    const input = parsed(z.object({ code: z.string().trim().min(4).max(128) }).strict(), req.body);
    res.json(cdk.inspect(input.code));
  });
  router.post("/api/auth/cdk/login", async (req,res) => {
    if (!cdk) throw new HttpError(503, "未开放卡密登录", "CDK_DISABLED");
    if (!access.initialized()) throw new HttpError(409, "系统尚未初始化，请联系管理员", "WORKSPACE_NOT_INITIALIZED");
    assertRequestOrigin(req);
    const input = parsed(z.object({ code: z.string().trim().min(4).max(128), displayName: z.string().trim().min(1).max(40).optional() }).strict(), req.body);
    const identity = await cdk.login(input.code, { displayName: input.displayName });
    // 登录走既有凭证体系：与密码登录签发同一种 24h 会话，权限、限流、失效规则完全一致。
    const credential = access.issueSession(identity.userId);
    sessionCookie(res, credential.token, req.secure);
    res.status(identity.created ? 201 : 200).json({ user: credential.user, created: identity.created, notice: identity.notice, ...(identity.packageId ? { packageId: identity.packageId } : {}), nextAction: identity.packageId ? "open_service" : "open_user_portal" });
  });
  router.post("/api/auth/login", async (req,res) => { assertRequestOrigin(req); const input = parsed(authLogin, req.body); const result = await access.login(input.username, input.password, { clientAddress: req.ip, userOnly: Boolean(res.locals.publicUserOnly) }); sessionCookie(res,result.token,req.secure); res.json({ user: result.user }); });
  // Logout is handled after the identity gate, not by an unauthenticated bypass.
  return router;
}
export function createAccessRouter(access: AccessService, portal: UserPortalService, credits?: CreditService, packages?: PackageCatalogueService) {
  const router = Router();
  const uploadQuotaLimiter = new UploadQuotaLimiter();
  const feedback = new SystemFeedbackService(access, async () => (await portal.scenes.loadSettings()).projectDirectory);
  router.get("/api/v1/self/system-feedback", async (req,res) => res.json(await feedback.list(identity(res), req.query)));
  router.post("/api/v1/self/system-feedback", async (req,res) => res.status(201).json(await feedback.create(identity(res), req.body)));
  router.get("/api/v1/self/system-feedback/:feedbackId", async (req,res) => res.json(await feedback.get(identity(res), { feedbackId: req.params.feedbackId })));
  router.get("/api/v1/system-feedback", async (req,res) => res.json(await feedback.list(identity(res), req.query, true)));
  router.get("/api/v1/system-feedback/:feedbackId", async (req,res) => res.json(await feedback.get(identity(res), { feedbackId: req.params.feedbackId }, true)));
  router.post("/api/v1/system-feedback/:feedbackId/handle", async (req,res) => res.json(await feedback.handle(identity(res), { ...req.body, feedbackId: req.params.feedbackId })));
  router.get("/api/v1/ai", (req,res,next) => {
    const current = identity(res);
    if (current.role === "admin") { next(); return; }
    const { detail } = parsed(catalogueDetailQuery, { detail: req.query.detail });
    res.json({ name: "zane-workbench", contractVersion: AI_CONTRACT_VERSION, identity: publicUser(current), mode: "user", security: access.securityPolicy(Boolean(res.locals.publicUserOnly)), worker: { ready: portal.runs.metrics().ready, accepting: portal.runs.metrics().accepting }, operations: catalogueOperations(aiOperations.filter(operation => operation.access === "authenticated"), detail), nextAction: "list_available_scenes", submissionPolicy: { clientRunIdRequiredForAi: true, lostResponse: "query_same_run_id_do_not_resubmit" }, ...(detail === "summary" ? { catalogueSummary: CATALOGUE_SUMMARY_OMISSION } : {}) });
  });
  router.post("/api/v1/self/logout", (_req,res) => { access.logout(identity(res)); res.clearCookie("zane_session", { path: "/" }); res.json({ loggedOut: true }); });
  router.get("/api/v1/self/account", (_req,res) => res.json({ user: publicUser(access.refresh(identity(res))), nextAction: identity(res).role === "admin" ? "list_users" : "list_available_scenes" }));
  router.get("/api/v1/users", (req,res) => { res.locals.authorizeAdmin(); res.json(access.list(parsed(accessPage,req.query))); });
  router.post("/api/v1/users", async (req,res) => res.status(201).json(await access.create(parsed(userCreate,req.body),false,res.locals.authorizeAdmin)));
  router.get("/api/v1/users/:userId", (req,res) => { res.locals.authorizeAdmin(); res.json({ user: access.get(String(req.params.userId)) }); });
  router.patch("/api/v1/users/:userId", (req,res) => { res.locals.authorizeAdmin(); res.json(access.update(parsed(userUpdate,{ ...req.body, userId: req.params.userId }), res.locals.identity?.id)); });
  router.post("/api/v1/users/:userId/scene-access", async (req,res) => res.json(await access.setScenes(parsed(userAccess,{ ...req.body, userId: req.params.userId }),res.locals.authorizeAdmin, res.locals.identity?.id)));
  router.post("/api/v1/users/:userId/package-access", async (req,res) => {
    if (!packages) throw new HttpError(503, "场景包服务未启用", "PACKAGES_DISABLED");
    // 已知包 ID = 代码子工程（已加载且启用）∪ 配置型草稿：授权单元仍是 packageIds，
    // 代码包与配置型包在这一层没有区别，用户只看到「哪个服务被授权」。
    const known = new Set(await packages.knownPackageIds());
    res.json(await access.setPackages(parsed(packageAccess,{ ...req.body, userId: req.params.userId }), known, res.locals.authorizeAdmin, res.locals.identity?.id));
  });
  router.post("/api/v1/users/:userId/password", async (req,res) => res.json(await access.resetPassword(parsed(passwordReset,{ ...req.body,userId:req.params.userId }),res.locals.authorizeAdmin, res.locals.identity?.id)));
  router.get("/api/v1/self/tokens", (req,res) => res.json(access.credentials(identity(res),parsed(accessPage,req.query))));
  // 积分：本人余额/流水/兑换 + 管理员发码与调账。额度口径与结算规则见 get_own_credits 说明。
  router.get("/api/v1/self/credits", (req,res) => { parsed(z.object({}).strict(), req.query); res.json(portal.creditsSummary(identity(res))); });
  router.get("/api/v1/self/credits/entries", (req,res) => res.json(portal.creditsLedger(identity(res), parsed(creditLedgerQuery, req.query))));
  router.post("/api/v1/self/credits/redeem", (req,res) => { assertRequestOrigin(req); res.json(portal.redeemCode(identity(res), parsed(redeemCodeRequest, req.body).code)); });
  router.get("/api/v1/settings/credits/reconciliation", (req,res) => {
    res.locals.authorizeAdmin();
    if (!credits) throw new HttpError(503, "积分服务未启用", "CREDITS_DISABLED");
    parsed(z.object({}).strict(), req.query);
    res.json(credits.reconciliation());
  });
  router.get("/api/v1/redeem-batches", (req,res) => { res.locals.authorizeAdmin(); if (!credits) throw new HttpError(503, "积分服务未启用", "CREDITS_DISABLED"); parsed(z.object({}).strict(), req.query); res.json(credits.listBatches()); });
  router.get("/api/v1/redeem-batches/:batchId/codes", (req,res) => {
    res.locals.authorizeAdmin();
    if (!credits) throw new HttpError(503, "积分服务未启用", "CREDITS_DISABLED");
    parsed(z.object({}).strict(), req.query);
    const input = parsed(redeemBatchKey, { batchId: req.params.batchId });
    res.json(credits.listCodes(input.batchId));
  });
  router.post("/api/v1/redeem-batches/:batchId/void", (req,res) => {
    res.locals.authorizeAdmin();
    if (!credits) throw new HttpError(503, "积分服务未启用", "CREDITS_DISABLED");
    const input = parsed(redeemBatchKey, { batchId: req.params.batchId });
    const options = parsed(voidRedeemBatchRequest, req.body ?? {});
    res.json(credits.voidBatch(input.batchId, { ...options, actorId: identity(res).id }));
  });
  router.post("/api/v1/redeem-batches", (req,res) => {
    res.locals.authorizeAdmin();
    if (!credits) throw new HttpError(503, "积分服务未启用", "CREDITS_DISABLED");
    // 新建与同 batchId 重复提交都返回 200：这个接口是幂等回执，用响应体里的 created 区分，
    // 不用状态码区分（客户端只判断 HTTP 成功与否，不因首次/重放走不同分支）。
    res.json(credits.createBatch(parsed(createRedeemBatch, req.body), identity(res).id));
  });
  router.post("/api/v1/redeem-codes/:codeId/void", (req,res) => {
    res.locals.authorizeAdmin();
    if (!credits) throw new HttpError(503, "积分服务未启用", "CREDITS_DISABLED");
    const input = parsed(redeemCodeKey, { codeId: req.params.codeId });
    const options = parsed(voidRedeemCodeRequest, req.body ?? {});
    res.json(credits.voidCode(input.codeId, { ...options, actorId: identity(res).id }));
  });
  router.post("/api/v1/users/:userId/credits", (req,res) => {
    if (!credits) throw new HttpError(503, "积分服务未启用", "CREDITS_DISABLED");
    const input = parsed(adjustUserCredits, { ...req.body, userId: req.params.userId });
    res.json(credits.adjust(input, identity(res).id, res.locals.authorizeAdmin));
  });
  router.post("/api/v1/self/tokens", (req,res) => res.status(201).json(access.createCredential(identity(res),parsed(credentialCreate,req.body))));
  router.post("/api/v1/self/tokens/:tokenId/revoke", (req,res) => { const input = parsed(credentialRevoke,{ ...req.body,tokenId:req.params.tokenId }); res.json(access.revokeCredential(identity(res),input.tokenId,input.revision)); });
  // 场景包：用户面唯一的产品单元（场景降级为包内部件）。
  router.get("/api/v1/self/packages", async (req,res) => { if (!packages) throw new HttpError(503, "场景包服务未启用", "PACKAGES_DISABLED"); res.json(await packages.listAvailable(identity(res), parsed(accessPage, req.query))); });
  router.get("/api/v1/self/packages/:packageId", async (req,res) => {
    if (!packages) throw new HttpError(503, "场景包服务未启用", "PACKAGES_DISABLED");
    const input = parsed(ownPackageQuery, { packageId: req.params.packageId, ...(req.query.versionId === undefined ? {} : { versionId: req.query.versionId }) });
    res.json(await packages.getAvailable(identity(res), input.packageId, input.versionId));
  });
  router.post("/api/v1/self/packages/:packageId/prepare", async (req,res) => {
    if (!packages) throw new HttpError(503, "场景包服务未启用", "PACKAGES_DISABLED");
    res.json(await packages.prepare(identity(res), String(req.params.packageId), req.body));
  });
  router.post("/api/v1/self/packages/:packageId/runs", async (req,res) => {
    if (!packages) throw new HttpError(503, "场景包服务未启用", "PACKAGES_DISABLED");
    res.status(202).json(await packages.submit(identity(res), String(req.params.packageId), req.body));
  });
  router.get("/api/v1/self/package-runs", async (req,res) => {
    if (!packages) throw new HttpError(503, "场景包服务未启用", "PACKAGES_DISABLED");
    res.json(await packages.listRuns(identity(res), parsed(accessPage, req.query)));
  });
  router.get("/api/v1/self/package-runs/:packageRunId", async (req,res) => {
    if (!packages) throw new HttpError(503, "场景包服务未启用", "PACKAGES_DISABLED");
    const input = parsed(packageRunKey, { packageRunId: req.params.packageRunId });
    res.json(await packages.getRun(identity(res), input.packageRunId));
  });
  // 服务级产出：按包内顺序聚合各步媒体，用户不需要知道子运行。
  router.get("/api/v1/self/package-runs/:packageRunId/outputs", async (req,res) => {
    if (!packages) throw new HttpError(503, "场景包服务未启用", "PACKAGES_DISABLED");
    const input = parsed(packageRunKey, { packageRunId: req.params.packageRunId });
    res.json(await packages.outputs(identity(res), input.packageRunId));
  });
  // 本次服务运行的原始输入：字段取该次运行固化的发布快照，值取提交时快照。
  // 分页、省略标记与媒体投影与单次运行的输入快照完全一致。
  router.get("/api/v1/self/package-runs/:packageRunId/inputs", async (req,res) => {
    if (!packages) throw new HttpError(503, "场景包服务未启用", "PACKAGES_DISABLED");
    const input = parsed(packageRunKey.extend(runInputQuery.shape).strict(), { ...results(req.query), packageRunId: req.params.packageRunId });
    res.json(await packages.inputs(identity(res), input.packageRunId, input));
  });
  router.post("/api/v1/self/package-runs/:packageRunId/items/:itemId/confirm", async (req,res) => {
    if (!packages) throw new HttpError(503, "场景包服务未启用", "PACKAGES_DISABLED");
    res.status(202).json(await packages.confirmItem(identity(res), { ...req.body, packageRunId: req.params.packageRunId, itemId: req.params.itemId }));
  });
  router.post("/api/v1/self/package-runs/:packageRunId/cancel", async (req,res) => {
    if (!packages) throw new HttpError(503, "场景包服务未启用", "PACKAGES_DISABLED");
    const input = parsed(packageRunKey, { packageRunId: req.params.packageRunId });
    res.json(await packages.cancel(identity(res), input.packageRunId));
  });
  router.get("/api/v1/self/scenes", async (req,res) => res.json(await portal.list(identity(res),parsed(accessPage,req.query))));
  router.get("/api/v1/self/scenes/:sceneId", async (req,res) => { const input = parsed(ownScene,req.params); res.json(await portal.get(identity(res),input.sceneId)); });
  router.post("/api/v1/self/scenes/:sceneId/prepare", async (req,res) => res.json(await portal.prepare(identity(res),parsed(ownPreparation,{ ...req.body,sceneId:req.params.sceneId }))));
  router.post("/api/v1/self/scenes/:sceneId/runs", async (req,res) => res.status(202).json(await portal.submit(identity(res),parsed(ownSubmission,{ ...req.body,sceneId:req.params.sceneId }))));
  router.get("/api/v1/self/drafts", async (req,res) => res.json(await portal.listDrafts(identity(res),parsed(accessPage,req.query))));
  router.get("/api/v1/self/drafts/:draftId", async (req,res) => res.json(await portal.getDraft(identity(res),String(req.params.draftId))));
  router.patch("/api/v1/self/drafts/:draftId/favorite", async (req,res) => res.json(await portal.setDraftFavorite(identity(res), String(req.params.draftId), parsed(draftFavoriteRequest, req.body))));
  router.post("/api/v1/self/drafts", async (req,res) => res.json(await portal.saveDraft(identity(res),parsed(ownDraft,req.body))));
  router.get("/api/v1/self/runs", async (req,res) => res.json(await portal.listRuns(identity(res),parsed(runListPage,req.query))));
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
    // 配额在读取到完整请求体之后、写入之前记账：计数与字节双限，超出返回 429 与 Retry-After。
    try { uploadQuotaLimiter.check(identity(res).id, req.body.length); }
    catch (error) {
      const quota = error as Error & { status?: number; code?: string; retryAfterSeconds?: number };
      if (quota.retryAfterSeconds) res.set("Retry-After", String(quota.retryAfterSeconds));
      throw new HttpError(quota.status ?? 429, quota.message, quota.code ?? "UPLOAD_QUOTA_EXCEEDED");
    }
    res.status(201).json(await portal.upload(identity(res),input.assetId,input.name,input.kind,req.body,filename));
  });
  router.get("/api/v1/self/assets", async (req,res) => { res.set("Cache-Control", "no-store"); res.json(await portal.listOwnAssets(identity(res),parsed(ownAssetQuerySchema,req.query))); });
  router.get("/api/v1/self/assets/:assetId", async (req,res) => res.json(await portal.getAsset(identity(res),String(req.params.assetId))));
  return router;
}
